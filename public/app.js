(function () {
  "use strict";

  // ---------------- utilities ----------------
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function todayISO() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function addDays(iso, n) {
    var p = iso.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function shiftMonth(ym, delta) {
    var p = ym.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1 + delta, 1);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1);
  }
  function monthLabel(ym) {
    var p = ym.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, 1);
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  function daysInMonth(year, month1based) { return new Date(year, month1based, 0).getDate(); }
  function fmtDate(iso) {
    var parts = iso.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    var today = todayISO();
    var tmw = new Date(); tmw.setDate(tmw.getDate() + 1);
    var tmwIso = tmw.getFullYear() + "-" + pad(tmw.getMonth() + 1) + "-" + pad(tmw.getDate());
    var base = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (iso === today) return "Today · " + base;
    if (iso === tmwIso) return "Tomorrow · " + base;
    return base;
  }
  function fmtTime(hhmm) {
    if (!hhmm) return "";
    var parts = hhmm.split(":");
    var h = parseInt(parts[0], 10), m = parts[1];
    var ap = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ":" + m + " " + ap;
  }
  function fmtRange(a, b) { return fmtTime(a) + " – " + fmtTime(b); }
  function escapeHtml(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var toastEl = document.getElementById("toast");
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }

  // In-app confirmation dialog. Deliberately NOT the browser's native
  // confirm() — some embedded/webview contexts (including this app's own
  // test preview) silently suppress it, so it can return "cancelled"
  // instantly with no dialog ever shown, making destructive buttons look
  // broken. This lives outside #root so re-renders never touch it.
  var confirmOverlay = document.getElementById("confirmOverlay");
  var confirmMessageEl = document.getElementById("confirmMessage");
  var confirmYesBtn = document.getElementById("confirmYes");
  var confirmCancelBtn = document.getElementById("confirmCancel");
  var pendingConfirmYes = null;
  function showConfirm(message, onYes, confirmLabel) {
    confirmMessageEl.textContent = message;
    confirmYesBtn.textContent = confirmLabel || "Delete";
    pendingConfirmYes = onYes;
    confirmOverlay.hidden = false;
  }
  function hideConfirm() {
    confirmOverlay.hidden = true;
    pendingConfirmYes = null;
  }
  confirmCancelBtn.onclick = hideConfirm;
  confirmYesBtn.onclick = function () {
    var fn = pendingConfirmYes;
    hideConfirm();
    if (fn) fn();
  };
  confirmOverlay.onclick = function (e) { if (e.target === confirmOverlay) hideConfirm(); };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !confirmOverlay.hidden) hideConfirm(); });

  function loadIdentity() {
    try { return JSON.parse(localStorage.getItem("shiftboard_identity") || "null"); } catch (e) { return null; }
  }
  function saveIdentity(v) {
    try { if (v) localStorage.setItem("shiftboard_identity", JSON.stringify(v)); else localStorage.removeItem("shiftboard_identity"); } catch (e) {}
  }
  function loadAdminCode() { try { return localStorage.getItem("shiftboard_admin_code") || ""; } catch (e) { return ""; } }
  function saveAdminCode(v) { try { if (v) localStorage.setItem("shiftboard_admin_code", v); else localStorage.removeItem("shiftboard_admin_code"); } catch (e) {} }
  function genCode() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easier to read aloud
    var out = "";
    var rnd = new Uint32Array(8);
    (window.crypto || window.msCrypto).getRandomValues(rnd);
    for (var i = 0; i < 8; i++) out += chars[rnd[i] % chars.length];
    return out;
  }

  function api(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json()
        .then(function (data) { return { ok: r.ok, status: r.status, data: data }; })
        .catch(function () { return { ok: false, status: r.status, data: { error: "bad_response" } }; });
    }).catch(function () {
      // The request never made it — server unreachable, offline, etc. Fail
      // loudly (a caller's generic error toast) instead of leaving a button
      // that silently does nothing.
      return { ok: false, status: 0, data: { error: "network_error" } };
    });
  }
  function apiGet(path) {
    return fetch(path).then(function (r) { return r.json(); });
  }

  // Shared failure handler for admin-authenticated calls. If the server says
  // the code is no longer valid — it was changed, or that admin was removed
  // — sign this device out of admin back to the picker instead of leaving
  // every action silently failing with no explanation. Returns true if it
  // handled the failure (caller should skip its own generic error toast).
  function handleAuthFailure(res) {
    if (res.ok || !res.data || res.data.error !== "bad_code") return false;
    if (state.identity && state.identity.type === "admin") {
      state.identity = null; saveIdentity(null);
      state.adminCode = ""; saveAdminCode("");
      state.passcodeError = "Your admin code no longer works — ask another admin for a current one.";
      render();
    }
    return true;
  }

  // ---------------- state ----------------
  var state = {
    loaded: false,
    settings: { exists: false, employees: [] },
    shifts: [],
    identity: loadIdentity(),
    adminCode: loadAdminCode(),
    admins: [],
    tab: "mine",
    adminTab: "all",
    adminFilterStatus: "all",
    adminFilterEmployee: "",
    passcodeError: "",
    newShiftDraft: { date: todayISO(), start: "09:00", end: "17:00", role: "", assignedTo: "" },
    flagDraft: {},
    duplicateDraft: {},
    editingShiftId: null,
    calendarMonth: todayISO().slice(0, 7),
  };

  var root = document.getElementById("root");

  function render() {
    if (!state.loaded) { root.innerHTML = renderLoading(); return; }
    if (!state.settings.exists) { root.innerHTML = renderSetup(); bindSetup(); return; }
    if (!state.identity) { root.innerHTML = renderIdentityPicker(); bindIdentityPicker(); return; }
    if (state.identity.type === "employee" && state.settings.employees.indexOf(state.identity.name) === -1) {
      state.identity = null; saveIdentity(null);
      root.innerHTML = renderIdentityPicker(); bindIdentityPicker(); return;
    }
    root.innerHTML = renderApp(); bindApp();
  }

  function renderLoading() {
    return '<div class="center-screen"><div style="color:var(--ink-faint);font-size:14px;">Loading Shift Board…</div></div>';
  }

  // ---------------- setup ----------------
  function renderSetup() {
    return '' +
      '<div class="center-screen"><div class="id-card">' +
      '<div class="brand-mark">🗓️</div>' +
      '<h1>Set up Shift Board</h1>' +
      '<div class="hint">You\'re first here — set yourself up as admin and add the people you schedule. You can change this anytime later.</div>' +
      '<div class="form-grid" style="margin-bottom:12px;">' +
      '<div class="field"><label>Your name</label><input id="su-admin-name" type="text" placeholder="e.g. Jordan" /></div>' +
      '<div class="field"><label>Your admin code</label><input id="su-passcode" type="text" placeholder="e.g. a word or number only you know" /></div>' +
      '</div>' +
      '<div class="field full" style="margin-bottom:12px;"><label>Add people (one at a time)</label>' +
      '<div style="display:flex;gap:8px;"><input id="su-name" type="text" placeholder="Full name" style="flex:1;" />' +
      '<button class="btn" id="su-add">Add</button></div></div>' +
      '<div class="roster-list" id="su-roster" style="margin-bottom:16px;"></div>' +
      '<div id="su-error" class="error-text" style="display:none;"></div>' +
      '<button class="btn primary" id="su-finish" style="width:100%;justify-content:center;">Create Shift Board</button>' +
      '</div></div>';
  }
  var setupDraftNames = [];
  function bindSetup() {
    var rosterEl = document.getElementById("su-roster");
    function renderRoster() {
      rosterEl.innerHTML = setupDraftNames.map(function (n, i) {
        return '<div class="roster-chip">' + escapeHtml(n) + '<button data-i="' + i + '">✕</button></div>';
      }).join("") || '<span style="color:var(--ink-faint);font-size:13px;">No one added yet</span>';
      Array.prototype.forEach.call(rosterEl.querySelectorAll("button"), function (b) {
        b.onclick = function () { setupDraftNames.splice(parseInt(b.dataset.i, 10), 1); renderRoster(); };
      });
    }
    renderRoster();
    document.getElementById("su-add").onclick = function () {
      var input = document.getElementById("su-name");
      var v = input.value.trim();
      if (v && setupDraftNames.indexOf(v) === -1) { setupDraftNames.push(v); input.value = ""; renderRoster(); input.focus(); }
    };
    document.getElementById("su-name").onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); document.getElementById("su-add").click(); }
    };
    document.getElementById("su-finish").onclick = function () {
      var name = document.getElementById("su-admin-name").value.trim();
      var pass = document.getElementById("su-passcode").value.trim();
      var errEl = document.getElementById("su-error");
      if (!name) { errEl.textContent = "Please enter your name."; errEl.style.display = "block"; return; }
      if (!pass) { errEl.textContent = "Please set an admin code."; errEl.style.display = "block"; return; }
      api("/api/setup", { adminName: name, adminCode: pass, employees: setupDraftNames }).then(function (res) {
        if (!res.ok) { errEl.textContent = "Couldn't save — try again."; errEl.style.display = "block"; return; }
        toast("Shift Board is ready");
        refresh();
      });
    };
  }

  // ---------------- identity picker ----------------
  function renderIdentityPicker() {
    var employees = state.settings.employees || [];
    var names = employees.map(function (n) {
      return '<button class="name-btn" data-name="' + escapeHtml(n) + '">' + escapeHtml(n) + ' <span style="color:var(--ink-faint);">→</span></button>';
    }).join("");
    return '' +
      '<div class="center-screen"><div class="id-card">' +
      '<div class="brand-mark">🗓️</div><h1>Shift Board</h1>' +
      '<div class="hint">Who\'s this?</div>' +
      '<div class="name-grid">' + (names || '<div style="color:var(--ink-faint);font-size:13.5px;">No one on the roster yet — ask your admin to add you.</div>') + '</div>' +
      '<div class="divider">or</div>' +
      '<div class="passcode-row"><input id="id-passcode" type="password" placeholder="Admin code" />' +
      '<button class="btn primary" id="id-admin-go">Admin</button></div>' +
      (state.passcodeError ? '<div class="error-text">' + escapeHtml(state.passcodeError) + '</div>' : '') +
      '</div></div>';
  }
  function bindIdentityPicker() {
    Array.prototype.forEach.call(document.querySelectorAll(".name-btn"), function (b) {
      b.onclick = function () {
        state.identity = { type: "employee", name: b.dataset.name };
        saveIdentity(state.identity);
        state.tab = "mine";
        render();
      };
    });
    var go = document.getElementById("id-admin-go");
    var input = document.getElementById("id-passcode");
    function tryAdmin() {
      var v = input.value;
      api("/api/admin/verify", { code: v }).then(function (res) {
        if (res.ok && res.data.ok) {
          state.identity = { type: "admin", name: res.data.name };
          state.adminCode = v;
          saveIdentity(state.identity);
          saveAdminCode(v);
          state.passcodeError = "";
          state.adminTab = "all";
          render();
        } else {
          state.passcodeError = "That admin code isn't right.";
          render();
        }
      });
    }
    go.onclick = tryAdmin;
    input.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); tryAdmin(); } };
  }
  // ---------------- main app ----------------
  function shiftSort(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.start || "") < (b.start || "") ? -1 : 1;
  }
  function groupByDate(list) {
    var groups = [], map = {};
    list.slice().sort(shiftSort).forEach(function (s) {
      if (!map[s.date]) { map[s.date] = { date: s.date, items: [] }; groups.push(map[s.date]); }
      map[s.date].items.push(s);
    });
    return groups;
  }

  function renderApp() {
    var isAdmin = state.identity.type === "admin";
    var today = todayISO();
    var html = '<div class="wrap">';
    html += renderTopbar(isAdmin);
    if (isAdmin) {
      html += renderAdminTabs();
      html += '<div class="panel">';
      if (state.adminTab === "all") html += renderAdminAll(today);
      else if (state.adminTab === "calendar") html += renderAdminCalendar();
      else if (state.adminTab === "new") html += renderAdminNew();
      else if (state.adminTab === "flagged") html += renderAdminFlagged();
      else if (state.adminTab === "roster") html += renderAdminRoster();
      html += '</div>';
    } else {
      html += renderEmployeeTabs();
      html += '<div class="panel">';
      html += state.tab === "mine" ? renderMyShifts(today) : renderOpenShifts(today);
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderTopbar(isAdmin) {
    var who = isAdmin
      ? '<span class="pill-role">Admin</span> <span>' + escapeHtml(state.identity.name) + '</span>'
      : '<span>Viewing as <b>' + escapeHtml(state.identity.name) + '</b></span>';
    return '' +
      '<div class="topbar"><div class="brand"><span class="brand-mark">🗓️</span><h1>Shift Board</h1></div>' +
      '<div class="whoami">' + who + ' <button class="link-btn" id="switch-btn">Switch</button></div></div>';
  }

  function renderEmployeeTabs() {
    var today = todayISO();
    var mine = state.shifts.filter(function (s) { return s.assignedTo === state.identity.name && s.date >= today; }).length;
    var open = state.shifts.filter(function (s) { return !s.assignedTo && s.date >= today; }).length;
    return '' +
      '<div class="tabs">' +
      '<button class="tab ' + (state.tab === "mine" ? "active" : "") + '" data-tab="mine">My Shifts <span class="count">' + mine + '</span></button>' +
      '<button class="tab ' + (state.tab === "open" ? "active" : "") + '" data-tab="open">Open Shifts <span class="count">' + open + '</span></button>' +
      '</div>';
  }

  function renderAdminTabs() {
    var flaggedCount = state.shifts.filter(function (s) { return s.status === "flagged"; }).length;
    function t(key, label, badge) {
      return '<button class="tab ' + (state.adminTab === key ? "active" : "") + '" data-atab="' + key + '">' + label + (badge != null ? ' <span class="count">' + badge + '</span>' : '') + '</button>';
    }
    return '<div class="tabs">' + t("all", "All Shifts", state.shifts.length) + t("calendar", "Calendar") + t("new", "New Shift") + t("flagged", "Flagged", flaggedCount) + t("roster", "Roster & Settings") + '</div>';
  }

  function renderMyShifts(today) {
    var mine = state.shifts.filter(function (s) { return s.assignedTo === state.identity.name && s.date >= today; });
    if (mine.length === 0) return '<div class="empty"><div class="big">📭</div>No upcoming shifts assigned to you yet.</div>';
    return groupByDate(mine).map(function (g) {
      return '<div class="day-group"><div class="day-heading">' + fmtDate(g.date) + '</div>' + g.items.map(renderMyShiftCard).join("") + '</div>';
    }).join("");
  }
  function renderMyShiftCard(s) {
    var flagOpen = state.flagDraft.hasOwnProperty(s.id);
    var card = '' +
      '<div class="shift-card"><div class="shift-time mono">' + fmtRange(s.start, s.end) + '</div>' +
      '<div class="shift-main"><div class="shift-role">' + escapeHtml(s.role || "Shift") + '</div>' +
      '<div class="shift-sub"><span class="badge assigned">Assigned</span></div></div>' +
      '<div class="shift-actions">' + (flagOpen ? '' : '<button class="btn warn sm" data-flag="' + s.id + '">Flag unavailable</button>') + '</div></div>';
    if (flagOpen) {
      card += '' +
        '<div class="card" style="margin-top:-8px;">' +
        '<div class="hint" style="margin-bottom:8px;">This shift will open up for someone else to claim. Add a note if you\'d like (optional).</div>' +
        '<textarea id="flag-note-' + s.id + '" rows="2" style="width:100%;border-radius:8px;border:1px solid var(--line);padding:8px;font-family:inherit;font-size:13.5px;background:var(--paper);color:var(--ink);" placeholder="e.g. Doctor\'s appointment"></textarea>' +
        '<div class="form-actions"><button class="btn ghost sm" data-flag-cancel="' + s.id + '">Cancel</button>' +
        '<button class="btn warn sm" data-flag-confirm="' + s.id + '">Confirm — mark unavailable</button></div></div>';
    }
    return card;
  }

  function renderOpenShifts(today) {
    var open = state.shifts.filter(function (s) { return !s.assignedTo && s.date >= today; });
    if (open.length === 0) return '<div class="empty"><div class="big">✅</div>No open shifts right now.</div>';
    return groupByDate(open).map(function (g) {
      return '<div class="day-group"><div class="day-heading">' + fmtDate(g.date) + '</div>' +
        g.items.map(function (s) {
          var wasFlagged = s.status === "flagged";
          return '' +
            '<div class="shift-card"><div class="shift-time mono">' + fmtRange(s.start, s.end) + '</div>' +
            '<div class="shift-main"><div class="shift-role">' + escapeHtml(s.role || "Shift") + '</div>' +
            '<div class="shift-sub">' + (wasFlagged ? '<span class="badge flagged">Needs coverage</span>' : '<span class="badge open">Open</span>') +
            (wasFlagged && s.flaggedBy ? ' <span style="margin-left:6px;">was ' + escapeHtml(s.flaggedBy) + "'s" + (s.flagNote ? ' · "' + escapeHtml(s.flagNote) + '"' : '') + '</span>' : '') +
            '</div></div><div class="shift-actions"><button class="btn primary sm" data-claim="' + s.id + '">Claim shift</button></div></div>';
        }).join("") + '</div>';
    }).join("");
  }
  function renderAdminAll(today) {
    var employees = state.settings.employees || [];
    var list = state.shifts.slice();
    if (state.adminFilterStatus !== "all") {
      list = list.filter(function (s) {
        if (state.adminFilterStatus === "assigned") return !!s.assignedTo;
        if (state.adminFilterStatus === "open") return !s.assignedTo && s.status !== "flagged";
        if (state.adminFilterStatus === "flagged") return s.status === "flagged";
        return true;
      });
    }
    if (state.adminFilterEmployee) list = list.filter(function (s) { return s.assignedTo === state.adminFilterEmployee; });
    var filters = '' +
      '<div class="filter-row">' +
      ["all", "assigned", "open", "flagged"].map(function (k) {
        return '<button class="chip-filter ' + (state.adminFilterStatus === k ? "active" : "") + '" data-afilter="' + k + '">' + k.charAt(0).toUpperCase() + k.slice(1) + '</button>';
      }).join("") +
      '<select id="admin-emp-filter" class="chip-filter" style="padding:6px 10px;"><option value="">Everyone</option>' +
      employees.map(function (n) { return '<option value="' + escapeHtml(n) + '" ' + (state.adminFilterEmployee === n ? "selected" : "") + '>' + escapeHtml(n) + '</option>'; }).join("") +
      '</select></div>';
    if (list.length === 0) return filters + '<div class="empty"><div class="big">🗂️</div>No shifts match this filter.</div>';
    var groups = groupByDate(list);
    var body = groups.map(function (g) {
      return '<div class="day-group"><div class="day-heading">' + fmtDate(g.date) + (g.date < today ? ' · past' : '') + '</div>' +
        g.items.map(function (s) { return renderAdminShiftRow(s, employees); }).join("") + '</div>';
    }).join("");
    return filters + body;
  }

  function renderAdminShiftRow(s, employees) {
    if (state.editingShiftId === s.id) return renderAdminEditForm(s, employees);
    var badge = s.status === "flagged" ? '<span class="badge flagged">Flagged</span>' : (s.assignedTo ? '<span class="badge assigned">Assigned</span>' : '<span class="badge open">Open</span>');
    var row = '' +
      '<div class="shift-card"><div class="shift-time mono">' + fmtRange(s.start, s.end) + '</div>' +
      '<div class="shift-main"><div class="shift-role">' + escapeHtml(s.role || "Shift") + '</div>' +
      '<div class="shift-sub">' + badge + ' ' + (s.assignedTo ? escapeHtml(s.assignedTo) : (s.status === "flagged" && s.flaggedBy ? 'was ' + escapeHtml(s.flaggedBy) + "'s" : '— unassigned —')) +
      (s.flagNote ? ' · "' + escapeHtml(s.flagNote) + '"' : '') + '</div></div>' +
      '<div class="shift-actions"><button class="btn ghost sm" data-duplicate="' + s.id + '">Duplicate</button>' +
      '<button class="btn ghost sm" data-edit="' + s.id + '">Edit</button>' +
      '<button class="btn danger sm" data-delete="' + s.id + '">Delete</button></div></div>';
    if (state.duplicateDraft.hasOwnProperty(s.id)) row += renderAdminDuplicatePanel(s);
    return row;
  }

  function renderAdminDuplicatePanel(s) {
    var dates = state.duplicateDraft[s.id] || [""];
    var inputStyle = "flex:1;border-radius:8px;border:1px solid var(--line);padding:9px 10px;background:var(--paper);color:var(--ink);font-family:inherit;font-size:14px;";
    return '' +
      '<div class="card" style="margin-top:-8px;">' +
      '<div class="hint" style="margin-bottom:8px;">Create a copy of this shift on each date below.</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;">' +
      dates.map(function (d, i) {
        return '' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
          '<input type="date" data-dup-shift="' + s.id + '" data-dup-idx="' + i + '" value="' + escapeHtml(d) + '" style="' + inputStyle + '" />' +
          (dates.length > 1 ? '<button class="btn ghost sm" data-dup-remove-shift="' + s.id + '" data-dup-remove-idx="' + i + '" type="button">✕</button>' : '') +
          '</div>';
      }).join("") +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
      '<button class="btn ghost sm" data-dup-add="' + s.id + '" type="button">+ Add another date</button>' +
      '<div class="form-actions" style="margin:0;">' +
      '<button class="btn ghost sm" data-dup-cancel="' + s.id + '">Cancel</button>' +
      '<button class="btn primary sm" data-dup-confirm="' + s.id + '">Duplicate</button>' +
      '</div></div></div>';
  }

  function renderAdminEditForm(s, employees) {
    return '' +
      '<div class="card"><h2>Edit shift</h2><div class="form-grid">' +
      '<div class="field"><label>Date</label><input type="date" id="ed-date" value="' + s.date + '" /></div>' +
      '<div class="field"><label>Role / label</label><input type="text" id="ed-role" value="' + escapeHtml(s.role || "") + '" /></div>' +
      '<div class="field"><label>Start</label><input type="time" id="ed-start" value="' + s.start + '" /></div>' +
      '<div class="field"><label>End</label><input type="time" id="ed-end" value="' + s.end + '" /></div>' +
      '<div class="field full"><label>Assigned to</label><select id="ed-assign"><option value="">— Leave open —</option>' +
      employees.map(function (n) { return '<option value="' + escapeHtml(n) + '" ' + (s.assignedTo === n ? "selected" : "") + '>' + escapeHtml(n) + '</option>'; }).join("") +
      '</select></div></div>' +
      '<div class="form-actions"><button class="btn ghost" data-edit-cancel="' + s.id + '">Cancel</button>' +
      '<button class="btn primary" data-edit-save="' + s.id + '">Save changes</button></div></div>';
  }
  function renderAdminNew() {
    var employees = state.settings.employees || [];
    var d = state.newShiftDraft;
    return '' +
      '<div class="card"><h2>Post a new shift</h2>' +
      '<div class="hint">Assign it to someone directly, or leave it open for anyone to claim.</div>' +
      '<div class="form-grid">' +
      '<div class="field"><label>Date</label><input type="date" id="ns-date" value="' + d.date + '" /></div>' +
      '<div class="field"><label>Role / label</label><input type="text" id="ns-role" placeholder="e.g. Front desk" value="' + escapeHtml(d.role) + '" /></div>' +
      '<div class="field"><label>Start time</label><input type="time" id="ns-start" value="' + d.start + '" /></div>' +
      '<div class="field"><label>End time</label><input type="time" id="ns-end" value="' + d.end + '" /></div>' +
      '<div class="field full"><label>Assign to</label><select id="ns-assign"><option value="">— Leave open —</option>' +
      employees.map(function (n) { return '<option value="' + escapeHtml(n) + '" ' + (d.assignedTo === n ? "selected" : "") + '>' + escapeHtml(n) + '</option>'; }).join("") +
      '</select></div></div>' +
      '<div class="form-actions"><button class="btn primary" id="ns-submit">Post shift</button></div></div>';
  }

  function renderAdminFlagged() {
    var flagged = state.shifts.filter(function (s) { return s.status === "flagged"; });
    if (flagged.length === 0) return '<div class="empty"><div class="big">👍</div>Nothing flagged — all clear.</div>';
    var employees = state.settings.employees || [];
    return groupByDate(flagged).map(function (g) {
      return '<div class="day-group"><div class="day-heading">' + fmtDate(g.date) + '</div>' +
        g.items.map(function (s) {
          return '' +
            '<div class="shift-card"><div class="shift-time mono">' + fmtRange(s.start, s.end) + '</div>' +
            '<div class="shift-main"><div class="shift-role">' + escapeHtml(s.role || "Shift") + '</div>' +
            '<div class="shift-sub">was ' + escapeHtml(s.flaggedBy || "—") + "'s" + (s.flagNote ? ' · "' + escapeHtml(s.flagNote) + '"' : '') + '</div></div>' +
            '<div class="shift-actions"><select data-reassign="' + s.id + '" style="border-radius:8px;border:1px solid var(--line);padding:7px 8px;background:var(--surface);color:var(--ink);font-size:13px;">' +
            '<option value="">Reassign to…</option>' + employees.map(function (n) { return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; }).join("") +
            '</select></div></div>';
        }).join("") + '</div>';
    }).join("");
  }

  function renderAdminRoster() {
    var employees = state.settings.employees || [];
    return '' +
      '<div class="card"><h2>Roster</h2><div class="hint">People who can appear in the name picker and be assigned shifts.</div>' +
      '<div class="roster-list" style="margin-bottom:14px;">' +
      (employees.map(function (n) { return '<div class="roster-chip">' + escapeHtml(n) + '<button data-remove-emp="' + escapeHtml(n) + '">✕</button></div>'; }).join("") || '<span style="color:var(--ink-faint);font-size:13px;">No one yet.</span>') +
      '</div><div style="display:flex;gap:8px;">' +
      '<input id="add-emp-name" type="text" placeholder="Full name" style="flex:1;border-radius:8px;border:1px solid var(--line);padding:9px 10px;background:var(--paper);color:var(--ink);font-family:inherit;font-size:14px;" />' +
      '<button class="btn" id="add-emp-btn">Add person</button></div></div>' +
      renderAdminsCard() +
      '<div class="card"><h2>Your admin code</h2><div class="hint">Only you use this one — changing it doesn\'t affect any other admin.</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<input id="new-own-code" type="text" placeholder="Set a new code for yourself" style="flex:1;border-radius:8px;border:1px solid var(--line);padding:9px 10px;background:var(--paper);color:var(--ink);font-family:inherit;font-size:14px;" />' +
      '<button class="btn" id="save-own-code-btn">Update</button></div></div>' +
      '<div class="card"><h2>This device</h2><div class="hint">Lock the admin panel on this device — you\'ll need your code again next time.</div>' +
      '<button class="btn danger" id="lock-admin-btn">Lock admin panel</button></div>';
  }

  function renderAdminsCard() {
    var admins = state.admins || [];
    var rows = admins.length ? admins.map(function (a) {
      return '<div class="admin-row"><div style="flex:1;min-width:120px;font-weight:600;">' + escapeHtml(a.name) +
        (a.name === state.identity.name ? ' <span style="color:var(--ink-faint);font-weight:500;">(you)</span>' : '') + '</div>' +
        '<div class="mono" style="background:var(--surface-2);padding:5px 10px;border-radius:7px;font-size:13px;letter-spacing:.03em;">' + escapeHtml(a.code) + '</div>' +
        '<button class="btn danger sm" data-remove-admin="' + escapeHtml(a.name) + '" ' + (admins.length <= 1 ? "disabled" : "") + '>Remove</button>' +
        '</div>';
    }).join("") : '<div class="hint">Loading…</div>';
    return '' +
      '<div class="card"><h2>Admins</h2><div class="hint">Anyone listed here can unlock the admin view with their own code below.</div>' +
      rows +
      '<div class="form-grid" style="margin-top:14px;">' +
      '<div class="field"><label>New admin\'s name</label><input id="new-admin-name" type="text" placeholder="Full name" /></div>' +
      '<div class="field"><label>Their code</label><div style="display:flex;gap:6px;">' +
      '<input id="new-admin-code" type="text" placeholder="A code just for them" style="flex:1;" />' +
      '<button class="btn sm" id="gen-admin-code" type="button" title="Generate a random code">Generate</button></div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn primary" id="add-admin-btn">Add admin</button></div>' +
      '<div class="hint" style="margin-top:6px;margin-bottom:0;">Share the code with them directly — whoever holds it has full admin access.</div>' +
      '</div>';
  }
  // ---------------- calendar ----------------
  function renderAdminCalendar() {
    var ym = state.calendarMonth;
    var p = ym.split("-").map(Number);
    var year = p[0], month = p[1]; // month is 1-based
    var firstWeekday = new Date(year, month - 1, 1).getDay(); // 0 = Sun
    var totalDays = daysInMonth(year, month);
    var today = todayISO();

    var byDate = {};
    state.shifts.forEach(function (s) { (byDate[s.date] = byDate[s.date] || []).push(s); });

    var cells = "";
    for (var i = 0; i < firstWeekday; i++) cells += '<div class="cal-cell cal-cell-empty"></div>';
    for (var day = 1; day <= totalDays; day++) {
      var iso = year + "-" + pad(month) + "-" + pad(day);
      var dayShifts = (byDate[iso] || []).slice().sort(shiftSort);
      var isToday = iso === today;
      var visible = dayShifts.slice(0, 4);
      cells += '' +
        '<div class="cal-cell' + (isToday ? " cal-today" : "") + '">' +
        '<div class="cal-daynum">' + day + '</div>' +
        '<div class="cal-shifts">' +
        visible.map(function (s) {
          var cls = s.status === "flagged" ? "flagged" : (s.assignedTo ? "assigned" : "open");
          var label = fmtTime(s.start) + " " + escapeHtml(s.role || "Shift") + (s.assignedTo ? " · " + escapeHtml(s.assignedTo) : "");
          return '<div class="cal-chip cal-chip-' + cls + '" data-cal-shift="' + s.id + '" title="' + label + '">' + label + '</div>';
        }).join("") +
        (dayShifts.length > 4 ? '<div class="cal-more">+' + (dayShifts.length - 4) + ' more</div>' : '') +
        '</div>' +
        '<button class="cal-add" data-cal-add="' + iso + '" type="button" title="Add a shift on this day">+</button>' +
        '</div>';
    }
    var totalCells = firstWeekday + totalDays;
    var trailing = (7 - (totalCells % 7)) % 7;
    for (var j = 0; j < trailing; j++) cells += '<div class="cal-cell cal-cell-empty"></div>';

    return '' +
      '<div class="cal-header">' +
      '<button class="btn ghost sm" id="cal-prev" type="button">‹</button>' +
      '<h2 class="cal-title">' + monthLabel(ym) + '</h2>' +
      '<button class="btn ghost sm" id="cal-next" type="button">›</button>' +
      '<button class="btn sm" id="cal-today-btn" type="button">Today</button>' +
      '</div>' +
      '<div class="cal-grid cal-weekdays">' +
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(function (d) { return '<div class="cal-weekday">' + d + '</div>'; }).join("") +
      '</div>' +
      '<div class="cal-grid">' + cells + '</div>';
  }
  // ---------------- bindings ----------------
  function bindApp() {
    var switchBtn = document.getElementById("switch-btn");
    if (switchBtn) switchBtn.onclick = function () { state.identity = null; saveIdentity(null); state.passcodeError = ""; render(); };
    Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (b) { b.onclick = function () { state.tab = b.dataset.tab; render(); }; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-atab]"), function (b) {
      b.onclick = function () {
        state.adminTab = b.dataset.atab;
        state.editingShiftId = null;
        render();
        if (state.adminTab === "roster") loadAdmins();
      };
    });
    if (state.identity.type === "admin") bindAdmin(); else bindEmployee();
  }

  function bindEmployee() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-flag]"), function (b) { b.onclick = function () { state.flagDraft[b.dataset.flag] = ""; render(); }; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-flag-cancel]"), function (b) { b.onclick = function () { delete state.flagDraft[b.dataset.flagCancel]; render(); }; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-flag-confirm]"), function (b) {
      b.onclick = function () {
        var id = b.dataset.flagConfirm;
        var noteEl = document.getElementById("flag-note-" + id);
        var note = noteEl ? noteEl.value.trim() : "";
        api("/api/shifts/" + id + "/flag", { name: state.identity.name, note: note }).then(function (res) {
          if (res.ok) { delete state.flagDraft[id]; toast("Marked unavailable — it's open for someone else to claim."); refresh(); }
          else toast("Couldn't update that shift. Try again.");
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-claim]"), function (b) {
      b.onclick = function () {
        api("/api/shifts/" + b.dataset.claim + "/claim", { name: state.identity.name }).then(function (res) {
          if (res.ok) { toast("Shift claimed — it's yours."); refresh(); }
          else if (res.data && res.data.error === "already_claimed") { toast("That shift was just claimed by someone else."); refresh(); }
          else toast("Couldn't claim that shift. Try again.");
        });
      };
    });
  }

  function loadAdmins() {
    return api("/api/admins/list", { code: state.adminCode }).then(function (res) {
      if (res.ok) { state.admins = res.data.admins || []; render(); }
      else handleAuthFailure(res);
    });
  }

  // Reads whatever is currently typed into a duplicate panel's date inputs
  // back into state before the list is mutated (add/remove a row) or
  // submitted, so in-progress edits aren't lost on the next render.
  function syncDupInputs(shiftId) {
    var inputs = document.querySelectorAll('[data-dup-shift="' + shiftId + '"]');
    var vals = [];
    Array.prototype.forEach.call(inputs, function (inp) { vals[parseInt(inp.dataset.dupIdx, 10)] = inp.value || ""; });
    state.duplicateDraft[shiftId] = vals;
  }
  function bindAdmin() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-afilter]"), function (b) { b.onclick = function () { state.adminFilterStatus = b.dataset.afilter; render(); }; });
    var empFilter = document.getElementById("admin-emp-filter");
    if (empFilter) empFilter.onchange = function () { state.adminFilterEmployee = empFilter.value; render(); };
    Array.prototype.forEach.call(document.querySelectorAll("[data-edit]"), function (b) { b.onclick = function () { state.editingShiftId = b.dataset.edit; render(); }; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-edit-cancel]"), function (b) { b.onclick = function () { state.editingShiftId = null; render(); }; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-edit-save]"), function (b) {
      b.onclick = function () {
        var id = b.dataset.editSave;
        api("/api/shifts/" + id + "/update", {
          code: state.adminCode,
          date: document.getElementById("ed-date").value,
          role: document.getElementById("ed-role").value.trim(),
          start: document.getElementById("ed-start").value,
          end: document.getElementById("ed-end").value,
          assignedTo: document.getElementById("ed-assign").value,
        }).then(function (res) {
          if (res.ok) { state.editingShiftId = null; toast("Shift updated."); refresh(); }
          else if (!handleAuthFailure(res)) toast("Couldn't save changes. Try again.");
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-delete]"), function (b) {
      b.onclick = function () {
        var id = b.dataset.delete;
        showConfirm("Delete this shift? This can't be undone.", function () {
          api("/api/shifts/" + id + "/delete", { code: state.adminCode }).then(function (res) {
            if (res.ok) { toast("Shift deleted."); refresh(); } else if (!handleAuthFailure(res)) toast("Couldn't delete. Try again.");
          });
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-duplicate]"), function (b) {
      b.onclick = function () {
        var id = b.dataset.duplicate;
        var shift = state.shifts.filter(function (x) { return x.id === id; })[0];
        state.duplicateDraft[id] = [shift ? addDays(shift.date, 7) : todayISO()];
        render();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-dup-cancel]"), function (b) {
      b.onclick = function () { delete state.duplicateDraft[b.dataset.dupCancel]; render(); };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-dup-add]"), function (b) {
      b.onclick = function () {
        var id = b.dataset.dupAdd;
        syncDupInputs(id);
        state.duplicateDraft[id].push("");
        render();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-dup-remove-shift]"), function (b) {
      b.onclick = function () {
        var id = b.dataset.dupRemoveShift;
        var idx = parseInt(b.dataset.dupRemoveIdx, 10);
        syncDupInputs(id);
        state.duplicateDraft[id].splice(idx, 1);
        render();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-dup-confirm]"), function (b) {
      b.onclick = function () {
        var id = b.dataset.dupConfirm;
        syncDupInputs(id);
        var seen = {};
        var dates = (state.duplicateDraft[id] || []).map(function (d) { return (d || "").trim(); }).filter(function (d) {
          if (!d || seen[d]) return false;
          seen[d] = true;
          return true;
        });
        if (dates.length === 0) { toast("Pick at least one date."); return; }
        api("/api/shifts/" + id + "/duplicate", { code: state.adminCode, dates: dates }).then(function (res) {
          if (res.ok) {
            delete state.duplicateDraft[id];
            toast(dates.length === 1 ? "Shift duplicated." : "Duplicated to " + dates.length + " days.");
            refresh();
          } else if (!handleAuthFailure(res)) toast("Couldn't duplicate that shift. Try again.");
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-reassign]"), function (sel) {
      sel.onchange = function () {
        if (!sel.value) return;
        api("/api/shifts/" + sel.dataset.reassign + "/update", { code: state.adminCode, assignedTo: sel.value }).then(function (res) {
          if (res.ok) { toast("Reassigned to " + sel.value + "."); refresh(); } else if (!handleAuthFailure(res)) toast("Couldn't reassign. Try again.");
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-remove-emp]"), function (b) {
      b.onclick = function () {
        var name = b.dataset.removeEmp;
        showConfirm("Remove " + name + " from the roster? Their existing shifts stay assigned to them until reassigned.", function () {
          api("/api/roster/remove", { code: state.adminCode, name: name }).then(function (res) {
            if (res.ok) { toast("Removed " + name + "."); refresh(); } else if (!handleAuthFailure(res)) toast("Couldn't remove — try again.");
          });
        }, "Remove");
      };
    });
    var addEmpBtn = document.getElementById("add-emp-btn");
    if (addEmpBtn) {
      addEmpBtn.onclick = function () {
        var input = document.getElementById("add-emp-name");
        var v = input.value.trim();
        if (!v) return;
        api("/api/roster/add", { code: state.adminCode, name: v }).then(function (res) {
          if (res.ok) { toast("Added " + v + "."); refresh(); } else if (!handleAuthFailure(res)) toast("Couldn't add — try again.");
        });
      };
      document.getElementById("add-emp-name").onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); addEmpBtn.click(); } };
    }

    var genBtn = document.getElementById("gen-admin-code");
    if (genBtn) genBtn.onclick = function () { document.getElementById("new-admin-code").value = genCode(); };
    var addAdminBtn = document.getElementById("add-admin-btn");
    if (addAdminBtn) {
      addAdminBtn.onclick = function () {
        var name = document.getElementById("new-admin-name").value.trim();
        var code = document.getElementById("new-admin-code").value.trim();
        if (!name || !code) { toast("Enter a name and a code for the new admin."); return; }
        api("/api/admins/add", { code: state.adminCode, name: name, newCode: code }).then(function (res) {
          if (res.ok) { state.admins = res.data.admins || []; toast("Added " + name + " as an admin."); render(); }
          else if (res.data && res.data.error === "code_taken") toast("That code is already in use — try another.");
          else if (res.data && res.data.error === "name_taken") toast("There's already an admin with that name.");
          else if (!handleAuthFailure(res)) toast("Couldn't add that admin. Try again.");
        });
      };
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-remove-admin]"), function (b) {
      b.onclick = function () {
        var name = b.dataset.removeAdmin;
        showConfirm("Remove " + name + " as an admin? Their code will stop working immediately.", function () {
          api("/api/admins/remove", { code: state.adminCode, name: name }).then(function (res) {
            if (res.ok) {
              state.admins = res.data.admins || [];
              toast("Removed " + name + ".");
              if (name === state.identity.name) { state.identity = null; saveIdentity(null); saveAdminCode(""); }
              render();
            } else if (res.data && res.data.error === "last_admin") toast("Can't remove the last admin.");
            else if (!handleAuthFailure(res)) toast("Couldn't remove — try again.");
          });
        }, "Remove");
      };
    });
    var saveOwnCodeBtn = document.getElementById("save-own-code-btn");
    if (saveOwnCodeBtn) {
      saveOwnCodeBtn.onclick = function () {
        var v = document.getElementById("new-own-code").value.trim();
        if (!v) return;
        api("/api/admins/update-code", { code: state.adminCode, newCode: v }).then(function (res) {
          if (res.ok) {
            state.adminCode = v; saveAdminCode(v);
            document.getElementById("new-own-code").value = "";
            toast("Your admin code was updated.");
            loadAdmins();
          } else if (res.data && res.data.error === "code_taken") toast("That code is already in use — try another.");
          else if (!handleAuthFailure(res)) toast("Couldn't update — try again.");
        });
      };
    }
    var lockBtn = document.getElementById("lock-admin-btn");
    if (lockBtn) lockBtn.onclick = function () { state.identity = null; saveIdentity(null); saveAdminCode(""); render(); };

    var nsSubmit = document.getElementById("ns-submit");
    if (nsSubmit) {
      nsSubmit.onclick = function () {
        var d = {
          date: document.getElementById("ns-date").value || todayISO(),
          start: document.getElementById("ns-start").value || "09:00",
          end: document.getElementById("ns-end").value || "17:00",
          role: document.getElementById("ns-role").value.trim(),
          assignedTo: document.getElementById("ns-assign").value,
        };
        if (!d.date || !d.start || !d.end) { toast("Please fill in the date and times."); return; }
        api("/api/shifts/create", Object.assign({ code: state.adminCode }, d)).then(function (res) {
          if (res.ok) {
            toast("Shift posted.");
            state.newShiftDraft = { date: d.date, start: "09:00", end: "17:00", role: "", assignedTo: "" };
            refresh();
          } else if (!handleAuthFailure(res)) toast("Couldn't post that shift. Try again.");
        });
      };
    }

    var calPrev = document.getElementById("cal-prev");
    if (calPrev) calPrev.onclick = function () { state.calendarMonth = shiftMonth(state.calendarMonth, -1); render(); };
    var calNext = document.getElementById("cal-next");
    if (calNext) calNext.onclick = function () { state.calendarMonth = shiftMonth(state.calendarMonth, 1); render(); };
    var calTodayBtn = document.getElementById("cal-today-btn");
    if (calTodayBtn) calTodayBtn.onclick = function () { state.calendarMonth = todayISO().slice(0, 7); render(); };
    Array.prototype.forEach.call(document.querySelectorAll("[data-cal-add]"), function (b) {
      b.onclick = function () {
        state.newShiftDraft = { date: b.dataset.calAdd, start: "09:00", end: "17:00", role: "", assignedTo: "" };
        state.adminTab = "new";
        render();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-cal-shift]"), function (el) {
      el.onclick = function () {
        state.adminTab = "all";
        state.adminFilterStatus = "all";
        state.adminFilterEmployee = "";
        state.editingShiftId = el.dataset.calShift;
        render();
      };
    });
  }
  // ---------------- data refresh / polling ----------------
  // A background poll must never blow away a form the admin (or an employee
  // flagging a shift) is still filling in — the New Shift / Edit shift forms
  // aren't wired up to re-populate themselves from fresh state, so a
  // re-render mid-edit would silently discard whatever was typed or picked.
  function isFormBusy() {
    var el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return true;
    if (state.editingShiftId) return true; // the "Edit shift" form is open
    if (state.identity && state.identity.type === "admin" && state.adminTab === "new") return true; // "New Shift" form is showing
    if (Object.keys(state.flagDraft).length > 0) return true; // a "flag unavailable" note is open
    if (Object.keys(state.duplicateDraft).length > 0) return true; // a "duplicate to dates" panel is open
    return false;
  }
  function refresh(isPoll) {
    return apiGet("/api/state").then(function (data) {
      state.settings = data.settings || { exists: false, employees: [] };
      state.shifts = data.shifts || [];
      state.loaded = true;
      // Data is stored either way, above — just skip the re-render (and
      // whatever it would wipe out) while a form is in use. The next
      // non-blocked render (leaving the tab, submitting, canceling) picks
      // up the fresh data automatically, no extra fetch needed.
      if (isPoll && isFormBusy()) return;
      render();
    }).catch(function () {
      if (isPoll && isFormBusy()) return;
      state.loaded = true;
      render();
    });
  }

  refresh();
  setInterval(function () { refresh(true); }, 4000);
})();
