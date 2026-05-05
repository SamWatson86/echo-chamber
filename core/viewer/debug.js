/* =========================================================
   DEBUG — Logging, toasts, status, and HTML utilities
   ========================================================= */

const DEBUG_LIMIT = 180;

var _debugDirty = false;
var _debugRafPending = false;
function debugLog(message) {
  if (!message) return;
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${message}`;
  debugLines.push(line);
  while (debugLines.length > DEBUG_LIMIT) debugLines.shift();
  // Batch DOM updates — only repaint debug panel once per animation frame
  if (debugLogEl && !_debugRafPending) {
    _debugDirty = true;
    _debugRafPending = true;
    requestAnimationFrame(function() {
      _debugRafPending = false;
      if (_debugDirty && debugLogEl) {
        debugLogEl.textContent = debugLines.join("\n");
        _debugDirty = false;
      }
    });
  }
}

// ── Persistent event logging (server-side JSONL) ──
// Captures important events (freeze, screen share start/stop, layer changes)
// to daily stats log files for offline diagnosis.
function logEvent(eventName, detail) {
  try {
    if (!room?.localParticipant?.identity) return;
    fetch(apiUrl("/api/stats-log"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: room.localParticipant.identity,
        room: currentRoomName || "",
        event: eventName,
        event_detail: detail || null,
      }),
    }).catch(function() {});
  } catch (e) {}
}

function buildNativePresenterDebugFallback(reason) {
  return {
    state: "fallback",
    render_path: "webview2",
    target_identity: null,
    target_track_sid: null,
    native_receive_fps: null,
    native_presented_fps: null,
    native_frames_received: 0,
    native_frames_dropped: 0,
    queue_depth: 0,
    fallback_reason: reason || "native presenter unavailable",
    tile_width: null,
    tile_height: null,
    updated_at_ms: Date.now(),
  };
}

function getNativePresenterDebugReport() {
  if (typeof getNativePresenterStatusForReport === "function") {
    return getNativePresenterStatusForReport();
  }
  if (typeof getNativePresenterStatusSnapshot === "function") {
    try {
      return getNativePresenterStatusSnapshot()
        || buildNativePresenterDebugFallback("native presenter status unavailable");
    } catch (e) {
      return buildNativePresenterDebugFallback(
        "native presenter status error: " + (e && e.message ? e.message : e)
      );
    }
  }
  return typeof window !== "undefined" && window.__ECHO_NATIVE__ === true
    ? buildNativePresenterDebugFallback("native presenter script unavailable")
    : null;
}

function reportWatchDebug(message) {
  try {
    if (!message || !currentAccessToken || !room?.localParticipant?.identity) return;
    var payload = {
      identity: room.localParticipant.identity,
      name: room.localParticipant.name || "",
      room: currentRoomName || "",
      watch_debug: message,
    };
    var nativePresenter = getNativePresenterDebugReport();
    if (nativePresenter) payload.native_presenter = nativePresenter;
    fetch(apiUrl("/api/client-stats-report"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + currentAccessToken,
      },
      body: JSON.stringify(payload),
    }).catch(function() {});
  } catch (e) {}
}

// ── General toast notification ──
function showToast(message, durationMs) {
  var existing = document.querySelector(".jam-toast");
  if (existing) existing.remove();
  var toast = document.createElement("div");
  toast.className = "jam-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function() { toast.classList.add("jam-toast-visible"); }, 10);
  setTimeout(function() {
    toast.classList.remove("jam-toast-visible");
    setTimeout(function() { toast.remove(); }, 400);
  }, durationMs || 4000);
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#f87171" : "";
}

function describeDisconnectReason(reason, LK) {
  if (reason == null) return "unknown";
  if (typeof reason === "string") return reason;
  if (typeof reason === "number" && LK?.DisconnectReason) {
    const entry = Object.entries(LK.DisconnectReason).find(([, value]) => value === reason);
    if (entry) return entry[0];
  }
  return String(reason);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function linkifyText(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const escaped = escapeHtml(text || "");
  return escaped.replace(urlRegex, function(url) {
    const safeHref = url.replace(/\"/g, "%22");
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function escAdm(s) {
  var d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    buildNativePresenterDebugFallback,
    getNativePresenterDebugReport,
  };
}
