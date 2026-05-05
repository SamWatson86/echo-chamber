const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildNativePresenterDebugFallback,
  getNativePresenterDebugReport,
} = require("./debug.js");

test("native presenter debug fallback uses client stats schema", () => {
  const report = buildNativePresenterDebugFallback("native presenter script unavailable");

  assert.equal(report.state, "fallback");
  assert.equal(report.render_path, "webview2");
  assert.equal(report.fallback_reason, "native presenter script unavailable");
  assert.equal(report.target_identity, null);
  assert.equal(report.target_track_sid, null);
});

test("native presenter debug report is null outside native shell", () => {
  const oldWindow = global.window;
  const oldSnapshot = global.getNativePresenterStatusSnapshot;
  const oldStatsHelper = global.getNativePresenterStatusForReport;
  delete global.getNativePresenterStatusSnapshot;
  delete global.getNativePresenterStatusForReport;
  global.window = { __ECHO_NATIVE__: false };

  assert.equal(getNativePresenterDebugReport(), null);

  global.window = oldWindow;
  if (oldSnapshot) global.getNativePresenterStatusSnapshot = oldSnapshot;
  if (oldStatsHelper) global.getNativePresenterStatusForReport = oldStatsHelper;
});

test("native presenter debug report exposes missing script in native shell", () => {
  const oldWindow = global.window;
  const oldSnapshot = global.getNativePresenterStatusSnapshot;
  const oldStatsHelper = global.getNativePresenterStatusForReport;
  delete global.getNativePresenterStatusSnapshot;
  delete global.getNativePresenterStatusForReport;
  global.window = { __ECHO_NATIVE__: true };

  const report = getNativePresenterDebugReport();

  assert.equal(report.state, "fallback");
  assert.equal(report.fallback_reason, "native presenter script unavailable");

  global.window = oldWindow;
  if (oldSnapshot) global.getNativePresenterStatusSnapshot = oldSnapshot;
  if (oldStatsHelper) global.getNativePresenterStatusForReport = oldStatsHelper;
});
