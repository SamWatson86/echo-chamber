const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoomSwitchState } = require("./room-switch-state.js");
const { createJamSessionState } = require("./jam-session-state.js");
const { reconcilePublishIndicators } = require("./publish-state-reconcile.js");

test("room transition keeps heartbeat on connected room until switch commit", () => {
  const rooms = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });

  rooms.requestSwitch("gaming", 1_000);
  assert.equal(rooms.heartbeatRoomName(), "main");

  rooms.markConnected("gaming");
  assert.equal(rooms.heartbeatRoomName(), "gaming");
});

test("switch transition publish drift is reconciled against actual publication", () => {
  const rooms = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });

  rooms.requestSwitch("breakout", 1_000);

  const uiStateAfterSwitch = { camEnabled: true, screenEnabled: true };
  const actualPublication = { cameraPublished: false, screenPublished: false };

  const reconciled = reconcilePublishIndicators(uiStateAfterSwitch, actualPublication);
  assert.equal(reconciled.anyDrift, true);
  assert.deepEqual(reconciled.next, { camEnabled: false, screenEnabled: false });

  rooms.markConnected("breakout");
  assert.equal(rooms.snapshot().isSwitching, false);
});

test("jam reconnect loop is deterministic and resets after successful stream open", () => {
  const jam = createJamSessionState({ reconnectBaseMs: 200, reconnectMaxMs: 800 });
  jam.requestJoin();
  jam.joinAccepted();
  jam.streamOpen();

  assert.equal(jam.streamClosedTransient("blip").delayMs, 200);
  assert.equal(jam.streamClosedTransient("blip").delayMs, 400);
  assert.equal(jam.streamClosedTransient("blip").delayMs, 800);
  assert.equal(jam.streamClosedTransient("blip").delayMs, 800);

  const reconnectStart = jam.reconnectAttemptStarted();
  assert.equal(reconnectStart.shouldConnect, true);
  assert.equal(jam.ui().status, "connecting");

  jam.streamOpen();
  assert.equal(jam.snapshot().reconnectAttempt, 0);
  assert.equal(jam.ui().status, "connected");
});

test("stale room-connected callback does not override pending switch publish truth", () => {
  const rooms = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });
  rooms.requestSwitch("breakout", 1_000);

  // Stale callback from prior room must not collapse in-flight switch.
  rooms.markConnected("main");
  assert.equal(rooms.snapshot().isSwitching, true);
  assert.equal(rooms.snapshot().activeRoomName, "breakout");

  // During transition, callbacks may report camera still published in old room.
  const reconciled = reconcilePublishIndicators(
    { camEnabled: false, screenEnabled: false },
    { cameraPublished: true, screenPublished: false }
  );
  assert.equal(reconciled.next.camEnabled, true);

  rooms.markConnected("breakout");
  assert.equal(rooms.snapshot().isSwitching, false);
  assert.equal(rooms.snapshot().connectedRoomName, "breakout");
});

test("room switch transition converges when publication callbacks arrive in opposite order", () => {
  const rooms = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });

  rooms.requestSwitch("breakout-2", 1_000);

  // First callback says everything unpublished (disconnect edge)
  const first = reconcilePublishIndicators(
    { camEnabled: true, screenEnabled: true },
    { cameraPublished: false, screenPublished: false }
  );
  assert.deepEqual(first.next, { camEnabled: false, screenEnabled: false });

  // Later callback says screen actually published (late subscribe edge)
  const second = reconcilePublishIndicators(
    first.next,
    { cameraPublished: false, screenPublished: true }
  );
  assert.deepEqual(second.next, { camEnabled: false, screenEnabled: true });

  rooms.markConnected("breakout-2");
  assert.equal(rooms.heartbeatRoomName(), "breakout-2");
});

test("forceConnected path ignores late callback churn from superseded room", () => {
  const rooms = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });

  rooms.requestSwitch("breakout-1", 1_000);

  // connectToRoom(forceConnected) can advance active room while old callbacks are still pending.
  rooms.forceConnected("breakout-2");

  // Late callback for the superseded room must not move us back.
  rooms.markConnected("breakout-1");
  assert.equal(rooms.snapshot().connectedRoomName, "breakout-2");

  // Idempotent callback for active room preserves committed truth.
  rooms.markConnected("breakout-2");
  assert.equal(rooms.heartbeatRoomName(), "breakout-2");
});

