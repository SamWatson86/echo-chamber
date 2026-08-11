const test = require("node:test");
const assert = require("node:assert/strict");
const {
  attemptAndroidFirefoxConnectedMediaRelayRecovery,
  attemptAndroidFirefoxScreenSubscriptionReset,
} = require("./participants-fullscreen.js");

function createGeneration() {
  const calls = [];
  const timers = [];
  const track = {
    kind: "video",
    mediaStreamTrack: { readyState: "live", muted: true },
  };
  const publication = {
    isSubscribed: true,
    track,
    setSubscribed(value) {
      calls.push(["setSubscribed", value]);
      this.isSubscribed = value;
    },
  };
  const tile = {
    isConnected: true,
    dataset: { trackSid: "TR_old" },
  };
  const meta = { publication, tile, identity: "sam" };
  const metaBySid = new Map([["TR_old", meta]]);
  const tileBySid = new Map([["TR_old", tile]]);
  const recoveryStateBySid = new Map();
  return {
    calls,
    timers,
    publication,
    tile,
    meta,
    metaBySid,
    tileBySid,
    recoveryStateBySid,
    options: {
      enabled: true,
      trackSid: "TR_old",
      meta,
      publication,
      tile,
      frameAgeMs: 6000,
      firstLineRecoveryAt: 1000,
      nowMs: 10000,
      recoveryStateBySid,
      getCurrentMeta: (sid) => metaBySid.get(sid),
      getCurrentTile: (sid) => tileBySid.get(sid),
      isHidden: () => false,
      markResubscribeIntent: (sid) => calls.push(["intent", sid]),
      requestKeyFrame: () => calls.push(["keyframe"]),
      schedule: (callback, delay) => timers.push({ callback, delay }),
    },
  };
}

function relayOptions(fixture, overrides = {}) {
  return {
    ...fixture.options,
    roomConnected: true,
    nowMs: 16000,
    resetGraceMs: 6000,
    recover: () => true,
    ...overrides,
  };
}

test("non-target receiver gates cause zero subscription recovery actions", () => {
  const negativePlatforms = [
    "Windows Chrome",
    "Windows Tauri",
    "macOS Safari",
    "macOS Chrome",
    "Android Chrome",
    "iOS Safari",
    "iOS Firefox",
  ];

  for (const label of negativePlatforms) {
    const fixture = createGeneration();
    fixture.options.enabled = false;
    assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), false, label);
    assert.deepEqual(fixture.calls, [], label + " must not change a subscription");
    assert.deepEqual(fixture.timers, [], label + " must not schedule recovery");
  }
});

test("stalled Android Firefox screen subscription resets exactly once", () => {
  const fixture = createGeneration();

  assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), true);
  assert.deepEqual(fixture.calls, [
    ["intent", "TR_old"],
    ["setSubscribed", false],
  ]);
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.timers[0].delay, 500);

  assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), false);
  assert.equal(fixture.timers.length, 1, "the same SID must never start another reset timer");

  fixture.timers[0].callback();
  assert.deepEqual(fixture.calls, [
    ["intent", "TR_old"],
    ["setSubscribed", false],
    ["setSubscribed", true],
    ["keyframe"],
  ]);
});

test("old-generation reset timer cannot touch a replacement track", () => {
  const fixture = createGeneration();
  assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), true);

  const replacementTile = { isConnected: true, dataset: { trackSid: "TR_new" } };
  const replacementPublication = { isSubscribed: true, track: {} };
  const replacementMeta = {
    publication: replacementPublication,
    tile: replacementTile,
    identity: "sam",
  };
  fixture.metaBySid.delete("TR_old");
  fixture.tileBySid.delete("TR_old");
  fixture.metaBySid.set("TR_new", replacementMeta);
  fixture.tileBySid.set("TR_new", replacementTile);

  fixture.timers[0].callback();
  assert.deepEqual(fixture.calls, [
    ["intent", "TR_old"],
    ["setSubscribed", false],
  ]);
  assert.equal(replacementPublication.isSubscribed, true);
  assert.equal(replacementTile.isConnected, true);
});

