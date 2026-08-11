const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  createAndroidFirefoxCandidateReleaseError,
  createAndroidFirefoxRoomDisconnectRecovery,
  disconnectAndroidFirefoxRejectedRelayCandidate,
  isAndroidFirefoxCandidateReleaseError,
  resolvePostConnectMicrophoneBehavior,
  verifyAndroidFirefoxRelayCandidateRoom,
} = require("./room-switch-state.js");

const rnnoiseSource = fs.readFileSync(path.join(__dirname, "rnnoise.js"), "utf8");
const connectSource = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");

const disconnectReasons = {
  0: "UNKNOWN_REASON",
  1: "CLIENT_INITIATED",
  2: "DUPLICATE_IDENTITY",
  3: "SERVER_SHUTDOWN",
  4: "PARTICIPANT_REMOVED",
  5: "ROOM_DELETED",
  6: "STATE_MISMATCH",
  7: "JOIN_FAILURE",
  8: "MIGRATION",
  9: "SIGNAL_CLOSE",
  10: "ROOM_CLOSED",
  11: "USER_UNAVAILABLE",
  12: "USER_REJECTED",
  13: "SIP_TRUNK_FAILURE",
  14: "CONNECTION_TIMEOUT",
  15: "MEDIA_FAILURE",
};

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

function createHarness(options = {}) {
  const timers = [];
  const attempts = [];
  const attemptFailures = [];
  let nextTimerId = 1;
  let currentRoom = options.room || { sid: "old-room" };
  let hidden = options.hidden === true;
  let online = options.online !== false;
  let switching = options.switching === true;
  let reconnectCalls = 0;

  const controller = createAndroidFirefoxRoomDisconnectRecovery({
    navigatorObject: { userAgent: options.userAgent || "" },
    isNativeShell: options.isNativeShell === true,
    isTargetBrowser: isAndroidFirefoxBrowser,
    retryDelaysMs: options.retryDelaysMs || [500, 2000, 5000],
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
    onAttempt(state) { attempts.push(state.attempt); },
    onAttemptFailed(state) { attemptFailures.push(state); },
  });

  async function fireNextTimer() {
    const timer = timers.find((candidate) => !candidate.cancelled);
    assert.ok(timer, "expected a pending timer");
    timers.splice(timers.indexOf(timer), 1);
    await timer.callback();
    return timer;
  }

  function liveTimers() {
    return timers.filter((timer) => !timer.cancelled);
  }

  function disconnect(reason = 14, reconnectBehavior) {
    return controller.handleDisconnected({
      room: currentRoom,
      reason,
      disconnectReasons,
      reconnect: async function() {
        reconnectCalls += 1;
        if (reconnectBehavior) return reconnectBehavior({ reconnectCalls, setCurrentRoom });
        currentRoom = { sid: "replacement-room-" + reconnectCalls };
      },
    });
  }

  function setCurrentRoom(nextRoom) { currentRoom = nextRoom; }

  return {
    attempts,
    attemptFailures,
    controller,
    disconnect,
    fireNextTimer,
    getCurrentRoom: () => currentRoom,
    getReconnectCalls: () => reconnectCalls,
    liveTimers,
    setCurrentRoom,
    setHidden(value) { hidden = value; },
    setOnline(value) { online = value; },
    setSwitching(value) { switching = value; },
  };
}

const androidFirefoxUa =
  "Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0";

