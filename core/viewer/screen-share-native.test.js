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
    _screenShareVideoTrack: null,
    _screenShareAudioTrack: null,
    _screenShareStatsInterval: null,
    _bitrateCaps: new Map(),
    _bitrateCapCleanupTimer: null,
    _cameraReducedForScreenShare: false,
    logEvent() {},
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
    hasTauriIPC: () => false,
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

function installNativeAudioRuntime(context, published, lifecycle) {
  const state = lifecycle || {};
  state.contextClosed = 0;
  state.workletDisconnected = 0;
  state.trackStopped = 0;
  state.unlistened = 0;

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
      return {
        stream: {
          getAudioTracks: () => [{
            enabled: true,
            muted: false,
            readyState: "live",
            stop() { state.trackStopped += 1; },
          }],
        },
      };
    }
    async resume() {}
    async close() { state.contextClosed += 1; }
  };
  context.AudioWorkletNode = class {
    constructor() {
      this.port = { postMessage() {} };
    }
    connect() {}
    disconnect() { state.workletDisconnected += 1; }
  };
  context.Blob = Blob;
  context.URL = {
    createObjectURL: () => "blob:native-audio",
    revokeObjectURL() {},
  };
  context.tauriListen = async () => () => { state.unlistened += 1; };
  context.room.localParticipant.publishTrack = async (track, options) => {
    published.push({ track, options });
  };
  return state;
}

function loadNativeShareRecovery(savedOverrides = {}) {
  const harness = loadScreenShareNative();
  const { context, calls } = harness;
  const source = { id: 4242, pid: 5678, sourceType: "game", title: "Original title", exeName: "game.exe" };
  const saved = { version: 1, source, mode: "wgc", identity: "Sam", roomName: "main",
    startedAt: Date.now() - 100000, ...savedOverrides };
  const storage = new Map([[context.NATIVE_SHARE_SESSION_KEY, JSON.stringify(saved)]]);
  context.window.sessionStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const published = [];
  installNativeAudioRuntime(context, published);
  context.hasTauriIPC = () => true;
  context._startQualityWarnListener = () => {};
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "get_capture_health") return { capture_active: true, capture_mode: "WGC", seconds_since_capture_started: 100 };
    if (command === "list_screen_sources") return [{ id: 4242, pid: 5678, source_type: "game", title: "Current game title", exe_name: "game.exe" }];
    return null;
  };
  return { ...harness, source, storage, published };
}

function installRoomDisconnectLifecycle(harness) {
  const { context, calls } = harness;
  const lifecycle = [];
  const eventRoom = context.room;
  const handlers = new Map();
  const noOp = () => {};
  Object.assign(context, {
    newRoom: eventRoom,
    LK: { RoomEvent: { Disconnected: 'disconnected' }, DisconnectReason: {} },
    phoneWakeLockManager: null,
    phoneAudioPlaybackRecovery: null,
    phoneScreenVideoBudget: null,
    androidFirefoxRoomDisconnectRecovery: null,
    androidFirefoxRoomDisconnectRecoveryEnabled: false,
    ignoreStaleRoomEvent: () => context.room !== eventRoom,
    describeDisconnectReason: () => 'server disconnected',
    _isRoomSwitch: false,
    connectSequence: 0,
    recordActiveRoomDiagnostic: (_room, action) => action(),
    captureAndroidFirefoxRecoveryMicIntent: () => false,
    reconnectAndroidFirefoxRoom: noOp,
    stopInboundScreenStatsMonitor: noOp,
    sendLeaveNotification: () => lifecycle.push('leave'),
    stopHeartbeat: noOp,
    stopRoomStatusPolling: noOp,
    _updateCheckTimer: null,
    disableNoiseCancellation: noOp,
    cleanupPrewarmedRooms: noOp,
    clearMedia: () => lifecycle.push('clear-media'),
    clearSoundboardState: noOp,
    clearConnectedParticipantToken: noOp,
    currentAccessToken: 'participant-token',
    applyPg13Ui: noOp,
    startOnlineUsersPolling: noOp,
    setPublishButtonsEnabled: noOp,
    _adminDashOpen: false,
    syncDesiredMicToActual: noOp,
    setDeviceStatus: noOp,
    setStatus: (message) => lifecycle.push('status:' + message),
    showToast: (message) => lifecycle.push('toast:' + message),
    connectBtn: {}, disconnectBtn: {}, disconnectTopBtn: {},
    roomListEl: { classList: { add: noOp } },
    connectPanel: { classList: { remove: noOp } },
  });
  for (const name of ['openSoundboardButton', 'openCameraLobbyButton', 'openChatButton',
    'bugReportBtn', 'openJamButton', 'togglePg13Button', 'toggleRoomAudioButton',
    'openSettingsButton', 'deviceActionsEl', 'deviceActionsHome', 'deviceStatusEl',
    'deviceStatusHome', 'settingsPanel']) context[name] = null;
  context.document.querySelector = () => null;
  context.tauriInvoke = async (command) => { calls.push({ command }); };
  eventRoom.on = (name, callback) => handlers.set(name, callback);
  eventRoom.disconnect = () => {
    lifecycle.push('room-disconnect');
    handlers.get('disconnected')?.(1);
  };
  const source = fs.readFileSync(path.join(__dirname, 'connect.js'), 'utf8').replace(/\r\n/g, '\n');
  const helperStart = source.indexOf('async function stopSharingBeforeRoomDisconnect(');
  // The fallback lets the regression harness execute the pre-fix disconnect too.
  const start = helperStart >= 0 ? helperStart : source.indexOf('async function disconnect()');
  const end = source.indexOf('// ── Connect/Disconnect button handlers', start);
  vm.runInContext(source.slice(start, end), context, { filename: 'connect.js:disconnect' });
  const handlerStart = source.indexOf('newRoom.on(LK.RoomEvent.Disconnected,');
  const handlerEnd = source.indexOf('\n    });\n  }\n  if (LK.RoomEvent?.AudioPlaybackStatusChanged)', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  vm.runInContext(source.slice(handlerStart, handlerEnd + '\n    });'.length), context,
    { filename: 'connect.js:Disconnected' });
  return { lifecycle, eventRoom, terminalDisconnect: () => handlers.get('disconnected')(1) };
}

test('Disconnect waits for both native stops before leaving and clearing the session', async () => {
  const harness = loadScreenShareNative();
  const { context, calls } = harness;
  const { lifecycle } = installRoomDisconnectLifecycle(harness);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  context.tauriInvoke = async command => { calls.push({ command }); await gate; };
  const pending = context.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.command), ['stop_screen_share', 'stop_desktop_capture']);
  assert.equal(lifecycle.includes('leave'), false);
  assert.equal(lifecycle.includes('room-disconnect'), false);
  release();
  await pending;
  assert.ok(lifecycle.indexOf('leave') < lifecycle.indexOf('room-disconnect'));
  assert.equal(context.room, null);
  assert.equal(context.screenEnabled, false);
  assert.equal(calls.length, 2, 'expected disconnect must not stop a replacement or double-stop');
});

