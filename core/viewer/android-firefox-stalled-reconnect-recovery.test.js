const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  createAndroidFirefoxRoomDisconnectRecovery,
  disconnectAndroidFirefoxRecoverySource,
  resolvePostConnectMicrophoneBehavior,
} = require("./room-switch-state.js");

const rnnoiseSource = fs.readFileSync(path.join(__dirname, "rnnoise.js"), "utf8");
const connectSource = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");

function loadRealBrowserPredicate() {
  const context = {
    navigator: { userAgent: "", platform: "" },
    echoGet() { return null; },
    debugLog() {},
  };
  vm.createContext(context);
  vm.runInContext(rnnoiseSource, context, { filename: "rnnoise.js" });
  return context.isAndroidFirefoxBrowser;
}

const isAndroidFirefoxBrowser = loadRealBrowserPredicate();
const androidFirefoxUa =
  "Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0";
const disconnectReasons = {
  1: "CLIENT_INITIATED",
  3: "SERVER_SHUTDOWN",
  14: "CONNECTION_TIMEOUT",
  15: "MEDIA_FAILURE",
};

function createHarness(options = {}) {
  const timers = [];
  const reconnectStates = [];
  const stalled = [];
  let nextTimerId = 1;
  let currentRoom = options.room || { sid: "source-room" };
  let hidden = options.hidden === true;
  let online = options.online !== false;
  let switching = options.switching === true;
  let reconnectCalls = 0;

  const controller = createAndroidFirefoxRoomDisconnectRecovery({
    navigatorObject: { userAgent: options.userAgent || androidFirefoxUa },
    isNativeShell: options.isNativeShell === true,
    isTargetBrowser: isAndroidFirefoxBrowser,
    stalledReconnectTimeoutMs: 15000,
    retryDelaysMs: [500, 2000, 5000],
    getCurrentRoom() { return currentRoom; },
    isSwitching() { return switching; },
    isHidden() { return hidden; },
    isOnline() { return online; },
    schedule(callback, delay) {
      const timer = { id: nextTimerId++, callback, delay, cancelled: false };
      timers.push(timer);
      return timer.id;
    },
    cancelSchedule(timerId) {
      const timer = timers.find((candidate) => candidate.id === timerId);
      if (timer) timer.cancelled = true;
    },
    onStalledReconnect(state) { stalled.push(state); },
  });

  function reconnect(recoveryState) {
    reconnectCalls += 1;
    reconnectStates.push(recoveryState);
    if (typeof options.reconnect === "function") {
      return options.reconnect({
        controller,
        currentRoom,
        reconnectCalls,
        recoveryState,
        setCurrentRoom,
      });
    }
    currentRoom = { sid: "replacement-room-" + reconnectCalls };
  }

  function arm(micWasEnabled = false) {
    return controller.handleReconnecting({
      room: currentRoom,
      reconnect,
      micWasEnabled,
    });
  }

  function disconnect(reason = 14, micWasEnabled = false) {
    return controller.handleDisconnected({
      room: currentRoom,
      reason,
      disconnectReasons,
      reconnect,
      micWasEnabled,
    });
  }

  async function fire(timer, includeCancelled = false) {
    assert.ok(timer, "expected a timer");
    if (!includeCancelled) assert.equal(timer.cancelled, false, "timer must still be live");
    timer.fired = true;
    await timer.callback();
  }

  function liveTimers() {
    return timers.filter((timer) => !timer.cancelled && !timer.fired);
  }

  function setCurrentRoom(room) { currentRoom = room; }

  return {
    arm,
    controller,
    disconnect,
    fire,
    getCurrentRoom: () => currentRoom,
    getReconnectCalls: () => reconnectCalls,
    liveTimers,
    reconnectStates,
    setCurrentRoom,
    setHidden(value) { hidden = value; },
    setOnline(value) { online = value; },
    setSwitching(value) { switching = value; },
    stalled,
    timers,
  };
}

test("stalled reconnect watchdog coalesces SDK events and carries first-event mic intent", async () => {
  const harness = createHarness();

  assert.equal(harness.arm(true), true);
  assert.equal(harness.arm(false), false, "Room and signal reconnect events must share one watchdog");
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [15000]);
  assert.deepEqual(harness.controller.snapshot(), {
    enabled: true,
    active: false,
    watching: true,
    scheduled: true,
    waiting: false,
    stale: false,
  });

  await harness.fire(harness.liveTimers()[0]);
  assert.equal(harness.getReconnectCalls(), 0, "watchdog expiry only queues the bounded fresh attempt");
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [500]);
  assert.equal(harness.stalled.length, 1);

  await harness.fire(harness.liveTimers()[0]);
  assert.equal(harness.getReconnectCalls(), 1);
  assert.equal(harness.reconnectStates[0].micWasEnabled, true);
  assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false });
});

