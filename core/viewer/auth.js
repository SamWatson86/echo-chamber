/* =========================================================
   AUTH — LiveKit client, admin tokens, room tokens, and prefetch
   ========================================================= */

const PARTICIPANT_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PARTICIPANT_TOKEN_REFRESH_RETRY_MS = 60 * 1000;

function decodeParticipantTokenExpirationMs(token) {
  try {
    var part = String(token || "").split(".")[1];
    if (!part) return null;
    var normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4) normalized += "=";
    var json;
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(normalized, "base64").toString("utf8");
    } else if (typeof atob === "function") {
      var binary = atob(normalized);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      json = typeof TextDecoder === "function"
        ? new TextDecoder().decode(bytes)
        : decodeURIComponent(Array.from(bytes, function (value) {
            return "%" + value.toString(16).padStart(2, "0");
          }).join(""));
    } else {
      return null;
    }
    var payload = JSON.parse(json);
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch (_) {
    return null;
  }
}

function isParticipantTokenAuthorizationError(error) {
  return !!error && (Number(error.status) === 401 || Number(error.status) === 403);
}

function createParticipantTokenLifecycle(options) {
  var opts = options || {};
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var refreshMarginMs = Number.isFinite(opts.refreshMarginMs)
    ? opts.refreshMarginMs
    : PARTICIPANT_TOKEN_REFRESH_MARGIN_MS;
  var refreshRetryMs = Number.isFinite(opts.refreshRetryMs)
    ? opts.refreshRetryMs
    : PARTICIPANT_TOKEN_REFRESH_RETRY_MS;
  var getCurrentToken = opts.getCurrentToken;
  var setCurrentToken = opts.setCurrentToken;
  var getAdminToken = opts.getAdminToken;
  var setAdminToken = opts.setAdminToken;
  var getPassword = opts.getPassword;
  var issueRoomToken = opts.issueRoomToken;
  var renewAdminToken = opts.renewAdminToken;
  var onTokenCommitted = typeof opts.onTokenCommitted === "function"
    ? opts.onTokenCommitted
    : function () {};

  if (typeof getCurrentToken !== "function" ||
      typeof setCurrentToken !== "function" ||
      typeof getAdminToken !== "function" ||
      typeof setAdminToken !== "function" ||
      typeof getPassword !== "function" ||
      typeof issueRoomToken !== "function" ||
      typeof renewAdminToken !== "function") {
    throw new Error("Participant token lifecycle dependencies are incomplete");
  }

  var generation = 0;
  var active = null;
  var inFlight = null;

  function commitConnected(context) {
    if (!context || !context.controlUrl || !context.roomId ||
        !context.identity || !context.token) {
      throw new Error("Connected participant token context is incomplete");
    }
    generation += 1;
    active = {
      generation: generation,
      controlUrl: context.controlUrl,
      roomId: context.roomId,
      identity: context.identity,
      name: context.name || "Viewer",
      token: context.token,
      expiresAtMs: decodeParticipantTokenExpirationMs(context.token),
      refreshNotBeforeMs: 0,
      forcedRefreshNotBeforeMs: 0,
    };
    inFlight = null;
    return generation;
  }

  function clearConnected() {
    generation += 1;
    active = null;
    inFlight = null;
  }

  function captureActive(expectedToken) {
    if (!active) return null;
    var currentToken = getCurrentToken();
    if (!currentToken || currentToken !== active.token) return null;
    if (expectedToken && expectedToken !== currentToken) return null;
    return {
      generation: active.generation,
      controlUrl: active.controlUrl,
      roomId: active.roomId,
      identity: active.identity,
      name: active.name,
      token: active.token,
      expiresAtMs: active.expiresAtMs,
    };
  }

  function isCaptureCurrent(capture) {
    return !!capture && !!active &&
      generation === capture.generation &&
      active.generation === capture.generation &&
      active.controlUrl === capture.controlUrl &&
      active.roomId === capture.roomId &&
      active.identity === capture.identity &&
      active.token === capture.token &&
      getCurrentToken() === capture.token;
  }

  async function performRefresh(capture, forced) {
    try {
      var nextToken;
      var currentAdminToken = getAdminToken();
      try {
        nextToken = await issueRoomToken(capture, currentAdminToken);
      } catch (error) {
        if (!isParticipantTokenAuthorizationError(error)) throw error;
        var password = getPassword();
        if (!password) throw error;
        var renewedAdminToken = await renewAdminToken(capture.controlUrl, password);
        if (!isCaptureCurrent(capture)) return { status: "superseded" };
        setAdminToken(renewedAdminToken);
        nextToken = await issueRoomToken(capture, renewedAdminToken);
      }

      if (typeof nextToken !== "string" || !nextToken) {
        throw new Error("Participant token refresh returned an empty token");
      }
      if (!isCaptureCurrent(capture)) return { status: "superseded" };

      setCurrentToken(nextToken);
      active.token = nextToken;
      active.expiresAtMs = decodeParticipantTokenExpirationMs(nextToken);
      active.refreshNotBeforeMs = 0;
      active.forcedRefreshNotBeforeMs = 0;
      onTokenCommitted({
        controlUrl: capture.controlUrl,
        roomId: capture.roomId,
        identity: capture.identity,
        previousToken: capture.token,
        token: nextToken,
      });
      return { status: "refreshed", token: nextToken, previousToken: capture.token };
    } catch (error) {
      if (isCaptureCurrent(capture)) {
        active.refreshNotBeforeMs = now() + refreshRetryMs;
        if (forced) active.forcedRefreshNotBeforeMs = now() + refreshRetryMs;
      }
      return { status: "failed", error: error };
    }
  }

  function ensureFresh(options) {
    var request = options || {};
    var capture = captureActive(request.expectedToken);
    if (!capture) {
      return Promise.resolve({ status: active ? "superseded" : "inactive" });
    }
    var forced = request.force === true;
    var due = Number.isFinite(capture.expiresAtMs) &&
      capture.expiresAtMs - now() <= refreshMarginMs;
    if (!forced && !due) {
      return Promise.resolve({ status: "current", token: capture.token });
    }
    var refreshNotBeforeMs = forced
      ? active.forcedRefreshNotBeforeMs
      : active.refreshNotBeforeMs;
    if (refreshNotBeforeMs > now()) {
      return Promise.resolve({ status: "deferred", token: capture.token });
    }
    if (inFlight &&
        inFlight.generation === capture.generation &&
        inFlight.token === capture.token) {
      return inFlight.promise;
    }

    var refresh = performRefresh(capture, forced);
    inFlight = {
      generation: capture.generation,
      token: capture.token,
      promise: refresh,
    };
    refresh.finally(function () {
      if (inFlight && inFlight.promise === refresh) inFlight = null;
    });
    return refresh;
  }

  return {
    commitConnected: commitConnected,
    clearConnected: clearConnected,
    ensureFresh: ensureFresh,
  };
}

