"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const diagnostics = require("./diagnostics-client.js");

const {
  CONSENT_KEY,
  INSTALL_KEY,
  QUEUE_KEY,
  STATUS_KEY,
  ACTIVE_KEY,
  CANARY_QUERY_PARAM,
  CONSENT_ENABLED,
  CONSENT_DISABLED,
  MAX_ENVELOPES,
  MAX_ENVELOPE_BYTES,
  MAX_QUEUE_BYTES,
  QUEUE_TTL_MS,
} = diagnostics.constants;

const BASE_TIME = 1_784_660_000_000;
const SCOPE_A = "a".repeat(64);
const SCOPE_B = "b".repeat(64);

class MemoryStorage {
  constructor(initial) {
    this.values = new Map();
    this.writes = [];
    this.removes = [];
    Object.entries(initial || {}).forEach(([key, value]) => {
      this.values.set(String(key), String(value));
    });
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key) {
    key = String(key);
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    key = String(key);
    value = String(value);
    this.values.set(key, value);
    this.writes.push({ key, value });
  }

  removeItem(key) {
    key = String(key);
    this.values.delete(key);
    this.removes.push(key);
  }

  dump() {
    return JSON.stringify(Object.fromEntries(this.values));
  }
}

class MemoryEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (listeners) listeners.delete(listener);
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  count(type) {
    return (this.listeners.get(type) || new Set()).size;
  }
}

class MemoryTimers {
  constructor() {
    this.nextId = 1;
    this.timeouts = new Map();
    this.intervals = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) {
    this.timeouts.delete(id);
  }

  setInterval(callback, delay) {
    const id = this.nextId++;
    this.intervals.set(id, { callback, delay });
    return id;
  }

  clearInterval(id) {
    this.intervals.delete(id);
  }
}

function uuidFor(number, uppercase) {
  const suffix = Number(number).toString(16).padStart(12, "0");
  const value = `00000000-0000-4000-8000-${suffix}`;
  return uppercase ? value.toUpperCase() : value;
}

function deterministicCrypto(options) {
  const opts = options || {};
  let next = opts.start || 1;
  return {
    randomUUID() {
      if (opts.throwRandomUuid) throw new Error("secure random source failed");
      if (opts.invalidRandomUuid) return "not-a-uuid";
      return uuidFor(next++, opts.uppercase);
    },
  };
}

function getRandomValuesCrypto() {
  let counter = 0;
  return {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (counter + index + 1) & 0xff;
      }
      counter += bytes.length;
      return bytes;
    },
  };
}

class FetchHarness {
  constructor(plan) {
    this.plan = Array.from(plan || []);
    this.calls = [];
  }