test("transition-time publish/unpublish interleavings converge without sticky drift", () => {
  let ui = { camEnabled: true, screenEnabled: false };

  // Old-room unpublish arrives first.
  ui = reconcilePublishIndicators(ui, { cameraPublished: false, screenPublished: false }).next;
  assert.deepEqual(ui, { camEnabled: false, screenEnabled: false });

  // New-room publish callback arrives after disconnect edge.
  ui = reconcilePublishIndicators(ui, { cameraPublished: true, screenPublished: false }).next;
  assert.deepEqual(ui, { camEnabled: true, screenEnabled: false });

  // Brief duplicate unpublish from prior transport edge should still be corrected by next publish truth.
  ui = reconcilePublishIndicators(ui, { cameraPublished: false, screenPublished: false }).next;
  ui = reconcilePublishIndicators(ui, { cameraPublished: true, screenPublished: false }).next;
  assert.deepEqual(ui, { camEnabled: true, screenEnabled: false });
});

test("camera and screen interleavings remain independent across transition edges", () => {
  let ui = { camEnabled: false, screenEnabled: true };

  // Screen unpublished while camera becomes published in next room.
  ui = reconcilePublishIndicators(ui, { cameraPublished: true, screenPublished: false }).next;
  assert.deepEqual(ui, { camEnabled: true, screenEnabled: false });

  // Late screen publish arrives without affecting camera.
  ui = reconcilePublishIndicators(ui, { cameraPublished: true, screenPublished: true }).next;
  assert.deepEqual(ui, { camEnabled: true, screenEnabled: true });
});

test("transition-time callback permutations converge to final publication truth", () => {
  const callbacks = [
    { cameraPublished: false, screenPublished: false },
    { cameraPublished: true, screenPublished: false },
    { cameraPublished: false, screenPublished: true },
    { cameraPublished: true, screenPublished: true },
  ];

  for (let i = 0; i < callbacks.length; i += 1) {
    for (let j = 0; j < callbacks.length; j += 1) {
      for (let k = 0; k < callbacks.length; k += 1) {
        let ui = { camEnabled: false, screenEnabled: false };
        ui = reconcilePublishIndicators(ui, callbacks[i]).next;
        ui = reconcilePublishIndicators(ui, callbacks[j]).next;
        ui = reconcilePublishIndicators(ui, callbacks[k]).next;

        // Last callback should always be the settled UI truth.
        assert.deepEqual(ui, {
          camEnabled: callbacks[k].cameraPublished,
          screenEnabled: callbacks[k].screenPublished,
        });
      }
    }
  }
});

test("switch commit only occurs for active target when connect callbacks resolve out-of-order", () => {
  const rooms = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });

  // User initiates a switch; UI optimistically points to breakout.
  rooms.requestSwitch("breakout", 1_000);
  assert.equal(rooms.snapshot().activeRoomName, "breakout");
  assert.equal(rooms.heartbeatRoomName(), "main");

  // Stale callback from the previous connection attempt lands first.
  rooms.markConnected("main");
  assert.equal(rooms.snapshot().isSwitching, true);
  assert.equal(rooms.snapshot().activeRoomName, "breakout");
  assert.equal(rooms.heartbeatRoomName(), "main");

  // Correct callback lands later and must commit the switch.
  rooms.markConnected("breakout");
  assert.equal(rooms.snapshot().isSwitching, false);
  assert.equal(rooms.heartbeatRoomName(), "breakout");
});

test("publish reconcile converges after alternating room-edge callback churn", () => {
  let ui = { camEnabled: true, screenEnabled: true };

  const callbackOrder = [
    { cameraPublished: false, screenPublished: true },
    { cameraPublished: false, screenPublished: false },
    { cameraPublished: true, screenPublished: false },
    { cameraPublished: true, screenPublished: true },
    { cameraPublished: false, screenPublished: true },
    { cameraPublished: true, screenPublished: true },
  ];

  for (const actual of callbackOrder) {
    ui = reconcilePublishIndicators(ui, actual).next;
  }

  // Final callback truth should always win, regardless of transition churn.
  assert.deepEqual(ui, { camEnabled: true, screenEnabled: true });
});

