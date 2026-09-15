// Shift Board — standalone server.
// Run with: node server.js
//
// Storage: if UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set (as
// they will be once deployed — see README), the whole store persists to
// Upstash Redis (one JSON blob under one key), so data survives the host
// putting the app to sleep and waking it back up on a fresh container.
// Without those env vars (e.g. running locally), it falls back to a plain
// file at ./data/store.json — no setup needed for local testing.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = "shiftboard:store";

// ---------------- storage ----------------
// The in-memory `store` object is the single source of truth while the
// process is running (every request reads/mutates it directly, synchronously
// — Node never interleaves two request handlers' synchronous code, so this
// stays race-free). `saveStore` persists a snapshot after each mutation;
// callers `await` it before responding so a write is durable before the
// client sees "ok".

function defaultStore() {
  return { settings: { exists: false, employees: [], admins: [] }, shifts: {} };
}

function normalize(parsed) {
  if (!parsed || typeof parsed !== "object") return defaultStore();
  if (!parsed.settings) parsed.settings = defaultStore().settings;
  if (!Array.isArray(parsed.settings.admins)) parsed.settings.admins = [];
  if (!parsed.shifts) parsed.shifts = {};
  return parsed;
}

async function redisCommand(cmd) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REDIS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  const data = await res.json();
  if (data.error) throw new Error("Upstash error: " + data.error);
  return data.result;
}

async function loadStore() {
  if (USE_REDIS) {
    try {
      const raw = await redisCommand(["GET", REDIS_KEY]);
      return raw ? normalize(JSON.parse(raw)) : defaultStore();
    } catch (e) {
      console.error("Redis load failed, starting empty:", e.message);
      return defaultStore();
    }
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return normalize(JSON.parse(raw));
  } catch (e) {
    return defaultStore();
  }
}

