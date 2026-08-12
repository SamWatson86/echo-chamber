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
  const connectedMediaStalls = [];
  let nextTimerId = 1;
  let currentRoom = options.room || { sid: "source-room" };
  let hidden = options.hidden === true;
  let online = options.online !== false;
  let switching = options.switching === true;
  let mediaStalled = options.mediaStalled !== false;
  let reconnectCalls = 0;
  let validatedMediaStalls = 0;

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
    onConnectedMediaStall(state) {
      connectedMediaStalls.push(state);
      if (typeof options.onConnectedMediaStall === "function") {
        options.onConnectedMediaStall({ controller, state });
      }
    },
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

  function connectedMediaStall(options = {}) {
    return controller.handleConnectedMediaStall({
      room: currentRoom,
      trackSid: options.trackSid || "TR_screen",
      alreadyUsingRelay: options.alreadyUsingRelay === true,
      isStillStalled: typeof options.isStillStalled === "function"
        ? options.isStillStalled
        : () => mediaStalled,
      onValidated: typeof options.onValidated === "function"
        ? options.onValidated
        : () => {
            validatedMediaStalls += 1;
            return true;
          },
      micWasEnabled: options.micWasEnabled === true,
      reconnect(recoveryState) {
        return reconnect({ ...recoveryState, forceRelay: true });
      },
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
    connectedMediaStall,
    connectedMediaStalls,
    controller,
    disconnect,
    fire,
    getCurrentRoom: () => currentRoom,
    getReconnectCalls: () => reconnectCalls,
    getValidatedMediaStalls: () => validatedMediaStalls,
    liveTimers,
    reconnectStates,
    setCurrentRoom,
    setHidden(value) { hidden = value; },
    setMediaStalled(value) { mediaStalled = value; },
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

test("falsy source teardown rejection clears the cached attempt and permits a successful retry", async () => {
  let disconnectCalls = 0;
  const sourceRoom = {
    disconnect() {
      disconnectCalls += 1;
      if (disconnectCalls === 1) return Promise.reject(undefined);
      return Promise.resolve();
    },
  };

  let rejected = false;
  try {
    await disconnectAndroidFirefoxRecoverySource(sourceRoom);
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
  assert.equal(sourceRoom._echoRecoveryDisconnectPromise, null);
  assert.equal(sourceRoom._echoRecoveryDisconnectComplete, undefined);

  assert.equal(await disconnectAndroidFirefoxRecoverySource(sourceRoom), true);
  assert.equal(disconnectCalls, 2);
  assert.equal(sourceRoom._echoRecoveryDisconnectComplete, true);
});

test("never-settling source teardown releases once at its deadline and remains single-flight", async () => {
  const timers = [];
  let disconnectCalls = 0;
  const sourceRoom = {
    disconnect(stopTracks) {
      disconnectCalls += 1;
      assert.equal(stopTracks, true);
      return new Promise(() => {});
    },
  };
  const options = {
    timeoutMs: 1500,
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelSchedule(timer) { timer.cancelled = true; },
  };

  const first = disconnectAndroidFirefoxRecoverySource(sourceRoom, options);
  const concurrent = disconnectAndroidFirefoxRecoverySource(sourceRoom, options);
  await Promise.resolve();

  assert.equal(disconnectCalls, 1, "concurrent callers must share the wedged teardown");
  assert.equal(timers.length, 1, "the shared teardown must own one deadline");
  assert.equal(timers[0].delay, 1500);
  timers[0].callback();

  assert.deepEqual(await Promise.all([first, concurrent]), [true, true]);
  assert.equal(sourceRoom._echoRecoveryDisconnectReleased, true);
  assert.equal(sourceRoom._echoRecoveryDisconnectTimedOut, true);
  assert.equal(sourceRoom._echoRecoveryDisconnectComplete, undefined);
  assert.equal(await disconnectAndroidFirefoxRecoverySource(sourceRoom, options), false);
  assert.equal(disconnectCalls, 1, "released teardown must not start again");
});

test("controller cannot overlap fresh connects while a wedged teardown waits for its deadline", async () => {
  const teardownTimers = [];
  let disconnectCalls = 0;
  let replacementStarts = 0;
  const teardownOptions = {
    timeoutMs: 1500,
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      teardownTimers.push(timer);
      return timer;
    },
    cancelSchedule(timer) { timer.cancelled = true; },
  };
  const harness = createHarness({
    reconnect({ currentRoom, setCurrentRoom }) {
      replacementStarts += 1;
      currentRoom.disconnect = function(stopTracks) {
        disconnectCalls += 1;
        assert.equal(stopTracks, true);
        return new Promise(() => {});
      };
      return disconnectAndroidFirefoxRecoverySource(currentRoom, teardownOptions)
        .then(function() {
          setCurrentRoom({ sid: "replacement-room" });
        });
    },
  });

  assert.equal(harness.arm(true), true);
  await harness.fire(harness.liveTimers()[0]);
  const attempt = harness.fire(harness.liveTimers()[0]);
  await Promise.resolve();

  assert.equal(replacementStarts, 1);
  assert.equal(disconnectCalls, 1);
  assert.equal(harness.arm(false), false, "duplicate reconnect events must not start another fresh connect");
  assert.equal(harness.controller.snapshot().inFlight, true);
  assert.equal(teardownTimers.length, 1);
  assert.equal(teardownTimers[0].delay, 1500);

  teardownTimers[0].callback();
  await attempt;
  assert.equal(replacementStarts, 1);
  assert.equal(disconnectCalls, 1);
  assert.equal(harness.getCurrentRoom().sid, "replacement-room");
  assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false });
});

test("late source teardown completion cannot restart or overwrite a released handoff", async () => {
  const timers = [];
  let disconnectCalls = 0;
  let finishDisconnect;
  const sourceRoom = {
    disconnect() {
      disconnectCalls += 1;
      return new Promise((resolve) => { finishDisconnect = resolve; });
    },
  };
  const options = {
    timeoutMs: 1500,
    schedule(callback) {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelSchedule(timer) { timer.cancelled = true; },
  };

  const teardown = disconnectAndroidFirefoxRecoverySource(sourceRoom, options);
  await Promise.resolve();
  timers[0].callback();
  assert.equal(await teardown, true);
  assert.equal(sourceRoom._echoRecoveryDisconnectReleased, true);

  finishDisconnect();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sourceRoom._echoRecoveryDisconnectComplete, true);
  assert.equal(await disconnectAndroidFirefoxRecoverySource(sourceRoom, options), false);
  assert.equal(disconnectCalls, 1);
});

test("connected media stall starts one relay fallback and preserves microphone intent", async () => {
  const harness = createHarness();
  const sourceRoom = harness.getCurrentRoom();

  assert.equal(harness.connectedMediaStall({ trackSid: "TR_stalled", micWasEnabled: true }), true);
  assert.equal(harness.connectedMediaStall({ trackSid: "TR_stalled", micWasEnabled: false }), false,
    "duplicate watchdog ticks must coalesce on the same source Room");
  assert.equal(harness.controller.handleConnected({ room: sourceRoom }), false,
    "redundant connected events cannot substitute for media recovery");
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [500]);
  assert.deepEqual(harness.connectedMediaStalls, [],
    "diagnostics must wait for the just-in-time media validation");

  await harness.fire(harness.liveTimers()[0]);
  assert.equal(harness.getValidatedMediaStalls(), 1);
  assert.deepEqual(harness.connectedMediaStalls, [{ room: sourceRoom, trackSid: "TR_stalled" }]);
  assert.equal(harness.getReconnectCalls(), 1);
  assert.deepEqual(harness.reconnectStates, [{
    room: sourceRoom,
    micWasEnabled: true,
    forceRelay: true,
  }]);
  assert.notEqual(harness.getCurrentRoom(), sourceRoom);
  assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false });
});

