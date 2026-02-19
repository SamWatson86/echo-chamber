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