async function saveStore(store) {
  if (USE_REDIS) {
    await redisCommand(["SET", REDIS_KEY, JSON.stringify(store)]);
    return;
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let store = defaultStore(); // replaced by the real thing once loadStore() resolves, before listen()

// ---------------- helpers ----------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function publicSettings() {
  // Never include admin codes here — this endpoint is unauthenticated.
  return { exists: !!store.settings.exists, employees: store.settings.employees.slice() };
}

function shiftsArray() {
  return Object.keys(store.shifts).map((id) => Object.assign({ id }, store.shifts[id]));
}

// Looks up which admin (if any) a request's code belongs to.
function resolveAdmin(body) {
  if (!store.settings.exists || !body || typeof body.code !== "string" || !body.code) return null;
  return store.settings.admins.find((a) => a.code === body.code) || null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback — serve index.html for unknown non-API GET routes
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(full);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------------- request handling ----------------

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const pathname = u.pathname;

  if (!pathname.startsWith("/api/")) {
    if (req.method === "GET") return serveStatic(req, res, pathname);
    res.writeHead(405); return res.end();
  }

  // ---- API routes ----
  if (pathname === "/api/state" && req.method === "GET") {
    return sendJson(res, 200, { settings: publicSettings(), shifts: shiftsArray() });
  }

  if (req.method !== "POST") { return sendJson(res, 405, { error: "method_not_allowed" }); }

  readBody(req).then(async (body) => {
    // ---- setup (first run only) ----
    if (pathname === "/api/setup") {
      if (store.settings.exists) return sendJson(res, 409, { error: "already_set_up" });
      const adminName = (body.adminName || "").toString().trim();
      const adminCode = (body.adminCode || "").toString().trim();
      const employees = Array.isArray(body.employees) ? body.employees.map(String).filter(Boolean) : [];
      if (!adminName) return sendJson(res, 400, { error: "admin_name_required" });
      if (!adminCode) return sendJson(res, 400, { error: "admin_code_required" });
      store.settings = { exists: true, employees, admins: [{ name: adminName, code: adminCode }] };
      await saveStore(store);
      return sendJson(res, 200, { settings: publicSettings() });
    }

    if (pathname === "/api/admin/verify") {
      const admin = resolveAdmin(body);
      return sendJson(res, 200, admin ? { ok: true, name: admin.name } : { ok: false });
    }

    if (pathname === "/api/admins/list") {
      const admin = resolveAdmin(body);
      if (!admin) return sendJson(res, 403, { error: "bad_code" });
      return sendJson(res, 200, { admins: store.settings.admins.map((a) => ({ name: a.name, code: a.code })) });
    }

    if (pathname === "/api/admins/add") {
      const admin = resolveAdmin(body);
      if (!admin) return sendJson(res, 403, { error: "bad_code" });
      const name = (body.name || "").toString().trim();
      const newCode = (body.newCode || "").toString().trim();
      if (!name) return sendJson(res, 400, { error: "name_required" });
      if (!newCode) return sendJson(res, 400, { error: "code_required" });
      if (store.settings.admins.some((a) => a.name === name)) return sendJson(res, 409, { error: "name_taken" });
      if (store.settings.admins.some((a) => a.code === newCode)) return sendJson(res, 409, { error: "code_taken" });
      store.settings.admins.push({ name, code: newCode });
      await saveStore(store);
      return sendJson(res, 200, { admins: store.settings.admins.map((a) => ({ name: a.name, code: a.code })) });
    }

    if (pathname === "/api/admins/remove") {
      const admin = resolveAdmin(body);
      if (!admin) return sendJson(res, 403, { error: "bad_code" });
      const name = (body.name || "").toString();
      if (store.settings.admins.length <= 1) return sendJson(res, 409, { error: "last_admin" });
      const next = store.settings.admins.filter((a) => a.name !== name);
      if (next.length === store.settings.admins.length) return sendJson(res, 404, { error: "not_found" });
      store.settings.admins = next;
      await saveStore(store);
      return sendJson(res, 200, { admins: store.settings.admins.map((a) => ({ name: a.name, code: a.code })) });
    }
    // An admin can only ever rotate their OWN code (the one that authenticated
    // this request) — not anyone else's. To help someone who lost theirs,
    // remove and re-add them instead.
    if (pathname === "/api/admins/update-code") {
      const admin = resolveAdmin(body);
      if (!admin) return sendJson(res, 403, { error: "bad_code" });
      const newCode = (body.newCode || "").toString().trim();
      if (!newCode) return sendJson(res, 400, { error: "code_required" });
      if (store.settings.admins.some((a) => a.code === newCode && a !== admin)) return sendJson(res, 409, { error: "code_taken" });
      admin.code = newCode;
      await saveStore(store);
      return sendJson(res, 200, { ok: true, name: admin.name });
    }

    if (pathname === "/api/shifts/create") {
      const admin = resolveAdmin(body);
      if (!admin) return sendJson(res, 403, { error: "bad_code" });
      const id = crypto.randomUUID();
      const assignedTo = (body.assignedTo || "").toString();
      store.shifts[id] = {
        date: String(body.date || ""),
        start: String(body.start || ""),
        end: String(body.end || ""),
        role: String(body.role || ""),
        assignedTo: assignedTo,
        status: assignedTo ? "assigned" : "open",
        flagNote: "", flaggedBy: "",
        createdAt: Date.now(), updatedAt: Date.now(), lastEditedBy: admin.name,
      };
      await saveStore(store);
      return sendJson(res, 200, { id });
    }

    const shiftMatch = pathname.match(/^\/api\/shifts\/([^/]+)\/(update|delete|claim|flag|duplicate)$/);
    if (shiftMatch) {
      const id = shiftMatch[1];
      const action = shiftMatch[2];
      const shift = store.shifts[id];
      if (!shift) return sendJson(res, 404, { error: "not_found" });

      if (action === "update") {
        const admin = resolveAdmin(body);
        if (!admin) return sendJson(res, 403, { error: "bad_code" });
        const assignedTo = (body.assignedTo || "").toString();
        Object.assign(shift, {
          date: String(body.date || shift.date),
          start: String(body.start || shift.start),
          end: String(body.end || shift.end),
          role: body.role != null ? String(body.role) : shift.role,
          assignedTo: assignedTo,
          status: assignedTo ? "assigned" : "open",
          flagNote: "", flaggedBy: "",
          updatedAt: Date.now(), lastEditedBy: admin.name,
        });
        await saveStore(store);
        return sendJson(res, 200, { ok: true });
      }

      if (action === "delete") {
        const admin = resolveAdmin(body);
        if (!admin) return sendJson(res, 403, { error: "bad_code" });
        delete store.shifts[id];
        await saveStore(store);
        return sendJson(res, 200, { ok: true });
      }

      if (action === "claim") {
        const name = (body.name || "").toString();
        if (!name || store.settings.employees.indexOf(name) === -1) return sendJson(res, 403, { error: "unknown_person" });
        if (shift.assignedTo) return sendJson(res, 409, { error: "already_claimed" });
        Object.assign(shift, { assignedTo: name, status: "assigned", flagNote: "", flaggedBy: "", updatedAt: Date.now() });
        await saveStore(store);
        return sendJson(res, 200, { ok: true });
      }

      if (action === "flag") {
        const name = (body.name || "").toString();
        if (!name || shift.assignedTo !== name) return sendJson(res, 403, { error: "not_your_shift" });
        Object.assign(shift, { assignedTo: "", status: "flagged", flaggedBy: name, flagNote: (body.note || "").toString(), updatedAt: Date.now() });
        await saveStore(store);
        return sendJson(res, 200, { ok: true });
      }

      if (action === "duplicate") {
        const admin = resolveAdmin(body);
        if (!admin) return sendJson(res, 403, { error: "bad_code" });
        // `dates`: create one copy per date given (lets an admin duplicate a
        // shift onto several days at once). Falls back to the original
        // shift's own date when no dates are given, for older callers.
        const dates = Array.isArray(body.dates) ? body.dates.map(String).filter(Boolean) : [];
        const targetDates = dates.length ? dates : [shift.date];
        const ids = targetDates.map((date) => {
          const newId = crypto.randomUUID();
          store.shifts[newId] = {
            date, start: shift.start, end: shift.end, role: shift.role,
            assignedTo: shift.assignedTo, status: shift.assignedTo ? "assigned" : "open",
            flagNote: "", flaggedBy: "",
            createdAt: Date.now(), updatedAt: Date.now(), lastEditedBy: admin.name,
          };
          return newId;
        });
        await saveStore(store);
        return sendJson(res, 200, { id: ids[0], ids });
      }
    }
    if (pathname === "/api/roster/add") {
      const admin = resolveAdmin(body);
      if (!admin) return sendJson(res, 403, { error: "bad_code" });
      const name = (body.name || "").toString().trim();
      if (!name) return sendJson(res, 400, { error: "name_required" });
      if (store.settings.employees.indexOf(name) === -1) store.settings.employees.push(name);
      await saveStore(store);
      return sendJson(res, 200, { settings: publicSettings() });
    }

    if (pathname === "/api/roster/remove") {
      const admin = resolveAdmin(body);
      if (!admin) return sendJson(res, 403, { error: "bad_code" });
      const name = (body.name || "").toString();
      store.settings.employees = store.settings.employees.filter((n) => n !== name);
      await saveStore(store);
      return sendJson(res, 200, { settings: publicSettings() });
    }

    return sendJson(res, 404, { error: "unknown_route" });
  }).catch((e) => {
    sendJson(res, 400, { error: "bad_request", message: e.message });
  });
});

loadStore().then((loaded) => {
  store = loaded;
  server.listen(PORT, () => {
    console.log(
      "Shift Board running at http://localhost:" + PORT +
      (USE_REDIS ? " (storage: Upstash Redis)" : " (storage: local file)")
    );
  });
});
