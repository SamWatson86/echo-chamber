const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadScreenShareNative() {
  const calls = [];
  const fetches = [];
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
    document: {
      body: { appendChild() {} },
      createElement() {
        return { style: {}, classList: { add() {}, remove() {} } };
      },
      getElementById() {
        return null;
      },
    },
    fetch: async (url, opts) => {
      fetches.push({ url: String(url), opts: opts || {} });
      return { ok: true, status: 200 };
    },
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
  return { context, calls, fetches };
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

test("game auto capture does not silently fallback to desktop duplication on WGC-supported Windows", async () => {
  const { context, calls } = loadScreenShareNative();
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "get_os_build_number") return 26100;
    if (command === "start_screen_share") throw new Error("WGC start failed");
    if (command === "check_desktop_capture_available") return [true, "available"];
    return null;
  };

  await context.startScreenShareManual();

  assert.equal(calls.some((call) => call.command === "start_screen_share"), true);
  assert.equal(calls.some((call) => call.command === "check_desktop_capture_available"), false);
  assert.equal(calls.some((call) => call.command === "start_desktop_capture"), false);
  assert.equal(context.screenEnabled, false);
});

test("game auto capture uses WGC before Desktop Duplication", async () => {
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

  const wgcStart = calls.find((call) => call.command === "start_screen_share");
  assert.ok(wgcStart);
  assert.equal(wgcStart.args.sourceId, 4242);
  assert.equal(wgcStart.args.publishProfile, "game");
  assert.equal(calls.some((call) => call.command === "check_desktop_capture_available"), false);
  assert.equal(calls.some((call) => call.command === "start_desktop_capture"), false);
  assert.equal(context.window._echoNativeCaptureMode, "wgc");
});

test("window auto capture uses WGC before Desktop Duplication", async () => {
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

  const wgcStart = calls.find((call) => call.command === "start_screen_share");
  assert.ok(wgcStart);
  assert.equal(wgcStart.args.sourceId, 4242);
  assert.equal(wgcStart.args.publishProfile, "desktop");
  assert.equal(calls.some((call) => call.command === "check_desktop_capture_available"), false);
  assert.equal(calls.some((call) => call.command === "start_desktop_capture"), false);
  assert.equal(context.window._echoNativeCaptureMode, "wgc");
});

test("game capture ignores Desktop Duplication mode on WGC-supported Windows", async () => {
  const { context, calls } = loadScreenShareNative();
  context.showCapturePicker = async () => ({
    sourceType: "game",
    id: 4242,
    pid: 5678,
    isMonitor: false,
    captureMode: "desktop-dd",
  });
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "get_os_build_number") return 26100;
    if (command === "check_desktop_capture_available") return [true, "available"];
    return null;
  };

  await context.startScreenShareManual();

  const wgcStart = calls.find((call) => call.command === "start_screen_share");
  assert.ok(wgcStart);
  assert.equal(wgcStart.args.sourceId, 4242);
  assert.equal(wgcStart.args.publishProfile, "game");
  assert.equal(calls.some((call) => call.command === "check_desktop_capture_available"), false);
  assert.equal(calls.some((call) => call.command === "start_desktop_capture"), false);
  assert.equal(context.window._echoNativeCaptureMode, "wgc");
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

test("monitor audio capture requests system audio with Echo playback excluded", () => {
  const { context } = loadScreenShareNative();

  assert.equal(
    JSON.stringify(context.nativeAudioCaptureRequestForSource({ sourceType: "window", pid: 1234 })),
    JSON.stringify({ mode: "process", pid: 1234, toast: "Window audio streaming" })
  );
  assert.equal(
    JSON.stringify(context.nativeAudioCaptureRequestForSource({ sourceType: "game", pid: 5678 })),
    JSON.stringify({ mode: "process", pid: 5678, toast: "Game audio streaming" })
  );
  const request = context.nativeAudioCaptureRequestForSource({ sourceType: "monitor", pid: 0 });
  assert.equal(request.mode, "system-exclude-echo");
  assert.equal(request.pid, 0);
  assert.equal(
    context.nativeAudioCaptureRequestForSource({ sourceType: "window", pid: 0 }),
    null
  );
});

test("native audio capture uses the Echo-excluding system command for monitor audio", async () => {
  const { context, calls } = loadScreenShareNative();

  context.hasTauriIPC = () => true;
  context.getLiveKitClient = () => ({
    Track: { Source: { ScreenShareAudio: "screen_share_audio" } },
    LocalAudioTrack: class {
      constructor(mediaStreamTrack) {
        this.mediaStreamTrack = mediaStreamTrack;
      }
    },
  });
  context.AudioContext = class {
    constructor() {
      this.state = "running";
      this.sampleRate = 48000;
      this.audioWorklet = { addModule: async () => {} };
    }
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [{ enabled: true, muted: false, readyState: "live" }] } };
    }
    async resume() {}
    async close() {}
  };
  context.AudioWorkletNode = class {
    constructor() {
      this.port = { postMessage() {} };
    }
    connect() {}
    disconnect() {}
  };
  context.Blob = Blob;
  context.URL = {
    createObjectURL: () => "blob:native-audio",
    revokeObjectURL() {},
  };
  context.tauriListen = async () => () => {};
  context.room.localParticipant.publishTrack = async () => {};

  await context.startNativeAudioCapture(0, { systemExcludeEcho: true });

  assert.equal(
    calls.some((call) => call.command === "start_system_audio_capture_excluding_echo"),
    true
  );
  assert.equal(
    calls.some((call) => call.command === "start_system_audio_capture"),
    false
  );
});

test("native stop clears local screen tile and removes the screen companion", async () => {
  const { context, calls, fetches } = loadScreenShareNative();
  let removed = false;
  let unregisteredSid = null;
  const tile = {
    dataset: { trackSid: "TR_SCREEN" },
    classList: { contains: () => false },
    remove() { removed = true; },
  };
  context.window._echoNativeCaptureActive = true;
  context.window._echoNativeCaptureMode = "wgc-monitor";
  context.screenEnabled = true;
  context.screenTileByIdentity = new Map([["Sam", tile]]);
  context.screenTileBySid = new Map([["TR_SCREEN", tile]]);
  context.screenTrackMeta = new Map([["TR_SCREEN", { identity: "Sam" }]]);
  context.screenRecoveryAttempts = new Map([["TR_SCREEN", 1]]);
  context.screenResubscribeIntent = new Map([["TR_SCREEN", 1]]);
  context.hiddenScreens = new Set(["Sam"]);
  context.watchedScreens = new Set(["Sam"]);
  context._pubBitrateControl = new Map([["Sam", {}]]);
  context.removeScreenTile = (sid) => {
    assert.equal(sid, "TR_SCREEN");
    removed = true;
    context.screenTileBySid.delete(sid);
  };
  context.unregisterScreenTrack = (sid) => {
    unregisteredSid = sid;
    context.screenTrackMeta.delete(sid);
  };

  await context.stopScreenShareManual();

  assert.equal(calls.some((call) => call.command === "stop_screen_share"), true);
  assert.equal(removed, true);
  assert.equal(unregisteredSid, "TR_SCREEN");
  assert.equal(context.screenTileByIdentity.has("Sam"), false);
  assert.equal(context.hiddenScreens.has("Sam"), false);
  assert.equal(context.watchedScreens.has("Sam"), false);
  assert.equal(context._pubBitrateControl.has("Sam"), false);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /\/v1\/rooms\/main\/kick\/Sam%24screen$/);
  assert.equal(fetches[0].opts.method, "POST");
  assert.equal(fetches[0].opts.headers.Authorization, "Bearer admin-token");
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
