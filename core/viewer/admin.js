/* =========================================================
   ADMIN — Dashboard, kick/mute, bug reports, and deploy history
   ========================================================= */

// ── Bug Report ──

var bugReportBtn = document.getElementById("open-bug-report");
var bugReportModal = document.getElementById("bug-report-modal");
var bugReportDesc = document.getElementById("bug-report-desc");
var bugReportStatsEl = document.getElementById("bug-report-stats");
var bugReportStatusEl = document.getElementById("bug-report-status");
var submitBugReportBtn = document.getElementById("submit-bug-report");
var closeBugReportBtn = document.getElementById("close-bug-report");
var bugReportFileInput = document.getElementById("bug-report-file");
var bugReportScreenshotBtn = document.getElementById("bug-report-screenshot-btn");
var bugReportFileName = document.getElementById("bug-report-file-name");
var bugReportPreview = document.getElementById("bug-report-screenshot-preview");
var _bugReportScreenshotUrl = null;

function openBugReport() {
  if (!bugReportModal) return;
  bugReportModal.classList.remove("hidden");
  if (bugReportDesc) bugReportDesc.value = "";
  if (bugReportStatusEl) bugReportStatusEl.textContent = "";
  // Reset screenshot state
  _bugReportScreenshotUrl = null;
  if (bugReportFileInput) bugReportFileInput.value = "";
  if (bugReportFileName) bugReportFileName.textContent = "";
  if (bugReportPreview) { bugReportPreview.innerHTML = ""; bugReportPreview.classList.add("hidden"); }
  if (bugReportStatsEl) {
    if (_latestScreenStats) {
      var s = _latestScreenStats;
      bugReportStatsEl.innerHTML =
        '<div class="bug-stats-preview">Auto-captured: ' + (s.screen_fps || 0) + 'fps ' +
        (s.screen_width || 0) + 'x' + (s.screen_height || 0) + ' ' +
        ((s.screen_bitrate_kbps || 0) / 1000).toFixed(1) + 'Mbps ' +
        'BWE=' + ((s.bwe_kbps || 0) / 1000).toFixed(1) + 'Mbps ' +
        (s.encoder || '?') + ' ' + (s.quality_limitation || 'none') + '</div>';
    } else {
      bugReportStatsEl.innerHTML = '<div class="bug-stats-preview">No active screen share stats</div>';
    }
  }
  if (bugReportDesc) bugReportDesc.focus();
}

function closeBugReportModal() {
  if (bugReportModal) bugReportModal.classList.add("hidden");
}

async function sendBugReport() {
  if (!bugReportDesc) return;
  var desc = bugReportDesc.value.trim();
  if (!desc) {
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Please describe your feedback.";
    return;
  }
  var token = adminToken;
  if (!token) {
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Not connected.";
    return;
  }
  var feedbackType = "bug";
  var checkedRadio = document.querySelector('input[name="feedback-type"]:checked');
  if (checkedRadio) feedbackType = checkedRadio.value;
  var payload = {
    description: desc,
    feedback_type: feedbackType,
    identity: room?.localParticipant?.identity || "",
    name: room?.localParticipant?.name || "",
    room: currentRoomName || "",
  };
  if (_bugReportScreenshotUrl) {
    payload.screenshot_url = _bugReportScreenshotUrl;
  }
  if (_latestScreenStats) {
    Object.assign(payload, _latestScreenStats);
  }
  try {
    if (submitBugReportBtn) submitBugReportBtn.disabled = true;
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Sending...";
    var res = await fetch(apiUrl("/api/bug-report"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      if (bugReportStatusEl) bugReportStatusEl.textContent = "Feedback sent! Thank you.";
      bugReportDesc.value = "";
      setTimeout(closeBugReportModal, 1500);
    } else {
      if (bugReportStatusEl) bugReportStatusEl.textContent = "Failed (status " + res.status + ")";
    }
  } catch (e) {
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Error: " + e.message;
  } finally {
    if (submitBugReportBtn) submitBugReportBtn.disabled = false;
  }
}

if (bugReportBtn) {
  bugReportBtn.addEventListener("click", openBugReport);
}
if (closeBugReportBtn) {
  closeBugReportBtn.addEventListener("click", closeBugReportModal);
}
if (submitBugReportBtn) {
  submitBugReportBtn.addEventListener("click", sendBugReport);
}
if (bugReportDesc) {
  bugReportDesc.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      sendBugReport();
    }
  });
}
// Screenshot attachment for bug reports
if (bugReportScreenshotBtn && bugReportFileInput) {
  bugReportScreenshotBtn.addEventListener("click", function() {
    bugReportFileInput.click();
  });
  bugReportFileInput.addEventListener("change", async function() {
    var file = bugReportFileInput.files && bugReportFileInput.files[0];
    if (!file) return;
    if (bugReportFileName) bugReportFileName.textContent = file.name;
    // Show preview
    if (bugReportPreview) {
      var imgPreview = document.createElement("img");
      imgPreview.src = URL.createObjectURL(file);
      bugReportPreview.innerHTML = "";
      bugReportPreview.appendChild(imgPreview);
      bugReportPreview.classList.remove("hidden");
    }
    // Upload to server using chat upload endpoint
    try {
      if (bugReportStatusEl) bugReportStatusEl.textContent = "Uploading screenshot...";
      var formData = new FormData();
      formData.append("file", file);
      var uploadResp = await fetch(apiUrl("/api/chat/upload"), {
        method: "POST",
        headers: { Authorization: "Bearer " + adminToken },
        body: formData,
      });
      var uploadData = await uploadResp.json().catch(function() { return {}; });
      if (uploadData.ok && uploadData.url) {
        _bugReportScreenshotUrl = uploadData.url;
        if (bugReportStatusEl) bugReportStatusEl.textContent = "Screenshot attached.";
      } else {
        if (bugReportStatusEl) bugReportStatusEl.textContent = "Screenshot upload failed.";
      }
    } catch (e) {
      if (bugReportStatusEl) bugReportStatusEl.textContent = "Screenshot upload error: " + e.message;
    }
  });
}

