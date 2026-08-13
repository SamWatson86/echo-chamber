const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const androidFirefox =
  "Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0";

function createHarness() {
  const calls = [];
  const timeouts = [];
  const intervals = [];
  const videos = [];
  function video(frames) {
    const value = {
      _echoPresentationStats: { presentedFrames: frames },
      _lkTrack: null,
      classList: { add() {} },
      isConnected: true,
      paused: false,
      readyState: 4,
      srcObject: {},
      style: { setProperty() {}, width: "", height: "", background: "" },
      videoHeight: 1080,
      videoWidth: 1920,
    };
    videos.push(value);
    return value;
  }
  const initialVideo = video(10);
  const track = {
    mediaStreamTrack: { readyState: "live", muted: false },
    detach(value) { calls.push(["detach", value]); },
    attach(value) { calls.push(["reattach", value]); return value; },
  };
  initialVideo._lkTrack = track;
  const publication = {
    isSubscribed: true,
    track,
    setSubscribed(value) { this.isSubscribed = value; calls.push(["subscribed", value]); },
  };
  const overlay = {};
  const tile = {
    currentVideo: initialVideo,
    dataset: { trackSid: "TR_screen" },
    isConnected: true,
    querySelector(selector) { return selector === "video" ? this.currentVideo : overlay; },
  };
  const meta = { identity: "remote", publication, tile };
  const room = { state: "connected", localParticipant: { identity: "local" } };
  const context = {
    Map,
    Date,
    globalThis: null,
    module: { exports: {} },
    performance: { now: () => 0 },
    screenTileBySid: new Map([["TR_screen", tile]]),
    screenTrackMeta: new Map([["TR_screen", meta]]),
    hiddenScreens: new Set(),
    room,
    window: {
      EchoAndroidFirefoxPresentationRecoveryLoader: {
        isExactTarget: () => true,
      },
      document: { visibilityState: "visible" },
      navigator: { userAgent: androidFirefox },
      setInterval(callback, delay) { intervals.push({ callback, delay }); return 1; },
      setTimeout(callback, delay) { timeouts.push({ callback, delay }); return timeouts.length; },
    },
    configureVideoElement() { calls.push(["configure"]); },
    ensureVideoPlays() { calls.push(["play"]); },
    ensureVideoSubscribed() { calls.push(["ensureSubscribed"]); },
    markResubscribeIntent(sid) { calls.push(["intent", sid]); },
    requestVideoKeyFrame() { calls.push(["keyframe"]); },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "android-firefox-presentation-recovery.js"), "utf8"),
    context,
  );
  return { api: context.module.exports, calls, context, intervals, meta, publication, room, tile, timeouts, videos };
}

test("a never-presented live track cannot enter the presentation recovery ladder", () => {
  const harness = createHarness();
  harness.tile.currentVideo._echoPresentationStats.presentedFrames = 0;
  harness.api.stateBySid.clear();
  assert.equal(harness.api.inspect(1000), 0);
  assert.equal(harness.api.inspect(20000), 0);
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.timeouts.length, 0);
});

test("a proven presentation stall reattaches only its stable sink, then performs one exact-SID resubscribe", () => {
  const harness = createHarness();
  assert.equal(harness.api.inspect(1000), 0, "records genuine presentation progress");
  assert.equal(harness.api.inspect(9001), 1, "eight-second presentation stall reattaches sink");
  assert.equal(harness.calls.filter((entry) => entry[0] === "reattach").length, 1);
  assert.equal(harness.tile.currentVideo, harness.videos[0], "production video node stays stable");
  assert.equal(harness.calls.some((entry) => entry[0] === "subscribed"), false);

  assert.equal(harness.api.inspect(15002), 1, "six-second sink grace permits one reset");
  assert.deepEqual(harness.calls.filter((entry) => entry[0] === "subscribed"), [["subscribed", false]]);
  assert.equal(harness.timeouts.length, 1);
  assert.equal(harness.timeouts[0].delay, 500);
  harness.publication.isSubscribed = true;
  assert.equal(harness.api.inspect(25000), 0, "the same SID cannot schedule another reset");
  assert.equal(harness.timeouts.length, 1);
});

test("a rejected same-node reattach cannot block the bounded SID reset", () => {
  const harness = createHarness();
  harness.publication.track.attach = undefined;
  harness.api.inspect(1000);
  assert.equal(harness.api.inspect(9001), 0);
  assert.equal(harness.api.stateBySid.get("TR_screen").sinkAttempted, true);
  assert.equal(harness.api.inspect(15002), 1);
  assert.deepEqual(harness.calls.filter((entry) => entry[0] === "subscribed"), [["subscribed", false]]);
  assert.equal(harness.timeouts.length, 1);
});

