/* =========================================================
   ROOM STATUS — Room list, heartbeat, online users, update checker
   ========================================================= */

// ── Module-local state (only used by functions in this file) ──
var _updateCheckTimer = null;
var _updateDismissed = false;
var _heartbeatAbort = null; // AbortController for in-flight heartbeat — prevents ghost presence (#50)
var _heartbeatResumeHandler = null;

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
    const initials = escapeHtml(getInitials(u.name || "Unknown"));
    return `<span class="online-user-pill" title="${title}" data-initials="${initials}">${name}</span>`;
  }).join("");
  onlineUsersEl.innerHTML =
    `<div class="online-users-header">Online Now \u2014 ${users.length}</div>` +
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
function parseVersionIdentifier(value) {
  if (/^\d+$/.test(value)) return { numeric: true, value: parseInt(value, 10) };
  return { numeric: false, value: String(value || "").toLowerCase() };
}

function parseVersionTag(version) {
  var normalized = String(version || "").trim();
  var match = normalized.match(/^v?([0-9]+(?:\.[0-9]+)*)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return { core: [0], prerelease: [] };
  }
  return {
    core: match[1].split(".").map(function(part) {
      return parseInt(part, 10) || 0;
    }),
    prerelease: match[2]
      ? match[2].split(".").map(parseVersionIdentifier)
      : [],
  };
}

