/* =========================================================
   NATIVE PRESENTER - guarded native receive probe for screen tiles
   ========================================================= */

const NATIVE_PRESENTER_MODE_KEY = "echo-native-presenter-mode";
var _nativePresenterStatus = null;
var _nativePresenterActiveTrackSid = "";
var _nativePresenterPollTimer = null;

function normalizeNativePresenterMode(value) {
  var mode = String(value || "off").toLowerCase();
  return mode === "on" || mode === "auto" ? mode : "off";
}

function getNativePresenterMode() {
  if (typeof echoGet !== "function") return "off";
  return normalizeNativePresenterMode(echoGet(NATIVE_PRESENTER_MODE_KEY));
}

function nativePresenterIdentity(viewerIdentity) {
  var identity = String(viewerIdentity || "").trim();
  if (!identity) return "";
  return identity.endsWith("$native-presenter") ? identity : identity + "$native-presenter";
}

function buildNativePresenterTileRect(tile, scaleFactor) {
  var rect = tile.getBoundingClientRect();
  var scale = Number(scaleFactor || window.devicePixelRatio || 1) || 1;
  return {
    x: Math.round(rect.left * scale),
    y: Math.round(rect.top * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
    scale_factor: scale,
  };
}

function buildNativePresenterReport(status) {
  if (!status) return null;
  return {
    state: status.state || "disabled",
    render_path: status.render_path || "webview2",
    target_identity: status.target_identity || null,
    target_track_sid: status.target_track_sid || null,
    native_receive_fps: status.native_receive_fps ?? null,
    native_presented_fps: status.native_presented_fps ?? null,
    native_frames_received: status.native_frames_received || 0,
    native_frames_dropped: status.native_frames_dropped || 0,
    queue_depth: status.queue_depth || 0,
    fallback_reason: status.fallback_reason || null,
    tile_width: status.tile_width || null,
    tile_height: status.tile_height || null,
    updated_at_ms: status.updated_at_ms || 0,
  };
}

function getNativePresenterStatusSnapshot() {
  return buildNativePresenterReport(_nativePresenterStatus);
}

function shouldNativePresenterProbeScreen(mode, tile) {
  if (!window.__ECHO_NATIVE__ || typeof hasTauriIPC !== "function" || !hasTauriIPC()) return false;
  if (mode === "off") return false;
  if (!tile || !tile.dataset || !tile.dataset.trackSid || !tile.dataset.identity) return false;
  if (mode === "on") return true;
  var rect = tile.getBoundingClientRect();
  return rect.width >= 1600 || rect.height >= 900;
}

async function fetchNativePresenterToken(identity) {
  if (!adminToken) throw new Error("admin token unavailable");
  var controlUrl = controlUrlInput.value.trim();
  var roomId = currentRoomName || "main";
  var presenterIdentity = nativePresenterIdentity(identity);
  var presenterName = (nameInput.value.trim() || "Viewer") + " Native Presenter";
  return fetchRoomToken(controlUrl, adminToken, roomId, presenterIdentity, presenterName);
}

async function maybeStartNativePresenterForScreenTrack(meta) {
  try {
    var mode = getNativePresenterMode();
    var tile = meta && meta.tile;
    if (!shouldNativePresenterProbeScreen(mode, tile)) return null;
    var identity = meta.identity || (tile.dataset && tile.dataset.identity) || "";
    var trackSid = meta.trackSid || (tile.dataset && tile.dataset.trackSid) || "";
    if (!identity || !trackSid) return null;
    if (_nativePresenterActiveTrackSid === trackSid) return _nativePresenterStatus;

    var token = await fetchNativePresenterToken(room?.localParticipant?.identity || identityInput.value || identity);
    var status = await tauriInvoke("start_native_presenter", {
      request: {
        mode: mode,
        room: currentRoomName || "main",
        sfu_url: sfuUrlInput.value.trim(),
        token: token,
        viewer_identity: room?.localParticipant?.identity || identityInput.value || "",
        participant_identity: identity,
        track_sid: trackSid,
        tile: buildNativePresenterTileRect(tile, window.devicePixelRatio || 1),
      },
    });
    _nativePresenterStatus = status;
    _nativePresenterActiveTrackSid = trackSid;
    startNativePresenterStatusPolling();
    debugLog("[native-presenter] receive probe started for " + identity + " " + trackSid);
    return status;
  } catch (e) {
    debugLog("[native-presenter] start failed: " + (e && e.message ? e.message : e));
    return null;
  }
}

async function stopNativePresenterForTrack(trackSid) {
  if (!_nativePresenterActiveTrackSid || _nativePresenterActiveTrackSid !== trackSid) return null;
  return stopAllNativePresenter("track removed");
}

async function stopAllNativePresenter(reason) {
  if (!window.__ECHO_NATIVE__ || typeof hasTauriIPC !== "function" || !hasTauriIPC()) return null;
  try {
    var status = await tauriInvoke("stop_native_presenter", { reason: reason || "viewer stopped" });
    _nativePresenterStatus = status;
    _nativePresenterActiveTrackSid = "";
    return status;
  } catch (e) {
    debugLog("[native-presenter] stop failed: " + (e && e.message ? e.message : e));
    return null;
  }
}

function startNativePresenterStatusPolling() {
  if (_nativePresenterPollTimer) return;
  _nativePresenterPollTimer = setInterval(async function() {
    try {
      if (!window.__ECHO_NATIVE__ || typeof hasTauriIPC !== "function" || !hasTauriIPC()) return;
      _nativePresenterStatus = await tauriInvoke("get_native_presenter_status");
    } catch (e) {
      debugLog("[native-presenter] status failed: " + (e && e.message ? e.message : e));
    }
  }, 1000);
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    normalizeNativePresenterMode,
    nativePresenterIdentity,
    buildNativePresenterTileRect,
    buildNativePresenterReport,
  };
}
