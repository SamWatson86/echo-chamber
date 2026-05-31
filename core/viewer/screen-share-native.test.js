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

function loadNativeAudioProcessor(code) {
  const registered = {};
  const context = {
    sampleRate: 48000,
    Float32Array,
    Math,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { onmessage: null };
      }
    },
    registerProcessor(name, processor) {
      registered[name] = processor;
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "native-audio-worklet.js" });
  return new registered["native-audio-proc"]();
}

function assertFloatArrayApprox(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `index ${i}: ${actual[i]} !== ${expected[i]}`);
  }
}

test("game auto capture does not silently fall back to WGC", async () => {
  const { context, calls } = loadScreenShareNative();

  await context.startScreenShareManual();

  assert.equal(calls.some((call) => call.command === "check_desktop_capture_available"), true);
  assert.equal(calls.some((call) => call.command === "start_screen_share"), false);
});

test("game auto capture uses Desktop Duplication before WGC", async () => {
  const { context, calls } = loadScreenShareNative();
  context.showCapturePicker = async () => ({
    sourceType: "game",
    id: 4242,
    pid: 5678,
    isMonitor: false,
    captureMode: "auto",
  });
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "get_os_build_number") return 26100;
    if (command === "check_desktop_capture_available") return [true, "available"];
    return null;
  };

  await context.startScreenShareManual();

  const desktopStart = calls.find((call) => call.command === "start_desktop_capture");
  assert.ok(desktopStart);
  assert.equal(desktopStart.args.hwnd, 4242);
  assert.equal(desktopStart.args.fullscreen, false);
  assert.equal(desktopStart.args.publishProfile, "game");
  assert.equal(calls.some((call) => call.command === "start_screen_share"), false);
  assert.equal(context.window._echoNativeCaptureMode, "desktop-dd");
});

test("window auto capture uses Desktop Duplication before WGC", async () => {
  const { context, calls } = loadScreenShareNative();
  context.showCapturePicker = async () => ({
    sourceType: "window",
    id: 4242,
    pid: 5678,
    isMonitor: false,
    captureMode: "auto",
  });
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "get_os_build_number") return 26100;
    if (command === "check_desktop_capture_available") return [true, "available"];
    return null;
  };

  await context.startScreenShareManual();

  const desktopStart = calls.find((call) => call.command === "start_desktop_capture");
  assert.ok(desktopStart);
  assert.equal(desktopStart.args.hwnd, 4242);
  assert.equal(desktopStart.args.fullscreen, false);
  assert.equal(desktopStart.args.publishProfile, "desktop");
  assert.equal(calls.some((call) => call.command === "start_screen_share"), false);
  assert.equal(context.window._echoNativeCaptureMode, "desktop-dd");
});

test("manual WGC game capture keeps the WGC path available", async () => {
  const { context, calls } = loadScreenShareNative();
  context.showCapturePicker = async () => ({
    sourceType: "game",
    id: 4242,
    pid: 5678,
    isMonitor: false,
    captureMode: "wgc",
  });
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "get_os_build_number") return 26100;
    return null;
  };

  await context.startScreenShareManual();

  const wgcStart = calls.find((call) => call.command === "start_screen_share");
  assert.ok(wgcStart);
  assert.equal(wgcStart.args.sourceId, 4242);
  assert.equal(wgcStart.args.publishProfile, "game");
  assert.equal(calls.some((call) => call.command === "start_desktop_capture"), false);
  assert.equal(context.window._echoNativeCaptureMode, "wgc");
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

test("native audio capture request covers window and monitor shares", () => {
  const { context } = loadScreenShareNative();

  assert.equal(
    JSON.stringify(context.nativeAudioCaptureRequestForSource({ sourceType: "window", pid: 1234 })),
    JSON.stringify({ mode: "process", pid: 1234, toast: "Window audio streaming" })
  );
  assert.equal(
    JSON.stringify(context.nativeAudioCaptureRequestForSource({ sourceType: "game", pid: 5678 })),
    JSON.stringify({ mode: "process", pid: 5678, toast: "Game audio streaming" })
  );
  assert.equal(
    JSON.stringify(context.nativeAudioCaptureRequestForSource({ sourceType: "monitor", pid: 0 })),
    JSON.stringify({ mode: "system", pid: 0, toast: "System audio streaming" })
  );
  assert.equal(
    context.nativeAudioCaptureRequestForSource({ sourceType: "window", pid: 0 }),
    null
  );
});

test("native audio worklet downmixes multichannel WASAPI frames to stereo", () => {
  const { context } = loadScreenShareNative();
  const processor = loadNativeAudioProcessor(context._nativeAudioWorkletCode);

  processor.port.onmessage({ data: { type: "format", channels: 4, sampleRate: 48000 } });
  processor.port.onmessage({
    data: {
      type: "samples",
      samples: new Float32Array([
        0.1, 0.2, 0.3, 0.4,
        0.5, 0.6, 0.7, 0.8,
      ]),
    },
  });

  const out = [[new Float32Array(3), new Float32Array(3)]];
  processor.process([], out);

  assertFloatArrayApprox(Array.from(out[0][0]), [(0.1 + 0.3) * 0.707, (0.5 + 0.7) * 0.707, 0]);
  assertFloatArrayApprox(Array.from(out[0][1]), [(0.2 + 0.4) * 0.707, (0.6 + 0.8) * 0.707, 0]);
});

test("native audio worklet duplicates mono WASAPI frames", () => {
  const { context } = loadScreenShareNative();
  const processor = loadNativeAudioProcessor(context._nativeAudioWorkletCode);

  processor.port.onmessage({ data: { type: "format", channels: 1, sampleRate: 48000 } });
  processor.port.onmessage({ data: { type: "samples", samples: new Float32Array([0.25, -0.5]) } });

  const out = [[new Float32Array(2), new Float32Array(2)]];
  processor.process([], out);

  assert.deepEqual(Array.from(out[0][0]), [0.25, -0.5]);
  assert.deepEqual(Array.from(out[0][1]), [0.25, -0.5]);
});