test("same-SID metadata replacement cannot reset the one-shot recovery state", () => {
  const fixture = createGeneration();
  assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), true);

  const replacementCalls = [];
  const replacementTile = { isConnected: true, dataset: { trackSid: "TR_old" } };
  const replacementPublication = {
    isSubscribed: true,
    track: {
      kind: "video",
      mediaStreamTrack: { readyState: "live", muted: true },
    },
    setSubscribed(value) {
      replacementCalls.push(value);
      this.isSubscribed = value;
    },
  };
  const replacementMeta = {
    publication: replacementPublication,
    tile: replacementTile,
    identity: "sam",
  };
  fixture.metaBySid.set("TR_old", replacementMeta);
  fixture.tileBySid.set("TR_old", replacementTile);

  const replacementOptions = {
    ...fixture.options,
    meta: replacementMeta,
    publication: replacementPublication,
    tile: replacementTile,
  };

  assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(replacementOptions), false);
  assert.deepEqual(replacementCalls, []);
  assert.equal(fixture.timers.length, 1, "same SID must retain its original one-shot timer only");
  fixture.timers[0].callback();
  assert.deepEqual(replacementCalls, []);
});

test("connected Android Firefox media stall escalates only after the SID reset grace period", () => {
  const fixture = createGeneration();
  const recoveries = [];
  let onValidated = null;

  assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), true);
  fixture.timers[0].callback();
  assert.deepEqual(fixture.recoveryStateBySid.get("TR_old"), {
    subscriptionResetAttempted: true,
    subscriptionResetAt: 10000,
  });

  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(relayOptions(fixture, {
    nowMs: 15999,
    recover: (detail) => {
      recoveries.push({
        trackSid: detail.trackSid,
        identity: detail.identity,
        isStillStalled: detail.isStillStalled(),
      });
      return true;
    },
  })), false, "the per-track reset gets its complete grace period");
  assert.deepEqual(recoveries, []);

  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(relayOptions(fixture, {
    recover: (detail) => {
      recoveries.push({
        trackSid: detail.trackSid,
        identity: detail.identity,
        isStillStalled: detail.isStillStalled(),
      });
      onValidated = detail.onValidated;
      return true;
    },
  })), true);
  assert.deepEqual(recoveries, [{
    trackSid: "TR_old",
    identity: "sam",
    isStillStalled: true,
  }]);
  assert.deepEqual(fixture.recoveryStateBySid.get("TR_old"), {
    subscriptionResetAttempted: true,
    subscriptionResetAt: 10000,
  }, "queue acceptance alone must not consume the fallback");
  assert.equal(onValidated(), true);
  assert.deepEqual(fixture.recoveryStateBySid.get("TR_old"), {
    subscriptionResetAttempted: true,
    subscriptionResetAt: 10000,
    relayRecoveryAttempted: true,
    relayRecoveryAt: 16000,
  });
  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(relayOptions(fixture)), false,
    "one SID generation cannot trigger a Room loop");
});

test("relay recovery requires the exact connected live-muted stalled generation", () => {
  const cases = [
    ["target gate", (fixture, options) => { options.enabled = false; }],
    ["connected Room", (fixture, options) => { options.roomConnected = false; }],
    ["stale frames", (fixture, options) => { options.frameAgeMs = 3000; }],
    ["active subscription", (fixture) => { fixture.publication.isSubscribed = false; }],
    ["live track", (fixture) => { fixture.publication.track.mediaStreamTrack.readyState = "ended"; }],
    ["muted track", (fixture) => { fixture.publication.track.mediaStreamTrack.muted = false; }],
    ["watched identity", (fixture, options) => { options.isHidden = () => true; }],
    ["current tile", (fixture) => { fixture.tileBySid.delete("TR_old"); }],
    ["current metadata", (fixture) => { fixture.metaBySid.delete("TR_old"); }],
  ];

  for (const [label, mutate] of cases) {
    const fixture = createGeneration();
    assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), true, label);
    fixture.timers[0].callback();
    let recoveryCalls = 0;
    const options = relayOptions(fixture, { recover: () => { recoveryCalls += 1; return true; } });
    mutate(fixture, options);
    assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(options), false, label);
    assert.equal(recoveryCalls, 0, label + " must not replace the Room");
  }
});

