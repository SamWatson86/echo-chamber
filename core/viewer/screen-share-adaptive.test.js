const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildNativePresenterUnavailableReport,
  exposeNativePresenterReportGlobals,
  getNativePresenterStatusForReport,
  resolveNativePresenterStatusForReport,
} = require("./screen-share-adaptive.js");

test("native presenter unavailable report uses dashboard-safe shape", () => {
  const report = buildNativePresenterUnavailableReport("native presenter script unavailable");

  assert.equal(report.state, "fallback");
  assert.equal(report.render_path, "webview2");
  assert.equal(report.fallback_reason, "native presenter script unavailable");
  assert.equal(report.target_identity, null);
  assert.equal(report.target_track_sid, null);
});

test("native presenter report is null in browser viewer when script is missing", () => {
  const oldWindow = global.window;
  const oldSnapshot = global.getNativePresenterStatusSnapshot;
  delete global.getNativePresenterStatusSnapshot;
  global.window = { __ECHO_NATIVE__: false };

  assert.equal(getNativePresenterStatusForReport(), null);

  global.window = oldWindow;
  if (oldSnapshot) global.getNativePresenterStatusSnapshot = oldSnapshot;
});

test("native presenter report exposes missing script in native shell", () => {
  const oldWindow = global.window;
  const oldSnapshot = global.getNativePresenterStatusSnapshot;
  delete global.getNativePresenterStatusSnapshot;
  global.window = { __ECHO_NATIVE__: true };

  const report = getNativePresenterStatusForReport();

  assert.equal(report.state, "fallback");
  assert.equal(report.fallback_reason, "native presenter script unavailable");

  global.window = oldWindow;
  if (oldSnapshot) global.getNativePresenterStatusSnapshot = oldSnapshot;
});

test("native presenter dashboard report prefers refreshed Rust status", async () => {
  const oldWindow = global.window;
  const oldSnapshot = global.getNativePresenterStatusSnapshot;
  const oldRefresh = global.refreshNativePresenterStatusSnapshot;
  global.window = { __ECHO_NATIVE__: true };
  global.getNativePresenterStatusSnapshot = () => ({
    state: "fallback",
    render_path: "webview2",
    fallback_reason: "stale cached fallback",
    native_frames_received: 0,
  });
  global.refreshNativePresenterStatusSnapshot = async () => ({
    state: "receiving",
    render_path: "native_receive_probe",
    target_identity: "SAM-PC-1234",
    target_track_sid: "TR_screen",
    native_receive_fps: 58.8,
    native_frames_received: 240,
  });

  const report = await resolveNativePresenterStatusForReport();

  assert.equal(report.state, "receiving");
  assert.equal(report.render_path, "native_receive_probe");
  assert.equal(report.native_receive_fps, 58.8);
  assert.equal(report.fallback_reason, undefined);

  global.window = oldWindow;
  if (oldSnapshot) global.getNativePresenterStatusSnapshot = oldSnapshot;
  else delete global.getNativePresenterStatusSnapshot;
  if (oldRefresh) global.refreshNativePresenterStatusSnapshot = oldRefresh;
  else delete global.refreshNativePresenterStatusSnapshot;
});

test("native presenter report functions are exposed for debug reporter", () => {
  const root = {};

  exposeNativePresenterReportGlobals(root);

  assert.equal(typeof root.getNativePresenterStatusForReport, "function");
  assert.equal(typeof root.resolveNativePresenterStatusForReport, "function");
});
