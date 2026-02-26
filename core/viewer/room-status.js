/* =========================================================
   ROOM STATUS — Room list, heartbeat, online users, update checker
   ========================================================= */

// ── Module-local state (only used by functions in this file) ──
var _updateCheckTimer = null;
var _updateDismissed = false;
var _heartbeatAbort = null; // AbortController for in-flight heartbeat — prevents ghost presence (#50)

// ─── Who's Online polling (pre-connect) ───
async function fetchOnlineUsers(controlUrl) {
  try {
    const resp = await fetch(`${controlUrl}/api/online`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

function renderOnlineUsers(users) {
  if (!onlineUsersEl) return;
  if (!users || users.length === 0) {
    onlineUsersEl.innerHTML = '<div class="online-users-empty">No one is currently online</div>';
    return;
  }
  const pills = users.map(u => {
    const name = escapeHtml(u.name || "Unknown");
    const room = escapeHtml(u.room || "");
    const title = room ? `In room: ${room}` : "";
    return `<span class="online-user-pill" title="${title}">${name}</span>`;
  }).join("");
  onlineUsersEl.innerHTML =
    `<div class="online-users-header">Currently Online (${users.length})</div>` +
    `<div class="online-users-list">${pills}</div>`;
}

function startOnlineUsersPolling() {
  if (onlineUsersTimer) return;
  const poll = async () => {
    const users = await fetchOnlineUsers(getControlUrl());
    renderOnlineUsers(users);
  };
  poll(); // immediate first fetch
  onlineUsersTimer = setInterval(poll, 10000);
}

function stopOnlineUsersPolling() {
  if (onlineUsersTimer) {
    clearInterval(onlineUsersTimer);
    onlineUsersTimer = null;
  }
  if (onlineUsersEl) onlineUsersEl.innerHTML = "";
}

// ─── Room status polling ───
async function fetchRoomStatus(baseUrl, adminToken) {
  try {
    const res = await fetch(`${baseUrl}/v1/room-status`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

function detectRoomChanges(statusMap) {
  // Track participant sets for room list UI (chimes are now handled by real-time LiveKit events)
  const currentIds = {};
  FIXED_ROOMS.forEach((roomId) => {
    currentIds[roomId] = new Set((statusMap[roomId] || []).map((p) => p.identity));
  });
  const myRoom = currentRoomName;
  if (previousDetectedRoom !== myRoom) {
    previousDetectedRoom = myRoom;
  }
  previousRoomParticipants = currentIds;
}

async function refreshRoomList(baseUrl, adminToken, activeRoom) {
  if (!roomListEl) return;
  const statusList = await fetchRoomStatus(baseUrl, adminToken);
  const statusMap = {};
  if (Array.isArray(statusList)) {
    statusList.forEach((r) => { statusMap[r.room_id] = r.participants || []; });
  }
  detectRoomChanges(statusMap);
  roomListEl.innerHTML = "";
  FIXED_ROOMS.forEach((roomId) => {
    const participants = statusMap[roomId] || [];
    const displayName = ROOM_DISPLAY_NAMES[roomId] || roomId;
    const isActive = roomId === activeRoom;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "room-status-btn" + (isActive ? " is-active" : "");
    const nameSpan = document.createElement("span");
    nameSpan.className = "room-status-name";
    nameSpan.textContent = displayName;
    btn.appendChild(nameSpan);
    const countSpan = document.createElement("span");
    countSpan.className = "room-status-count";
    countSpan.textContent = participants.length > 0 ? participants.length : "";
    btn.appendChild(countSpan);
    if (participants.length > 0) {
      btn.classList.add("has-users");
      const tooltip = document.createElement("div");
      tooltip.className = "room-status-tooltip";
      participants.forEach((p) => {
        const row = document.createElement("div");
        row.className = "room-status-tooltip-name";
        row.textContent = p.name || p.identity;
        tooltip.appendChild(row);
      });
      btn.appendChild(tooltip);
    }
    btn.addEventListener("click", () => {
      if (roomId === currentRoomName) return;
      // Optimistic UI: immediately show this room as active
      roomListEl.querySelectorAll(".room-status-btn").forEach(function(b) { b.classList.remove("is-active"); });
      btn.classList.add("is-active");
      switchRoom(roomId).catch(() => {});
    });
    roomListEl.appendChild(btn);
  });
}

function startRoomStatusPolling() {
  stopRoomStatusPolling();
  const controlUrl = controlUrlInput.value.trim();
  if (!controlUrl || !adminToken) return;
  roomStatusTimer = setInterval(() => {
    refreshRoomList(controlUrl, adminToken, currentRoomName).catch(() => {});
    // Refresh token cache every 5 minutes
    if (Date.now() - _lastTokenPrefetch > 300000) {
      _lastTokenPrefetch = Date.now();
      prefetchRoomTokens();
    }
  }, 5000);
}

function stopRoomStatusPolling() {
  if (roomStatusTimer) {
    clearInterval(roomStatusTimer);
    roomStatusTimer = null;
  }
}

// ── Auto update check ──
function startUpdateCheckPolling() {
  if (_updateCheckTimer) return;
  // Check once after 10s, then every 5 minutes
  setTimeout(checkForUpdateNotification, 10000);
  _updateCheckTimer = setInterval(checkForUpdateNotification, 5 * 60 * 1000);
}
function isNewerVersion(latest, current) {
  var a = latest.split(".").map(Number);
  var b = current.split(".").map(Number);
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    var x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
async function checkForUpdateNotification() {
  if (_updateDismissed) return;
  try {
    var currentVer = "";
    if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
      try {
        var info = await tauriInvoke("get_app_info");
        currentVer = info.version || "";
      } catch (e) { /* ignore */ }
    }
    if (!currentVer) return; // browser viewer doesn't have a version to compare
    var cUrl = controlUrlInput ? controlUrlInput.value.trim() : "";
    if (!cUrl) return;
    var resp = await fetch(cUrl + "/api/version");
    if (!resp.ok) return;
    var data = await resp.json();
    var latestClient = data.latest_client || "";
    if (latestClient && isNewerVersion(latestClient, currentVer)) {
      showUpdateBanner(latestClient);
    }
  } catch (e) {
    // silent
  }
}
function showUpdateBanner(version) {
  if (document.getElementById("update-banner")) return;
  var banner = document.createElement("div");
  banner.id = "update-banner";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:500;background:linear-gradient(90deg,rgba(56,189,248,0.15),rgba(139,92,246,0.15));backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(56,189,248,0.3);padding:8px 16px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:13px;color:var(--text,#e2e8f0);";
  banner.innerHTML = '<span>Update available: <strong>v' + version + '</strong> — restart the app to update</span><button type="button" style="background:none;border:none;color:var(--muted,#94a3b8);cursor:pointer;font-size:16px;padding:2px 6px;" title="Dismiss">&times;</button>';
  banner.querySelector("button").addEventListener("click", function() {
    banner.remove();
    _updateDismissed = true;
  });
  document.body.appendChild(banner);
}

// ─── Heartbeat ───
function startHeartbeat() {
  stopHeartbeat();
  const controlUrl = controlUrlInput.value.trim();
  if (!controlUrl || !adminToken) return;
  _heartbeatAbort = new AbortController();
  const sendBeat = () => {
    if (!_heartbeatAbort || _heartbeatAbort.signal.aborted) return;
    const identity = identityInput ? identityInput.value : "";
    const name = nameInput.value.trim() || "Viewer";
    const beatRoom = roomSwitchState && roomSwitchState.heartbeatRoomName
      ? roomSwitchState.heartbeatRoomName()
      : currentRoomName;
    fetch(`${controlUrl}/v1/participants/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ room: beatRoom, identity, name, viewer_version: _viewerVersion }),
      signal: _heartbeatAbort.signal,
    }).catch(() => {});
  };
  sendBeat();
  heartbeatTimer = setInterval(sendBeat, 10000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  // Abort any in-flight heartbeat request to prevent ghost presence after disconnect
  if (_heartbeatAbort) {
    _heartbeatAbort.abort();
    _heartbeatAbort = null;
  }
}

function sendLeaveNotification() {
  const controlUrl = controlUrlInput.value.trim();
  const identity = identityInput ? identityInput.value : "";
  if (!controlUrl || !adminToken || !identity) return;
  fetch(`${controlUrl}/v1/participants/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ identity }),
  }).catch(() => {});
}