test("an existing signaling watch rejects a later connected-media recovery claim", async () => {
  const harness = createHarness();
  const sourceRoom = harness.getCurrentRoom();
  assert.equal(harness.arm(true), true);
  const signalingTimer = harness.liveTimers()[0];

  assert.equal(harness.connectedMediaStall({ micWasEnabled: false }), false);
  assert.equal(signalingTimer.cancelled, false);
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [15000]);
  assert.deepEqual(harness.connectedMediaStalls, []);

  await harness.fire(signalingTimer);
  await harness.fire(harness.liveTimers()[0]);
  assert.deepEqual(harness.reconnectStates, [{
    room: sourceRoom,
    micWasEnabled: true,
  }], "the first signaling event retains recovery ownership and mic intent");
});

test("cancelled media validation leaves the same SID eligible for one real relay handoff", async () => {
  const harness = createHarness();
  const sourceRoom = harness.getCurrentRoom();

  assert.equal(harness.connectedMediaStall({ trackSid: "TR_same", micWasEnabled: false }), true);
  const timer = harness.liveTimers()[0];
  harness.setMediaStalled(false);
  await harness.fire(timer);

  assert.equal(harness.getReconnectCalls(), 0);
  assert.equal(harness.getValidatedMediaStalls(), 0,
    "a recovered stream must not consume its relay fallback");
  assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false });

  harness.setMediaStalled(true);
  assert.equal(harness.connectedMediaStall({ trackSid: "TR_same", micWasEnabled: true }), true,
    "the same SID may schedule again with the user's fresh mic intent");
  await harness.fire(harness.liveTimers()[0]);
  assert.equal(harness.getValidatedMediaStalls(), 1);
  assert.equal(harness.getReconnectCalls(), 1,
    "only the validated stall may start the relay Room");
  assert.deepEqual(harness.reconnectStates, [{
    room: sourceRoom,
    micWasEnabled: true,
    forceRelay: true,
  }], "a cancelled attempt cannot cache the old muted intent for the same-SID rearm");
});

