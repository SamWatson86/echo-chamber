/* =========================================================
   NATIVE PRESENTER - guarded native receive probe for screen tiles
   ========================================================= */

const NATIVE_PRESENTER_MODE_KEY = "echo-native-presenter-mode";
var _nativePresenterStatus = null;
var _nativePresenterActiveTrackSid = "";
var _nativePresenterPendingTrackSid = "";
var _nativePresenterStartToken = 0;
var _nativePresenterPollTimer = null;
var _nativePresenterRetryTimers = [];
var _nativePresenterLastReportAt = 0;

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

function isNativePresenterIdentity(identity) {
  return String(identity || "").endsWith("$native-presenter");
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

function buildNativePresenterStatsPayload(status, context) {
  var report = buildNativePresenterReport(status);
  if (!report) return null;
  var ctx = context || {};
  return {
    identity: ctx.identity || "",
    name: ctx.name || "",
    room: ctx.room || "",
    native_presenter: report,
  };
}

function buildNativePresenterStartRequest(options) {
  var opts = options || {};
  return {
    mode: opts.mode,
    room: opts.room,
    sfu_url: opts.sfuUrl,
    token: opts.nativeToken,
    viewer_token: opts.viewerToken || "",
    viewer_identity: opts.viewerIdentity || "",
    viewer_name: opts.viewerName || "",
    control_url: opts.controlUrl || "",
    participant_identity: opts.participantIdentity || "",
    track_sid: opts.trackSid || "",
    tile: buildNativePresenterTileRect(opts.tile, opts.scaleFactor || window.devicePixelRatio || 1),
  };
}

function nativePresenterStartBlockReason(trackSid, activeTrackSid, pendingTrackSid) {
  var sid = String(trackSid || "").trim();
  var active = String(activeTrackSid || "").trim();
  var pending = String(pendingTrackSid || "").trim();
  if (!sid) return "native presenter target unavailable";
  if (active) {
    return active === sid ? "already active" : "native presenter already probing another screen";
  }
  if (pending) {
    return pending === sid ? "already pending" : "native presenter start already pending for another screen";
  }
  return null;
}

function skipNativePresenterStart(reason, meta) {
  try {
    var target = meta && (meta.trackSid || meta.track_sid || meta?.tile?.dataset?.trackSid);
    debugLog("[native-presenter] " + reason + (target ? " target=" + target : ""));
  } catch (e) {}
  return _nativePresenterStatus;
}

function postNativePresenterStatus(status, force) {
  try {
    if (!status || !currentAccessToken || !room?.localParticipant?.identity) return;
    var now = Date.now();
    if (!force && now - _nativePresenterLastReportAt < 2500) return;
    _nativePresenterLastReportAt = now;
    var payload = buildNativePresenterStatsPayload(status, {
      identity: room.localParticipant.identity,
      name: room.localParticipant.name || "",
      room: currentRoomName || "",
    });
    if (!payload) return;
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

function buildNativePresenterIdleStatus(mode) {
  var normalizedMode = mode === "loading" ? "loading" : normalizeNativePresenterMode(mode);
  return {
    state: "idle",
    render_path: "webview2",
    target_identity: null,
    target_track_sid: null,
    native_receive_fps: null,
    native_presented_fps: null,
    native_frames_received: 0,
    native_frames_dropped: 0,
    queue_depth: 0,
    tile_width: null,
    tile_height: null,
    fallback_reason: "native presenter script loaded; waiting for screen track",
    mode: normalizedMode,
    updated_at_ms: Date.now(),
  };
}

function buildNativePresenterFallbackStatus(reason, meta) {
  var tile = meta && meta.tile;
  var rect = null;
  try {
    rect = tile && typeof tile.getBoundingClientRect === "function"
      ? buildNativePresenterTileRect(tile, meta.scaleFactor || window.devicePixelRatio || 1)
      : null;
  } catch (e) {
    rect = null;
  }
  return {
    state: "fallback",
    render_path: "webview2",
    target_identity: meta && (meta.identity || meta.participant_identity) || null,
    target_track_sid: meta && (meta.trackSid || meta.track_sid) || null,
    native_receive_fps: null,
    native_presented_fps: null,
    native_frames_received: 0,
    native_frames_dropped: 0,
    queue_depth: 0,
    tile_width: rect ? rect.width : null,
    tile_height: rect ? rect.height : null,
    fallback_reason: reason || "native presenter skipped",
    updated_at_ms: Date.now(),
  };
}

function recordNativePresenterFallback(reason, meta) {
  _nativePresenterStatus = buildNativePresenterFallbackStatus(reason, meta || {});
  debugLog("[native-presenter] " + _nativePresenterStatus.fallback_reason);
  return _nativePresenterStatus;
}

function getNativePresenterStatusSnapshot() {
  if (_nativePresenterStatus && _nativePresenterStatus.state === "idle") {
    _nativePresenterStatus = buildNativePresenterIdleStatus(getNativePresenterMode());
  }
  return buildNativePresenterReport(_nativePresenterStatus);
}

async function refreshNativePresenterStatusSnapshot() {
  if (!window.__ECHO_NATIVE__ || typeof hasTauriIPC !== "function" || !hasTauriIPC()) {
    return getNativePresenterStatusSnapshot();
  }
  if (typeof tauriInvoke !== "function") return getNativePresenterStatusSnapshot();
  try {
    _nativePresenterStatus = await tauriInvoke("get_native_presenter_status");
    postNativePresenterStatus(_nativePresenterStatus, false);
  } catch (e) {
    debugLog("[native-presenter] status refresh failed: " + (e && e.message ? e.message : e));
  }
  return getNativePresenterStatusSnapshot();
}

function exposeNativePresenterGlobals(root) {
  if (!root) return;
  root.getNativePresenterStatusSnapshot = getNativePresenterStatusSnapshot;
  root.refreshNativePresenterStatusSnapshot = refreshNativePresenterStatusSnapshot;
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

function scheduleNativePresenterProbeRetries(meta) {
  if (!meta || !meta.trackSid) return;
  if (nativePresenterStartBlockReason(meta.trackSid, _nativePresenterActiveTrackSid, _nativePresenterPendingTrackSid)) return;
  [750, 2500].forEach(function(delay) {
    var timer = setTimeout(function() {
      if (nativePresenterStartBlockReason(meta.trackSid, _nativePresenterActiveTrackSid, _nativePresenterPendingTrackSid)) return;
      if (meta.tile && !meta.tile.isConnected) return;
      maybeStartNativePresenterForScreenTrack(meta).catch(function(e) {
        debugLog("[native-presenter] retry failed: " + (e && e.message ? e.message : e));
      });
    }, delay);
    _nativePresenterRetryTimers.push(timer);
  });
}

async function maybeStartNativePresenterForScreenTrack(meta) {
  try {
    var mode = getNativePresenterMode();
    var tile = meta && meta.tile;
    if (mode === "off") return recordNativePresenterFallback("native presenter mode is off", meta);
    if (!window.__ECHO_NATIVE__) return recordNativePresenterFallback("native shell unavailable", meta);
    if (typeof hasTauriIPC !== "function" || !hasTauriIPC()) return recordNativePresenterFallback("tauri ipc unavailable", meta);
    if (!tile || !tile.dataset) return recordNativePresenterFallback("screen tile metadata unavailable", meta);
    if (!tile.dataset.trackSid || !tile.dataset.identity) return recordNativePresenterFallback("screen tile target unavailable", meta);
    if (!shouldNativePresenterProbeScreen(mode, tile)) return recordNativePresenterFallback("native presenter screen probe not eligible", meta);
    var identity = meta.identity || (tile.dataset && tile.dataset.identity) || "";
    var trackSid = meta.trackSid || (tile.dataset && tile.dataset.trackSid) || "";
    if (!identity || !trackSid) return recordNativePresenterFallback("native presenter target unavailable", meta);
    var blockReason = nativePresenterStartBlockReason(
      trackSid,
      _nativePresenterActiveTrackSid,
      _nativePresenterPendingTrackSid
    );
    if (blockReason) return skipNativePresenterStart(blockReason, meta);

    var startToken = ++_nativePresenterStartToken;
    _nativePresenterPendingTrackSid = trackSid;
    var token = await fetchNativePresenterToken(room?.localParticipant?.identity || identityInput.value || identity);
    if (_nativePresenterPendingTrackSid !== trackSid || startToken !== _nativePresenterStartToken) {
      return skipNativePresenterStart("start canceled", meta);
    }
    var status = await tauriInvoke("start_native_presenter", {
      request: buildNativePresenterStartRequest({
        mode: mode,
        room: currentRoomName || "main",
        sfuUrl: sfuUrlInput.value.trim(),
        nativeToken: token,
        viewerToken: currentAccessToken || "",
        viewerIdentity: room?.localParticipant?.identity || identityInput.value || "",
        viewerName: nameInput.value.trim() || "",
        controlUrl: controlUrlInput.value.trim(),
        participantIdentity: identity,
        trackSid: trackSid,
        tile: tile,
        scaleFactor: window.devicePixelRatio || 1,
      }),
    });
    if (_nativePresenterPendingTrackSid !== trackSid || startToken !== _nativePresenterStartToken) {
      return skipNativePresenterStart("start canceled", meta);
    }
    _nativePresenterStatus = status;
    _nativePresenterActiveTrackSid = trackSid;
    _nativePresenterPendingTrackSid = "";
    startNativePresenterStatusPolling();
    postNativePresenterStatus(status, true);
    debugLog("[native-presenter] receive probe started for " + identity + " " + trackSid);
    return status;
  } catch (e) {
    _nativePresenterPendingTrackSid = "";
    recordNativePresenterFallback("start failed: " + (e && e.message ? e.message : e), meta);
    return null;
  }
}

async function stopNativePresenterForTrack(trackSid) {
  if (_nativePresenterPendingTrackSid && _nativePresenterPendingTrackSid === trackSid) {
    _nativePresenterPendingTrackSid = "";
    _nativePresenterStartToken += 1;
    return _nativePresenterStatus;
  }
  if (!_nativePresenterActiveTrackSid || _nativePresenterActiveTrackSid !== trackSid) return null;
  return stopAllNativePresenter("track removed");
}

async function stopAllNativePresenter(reason) {
  if (!window.__ECHO_NATIVE__ || typeof hasTauriIPC !== "function" || !hasTauriIPC()) return null;
  _nativePresenterRetryTimers.forEach(function(timer) { clearTimeout(timer); });
  _nativePresenterRetryTimers = [];
  _nativePresenterPendingTrackSid = "";
  _nativePresenterStartToken += 1;
  try {
    var status = await tauriInvoke("stop_native_presenter", { reason: reason || "viewer stopped" });
    _nativePresenterStatus = status;
    _nativePresenterActiveTrackSid = "";
    postNativePresenterStatus(status, true);
    return status;
  } catch (e) {
    debugLog("[native-presenter] stop failed: " + (e && e.message ? e.message : e));
    return null;
  }
}

function startNativePresenterStatusPolling() {
  if (_nativePresenterPollTimer) return;
  _nativePresenterPollTimer = setInterval(async function() {
    await refreshNativePresenterStatusSnapshot();
  }, 1000);
}

_nativePresenterStatus = buildNativePresenterIdleStatus("loading");
exposeNativePresenterGlobals(typeof globalThis === "object" ? globalThis : null);

if (typeof module === "object" && module.exports) {
  module.exports = {
    normalizeNativePresenterMode,
    nativePresenterIdentity,
    isNativePresenterIdentity,
    buildNativePresenterTileRect,
    buildNativePresenterIdleStatus,
    buildNativePresenterFallbackStatus,
    buildNativePresenterReport,
    buildNativePresenterStatsPayload,
    buildNativePresenterStartRequest,
    nativePresenterStartBlockReason,
    exposeNativePresenterGlobals,
    refreshNativePresenterStatusSnapshot,
  };
}
