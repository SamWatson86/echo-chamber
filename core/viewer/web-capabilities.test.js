const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadScript(fileName, endMarker, extraContext = {}) {
  const context = {
    togglePg13Button: null,
    ...extraContext,
  };
  let source = fs.readFileSync(path.join(__dirname, fileName), "utf8");
  if (endMarker) source = source.slice(0, source.indexOf(endMarker));
  vm.createContext(context);
  vm.runInContext(
    source,
    context,
    { filename: fileName }
  );
  return context;
}

test("browser output selection follows setSinkId capability", () => {
  const context = loadScript("media-controls.js", "async function ensureDevicePermissions");

  assert.equal(context.shouldEnableAudioOutputSelection({
    nativeIpc: false,
    setSinkIdSupported: true,
  }), true);
  assert.equal(context.shouldEnableAudioOutputSelection({
    nativeIpc: false,
    setSinkIdSupported: false,
  }), false);
});

test("native IPC keeps existing Windows output controls enabled", () => {
  const context = loadScript("media-controls.js", "async function ensureDevicePermissions");

  assert.equal(context.shouldEnableAudioOutputSelection({
    nativeIpc: true,
    setSinkIdSupported: false,
  }), true);
});

test("Mac browser permission guidance points to site and OS controls", () => {
  const context = loadScript("media-controls.js", "async function ensureDevicePermissions");
  const message = context.devicePermissionGuidance({ macOS: true, nativeShell: false });

  assert.match(message, /Echo site/);
  assert.match(message, /macOS Privacy & Security/);
  assert.match(message, /reload/);
  assert.doesNotMatch(message, /restart Echo/);
});

test("desktop updater action is native-shell only", () => {
  const context = loadScript("theme.js", "function buildVersionSection");

  assert.equal(context.shouldShowDesktopUpdater({ nativeShell: true, hasIpc: true }), true);
  assert.equal(context.shouldShowDesktopUpdater({ nativeShell: false, hasIpc: true }), false);
  assert.equal(context.shouldShowDesktopUpdater({ nativeShell: true, hasIpc: false }), false);
});