test("Room and signal reconnect ordering supersedes an uncommitted media timer", async () => {
  const eventOrders = [
    ["Reconnecting", "SignalReconnecting"],
    ["SignalReconnecting", "Reconnecting"],
  ];

  for (const [firstEvent, duplicateEvent] of eventOrders) {
    const harness = createHarness();
    const sourceRoom = harness.getCurrentRoom();
    assert.equal(harness.connectedMediaStall({ micWasEnabled: true }), true, firstEvent);
    const mediaTimer = harness.liveTimers()[0];

    assert.equal(harness.arm(false), true, firstEvent + " must take ownership");
    assert.equal(mediaTimer.cancelled, true, firstEvent + " must cancel the media timer");
    assert.equal(harness.arm(false), false, duplicateEvent + " must coalesce");
    assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [15000], firstEvent);

    await harness.fire(mediaTimer, true);
    assert.equal(harness.getValidatedMediaStalls(), 0, firstEvent);
    assert.equal(harness.getReconnectCalls(), 0, firstEvent);

    await harness.fire(harness.liveTimers()[0]);
    assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [500], firstEvent);
    await harness.fire(harness.liveTimers()[0]);
    assert.deepEqual(harness.reconnectStates, [{
      room: sourceRoom,
      micWasEnabled: true,
    }], firstEvent + " must preserve the media recovery's first mic intent");
    assert.equal(harness.getReconnectCalls(), 1, firstEvent);
  }
});

test("connected return cancels the reconnect watch that superseded a media timer", async () => {
  const harness = createHarness();
  const sourceRoom = harness.getCurrentRoom();
  assert.equal(harness.connectedMediaStall({ micWasEnabled: true }), true);
  const mediaTimer = harness.liveTimers()[0];
  assert.equal(harness.arm(false), true);
  const reconnectTimer = harness.liveTimers()[0];

  assert.equal(harness.controller.handleConnected({ room: sourceRoom }), true);
  assert.equal(mediaTimer.cancelled, true);
  assert.equal(reconnectTimer.cancelled, true);
  await harness.fire(mediaTimer, true);
  await harness.fire(reconnectTimer, true);

  assert.equal(harness.getValidatedMediaStalls(), 0);
  assert.equal(harness.getReconnectCalls(), 0);
  assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false });
});

test("direct nonterminal disconnect supersedes an uncommitted media timer", async () => {
  const harness = createHarness();
  const sourceRoom = harness.getCurrentRoom();
  assert.equal(harness.connectedMediaStall({ micWasEnabled: true }), true);
  const mediaTimer = harness.liveTimers()[0];

  assert.equal(harness.disconnect(14, false), true);
  assert.equal(mediaTimer.cancelled, true);
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [500]);
  await harness.fire(mediaTimer, true);
  assert.equal(harness.getValidatedMediaStalls(), 0);
  assert.equal(harness.getReconnectCalls(), 0);

  await harness.fire(harness.liveTimers()[0]);
  assert.deepEqual(harness.reconnectStates, [{
    room: sourceRoom,
    micWasEnabled: true,
  }], "direct disconnect must retain the media recovery's first mic intent");
  assert.equal(harness.getReconnectCalls(), 1);
});