test('Disconnect cancels an in-flight native start before announcing leave', async () => {
  const harness = loadScreenShareNative();
  const { context, calls } = harness;
  const { lifecycle } = installRoomDisconnectLifecycle(harness);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const starting = new Promise(resolve => { entered = resolve; });
  context.tauriInvoke = async command => {
    calls.push({ command });
    if (command === 'get_os_build_number') return 26100;
    if (command === 'start_screen_share') { entered(); await gate; }
  };
  let audioStarts = 0;
  context.startNativeAudioCapture = async () => { audioStarts++; };
  const share = context.startScreenShareManual();
  await starting;
  const leaving = context.disconnect();
  assert.equal(lifecycle.includes('leave'), false);
  release();
  assert.equal(await share, false);
  await leaving;
  assert.equal(audioStarts, 0);
  assert.equal(context.room, null);
  assert.equal(context.window._echoNativeCaptureActive, false);
  assert.ok(calls.some(call => call.command === 'stop_desktop_capture'));
});

test('failed native stop preserves the session and visible retry state on Disconnect', async () => {
  const harness = loadScreenShareNative();
  const { context } = harness;
  const { lifecycle, eventRoom } = installRoomDisconnectLifecycle(harness);
  context.tauriInvoke = async command => {
    if (command === 'stop_screen_share') throw new Error('native stop failed');
  };
  await assert.rejects(context.disconnect(), /could not be fully stopped/);
  assert.equal(context.room, eventRoom);
  assert.equal(context.currentAccessToken, 'participant-token');
  assert.equal(context.screenEnabled, true);
  assert.equal(lifecycle.includes('leave'), false);
  assert.equal(lifecycle.includes('clear-media'), false);
  assert.ok(lifecycle.some(value => value.startsWith('status:Screen sharing could not')));
});

test('terminal parent disconnect stops native capture even when active flags were lost', async () => {
  const harness = loadScreenShareNative();
  const { context, calls } = harness;
  const { terminalDisconnect } = installRoomDisconnectLifecycle(harness);
  terminalDisconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.command), ['stop_screen_share', 'stop_desktop_capture']);
  assert.equal(context.screenEnabled, false);
});

test('terminal parent disconnect cancels pending native startup without publishing audio', async () => {
  const harness = loadScreenShareNative();
  const { context, calls } = harness;
  const { terminalDisconnect } = installRoomDisconnectLifecycle(harness);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const starting = new Promise(resolve => { entered = resolve; });
  context.tauriInvoke = async command => {
    calls.push({ command });
    if (command === 'get_os_build_number') return 26100;
    if (command === 'start_screen_share') { entered(); await gate; }
  };
  let audioStarts = 0;
  context.startNativeAudioCapture = async () => { audioStarts++; };
  const share = context.startScreenShareManual();
  await starting;
  terminalDisconnect();
  release();
  assert.equal(await share, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(audioStarts, 0);
  assert.equal(context.screenEnabled, false);
  assert.ok(calls.some(call => call.command === 'stop_screen_share'));
  assert.ok(calls.some(call => call.command === 'stop_desktop_capture'));
});

test('terminal disconnect reports unconfirmed native shutdown and keeps End Sharing available', async () => {
  const harness = loadScreenShareNative();
  const { context } = harness;
  const { terminalDisconnect, lifecycle } = installRoomDisconnectLifecycle(harness);
  context.tauriInvoke = async command => {
    if (command === 'stop_desktop_capture') throw new Error('native stop failed');
  };
  terminalDisconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.screenEnabled, true);
  assert.ok(lifecycle.some(value => value.startsWith('status:Screen sharing could not')));
});

test('late old-Room terminal disconnect cannot stop a replacement share', async () => {
  const harness = loadScreenShareNative();
  const { context, calls } = harness;
  const { terminalDisconnect } = installRoomDisconnectLifecycle(harness);
  context.room = { localParticipant: { identity: 'Sam-new' } };
  context.window._echoNativeCaptureActive = true;
  context.screenEnabled = true;
  const generation = context._nativeShareRecoveryGeneration;
  terminalDisconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
  assert.equal(context.screenEnabled, true);
  assert.equal(context._nativeShareRecoveryGeneration, generation);
});

