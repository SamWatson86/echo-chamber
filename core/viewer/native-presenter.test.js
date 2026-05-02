const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeNativePresenterMode,
  nativePresenterIdentity,
  buildNativePresenterTileRect,
  buildNativePresenterReport,
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