test("real browser predicate gives every PC, Mac, native, Chrome, and iOS client zero recovery actions", () => {
  const cases = [
    {
      name: "Windows Chrome",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
    },
    {
      name: "Windows Tauri",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
      isNativeShell: true,
    },
    {
      name: "Android Firefox native shell",
      userAgent: androidFirefoxUa,
      isNativeShell: true,
    },
    {
      name: "macOS Safari",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15",
    },
    {
      name: "macOS Chrome",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
    },
    {
      name: "Android Chrome",
      userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 Chrome/153.0.0.0 Mobile Safari/537.36",
    },
    {
      name: "iOS Safari",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_6 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1",
    },
    {
      name: "iOS Firefox",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_6 like Mac OS X) AppleWebKit/605.1.15 FxiOS/153.0 Mobile/15E148 Safari/605.1.15",
    },
  ];

  for (const testCase of cases) {
    const harness = createHarness(testCase);
    assert.equal(harness.controller.isEnabled(), false, testCase.name);
    assert.equal(harness.disconnect(), false, testCase.name);
    assert.equal(harness.controller.resume(), false, testCase.name);
    assert.equal(harness.liveTimers().length, 0, testCase.name);
    assert.equal(harness.getReconnectCalls(), 0, testCase.name);
  }
});

test("Android Firefox unexpected disconnect is coalesced and reconnects through one scheduled action", async () => {
  const harness = createHarness({ userAgent: androidFirefoxUa });

  assert.equal(harness.controller.isEnabled(), true);
  assert.equal(harness.disconnect(), true);
  assert.equal(harness.disconnect(), false, "duplicate disconnect must coalesce");
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [500]);

  await harness.fireNextTimer();

  assert.equal(harness.getReconnectCalls(), 1);
  assert.deepEqual(harness.attempts, [1]);
  assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false });
});

test("brief duplicate-identity race retries with bounded deterministic backoff", async () => {
  const harness = createHarness({ userAgent: androidFirefoxUa });
  const reconnect = ({ reconnectCalls, setCurrentRoom }) => {
    if (reconnectCalls < 3) throw new Error("duplicate identity still draining");
    setCurrentRoom({ sid: "reconnected-room" });
  };

  assert.equal(harness.disconnect(14, reconnect), true);
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [500]);
  await harness.fireNextTimer();
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [2000]);
  await harness.fireNextTimer();
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [5000]);
  await harness.fireNextTimer();

  assert.equal(harness.getReconnectCalls(), 3);
  assert.deepEqual(harness.attempts, [1, 2, 3]);
  assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false });
});

test("a completed rejected-candidate cleanup permits retry two and the next verified candidate succeeds", async () => {
  const harness = createHarness({ userAgent: androidFirefoxUa });
  const verificationResults = [];
  const rejectedCandidates = [];
  const reconnect = async ({ reconnectCalls, setCurrentRoom }) => {
    const policy = reconnectCalls === 1 ? "all" : "relay";
    const candidate = {
      sid: "candidate-" + reconnectCalls,
      _echoAndroidFirefoxRelayAttempted: true,
      disconnectCalls: 0,
      disconnect(stopTracks) {
        candidate.disconnectCalls += 1;
        assert.equal(stopTracks, true);
        return Promise.resolve();
      },
      engine: {
        pcManager: {
          publisher: { pc: { getConfiguration: () => ({ iceTransportPolicy: policy }) } },
          subscriber: { pc: { getConfiguration: () => ({ iceTransportPolicy: "relay" }) } },
        },
      },
    };
    const verification = verifyAndroidFirefoxRelayCandidateRoom(candidate);
    verificationResults.push(verification.verified);
    if (!verification.verified) {
      rejectedCandidates.push(candidate);
      assert.equal(
        await disconnectAndroidFirefoxRejectedRelayCandidate(candidate),
        true
      );
      const error = new Error("relay candidate verification failed");
      error.name = "AndroidFirefoxRelayVerificationError";
      throw error;
    }
    candidate._echoAndroidFirefoxRelayForced = true;
    setCurrentRoom(candidate);
  };

  assert.equal(harness.disconnect(14, reconnect), true);
  await harness.fireNextTimer();
  assert.deepEqual(verificationResults, [false]);
  assert.deepEqual(harness.attempts, [1]);
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [2000]);
  assert.equal(harness.getCurrentRoom().sid, "old-room");
  assert.equal(rejectedCandidates[0]._echoRecoveryDisconnectComplete, true);
  assert.equal(rejectedCandidates[0].disconnectCalls, 1);

  await harness.fireNextTimer();
  assert.deepEqual(verificationResults, [false, true]);
  assert.deepEqual(harness.attempts, [1, 2]);
  assert.equal(harness.getCurrentRoom()._echoAndroidFirefoxRelayAttempted, true);
  assert.equal(harness.getCurrentRoom()._echoAndroidFirefoxRelayForced, true);
  assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false });
});