// ═══════════════════════════════════════════
// ADMIN PANEL
// ═══════════════════════════════════════════

var _adminDashTimer = null;
var _adminDashOpen = false;

function adminKickParticipant(identity) {
  if (!confirm("Kick " + identity + " from the room?")) return;
  var roomId = currentRoomName;
  if (!roomId) return;
  fetch(apiUrl("/v1/rooms/" + encodeURIComponent(roomId) + "/kick/" + encodeURIComponent(identity)), {
    method: "POST",
    headers: { "Authorization": "Bearer " + adminToken }
  }).then(function(res) {
    if (res.ok) {
      setStatus("Kicked " + identity);
      // Remove the card immediately since they're gone
      var cardRef = participantCards.get(identity);
      if (cardRef) cardRef.card.remove();
      participantCards.delete(identity);
      participantState.delete(identity);
    } else if (res.status === 502) {
      // 502 = SFU returned error (e.g. 404 participant not found)
      setStatus(identity + " already left the room", true);
      // Clean up stale card
      var cardRef = participantCards.get(identity);
      if (cardRef) cardRef.card.remove();
      participantCards.delete(identity);
      participantState.delete(identity);
    } else {
      setStatus("Kick failed: " + res.status, true);
    }
  }).catch(function(e) {
    setStatus("Kick error: " + e.message, true);
  });
}

function adminMuteParticipant(identity) {
  var roomId = currentRoomName;
  if (!roomId) return;
  fetch(apiUrl("/v1/rooms/" + encodeURIComponent(roomId) + "/mute/" + encodeURIComponent(identity)), {
    method: "POST",
    headers: { "Authorization": "Bearer " + adminToken }
  }).then(function(res) {
    if (res.ok) {
      setStatus("Server-muted " + identity);
    } else {
      setStatus("Mute failed: " + res.status, true);
    }
  }).catch(function(e) {
    setStatus("Mute error: " + e.message, true);
  });
}

function toggleAdminDash() {
  var panel = document.getElementById("admin-dash-panel");
  if (!panel) return;
  _adminDashOpen = !_adminDashOpen;
  if (_adminDashOpen) {
    panel.classList.remove("hidden");
    fetchAdminDashboard();
    fetchAdminHistory();
    fetchAdminDashboardMetrics();
    fetchAdminMetrics();
    fetchAdminBugs();
    _adminDashTimer = setInterval(function() {
      fetchAdminDashboard();
      fetchAdminMetrics();
    }, 3000);
  } else {
    panel.classList.add("hidden");
    if (_adminDashTimer) {
      clearInterval(_adminDashTimer);
      _adminDashTimer = null;
    }
  }
}

(function initAdminResize() {
  var panel = document.getElementById("admin-dash-panel");
  if (!panel) return;
  var handle = document.createElement("div");
  handle.className = "admin-dash-resize-handle";
  panel.appendChild(handle);

  var saved = localStorage.getItem("admin-panel-width");
  if (saved) panel.style.setProperty("--admin-panel-width", saved + "px");

  var dragging = false;
  handle.addEventListener("mousedown", function(e) {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", function(e) {
    if (!dragging) return;
    var w = window.innerWidth - e.clientX;
    if (w < 400) w = 400;
    if (w > window.innerWidth * 0.8) w = window.innerWidth * 0.8;
    panel.style.setProperty("--admin-panel-width", w + "px");
  });
  document.addEventListener("mouseup", function() {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    var current = panel.style.getPropertyValue("--admin-panel-width");
    if (current) localStorage.setItem("admin-panel-width", parseInt(current));
  });
})();