test('replacement Room during confirmed shutdown is not cleared by the old Disconnect continuation', async () => {
  const harness = loadScreenShareNative();
  const { context } = harness;
  const { lifecycle } = installRoomDisconnectLifecycle(harness);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  context.tauriInvoke = async () => gate;
  const leaving = context.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  const replacement = { localParticipant: { identity: 'Sam-new' } };
  context.room = replacement;
  release();
  await leaving;
  assert.equal(context.room, replacement);
  assert.equal(lifecycle.includes('leave'), false);
  assert.equal(lifecycle.includes('clear-media'), false);
  assert.equal(lifecycle.includes('room-disconnect'), false);
});

test("viewer reload restores the exact native game title and audio without restarting video", async () => {
  const { context, calls, published } = loadNativeShareRecovery();
  await context.recoverNativeScreenShare(context.room);
  assert.equal(context.window._echoNativeCaptureActive, true);
  assert.equal(context.window._echoNativeShareNeedsRestart, false);
  assert.equal(context.screenEnabled, true);
  assert.equal(context.getCaptureSourceReportSnapshot().source_title, "Current game title");
  assert.equal(published.length, 1);
  assert.equal(published[0].options.source, "screen_share_audio");
  assert.equal(calls.find(call => call.command === "start_audio_capture").args.pid, 5678);
  assert.equal(calls.some(call => call.command === "start_screen_share"), false);
  await context.recoverNativeScreenShare(context.room);
  assert.equal(published.length, 1);
});

test("fresh native share retains source provenance only for the current capture generation", async () => {
  const { context, source, storage } = loadNativeShareRecovery();
  storage.clear();
  context.window._echoNativeCaptureActive = true;
  await context.rememberNativeShareSession(source, "wgc", context._nativeShareRecoveryGeneration);
  const saved = JSON.parse(storage.get(context.NATIVE_SHARE_SESSION_KEY));
  assert.equal(saved.source.pid, 5678);
  assert.equal(saved.roomName, "main");
  assert.ok(Math.abs(saved.startedAt - (Date.now() - 100000)) < 1000);
  context.clearNativeShareSession();
  await context.rememberNativeShareSession(source, "wgc", context._nativeShareRecoveryGeneration - 1);
  assert.equal(storage.size, 0);
});

test("same-page room reconnection restores audio when native video is already marked active", async () => {
  const { context, published } = loadNativeShareRecovery();
  await context.recoverNativeScreenShare(context.room);
  await context.stopNativeAudioCapture();
  assert.equal(context.window._echoNativeCaptureActive, true);
  const rejoined = [];
  context.room = { localParticipant: { identity: 'Sam', name: 'Sam',
    publishTrack: async (track, options) => rejoined.push({ track, options }), unpublishTrack: async () => {},
  } };
  await context.recoverNativeScreenShare(context.room);
  assert.equal(published.length, 1);
  assert.equal(rejoined.length, 1);
  assert.equal(context._nativeAudioActive, true);
  assert.equal(context.window._echoNativeShareNeedsRestart, false);
});

test("pre-fix orphaned shares remain stoppable and request source selection instead of guessing audio", async () => {
  const { context, storage, published } = loadNativeShareRecovery();
  storage.clear();
  await context.recoverNativeScreenShare(context.room);
  assert.equal(context.window._echoNativeShareNeedsRestart, true);
  assert.equal(context.window._echoNativeCaptureActive, true);
  assert.equal(context.screenEnabled, true);
  assert.equal(published.length, 0);
  assert.equal(context.getCaptureSourceReportSnapshot(), null);
});

test("recovery rejects a stale capture, another room, identity, or reused window process", async () => {
  for (const overrides of [{ startedAt: Date.now() - 500000 }, { roomName: "other-room" }, { identity: "Other" },
    { source: { id: 4242, pid: 9999, sourceType: "game", exeName: "game.exe" } }]) {
    const { context, published } = loadNativeShareRecovery(overrides);
    await context.recoverNativeScreenShare(context.room);
    assert.equal(context.window._echoNativeShareNeedsRestart, true);
    assert.equal(published.length, 0);
    assert.equal(context.getCaptureSourceReportSnapshot(), null);
  }
});

test("inactive native capture clears the previous session without creating a ghost share", async () => {
  const { context, storage, published } = loadNativeShareRecovery();
  context.tauriInvoke = async () => null;
  await context.recoverNativeScreenShare(context.room);
  assert.equal(context.screenEnabled, false);
  assert.equal(storage.size, 0);
  assert.equal(published.length, 0);
});

test("superseded stop-listener registration disposes its pending listener", async () => {
  const { context } = loadNativeShareRecovery();
  let release;
  const registered = new Promise(resolve => { release = resolve; });
  let disposed = 0;
  context.tauriListen = async () => { await registered; return () => { disposed++; }; };
  const registering = context._startNativeCaptureStopListeners(context._nativeShareRecoveryGeneration);
  context._nativeShareRecoveryGeneration++;
  release();
  await registering;
  assert.equal(disposed, 1);
  assert.equal(context._nativeCaptureStopUnlisten, null);
});

