const test = require("node:test");
const assert = require("node:assert/strict");
const {
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
