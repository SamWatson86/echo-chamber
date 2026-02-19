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

test("stale markConnected callback is ignored while switching", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });
  s.requestSwitch("breakout-1", 1_000);

  // Old room callback arrives out-of-order during in-flight switch.
  const room = s.markConnected("main");
  assert.equal(room, "breakout-1");

  assert.deepEqual(s.snapshot(), {
    connectedRoomName: "main",
    activeRoomName: "breakout-1",
    pendingRoomName: "breakout-1",
    isSwitching: true,
    lastSwitchRequestedAt: 1_000,
    cooldownMs: 0,
  });
});

test("pending room commits when markConnected is called without explicit room", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });
  s.requestSwitch("breakout-2", 1_000);

  const room = s.markConnected();
  assert.equal(room, "breakout-2");
  assert.equal(s.snapshot().isSwitching, false);
  assert.equal(s.snapshot().connectedRoomName, "breakout-2");
});

test("stale callback then implicit callback commits only pending switch target", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });
  s.requestSwitch("breakout-3", 1_000);

  // Out-of-order callback from previous room must keep switch in-flight.
  s.markConnected("main");
  assert.equal(s.snapshot().isSwitching, true);
  assert.equal(s.snapshot().activeRoomName, "breakout-3");
  assert.equal(s.heartbeatRoomName(), "main");

  // connectToRoom success path can commit without explicit room name.
  s.markConnected();
  assert.equal(s.snapshot().isSwitching, false);
  assert.equal(s.snapshot().connectedRoomName, "breakout-3");
  assert.equal(s.heartbeatRoomName(), "breakout-3");
});

test("forced room connect ignores late old-room callback after commit", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });
  s.requestSwitch("breakout-1", 1_000);

  // Simulates connectToRoom(forceConnected) after new room finishes.
  s.forceConnected("breakout-1");
  assert.equal(s.snapshot().connectedRoomName, "breakout-1");

  // Late callback from old room must be ignored once switch is settled.
  s.markConnected("main");
  assert.equal(s.snapshot().connectedRoomName, "breakout-1");
  assert.equal(s.heartbeatRoomName(), "breakout-1");
});

test("forceConnected followed by explicit markConnected target is idempotent", () => {
  const s = createRoomSwitchState({ initialRoomName: "main", cooldownMs: 0 });
  s.requestSwitch("studio", 1_000);

  s.forceConnected("studio");
  s.markConnected("studio");

  assert.deepEqual(s.snapshot(), {
    connectedRoomName: "studio",
    activeRoomName: "studio",
    pendingRoomName: null,
    isSwitching: false,
    lastSwitchRequestedAt: 1_000,
    cooldownMs: 0,
  });
});