function getLiveKitClient() {
  return window.LiveKitClient || window.LivekitClient || window.LiveKit;
}

async function fetchAdminToken(baseUrl, password) {
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) {
    const error = new Error(`Login failed (${login.status})`);
    error.status = login.status;
    throw error;
  }
  const loginData = await login.json();
  return loginData.token;
}

async function fetchRoomToken(baseUrl, adminToken, room, identity, name) {
  const token = await fetch(`${baseUrl}/v1/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      room,
      identity,
      name,
      deviceId: ensureDeviceId(),
      participantAuthKey: ensureParticipantAuthKey()
    }),
  });
  if (token.status === 409) {
    const error = new Error("Name is already in use by another connected user. Please choose a different name.");
    error.status = token.status;
    throw error;
  }
  if (!token.ok) {
    const error = new Error(`Token failed (${token.status})`);
    error.status = token.status;
    throw error;
  }
  const tokenData = await token.json();
  return tokenData.token;
}

// The participant token authenticates heartbeat, Jam reconnects, chat, and
// native-presenter requests after LiveKit has connected. Rotate that shared
// credential without replacing the active LiveKit Room or its media tracks.
var _participantTokenLifecycle = typeof window !== "undefined"
  ? createParticipantTokenLifecycle({
      getCurrentToken: function() { return currentAccessToken; },
      setCurrentToken: function(token) { currentAccessToken = token; },
      getAdminToken: function() { return adminToken; },
      setAdminToken: function(token) { adminToken = token; },
      getPassword: function() {
        var current = passwordInput && passwordInput.value ? passwordInput.value : "";
        if (current) return current;
        try { return echoGet(REMEMBER_PASS_KEY) || ""; } catch (_) { return ""; }
      },
      issueRoomToken: function(context, token) {
        return fetchRoomToken(
          context.controlUrl,
          token,
          context.roomId,
          context.identity,
          context.name
        );
      },
      renewAdminToken: fetchAdminToken,
      onTokenCommitted: function(context) {
        tokenCache.delete(context.roomId);
        debugLog("[participant-token] refreshed active room credential");
      },
    })
  : null;

function commitConnectedParticipantToken(context) {
  if (!_participantTokenLifecycle) {
    throw new Error("Participant token lifecycle helper is unavailable");
  }
  return _participantTokenLifecycle.commitConnected(context);
}

function clearConnectedParticipantToken() {
  _participantTokenLifecycle?.clearConnected();
}

function ensureFreshParticipantToken(options) {
  if (!_participantTokenLifecycle) {
    return Promise.resolve({ status: "failed", error: new Error("Participant token lifecycle helper is unavailable") });
  }
  return _participantTokenLifecycle.ensureFresh(options);
}

async function ensureRoomExists(baseUrl, adminToken, roomId) {
  await fetch(`${baseUrl}/v1/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ room_id: roomId }),
  }).catch(() => {});
}