test("rejected-candidate disconnect rejection is terminal and never starts fresh connect two", async () => {
  let candidateDisconnectCalls = 0;
  const harness = createHarness({ userAgent: androidFirefoxUa });
  const reconnect = async () => {
    const candidate = {
      disconnect(stopTracks) {
        candidateDisconnectCalls += 1;
        assert.equal(stopTracks, true);
        return Promise.reject(new Error("candidate sendLeave failed"));
      },
    };
    await disconnectAndroidFirefoxRejectedRelayCandidate(candidate);
  };

  assert.equal(harness.disconnect(14, reconnect), true);
  await harness.fireNextTimer();

  assert.equal(harness.getReconnectCalls(), 1);
  assert.equal(candidateDisconnectCalls, 1);
  assert.deepEqual(harness.attempts, [1]);
  assert.equal(harness.liveTimers().length, 0);
  assert.equal(harness.attemptFailures.length, 1);
  assert.equal(isAndroidFirefoxCandidateReleaseError(harness.attemptFailures[0].error), true);
  assert.equal(harness.attemptFailures[0].error.retryable, false);
  assert.deepEqual(harness.controller.snapshot(), {
    enabled: true,
    active: true,
    attemptCount: 1,
    scheduled: false,
    inFlight: false,
    waiting: false,
    exhausted: true,
  });
  assert.equal(harness.disconnect(14, reconnect), false, "duplicate event cannot reopen recovery");
  assert.equal(harness.controller.resume(), false);
  assert.equal(harness.getReconnectCalls(), 1);
});

test("missing rejected-candidate cleanup helper fails closed without starting retry two", async () => {
  const harness = createHarness({ userAgent: androidFirefoxUa });
  const reconnect = () => {
    throw createAndroidFirefoxCandidateReleaseError(
      "Android Firefox rejected-candidate teardown helper is unavailable"
    );
  };

  assert.equal(harness.disconnect(14, reconnect), true);
  await harness.fireNextTimer();

  assert.equal(harness.getReconnectCalls(), 1);
  assert.deepEqual(harness.attempts, [1]);
  assert.equal(harness.liveTimers().length, 0);
  assert.equal(harness.attemptFailures.length, 1);
  assert.equal(isAndroidFirefoxCandidateReleaseError(harness.attemptFailures[0].error), true);
  assert.equal(harness.attemptFailures[0].error.retryable, false);
  assert.equal(harness.controller.snapshot().exhausted, true);
  assert.equal(harness.disconnect(14, reconnect), false);
  assert.equal(harness.controller.resume(), false);
  assert.equal(harness.getReconnectCalls(), 1);
});

test("unproven rejected-candidate timeout is terminal and cannot overlap a fresh connect", async () => {
  const cleanupTimers = [];
  let candidateDisconnectCalls = 0;
  const cleanupOptions = {
    timeoutMs: 1500,
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      cleanupTimers.push(timer);
      return timer;
    },
    cancelSchedule(timer) { timer.cancelled = true; },
  };
  const harness = createHarness({ userAgent: androidFirefoxUa });
  const reconnect = async () => {
    const candidate = {
      disconnect(stopTracks) {
        candidateDisconnectCalls += 1;
        assert.equal(stopTracks, true);
        return new Promise(() => {});
      },
    };
    await disconnectAndroidFirefoxRejectedRelayCandidate(candidate, cleanupOptions);
  };

  assert.equal(harness.disconnect(14, reconnect), true);
  const firstAttempt = harness.fireNextTimer();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.getReconnectCalls(), 1);
  assert.equal(candidateDisconnectCalls, 1);
  assert.equal(cleanupTimers.length, 1);
  assert.equal(cleanupTimers[0].delay, 1500);
  assert.equal(harness.liveTimers().length, 0);
  assert.equal(harness.controller.snapshot().inFlight, true);
  assert.equal(harness.disconnect(14, reconnect), false, "in-flight cleanup must coalesce events");

  cleanupTimers[0].callback();
  await firstAttempt;

  assert.equal(harness.getReconnectCalls(), 1);
  assert.equal(candidateDisconnectCalls, 1);
  assert.equal(harness.liveTimers().length, 0);
  assert.equal(harness.attemptFailures.length, 1);
  assert.equal(isAndroidFirefoxCandidateReleaseError(harness.attemptFailures[0].error), true);
  assert.match(harness.attemptFailures[0].error.message, /timed out/);
  assert.equal(harness.controller.snapshot().exhausted, true);
  assert.equal(harness.controller.resume(), false);
});