  async fetch(url, init) {
    const captured = {
      url: String(url),
      method: init && init.method,
      headers: init && { ...init.headers },
      body: init && init.body,
      cache: init && init.cache,
    };
    this.calls.push(captured);
    const next = this.plan.length ? this.plan.shift() : { status: 503 };
    if (next && next.error) throw next.error;
    const headers = new Map(
      Object.entries((next && next.headers) || {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    };
  }
}

class DeferredFetchHarness extends FetchHarness {
  constructor() {
    super();
    this.pending = [];
  }

  async fetch(url, init) {
    this.calls.push({
      url: String(url),
      method: init && init.method,
      headers: init && { ...init.headers },
      body: init && init.body,
      cache: init && init.cache,
    });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  respond(status) {
    const pending = this.pending.shift();
    assert.ok(pending, "expected a pending fetch");
    pending.resolve({ status, ok: status >= 200 && status < 300, headers: { get: () => null } });
  }

  reject(error) {
    const pending = this.pending.shift();
    assert.ok(pending, "expected a pending fetch");
    pending.reject(error || new Error("network unavailable"));
  }
}

function validMetadata(overrides) {
  const base = {
    app: {
      version: "0.6.33.1784660000",
      git_sha: "ceaaf6f1",
      channel: "web-canary",
      runtimes: {
        browser_name: "Safari",
        browser_version: "18.5",
        livekit_version: "2.15.3",
      },
    },
    platform: {
      client_kind: "browser",
      operating_system: "macos",
      architecture: "unknown",
    },
  };
  if (!overrides) return base;
  return {
    app: { ...base.app, ...(overrides.app || {}) },
    platform: { ...base.platform, ...(overrides.platform || {}) },
  };
}

function createHarness(options) {
  const opts = options || {};
  const storage = opts.storage || new MemoryStorage(opts.initialStorage);
  const eventTarget = opts.eventTarget || new MemoryEventTarget();
  const timers = opts.timers || new MemoryTimers();
  const fetchHarness = opts.fetchHarness || new FetchHarness(opts.responses);
  const crypto = opts.crypto || deterministicCrypto({ uppercase: opts.uppercaseUuids });
  let currentTime = opts.now || BASE_TIME;
  const metadata = Object.prototype.hasOwnProperty.call(opts, "metadata")
    ? opts.metadata
    : validMetadata();
  const metadataProvider = opts.metadataProvider || (async () => metadata);
  const scopeDigest = opts.useDefaultScopeDigest ? undefined : (opts.scopeDigest || (async (token) => (
    String(token).includes("scope-b") ? SCOPE_B : SCOPE_A
  )));

  const collector = diagnostics.createCollector({
    storage,
    crypto,
    fetch: fetchHarness.fetch.bind(fetchHarness),
    now: () => currentTime,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    setInterval: timers.setInterval.bind(timers),
    clearInterval: timers.clearInterval.bind(timers),
    metadataProvider,
    ...(scopeDigest ? { scopeDigest } : {}),
    eventTarget,
  });

  return {
    collector,
    storage,
    eventTarget,
    timers,
    fetchHarness,
    crypto,
    now: () => currentTime,
    advance(milliseconds) {
      currentTime += milliseconds;
      return currentTime;
    },
  };
}

function readQueue(storage, now) {
  return diagnostics.parseQueue(storage.getItem(QUEUE_KEY), now || BASE_TIME);
}

function readStatus(storage) {
  return JSON.parse(storage.getItem(STATUS_KEY) || "null");
}

function interceptNextStorageMutation(storage, method, key, afterMutation) {
  const original = storage[method].bind(storage);
  let armed = false;
  let fired = false;
  storage[method] = function (...args) {
    const result = original(...args);
    if (armed && !fired && String(args[0]) === key) {
      fired = true;
      afterMutation();
    }
    return result;
  };
  return {
    arm() { armed = true; },
    fired() { return fired; },
  };
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).length;
}

function jwtForSubject(subject) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub: subject })}.signature`;
}

function makeEnvelope(options) {
  const opts = options || {};
  const eventCount = opts.eventCount || 1;
  const capturedAt = opts.capturedAt || BASE_TIME;
  const details = opts.details || { connection_state: "connected" };
  const events = [];
  for (let index = 0; index < eventCount; index += 1) {
    events.push({
      sequence: index + 1,
      timestamp_ms: capturedAt + index,
      event_type: "connection",
      severity: "info",
      code: "connection.connected",
      details: { ...details },
    });
  }
  return JSON.stringify({
    schema_version: 1,
    envelope_id: opts.envelopeId || uuidFor(opts.number || 100),
    install_id: opts.installId || uuidFor(200),
    session_id: opts.sessionId || uuidFor(300),
    captured_at_ms: capturedAt,
    sent_at_ms: capturedAt + eventCount,
    app: validMetadata().app,
    platform: validMetadata().platform,
    events,
  });
}

function queueDocument(envelopes, options) {
  const opts = options || {};
  return JSON.stringify({
    version: 1,
    revision: 1,
    writer: "",
    draft: opts.draft || null,
    envelopes: envelopes.map((body, index) => ({
      body,
      created_at_ms: (opts.createdAt || BASE_TIME) + index,
      scope: opts.scope === undefined ? SCOPE_A : opts.scope,
      attempts: 0,
      next_attempt_ms: 0,
    })),
  });
}

test("desktop Mac browser gating excludes native shell, iPad masquerade, and non-Mac browsers", () => {
  assert.equal(diagnostics.isDesktopMacBrowser({
    __ECHO_NATIVE__: false,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 },
  }), true);
  assert.equal(diagnostics.isDesktopMacBrowser({
    __ECHO_NATIVE__: true,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 0 },
  }), false);
  assert.equal(diagnostics.isDesktopMacBrowser({
    __ECHO_NATIVE__: false,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 5 },
  }), false);
  assert.equal(diagnostics.isDesktopMacBrowser({
    __ECHO_NATIVE__: false,
    navigator: { platform: "iPad", userAgent: "Mozilla/5.0 (Macintosh; Mac OS X)", maxTouchPoints: 5 },
  }), false);
  assert.equal(diagnostics.isDesktopMacBrowser({
    __ECHO_NATIVE__: false,
    navigator: { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)", maxTouchPoints: 0 },
  }), false);

  const nativeStorage = new MemoryStorage();
  const nativeEnvironment = {
    __ECHO_NATIVE__: true,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 0 },
    localStorage: nativeStorage,
  };
  assert.equal(diagnostics.installBrowserRuntime(nativeEnvironment), null);
  assert.equal(nativeStorage.writes.length, 0);

  for (const environment of [
    {
      __ECHO_NATIVE__: true,
      navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 0 },
    },
    {
      __ECHO_NATIVE__: false,
      navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 5 },
    },
    {
      __ECHO_NATIVE__: false,
      navigator: { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)", maxTouchPoints: 0 },
    },
  ]) {
    const storage = new MemoryStorage();
    Object.assign(environment, {
      URLSearchParams,
      location: { search: "?echoWebDiagnosticsCanary=1" },
      localStorage: storage,
    });
    assert.equal(diagnostics.installBrowserRuntime(environment), null);
    assert.equal(storage.writes.length, 0);
  }

  assert.equal(diagnostics.installBrowserRuntime({
    __ECHO_NATIVE__: false,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 0 },
    URLSearchParams,
    location: { search: "?echoWebDiagnosticsCanary=1" },
    localStorage: null,
  }), null);
});

test("web diagnostics canary enrollment requires an exact invite or persisted consent", () => {
  const emptyStorage = new MemoryStorage();
  const replacements = [];
  const environment = {
    URLSearchParams,
    location: {
      pathname: "/viewer/",
      search: "?echo-ui-shell-v2=1&echoWebDiagnosticsCanary=1",
      hash: "#test-room",
    },
    history: {
      state: { retained: true },
      replaceState(state, title, url) { replacements.push({ state, title, url }); },
    },
  };

  assert.equal(diagnostics.isWebDiagnosticsCanaryEnrolled(environment, emptyStorage), true);
  assert.equal(emptyStorage.writes.length, 0);
  assert.equal(diagnostics.clearWebDiagnosticsCanaryInvite(environment), true);
  assert.deepEqual(replacements, [{
    state: { retained: true },
    title: "",
    url: "/viewer/?echo-ui-shell-v2=1#test-room",
  }]);

  for (const search of [
    "",
    "?echoWebDiagnosticsCanary=0",
    "?echowebdiagnosticscanary=1",
    "?echoWebDiagnosticsCanary=1&echoWebDiagnosticsCanary=1",
    "?echoWebDiagnosticsCanary=1&echoWebDiagnosticsCanary=0",
  ]) {
    assert.equal(diagnostics.isWebDiagnosticsCanaryEnrolled({
      URLSearchParams,
      location: { search },
    }, emptyStorage), false, `unexpected enrollment for ${search || "empty query"}`);
  }

  assert.equal(CANARY_QUERY_PARAM, "echoWebDiagnosticsCanary");
  assert.equal(diagnostics.isWebDiagnosticsCanaryEnrolled({}, new MemoryStorage({
    [CONSENT_KEY]: CONSENT_ENABLED,
  })), true);
  assert.equal(diagnostics.isWebDiagnosticsCanaryEnrolled({}, new MemoryStorage({
    [CONSENT_KEY]: CONSENT_DISABLED,
  })), true);
  assert.equal(diagnostics.isWebDiagnosticsCanaryEnrolled({}, new MemoryStorage({
    [CONSENT_KEY]: "corrupt-v99",
  })), false);
  assert.equal(diagnostics.isWebDiagnosticsCanaryEnrolled(environment, null), false);
  assert.equal(diagnostics.isWebDiagnosticsCanaryEnrolled(environment, { getItem() { return null; } }), false);
  assert.equal(diagnostics.isWebDiagnosticsCanaryEnrolled(environment, {
    getItem() { throw new Error("storage blocked"); },
    setItem() {},
    removeItem() {},
  }), false);

  assert.equal(diagnostics.installBrowserRuntime({
    __ECHO_NATIVE__: false,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 0 },
    URLSearchParams,
    location: { search: "?echoWebDiagnosticsCanary=1" },
    get localStorage() { throw new Error("storage blocked"); },
  }), null);
});

test("secure UUID generation is canonical lowercase and fails closed without secure randomness", async (t) => {
  assert.match(diagnostics.secureUuid(deterministicCrypto({ uppercase: true })), /^[0-9a-f-]{36}$/);
  assert.match(diagnostics.secureUuid(getRandomValuesCrypto()), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(diagnostics.secureUuid({}), null);
  assert.equal(diagnostics.secureUuid(deterministicCrypto({ invalidRandomUuid: true })), null);

  await t.test("collector stays off when no secure UUID source exists", async () => {
    const storage = new MemoryStorage();
    const harness = createHarness({ storage, crypto: {} });
    assert.equal(await harness.collector.enable(), false);
    assert.equal(harness.collector.snapshot().enabled, false);
    assert.equal(storage.getItem(INSTALL_KEY), null);
    assert.equal(storage.getItem(QUEUE_KEY), null);
    assert.equal(harness.fetchHarness.calls.length, 0);
  });
});

test("absent or corrupt consent is OFF and nothing writes or uses the network before explicit enable", async () => {
  const storage = new MemoryStorage({ [CONSENT_KEY]: "corrupt-v99" });
  const harness = createHarness({ storage });
  assert.equal(harness.collector.consentState(), "unset");
  assert.equal(harness.collector.recordLegacyEvent("room-disconnect"), false);
  assert.equal(harness.collector.recordPermission("microphone", false, "NotAllowedError"), false);
  assert.equal(harness.collector.recordMedia("camera", "start", "failed", "NotReadableError"), false);
  assert.equal(harness.collector.recordConnectionState("failed", "AbortError"), false);
  assert.equal(await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control-before-enable.invalid/private",
    token: "before-enable-token",
  }), false);
  assert.equal(storage.writes.length, 0);
  assert.equal(harness.fetchHarness.calls.length, 0);
  assert.equal(storage.getItem(QUEUE_KEY), null);
});

test("invalid build metadata fails closed before handlers, queueing, or upload", async () => {
  const harness = createHarness({ metadata: validMetadata({ app: { git_sha: "not-a-sha" } }) });
  assert.equal(await harness.collector.enable(), false);
  const snapshot = harness.collector.snapshot();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.authenticated, false);
  assert.equal(harness.eventTarget.count("error"), 0);
  assert.equal(harness.storage.getItem(QUEUE_KEY), null);
  assert.equal(readStatus(harness.storage).code, "metadata_unavailable");
  assert.equal(await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.invalid",
    token: "metadata-failure-token",
  }), false);
  assert.equal(harness.fetchHarness.calls.length, 0);
});

test("global adapters never read raw error text, stack, source, or rejection reason", async () => {
  const forbidden = [
    "FORBIDDEN-MESSAGE-9fd3",
    "Bearer secret.jwt.value",
    "person@example.invalid",
    "192.0.2.77",
    "F:\\private\\trace.log",
    "https://example.invalid/api?token=secret",
    "a=candidate:1 1 udp 1 192.0.2.88 50000 typ host",
    "private-identity-7475",
  ];
  const reads = { message: 0, stack: 0, filename: 0, source: 0, reason: 0 };
  const errorObject = { name: "TypeError" };
  Object.defineProperty(errorObject, "message", {
    get() { reads.message += 1; throw new Error(forbidden[0]); },
  });
  Object.defineProperty(errorObject, "stack", {
    get() { reads.stack += 1; throw new Error(forbidden[1]); },
  });
  const errorEvent = { error: errorObject, lineno: 17, colno: 23 };
  Object.defineProperty(errorEvent, "filename", {
    get() { reads.filename += 1; throw new Error(forbidden[5]); },
  });
  Object.defineProperty(errorEvent, "source", {
    get() { reads.source += 1; throw new Error(forbidden[6]); },
  });
  const rejectionEvent = {};
  Object.defineProperty(rejectionEvent, "reason", {
    get() { reads.reason += 1; throw new Error(forbidden.join(" ")); },
  });

  const harness = createHarness({ responses: [{ status: 503 }] });
  assert.equal(await harness.collector.enable(), true);
  harness.eventTarget.dispatch("error", errorEvent);
  harness.eventTarget.dispatch("unhandledrejection", rejectionEvent);
  assert.deepEqual(reads, { message: 0, stack: 0, filename: 0, source: 0, reason: 0 });

  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "memory-only-adapter-token",
  });
  assert.equal(harness.fetchHarness.calls.length, 1);
  const persisted = harness.storage.dump();
  const body = harness.fetchHarness.calls[0].body;
  for (const value of forbidden) {
    assert.equal(persisted.includes(value), false, `storage leaked ${value}`);
    assert.equal(body.includes(value), false, `wire body leaked ${value}`);
  }
  assert.equal(body.includes("message"), false);
  assert.equal(body.includes("fingerprint"), false);
  const sent = JSON.parse(body);
  const error = sent.events.find((event) => event.event_type === "javascript_error");
  assert.equal(error.details.error_code, "type_error");
  assert.equal(error.details.line, 17);
  assert.equal(error.details.column, 23);
});

test("heartbeat is the only upload release and token/control URL remain memory-only", async () => {
  const token = "TOKEN-MUST-NEVER-PERSIST-6d30";
  const controlUrl = "https://private-control.example.test/some/path";
  const harness = createHarness({ responses: [{ status: 503 }] });
  assert.equal(await harness.collector.enable(), true);
  harness.collector.recordPermission("microphone", false, "NotAllowedError");
  assert.equal(harness.fetchHarness.calls.length, 0);

  await harness.collector.heartbeatSucceeded({ controlUrl, token });
  assert.equal(harness.fetchHarness.calls.length, 1);
  assert.equal(harness.fetchHarness.calls[0].url, "https://private-control.example.test/api/diagnostics/v1/envelopes");
  assert.equal(harness.fetchHarness.calls[0].headers.Authorization, `Bearer ${token}`);
  const persisted = harness.storage.dump();
  assert.equal(persisted.includes(token), false);
  assert.equal(persisted.includes("private-control.example.test"), false);
  assert.equal(persisted.includes("some/path"), false);

  harness.collector.invalidateHeartbeat();
  assert.equal(harness.collector.snapshot().authenticated, false);
  assert.equal(await harness.collector.sendNow(), false);
  assert.equal(harness.fetchHarness.calls.length, 1);
});

for (const successStatus of [202, 200]) {
  test(`${successStatus} acknowledgement deletes the sealed envelope`, async () => {
    const harness = createHarness({ responses: [{ status: successStatus }] });
    assert.equal(await harness.collector.enable(), true);
    assert.equal(await harness.collector.heartbeatSucceeded({
      controlUrl: "https://control.example.test",
      token: `ack-${successStatus}`,
    }), true);
    assert.equal(harness.fetchHarness.calls.length, 1);
    assert.equal(harness.collector.snapshot().sealed, 0);
    assert.equal(harness.collector.snapshot().queued, 0);
    assert.equal(readStatus(harness.storage).code, successStatus === 202 ? "accepted" : "duplicate");
  });
}

test("sealed request bytes remain identical across a 5xx retry", async () => {
  const harness = createHarness({ responses: [{ status: 503 }, { status: 202 }] });
  assert.equal(await harness.collector.enable(), true);
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "retry-scope-a",
  });
  assert.equal(harness.fetchHarness.calls.length, 1);
  const firstBody = harness.fetchHarness.calls[0].body;
  const queuedAfterFailure = readQueue(harness.storage, harness.now());
  assert.equal(queuedAfterFailure.envelopes.length, 1);
  assert.equal(queuedAfterFailure.envelopes[0].body, firstBody);
  assert.equal(queuedAfterFailure.envelopes[0].attempts, 1);
  assert.equal(readStatus(harness.storage).code, "retry_wait");

  harness.advance(5_000);
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "retry-scope-a",
  });
  assert.equal(harness.fetchHarness.calls.length, 2);
  assert.equal(harness.fetchHarness.calls[1].body, firstBody);
  assert.equal(harness.collector.snapshot().sealed, 0);
});

test("401 waits for a new heartbeat without deleting or looping", async () => {
  const harness = createHarness({ responses: [{ status: 401 }, { status: 202 }] });
  await harness.collector.enable();
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "expired-participant-token",
  });
  assert.equal(harness.fetchHarness.calls.length, 1);
  assert.equal(harness.collector.snapshot().sealed, 1);
  assert.equal(harness.collector.snapshot().authenticated, false);
  assert.equal(readStatus(harness.storage).code, "auth_wait");
  assert.equal(await harness.collector.sendNow(), false);
  assert.equal(harness.fetchHarness.calls.length, 1);
});

test("404 disables uploads for the rest of the page without deleting the queue", async () => {
  const harness = createHarness({ responses: [{ status: 404 }, { status: 202 }] });
  await harness.collector.enable();
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "disabled-server-token",
  });
  assert.equal(harness.fetchHarness.calls.length, 1);
  assert.equal(harness.collector.snapshot().sealed, 1);
  assert.equal(readStatus(harness.storage).code, "server_disabled");
  harness.advance(1_000);
  assert.equal(await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "new-disabled-server-token",
  }), false);
  assert.equal(harness.fetchHarness.calls.length, 1);
  assert.equal(harness.collector.snapshot().sealed, 1);
});

for (const terminalStatus of [400, 409, 413, 422]) {
  test(`${terminalStatus} drops the terminal envelope and does not hot-loop`, async () => {
    const harness = createHarness({ responses: [{ status: terminalStatus }, { status: 202 }] });
    await harness.collector.enable();
    await harness.collector.heartbeatSucceeded({
      controlUrl: "https://control.example.test",
      token: `terminal-${terminalStatus}`,
    });
    assert.equal(harness.fetchHarness.calls.length, 1);
    assert.equal(harness.collector.snapshot().sealed, 0);
    assert.equal(readStatus(harness.storage).code, terminalStatus === 409 ? "conflict_dropped" : "invalid_dropped");
    await harness.collector.heartbeatSucceeded({
      controlUrl: "https://control.example.test",
      token: `terminal-${terminalStatus}`,
    });
    assert.equal(harness.fetchHarness.calls.length, 1);
  });
}

test("429 honors Retry-After and retries the exact sealed bytes only after the window", async () => {
  const harness = createHarness({
    responses: [
      { status: 429, headers: { "Retry-After": "9" } },
      { status: 202 },
    ],
  });
  await harness.collector.enable();
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "rate-limit-token",
  });
  const firstBody = harness.fetchHarness.calls[0].body;
  const queued = readQueue(harness.storage, harness.now());
  assert.equal(queued.envelopes[0].next_attempt_ms, harness.now() + 9_000);
  assert.equal(readStatus(harness.storage).code, "rate_limited");

  harness.advance(8_999);
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "rate-limit-token",
  });
  assert.equal(harness.fetchHarness.calls.length, 1);
  harness.advance(1);
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "rate-limit-token",
  });
  assert.equal(harness.fetchHarness.calls.length, 2);
  assert.equal(harness.fetchHarness.calls[1].body, firstBody);
});

test("a sealed envelope never crosses participant scope", async () => {
  const harness = createHarness({ responses: [{ status: 503 }, { status: 202 }] });
  await harness.collector.enable();
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "participant-scope-a",
  });
  assert.equal(harness.fetchHarness.calls.length, 1);
  const body = harness.fetchHarness.calls[0].body;
  const queueA = readQueue(harness.storage, harness.now());
  assert.equal(queueA.envelopes[0].scope, SCOPE_A);
  assert.equal(queueA.envelopes[0].body, body);

  harness.advance(5_000);
  assert.equal(await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "participant-scope-b",
  }), false);
  assert.equal(harness.fetchHarness.calls.length, 1);
  assert.equal(harness.collector.snapshot().sealed, 1);

  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "participant-scope-a-refreshed",
  });
  assert.equal(harness.fetchHarness.calls.length, 2);
  assert.equal(harness.fetchHarness.calls[1].body, body);
});

test("a sealed envelope never crosses control origins even when the JWT subject matches", async () => {
  const harness = createHarness({
    responses: [{ status: 503 }, { status: 202 }],
    scopeDigest: async (_token, _installId, origin) => (
      origin === "https://control-a.example.test" ? SCOPE_A : SCOPE_B
    ),
  });
  await harness.collector.enable();
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control-a.example.test/room",
    token: "same-subject-token",
  });
  assert.equal(harness.fetchHarness.calls.length, 1);
  const body = harness.fetchHarness.calls[0].body;
  assert.equal(readQueue(harness.storage, harness.now()).envelopes[0].scope, SCOPE_A);

  harness.advance(5_000);
  assert.equal(await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control-b.example.test/room",
    token: "same-subject-token",
  }), false);
  assert.equal(harness.fetchHarness.calls.length, 1);

  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control-a.example.test/room",
    token: "same-subject-token",
  });
  assert.equal(harness.fetchHarness.calls.length, 2);
  assert.equal(harness.fetchHarness.calls[1].body, body);
});

test("the default scope digest is stable per install, subject, and normalized control origin", async () => {
  async function scopeFor(controlUrl) {
    const crypto = deterministicCrypto({ start: 1200 });
    crypto.subtle = webcrypto.subtle;
    const harness = createHarness({
      crypto,
      useDefaultScopeDigest: true,
      responses: [{ status: 503 }],
    });
    await harness.collector.enable();
    await harness.collector.heartbeatSucceeded({
      controlUrl,
      token: jwtForSubject("same-participant"),
    });
    return readQueue(harness.storage, harness.now()).envelopes[0].scope;
  }

  const first = await scopeFor("https://control-a.example.test/one");
  const sameOrigin = await scopeFor("https://control-a.example.test/two");
  const otherOrigin = await scopeFor("https://control-b.example.test/one");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, sameOrigin);
  assert.notEqual(first, otherOrigin);
});

test("credential changes seal the old scope and rotate the diagnostics session", async () => {
  const harness = createHarness({ responses: [{ status: 503 }, { status: 202 }] });
  await harness.collector.enable();
  const initialSession = readQueue(harness.storage, harness.now()).draft.session_id;
  assert.equal(harness.collector.credentialBoundary(), true, "first credential adopts the page session");
  assert.equal(readQueue(harness.storage, harness.now()).draft.session_id, initialSession);

  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "participant-scope-a",
  });
  harness.collector.recordMedia("camera", "enable", "enabled", null);
  assert.equal(harness.collector.credentialBoundary(), true);
  const rotatedSession = readQueue(harness.storage, harness.now()).draft.session_id;
  assert.notEqual(rotatedSession, initialSession);

  harness.collector.recordConnectionState("connecting", null);
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "participant-scope-b",
  });
  assert.equal(harness.fetchHarness.calls.length, 2);
  const secondEnvelope = JSON.parse(harness.fetchHarness.calls[1].body);
  assert.equal(secondEnvelope.session_id, rotatedSession);
  assert.notEqual(secondEnvelope.session_id, initialSession);

  const remaining = readQueue(harness.storage, harness.now()).envelopes;
  assert.ok(remaining.length >= 1);
  assert.ok(remaining.every((item) => item.scope === SCOPE_A));
  assert.ok(remaining.every((item) => JSON.parse(item.body).session_id === initialSession));
});

test("an already-connected replacement rotates even before diagnostics sees its first heartbeat", async () => {
  const harness = createHarness({ responses: [{ status: 202 }] });
  await harness.collector.enable();
  const initialSession = readQueue(harness.storage, harness.now()).draft.session_id;

  assert.equal(harness.collector.credentialBoundary(true), true);
  const afterBoundary = readQueue(harness.storage, harness.now());
  assert.notEqual(afterBoundary.draft.session_id, initialSession);
  assert.ok(afterBoundary.envelopes.some((item) => (
    item.scope === null && JSON.parse(item.body).session_id === initialSession
  )));

  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://replacement.example.test",
    token: "participant-scope-b",
  });
  assert.equal(harness.fetchHarness.calls.length, 1);
  const sent = JSON.parse(harness.fetchHarness.calls[0].body);
  assert.equal(sent.session_id, afterBoundary.draft.session_id);
  const remaining = readQueue(harness.storage, harness.now()).envelopes;
  assert.ok(remaining.some((item) => item.scope === null));
});

test("queue parsing enforces TTL, count, total byte bounds, and corrupt-body rejection", () => {
  const freshBody = makeEnvelope({ number: 401 });
  const oldBody = makeEnvelope({ number: 402, capturedAt: BASE_TIME - QUEUE_TTL_MS - 10_000 });
  const ttlRaw = JSON.stringify({
    version: 1,
    revision: 1,
    writer: "",
    draft: null,
    envelopes: [
      { body: oldBody, created_at_ms: BASE_TIME - QUEUE_TTL_MS - 1, scope: SCOPE_A, attempts: 0, next_attempt_ms: 0 },
      { body: freshBody, created_at_ms: BASE_TIME, scope: SCOPE_A, attempts: 0, next_attempt_ms: 0 },
    ],
  });
  assert.deepEqual(diagnostics.parseQueue("not-json", BASE_TIME).envelopes, []);
  const ttlQueue = diagnostics.parseQueue(ttlRaw, BASE_TIME);
  assert.equal(ttlQueue.envelopes.length, 1);
  assert.equal(ttlQueue.envelopes[0].body, freshBody);

  const manyBodies = Array.from({ length: MAX_ENVELOPES + 4 }, (_, index) => (
    makeEnvelope({ number: 500 + index })
  ));
  const countQueue = diagnostics.parseQueue(queueDocument(manyBodies), BASE_TIME + 100);
  assert.equal(countQueue.envelopes.length, MAX_ENVELOPES);
  assert.equal(JSON.parse(countQueue.envelopes[0].body).envelope_id, uuidFor(504));

  const detailKeys = [
    "action", "actual", "attempt", "audio", "browser", "camera", "clean", "column",
    "connection_state", "count", "current", "denied", "device_count", "device_kind",
    "direction", "duration_ms", "enabled", "ended", "error_code", "expected", "failure_stage",
    "granted", "kind", "line", "media_kind", "microphone", "operation", "output",
    "permission", "permission_state", "phase", "previous",
  ];
  const denseDetails = Object.fromEntries(detailKeys.map((key) => [key, `a${"x".repeat(62)}`]));
  let denseBody = null;
  for (let eventCount = 50; eventCount >= 1; eventCount -= 1) {
    const candidate = makeEnvelope({ number: 700, eventCount, details: denseDetails });
    if (utf8Bytes(candidate) <= MAX_ENVELOPE_BYTES && utf8Bytes(candidate) > MAX_QUEUE_BYTES / MAX_ENVELOPES) {
      denseBody = candidate;
      break;
    }
  }
  assert.ok(denseBody, "fixture should exercise aggregate queue byte eviction");
  const denseBodies = Array.from({ length: MAX_ENVELOPES }, (_, index) => {
    const parsed = JSON.parse(denseBody);
    parsed.envelope_id = uuidFor(800 + index);
    return JSON.stringify(parsed);
  });
  const byteQueue = diagnostics.parseQueue(queueDocument(denseBodies), BASE_TIME + 100);
  assert.ok(byteQueue.envelopes.reduce((sum, item) => sum + utf8Bytes(item.body), 0) <= MAX_QUEUE_BYTES);
  assert.ok(byteQueue.envelopes.length < MAX_ENVELOPES);
  const persistedQueueBytes = utf8Bytes(JSON.stringify(byteQueue));
  assert.ok(
    persistedQueueBytes <= MAX_QUEUE_BYTES,
    `persisted queue document must stay within the hard byte cap (${persistedQueueBytes} > ${MAX_QUEUE_BYTES})`,
  );

  const mixedRaw = JSON.stringify({
    version: 1,
    revision: 1,
    writer: "",
    draft: null,
    envelopes: [
      { body: "{", created_at_ms: BASE_TIME, scope: SCOPE_A, attempts: 0, next_attempt_ms: 0 },
      { body: freshBody, created_at_ms: BASE_TIME, scope: SCOPE_A, attempts: 0, next_attempt_ms: 0 },
      { body: JSON.stringify({ secret: "FORBIDDEN-CORRUPT-BODY" }), created_at_ms: BASE_TIME, scope: SCOPE_A, attempts: 0, next_attempt_ms: 0 },
    ],
  });
  const mixed = diagnostics.parseQueue(mixedRaw, BASE_TIME);
  assert.equal(mixed.envelopes.length, 1);
  assert.equal(mixed.envelopes[0].body, freshBody);
});

test("a malformed persisted body is discarded before fetch", async () => {
  const harness = createHarness({ responses: [{ status: 202 }] });
  await harness.collector.enable();
  harness.storage.setItem(QUEUE_KEY, JSON.stringify({
    version: 1,
    revision: 9,
    writer: "",
    draft: null,
    envelopes: [{
      body: "{\"token\":\"FORBIDDEN-MALFORMED\"}",
      created_at_ms: harness.now(),
      scope: SCOPE_A,
      attempts: 0,
      next_attempt_ms: 0,
    }],
  }));
  assert.equal(await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "malformed-body-token",
  }), false);
  assert.equal(harness.fetchHarness.calls.length, 0);
  assert.equal(harness.collector.snapshot().sealed, 0);
});

test("opt-out persists OFF, detaches handlers, and deletes only diagnostics-owned data", async () => {
  const storage = new MemoryStorage({ unrelated_application_key: "keep-me" });
  const harness = createHarness({ storage, responses: [{ status: 401 }] });
  await harness.collector.enable();
  assert.equal(harness.eventTarget.count("error"), 1);
  harness.collector.recordPermission("camera", false, "NotAllowedError");
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "opt-out-token",
  });
  assert.ok(storage.getItem(INSTALL_KEY));
  assert.ok(storage.getItem(QUEUE_KEY));
  assert.ok(storage.getItem(STATUS_KEY));
  assert.ok(storage.getItem(ACTIVE_KEY));

  storage.removes.length = 0;
  harness.collector.disable();
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(INSTALL_KEY), null);
  assert.equal(storage.getItem(QUEUE_KEY), null);
  assert.equal(storage.getItem(STATUS_KEY), null);
  assert.equal(storage.getItem(ACTIVE_KEY), null);
  assert.equal(storage.getItem("unrelated_application_key"), "keep-me");
  assert.deepEqual(new Set(storage.removes), new Set([INSTALL_KEY, QUEUE_KEY, STATUS_KEY, ACTIVE_KEY]));
  assert.equal(harness.eventTarget.count("error"), 0);
  assert.equal(harness.eventTarget.count("unhandledrejection"), 0);
  assert.equal(harness.eventTarget.count("pagehide"), 0);
  assert.equal(harness.eventTarget.count("pageshow"), 0);
  assert.equal(harness.collector.snapshot().enabled, false);
});

test("a delayed tab cannot recreate its queue after another tab opts out", async () => {
  const storage = new MemoryStorage({ unrelated_application_key: "keep-me" });
  const staleTab = createHarness({ storage });
  const optingOutTab = createHarness({ storage });
  await staleTab.collector.enable();
  assert.ok(storage.getItem(QUEUE_KEY));

  optingOutTab.collector.disable();
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(QUEUE_KEY), null);

  // Deliberately do not deliver a storage event to the stale tab.
  staleTab.collector.recordDeviceCounts({ microphone: 1, camera: 1, output: 1 });
  assert.equal(staleTab.collector.snapshot().enabled, false);
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(INSTALL_KEY), null);
  assert.equal(storage.getItem(QUEUE_KEY), null);
  assert.equal(storage.getItem(STATUS_KEY), null);
  assert.equal(storage.getItem(ACTIVE_KEY), null);
  assert.equal(storage.getItem("unrelated_application_key"), "keep-me");
  assert.equal(staleTab.fetchHarness.calls.length, 0);
});

test("a delayed tab cannot recreate its active sentinel after another tab opts out", async () => {
  const storage = new MemoryStorage();
  const staleTab = createHarness({ storage });
  const optingOutTab = createHarness({ storage });
  await staleTab.collector.enable();
  const sessionRefresh = Array.from(staleTab.timers.intervals.values())
    .find((timer) => timer.delay === 10000);
  assert.ok(sessionRefresh);

  optingOutTab.collector.disable();
  sessionRefresh.callback();

  assert.equal(staleTab.collector.snapshot().enabled, false);
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(INSTALL_KEY), null);
  assert.equal(storage.getItem(QUEUE_KEY), null);
  assert.equal(storage.getItem(STATUS_KEY), null);
  assert.equal(storage.getItem(ACTIVE_KEY), null);
});

test("a delayed tab rechecks shared consent immediately before starting fetch", async () => {
  const storage = new MemoryStorage();
  const staleTab = createHarness({ storage, responses: [{ status: 202 }] });
  const optingOutTab = createHarness({ storage });
  await staleTab.collector.enable();
  assert.equal(await staleTab.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "shared-consent-token",
  }), true);
  assert.equal(staleTab.fetchHarness.calls.length, 1);

  staleTab.collector.recordDeviceCounts({ microphone: 1, camera: 1, output: 1 });
  assert.equal(staleTab.collector._sealDraft(), true);
  assert.equal(staleTab.collector.snapshot().sealed, 1);

  const originalGetItem = storage.getItem.bind(storage);
  let revokedAtNetworkBoundary = false;
  storage.getItem = function (key) {
    if (!revokedAtNetworkBoundary && String(key) === CONSENT_KEY) {
      revokedAtNetworkBoundary = true;
      optingOutTab.collector.disable();
    }
    return originalGetItem(key);
  };

  assert.equal(await staleTab.collector.sendNow(), false);
  assert.equal(revokedAtNetworkBoundary, true);
  assert.equal(staleTab.fetchHarness.calls.length, 1);
  assert.equal(staleTab.collector.snapshot().enabled, false);
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(INSTALL_KEY), null);
  assert.equal(storage.getItem(QUEUE_KEY), null);
  assert.equal(storage.getItem(STATUS_KEY), null);
  assert.equal(storage.getItem(ACTIVE_KEY), null);
});

test("a delayed upload response cannot recreate state after another tab opts out", async () => {
  const storage = new MemoryStorage();
  const fetchHarness = new DeferredFetchHarness();
  const staleTab = createHarness({ storage, fetchHarness });
  const optingOutTab = createHarness({ storage });
  await staleTab.collector.enable();
  const pendingUpload = staleTab.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "cross-tab-late-response-token",
  });
  while (fetchHarness.calls.length === 0) await Promise.resolve();

  optingOutTab.collector.disable();
  fetchHarness.respond(202);

  assert.equal(await pendingUpload, false);
  assert.equal(staleTab.collector.snapshot().enabled, false);
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(INSTALL_KEY), null);
  assert.equal(storage.getItem(QUEUE_KEY), null);
  assert.equal(storage.getItem(STATUS_KEY), null);
  assert.equal(storage.getItem(ACTIVE_KEY), null);
});

test("an in-flight enable cannot restart after another tab opts out", async () => {
  const storage = new MemoryStorage();
  let resolveMetadata;
  const staleTab = createHarness({
    storage,
    metadataProvider: () => new Promise((resolve) => { resolveMetadata = resolve; }),
  });
  const optingOutTab = createHarness({ storage });
  const pendingEnable = staleTab.collector.enable();
  while (!resolveMetadata) await Promise.resolve();

  optingOutTab.collector.disable();
  resolveMetadata(validMetadata());

  assert.equal(await pendingEnable, false);
  assert.equal(staleTab.collector.snapshot().enabled, false);
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(INSTALL_KEY), null);
  assert.equal(storage.getItem(QUEUE_KEY), null);
  assert.equal(storage.getItem(STATUS_KEY), null);
  assert.equal(storage.getItem(ACTIVE_KEY), null);
});

test("queue clearing cannot recreate status when another tab opts out at the delete boundary", async () => {
  const storage = new MemoryStorage();
  const staleTab = createHarness({ storage });
  const optingOutTab = createHarness({ storage });
  await staleTab.collector.enable();
  const boundary = interceptNextStorageMutation(storage, "removeItem", QUEUE_KEY, () => {
    optingOutTab.collector.disable();
  });
  boundary.arm();

  assert.equal(staleTab.collector.clearQueuedData(), false);
  assert.equal(boundary.fired(), true);
  assert.equal(staleTab.collector.snapshot().enabled, false);
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(INSTALL_KEY), null);
  assert.equal(storage.getItem(QUEUE_KEY), null);
  assert.equal(storage.getItem(STATUS_KEY), null);
  assert.equal(storage.getItem(ACTIVE_KEY), null);
  assert.equal(staleTab.timers.timeouts.size, 0);
});

for (const responseStatus of [202, 503]) {
  test(`a ${responseStatus} response cannot recreate state or retry after boundary opt-out`, async () => {
    const storage = new MemoryStorage();
    const fetchHarness = new DeferredFetchHarness();
    const staleTab = createHarness({ storage, fetchHarness });
    const optingOutTab = createHarness({ storage });
    await staleTab.collector.enable();
    const pendingUpload = staleTab.collector.heartbeatSucceeded({
      controlUrl: "https://control.example.test",
      token: `boundary-response-${responseStatus}`,
    });
    while (fetchHarness.calls.length === 0) await Promise.resolve();
    const boundary = interceptNextStorageMutation(storage, "setItem", QUEUE_KEY, () => {
      optingOutTab.collector.disable();
    });
    boundary.arm();

    fetchHarness.respond(responseStatus);

    assert.equal(await pendingUpload, false);
    assert.equal(boundary.fired(), true);
    assert.equal(staleTab.collector.snapshot().enabled, false);
    assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
    assert.equal(storage.getItem(INSTALL_KEY), null);
    assert.equal(storage.getItem(QUEUE_KEY), null);
    assert.equal(storage.getItem(STATUS_KEY), null);
    assert.equal(storage.getItem(ACTIVE_KEY), null);
    assert.equal(staleTab.timers.timeouts.size, 0);
  });
}

test("a network failure cannot recreate status or retry after boundary opt-out", async () => {
  const storage = new MemoryStorage();
  const fetchHarness = new DeferredFetchHarness();
  const staleTab = createHarness({ storage, fetchHarness });
  const optingOutTab = createHarness({ storage });
  await staleTab.collector.enable();
  const pendingUpload = staleTab.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "boundary-network-failure",
  });
  while (fetchHarness.calls.length === 0) await Promise.resolve();
  const boundary = interceptNextStorageMutation(storage, "setItem", QUEUE_KEY, () => {
    optingOutTab.collector.disable();
  });
  boundary.arm();

  fetchHarness.reject(new Error("network unavailable"));

  assert.equal(await pendingUpload, false);
  assert.equal(boundary.fired(), true);
  assert.equal(staleTab.collector.snapshot().enabled, false);
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(INSTALL_KEY), null);
  assert.equal(storage.getItem(QUEUE_KEY), null);
  assert.equal(storage.getItem(STATUS_KEY), null);
  assert.equal(storage.getItem(ACTIVE_KEY), null);
  assert.equal(staleTab.timers.timeouts.size, 0);
});

test("a late upload response cannot recreate diagnostics state after opt-out", async () => {
  const fetchHarness = new DeferredFetchHarness();
  const storage = new MemoryStorage({ unrelated_application_key: "keep-me" });
  const harness = createHarness({ storage, fetchHarness });
  await harness.collector.enable();
  const pendingUpload = harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "late-response-token",
  });
  while (fetchHarness.calls.length === 0) await Promise.resolve();

  harness.collector.disable();
  fetchHarness.respond(404);
  assert.equal(await pendingUpload, false);
  assert.equal(storage.getItem(CONSENT_KEY), CONSENT_DISABLED);
  assert.equal(storage.getItem(INSTALL_KEY), null);
  assert.equal(storage.getItem(QUEUE_KEY), null);
  assert.equal(storage.getItem(STATUS_KEY), null);
  assert.equal(storage.getItem(ACTIVE_KEY), null);
  assert.equal(storage.getItem("unrelated_application_key"), "keep-me");
});

test("a late old-credential response cannot poison a fresh credential upload", async () => {
  const fetchHarness = new DeferredFetchHarness();
  const harness = createHarness({ fetchHarness });
  await harness.collector.enable();
  const uploadA = harness.collector.heartbeatSucceeded({
    controlUrl: "https://control-a.example.test",
    token: "participant-scope-a",
  });
  while (fetchHarness.calls.length < 1) await Promise.resolve();

  assert.equal(harness.collector.credentialBoundary(), true);
  const uploadB = harness.collector.heartbeatSucceeded({
    controlUrl: "https://control-b.example.test",
    token: "participant-scope-b",
  });
  while (fetchHarness.calls.length < 2) await Promise.resolve();

  fetchHarness.respond(404);
  assert.equal(await uploadA, false);
  assert.equal(harness.collector.snapshot().authenticated, true);
  fetchHarness.respond(202);
  assert.equal(await uploadB, true);
  assert.equal(readStatus(harness.storage).code, "accepted");
  assert.equal(harness.collector.snapshot().authenticated, true);
});

test("invalid public event arguments are ignored without mutating the queue", async () => {
  const harness = createHarness();
  await harness.collector.enable();
  const before = harness.storage.getItem(QUEUE_KEY);
  assert.equal(harness.collector.recordLegacyEvent("not-a-real-event", "FORBIDDEN-DETAIL"), false);
  assert.equal(harness.collector.recordPermission("chat", false, "NotAllowedError"), false);
  assert.equal(harness.collector.recordMedia("camera", "exfiltrate", "failed", "TypeError"), false);
  assert.equal(harness.collector.recordMedia("camera", "start", "secret-state", "TypeError"), false);
  assert.equal(harness.collector.recordConnectionState("secret-state", "TypeError"), false);
  assert.equal(harness.storage.getItem(QUEUE_KEY), before);
  assert.equal(harness.storage.dump().includes("FORBIDDEN-DETAIL"), false);
});

test("a stale session emits an unclean marker only under its proven participant scope", async () => {
  const staleSession = uuidFor(900);
  const freshSession = uuidFor(901);
  const storage = new MemoryStorage({
    [ACTIVE_KEY]: JSON.stringify({
      version: 1,
      sessions: {
        [staleSession]: {
          started_at_ms: BASE_TIME - 660_000,
          last_seen_ms: BASE_TIME - 600_000,
          scope: SCOPE_A,
        },
        [freshSession]: {
          started_at_ms: BASE_TIME - 20_000,
          last_seen_ms: BASE_TIME - 1_000,
          scope: SCOPE_B,
        },
      },
    }),
  });
  const bob = createHarness({
    storage,
    crypto: deterministicCrypto({ start: 1000 }),
    responses: [{ status: 202 }],
  });
  assert.equal(await bob.collector.enable(), true);
  await bob.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "participant-scope-b",
  });
  assert.equal(bob.fetchHarness.calls.length, 1);
  assert.equal(bob.fetchHarness.calls[0].body.includes("session.unclean_shutdown"), false);
  let active = JSON.parse(storage.getItem(ACTIVE_KEY));
  assert.ok(active.sessions[staleSession], "Alice's stale sentinel must not be attributed to Bob");
  assert.ok(active.sessions[freshSession], "fresh tab sentinel must survive another tab startup");

  const alice = createHarness({
    storage,
    crypto: deterministicCrypto({ start: 1100 }),
    responses: [{ status: 503 }],
  });
  assert.equal(await alice.collector.enable(), true);
  await alice.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "participant-scope-a",
  });
  assert.equal(alice.fetchHarness.calls.length, 1);
  const events = JSON.parse(alice.fetchHarness.calls[0].body).events;
  const unclean = events.filter((event) => event.event_type === "unclean_shutdown");
  assert.equal(unclean.length, 1);
  assert.equal(unclean[0].code, "session.unclean_shutdown");
  assert.deepEqual(unclean[0].details, { unclean: true, duration_ms: 60000 });

  active = JSON.parse(storage.getItem(ACTIVE_KEY));
  assert.equal(active.sessions[staleSession], undefined);
  assert.ok(active.sessions[freshSession], "fresh tab sentinel must survive another tab startup");
  assert.ok(Object.values(active.sessions).some((item) => item.scope === SCOPE_A));
  assert.ok(Object.values(active.sessions).some((item) => item.scope === SCOPE_B));
});

test("back-forward cache suspension removes and restores the active sentinel without a false shutdown", async () => {
  const harness = createHarness();
  await harness.collector.enable();
  const beforeQueue = harness.storage.getItem(QUEUE_KEY);
  const sessionId = readQueue(harness.storage, harness.now()).draft.session_id;
  assert.ok(JSON.parse(harness.storage.getItem(ACTIVE_KEY)).sessions[sessionId]);

  harness.eventTarget.dispatch("pagehide", { persisted: true });
  assert.equal(harness.storage.getItem(ACTIVE_KEY), null);
  assert.equal(harness.storage.getItem(QUEUE_KEY), beforeQueue);

  harness.eventTarget.dispatch("pageshow", { persisted: true });
  assert.ok(JSON.parse(harness.storage.getItem(ACTIVE_KEY)).sessions[sessionId]);
  assert.equal(harness.storage.getItem(QUEUE_KEY), beforeQueue);
});

test("sealed envelope identifiers are lowercase even if randomUUID returns uppercase", async () => {
  const harness = createHarness({
    uppercaseUuids: true,
    responses: [{ status: 503 }],
  });
  assert.equal(await harness.collector.enable(), true);
  await harness.collector.heartbeatSucceeded({
    controlUrl: "https://control.example.test",
    token: "uppercase-uuid-token",
  });
  const envelope = JSON.parse(harness.fetchHarness.calls[0].body);
  for (const id of [envelope.envelope_id, envelope.install_id, envelope.session_id]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(id, id.toLowerCase());
  }
  assert.equal(harness.storage.getItem(INSTALL_KEY), envelope.install_id);
  assert.equal(harness.storage.dump().includes("uppercase-uuid-token"), false);
});

test("exported sealed-body validator accepts the deterministic JS fixture", () => {
  const body = makeEnvelope({ number: 999 });
  assert.equal(diagnostics.validateSealedBody(body, uuidFor(200)), true);
  const parsed = JSON.parse(body);
  parsed.events[0].message = "FORBIDDEN";
  assert.equal(diagnostics.validateSealedBody(JSON.stringify(parsed), uuidFor(200)), false);
});

test("the shared browser envelope fixture matches the JS wire contract", () => {
  const fixturePath = path.join(__dirname, "..", "control", "testdata", "browser-diagnostics-envelope-v1.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.equal(diagnostics.validateSealedBody(JSON.stringify(fixture), fixture.install_id), true);
});
