const test = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("./native-presenter.js");

test("native presenter mode defaults to off", () => {
  assert.equal(normalizeNativePresenterMode("off"), "off");
  assert.equal(normalizeNativePresenterMode("on"), "on");
  assert.equal(normalizeNativePresenterMode("auto"), "auto");
  assert.equal(normalizeNativePresenterMode(""), "off");
  assert.equal(normalizeNativePresenterMode("turbo"), "off");
});

test("native presenter identity is a hidden companion identity", () => {
  assert.equal(nativePresenterIdentity("Sam-1234"), "Sam-1234$native-presenter");
  assert.equal(
    nativePresenterIdentity("Sam-1234$native-presenter"),
    "Sam-1234$native-presenter"
  );
});

test("native presenter companion identities are hidden from participant UI", () => {
  assert.equal(isNativePresenterIdentity("Sam-1234$native-presenter"), true);
  assert.equal(isNativePresenterIdentity("Sam-1234"), false);
  assert.equal(isNativePresenterIdentity("Sam-1234$screen"), false);
  assert.equal(isNativePresenterIdentity(""), false);
});

test("tile rect is converted to physical pixels", () => {
  const tile = {
    getBoundingClientRect() {
      return { left: 10.25, top: 20.5, width: 640.5, height: 360.25 };
    },
  };
  const rect = buildNativePresenterTileRect(tile, 1.5);
  assert.deepEqual(rect, {
    x: 15,
    y: 31,
    width: 961,
    height: 540,
    scale_factor: 1.5,
  });
});

test("native presenter report is null when status is missing", () => {
  assert.equal(buildNativePresenterReport(null), null);
});

test("native presenter idle status proves the script loaded", () => {
  const status = buildNativePresenterIdleStatus("on");

  assert.equal(status.state, "idle");
  assert.equal(status.render_path, "webview2");
  assert.equal(status.fallback_reason, "native presenter script loaded; waiting for screen track");
  assert.equal(status.mode, "on");
});

test("native presenter fallback status reports skipped activation reason", () => {
  const status = buildNativePresenterFallbackStatus("admin token unavailable", {
    identity: "SAM-PC-1234",
    trackSid: "TR_screen",
    tile: {
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 1280, height: 720 };
      },
    },
    scaleFactor: 1,
  });

  assert.equal(status.state, "fallback");
  assert.equal(status.render_path, "webview2");
  assert.equal(status.fallback_reason, "admin token unavailable");
  assert.equal(status.target_identity, "SAM-PC-1234");
  assert.equal(status.target_track_sid, "TR_screen");
  assert.equal(status.tile_width, 1280);
  assert.equal(status.tile_height, 720);
});

test("native presenter report exposes safe telemetry names", () => {
  const report = buildNativePresenterReport({
    state: "receiving",
    render_path: "native_receive_probe",
    target_identity: "Spencer-2222",
    target_track_sid: "TR_screen",
    native_receive_fps: 59.7,
    native_presented_fps: null,
    native_frames_received: 120,
    native_frames_dropped: 0,
    queue_depth: 0,
    fallback_reason: null,
    tile_width: 1920,
    tile_height: 1080,
    updated_at_ms: 4567,
  });

  assert.equal(report.state, "receiving");
  assert.equal(report.render_path, "native_receive_probe");
  assert.equal(report.native_receive_fps, 59.7);
  assert.equal(report.native_presented_fps, null);
  assert.equal(report.target_identity, "Spencer-2222");
});