test("canceling source selection during Restart Share leaves the stopped share off", async () => {
  const { context } = loadNativeShareRecovery();
  context.micEnabled = false;
  context.togglePg13Button = null;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'media-controls.js'), 'utf8'), context);
  context.window._echoNativeShareNeedsRestart = true;
  context.window._echoNativeCaptureActive = true;
  context.screenEnabled = true;
  context.screenBtn = {};
  context.switchingRoom = false;
  context.ensureParticipantCard = () => ({});
  context.showCapturePicker = async () => null;
  context.setStatus = message => assert.fail(message);
  await context.toggleScreen();
  assert.equal(context.screenEnabled, false);
  assert.equal(context.window._echoNativeShareNeedsRestart, false);
  assert.equal(context.window._echoNativeCaptureActive, false);
  assert.equal(context.screenBtn.disabled, false);
});

test("stopping while reload recovery lists sources cannot restart audio or resurrect the share", async () => {
  const { context, published, storage } = loadNativeShareRecovery();
  const invoke = context.tauriInvoke;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let listing;
  const entered = new Promise(resolve => { listing = resolve; });
  context.tauriInvoke = async (command, args) => {
    if (command === "list_screen_sources") { listing(); await gate; }
    return invoke(command, args);
  };
  const recovering = context.recoverNativeScreenShare(context.room);
  await entered;
  await context._finalizeNativeCaptureStop(null);
  release();
  await recovering;
  assert.equal(context.screenEnabled, false);
  assert.equal(context.window._echoNativeCaptureActive, false);
  assert.equal(storage.size, 0);
  assert.equal(published.length, 0);
});

test("an audio start cannot publish into a room joined while native IPC was pending", async () => {
  const { context, published } = loadNativeShareRecovery();
  const invoke = context.tauriInvoke;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  context.tauriInvoke = async (command, args) => {
    if (command === "start_audio_capture") { started(); await gate; }
    return invoke(command, args);
  };
  const starting = context.startNativeAudioCapture(5678);
  await entered;
  context.room = { localParticipant: { publishTrack() { assert.fail("published into the new room"); } } };
  release();
  await assert.rejects(starting, { code: "ECHO_NATIVE_AUDIO_CANCELLED" });
  assert.equal(published.length, 0);
  assert.equal(context._nativeAudioActive, false);
});

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

test("monitor routes request attested Echo-excluding audio while process-only routes remain available", () => {
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
    request.toast,
    "System audio streaming (Echo voice excluded)"
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

test("Battlefield 6 executable variants request attested Echo-excluding audio", () => {
  const { context } = loadScreenShareNative();
  const sources = [
    { sourceType: "game", pid: 601, title: "Loading", exe_name: "BF6.exe" },
    { sourceType: "game", pid: 602, title: "Loading", exeName: "C:\\Games\\Battlefield6.EXE" },
  ];

  for (const source of sources) {
    const request = context.nativeAudioCaptureRequestForSource(source);
    assert.equal(request.mode, "system-exclude-echo");
    assert.equal(request.pid, 0);
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
    assert.equal(request.mode, "system-exclude-echo", title);
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

test("raw system audio is rejected before native capture or LiveKit publication", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];

  context.hasTauriIPC = () => true;
  context.room.localParticipant.publishTrack = async (track, options) => {
    published.push({ track, options });
  };

  await assert.rejects(
    context.startNativeAudioCapture(0, { system: true }),
    /Echo voice isolation could not be verified/
  );

  assert.equal(
    calls.some((call) => call.command === "start_attested_system_audio_capture_excluding_echo"),
    false
  );
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

test("attested Echo-excluding system audio publishes only after exact native proof", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];
  const order = [];

  context.hasTauriIPC = () => true;
  installNativeAudioRuntime(context, published);
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "start_attested_system_audio_capture_excluding_echo") {
      order.push("attestation");
      return {
        isolationMode: "webview2-process-tree",
        excludedPid: 4242,
        excludedProcess: "msedgewebview2.exe",
        activationStarted: true,
      };
    }
    return null;
  };
  context.room.localParticipant.publishTrack = async (track, options) => {
    order.push("publish");
    published.push({ track, options });
  };

  await context.startNativeAudioCapture(0, { systemExcludeEcho: true });

  assert.deepEqual(order, ["attestation", "publish"]);
  assert.equal(
    calls.filter((call) => call.command === "start_attested_system_audio_capture_excluding_echo").length,
    1
  );
  assert.equal(
    calls.some((call) => call.command === "start_system_audio_capture_excluding_echo"),
    false
  );
  assert.equal(published.length, 1);
  assert.equal(published[0].options.name, "echo-screen-audio-system-exclude");
});

test("Stop during deferred isolation attestation invalidates the start and publishes nothing", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];
  const lifecycle = installNativeAudioRuntime(context, published);
  let resolveAttestation;
  let markAttestationStarted;
  const attestationStarted = new Promise((resolve) => { markAttestationStarted = resolve; });
  const deferredAttestation = new Promise((resolve) => { resolveAttestation = resolve; });

  context.hasTauriIPC = () => true;
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "start_attested_system_audio_capture_excluding_echo") {
      markAttestationStarted();
      return deferredAttestation;
    }
    return null;
  };

  const pendingStart = context.startNativeAudioCapture(0, { systemExcludeEcho: true });
  await attestationStarted;
  const pendingStop = context.stopNativeAudioCapture();
  resolveAttestation({
    isolationMode: "webview2-process-tree",
    excludedPid: 4242,
    excludedProcess: "msedgewebview2.exe",
    activationStarted: true,
  });
  await pendingStop;

  await assert.rejects(
    pendingStart,
    (error) => error && error.code === "ECHO_NATIVE_AUDIO_CANCELLED"
  );
  assert.equal(published.length, 0);
  assert.equal(calls.filter((call) => call.command === "stop_audio_capture").length, 2);
  assert.equal(lifecycle.contextClosed, 1);
  assert.equal(lifecycle.workletDisconnected, 1);
  assert.equal(lifecycle.unlistened, 4);
  assert.equal(context._nativeAudioActive, false);
  assert.equal(context._nativeAudioOperation, null);
});

