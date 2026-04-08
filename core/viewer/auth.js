/* =========================================================
   AUTH — LiveKit client, admin tokens, room tokens, and prefetch
   ========================================================= */

function getLiveKitClient() {
  return window.LiveKitClient || window.LivekitClient || window.LiveKit;
}

async function fetchAdminToken(baseUrl, password) {
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`Login failed (${login.status})`);
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
    body: JSON.stringify({ room, identity, name, deviceId: ensureDeviceId() }),
  });
  if (token.status === 409) throw new Error("Name is already in use by another connected user. Please choose a different name.");
  if (!token.ok) throw new Error(`Token failed (${token.status})`);
  const tokenData = await token.json();
  return tokenData.token;
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
        body: JSON.stringify({ room: rid, identity: id, name: nm, deviceId: ensureDeviceId() }),
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
      var warmRoom = new LK.Room({ adaptiveStream: false, dynacast: false, autoSubscribe: true });
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
function setupAdminLoginUi() {
  const btn = document.getElementById("adminLoginBtn");
  const modal = document.getElementById("adminLoginModal");
  const pwInput = document.getElementById("adminLoginPassword");
  const errBox = document.getElementById("adminLoginError");
  const cancelBtn = document.getElementById("adminLoginCancel");
  const submitBtn = document.getElementById("adminLoginSubmit");
  if (!btn || !modal || !pwInput || !submitBtn || !cancelBtn) return;

  btn.addEventListener("click", () => {
    pwInput.value = "";
    if (errBox) { errBox.hidden = true; errBox.textContent = ""; }
    modal.hidden = false;
    setTimeout(() => pwInput.focus(), 0);
  });

  cancelBtn.addEventListener("click", () => { modal.hidden = true; });

  pwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitBtn.click();
    if (e.key === "Escape") modal.hidden = true;
  });

  submitBtn.addEventListener("click", async () => {
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
      // Phase 2 will start the admin panel polling here.
      if (typeof startAdminPanel === "function") startAdminPanel();
    } catch (e) {
      if (errBox) { errBox.hidden = false; errBox.textContent = String(e.message || e); }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
    }
  });
}

function renderAdminBadge() {
  const slot = document.getElementById("adminBadgeSlot");
  if (!slot) return;
  if (!adminToken) { slot.innerHTML = ""; return; }
  slot.innerHTML = `
    <div class="admin-badge" id="adminBadgeBox">
      <span>🛡 ADMIN</span>
      <button type="button" id="adminLogoutBtn" title="Sign out of admin">Sign out</button>
    </div>
  `;
  const out = document.getElementById("adminLogoutBtn");
  if (out) out.addEventListener("click", () => {
    adminLogout();
    renderAdminBadge();
    if (typeof stopAdminPanel === "function") stopAdminPanel();
  });
}

// Auto-restore on load
async function bootAdminFromStorage() {
  const baseUrl = (typeof getControlUrl === "function")
    ? getControlUrl()
    : (controlUrlInput && controlUrlInput.value.trim());
  if (!baseUrl) return;
  const ok = await restoreAdminFromStorage(baseUrl);
  if (ok) {
    renderAdminBadge();
    if (typeof startAdminPanel === "function") startAdminPanel();
  }
}
