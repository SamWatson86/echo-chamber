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

test("Mac browser sharing selects the conservative direct-track profile", () => {
  const { context } = loadScreenShareNative();

  assert.equal(context.shouldUseConservativeBrowserScreenShare({
    nativeClient: false,
    navigatorLike: {
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
    },
    canvasCaptureSupported: true,
    workerSupported: true,
  }), true);
});

test("capable Windows browser sharing keeps the existing canvas profile", () => {
  const { context } = loadScreenShareNative();

  assert.equal(context.shouldUseConservativeBrowserScreenShare({
    nativeClient: false,
    navigatorLike: {
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
    canvasCaptureSupported: true,
    workerSupported: true,
  }), false);
});

test("missing canvas or Worker capability safely selects direct-track sharing", () => {
  const { context } = loadScreenShareNative();
  const navigatorLike = {
    platform: "Linux x86_64",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
  };

  assert.equal(context.shouldUseConservativeBrowserScreenShare({
    nativeClient: false,
    navigatorLike,
    canvasCaptureSupported: false,
    workerSupported: true,
  }), true);
  assert.equal(context.shouldUseConservativeBrowserScreenShare({
    nativeClient: false,
    navigatorLike,
    canvasCaptureSupported: true,
    workerSupported: false,
  }), true);
});

test("conservative display request is video-only and omits Chromium-only hints", () => {
  const { context } = loadScreenShareNative();
  const constraints = context.buildBrowserDisplayMediaConstraints(true);

  assert.equal(constraints.video.frameRate.ideal, 30);
  assert.equal(constraints.audio, false);
  assert.equal("systemAudio" in constraints, false);
  assert.equal("surfaceSwitching" in constraints, false);
});

test("capable Chromium display request explicitly excludes system audio", () => {
  const { context } = loadScreenShareNative();
  const constraints = context.buildBrowserDisplayMediaConstraints(false);

  assert.equal(constraints.video.frameRate.ideal, 60);
  assert.equal(constraints.video.resizeMode, "none");
  assert.equal(constraints.audio, false);
  assert.equal(constraints.systemAudio, "exclude");
});

test("browser capture cleanup stops every acquired track", () => {
  const { context } = loadScreenShareNative();
  const stopped = [];
  context.stopBrowserCaptureStream({
    getTracks: () => [
      { stop: () => stopped.push("video") },
      { stop: () => stopped.push("audio") },
    ],
  });

  assert.deepEqual(stopped, ["video", "audio"]);
});

test("browser audio guard stops unexpected audio without stopping video", () => {
  const { context } = loadScreenShareNative();
  const stopped = [];
  const count = context.stopUnexpectedBrowserAudioTracks({
    getAudioTracks: () => [
      { stop: () => stopped.push("audio-1") },
      { stop: () => stopped.push("audio-2") },
    ],
  });

  assert.equal(count, 2);
  assert.deepEqual(stopped, ["audio-1", "audio-2"]);
});

test("Mac browser start publishes the original display track without creating a canvas", async () => {
  const { context } = loadScreenShareNative();
  const published = [];
  const optionCalls = [];
  const toasts = [];
  let canvasCreated = false;
  let unexpectedAudioStopped = false;
  const videoTrack = {
    id: "mac-display-track",
    readyState: "live",
    enabled: true,
    muted: false,
    label: "Screen 1",
    getSettings: () => ({ width: 1728, height: 1117, frameRate: 30, displaySurface: "monitor" }),
    addEventListener() {},
    stop() {},
  };
  const unexpectedAudioTrack = {
    stop() { unexpectedAudioStopped = true; },
  };
  const stream = {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [unexpectedAudioTrack],
    getTracks: () => [videoTrack, unexpectedAudioTrack],
  };

  context.window.__ECHO_NATIVE__ = false;
  context.navigator = {
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
    mediaDevices: { getDisplayMedia: async () => stream },
  };
  context.HTMLCanvasElement = function HTMLCanvasElement() {};
  context.HTMLCanvasElement.prototype.captureStream = function() {};
  context.Worker = function Worker() {};
  context.prewarmedRooms = new Map();
  context._screenShareStatsInterval = null;
  context.logEvent = () => {};
  context.renderPublishButtons = () => {};
  context.showToast = (message) => toasts.push(message);
  context.getScreenSharePublishOptions = (width, height, conservative) => {
    optionCalls.push({ width, height, conservative });
    return { simulcast: false };
  };
  context.getLiveKitClient = () => ({
    Track: { Source: { ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
    LocalVideoTrack: class {
      constructor(mediaStreamTrack) {
        this.mediaStreamTrack = mediaStreamTrack;
        this.sender = null;
      }
    },
  });
  context.room.localParticipant.publishTrack = async (track, options) => {
    published.push({ track, options });
  };
  context.document.createElement = () => {
    canvasCreated = true;
    throw new Error("Mac direct-track route must not create a canvas");
  };

  await context.startScreenShareManual();

  assert.equal(canvasCreated, false);
  assert.equal(published.length, 1);
  assert.equal(published[0].track.mediaStreamTrack, videoTrack);
  assert.equal(published[0].options.source, "screen_share");
  assert.deepEqual(optionCalls, [{ width: 1728, height: 1117, conservative: true }]);
  assert.equal(context.window._echoCaptureSourceReport.capture_route, "browser-direct");
  assert.equal(unexpectedAudioStopped, true);
  assert.deepEqual(toasts, [
    "Screen shared without computer audio. Use the Echo Windows app for safe game audio.",
  ]);
});

test("old native picker fallback remains video-only", async () => {
  const { context } = loadScreenShareNative();
  const published = [];
  const toasts = [];
  let unexpectedAudioStopped = false;
  const videoTrack = {
    id: "legacy-native-display-track",
    readyState: "live",
    enabled: true,
    muted: false,
    label: "Screen 1",
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30, displaySurface: "monitor" }),
    addEventListener() {},
    stop() {},
  };
  const unexpectedAudioTrack = {
    stop() { unexpectedAudioStopped = true; },
  };
  const stream = {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [unexpectedAudioTrack],
    getTracks: () => [videoTrack, unexpectedAudioTrack],
  };

  context.showCapturePicker = async () => {
    throw new Error("Command list_screen_sources not found");
  };
  context.isTauriCommandMissingError = () => true;
  context.navigator = {
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    mediaDevices: { getDisplayMedia: async () => stream },
  };
  context.prewarmedRooms = new Map();
  context._screenShareStatsInterval = null;
  context.logEvent = () => {};
  context.renderPublishButtons = () => {};
  context.showToast = (message) => toasts.push(message);
  context.getScreenSharePublishOptions = () => ({ simulcast: false });
  context.getLiveKitClient = () => ({
    Track: { Source: { ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
    LocalVideoTrack: class {
      constructor(mediaStreamTrack) {
        this.mediaStreamTrack = mediaStreamTrack;
        this.sender = null;
      }
    },
  });
  context.room.localParticipant.publishTrack = async (track, options) => {
    published.push({ track, options });
  };

  await context.startScreenShareManual();

  assert.equal(unexpectedAudioStopped, true);
  assert.equal(published.length, 1);
  assert.equal(published[0].track.mediaStreamTrack, videoTrack);
  assert.equal(published[0].options.source, "screen_share");
  assert.deepEqual(toasts, [
    "Native screen picker unavailable; using browser picker",
    "Screen shared without computer audio. Use the Echo Windows app for safe game audio.",
  ]);
});

test("system-wide native audio fails closed while process-only routes remain available", () => {
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
  assert.equal(request.mode, "video-only");
  assert.equal(request.pid, 0);
  assert.equal(request.reason, "system-exclusion-unattested");
  assert.equal(
    request.toast,
    "Screen shared without computer audio — Echo voice isolation could not be verified."
  );
  assert.equal(
    context.nativeAudioCaptureRequestForSource({ sourceType: "window", pid: 0 }),
    null
  );
});

test("native audio routes use fixed non-sensitive LiveKit track names", () => {
  const { context } = loadScreenShareNative();

  assert.equal(
    context.nativeAudioTrackNameForOptions({ systemExcludeEcho: true }),
    "echo-screen-audio-system-exclude"
  );
  assert.equal(
    context.nativeAudioTrackNameForOptions({}),
    "echo-screen-audio-process"
  );
});

test("Battlefield 6 executable variants fail closed to video-only", () => {
  const { context } = loadScreenShareNative();
  const sources = [
    { sourceType: "game", pid: 601, title: "Loading", exe_name: "BF6.exe" },
    { sourceType: "game", pid: 602, title: "Loading", exeName: "C:\\Games\\Battlefield6.EXE" },
  ];

  for (const source of sources) {
    const request = context.nativeAudioCaptureRequestForSource(source);
    assert.equal(request.mode, "video-only");
    assert.equal(request.pid, 0);
    assert.equal(request.reason, "system-exclusion-unattested");
  }
});

test("Battlefield 6 exact title variants are used only when executable identity is absent", () => {
  const { context } = loadScreenShareNative();
  for (const title of ["BF6", "Battlefield 6", "Battlefield\u2122 6", " Battlefield  6 "]) {
    const request = context.nativeAudioCaptureRequestForSource({
      sourceType: "game",
      pid: 603,
      title,
    });
    assert.equal(request.mode, "video-only", title);
    assert.equal(request.reason, "system-exclusion-unattested", title);
  }
});

test("Battlefield 6 matching rejects false positives and preserves other source routes", () => {
  const { context } = loadScreenShareNative();
  const falsePositives = [
    { sourceType: "window", pid: 701, title: "Battlefield 6" },
    { sourceType: "game", pid: 702, title: "Battlefield 6 Beta" },
    { sourceType: "game", pid: 703, title: "My BF6 stream" },
    { sourceType: "game", pid: 704, title: "BF6", exe_name: "chrome.exe" },
    { sourceType: "game", pid: 705, title: "Battlefield 6", exeName: "bf2042.exe" },
    { sourceType: "game", pid: 706, title: "Battlefield 6", exe_name: "notbf6.exe" },
  ];

  for (const source of falsePositives) {
    const request = context.nativeAudioCaptureRequestForSource(source);
    assert.equal(request.mode, "process", JSON.stringify(source));
    assert.equal(request.pid, source.pid);
  }

  assert.equal(
    JSON.stringify(context.nativeAudioCaptureRequestForSource({
      sourceType: "game",
      pid: 801,
      title: "Crimson Desert",
      exe_name: "CrimsonDesert.exe",
    })),
    JSON.stringify({ mode: "process", pid: 801, toast: "Game audio streaming" })
  );
  assert.equal(
    JSON.stringify(context.nativeAudioCaptureRequestForSource({
      sourceType: "window",
      pid: 802,
      title: "PowerPoint",
    })),
    JSON.stringify({ mode: "process", pid: 802, toast: "Window audio streaming" })
  );
});

test("Battlefield 6 audio routing does not mutate capture geometry", () => {
  const { context } = loadScreenShareNative();
  const source = {
    sourceType: "game",
    id: 4242,
    pid: 5678,
    title: "BF6",
    width: 3440,
    height: 1440,
    fullscreenLike: true,
    monitorId: "DISPLAY1",
  };
  const before = JSON.stringify(source);

  context.nativeAudioCaptureRequestForSource(source);

  assert.equal(JSON.stringify(source), before);
});

test("unattested system audio is rejected before native capture or LiveKit publication", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];

  context.hasTauriIPC = () => true;
  context.room.localParticipant.publishTrack = async (track, options) => {
    published.push({ track, options });
  };

  for (const options of [{ system: true }, { systemExcludeEcho: true }]) {
    await assert.rejects(
      context.startNativeAudioCapture(0, options),
      /Echo voice isolation could not be verified/
    );
  }

  assert.equal(
    calls.some((call) => call.command === "start_system_audio_capture_excluding_echo"),
    false
  );
  assert.equal(
    calls.some((call) => call.command === "start_system_audio_capture"),
    false
  );
  assert.equal(calls.some((call) => call.command === "stop_audio_capture"), true);
  assert.equal(published.length, 0);
});

test("process-only native audio still captures the selected PID and publishes its fixed route", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];

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
  context.room.localParticipant.publishTrack = async (track, options) => {
    published.push({ track, options });
  };

  await context.startNativeAudioCapture(5678, {});

  const starts = calls.filter((call) => call.command === "start_audio_capture");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].args.pid, 5678);
  assert.equal(calls.some((call) => call.command === "start_system_audio_capture"), false);
  assert.equal(calls.some((call) => call.command === "start_system_audio_capture_excluding_echo"), false);
  assert.equal(published.length, 1);
  assert.equal(published[0].options.name, "echo-screen-audio-process");
});