test("refresh native presenter status asks Tauri for live Rust status", async () => {
  const oldWindow = global.window;
  const oldHasTauriIPC = global.hasTauriIPC;
  const oldTauriInvoke = global.tauriInvoke;
  const oldDebugLog = global.debugLog;
  global.window = { __ECHO_NATIVE__: true };
  global.hasTauriIPC = () => true;
  global.debugLog = () => {};
  global.tauriInvoke = async (command) => {
    assert.equal(command, "get_native_presenter_status");
    return {
      state: "receiving",
      render_path: "native_receive_probe",
      target_identity: "SAM-PC-1234",
      target_track_sid: "TR_screen",
      native_receive_fps: 58.8,
      native_presented_fps: null,
      native_frames_received: 240,
      native_frames_dropped: 0,
      queue_depth: 0,
      fallback_reason: null,
      tile_width: 1920,
      tile_height: 1080,
      updated_at_ms: 1234,
    };
  };

  const report = await refreshNativePresenterStatusSnapshot();

  assert.equal(report.state, "receiving");
  assert.equal(report.native_receive_fps, 58.8);
  assert.equal(report.native_frames_received, 240);

  global.window = oldWindow;
  global.hasTauriIPC = oldHasTauriIPC;
  global.tauriInvoke = oldTauriInvoke;
  global.debugLog = oldDebugLog;
});

test("native presenter telemetry functions are exposed for other scripts", () => {
  const root = {};

  exposeNativePresenterGlobals(root);

  assert.equal(typeof root.getNativePresenterStatusSnapshot, "function");
  assert.equal(typeof root.refreshNativePresenterStatusSnapshot, "function");
});

test("native presenter stats payload carries native report for dashboard merge", () => {
  const payload = buildNativePresenterStatsPayload({
    state: "receiving",
    render_path: "native_receive_probe",
    target_identity: "SAM-PC-1234",
    target_track_sid: "TR_screen",
    native_receive_fps: 15.1,
    native_presented_fps: null,
    native_frames_received: 1200,
    native_frames_dropped: 0,
    queue_depth: 0,
    fallback_reason: null,
    tile_width: 1920,
    tile_height: 1080,
    updated_at_ms: 12345,
  }, {
    identity: "Sam-1234",
    name: "Sam",
    room: "main",
  });

  assert.equal(payload.identity, "Sam-1234");
  assert.equal(payload.name, "Sam");
  assert.equal(payload.room, "main");
  assert.equal(payload.native_presenter.state, "receiving");
  assert.equal(payload.native_presenter.render_path, "native_receive_probe");
  assert.equal(payload.native_presenter.native_receive_fps, 15.1);
});

test("native presenter start request carries visible viewer token for native status reporting", () => {
  const tile = {
    dataset: {
      identity: "SAM-PC-1234",
      trackSid: "TR_screen",
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 1280, height: 720 };
    },
  };

  const request = buildNativePresenterStartRequest({
    mode: "on",
    room: "main",
    sfuUrl: "wss://echo.example.invalid",
    nativeToken: "hidden-native-token",
    viewerIdentity: "Sam-1234",
    viewerName: "Sam",
    viewerToken: "visible-viewer-token",
    controlUrl: "https://echo.example.invalid/",
    participantIdentity: "SAM-PC-1234",
    trackSid: "TR_screen",
    tile,
    scaleFactor: 1,
  });

  assert.equal(request.token, "hidden-native-token");
  assert.equal(request.viewer_token, "visible-viewer-token");
  assert.equal(request.viewer_name, "Sam");
  assert.equal(request.control_url, "https://echo.example.invalid/");
  assert.equal(request.viewer_identity, "Sam-1234");
  assert.equal(request.participant_identity, "SAM-PC-1234");
  assert.deepEqual(request.tile, {
    x: 10,
    y: 20,
    width: 1280,
    height: 720,
    scale_factor: 1,
  });
});

test("native presenter blocks a second active target", () => {
  assert.equal(
    nativePresenterStartBlockReason("TR_brad", "TR_sam", ""),
    "native presenter already probing another screen"
  );
  assert.equal(nativePresenterStartBlockReason("TR_sam", "TR_sam", ""), "already active");
});

test("native presenter blocks a second pending target", () => {
  assert.equal(
    nativePresenterStartBlockReason("TR_brad", "", "TR_sam"),
    "native presenter start already pending for another screen"
  );
  assert.equal(nativePresenterStartBlockReason("TR_sam", "", "TR_sam"), "already pending");
  assert.equal(nativePresenterStartBlockReason("TR_sam", "", ""), null);
});