// ── Fast room switching: token prefetch ──
async function prefetchRoomTokens() {
  if (!adminToken) return;
  var cUrl = controlUrlInput.value.trim();
  if (!cUrl) return;
  var nm = nameInput.value.trim() || "Viewer";
  var id = identityInput ? identityInput.value : buildIdentity(nm);
  for (var i = 0; i < FIXED_ROOMS.length; i++) {
    var rid = FIXED_ROOMS[i];
    if (rid === currentRoomName) continue;
    var cached = tokenCache.get(rid);
    if (cached) {
      var age = Date.now() - cached.fetchedAt;
      if (age < (cached.expiresInSeconds * 1000) - TOKEN_CACHE_MARGIN_MS) continue;
    }
    try {
      var res = await fetch(cUrl + "/v1/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
        body: JSON.stringify({
          room: rid,
          identity: id,
          name: nm,
          deviceId: ensureDeviceId(),
          participantAuthKey: ensureParticipantAuthKey()
        }),
      });
      if (!res.ok) continue;
      var data = await res.json();
      tokenCache.set(rid, { token: data.token, fetchedAt: Date.now(), expiresInSeconds: data.expires_in_seconds || 14400 });
      debugLog("[fast-switch] prefetched token for " + rid);
    } catch (e) { /* silent — fall back to live fetch on switch */ }
  }
}

async function getCachedOrFetchToken(baseUrl, adminToken, roomId, identity, name) {
  var cached = tokenCache.get(roomId);
  if (cached) {
    var age = Date.now() - cached.fetchedAt;
    if (age < (cached.expiresInSeconds * 1000) - TOKEN_CACHE_MARGIN_MS) {
      debugLog("[fast-switch] using cached token for " + roomId + " (age " + Math.round(age / 1000) + "s)");
      return cached.token;
    }
    tokenCache.delete(roomId);
  }
  return fetchRoomToken(baseUrl, adminToken, roomId, identity, name);
}