test("signaling and direct disconnect cannot supersede committed or in-flight media recovery", async () => {
  let committedSignalAccepted = null;
  let committedDisconnectAccepted = null;
  const committed = createHarness({
    onConnectedMediaStall({ controller, state }) {
      committedSignalAccepted = controller.handleReconnecting({
        room: state.room,
        reconnect: async () => {},
        micWasEnabled: false,
      });
      committedDisconnectAccepted = controller.handleDisconnected({
        room: state.room,
        reason: 14,
        disconnectReasons,
        reconnect: async () => {},
        micWasEnabled: false,
      });
    },
  });
  assert.equal(committed.connectedMediaStall({ micWasEnabled: true }), true);
  await committed.fire(committed.liveTimers()[0]);
  assert.equal(committedSignalAccepted, false,
    "eligibility commit must make the serialized relay handoff authoritative");
  assert.equal(committedDisconnectAccepted, false,
    "a direct disconnect cannot replace an eligibility-committed handoff");
  assert.equal(committed.getReconnectCalls(), 1);

  let releaseAttempt = null;
  const inFlight = createHarness({
    reconnect({ setCurrentRoom }) {
      return new Promise((resolve) => {
        releaseAttempt = () => {
          setCurrentRoom({ sid: "replacement-room" });
          resolve();
        };
      });
    },
  });
  assert.equal(inFlight.connectedMediaStall({ micWasEnabled: true }), true);
  const attempt = inFlight.fire(inFlight.liveTimers()[0]);
  await Promise.resolve();
  assert.equal(inFlight.controller.snapshot().inFlight, true);
  assert.equal(inFlight.arm(false), false,
    "an in-flight relay handoff cannot be replaced by a second recovery owner");
  assert.equal(inFlight.disconnect(14, false), false,
    "direct disconnect cannot replace an in-flight relay handoff");
  assert.deepEqual(inFlight.liveTimers(), []);
  releaseAttempt();
  await attempt;
  assert.equal(inFlight.getReconnectCalls(), 1);
  assert.deepEqual(inFlight.controller.snapshot(), { enabled: true, active: false });
});

test("expected and terminal disconnect still cancel pending media recovery without replacement", async () => {
  const cases = [
    ["expected leave", (harness) => { harness.getCurrentRoom()._echoExpectedDisconnect = true; }, 1],
    ["terminal disconnect", () => {}, 3],
  ];

  for (const [label, prepare, reason] of cases) {
    const harness = createHarness();
    assert.equal(harness.connectedMediaStall({ micWasEnabled: true }), true, label);
    const mediaTimer = harness.liveTimers()[0];
    prepare(harness);
    assert.equal(harness.disconnect(reason, false), false, label);
    assert.equal(mediaTimer.cancelled, true, label);
    assert.deepEqual(harness.liveTimers(), [], label);
    await harness.fire(mediaTimer, true);
    assert.equal(harness.getValidatedMediaStalls(), 0, label);
    assert.equal(harness.getReconnectCalls(), 0, label);
    assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false }, label);
  }
});

test("hidden or offline deferral revalidates recovered media before resuming", async () => {
  for (const condition of ["hidden", "offline"]) {
    const harness = createHarness();
    assert.equal(harness.connectedMediaStall(), true, condition);
    const timer = harness.liveTimers()[0];
    if (condition === "hidden") harness.setHidden(true);
    else harness.setOnline(false);
    await harness.fire(timer);
    assert.equal(harness.getReconnectCalls(), 0, condition);
    assert.equal(harness.getValidatedMediaStalls(), 0, condition);
    assert.equal(harness.controller.snapshot().waiting, true, condition);

    harness.setMediaStalled(false);
    if (condition === "hidden") harness.setHidden(false);
    else harness.setOnline(true);
    assert.equal(harness.controller.resume(), true, condition);
    await harness.fire(harness.liveTimers()[0]);
    assert.equal(harness.getReconnectCalls(), 0, condition);
    assert.equal(harness.getValidatedMediaStalls(), 0, condition);
    assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false }, condition);
  }
});