test("a replacement start owns Rust and a delayed older start cannot publish or stop it", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];
  const ipcOrder = [];
  let nativeOwner = null;
  installNativeAudioRuntime(context, published);
  let resolveOldAttestation;
  let markOldAttestationStarted;
  const oldAttestationStarted = new Promise((resolve) => { markOldAttestationStarted = resolve; });
  const oldAttestation = new Promise((resolve) => { resolveOldAttestation = resolve; });

  context.hasTauriIPC = () => true;
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "start_attested_system_audio_capture_excluding_echo") {
      ipcOrder.push("A-start");
      markOldAttestationStarted();
      return oldAttestation.then((attestation) => {
        ipcOrder.push("A-settled");
        nativeOwner = "A";
        return attestation;
      });
    }
    if (command === "stop_audio_capture") {
      ipcOrder.push("stop");
      nativeOwner = null;
    }
    if (command === "start_audio_capture") {
      ipcOrder.push("B-start");
      nativeOwner = "B";
    }
    return null;
  };

  const oldStart = context.startNativeAudioCapture(0, { systemExcludeEcho: true });
  await oldAttestationStarted;
  const pendingStop = context.stopNativeAudioCapture();
  const replacementStart = context.startNativeAudioCapture(7777, {});

  resolveOldAttestation({
    isolationMode: "webview2-process-tree",
    excludedPid: 4242,
    excludedProcess: "msedgewebview2.exe",
    activationStarted: true,
  });
  await pendingStop;
  await replacementStart;
  const stopsAfterReplacement = calls.filter((call) => call.command === "stop_audio_capture").length;
  await assert.rejects(
    oldStart,
    (error) => error && error.code === "ECHO_NATIVE_AUDIO_CANCELLED"
  );

  assert.equal(published.length, 1);
  assert.equal(published[0].options.name, "echo-screen-audio-process");
  const settledIndex = ipcOrder.indexOf("A-settled");
  const stopAIndex = ipcOrder.indexOf("stop", settledIndex + 1);
  const replacementIndex = ipcOrder.indexOf("B-start");
  assert.ok(settledIndex >= 0);
  assert.ok(stopAIndex > settledIndex);
  assert.ok(replacementIndex > stopAIndex);
  assert.equal(nativeOwner, "B");
  assert.equal(
    calls.filter((call) => call.command === "stop_audio_capture").length,
    stopsAfterReplacement
  );
  assert.equal(context._nativeAudioActive, true);
  assert.equal(context._nativeAudioOperation.generation, context._nativeAudioGeneration);
});

test("missing or malformed isolation attestation stops capture, cleans JS state, and fails closed", async () => {
  const invalidAttestations = [
    undefined,
    null,
    {},
    {
      isolationMode: "echo-process-tree",
      excludedPid: 4242,
      excludedProcess: "msedgewebview2.exe",
      activationStarted: true,
    },
    {
      isolationMode: "webview2-process-tree",
      excludedPid: 0,
      excludedProcess: "msedgewebview2.exe",
      activationStarted: true,
    },
    {
      isolationMode: "webview2-process-tree",
      excludedPid: "4242",
      excludedProcess: "msedgewebview2.exe",
      activationStarted: true,
    },
    {
      isolationMode: "webview2-process-tree",
      excludedPid: 4242.5,
      excludedProcess: "msedgewebview2.exe",
      activationStarted: true,
    },
    {
      isolationMode: "webview2-process-tree",
      excludedPid: 4242,
      excludedProcess: "echo-core-client.exe",
      activationStarted: true,
    },
    {
      isolationMode: "webview2-process-tree",
      excludedPid: 4242,
      excludedProcess: "msedgewebview2.exe",
      activationStarted: false,
    },
  ];

  for (const attestation of invalidAttestations) {
    const { context, calls } = loadScreenShareNative();
    const published = [];
    const lifecycle = installNativeAudioRuntime(context, published);
    context.hasTauriIPC = () => true;
    context.tauriInvoke = async (command, args) => {
      calls.push({ command, args });
      if (command === "start_attested_system_audio_capture_excluding_echo") return attestation;
      return null;
    };

    await assert.rejects(
      context.startNativeAudioCapture(0, { systemExcludeEcho: true }),
      /Echo voice isolation could not be verified/
    );

    assert.equal(published.length, 0, JSON.stringify(attestation));
    assert.equal(
      calls.filter((call) => call.command === "stop_audio_capture").length,
      2,
      JSON.stringify(attestation)
    );
    assert.equal(lifecycle.contextClosed, 1, JSON.stringify(attestation));
    assert.equal(lifecycle.workletDisconnected, 1, JSON.stringify(attestation));
    assert.equal(lifecycle.unlistened, 4, JSON.stringify(attestation));
    assert.equal(context._nativeAudioCtx, null, JSON.stringify(attestation));
    assert.equal(context._nativeAudioWorklet, null, JSON.stringify(attestation));
    assert.equal(context._nativeAudioDest, null, JSON.stringify(attestation));
    assert.equal(context._nativeAudioUnlisten, null, JSON.stringify(attestation));
  }
});