async function fetchRooms(baseUrl, adminToken) {
  const res = await fetch(`${baseUrl}/v1/rooms`, {
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

// ── Fast room switching: pre-warmed connections ──
const prewarmedRooms = new Map(); // roomId -> { room: LK.Room, createdAt }
const PREWARM_MAX_AGE_MS = 300000; // 5 minutes

async function prewarmRooms() {
  // Don't pre-warm while screen sharing — each pre-warmed connection burns
  // CPU/GPU via WebRTC peer connections (ICE, DTLS, STUN). During screen share
  // every resource matters for maintaining 60fps.
  if (_screenShareVideoTrack) return;
  var LK = getLiveKitClient();
  if (!LK || !LK.Room) return;
  var sfu = sfuUrlInput.value.trim();
  if (!sfu) return;
  for (var i = 0; i < FIXED_ROOMS.length; i++) {
    var rid = FIXED_ROOMS[i];
    if (rid === currentRoomName) continue;
    var existing = prewarmedRooms.get(rid);
    if (existing && (Date.now() - existing.createdAt) < PREWARM_MAX_AGE_MS) continue;
    var cached = tokenCache.get(rid);
    if (!cached) continue;
    // Clean up stale pre-warmed room
    if (existing && existing.room) {
      try { existing.room.disconnect(); } catch (e) {}
    }
    try {
      var warmRoom = new LK.Room({
        adaptiveStream: false,
        dynacast: false,
        autoSubscribe: !isPhoneSessionStabilityEnabled(),
      });
      await warmRoom.prepareConnection(sfu, cached.token);
      prewarmedRooms.set(rid, { room: warmRoom, createdAt: Date.now() });
      debugLog("[fast-switch] pre-warmed connection for " + rid);
    } catch (e) {
      debugLog("[fast-switch] pre-warm failed for " + rid + ": " + (e.message || e));
    }
  }
}

function cleanupPrewarmedRooms() {
  prewarmedRooms.forEach(function(entry) {
    try { entry.room.disconnect(); } catch (e) {}
  });
  prewarmedRooms.clear();
  tokenCache.clear();
}

// ── Admin login (Tauri viewer) ──────────────────────────────────────
// Lets Sam (or anyone with the password) become admin from the viewer
// itself instead of opening a separate Edge tab. The admin token is
// kept in module-level `adminToken` (already declared in state.js) and
// persisted to localStorage so it survives reload.

const ADMIN_TOKEN_STORAGE_KEY = "echo_admin_token";

async function adminLogin(baseUrl, password) {
  const token = await fetchAdminToken(baseUrl, password);
  adminToken = token;
  try { localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token); } catch (e) {}
  return token;
}

function adminLogout() {
  adminToken = "";
  try { localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY); } catch (e) {}
}

async function restoreAdminFromStorage(baseUrl) {
  let stored = "";
  try { stored = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || ""; } catch (e) {}
  if (!stored) return false;
  // Probe a cheap admin endpoint to verify the token is still valid.
  try {
    const probe = await fetch(`${baseUrl}/admin/api/dashboard`, {
      headers: { Authorization: `Bearer ${stored}` },
    });
    if (probe.ok) {
      adminToken = stored;
      return true;
    }
  } catch (e) {}
  // Stale or rejected — clear it.
  try { localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY); } catch (e) {}
  return false;
}

// ── Admin login UI wireup ────────────────────────────────────────────
// Use document-level event delegation rather than direct addEventListener,
// because the connect/disconnect flow can tear down and rebuild the connect
// form area, invalidating direct element references and silently breaking
// the click handler. Delegation survives DOM rebuilds.
let _adminLoginUiWired = false;
function setupAdminLoginUi() {
  if (_adminLoginUiWired) return; // delegation only needs to attach once
  _adminLoginUiWired = true;

  document.addEventListener("click", function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    // Open the modal when the Admin button (or any descendant) is clicked
    const openBtn = target.closest && target.closest("#adminLoginBtn");
    if (openBtn) {
      const modal = document.getElementById("adminLoginModal");
      const pwInput = document.getElementById("adminLoginPassword");
      const errBox = document.getElementById("adminLoginError");
      if (!modal || !pwInput) return;
      pwInput.value = "";
      if (errBox) { errBox.hidden = true; errBox.textContent = ""; }
      modal.hidden = false;
      setTimeout(function () { pwInput.focus(); }, 0);
      return;
    }

    // Cancel button
    if (target.closest && target.closest("#adminLoginCancel")) {
      const modal = document.getElementById("adminLoginModal");
      if (modal) modal.hidden = true;
      return;
    }

    // Submit button — perform the actual login
    const submitBtnHit = target.closest && target.closest("#adminLoginSubmit");
    if (submitBtnHit) {
      _adminLoginSubmit();
      return;
    }
  });

  // Enter / Escape keyboard shortcuts inside the password input.
  document.addEventListener("keydown", function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.id !== "adminLoginPassword") return;
    if (e.key === "Enter") { _adminLoginSubmit(); }
    if (e.key === "Escape") {
      const modal = document.getElementById("adminLoginModal");
      if (modal) modal.hidden = true;
    }
  });
}