test("relay verification requires both publisher and subscriber peer connections", () => {
  const candidate = {
    engine: {
      pcManager: {
        publisher: { pc: { getConfiguration: () => ({ iceTransportPolicy: "relay" }) } },
        subscriber: { pc: { getConfiguration: () => ({ iceTransportPolicy: "all" }) } },
      },
    },
  };
  assert.deepEqual(verifyAndroidFirefoxRelayCandidateRoom(candidate), {
    publisherPolicy: "relay",
    subscriberPolicy: "all",
    verified: false,
  });
  candidate.engine.pcManager.subscriber.pc.getConfiguration = () => ({ iceTransportPolicy: "relay" });
  assert.equal(verifyAndroidFirefoxRelayCandidateRoom(candidate).verified, true);
  delete candidate.engine.pcManager.subscriber;
  assert.equal(verifyAndroidFirefoxRelayCandidateRoom(candidate).verified, false);
});

test("failed recovery exhausts its bounded retry budget and cannot be restarted by duplicate events", async () => {
  const harness = createHarness({ userAgent: androidFirefoxUa });
  const fail = () => { throw new Error("still disconnected"); };

  assert.equal(harness.disconnect(15, fail), true);
  await harness.fireNextTimer();
  await harness.fireNextTimer();
  await harness.fireNextTimer();

  assert.equal(harness.getReconnectCalls(), 3);
  assert.equal(harness.liveTimers().length, 0);
  assert.equal(harness.controller.snapshot().exhausted, true);
  assert.equal(harness.disconnect(15, fail), false);
  assert.equal(harness.liveTimers().length, 0);
});

test("hidden and offline Android Firefox recovery defers until both conditions clear", async () => {
  const harness = createHarness({ userAgent: androidFirefoxUa, hidden: true, online: false });

  assert.equal(harness.disconnect(), true);
  assert.equal(harness.liveTimers().length, 0);
  assert.equal(harness.controller.snapshot().waiting, true);
  assert.equal(harness.controller.resume(), false);

  harness.setHidden(false);
  assert.equal(harness.controller.resume(), false, "offline state must continue deferring");
  harness.setOnline(true);
  assert.equal(harness.controller.resume(), true);
  assert.deepEqual(harness.liveTimers().map((timer) => timer.delay), [500]);

  await harness.fireNextTimer();
  assert.equal(harness.getReconnectCalls(), 1);
});

test("expected, switching, stale, user, and server removals never schedule reconnect", () => {
  const terminalReasons = [1, 2, 3, 4, 5, 7, 10, 11, 12, 13];
  for (const reason of terminalReasons) {
    const harness = createHarness({ userAgent: androidFirefoxUa });
    assert.equal(harness.disconnect(reason), false, disconnectReasons[reason]);
    assert.equal(harness.liveTimers().length, 0, disconnectReasons[reason]);
    assert.equal(harness.getReconnectCalls(), 0, disconnectReasons[reason]);
  }

  const expected = createHarness({
    userAgent: androidFirefoxUa,
    room: { sid: "expected", _echoExpectedDisconnect: true },
  });
  assert.equal(expected.disconnect(), false);
  assert.equal(expected.liveTimers().length, 0);

  const switching = createHarness({ userAgent: androidFirefoxUa, switching: true });
  assert.equal(switching.disconnect(), false);
  assert.equal(switching.liveTimers().length, 0);

  const stale = createHarness({ userAgent: androidFirefoxUa });
  const staleRoom = stale.getCurrentRoom();
  stale.setCurrentRoom({ sid: "new-current-room" });
  assert.equal(stale.controller.handleDisconnected({
    room: staleRoom,
    reason: 14,
    disconnectReasons,
    reconnect() { throw new Error("must not run"); },
  }), false);
  assert.equal(stale.liveTimers().length, 0);
});