test("rejected or JIT-cancelled relay handoff is retryable while a validated handoff is one-shot", () => {
  const fixture = createGeneration();
  assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), true);
  fixture.timers[0].callback();

  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(relayOptions(fixture, {
    recover: () => false,
  })), false);
  assert.equal(fixture.recoveryStateBySid.get("TR_old").relayRecoveryAttempted, undefined);

  let cancelledDetail = null;
  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(relayOptions(fixture, {
    recover: (detail) => { cancelledDetail = detail; return true; },
  })), true);
  assert.equal(fixture.recoveryStateBySid.get("TR_old").relayRecoveryAttempted, undefined,
    "an accepted timer may still be cancelled by the JIT predicate");

  let validatedDetail = null;
  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(relayOptions(fixture, {
    recover: (detail) => { validatedDetail = detail; return true; },
  })), true, "the same SID remains retryable after cancellation");
  assert.equal(validatedDetail.onValidated(), true);
  assert.equal(fixture.recoveryStateBySid.get("TR_old").relayRecoveryAttempted, true);
  assert.equal(cancelledDetail.onValidated(), false,
    "a stale accepted callback cannot reserve an already-used generation");
  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(relayOptions(fixture)), false);
});

test("relay handoff carries a dynamic exact-generation stall predicate", () => {
  const fixture = createGeneration();
  assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), true);
  fixture.timers[0].callback();
  let connected = true;
  let frameAgeMs = 6000;
  let isStillStalled = null;
  const options = relayOptions(fixture, {
    isRoomConnected: () => connected,
    getFrameAgeMs: () => frameAgeMs,
    recover(detail) {
      isStillStalled = detail.isStillStalled;
      return true;
    },
  });

  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(options), true);
  assert.equal(isStillStalled(), true);

  frameAgeMs = 0;
  assert.equal(isStillStalled(), false, "presented frames resumed");
  frameAgeMs = 6000;
  connected = false;
  assert.equal(isStillStalled(), false, "source Room changed or disconnected");
  connected = true;
  fixture.publication.track.mediaStreamTrack.muted = false;
  assert.equal(isStillStalled(), false, "track unmuted");
  fixture.publication.track.mediaStreamTrack.muted = true;
  fixture.publication.isSubscribed = false;
  assert.equal(isStillStalled(), false, "subscription ended");
  fixture.publication.isSubscribed = true;
  options.isHidden = () => true;
  assert.equal(isStillStalled(), false, "screen became hidden");
  options.isHidden = () => false;
  fixture.metaBySid.delete("TR_old");
  assert.equal(isStillStalled(), false, "metadata generation changed");
});

test("same-SID subscribed replacement inherits the bounded relay escalation state", () => {
  const fixture = createGeneration();
  assert.equal(attemptAndroidFirefoxScreenSubscriptionReset(fixture.options), true);
  fixture.timers[0].callback();

  const replacementTile = { isConnected: true, dataset: { trackSid: "TR_old" } };
  const replacementPublication = {
    isSubscribed: true,
    track: { kind: "video", mediaStreamTrack: { readyState: "live", muted: true } },
  };
  const replacementMeta = {
    publication: replacementPublication,
    tile: replacementTile,
    identity: "sam",
  };
  fixture.metaBySid.set("TR_old", replacementMeta);
  fixture.tileBySid.set("TR_old", replacementTile);

  let onValidated = null;
  const replacementOptions = relayOptions(fixture, {
    meta: replacementMeta,
    publication: replacementPublication,
    tile: replacementTile,
    recover: (detail) => { onValidated = detail.onValidated; return true; },
  });
  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(replacementOptions), true);
  assert.equal(onValidated(), true);
  assert.equal(attemptAndroidFirefoxConnectedMediaRelayRecovery(replacementOptions), false);
});
