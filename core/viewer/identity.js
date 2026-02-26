/* =========================================================
   IDENTITY — Name parsing, device IDs, and track helpers
   ========================================================= */

/** Reliably extract track source from publication + track. Used everywhere. */
function getTrackSource(publication, track) {
  return publication?.source || track?.source || null;
}

function ensureIdentitySuffix() {
  // Check persistent storage first so identity survives app restarts
  const persisted = echoGet(IDENTITY_SUFFIX_KEY);
  if (persisted) return persisted;
  // Fall back to sessionStorage (legacy)
  const session = sessionStorage.getItem(IDENTITY_SUFFIX_KEY);
  if (session) { echoSet(IDENTITY_SUFFIX_KEY, session); return session; }
  const fresh = `${Math.floor(Math.random() * 9000 + 1000)}`;
  echoSet(IDENTITY_SUFFIX_KEY, fresh);
  sessionStorage.setItem(IDENTITY_SUFFIX_KEY, fresh);
  return fresh;
}

// Stable device UUID — persists across sessions regardless of what name the user types.
// Used to key profile data (avatar, chimes) to the DEVICE, not the name.
function ensureDeviceId() {
  var existing = echoGet(DEVICE_ID_KEY);
  if (existing) return existing;
  // Generate a UUID-v4 using crypto API (or fallback to Math.random)
  var uuid;
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    uuid = crypto.randomUUID();
  } else if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    var hex = Array.from(bytes, function(b) { return b.toString(16).padStart(2, "0"); }).join("");
    uuid = hex.slice(0,8) + "-" + hex.slice(8,12) + "-" + hex.slice(12,16) + "-" + hex.slice(16,20) + "-" + hex.slice(20);
  } else {
    uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  echoSet(DEVICE_ID_KEY, uuid);
  return uuid;
}

// Get the device ID for the local user (shorthand used throughout profile code)
function getLocalDeviceId() {
  return ensureDeviceId();
}

function slugifyIdentity(text) {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildIdentity(name) {
  const base = slugifyIdentity(name) || "viewer";
  return `${base}-${ensureIdentitySuffix()}`;
}

function getParticipantPublications(participant) {
  if (!participant) return [];
  if (typeof participant.getTrackPublications === "function") {
    return participant.getTrackPublications();
  }
  if (participant.trackPublications?.values) {
    return Array.from(participant.trackPublications.values());
  }
  if (participant.tracks?.values) {
    return Array.from(participant.tracks.values());
  }
  return Array.from(participant.tracks || []);
}

function wasRecentlyHandled(key, windowMs = 200) {
  if (!key) return false;
  const last = lastTrackHandled.get(key) || 0;
  const timeSinceLast = performance.now() - last;
  if (timeSinceLast < windowMs) {
    debugLog(`track recently handled: ${key} (${Math.floor(timeSinceLast)}ms ago)`);
  }
  return timeSinceLast < windowMs;
}

function markHandled(key) {
  if (!key) return;
  lastTrackHandled.set(key, performance.now());
}

function setDeviceStatus(text, isError = false) {
  deviceStatusEl.textContent = text || "";
  deviceStatusEl.style.color = isError ? "#f87171" : "";
}

function getInitials(name) {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("");
}

function getIdentityBase(identity) {
  // Strip the -XXXX numeric suffix from "name-1234" -> "name"
  return identity ? identity.replace(/-\d+$/, "") : identity;
}
