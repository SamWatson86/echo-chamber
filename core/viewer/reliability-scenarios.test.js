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