test("missing attested isolation IPC on an old client cleans partial state and returns the update warning", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];
  const lifecycle = installNativeAudioRuntime(context, published);
  context.hasTauriIPC = () => true;
  context.isTauriCommandMissingError = (error, command) =>
    command === "start_attested_system_audio_capture_excluding_echo" &&
    String(error).includes("unknown IPC command");
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "start_attested_system_audio_capture_excluding_echo") {
      throw new Error("unknown IPC command");
    }
    return null;
  };

  await assert.rejects(
    context.startNativeAudioCapture(0, { systemExcludeEcho: true }),
    /update the Echo Windows app so Echo voice isolation can be verified/
  );

  assert.equal(published.length, 0);
  assert.equal(calls.filter((call) => call.command === "stop_audio_capture").length, 2);
  assert.equal(calls.some((call) => call.command === "start_system_audio_capture_excluding_echo"), false);
  assert.equal(lifecycle.contextClosed, 1);
  assert.equal(lifecycle.workletDisconnected, 1);
  assert.equal(lifecycle.unlistened, 4);
});

test("current attested isolation failures preserve the exact native diagnostic after cleanup", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];
  const lifecycle = installNativeAudioRuntime(context, published);
  const nativeFailure = new Error("WebView2 playback process validation failed");
  context.hasTauriIPC = () => true;
  context.isTauriCommandMissingError = () => false;
  context.tauriInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "start_attested_system_audio_capture_excluding_echo") {
      throw nativeFailure;
    }
    return null;
  };

  await assert.rejects(
    context.startNativeAudioCapture(0, { systemExcludeEcho: true }),
    (error) => error === nativeFailure
  );

  assert.equal(published.length, 0);
  assert.equal(calls.filter((call) => call.command === "stop_audio_capture").length, 2);
  assert.equal(lifecycle.contextClosed, 1);
  assert.equal(lifecycle.workletDisconnected, 1);
  assert.equal(lifecycle.unlistened, 4);
  assert.equal(context._nativeAudioOperation, null);
  assert.equal(context._nativeAudioTrack, null);
});

test("process-only native audio still captures the selected PID and publishes its fixed route", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];

  context.hasTauriIPC = () => true;
  installNativeAudioRuntime(context, published);

  await context.startNativeAudioCapture(5678, {});

  const starts = calls.filter((call) => call.command === "start_audio_capture");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].args.pid, 5678);
  assert.equal(calls.some((call) => call.command === "start_system_audio_capture"), false);
  assert.equal(calls.some((call) => call.command === "start_attested_system_audio_capture_excluding_echo"), false);
  assert.equal(calls.some((call) => call.command === "start_system_audio_capture_excluding_echo"), false);
  assert.equal(published.length, 1);
  assert.equal(published[0].options.name, "echo-screen-audio-process");
});

test("LiveKit publish rejection stops Rust and cleans every partially-created audio resource", async () => {
  const { context, calls } = loadScreenShareNative();
  const published = [];
  const lifecycle = installNativeAudioRuntime(context, published);
  let unpublishCalls = 0;
  context.hasTauriIPC = () => true;
  context.room.localParticipant.publishTrack = async () => {
    throw new Error("publish rejected");
  };
  context.room.localParticipant.unpublishTrack = async () => {
    unpublishCalls += 1;
  };

  await assert.rejects(
    context.startNativeAudioCapture(5678, {}),
    /publish rejected/
  );

  assert.equal(published.length, 0);
  assert.equal(calls.filter((call) => call.command === "start_audio_capture").length, 1);
  assert.equal(calls.filter((call) => call.command === "stop_audio_capture").length, 2);
  assert.ok(unpublishCalls >= 1);
  assert.equal(lifecycle.trackStopped, 1);
  assert.equal(lifecycle.contextClosed, 1);
  assert.equal(lifecycle.workletDisconnected, 1);
  assert.equal(lifecycle.unlistened, 4);
  assert.equal(context._nativeAudioActive, false);
  assert.equal(context._nativeAudioOperation, null);
  assert.equal(context._nativeAudioTrack, null);
  assert.equal(context._nativeAudioCtx, null);
  assert.equal(context._nativeAudioWorklet, null);
  assert.equal(context._nativeAudioDest, null);
  assert.equal(context._nativeAudioUnlisten, null);
});