test("current Room success cancels watchdog while stale Room success cannot cancel current generation", async () => {
  const first = createHarness();
  assert.equal(first.arm(), true);
  const cancelledTimer = first.liveTimers()[0];
  assert.equal(first.controller.handleConnected({ room: first.getCurrentRoom() }), true);
  assert.equal(cancelledTimer.cancelled, true);
  await first.fire(cancelledTimer, true);
  assert.equal(first.getReconnectCalls(), 0);

  const raced = createHarness();
  const oldRoom = raced.getCurrentRoom();
  assert.equal(raced.arm(), true);
  const oldGenerationTimer = raced.liveTimers()[0];
  const currentRoom = { sid: "new-current-room" };
  raced.setCurrentRoom(currentRoom);
  assert.equal(raced.controller.handleConnected({ room: oldRoom }), false);
  assert.equal(raced.controller.handleReconnecting({
    room: currentRoom,
    reconnect: async () => {},
    micWasEnabled: false,
  }), true);
  const currentGenerationTimer = raced.liveTimers().find((timer) => timer !== oldGenerationTimer);

  await raced.fire(oldGenerationTimer, true);
  assert.equal(currentGenerationTimer.cancelled, false, "late old generation must not clear current watchdog");
  assert.equal(raced.controller.snapshot().watching, true);
});

test("a later reconnect episode captures the user's new microphone intent", async () => {
  const harness = createHarness();
  const currentRoom = harness.getCurrentRoom();

  assert.equal(harness.arm(true), true);
  assert.equal(harness.controller.handleConnected({ room: currentRoom }), true);
  assert.equal(harness.arm(false), true, "second episode must create a new intent snapshot");

  await harness.fire(harness.liveTimers()[0]);
  await harness.fire(harness.liveTimers()[0]);

  assert.equal(harness.getReconnectCalls(), 1);
  assert.equal(harness.reconnectStates[0].micWasEnabled, false);
});

test("hidden or offline stale reconnect defers without consuming a recovery attempt", async () => {
  const harness = createHarness();
  assert.equal(harness.arm(true), true);
  harness.setHidden(true);
  harness.setOnline(false);

  await harness.fire(harness.liveTimers()[0]);
  assert.equal(harness.getReconnectCalls(), 0);
  assert.equal(harness.controller.snapshot().waiting, true);
  assert.equal(harness.controller.resume(), false);

  harness.setHidden(false);
  assert.equal(harness.controller.resume(), false, "offline still blocks replacement teardown");
  harness.setOnline(true);
  assert.equal(harness.controller.resume(), true);
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [500]);
  assert.equal(harness.controller.snapshot().attemptCount, 0);

  await harness.fire(harness.liveTimers()[0]);
  assert.equal(harness.getReconnectCalls(), 1);
  assert.equal(harness.reconnectStates[0].micWasEnabled, true);
});

test("expected leave, terminal disconnect, switch, and explicit cancel synchronously stop watchdog", async () => {
  const expected = createHarness();
  assert.equal(expected.arm(), true);
  const expectedTimer = expected.liveTimers()[0];
  expected.getCurrentRoom()._echoExpectedDisconnect = true;
  assert.equal(expected.disconnect(1), false);
  assert.equal(expectedTimer.cancelled, true);
  await expected.fire(expectedTimer, true);
  assert.equal(expected.getReconnectCalls(), 0);

  const terminal = createHarness();
  assert.equal(terminal.arm(), true);
  assert.equal(terminal.disconnect(3), false);
  assert.equal(terminal.liveTimers().length, 0);

  const switching = createHarness();
  assert.equal(switching.arm(), true);
  const switchingTimer = switching.liveTimers()[0];
  switching.setSwitching(true);
  await switching.fire(switchingTimer);
  assert.equal(switching.getReconnectCalls(), 0);

  const cancelled = createHarness();
  assert.equal(cancelled.arm(), true);
  const cancelledTimer = cancelled.liveTimers()[0];
  assert.equal(cancelled.controller.cancel({ sid: "not-current" }), false);
  assert.equal(cancelled.controller.cancel(cancelled.getCurrentRoom()), true);
  await cancelled.fire(cancelledTimer, true);
  assert.equal(cancelled.getReconnectCalls(), 0);
});

test("controlled source CLIENT_INITIATED teardown does not cancel serialized retries", async () => {
  const harness = createHarness({
    reconnect({ controller, currentRoom }) {
      currentRoom._echoRecoveryDisconnect = true;
      currentRoom._echoExpectedDisconnect = true;
      assert.equal(controller.handleDisconnected({
        room: currentRoom,
        reason: 1,
        disconnectReasons,
        reconnect() {},
      }), false);
      throw new Error("first fresh candidate failed");
    },
  });

  assert.equal(harness.arm(true), true);
  await harness.fire(harness.liveTimers()[0]);
  await harness.fire(harness.liveTimers()[0]);

  assert.equal(harness.getReconnectCalls(), 1);
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [2000]);
  assert.equal(harness.controller.snapshot().active, true);
});

