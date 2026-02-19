const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoomSwitchState } = require("./room-switch-state.js");

test("requestSwitch marks state as in-flight and optimistic", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 500 });
  const res = s.requestSwitch("breakout-1", 1_000);

  assert.equal(res.ok, true);
  const snap = s.snapshot();
  assert.equal(snap.connectedRoomName, "main");
  assert.equal(snap.activeRoomName, "breakout-1");
  assert.equal(snap.pendingRoomName, "breakout-1");
  assert.equal(snap.isSwitching, true);
});

test("heartbeat uses connected room while switch is in-flight", () => {
  const s = createRoomSwitchState({ initialRoomName: "main" });
  s.requestSwitch("breakout-1", 1_000);

  assert.equal(s.heartbeatRoomName(), "main");

  s.markConnected("breakout-1");
  assert.equal(s.heartbeatRoomName(), "breakout-1");
});

test("markFailed rolls back optimistic room and clears switching", () => {
  const s = createRoomSwitchState({ initialRoomName: "main" });
  s.requestSwitch("breakout-1", 1_000);

  const roomAfterFail = s.markFailed();
  assert.equal(roomAfterFail, "main");

  const snap = s.snapshot();
  assert.equal(snap.activeRoomName, "main");
  assert.equal(snap.pendingRoomName, null);
  assert.equal(snap.isSwitching, false);
});

test("cannot switch during cooldown window", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 500 });
  assert.equal(s.requestSwitch("breakout-1", 1_000).ok, true);
  s.markConnected("breakout-1");

  const denied = s.requestSwitch("breakout-2", 1_200);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "cooldown");
});

test("cannot switch while in-flight", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });
  assert.equal(s.requestSwitch("breakout-1", 1_000).ok, true);

  const denied = s.requestSwitch("breakout-2", 1_100);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "in-flight");
});

test("forceConnected hard-resets optimistic switching state", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });
  s.requestSwitch("breakout-1", 1_000);

  const forced = s.forceConnected("lobby");
  assert.equal(forced, "lobby");

  assert.deepEqual(s.snapshot(), {
    connectedRoomName: "lobby",
    activeRoomName: "lobby",
    pendingRoomName: null,
    isSwitching: false,
    lastSwitchRequestedAt: 1_000,
    cooldownMs: 0,
  });
});

test("same-room request is denied after switch commit", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });
  s.requestSwitch("breakout-1", 1_000);
  s.markConnected("breakout-1");

  const denied = s.requestSwitch("breakout-1", 1_100);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "same-room");
});