test("generation guard cancels a pending retry after another room becomes current", async () => {
  const harness = createHarness({ userAgent: androidFirefoxUa });
  assert.equal(harness.disconnect(), true);
  harness.setCurrentRoom({ sid: "newer-room" });

  await harness.fireNextTimer();

  assert.equal(harness.getReconnectCalls(), 0);
  assert.deepEqual(harness.controller.snapshot(), { enabled: true, active: false });
});

test("Android Firefox reconnect preserves muted mic and restores an enabled mic", () => {
  assert.deepEqual(resolvePostConnectMicrophoneBehavior({
    reuseAdmin: true,
    preserveMicIntent: true,
    micWasEnabled: false,
  }), {
    restoreMic: false,
    preserveMutedMic: true,
  });
  assert.deepEqual(resolvePostConnectMicrophoneBehavior({
    reuseAdmin: true,
    preserveMicIntent: true,
    micWasEnabled: true,
  }), {
    restoreMic: true,
    preserveMutedMic: false,
  });

  // Existing generic switch behavior remains unchanged when the target-only
  // preservation option is absent.
  assert.deepEqual(resolvePostConnectMicrophoneBehavior({
    reuseAdmin: true,
    preserveMicIntent: false,
    micWasEnabled: false,
  }), {
    restoreMic: false,
    preserveMutedMic: false,
  });
});

test("production wiring is target-gated and invokes only supported connectToRoom reuse path", () => {
  assert.match(
    connectSource,
    /androidFirefoxRoomDisconnectRecoveryEnabled = typeof isAndroidFirefoxBrowser === "function" &&\s+isAndroidFirefoxBrowser\(navigator, window\.__ECHO_NATIVE__ === true\)/
  );
  assert.match(
    connectSource,
    /function reconnectAndroidFirefoxRoom\([\s\S]*?return connectToRoom\(\{[\s\S]*?reuseAdmin: true,[\s\S]*?preserveMicIntent: true[\s\S]*?RoomEvent\.Disconnected[\s\S]*?handleDisconnected\(\{[\s\S]*?reconnect: reconnectAndroidFirefoxRoom/
  );
  assert.match(
    connectSource,
    /if \(androidFirefoxRoomDisconnectRecoveryEnabled && newRoom !== room\) \{[\s\S]*?return;/
  );
  assert.match(
    connectSource,
    /ConnectionStateChanged[\s\S]*?if \(androidFirefoxRoomDisconnectRecoveryEnabled && newRoom !== room\) \{[\s\S]*?return;/
  );
  assert.match(
    connectSource,
    /if \(restoreMicAfterConnect\)[\s\S]*?else if \(preserveDisabledMicAfterConnect\)[\s\S]*?syncDesiredMicToActual\(false\)[\s\S]*?else \{/
  );
  assert.match(
    connectSource,
    /await disconnectRejectedRelayCandidate\(newRoom, \{ timeoutMs: 1500 \}\)[\s\S]*?catch \(cleanupError\)[\s\S]*?throw cleanupError[\s\S]*?AndroidFirefoxRelayVerificationError[\s\S]*?throw relayVerificationError/
  );
  assert.match(
    connectSource,
    /typeof disconnectRejectedRelayCandidate !== "function"[\s\S]*?createAndroidFirefoxCandidateReleaseError[\s\S]*?throw createCandidateReleaseError/
  );
});
