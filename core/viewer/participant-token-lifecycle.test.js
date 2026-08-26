const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PARTICIPANT_TOKEN_REFRESH_MARGIN_MS,
  decodeParticipantTokenExpirationMs,
  createParticipantTokenLifecycle,
} = require("./auth.js");
const fs = require("node:fs");
const path = require("node:path");

function jwt(expirationMs, marker) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return encode({ alg: "none" }) + "." +
    encode({ exp: Math.floor(expirationMs / 1000), marker: marker || "token" }) + ".signature";
}

function httpError(status) {
  const error = new Error("HTTP " + status);
  error.status = status;
  return error;
}

function createHarness(options = {}) {
  let nowMs = options.nowMs || 1_000_000;
  let currentToken = options.currentToken || jwt(nowMs + 60 * 60 * 1000, "current");
  let adminToken = "admin-old";
  const calls = { issue: [], renew: [], committed: [] };
  const issue = options.issue || (async () => jwt(nowMs + 4 * 60 * 60 * 1000, "refreshed"));
  const renew = options.renew || (async () => "admin-new");
  const lifecycle = createParticipantTokenLifecycle({
    now: () => nowMs,
    refreshMarginMs: options.refreshMarginMs,
    getCurrentToken: () => currentToken,
    setCurrentToken: (token) => { currentToken = token; },
    getAdminToken: () => adminToken,
    setAdminToken: (token) => { adminToken = token; },
    getPassword: () => options.password === undefined ? "saved-password" : options.password,
    issueRoomToken: async (context, token) => {
      calls.issue.push({ context, token });
      return issue(context, token, calls.issue.length);
    },
    renewAdminToken: async (baseUrl, password) => {
      calls.renew.push({ baseUrl, password });
      return renew(baseUrl, password, calls.renew.length);
    },
    onTokenCommitted: (context) => calls.committed.push(context),
  });

  function commit(roomId = "main", token = currentToken) {
    currentToken = token;
    lifecycle.commitConnected({
      controlUrl: "https://echo.test",
      roomId,
      identity: "sam-device",
      name: "Sam",
      token,
    });
  }

  return {
    lifecycle,
    calls,
    commit,
    now: () => nowMs,
    setNow: (value) => { nowMs = value; },
    currentToken: () => currentToken,
    adminToken: () => adminToken,
  };
}

test("JWT expiration decoding drives a five-minute early refresh margin", () => {
  const expirationMs = 9_876_000;
  assert.equal(decodeParticipantTokenExpirationMs(jwt(expirationMs, "decode")), 9_876_000);
  assert.equal(decodeParticipantTokenExpirationMs("not-a-jwt"), null);
  assert.equal(PARTICIPANT_TOKEN_REFRESH_MARGIN_MS, 5 * 60 * 1000);
});

test("a connected token outside the margin stays current without a request", async () => {
  const harness = createHarness();
  harness.commit();

  const result = await harness.lifecycle.ensureFresh({ expectedToken: harness.currentToken() });

  assert.equal(result.status, "current");
  assert.equal(harness.calls.issue.length, 0);
  assert.equal(harness.currentToken(), result.token);
});

test("due concurrent refreshes coalesce and commit one participant token", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const nowMs = 2_000_000;
  const oldToken = jwt(nowMs + 4 * 60 * 1000, "due");
  const newToken = jwt(nowMs + 4 * 60 * 60 * 1000, "new");
  const harness = createHarness({ nowMs, currentToken: oldToken, issue: () => pending });
  harness.commit();

  const first = harness.lifecycle.ensureFresh({ expectedToken: oldToken });
  const second = harness.lifecycle.ensureFresh({ expectedToken: oldToken });
  assert.equal(first, second);
  assert.equal(harness.calls.issue.length, 1);

  release(newToken);
  assert.equal((await first).status, "refreshed");
  assert.equal(harness.currentToken(), newToken);
  assert.equal(harness.calls.committed.length, 1);
});

test("an expired admin credential gets exactly one retained-password retry", async () => {
  const nowMs = 3_000_000;
  const oldToken = jwt(nowMs + 60_000, "old");
  const newToken = jwt(nowMs + 4 * 60 * 60 * 1000, "new");
  const harness = createHarness({
    nowMs,
    currentToken: oldToken,
    issue: async (_context, admin, attempt) => {
      if (attempt === 1) throw httpError(401);
      assert.equal(admin, "admin-new");
      return newToken;
    },
  });
  harness.commit();

  const result = await harness.lifecycle.ensureFresh({ force: true, expectedToken: oldToken });

  assert.equal(result.status, "refreshed");
  assert.equal(harness.calls.issue.length, 2);
  assert.deepEqual(harness.calls.renew, [{ baseUrl: "https://echo.test", password: "saved-password" }]);
  assert.equal(harness.adminToken(), "admin-new");
  assert.equal(harness.currentToken(), newToken);
});