async function _adminLoginSubmit() {
  const modal = document.getElementById("adminLoginModal");
  const pwInput = document.getElementById("adminLoginPassword");
  const errBox = document.getElementById("adminLoginError");
  const submitBtn = document.getElementById("adminLoginSubmit");
  if (!modal || !pwInput || !submitBtn) return;

  const baseUrl = (typeof getControlUrl === "function")
    ? getControlUrl()
    : (controlUrlInput && controlUrlInput.value.trim());
  if (!baseUrl) {
    if (errBox) { errBox.hidden = false; errBox.textContent = "Set a server URL first."; }
    return;
  }
  try {
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in…";
    await adminLogin(baseUrl, pwInput.value);
    modal.hidden = true;
    renderAdminBadge();
    // Auto-open the panel on first explicit login (not on auto-restore).
    if (typeof startAdminPanel === "function") startAdminPanel();
  } catch (e) {
    if (errBox) { errBox.hidden = false; errBox.textContent = String(e.message || e); }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Sign in";
  }
}

function renderAdminBadge() {
  const slot = document.getElementById("adminBadgeSlot");
  if (!slot) return;
  if (!adminToken) { slot.innerHTML = ""; return; }
  // Badge has THREE clickable parts:
  //  - The 🛡 ADMIN label → toggles the admin panel show/hide
  //  - "Panel" button → explicit toggle (in case clicking the label feels wrong)
  //  - "Sign out" button → clears the admin token
  slot.innerHTML = `
    <div class="admin-badge" id="adminBadgeBox">
      <span class="admin-badge-label" id="adminBadgeToggle" title="Click to toggle admin panel">🛡 ADMIN</span>
      <button type="button" id="adminPanelToggleBtn" title="Show/hide admin panel">Panel</button>
      <button type="button" id="adminLogoutBtn" title="Sign out of admin">Sign out</button>
    </div>
  `;
  const out = document.getElementById("adminLogoutBtn");
  if (out) out.addEventListener("click", () => {
    adminLogout();
    renderAdminBadge();
    if (typeof stopAdminPanel === "function") stopAdminPanel();
  });
  const toggleHandler = () => {
    const panel = document.getElementById("adminPanel");
    if (!panel) return;
    if (panel.hidden) {
      if (typeof startAdminPanel === "function") startAdminPanel();
    } else {
      if (typeof stopAdminPanel === "function") stopAdminPanel();
    }
  };
  const toggleLabel = document.getElementById("adminBadgeToggle");
  if (toggleLabel) toggleLabel.addEventListener("click", toggleHandler);
  const toggleBtn = document.getElementById("adminPanelToggleBtn");
  if (toggleBtn) toggleBtn.addEventListener("click", toggleHandler);
}

// Auto-restore on load — restores the badge but does NOT auto-open the panel.
// Sam asked for explicit control: panel only opens when you click the badge or
// the Panel toggle. Avoids the "panel covers screen-share controls" surprise.
async function bootAdminFromStorage() {
  const baseUrl = (typeof getControlUrl === "function")
    ? getControlUrl()
    : (controlUrlInput && controlUrlInput.value.trim());
  if (!baseUrl) return;
  const ok = await restoreAdminFromStorage(baseUrl);
  if (ok) {
    renderAdminBadge();
    // Intentionally do NOT auto-open the panel on restore.
  }
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    PARTICIPANT_TOKEN_REFRESH_MARGIN_MS,
    decodeParticipantTokenExpirationMs,
    createParticipantTokenLifecycle,
  };
}
