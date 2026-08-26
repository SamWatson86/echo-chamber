const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "room-status.js"), "utf8");

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type) {
      for (const handler of Array.from(listeners.get(type) || [])) handler();
    },
    count(type) {
      return listeners.get(type)?.size || 0;
    },
  };
}

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
  };
}

function createHarness(options = {}) {
  const elements = new Map();
  const documentEvents = eventTarget();
  const windowEvents = eventTarget();
  const intervals = new Map();
  const fetchCalls = [];
  const freshnessCalls = [];
  const diagnostics = { succeeded: [], invalidated: 0 };
  let intervalId = 0;
  let reloads = 0;
  const queuedResponses = Array.from(options.responses || [response(200, { stale: false })]);

  function createElement() {
    let elementId = "";
    const countdown = { textContent: "5" };
    return {
      className: "",
      innerHTML: "",
      style: {},
      appendChild() {},
      addEventListener() {},
      querySelector(selector) {
        return selector === ".stale-countdown" ? countdown : { addEventListener() {} };
      },
      remove() {
        if (elementId) elements.delete(elementId);
      },
      set id(value) { elementId = value; },
      get id() { return elementId; },
    };
  }

  const documentObject = {
    hidden: false,
    body: {
      appendChild(element) {
        if (element.id) elements.set(element.id, element);
      },
    },
    createElement,
    getElementById: (id) => elements.get(id) || null,
    addEventListener: documentEvents.addEventListener,
    removeEventListener: documentEvents.removeEventListener,
  };
  const windowObject = {
    EchoWebDiagnosticsRuntime: {
      invalidateHeartbeat() { diagnostics.invalidated += 1; },
      heartbeatSucceeded(context) { diagnostics.succeeded.push(context); },
    },
    location: { reload() { reloads += 1; } },
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
  };

  const context = {
    window: windowObject,
    document: documentObject,
    navigator: { onLine: true },
    AbortController,
    AbortSignal,
    URL,
    console,
    currentAccessToken: options.token || "participant-old",
    adminToken: "admin",
    currentRoomName: "main",
    controlUrlInput: { value: "https://echo.test" },
    identityInput: { value: "sam-device" },
    nameInput: { value: "Sam" },
    roomSwitchState: { heartbeatRoomName: () => "main" },
    _viewerVersion: "viewer-stamp",
    heartbeatTimer: null,
    roomStatusTimer: null,
    onlineUsersTimer: null,
    onlineUsersEl: null,
    roomListEl: null,
    FIXED_ROOMS: [],
    ROOM_DISPLAY_NAMES: {},
    previousDetectedRoom: null,
    previousRoomParticipants: {},
    _lastTokenPrefetch: 0,
    debugLog() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval(handler, delay) {
      const id = ++intervalId;
      intervals.set(id, { handler, delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    fetch: options.fetch || (async (url, init) => {
      fetchCalls.push({ url, init });
      if (queuedResponses.length === 0) throw new Error("No queued response");
      const next = queuedResponses.shift();
      return typeof next === "function" ? next(url, init) : next;
    }),
    ensureFreshParticipantToken: options.ensureFresh || (async (request) => {
      freshnessCalls.push(request);
      return { status: "current", token: context.currentAccessToken };
    }),
    prefetchRoomTokens() {},
    getControlUrl() { return "https://echo.test"; },
    escapeHtml(value) { return String(value); },
    getInitials() { return "S"; },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "room-status.js" });

  async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return {
    context,
    elements,
    intervals,
    fetchCalls,
    freshnessCalls,
    diagnostics,
    documentEvents,
    windowEvents,
    queuedResponses,
    settle,
    reloads: () => reloads,
    heartbeatTick() {
      const heartbeat = Array.from(intervals.values()).find((item) => item.delay === 10000);
      assert.ok(heartbeat, "heartbeat interval should be active");
      heartbeat.handler();
    },
  };
}

test("a current-token 401 refreshes once and retries heartbeat without reloading", async () => {
  let forced = 0;
  const harness = createHarness({
    responses: [response(401), response(200, { stale: false })],
    ensureFresh: async (request) => {
      harness.freshnessCalls.push(request);
      if (request.force) {
        forced += 1;
        harness.context.currentAccessToken = "participant-new";
        return { status: "refreshed", token: "participant-new" };
      }
      return { status: "current", token: harness.context.currentAccessToken };
    },
  });

  harness.context.startHeartbeat();
  await harness.settle();

  assert.equal(forced, 1);
  assert.equal(harness.fetchCalls.length, 2);
  assert.match(harness.fetchCalls[0].init.headers.Authorization, /participant-old$/);
  assert.match(harness.fetchCalls[1].init.headers.Authorization, /participant-new$/);
  assert.equal(harness.elements.has("stale-banner"), false);
  assert.equal(harness.elements.has("session-expired-banner"), false);
  assert.equal(harness.reloads(), 0);
  assert.equal(harness.diagnostics.succeeded.length, 1);
  assert.equal(harness.diagnostics.succeeded[0].controlUrl, "https://echo.test");
  assert.equal(harness.diagnostics.succeeded[0].token, "participant-new");
  harness.context.stopHeartbeat();
});

test("concurrent current-token 401 responses share one refresh and one retry", async () => {
  let releaseRefresh;
  const refresh = new Promise((resolve) => { releaseRefresh = resolve; });
  let forced = 0;
  const harness = createHarness({
    responses: [response(401), response(401), response(200, { stale: false })],
    ensureFresh: async (request) => {
      if (!request.force) return { status: "current", token: harness.context.currentAccessToken };
      forced += 1;
      await refresh;
      harness.context.currentAccessToken = "participant-new";
      return { status: "refreshed", token: "participant-new" };
    },
  });

  harness.context.startHeartbeat();
  harness.heartbeatTick();
  await harness.settle();
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(forced, 1);

  releaseRefresh();
  await harness.settle();
  assert.equal(harness.fetchCalls.length, 3);
  assert.equal(forced, 1);
  assert.match(harness.fetchCalls[2].init.headers.Authorization, /participant-new$/);
  harness.context.stopHeartbeat();
});

test("a late 401 from a superseded token is ignored", async () => {
  let resolveHeartbeat;
  const pendingHeartbeat = new Promise((resolve) => { resolveHeartbeat = resolve; });
  const harness = createHarness({
    fetch: async (url, init) => {
      harness.fetchCalls.push({ url, init });
      return pendingHeartbeat;
    },
  });

  harness.context.startHeartbeat();
  await harness.settle(2);
  harness.context.currentAccessToken = "participant-new";
  resolveHeartbeat(response(401));
  await harness.settle();

  assert.equal(harness.freshnessCalls.filter((call) => call.force).length, 0);
  assert.equal(harness.elements.has("stale-banner"), false);
  assert.equal(harness.elements.has("session-expired-banner"), false);
  harness.context.stopHeartbeat();
});

test("an authentication refresh failure reports session expiry without media reload", async () => {
  const authError = new Error("admin login rejected");
  authError.status = 401;
  const harness = createHarness({
    responses: [response(401)],
    ensureFresh: async (request) => request.force
      ? { status: "failed", error: authError }
      : { status: "current", token: "participant-old" },
  });

  harness.context.startHeartbeat();
  await harness.settle();

  assert.equal(harness.elements.has("session-expired-banner"), true);
  assert.equal(harness.elements.has("stale-banner"), false);
  assert.equal(harness.reloads(), 0);
  harness.context.stopHeartbeat();
});

test("network and server refresh failures remain retry-only", async () => {
  for (const error of [new TypeError("offline"), Object.assign(new Error("server"), { status: 503 })]) {
    const harness = createHarness({
      responses: [response(401)],
      ensureFresh: async (request) => request.force
        ? { status: "failed", error }
        : { status: "current", token: "participant-old" },
    });
    harness.context.startHeartbeat();
    await harness.settle();
    assert.equal(harness.elements.has("session-expired-banner"), false);
    assert.equal(harness.elements.has("stale-banner"), false);
    assert.equal(harness.reloads(), 0);
    harness.context.stopHeartbeat();
  }
});

test("a heartbeat 5xx is retry-only and cannot claim an update", async () => {
  const harness = createHarness({ responses: [response(503, { stale: true })] });

  harness.context.startHeartbeat();
  await harness.settle();

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.elements.has("session-expired-banner"), false);
  assert.equal(harness.elements.has("stale-banner"), false);
  assert.equal(harness.reloads(), 0);
  harness.context.stopHeartbeat();
});

test("only an authenticated stale true heartbeat starts the update reload", async () => {
  const harness = createHarness({ responses: [response(200, { stale: true })] });

  harness.context.startHeartbeat();
  await harness.settle();

  const banner = harness.elements.get("stale-banner");
  assert.ok(banner);
  assert.match(banner.innerHTML, /Echo was updated — reconnecting/);
  assert.equal(harness.elements.has("session-expired-banner"), false);
  assert.equal(harness.reloads(), 0);
  assert.equal(source.includes("The server is restarting"), false);
  assert.equal(source.includes("SpeechSynthesisUtterance"), false);
  assert.equal(source.includes("playStaleJazz"), false);
  harness.context.stopHeartbeat();
});

test("a later healthy heartbeat clears the session-expired message", async () => {
  const authError = Object.assign(new Error("expired"), { status: 403 });
  const harness = createHarness({
    responses: [response(401), response(200, { stale: false })],
    ensureFresh: async (request) => request.force
      ? { status: "failed", error: authError }
      : { status: "current", token: "participant-old" },
  });
  harness.context.startHeartbeat();
  await harness.settle();
  assert.equal(harness.elements.has("session-expired-banner"), true);

  harness.heartbeatTick();
  await harness.settle();
  assert.equal(harness.elements.has("session-expired-banner"), false);
  harness.context.stopHeartbeat();
});

test("visibility and online resume hooks are deduplicated and removed on stop", async () => {
  const harness = createHarness({
    responses: [
      response(200, { stale: false }),
      response(200, { stale: false }),
      response(200, { stale: false }),
    ],
  });

  harness.context.startHeartbeat();
  await harness.settle();
  assert.equal(harness.documentEvents.count("visibilitychange"), 1);
  assert.equal(harness.windowEvents.count("online"), 1);

  harness.context.startHeartbeat();
  await harness.settle();
  assert.equal(harness.documentEvents.count("visibilitychange"), 1);
  assert.equal(harness.windowEvents.count("online"), 1);

  harness.documentEvents.dispatch("visibilitychange");
  await harness.settle();
  assert.equal(harness.fetchCalls.length, 3);

  harness.context.stopHeartbeat();
  assert.equal(harness.documentEvents.count("visibilitychange"), 0);
  assert.equal(harness.windowEvents.count("online"), 0);
});