test("a failed retry preserves the connected token and never loops", async () => {
  const nowMs = 4_000_000;
  const oldToken = jwt(nowMs + 60_000, "old");
  const harness = createHarness({
    nowMs,
    currentToken: oldToken,
    issue: async () => { throw httpError(401); },
  });
  harness.commit();

  const result = await harness.lifecycle.ensureFresh({ force: true, expectedToken: oldToken });

  assert.equal(result.status, "failed");
  assert.equal(harness.calls.issue.length, 2);
  assert.equal(harness.calls.renew.length, 1);
  assert.equal(harness.currentToken(), oldToken);
  assert.equal(harness.calls.committed.length, 0);

  const deferred = await harness.lifecycle.ensureFresh({ force: true, expectedToken: oldToken });
  assert.equal(deferred.status, "deferred");
  assert.equal(harness.calls.issue.length, 2, "heartbeat 401s must not hot-loop forced refresh");
  assert.equal(harness.calls.renew.length, 1);

  harness.setNow(nowMs + 60_001);
  const retried = await harness.lifecycle.ensureFresh({ force: true, expectedToken: oldToken });
  assert.equal(retried.status, "failed");
  assert.equal(harness.calls.issue.length, 4);
  assert.equal(harness.calls.renew.length, 2);
});

test("a network failure preserves the active credential for a later heartbeat", async () => {
  const nowMs = 5_000_000;
  const oldToken = jwt(nowMs + 60_000, "old");
  const harness = createHarness({
    nowMs,
    currentToken: oldToken,
    issue: async () => { throw new TypeError("network unavailable"); },
  });
  harness.commit();

  const result = await harness.lifecycle.ensureFresh({ expectedToken: oldToken });

  assert.equal(result.status, "failed");
  assert.equal(harness.calls.issue.length, 1);
  assert.equal(harness.calls.renew.length, 0);
  assert.equal(harness.currentToken(), oldToken);

  const deferred = await harness.lifecycle.ensureFresh({ expectedToken: oldToken });
  assert.equal(deferred.status, "deferred");
  assert.equal(harness.calls.issue.length, 1, "heartbeat polling must not hot-loop refresh failures");

  harness.setNow(nowMs + 60_001);
  const retried = await harness.lifecycle.ensureFresh({ expectedToken: oldToken });
  assert.equal(retried.status, "failed");
  assert.equal(harness.calls.issue.length, 2);
});

test("a room-switch generation rejects a late refresh commit", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const nowMs = 6_000_000;
  const oldToken = jwt(nowMs + 60_000, "main");
  const switchedToken = jwt(nowMs + 4 * 60 * 60 * 1000, "breakout");
  const lateToken = jwt(nowMs + 4 * 60 * 60 * 1000, "late-main");
  const harness = createHarness({ nowMs, currentToken: oldToken, issue: () => pending });
  harness.commit("main", oldToken);

  const refresh = harness.lifecycle.ensureFresh({ force: true, expectedToken: oldToken });
  harness.commit("breakout-1", switchedToken);
  release(lateToken);

  assert.equal((await refresh).status, "superseded");
  assert.equal(harness.currentToken(), switchedToken);
  assert.equal(harness.calls.committed.length, 0);
});

test("an old heartbeat token and a cleared connection cannot start refresh", async () => {
  const harness = createHarness();
  harness.commit();
  const oldToken = harness.currentToken();
  const replacement = jwt(harness.now() + 4 * 60 * 60 * 1000, "replacement");
  harness.commit("breakout-1", replacement);

  assert.equal((await harness.lifecycle.ensureFresh({ force: true, expectedToken: oldToken })).status, "superseded");
  harness.lifecycle.clearConnected();
  assert.equal((await harness.lifecycle.ensureFresh({ force: true, expectedToken: replacement })).status, "inactive");
  assert.equal(harness.calls.issue.length, 0);
});

test("connection integration commits lifecycle state only after the SFU room swap", () => {
  const connectSource = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");
  const connected = connectSource.indexOf("await newRoom.connect(sfuUrl, accessToken");
  const swapped = connectSource.indexOf("room = newRoom;", connected);
  const tokenCommitted = connectSource.indexOf("currentAccessToken =", swapped);
  const lifecycleCommitted = connectSource.indexOf("commitConnectedParticipantToken({", tokenCommitted);
  const heartbeatStarted = connectSource.indexOf("startHeartbeat();", lifecycleCommitted);

  assert.ok(connected >= 0);
  assert.ok(swapped > connected);
  assert.ok(tokenCommitted > swapped);
  assert.ok(lifecycleCommitted > tokenCommitted);
  assert.ok(heartbeatStarted > lifecycleCommitted);
});