test("switch, leave, and stale Room invalidate a scheduled connected-media handoff", async () => {
  const cases = [
    ["switch", (harness) => harness.setSwitching(true)],
    ["leave", (harness) => { harness.getCurrentRoom()._echoExpectedDisconnect = true; }],
    ["stale Room", (harness) => harness.setCurrentRoom({ sid: "other-room" })],
  ];

  for (const [label, invalidate] of cases) {
    const harness = createHarness();
    assert.equal(harness.connectedMediaStall(), true, label);
    const timer = harness.liveTimers()[0];
    invalidate(harness);
    await harness.fire(timer);
    assert.equal(harness.getReconnectCalls(), 0, label);
    assert.equal(harness.getValidatedMediaStalls(), 0, label);
    assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false }, label);
  }
});

test("relay-forced Room cannot trigger another connected-media fallback", () => {
  const harness = createHarness();

  assert.equal(harness.connectedMediaStall({ alreadyUsingRelay: true }), false);
  assert.deepEqual(harness.liveTimers(), []);
  assert.deepEqual(harness.connectedMediaStalls, []);
  assert.equal(harness.getReconnectCalls(), 0);
});

test("connected-media fallback honors switch, visibility, and network guards", () => {
  const switching = createHarness({ switching: true });
  assert.equal(switching.connectedMediaStall(), false);
  assert.deepEqual(switching.liveTimers(), []);

  const hidden = createHarness({ hidden: true });
  assert.equal(hidden.connectedMediaStall(), true);
  assert.deepEqual(hidden.controller.snapshot(), {
    enabled: true,
    active: true,
    attemptCount: 0,
    scheduled: false,
    inFlight: false,
    waiting: true,
    exhausted: false,
  });
  hidden.setHidden(false);
  assert.equal(hidden.controller.resume(), true);
  assert.deepEqual(hidden.liveTimers().map((timer) => timer.delay), [500]);

  const offline = createHarness({ online: false });
  assert.equal(offline.connectedMediaStall(), true);
  assert.deepEqual(offline.liveTimers(), []);
  offline.setOnline(true);
  assert.equal(offline.controller.resume(), true);
  assert.deepEqual(offline.liveTimers().map((timer) => timer.delay), [500]);
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
    assert.equal(harness.connectedMediaStall(), false, name);
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
  assert.match(connectSource, /_echoRecoveryDisconnectTimedOut === true[\s\S]*?continuing fresh handoff/);
  assert.match(connectSource, /newRoom\._echoRecoveryDisconnect === true\)[\s\S]*?if \(newRoom === room && typeof stopInboundScreenStatsMonitor/);
  assert.match(connectSource, /reuseAdmin: true,[\s\S]*?preserveMicIntent: true,[\s\S]*?androidFirefoxRecoverySourceRoom: newRoom/);
  assert.match(connectSource, /forceAndroidFirefoxRelay = controlledAndroidFirefoxReplacement &&\s+androidFirefoxForceRelay === true/);
  assert.match(connectSource, /_echoAndroidFirefoxConnectedMediaRelayRecovery = function[\s\S]*?handleConnectedMediaStall\(\{[\s\S]*?alreadyUsingRelay:[\s\S]*?forceRelay: true/);
  assert.match(connectSource, /handleConnectedMediaStall\(\{[\s\S]*?isStillStalled: detail\?\.isStillStalled,[\s\S]*?onValidated: detail\?\.onValidated/);
  assert.match(connectSource, /handleConnectedMediaStall\(\{[\s\S]*?micWasEnabled: desiredMicEnabledForRoomSwitch\(\) === true/);
  assert.match(connectSource, /if \(forceAndroidFirefoxRelay\) \{\s+rtcConfig\.iceTransportPolicy = "relay"/);
  assert.match(connectSource, /androidFirefoxForceRelay: recoveryState\?\.forceRelay === true/);
  assert.match(connectSource, /ignoreAndroidFirefoxStaleRoomEvent\("local track unpublished"\)/);
  assert.match(connectSource, /androidFirefoxRoomDisconnectRecovery\?\.cancel\(room\);[\s\S]*?connectSequence \+= 1;[\s\S]*?room\._echoExpectedDisconnect = true/);
});