test("Battlefield 6 starts native video and requests only the attested Echo-excluding route", async () => {
  const { context, calls } = loadScreenShareNative();
  const audioInvocations = [];
  const toasts = [];
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
  context.showToast = (message) => toasts.push(message);
  context._startQualityWarnListener = () => {};

  await context.startScreenShareManual();
  await Promise.resolve();

  assert.equal(audioInvocations.length, 1);
  assert.equal(audioInvocations[0].pid, 0);
  assert.equal(audioInvocations[0].options.system, false);
  assert.equal(audioInvocations[0].options.systemExcludeEcho, true);
  assert.equal(calls.some((call) => call.command === "start_screen_share"), true);
  assert.equal(
    toasts.includes("System audio streaming (Echo voice excluded)"),
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

test("End Sharing stops both native routes after viewer flags were lost on reload", async () => {
  const { context, calls, fetches } = loadScreenShareNative();
  await context.stopScreenShareManual();
  assert.deepEqual(calls.filter(call => call.command.startsWith('stop_')).map(call => call.command),
    ['stop_screen_share', 'stop_desktop_capture']);
  assert.equal(fetches.length, 1);
  assert.equal(context.screenEnabled, false);
});

test("failed native stop still attempts the other route and companion removal, and keeps retry available", async () => {
  const { context, calls, fetches } = loadScreenShareNative();
  context.window._echoNativeCaptureActive = true;
  context.window._echoNativeCaptureMode = 'wgc';
  context.screenEnabled = true;
  context.tauriInvoke = async command => {
    calls.push({ command });
    if (command === 'stop_screen_share') throw new Error('native shutdown timed out');
  };
  await assert.rejects(context.stopScreenShareManual(), /could not be fully stopped/);
  assert.equal(calls.some(call => call.command === 'stop_desktop_capture'), true);
  assert.equal(fetches.length, 1);
  assert.equal(context.screenEnabled, true);
  assert.equal(context.window._echoNativeCaptureActive, true);
  context.tauriInvoke = async () => {};
  await context.stopScreenShareManual();
  assert.equal(context.screenEnabled, false);
});

test("concurrent End Sharing requests wait for the same completed native shutdown", async () => {
  const { context, calls } = loadScreenShareNative();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  context.screenEnabled = true;
  context.tauriInvoke = async command => { calls.push({ command }); await pending; };
  const first = context.stopScreenShareManual();
  const second = context.stopScreenShareManual();
  assert.equal(first, second);
  let completed = false;
  first.then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(context.screenEnabled, true);
  release();
  await first;
  assert.equal(context.screenEnabled, false);
  assert.equal(calls.length, 2);
});

test("End Sharing cancels a pending native start without resurrecting video or audio", async () => {
  const { context, calls } = loadScreenShareNative();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const starting = new Promise(resolve => { entered = resolve; });
  context.tauriInvoke = async command => {
    calls.push({ command });
    if (command === 'get_os_build_number') return 26100;
    if (command === 'start_screen_share') { entered(); await gate; }
  };
  let audioStarts = 0;
  context.startNativeAudioCapture = async () => { audioStarts++; };
  const share = context.startScreenShareManual();
  await starting;
  const stop = context.stopScreenShareManual();
  release();
  assert.equal(await share, false);
  await stop;
  assert.equal(context.screenEnabled, false);
  assert.equal(context.window._echoNativeCaptureActive, false);
  assert.equal(audioStarts, 0);
  assert.ok(calls.findIndex(call => call.command === 'stop_screen_share') >
    calls.findIndex(call => call.command === 'start_screen_share'));
});

test("ending a share while the picker is open prevents a later selection from starting capture", async () => {
  const { context, calls } = loadScreenShareNative();
  let choose;
  context.showCapturePicker = () => new Promise(resolve => { choose = resolve; });
  const start = context.startScreenShareManual();
  await context.stopScreenShareManual();
  choose({ sourceType: 'game', id: 42 });
  assert.equal(await start, false);
  assert.equal(calls.some(call => call.command.startsWith('start_')), false);
});

test("disconnect during native startup revokes capture for the previous room", async () => {
  const { context, calls } = loadScreenShareNative();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const starting = new Promise(resolve => { entered = resolve; });
  context.tauriInvoke = async command => {
    calls.push({ command });
    if (command === 'get_os_build_number') return 26100;
    if (command === 'start_screen_share') { entered(); await gate; }
  };
  const share = context.startScreenShareManual();
  await starting;
  context.room = null;
  release();
  assert.equal(await share, false);
  assert.equal(context.screenEnabled, false);
  assert.equal(calls.some(call => call.command === 'stop_screen_share'), true);
});

test("recovery superseding a pending native start rolls back capture before returning cancelled", async () => {
  for (const failStop of [false, true]) {
    const { context, calls } = loadScreenShareNative();
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const starting = new Promise(resolve => { entered = resolve; });
    context.tauriInvoke = async command => {
      calls.push({ command });
      if (command === 'get_os_build_number') return 26100;
      if (command === 'start_screen_share') { entered(); await gate; }
      if (command === 'get_capture_health') return { capture_active: false };
      if (command === 'stop_screen_share' && failStop) throw new Error('IPC failure');
    };
    const share = context.startScreenShareManual();
    await starting;
    await context.recoverNativeScreenShare(context.room);
    release();
    if (failStop) {
      await assert.rejects(share, /Canceled screen capture could not be stopped/);
      assert.equal(context.screenEnabled, true);
      assert.equal(context.window._echoNativeCaptureActive, true);
    } else {
      assert.equal(await share, false);
      assert.equal(context.screenEnabled, false);
    }
    assert.equal(calls.some(call => call.command === 'stop_screen_share'), true);
  }
});

test("native recovery cannot restart audio while End Sharing is awaiting IPC", async () => {
  const { context, published } = loadNativeShareRecovery();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const invoke = context.tauriInvoke;
  context.tauriInvoke = async (command, args) => {
    if (command.startsWith('stop_')) await gate;
    return invoke(command, args);
  };
  const stop = context.stopScreenShareManual();
  await context.recoverNativeScreenShare(context.room);
  assert.equal(published.length, 0);
  release();
  await stop;
  assert.equal(context.screenEnabled, false);
});

test("browser source tracks stop immediately even when unpublish fails and audio cleanup is pending", async () => {
  const { context } = loadScreenShareNative();
  context.window.__ECHO_NATIVE__ = false;
  const stopped = [];
  context._screenShareVideoTrack = { mediaStreamTrack: { stop() { stopped.push('video'); } } };
  context._screenShareAudioTrack = { mediaStreamTrack: { stop() { stopped.push('audio'); } } };
  const unpublished = [];
  context.room.localParticipant.unpublishTrack = async track => {
    unpublished.push(track);
    throw new Error('signaling unavailable');
  };
  let release;
  context.stopNativeAudioCapture = () => new Promise(resolve => { release = resolve; });
  const stop = context.stopScreenShareManual();
  assert.deepEqual(stopped, ['video', 'audio']);
  release();
  await assert.rejects(stop, /could not be fully stopped/);
  assert.equal(unpublished.length, 2);
  assert.equal(context.screenEnabled, true);
  assert.ok(context._screenShareVideoTrack);
  assert.ok(context._screenShareAudioTrack);
});

test("native audio IPC failure is surfaced after stopping the published track and closing its context", async () => {
  const { context } = loadScreenShareNative();
  const published = [], lifecycle = [];
  installNativeAudioRuntime(context, published, lifecycle);
  context.hasTauriIPC = () => true;
  context.tauriInvoke = async () => {};
  await context.startNativeAudioCapture(5678);
  const track = published[0].track;
  let stopped = false;
  track.mediaStreamTrack.stop = () => { stopped = true; };
  context.tauriInvoke = async command => {
    if (command === 'stop_audio_capture') throw new Error('audio stop IPC failed');
  };
  await assert.rejects(context.stopScreenShareManual(), /could not be fully stopped/);
  assert.equal(stopped, true);
  assert.equal(context._nativeAudioCtx, null);
  assert.equal(context.screenEnabled, true);
});

test("browser picker completion after End Sharing stops the acquired source without publishing", async () => {
  const { context } = loadScreenShareNative();
  context.window.__ECHO_NATIVE__ = false;
  let choose, stopped = 0;
  context.navigator = { mediaDevices: { getDisplayMedia: () => new Promise(resolve => { choose = resolve; }) } };
  const share = context.startScreenShareManual();
  await context.stopScreenShareManual();
  choose({ getTracks: () => [{ stop() { stopped++; } }] });
  assert.equal(await share, false);
  assert.equal(stopped, 1);
});

function installBrowserVideo(context, sender = null) {
  const track = {
    readyState: 'live',
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
    addEventListener() {},
    stop() { this.readyState = 'ended'; },
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  context.window.__ECHO_NATIVE__ = false;
  context.navigator = { platform: 'Win32', mediaDevices: { getDisplayMedia: async () => stream } };
  context.prewarmedRooms = new Map();
  context.getScreenSharePublishOptions = () => ({});
  context.getLiveKitClient = () => ({
    Track: { Source: { ScreenShare: 'screen_share' } },
    LocalVideoTrack: class {
      constructor(mediaStreamTrack) { this.mediaStreamTrack = mediaStreamTrack; this.sender = sender; }
    },
  });
  context.room.localParticipant.unpublishTrack = async () => {};
  return { track, stream };
}

test("overlapping browser start controls cannot acquire an untracked second capture", async () => {
  const { context } = loadScreenShareNative();
  const { track } = installBrowserVideo(context);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const publishing = new Promise(resolve => { entered = resolve; });
  let publications = 0;
  context.room.localParticipant.publishTrack = async () => { publications++; entered(); await gate; };
  const first = context.startScreenShareManual();
  await publishing;
  const second = context.startScreenShareManual();
  assert.equal(first, second);
  await context.stopScreenShareManual();
  assert.equal(track.readyState, 'ended');
  assert.equal(context.screenEnabled, false);
  release();
  assert.equal(await first, false);
  assert.equal(publications, 1);
});

test("stopping during browser sender setup cannot resurrect sharing or its stats timer", async () => {
  const { context } = loadScreenShareNative();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const configuring = new Promise(resolve => { entered = resolve; });
  const { track, stream } = installBrowserVideo(context, {
    getParameters: () => ({ encodings: [] }),
    setParameters: async () => { entered(); await gate; },
  });
  context.shouldUseConservativeBrowserScreenShare = () => false;
  context.room.localParticipant.publishTrack = async () => {};
  context.document.createElement = type => type === 'canvas' ? {
    style: {}, getContext: () => ({ drawImage() {} }), captureStream: () => stream, remove() {},
  } : {
    readyState: 0, style: {}, addEventListener() {}, play: async () => {}, pause() {},
  };
  context.MediaStream = class { getTracks() { return [track]; } };
  context.Blob = class {};
  context.URL = { createObjectURL: () => 'blob:test' };
  context.Worker = class { postMessage() {} terminate() {} };
  context.setTimeout = () => 0;
  let timers = 0;
  context.setInterval = () => { timers++; return 1; };
  const share = context.startScreenShareManual();
  await configuring;
  await context.stopScreenShareManual();
  release();
  assert.equal(await share, false);
  assert.equal(track.readyState, 'ended');
  assert.equal(context.screenEnabled, false);
  assert.equal(timers, 0);
});

test("a delayed native stopped event cannot clear an active replacement", async () => {
  const { context } = loadScreenShareNative();
  const listeners = new Map();
  context.tauriListen = async (name, callback) => { listeners.set(name, callback); return () => {}; };
  context.screenEnabled = true;
  context.window._echoNativeCaptureActive = true;
  context.tauriInvoke = async () => ({ capture_active: true });
  await context._startNativeCaptureStopListeners(context._nativeShareRecoveryGeneration);
  await listeners.get('screen-capture-stopped')();
  assert.equal(context.screenEnabled, true);
  assert.equal(context.window._echoNativeCaptureActive, true);
  context.tauriInvoke = async () => ({ capture_active: false });
  await listeners.get('screen-capture-stopped')();
  assert.equal(context.screenEnabled, false);
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
