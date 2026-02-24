const test = require("node:test");
const assert = require("node:assert/strict");
const { createJamSessionState } = require("./jam-session-state.js");

test("join success then stream open => connected UI", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  assert.deepEqual(s.ui(), {
    joinVisible: false,
    leaveVisible: true,
    status: "connected",
  });
});

test("join accepted but stream closes => reconnect requested with backoff", () => {
  const s = createJamSessionState({ reconnectBaseMs: 500, reconnectMaxMs: 8000 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  const first = s.streamClosedTransient("ws-close");
  assert.equal(first.shouldReconnect, true);
  assert.equal(first.delayMs, 500);

  const second = s.streamClosedTransient("ws-close");
  assert.equal(second.shouldReconnect, true);
  assert.equal(second.delayMs, 1000);
});

test("stream close when user does not want listening => no reconnect", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();
  s.requestLeave();

  const close = s.streamClosedTransient("ws-close");
  assert.equal(close.shouldReconnect, false);
});

test("leave failed restores listening intent for recovery", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  s.requestLeave();
  s.leaveFailed("network");

  const snap = s.snapshot();
  assert.equal(snap.desiredListening, true);
  assert.equal(snap.serverJoined, true);
  assert.equal(s.ui().joinVisible, false); // reconnecting/leave path remains active
});

test("join rejected clears listening state", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinRejected("401");

  const snap = s.snapshot();
  assert.equal(snap.desiredListening, false);
  assert.equal(snap.serverJoined, false);
  assert.equal(snap.streamConnected, false);
  assert.equal(s.ui().joinVisible, true);
});

test("reconnect backoff is capped at reconnectMaxMs", () => {
  const s = createJamSessionState({ reconnectBaseMs: 200, reconnectMaxMs: 700 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  assert.equal(s.streamClosedTransient("ws-close").delayMs, 200);
  assert.equal(s.streamClosedTransient("ws-close").delayMs, 400);
  assert.equal(s.streamClosedTransient("ws-close").delayMs, 700);
  assert.equal(s.streamClosedTransient("ws-close").delayMs, 700);
});

test("reconnectAttemptStarted is blocked after leave request", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();
  s.requestLeave();

  const out = s.reconnectAttemptStarted();
  assert.equal(out.shouldConnect, false);
  assert.equal(s.snapshot().pendingLeave, true);
  assert.equal(s.ui().leaveVisible, true);
});

test("transient close after leave success never schedules reconnect", () => {
  const s = createJamSessionState({ reconnectBaseMs: 100, reconnectMaxMs: 400 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();
  s.requestLeave();
  s.leaveSucceeded();

  const close = s.streamClosedTransient("late-close");
  assert.equal(close.shouldReconnect, false);
  assert.equal(close.delayMs, 0);
  assert.equal(s.snapshot().reconnectAttempt, 0);
});

test("connect attempt is blocked after join rejection race", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.joinRejected("server-denied");

  const reconnect = s.reconnectAttemptStarted();
  assert.equal(reconnect.shouldConnect, false);
  assert.equal(s.ui().status, "error");
});

test("late transient disconnect after leave failure restarts deterministic reconnect ladder", () => {
  const s = createJamSessionState({ reconnectBaseMs: 100, reconnectMaxMs: 800 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  s.requestLeave();
  s.leaveFailed("timeout");

  const first = s.streamClosedTransient("late-close");
  const second = s.streamClosedTransient("late-close");

  assert.equal(first.shouldReconnect, true);
  assert.equal(first.delayMs, 100);
  assert.equal(second.shouldReconnect, true);
  assert.equal(second.delayMs, 200);
  assert.equal(s.snapshot().reconnectAttempt, 2);
});

test("reconnect attempt remains blocked until leave failure clears pendingLeave", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  s.requestLeave();
  assert.equal(s.reconnectAttemptStarted().shouldConnect, false);

  // Transport closes while leave is pending; reconnect still blocked.
  s.streamClosedTransient("socket-close");
  assert.equal(s.reconnectAttemptStarted().shouldConnect, false);

  // Once leave failure clears pendingLeave, reconnect is permitted again.
  s.leaveFailed("api-timeout");
  assert.equal(s.reconnectAttemptStarted().shouldConnect, true);
  assert.equal(s.snapshot().pendingLeave, false);
});

test("disconnect during reconnecting state continues deterministic backoff", () => {
  const s = createJamSessionState({ reconnectBaseMs: 150, reconnectMaxMs: 600 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  const first = s.streamClosedTransient("socket-close");
  assert.equal(first.delayMs, 150);
  assert.equal(s.reconnectAttemptStarted().shouldConnect, true);
  assert.equal(s.ui().status, "connecting");

  // While connect attempt is in-flight, another close should still advance backoff ladder.
  const second = s.streamClosedTransient("socket-close");
  assert.equal(second.shouldReconnect, true);
  assert.equal(second.delayMs, 300);
});

test("late disconnect after successful reconnect resets backoff to base", () => {
  const s = createJamSessionState({ reconnectBaseMs: 120, reconnectMaxMs: 480 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  // Build reconnect pressure.
  s.streamClosedTransient("drop-1"); // 120
  s.streamClosedTransient("drop-2"); // 240
  s.reconnectAttemptStarted();

  // Reconnect succeeds; backoff should reset.
  s.streamOpen();
  assert.equal(s.snapshot().reconnectAttempt, 0);

  // Next transient close should start from base again.
  const next = s.streamClosedTransient("drop-3");
  assert.equal(next.shouldReconnect, true);
  assert.equal(next.delayMs, 120);
});

test("late stream-open callback is ignored once leave is pending", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  s.requestLeave();

  // Transport callback arrives out-of-order after leave intent.
  s.streamOpen();

  assert.equal(s.snapshot().streamConnected, false);
  assert.equal(s.snapshot().pendingLeave, true);
  assert.equal(s.ui().status, "idle");
});
