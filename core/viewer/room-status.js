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

// ─── Stale Version Banner (FORCED — non-dismissable, auto-reloads) ───
// When heartbeat reports stale: true (server has been restarted/updated),
// show a full-width banner with a 5-second countdown, then force window.location.reload().
// Friends were getting stuck talking to no one after server restarts because they didn't
// know to refresh. This makes it impossible to miss.
//
// Plays a 5-second procedural smooth-jazz ii-V-I chord progression (Dm7 → G7 → Cmaj7)
// via Web Audio API, with a robot-voiced "The server is restarting" via SpeechSynthesis
// layered on top. Entirely synthesized — no audio files.
var _staleReloadTimer = null;

function playStaleJazz() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx = new AC();
    var now = ctx.currentTime;

    // Master gain — keep it gentle, this is smooth jazz not metal
    var master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);

    // Soft hi-pass to remove muddiness
    var filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    filter.Q.value = 0.7;
    filter.connect(master);

    // ii-V-I in C major: Dm7 → G7 → Cmaj7
    // Each chord ≈ 1.5s, total ≈ 4.5s of music + 0.5s tail
    var chords = [
      { time: 0.0, dur: 1.5, freqs: [146.83, 220.00, 261.63, 349.23] }, // Dm7  (D2, A3, C4, F4)
      { time: 1.5, dur: 1.5, freqs: [196.00, 246.94, 349.23, 440.00] }, // G7   (G3, B3, F4, A4)
      { time: 3.0, dur: 2.0, freqs: [130.81, 261.63, 329.63, 493.88] }, // Cmaj7 (C3, C4, E4, B4)
    ];

    chords.forEach(function(ch) {
      ch.freqs.forEach(function(f, idx) {
        // Two layered oscillators per note for warmth: sine (fundamental) + triangle (slight detune)
        ["sine", "triangle"].forEach(function(type, layer) {
          var osc = ctx.createOscillator();
          osc.type = type;
          osc.frequency.value = f * (layer === 1 ? 1.003 : 1.0); // tiny detune on layer 2

          var g = ctx.createGain();
          // Soft attack + release ADSR per note
          var startT = now + ch.time;
          var peakT = startT + 0.08;
          var releaseT = startT + ch.dur - 0.15;
          var endT = startT + ch.dur;
          var peakGain = (layer === 0 ? 0.22 : 0.14) / Math.max(1, idx === 0 ? 1 : 1.4); // bass slightly louder
          g.gain.setValueAtTime(0, startT);
          g.gain.linearRampToValueAtTime(peakGain, peakT);
          g.gain.linearRampToValueAtTime(peakGain * 0.7, releaseT);
          g.gain.linearRampToValueAtTime(0, endT);

          osc.connect(g).connect(filter);
          osc.start(startT);
          osc.stop(endT + 0.05);
        });
      });
    });

    // Robot voice over the top — layered around 1.0-4.0s so it sits in the chord progression
    if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
      // Cancel anything currently speaking
      window.speechSynthesis.cancel();
      var utter = new SpeechSynthesisUtterance("The server is restarting");
      utter.rate = 0.65;     // slow = more deliberate, more robotic
      utter.pitch = 0.3;     // very low = robot
      utter.volume = 0.95;
      // Try to grab a robot/synthetic voice if one exists
      var voices = window.speechSynthesis.getVoices();
      var robotVoice = voices.find(function(v) {
        return /microsoft david|google.*us|robot|synth/i.test(v.name);
      });
      if (robotVoice) utter.voice = robotVoice;
      // Slight delay so the chord lands first
      setTimeout(function() {
        try { window.speechSynthesis.speak(utter); } catch (e) {}
      }, 600);
    }

    // Clean up the audio context after the music finishes
    setTimeout(function() {
      try { ctx.close(); } catch (e) {}
    }, 5500);
  } catch (e) {
    // Audio is best-effort — never block the reload
    console.warn("[stale-banner] jazz playback failed:", e);
  }
}

function showStaleBanner() {
  if (document.getElementById("stale-banner")) return;
  var banner = document.createElement("div");
  banner.id = "stale-banner";
  banner.className = "stale-banner stale-banner-forced";
  banner.innerHTML =
    '<span class="stale-banner-text">🎷 Server was updated — reloading in <strong class="stale-countdown">5</strong>s…</span>';
  document.body.appendChild(banner);

  // Smooth jazz robot serenade
  playStaleJazz();

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

// ─── Heartbeat ───
function startHeartbeat() {
  stopHeartbeat();
  const controlUrl = controlUrlInput.value.trim();
  if (!controlUrl || !adminToken) return;
  _heartbeatAbort = new AbortController();
  const sendBeat = async () => {
    if (!_heartbeatAbort || _heartbeatAbort.signal.aborted) return;
    const identity = identityInput ? identityInput.value : "";
    const name = nameInput.value.trim() || "Viewer";
    const beatRoom = roomSwitchState && roomSwitchState.heartbeatRoomName
      ? roomSwitchState.heartbeatRoomName()
      : currentRoomName;
    try {
      const resp = await fetch(`${controlUrl}/v1/participants/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ room: beatRoom, identity, name, viewer_version: _viewerVersion }),
        signal: _heartbeatAbort.signal,
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        if (data && data.stale) {
          showStaleBanner();
        } else {
          hideStaleBanner();
        }
      }
    } catch {}
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