function compareVersionTags(left, right) {
  var a = parseVersionTag(left);
  var b = parseVersionTag(right);
  var coreLen = Math.max(a.core.length, b.core.length);
  for (var i = 0; i < coreLen; i++) {
    var x = a.core[i] || 0;
    var y = b.core[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }

  var aPre = a.prerelease;
  var bPre = b.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  var preLen = Math.max(aPre.length, bPre.length);
  for (var j = 0; j < preLen; j++) {
    var aId = aPre[j];
    var bId = bPre[j];
    if (!aId) return -1;
    if (!bId) return 1;
    if (aId.numeric && bId.numeric) {
      if (aId.value > bId.value) return 1;
      if (aId.value < bId.value) return -1;
      continue;
    }
    if (aId.numeric !== bId.numeric) return aId.numeric ? -1 : 1;
    if (aId.value > bId.value) return 1;
    if (aId.value < bId.value) return -1;
  }
  return 0;
}

function isNewerVersion(latest, current) {
  return compareVersionTags(latest, current) > 0;
}

function isLocalTestBuildVersion(version) {
  var prerelease = parseVersionTag(version).prerelease || [];
  return prerelease.some(function(part) {
    return !part.numeric && /^(local|dev|test|lab|dirty)$/.test(part.value);
  });
}

function hideUpdateBanner() {
  var banner = document.getElementById("update-banner");
  if (banner) banner.remove();
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
    if (isLocalTestBuildVersion(currentVer)) {
      hideUpdateBanner();
      return;
    }
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

// ─── Updated Viewer Banner (FORCED — non-dismissable, auto-reloads) ───
// When an authenticated heartbeat reports stale: true,
// show a full-width banner with a 5-second countdown, then force window.location.reload().
var _staleReloadTimer = null;

function showStaleBanner() {
  if (document.getElementById("stale-banner")) return;
  var banner = document.createElement("div");
  banner.id = "stale-banner";
  banner.className = "stale-banner stale-banner-forced";
  banner.innerHTML =
    '<span class="stale-banner-text">Echo was updated — reconnecting in <strong class="stale-countdown">5</strong>s…</span>';
  document.body.appendChild(banner);

  var secondsLeft = 5;
  var countdownEl = banner.querySelector(".stale-countdown");
  _staleReloadTimer = setInterval(function() {
    secondsLeft -= 1;
    if (countdownEl) countdownEl.textContent = String(Math.max(0, secondsLeft));
    if (secondsLeft <= 0) {
      clearInterval(_staleReloadTimer);
      _staleReloadTimer = null;
      window.location.reload();
    }
  }, 1000);
}

function hideStaleBanner() {
  var banner = document.getElementById("stale-banner");
  if (banner) banner.remove();
  if (_staleReloadTimer) {
    clearInterval(_staleReloadTimer);
    _staleReloadTimer = null;
  }
}

function showSessionExpiredBanner() {
  if (document.getElementById("stale-banner")) return;
  if (document.getElementById("session-expired-banner")) return;
  var banner = document.createElement("div");
  banner.id = "session-expired-banner";
  banner.className = "stale-banner";
  banner.innerHTML = '<span>Session expired — reconnect to Echo.</span>';
  document.body.appendChild(banner);
}

function hideSessionExpiredBanner() {
  var banner = document.getElementById("session-expired-banner");
  if (banner) banner.remove();
}

// ─── Heartbeat ───
function startHeartbeat() {
  stopHeartbeat();
  const controlUrl = controlUrlInput.value.trim();
  if (!controlUrl || !currentAccessToken) return;
  const heartbeatAbort = new AbortController();
  _heartbeatAbort = heartbeatAbort;
  const postHeartbeat = (token, beatRoom, identity, name) => fetch(`${controlUrl}/v1/participants/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ room: beatRoom, identity, name, viewer_version: _viewerVersion }),
    signal: heartbeatAbort.signal,
  });
  var authRecoveryPromise = null;
  const acceptHeartbeat = async (resp, beatToken, beatRoom, identity, name, mayRefresh) => {
    if (resp.status === 401 || resp.status === 403) {
      // A late response for a replaced participant token has no authority over
      // the current session and must not trigger another refresh or any UI.
      if (beatToken !== currentAccessToken) return;
      if (mayRefresh) {
        if (authRecoveryPromise) return authRecoveryPromise;
        var recovery = (async function() {
          const refreshed = await ensureFreshParticipantToken({
            force: true,
            expectedToken: beatToken,
          });
          if (_heartbeatAbort !== heartbeatAbort || heartbeatAbort.signal.aborted) return;
          if (refreshed.status === "superseded" || refreshed.status === "inactive") return;
          if (refreshed.status === "refreshed" && currentAccessToken !== beatToken) {
            const retryToken = currentAccessToken;
            const retry = await postHeartbeat(retryToken, beatRoom, identity, name);
            return acceptHeartbeat(retry, retryToken, beatRoom, identity, name, false);
          }
          if (refreshed.status === "failed") {
            var refreshStatus = Number(refreshed.error && refreshed.error.status);
            var networkFailure = refreshed.error && refreshed.error.name === "TypeError";
            if (networkFailure || refreshStatus === 429 || refreshStatus >= 500) return;
          }
          window.EchoWebDiagnosticsRuntime?.invalidateHeartbeat?.();
          showSessionExpiredBanner();
        })();
        authRecoveryPromise = recovery;
        var clearRecovery = function() {
          if (authRecoveryPromise === recovery) authRecoveryPromise = null;
        };
        recovery.then(clearRecovery, clearRecovery);
        return recovery;
      }
      window.EchoWebDiagnosticsRuntime?.invalidateHeartbeat?.();
      showSessionExpiredBanner();
      return;
    }
    if (resp.status !== 200) return;

    const data = await resp.json().catch(() => null);
    if (data && data.stale === true) {
      hideSessionExpiredBanner();
      window.EchoWebDiagnosticsRuntime?.invalidateHeartbeat?.();
      showStaleBanner();
    } else if (data && data.stale === false) {
      hideStaleBanner();
      hideSessionExpiredBanner();
      if (beatToken === currentAccessToken) {
        window.EchoWebDiagnosticsRuntime?.heartbeatSucceeded?.({
          controlUrl,
          token: beatToken,
        });
      }
    } else {
      window.EchoWebDiagnosticsRuntime?.invalidateHeartbeat?.();
    }
  };
  const sendBeat = async () => {
    if (_heartbeatAbort !== heartbeatAbort || heartbeatAbort.signal.aborted) return;
    const expectedToken = currentAccessToken;
    const freshness = await ensureFreshParticipantToken({ expectedToken: expectedToken });
    if (_heartbeatAbort !== heartbeatAbort || heartbeatAbort.signal.aborted) return;
    if (freshness.status === "failed") {
      debugLog("[participant-token] scheduled refresh failed; heartbeat will use the current credential");
    }
    const beatToken = currentAccessToken;
    const identity = identityInput ? identityInput.value : "";
    const name = nameInput.value.trim() || "Viewer";
    const beatRoom = roomSwitchState && roomSwitchState.heartbeatRoomName
      ? roomSwitchState.heartbeatRoomName()
      : currentRoomName;
    try {
      const resp = await postHeartbeat(beatToken, beatRoom, identity, name);
      await acceptHeartbeat(resp, beatToken, beatRoom, identity, name, true);
    } catch {}
  };
  sendBeat();
  heartbeatTimer = setInterval(sendBeat, 10000);
  _heartbeatResumeHandler = function() {
    if (document.hidden === true || navigator.onLine === false) return;
    sendBeat();
  };
  document.addEventListener("visibilitychange", _heartbeatResumeHandler);
  window.addEventListener("online", _heartbeatResumeHandler);
}

function stopHeartbeat() {
  window.EchoWebDiagnosticsRuntime?.invalidateHeartbeat?.();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  // Abort any in-flight heartbeat request to prevent ghost presence after disconnect
  if (_heartbeatAbort) {
    _heartbeatAbort.abort();
    _heartbeatAbort = null;
  }
  if (_heartbeatResumeHandler) {
    document.removeEventListener("visibilitychange", _heartbeatResumeHandler);
    window.removeEventListener("online", _heartbeatResumeHandler);
    _heartbeatResumeHandler = null;
  }
  hideSessionExpiredBanner();
}

function sendLeaveNotification() {
  const controlUrl = controlUrlInput.value.trim();
  const identity = identityInput ? identityInput.value : "";
  if (!controlUrl || !currentAccessToken || !identity) return;
  fetch(`${controlUrl}/v1/participants/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentAccessToken}` },
    body: JSON.stringify({ identity }),
  }).catch(() => {});
}