function switchAdminTab(btn, tabId) {
  document.querySelectorAll(".admin-dash-content").forEach(function(el) { el.classList.add("hidden"); });
  document.querySelectorAll(".adm-tab").forEach(function(el) { el.classList.remove("active"); });
  var tab = document.getElementById(tabId);
  if (tab) tab.classList.remove("hidden");
  btn.classList.add("active");
  if (tabId === "admin-dash-deploys") fetchAdminDeploys();
}

function fmtDur(secs) {
  if (secs == null) return "";
  var h = Math.floor(secs / 3600);
  var m = Math.floor((secs % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return Math.max(1, Math.floor(secs)) + "s";
}

function fmtTime(ts) {
  var d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function fetchAdminDashboard() {
  try {
    var res = await fetch(apiUrl("/admin/api/dashboard"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    var data = await res.json();
    var el = document.getElementById("admin-dash-live");
    if (!el) return;
    var total = data.total_online || 0;
    var sv = data.server_version || "";
    var html = '<div class="adm-stat-row"><span class="adm-stat-label">Online' + (sv ? ' · v' + sv : '') + '</span><span class="adm-stat-value">' + total + '</span></div>';
    if (data.rooms && data.rooms.length > 0) {
      data.rooms.forEach(function(room) {
        var pCount = room.participants ? room.participants.length : 0;
        html += '<div class="adm-room-card"><div class="adm-room-header">' + escAdm(room.room_id) + ' <span class="adm-room-count">' + pCount + '</span></div>';
        (room.participants || []).forEach(function(p) {
          var s = p.stats || {};
          var chips = "";
          // Version badge
          var vv = p.viewer_version;
          if (!vv) {
            chips += '<span class="adm-badge adm-badge-bad">STALE</span>';
          } else if (sv && vv !== sv) {
            chips += '<span class="adm-badge adm-badge-bad">v' + escAdm(vv) + '</span>';
          } else {
            chips += '<span class="adm-badge adm-badge-ok">v' + escAdm(vv) + '</span>';
          }
          if (s.ice_remote_type) chips += '<span class="adm-badge adm-ice-' + s.ice_remote_type + '">' + s.ice_remote_type + '</span>';
          if (s.screen_fps != null) chips += '<span class="adm-chip">' + s.screen_fps + 'fps ' + s.screen_width + 'x' + s.screen_height + '</span>';
          if (s.quality_limitation && s.quality_limitation !== "none") chips += '<span class="adm-badge adm-badge-warn">' + s.quality_limitation + '</span>';
          html += '<div class="adm-participant"><span>' + escAdm(p.name || p.identity) + '</span><span class="adm-time">' + fmtDur(p.online_seconds) + '</span>' + chips + '</div>';
        });
        html += '</div>';
      });
    } else {
      html += '<div class="adm-empty">No active rooms</div>';
    }
    el.innerHTML = html;
  } catch (e) {}
}

async function fetchAdminHistory() {
  try {
    var res = await fetch(apiUrl("/admin/api/sessions"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    var data = await res.json();
    var el = document.getElementById("admin-dash-history");
    if (!el) return;
    var events = data.events || [];
    if (events.length === 0) {
      el.innerHTML = '<div class="adm-empty">No session history</div>';
      return;
    }
    var html = '<table class="adm-table"><thead><tr><th>Time</th><th>Event</th><th>User</th><th>Room</th><th>Duration</th></tr></thead><tbody>';
    var lastDateKey = "";
    events.forEach(function(ev) {
      var d = new Date(ev.timestamp * 1000);
      var dateKey = d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
      if (dateKey !== lastDateKey) {
        html += '<tr class="adm-date-sep"><td colspan="5">' + dateKey + '</td></tr>';
        lastDateKey = dateKey;
      }
      var isJoin = ev.event_type === "join";
      html += '<tr><td>' + fmtTime(ev.timestamp) + '</td><td><span class="adm-badge ' + (isJoin ? 'adm-join' : 'adm-leave') + '">' + (isJoin ? 'JOIN' : 'LEAVE') + '</span></td><td>' + escAdm(ev.name || ev.identity) + '</td><td>' + escAdm(ev.room_id) + '</td><td>' + (ev.duration_secs != null ? fmtDur(ev.duration_secs) : '') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {}
}

var _admUserColors = [
  "#e8922f","#3b9dda","#49b86d","#c75dba","#d65757","#c9b83e","#6ec4c4","#8b7dd6",
  "#e06080","#40c090","#d4a030","#5c8de0","#c0604c","#50d0b0","#a070e0","#d09050",
  "#60b858","#9060c0","#e07898","#44b8c8","#b8a040","#7088d8","#c87858","#48c868",
  "#b860a8","#e0a870","#58a0d0","#a0c048","#d870a0","#60d0a0"
];
function _admUserColor(name) {
  var hash = 5381;
  for (var i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  return _admUserColors[hash % _admUserColors.length];
}

var _admDashboardData = null;
var _admBugData = null;
var _admSelectedUser = null;
var _admHeatmapUsers = {};

function _admSelectUser(name) {
  _admSelectedUser = (_admSelectedUser === name) ? null : name;
  renderAdminDashboard();
}

function _admHeatCellClick(e, dateKey, hour) {
  var old = document.getElementById("adm-heat-popup");
  if (old) old.remove();
  var users = (_admHeatmapUsers[dateKey] && _admHeatmapUsers[dateKey][hour]) || {};
  var names = Object.keys(users);
  if (names.length === 0) return;
  names.sort(function(a, b) { return users[b] - users[a]; });
  var dt = new Date(dateKey + "T00:00:00");
  var dayLabel = dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  var hourLabel = (hour % 12 || 12) + (hour < 12 ? "a" : "p");
  var ph = '<div class="adm-heat-popup-title">' + dayLabel + ' ' + hourLabel + '</div>';
  names.forEach(function(n) {
    ph += '<div class="adm-heat-popup-row"><span class="adm-heat-popup-dot" style="background:' + _admUserColor(n) + '"></span>' + escAdm(n) + '<span class="adm-heat-popup-count">' + users[n] + '</span></div>';
  });
  var popup = document.createElement("div");
  popup.id = "adm-heat-popup";
  popup.className = "adm-heat-popup";
  popup.innerHTML = ph;
  document.body.appendChild(popup);
  var rect = e.target.getBoundingClientRect();
  popup.style.top = (rect.bottom + 4) + "px";
  popup.style.left = Math.min(rect.left, window.innerWidth - 200) + "px";
  setTimeout(function() {
    document.addEventListener("click", function dismiss(ev) {
      if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener("click", dismiss); }
    });
  }, 0);
}

async function fetchAdminDashboardMetrics() {
  try {
    var res = await fetch(apiUrl("/admin/api/metrics/dashboard"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) { console.error("[admin] dashboard metrics fetch failed:", res.status); return; }
    _admDashboardData = await res.json();
    // Also fetch bug data for charts
    try {
      var bugRes = await fetch(apiUrl("/admin/api/bugs"), {
        headers: { "Authorization": "Bearer " + adminToken }
      });
      if (bugRes.ok) _admBugData = await bugRes.json();
    } catch (e2) { console.error("[admin] bug fetch error:", e2); }
    renderAdminDashboard();
  } catch (e) { console.error("[admin] fetchAdminDashboardMetrics error:", e); }
}

function renderAdminDashboard() {
  var el = document.getElementById("admin-dash-metrics");
  if (!el || !_admDashboardData) return;
  var d = _admDashboardData;
  var s = d.summary || {};
  var html = "";

  // ── Summary Cards ──
  html += '<div class="adm-cards">';
  html += '<div class="adm-card"><div class="adm-card-value">' + (s.total_sessions || 0) + '</div><div class="adm-card-label">Sessions (30d)</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (s.unique_users || 0) + '</div><div class="adm-card-label">Unique Users</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (s.total_hours || 0) + '</div><div class="adm-card-label">Total Hours</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (s.avg_duration_mins || 0) + 'm</div><div class="adm-card-label">Avg Duration</div></div>';
  html += '</div>';

  // ── User Leaderboard (clickable) ──
  var users = d.per_user || [];
  if (users.length > 0) {
    var maxCount = users[0].session_count || 1;
    html += '<div class="adm-section"><div class="adm-section-title">User Leaderboard (30d)</div>';
    users.forEach(function(u) {
      var uname = u.name || u.identity;
      var pct = Math.max(2, (u.session_count / maxCount) * 100);
      var col = _admUserColor(uname);
      var selClass = _admSelectedUser === uname ? " adm-lb-selected" : "";
      html += '<div class="adm-leaderboard-bar' + selClass + '" onclick="_admSelectUser(\'' + escAdm(uname).replace(/'/g, "\\'") + '\')"><span class="adm-leaderboard-name">' + escAdm(uname) + '</span><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + col + '"></div><span class="adm-leaderboard-count">' + u.session_count + ' (' + u.total_hours + 'h)</span></div>';
    });
    html += '</div>';
  }

  // ── Activity Heatmap (client-side timezone, per-user tracking) ──
  var heatJoins = d.heatmap_joins || [];
  if (heatJoins.length > 0) {
    var heatmap = {};
    _admHeatmapUsers = {};
    heatJoins.forEach(function(j) {
      var dt = new Date(j.timestamp * 1000);
      var dateKey = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
      var hour = dt.getHours();
      var name = j.name || "Unknown";
      if (!_admHeatmapUsers[dateKey]) _admHeatmapUsers[dateKey] = {};
      if (!_admHeatmapUsers[dateKey][hour]) _admHeatmapUsers[dateKey][hour] = {};
      _admHeatmapUsers[dateKey][hour][name] = (_admHeatmapUsers[dateKey][hour][name] || 0) + 1;
      if (!_admSelectedUser || name === _admSelectedUser) {
        if (!heatmap[dateKey]) heatmap[dateKey] = {};
        heatmap[dateKey][hour] = (heatmap[dateKey][hour] || 0) + 1;
      }
    });
    var heatDays = Object.keys(_admHeatmapUsers).sort().slice(-30);
    var heatMax = 1;
    heatDays.forEach(function(dk) {
      if (!heatmap[dk]) return;
      Object.keys(heatmap[dk]).forEach(function(h) { if (heatmap[dk][h] > heatMax) heatMax = heatmap[dk][h]; });
    });

    html += '<div class="adm-section"><div class="adm-section-title">Activity Heatmap (30d)</div>';
    if (_admSelectedUser) {
      html += '<div style="margin-bottom:8px;"><button class="adm-show-all-btn" onclick="_admSelectUser(null)">Show All</button> Filtered: <strong>' + escAdm(_admSelectedUser) + '</strong></div>';
    }
    html += '<div class="adm-chart-wrap"><div class="adm-heatmap-wrap"><div class="adm-heatmap-grid">';
    html += '<div class="adm-heatmap-label"></div>';
    for (var h = 0; h < 24; h++) {
      html += '<div class="adm-heatmap-hlabel">' + (h % 3 === 0 ? h + "" : "") + '</div>';
    }
    var selColor = _admSelectedUser ? _admUserColor(_admSelectedUser) : null;
    heatDays.forEach(function(dk) {
      var dayLabel = new Date(dk + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      html += '<div class="adm-heatmap-label">' + dayLabel + '</div>';
      for (var hr = 0; hr < 24; hr++) {
        var count = (heatmap[dk] && heatmap[dk][hr]) || 0;
        var intensity = count / heatMax;
        var bg;
        if (count === 0) {
          bg = "rgba(255,255,255,0.03)";
        } else if (selColor) {
          // Use selected user's color
          var r = parseInt(selColor.slice(1,3),16), g = parseInt(selColor.slice(3,5),16), b = parseInt(selColor.slice(5,7),16);
          bg = "rgba(" + r + "," + g + "," + b + "," + (0.2 + intensity * 0.8).toFixed(2) + ")";
        } else {
          bg = "rgba(232,146,47," + (0.2 + intensity * 0.8).toFixed(2) + ")";
        }
        html += '<div class="adm-heatmap-cell" style="background:' + bg + ';cursor:pointer" title="' + dayLabel + ' ' + hr + ':00 — ' + count + ' joins" onclick="_admHeatCellClick(event,\'' + dk + '\',' + hr + ')"></div>';
      }
    });
    html += '</div></div></div></div>';
  }

  // ── Session Timeline (today, local timezone) ──
  var tlEvents = d.timeline_events || [];
  if (tlEvents.length > 0) {
    var nowDate = new Date();
    var todayLocal = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    var todayStartTs = todayLocal.getTime() / 1000;
    var nowTs = Date.now() / 1000;
    var todayEvts = tlEvents.filter(function(e) { return e.timestamp >= todayStartTs; });
    var tlMap = {};
    var openJoins = {};
    todayEvts.sort(function(a, b) { return a.timestamp - b.timestamp; });
    todayEvts.forEach(function(ev) {
      var key = ev.name || ev.identity;
      if (ev.event_type === "join") {
        openJoins[ev.identity] = { ts: ev.timestamp, name: key };
        if (!tlMap[key]) tlMap[key] = [];
      } else if (ev.event_type === "leave") {
        var start = openJoins[ev.identity] ? openJoins[ev.identity].ts : todayStartTs;
        delete openJoins[ev.identity];
        if (!tlMap[key]) tlMap[key] = [];
        tlMap[key].push({ start: start, end: ev.timestamp });
      }
    });
    Object.keys(openJoins).forEach(function(id) {
      var oj = openJoins[id];
      if (!tlMap[oj.name]) tlMap[oj.name] = [];
      tlMap[oj.name].push({ start: oj.ts, end: nowTs });
    });
    var tlUsers = Object.keys(tlMap);
    if (tlUsers.length > 0) {
      html += '<div class="adm-section"><div class="adm-section-title">Today\'s Sessions</div><div class="adm-chart-wrap">';
      html += '<div class="adm-timeline-axis">';
      for (var th = 0; th < 24; th += 3) {
        html += '<span>' + (th === 0 ? '12a' : th < 12 ? th + 'a' : th === 12 ? '12p' : (th - 12) + 'p') + '</span>';
      }
      html += '</div>';
      tlUsers.forEach(function(uname) {
        var col = _admUserColor(uname);
        html += '<div class="adm-timeline-row"><span class="adm-timeline-name">' + escAdm(uname) + '</span><div class="adm-timeline-track">';
        (tlMap[uname] || []).forEach(function(sp) {
          var left = Math.max(0, ((sp.start - todayStartTs) / 86400) * 100);
          var width = Math.max(0.5, ((sp.end - sp.start) / 86400) * 100);
          html += '<div class="adm-timeline-span" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%;background:' + col + '"></div>';
        });
        html += '</div></div>';
      });
      html += '</div></div>';
    }
  }

  // ── Bug Reports Summary (on Metrics tab) ──
  var bugs = (_admBugData && _admBugData.reports) || [];
  if (bugs.length > 0) {
    var bugsByUser = {};
    bugs.forEach(function(b) {
      var name = b.name || b.reporter || b.identity || "Unknown";
      bugsByUser[name] = (bugsByUser[name] || 0) + 1;
    });
    var bugUserArr = Object.keys(bugsByUser).map(function(n) {
      return { name: n, count: bugsByUser[n] };
    }).sort(function(a, b) { return b.count - a.count; });
    var bugMax = bugUserArr[0].count;

    html += '<div class="adm-section"><div class="adm-section-title">Bug Reports by User</div>';
    bugUserArr.forEach(function(u) {
      var pct = (u.count / bugMax) * 100;
      html += '<div class="adm-leaderboard-bar"><div class="adm-leaderboard-name">' + escAdm(u.name) + '</div><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + _admUserColor(u.name) + '"></div><div class="adm-leaderboard-count">' + u.count + '</div></div>';
    });
    html += '</div>';

    // Bugs by Day
    var bugsByDay = {};
    bugs.forEach(function(b) {
      var dt = new Date(b.timestamp * 1000);
      var dk = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
      bugsByDay[dk] = (bugsByDay[dk] || 0) + 1;
    });
    var bugDays = Object.keys(bugsByDay).sort();
    var bugDayMax = Math.max.apply(null, bugDays.map(function(d) { return bugsByDay[d]; }));

    html += '<div class="adm-section"><div class="adm-section-title">Bugs by Day</div>';
    html += '<div class="adm-bugs-by-day">';
    bugDays.forEach(function(dk) {
      var count = bugsByDay[dk];
      var pct = (count / bugDayMax) * 100;
      var dt = new Date(dk + "T12:00:00");
      var label = dt.toLocaleDateString([], { month: "short", day: "numeric" });
      html += '<div class="adm-bug-day-col"><div class="adm-bug-day-bar" style="height:' + pct + '%" title="' + label + ': ' + count + ' bugs"></div><div class="adm-bug-day-count">' + count + '</div><div class="adm-bug-day-label">' + label + '</div></div>';
    });
    html += '</div></div>';
  }

  // Quality stats rendered below by renderAdminQuality
  html += '<div id="admin-dash-metrics-quality"></div>';
  el.innerHTML = html;
}

var _admQualityData = null;

async function fetchAdminMetrics() {
  try {
    var res = await fetch(apiUrl("/admin/api/metrics"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    _admQualityData = await res.json();
    renderAdminQuality();
  } catch (e) {}
}

function renderAdminQuality() {
  var container = document.getElementById("admin-dash-metrics-quality");
  if (!container || !_admQualityData) return;
  var users = _admQualityData.users || [];
  if (users.length === 0) {
    container.innerHTML = '<div class="adm-empty">No quality data yet</div>';
    return;
  }

  var html = '';

  // ── Quality Summary Cards ──
  var totalFps = 0, totalBitrate = 0, totalBw = 0, totalCpu = 0, n = users.length;
  users.forEach(function(u) {
    totalFps += u.avg_fps;
    totalBitrate += u.avg_bitrate_kbps;
    totalBw += u.pct_bandwidth_limited;
    totalCpu += u.pct_cpu_limited;
  });
  html += '<div class="adm-section"><div class="adm-section-title">Stream Quality Overview</div>';
  html += '<div class="adm-cards">';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalFps / n).toFixed(1) + '</div><div class="adm-card-label">Avg FPS</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalBitrate / n / 1000).toFixed(1) + '</div><div class="adm-card-label">Avg Mbps</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalBw / n).toFixed(1) + '%</div><div class="adm-card-label">BW Limited</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalCpu / n).toFixed(1) + '%</div><div class="adm-card-label">CPU Limited</div></div>';
  html += '</div></div>';

  // ── Quality Score Ranking ──
  var scored = users.map(function(u) {
    var fpsNorm = Math.min(u.avg_fps / 60, 1);
    var brNorm = Math.min(u.avg_bitrate_kbps / 15000, 1);
    var cleanPct = 1 - (u.pct_bandwidth_limited + u.pct_cpu_limited) / 100;
    if (cleanPct < 0) cleanPct = 0;
    var score = Math.round(fpsNorm * 40 + brNorm * 30 + cleanPct * 30);
    return { name: u.name || u.identity, score: score, u: u };
  }).sort(function(a, b) { return b.score - a.score; });

  html += '<div class="adm-section"><div class="adm-section-title">Quality Score Ranking</div>';
  scored.forEach(function(s) {
    var badgeClass = s.score >= 80 ? "adm-score-good" : (s.score >= 50 ? "adm-score-ok" : "adm-score-bad");
    html += '<div class="adm-leaderboard-bar" style="cursor:default"><div class="adm-leaderboard-name">' + escAdm(s.name) + '</div><div class="adm-leaderboard-fill" style="width:' + s.score + '%;background:' + _admUserColor(s.name) + '"></div><div class="adm-score-badge ' + badgeClass + '">' + s.score + '</div></div>';
  });
  html += '</div>';

  // ── Per-User FPS & Bitrate Bars ──
  var maxFps = Math.max.apply(null, users.map(function(u) { return u.avg_fps || 1; }));
  var maxBr = Math.max.apply(null, users.map(function(u) { return u.avg_bitrate_kbps || 1; }));

  html += '<div class="adm-section"><div class="adm-section-title">Per-User Quality</div>';
  html += '<div class="adm-quality-dual">';
  html += '<div class="adm-quality-col"><div class="adm-quality-col-title">Avg FPS</div>';
  users.slice().sort(function(a, b) { return b.avg_fps - a.avg_fps; }).forEach(function(u) {
    var pct = maxFps > 0 ? (u.avg_fps / maxFps) * 100 : 0;
    var name = u.name || u.identity;
    html += '<div class="adm-leaderboard-bar" style="cursor:default"><div class="adm-leaderboard-name">' + escAdm(name) + '</div><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + _admUserColor(name) + '"></div><div class="adm-leaderboard-count">' + u.avg_fps.toFixed(1) + '</div></div>';
  });
  html += '</div>';
  html += '<div class="adm-quality-col"><div class="adm-quality-col-title">Avg Bitrate (Mbps)</div>';
  users.slice().sort(function(a, b) { return b.avg_bitrate_kbps - a.avg_bitrate_kbps; }).forEach(function(u) {
    var pct = maxBr > 0 ? (u.avg_bitrate_kbps / maxBr) * 100 : 0;
    var name = u.name || u.identity;
    html += '<div class="adm-leaderboard-bar" style="cursor:default"><div class="adm-leaderboard-name">' + escAdm(name) + '</div><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + _admUserColor(name) + '"></div><div class="adm-leaderboard-count">' + (u.avg_bitrate_kbps / 1000).toFixed(1) + '</div></div>';
  });
  html += '</div></div></div>';

  // ── Quality Limitation Breakdown ──
  html += '<div class="adm-section"><div class="adm-section-title">Quality Limitations</div>';
  users.forEach(function(u) {
    var name = u.name || u.identity;
    var clean = Math.max(0, 100 - u.pct_bandwidth_limited - u.pct_cpu_limited);
    html += '<div class="adm-limit-row"><div class="adm-leaderboard-name">' + escAdm(name) + '</div>';
    html += '<div class="adm-limit-bar">';
    if (clean > 0) html += '<div class="adm-limit-seg adm-limit-clean" style="width:' + clean + '%" title="Clean: ' + clean.toFixed(1) + '%"></div>';
    if (u.pct_cpu_limited > 0) html += '<div class="adm-limit-seg adm-limit-cpu" style="width:' + u.pct_cpu_limited + '%" title="CPU: ' + u.pct_cpu_limited.toFixed(1) + '%"></div>';
    if (u.pct_bandwidth_limited > 0) html += '<div class="adm-limit-seg adm-limit-bw" style="width:' + u.pct_bandwidth_limited + '%" title="BW: ' + u.pct_bandwidth_limited.toFixed(1) + '%"></div>';
    html += '</div></div>';
  });
  html += '</div>';

  // ── Encoder & ICE Connection ──
  html += '<div class="adm-section"><div class="adm-section-title">Encoder & Connection</div>';
  html += '<table class="adm-table"><thead><tr><th>User</th><th>Encoder</th><th>Local ICE</th><th>Remote ICE</th><th>Samples</th><th>Time</th></tr></thead><tbody>';
  users.forEach(function(u) {
    var name = u.name || u.identity;
    var enc = u.encoder || "\u2014";
    var iceL = u.ice_local_type || "\u2014";
    var iceR = u.ice_remote_type || "\u2014";
    var iceClass = iceR === "relay" ? "adm-ice-relay" : (iceL === "host" ? "adm-ice-host" : "adm-ice-srflx");
    html += '<tr><td><span class="adm-heat-popup-dot" style="background:' + _admUserColor(name) + ';display:inline-block;vertical-align:middle;margin-right:4px"></span>' + escAdm(name) + '</td>';
    html += '<td><span class="adm-enc-badge">' + escAdm(enc) + '</span></td>';
    html += '<td>' + escAdm(iceL) + '</td>';
    html += '<td><span class="' + iceClass + '">' + escAdm(iceR) + '</span></td>';
    html += '<td>' + u.sample_count + '</td>';
    html += '<td>' + u.total_minutes.toFixed(1) + 'm</td></tr>';
  });
  html += '</tbody></table></div>';

  container.innerHTML = html;
}

async function fetchAdminBugs() {
  try {
    var res = await fetch(apiUrl("/admin/api/bugs"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    var data = await res.json();
    var el = document.getElementById("admin-dash-bugs");
    if (!el) return;
    var reports = data.reports || [];
    if (reports.length === 0) {
      el.innerHTML = '<div class="adm-empty">No bug reports</div>';
      return;
    }
    var html = "";
    reports.forEach(function(r) {
      var dt = new Date(r.timestamp * 1000);
      var dateStr = dt.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      html += '<div class="adm-bug"><div class="adm-bug-header"><strong>' + escAdm(r.name || r.identity) + '</strong><span class="adm-time">' + dateStr + '</span></div><div class="adm-bug-desc">' + escAdm(r.description) + '</div></div>';
    });
    el.innerHTML = html;
  } catch (e) {}
}

/* ── Deploy History Tab ────────────────────────────────────────── */

async function fetchAdminDeploys() {
  var deploysDiv = document.getElementById("admin-dash-deploys");
  if (!deploysDiv) return;
  try {
    var resp = await fetch(apiUrl("/admin/api/deploys"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!resp.ok) {
      deploysDiv.innerHTML = '<div class="adm-empty">Failed to load (' + resp.status + ')</div>';
      return;
    }
    var data = await resp.json();
    renderAdminDeploys(data.commits || [], deploysDiv);
  } catch (e) {
    deploysDiv.innerHTML = '<div class="adm-empty">Error: ' + e.message + '</div>';
  }
}

function renderAdminDeploys(commits, container) {
  if (commits.length === 0) {
    container.innerHTML = '<div class="adm-empty">No deploy history yet</div>';
    return;
  }
  var html = '<div class="adm-deploy-list">';
  commits.forEach(function(c) {
    var statusClass = "adm-deploy-historical";
    var statusLabel = "historical";
    if (c.deploy_status === "success") { statusClass = "adm-deploy-success"; statusLabel = "deployed"; }
    else if (c.deploy_status === "failed") { statusClass = "adm-deploy-failed"; statusLabel = "failed"; }
    else if (c.deploy_status === "rollback") { statusClass = "adm-deploy-rollback"; statusLabel = "rolled back"; }
    else if (c.deploy_status === "pending") { statusClass = "adm-deploy-pending"; statusLabel = "pending"; }

    html += '<div class="adm-deploy-row">';
    html += '<div class="adm-deploy-status"><span class="adm-deploy-badge ' + statusClass + '">' + escAdm(statusLabel) + '</span></div>';
    html += '<div class="adm-deploy-info">';
    if (c.pr_number) {
      html += '<div class="adm-deploy-msg"><a href="https://github.com/SamWatson86/echo-chamber/pull/' + c.pr_number + '" target="_blank" class="adm-deploy-link">' + escAdm(c.message || "(no message)") + '</a></div>';
    } else {
      html += '<div class="adm-deploy-msg">' + escAdm(c.message || "(no message)") + '</div>';
    }
    html += '<div class="adm-deploy-meta">';
    html += '<span class="adm-deploy-sha">' + escAdm(c.short_sha || c.sha || "") + '</span>';
    html += '<span class="adm-deploy-author">' + escAdm(c.author || "unknown") + '</span>';
    html += '<span class="adm-deploy-time">' + formatDeployTime(c.timestamp || c.deploy_timestamp || "") + '</span>';
    if (c.deploy_duration) {
      html += '<span class="adm-deploy-dur">' + c.deploy_duration + 's</span>';
    }
    if (c.deploy_error) {
      html += '<div class="adm-deploy-err">' + escAdm(c.deploy_error) + '</div>';
    }
    if (c.body) {
      var bodyId = 'deploy-body-' + escAdm(c.short_sha || c.sha || "");
      html += '<span class="adm-deploy-toggle" onclick="var el=document.getElementById(\'' + bodyId + '\');el.classList.toggle(\'hidden\');this.textContent=el.classList.contains(\'hidden\')?\'\u25B6 Details\':\'\u25BC Details\'">&#9654; Details</span>';
      html += '<pre class="adm-deploy-body hidden" id="' + bodyId + '">' + escAdm(c.body) + '</pre>';
    }
    html += '</div></div></div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

function formatDeployTime(isoStr) {
  if (!isoStr) return "";
  try {
    var d = new Date(isoStr);
    var now = new Date();
    var diffMs = now - d;
    var diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return diffMin + "m ago";
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h ago";
    var diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return diffDay + "d ago";
    return d.toLocaleDateString();
  } catch (e) { return isoStr; }
}