test("Battlefield 6 starts native video but never starts or publishes unsafe system audio", async () => {
  const { context, calls } = loadScreenShareNative();
  const audioInvocations = [];
  const toasts = [];
  let audioStops = 0;
  context.showCapturePicker = async () => ({
    sourceType: "game",
    id: 4242,
    pid: 5678,
    title: "Battlefield 6",
    captureMode: "auto",
  });
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "get_os_build_number") return 26100;
    return null;
  };
  context.startNativeAudioCapture = async (pid, options) => {
    audioInvocations.push({ pid, options });
  };
  context.stopNativeAudioCapture = async () => {
    audioStops += 1;
  };
  context.showToast = (message) => toasts.push(message);
  context._startQualityWarnListener = () => {};

  await context.startScreenShareManual();
  await Promise.resolve();

  assert.equal(audioInvocations.length, 0);
  assert.equal(audioStops, 1);
  assert.equal(calls.some((call) => call.command === "start_screen_share"), true);
  assert.equal(
    toasts.includes("Screen shared without computer audio — Echo voice isolation could not be verified."),
    true
  );
});

test("native audio stop clears Rust capture even when viewer state says inactive", async () => {
  const { context, calls } = loadScreenShareNative();
  context.hasTauriIPC = () => true;

  await context.stopNativeAudioCapture();

  assert.equal(calls.filter((call) => call.command === "stop_audio_capture").length, 1);
});

test("native stop clears local screen tile and removes the screen companion", async () => {
  const { context, calls, fetches } = loadScreenShareNative();
  let removed = false;
  let unregisteredSid = null;
  const screenAvailability = [];
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
  context.setParticipantScreenWatchAvailable = (identity, available) => {
    screenAvailability.push([identity, available]);
  };

  await context.stopScreenShareManual();

  assert.equal(calls.some((call) => call.command === "stop_screen_share"), true);
  assert.equal(removed, true);
  assert.equal(unregisteredSid, "TR_SCREEN");
  assert.equal(context.screenTileByIdentity.has("Sam"), false);
  assert.equal(context.hiddenScreens.has("Sam"), false);
  assert.equal(context.watchedScreens.has("Sam"), false);
  assert.equal(context._pubBitrateControl.has("Sam"), false);
  assert.deepEqual(screenAvailability, [["Sam", false], ["Sam$screen", false]]);
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