test("jam reconnect is blocked while leave is pending and resumes after leave failure", () => {
  const jam = createJamSessionState({ reconnectBaseMs: 100, reconnectMaxMs: 400 });
  jam.requestJoin();
  jam.joinAccepted();
  jam.streamOpen();

  jam.requestLeave();

  // Disconnect races during intentional leave must not schedule reconnect.
  const duringLeave = jam.streamClosedTransient("socket-close");
  assert.equal(duringLeave.shouldReconnect, false);
  assert.equal(jam.reconnectAttemptStarted().shouldConnect, false);

  // If leave API fails, recovery path should resume deterministic reconnect behavior.
  jam.leaveFailed("timeout");
  const afterFailure = jam.streamClosedTransient("socket-close");
  assert.equal(afterFailure.shouldReconnect, true);
  assert.equal(afterFailure.delayMs, 100);
});

test("connect callback sequencing: stale explicit callback then implicit success commits pending target", () => {
  const rooms = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });

  rooms.requestSwitch("studio", 1_000);

  // Old room callback lands first; switch must remain in-flight.
  rooms.markConnected("main");
  assert.equal(rooms.snapshot().isSwitching, true);
  assert.equal(rooms.snapshot().activeRoomName, "studio");

  // connectToRoom success callback can arrive without explicit room name.
  rooms.markConnected();
  assert.equal(rooms.snapshot().isSwitching, false);
  assert.equal(rooms.snapshot().connectedRoomName, "studio");
  assert.equal(rooms.heartbeatRoomName(), "studio");
});

test("transition media interleavings converge when camera and screen flap independently", () => {
  let ui = { camEnabled: true, screenEnabled: true };

  const callbackOrder = [
    // old room camera drops first
    { cameraPublished: false, screenPublished: true },
    // then old room screen drops
    { cameraPublished: false, screenPublished: false },
    // new room screen recovers before camera
    { cameraPublished: false, screenPublished: true },
    // finally camera recovers
    { cameraPublished: true, screenPublished: true },
    // brief duplicate stale screen drop
    { cameraPublished: true, screenPublished: false },
    // settled truth
    { cameraPublished: true, screenPublished: true },
  ];

  for (const actual of callbackOrder) {
    ui = reconcilePublishIndicators(ui, actual).next;
  }

  assert.deepEqual(ui, { camEnabled: true, screenEnabled: true });
});

test("reconnect/disconnect race: leave success hard-stops reconnect even after prior close", () => {
  const jam = createJamSessionState({ reconnectBaseMs: 100, reconnectMaxMs: 400 });
  jam.requestJoin();
  jam.joinAccepted();
  jam.streamOpen();

  // Transport drops and schedules reconnect.
  const dropped = jam.streamClosedTransient("socket-close");
  assert.equal(dropped.shouldReconnect, true);
  assert.equal(dropped.delayMs, 100);

  // User leaves before reconnect attempt runs.
  jam.requestLeave();
  jam.leaveSucceeded();

  // Scheduled reconnect callback must now be blocked.
  assert.equal(jam.reconnectAttemptStarted().shouldConnect, false);
  assert.equal(jam.snapshot().serverJoined, false);
  assert.equal(jam.snapshot().reconnectAttempt, 0);
});

test("transition media callback churn always converges to final camera/screen truth", () => {
  const states = [
    { cameraPublished: false, screenPublished: false },
    { cameraPublished: true, screenPublished: false },
    { cameraPublished: false, screenPublished: true },
    { cameraPublished: true, screenPublished: true },
  ];

  for (let a = 0; a < states.length; a += 1) {
    for (let b = 0; b < states.length; b += 1) {
      for (let c = 0; c < states.length; c += 1) {
        for (let d = 0; d < states.length; d += 1) {
          let ui = { camEnabled: true, screenEnabled: true };
          ui = reconcilePublishIndicators(ui, states[a]).next;
          ui = reconcilePublishIndicators(ui, states[b]).next;
          ui = reconcilePublishIndicators(ui, states[c]).next;
          ui = reconcilePublishIndicators(ui, states[d]).next;

          assert.deepEqual(ui, {
            camEnabled: states[d].cameraPublished,
            screenEnabled: states[d].screenPublished,
          });
        }
      }
    }
  }
});
