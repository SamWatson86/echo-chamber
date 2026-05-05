const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadScreenShareNative() {
  const calls = [];
  const context = {
    window: { __ECHO_NATIVE__: true },
    _nativeCaptureStopUnlisten: null,
    screenEnabled: false,
    _echoServerUrl: "https://echo.example.test:9443",
    adminToken: "admin-token",
    currentRoomName: "main",
    room: {
      localParticipant: {
        identity: "Sam",
        name: "Sam",
      },
    },
    getLiveKitClient() {
      return {};
    },
    showCapturePicker: async () => ({
      sourceType: "game",
      id: 4242,
      pid: 0,
      isMonitor: false,
    }),
    fetchRoomToken: async () => "screen-token",
    tauriInvoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "get_os_build_number") return 26100;
      if (command === "start_screen_share") {
        const starts = calls.filter((call) => call.command === "start_screen_share");
        if (starts.length === 1) throw new Error("first WGC start failed");
      }
      if (command === "check_desktop_capture_available") return [false, "unavailable"];
      return null;
    },
    tauriListen: undefined,
    debugLog() {},
    showToast() {},
    renderPublishButtons() {},
    _startQualityWarnListener() {
      throw new Error("force outer fallback path");
    },
    _stopQualityWarnListener() {},
    _sourceVisibilityInterval: null,
    _sourceVisibilityLastWarning: null,
    _sourceVisibilityLastToastAt: 0,
    stopNativeAudioCapture: async () => {},
    startNativeAudioCapture: async () => {},
    isTauriCommandMissingError: () => false,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  context.global = context;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "screen-share-native.js"), "utf8");
  vm.runInContext(code, context, { filename: "screen-share-native.js" });
  return { context, calls };
}

test("game WGC fallback keeps the high-motion publish profile", async () => {
  const { context, calls } = loadScreenShareNative();

  await context.startScreenShareManual();

  const screenStarts = calls.filter((call) => call.command === "start_screen_share");
  assert.equal(screenStarts.length, 2);
  assert.equal(screenStarts[1].args.publishProfile, "game");
});

test("source visibility warning tells the publisher to keep the shared window visible", () => {
  const { context } = loadScreenShareNative();

  assert.equal(
    context._captureSourceVisibilityToastMessage({
      warning: "Echo is covering the shared window",
    }),
    "Echo is covering the shared window. Keep the shared window visible while sharing."
  );
});

test("source visibility monitor is only enabled for native window-like sources", () => {
  const { context } = loadScreenShareNative();

  assert.equal(
    context._shouldMonitorNativeCaptureSource({ id: 123, sourceType: "window" }, "wgc"),
    true
  );
  assert.equal(
    context._shouldMonitorNativeCaptureSource({ id: 456, sourceType: "game" }, "desktop-dd"),
    true
  );
  assert.equal(
    context._shouldMonitorNativeCaptureSource({ id: 789, sourceType: "monitor" }, "desktop-dd"),
    false
  );
});