test("failed source teardown is retried and successful teardown stays single-flight", async () => {
  let disconnectCalls = 0;
  let releaseSecondDisconnect;
  const secondDisconnect = new Promise((resolve) => { releaseSecondDisconnect = resolve; });
  const sourceRoom = {
    disconnect(stopTracks) {
      disconnectCalls += 1;
      assert.equal(stopTracks, true);
      if (disconnectCalls === 1) return Promise.reject(new Error("sendLeave failed"));
      return secondDisconnect;
    },
  };

  await assert.rejects(
    disconnectAndroidFirefoxRecoverySource(sourceRoom),
    /sendLeave failed/
  );
  assert.equal(sourceRoom._echoRecoveryDisconnectPromise, null);
  assert.equal(sourceRoom._echoRecoveryDisconnectComplete, undefined);

  const retryOne = disconnectAndroidFirefoxRecoverySource(sourceRoom);
  const retryTwo = disconnectAndroidFirefoxRecoverySource(sourceRoom);
  assert.equal(disconnectCalls, 2, "concurrent retry callers must share one teardown");
  releaseSecondDisconnect();
  assert.deepEqual(await Promise.all([retryOne, retryTwo]), [true, true]);
  assert.equal(sourceRoom._echoRecoveryDisconnectComplete, true);

  assert.equal(await disconnectAndroidFirefoxRecoverySource(sourceRoom), false);
  assert.equal(disconnectCalls, 2, "completed teardown must never run again");
});

test("real platform gate gives every non-target client zero stalled-reconnect actions", () => {
  const cases = [
    ["Windows Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36", false],
    ["Windows native", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36", true],
    ["Android Firefox native", androidFirefoxUa, true],
    ["macOS Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15", false],
    ["Android Chrome", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/153.0 Mobile Safari/537.36", false],
    ["iOS Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 19_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", false],
  ];

  for (const [name, userAgent, isNativeShell] of cases) {
    const harness = createHarness({ userAgent, isNativeShell });
    assert.equal(harness.controller.isEnabled(), false, name);
    assert.equal(harness.arm(), false, name);
    assert.equal(harness.controller.resume(), false, name);
    assert.equal(harness.liveTimers().length, 0, name);
    assert.equal(harness.getReconnectCalls(), 0, name);
  }
});

test("mic preservation policy remains recovery-only and production wiring tears down before fresh connect", () => {
  assert.deepEqual(resolvePostConnectMicrophoneBehavior({
    reuseAdmin: true,
    preserveMicIntent: true,
    micWasEnabled: false,
  }), { restoreMic: false, preserveMutedMic: true });
  assert.deepEqual(resolvePostConnectMicrophoneBehavior({
    reuseAdmin: true,
    preserveMicIntent: true,
    micWasEnabled: true,
  }), { restoreMic: true, preserveMutedMic: false });

  assert.match(connectSource, /androidFirefoxRoomDisconnectRecoveryEnabled = typeof isAndroidFirefoxBrowser/);
  assert.match(connectSource, /if \(state === "reconnecting"\)[\s\S]*?else if \(androidFirefoxRoomDisconnectRecoveryEnabled && state === "signalReconnecting"\)/);
  assert.match(connectSource, /RoomEvent\.SignalReconnecting[\s\S]*?watchAndroidFirefoxRoomReconnect\(\)/);
  assert.match(connectSource, /RoomEvent\.SignalReconnected[\s\S]*?handleConnected\(\{ room: newRoom \}\)/);
  assert.match(connectSource, /handleConnected\(\{ room: newRoom \}\);\s+resetAndroidFirefoxRecoveryMicIntent\(\)/);
  assert.match(connectSource, /handleReconnecting\(\{[\s\S]*?micWasEnabled: captureAndroidFirefoxRecoveryMicIntent\(\)/);
  assert.match(connectSource, /disconnectAndroidFirefoxRecoverySource[\s\S]*?await disconnectRecoverySource\(androidFirefoxRecoverySourceRoom\)/);
  assert.match(connectSource, /await disconnectRecoverySource\(androidFirefoxRecoverySourceRoom\)[\s\S]*?await newRoom\.connect/);
  assert.match(connectSource, /reuseAdmin: true,[\s\S]*?preserveMicIntent: true,[\s\S]*?androidFirefoxRecoverySourceRoom: newRoom/);
  assert.match(connectSource, /ignoreAndroidFirefoxStaleRoomEvent\("local track unpublished"\)/);
  assert.match(connectSource, /androidFirefoxRoomDisconnectRecovery\?\.cancel\(room\);[\s\S]*?connectSequence \+= 1;[\s\S]*?room\._echoExpectedDisconnect = true/);
});