test("reattached sink progress rearms the bounded ladder after two observations", () => {
  const harness = createHarness();
  harness.api.inspect(1000);
  harness.api.inspect(9001);
  const stableVideo = harness.tile.currentVideo;
  stableVideo._echoPresentationStats.presentedFrames = 11;
  assert.equal(harness.api.inspect(10000), 0);
  stableVideo._echoPresentationStats.presentedFrames = 12;
  assert.equal(harness.api.inspect(11000), 0);
  const state = harness.api.stateBySid.get("TR_screen");
  assert.equal(state.sinkAttempted, false);
  assert.equal(state.subscriptionAttempted, false);
  assert.equal(state.sawPresentedFrame, true);
});

test("delayed subscription restoration is fenced to the exact Room, metadata, tile, and SID", () => {
  for (const mutation of [
    (h) => { h.context.room = { state: "connected", localParticipant: { identity: "local" } }; },
    (h) => h.context.screenTrackMeta.delete("TR_screen"),
    (h) => h.context.screenTileBySid.delete("TR_screen"),
    (h) => { h.tile.dataset.trackSid = "TR_new"; },
  ]) {
    const harness = createHarness();
    harness.api.inspect(1000);
    harness.api.inspect(9001);
    harness.api.inspect(15002);
    mutation(harness);
    harness.timeouts[0].callback();
    assert.deepEqual(harness.calls.filter((entry) => entry[0] === "subscribed"), [["subscribed", false]]);
  }
});

test("tab backgrounding after the reset cannot strand the exact subscription off", () => {
  const harness = createHarness();
  harness.api.inspect(1000);
  harness.api.inspect(9001);
  harness.api.inspect(15002);
  harness.context.window.document.visibilityState = "hidden";
  harness.timeouts[0].callback();
  assert.deepEqual(harness.calls.filter((entry) => entry[0] === "subscribed"), [
    ["subscribed", false],
    ["subscribed", true],
  ]);
});

test("same SID in a new publication and video generation cannot inherit presentation proof", () => {
  const harness = createHarness();
  harness.api.inspect(1000);
  harness.api.inspect(9001);
  assert.equal(harness.calls.filter((entry) => entry[0] === "reattach").length, 1);

  const replacementVideo = {
    ...harness.tile.currentVideo,
    _echoPresentationStats: { presentedFrames: 0 },
  };
  const replacementTrack = {
    mediaStreamTrack: { readyState: "live", muted: false },
    attach() {},
    detach() {},
  };
  replacementVideo._lkTrack = replacementTrack;
  const replacementPublication = {
    isSubscribed: true,
    track: replacementTrack,
    setSubscribed(value) { this.isSubscribed = value; harness.calls.push(["replacementSubscribed", value]); },
  };
  const replacementMeta = {
    identity: "remote",
    publication: replacementPublication,
    tile: harness.tile,
  };
  harness.tile.currentVideo = replacementVideo;
  harness.context.screenTrackMeta.set("TR_screen", replacementMeta);
  harness.api.inspect(20000);
  harness.api.inspect(40000);
  assert.deepEqual(harness.calls.filter((entry) => entry[0] === "replacementSubscribed"), []);
  assert.equal(harness.api.stateBySid.get("TR_screen").sawPresentedFrame, undefined);
});

test("state for a removed SID is swept on the next inspection", () => {
  const harness = createHarness();
  harness.api.inspect(1000);
  assert.equal(harness.api.stateBySid.has("TR_screen"), true);
  harness.context.screenTrackMeta.delete("TR_screen");
  harness.context.screenTileBySid.delete("TR_screen");
  harness.api.inspect(2000);
  assert.equal(harness.api.stateBySid.has("TR_screen"), false);
});

test("disconnecting the exact Room during the reset delay blocks restoration", () => {
  const harness = createHarness();
  harness.api.inspect(1000);
  harness.api.inspect(9001);
  harness.api.inspect(15002);
  harness.room.state = "disconnected";
  harness.timeouts[0].callback();
  assert.deepEqual(harness.calls.filter((entry) => entry[0] === "subscribed"), [["subscribed", false]]);
});

test("a recovered and restalled exact generation can never toggle its subscription twice", () => {
  const harness = createHarness();
  harness.api.inspect(1000);
  harness.api.inspect(9001);
  harness.api.inspect(15002);
  harness.api.inspect(15100);
  assert.equal(harness.api.stateBySid.get("TR_screen").subscriptionEverAttempted, true,
    "the 500ms unsubscribe window must not discard the exact-generation cap");
  harness.publication.isSubscribed = true;

  harness.tile.currentVideo._echoPresentationStats.presentedFrames = 11;
  harness.api.inspect(16000);
  harness.tile.currentVideo._echoPresentationStats.presentedFrames = 12;
  harness.api.inspect(17000);
  harness.api.inspect(26001);
  harness.api.inspect(33002);

  assert.deepEqual(harness.calls.filter((entry) => entry[0] === "subscribed"), [["subscribed", false]]);
  assert.equal(harness.timeouts.length, 1);
  assert.equal(harness.api.stateBySid.get("TR_screen").subscriptionEverAttempted, true);
});
