const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  capturePhoneFullscreenMediaGeneration,
  createPhoneFullscreenRecoveryContext,
  didPhoneFullscreenFrameAdvance,
  isCurrentPhoneFullscreenMediaGeneration,
} = require("./participants-fullscreen.js");

function createScreenGeneration() {
  const currentRoom = { name: "main" };
  const track = { sid: "TR_screen", mediaStreamTrack: { readyState: "live" } };
  const publication = { track, trackSid: "TR_screen" };
  const video = {
    isConnected: true,
    _lkTrack: track,
    _playGeneration: 4,
    _lastFrameTs: 100,
    _echoPresentationStats: { presentedFrames: 10 },
    currentTime: 2,
    paused: false,
    playCalls: 0,
    play() { this.playCalls += 1; return Promise.resolve(); },
  };
  const host = {
    isConnected: true,
    _screenRoom: currentRoom,
    _screenPublication: publication,
    _screenTrack: track,
    querySelector(selector) { return selector === "video" ? video : null; },
  };
  return {
    currentRoom,
    host,
    publication,
    track,
    video,
    generation: capturePhoneFullscreenMediaGeneration(host, video, currentRoom),
  };
}

test("phone fullscreen generation keeps the same host, video, publication, and track", () => {
  const fixture = createScreenGeneration();
  assert.equal(isCurrentPhoneFullscreenMediaGeneration(fixture.generation, fixture.currentRoom), true);
  assert.equal(fixture.generation.host, fixture.host);
  assert.equal(fixture.generation.element, fixture.video);
  assert.equal(fixture.generation.publication, fixture.publication);
  assert.equal(fixture.generation.track, fixture.track);

  fixture.video._lkTrack = { sid: "replacement" };
  assert.equal(isCurrentPhoneFullscreenMediaGeneration(fixture.generation, fixture.currentRoom), false);
});

test("phone fullscreen frame advancement accepts callback, presentation, or media-time progress", () => {
  const fixture = createScreenGeneration();
  const marker = { currentTime: 2, lastFrameTs: 100, presentedFrames: 10 };
  assert.equal(didPhoneFullscreenFrameAdvance(fixture.video, marker), false);
  fixture.video._echoPresentationStats.presentedFrames = 11;
  assert.equal(didPhoneFullscreenFrameAdvance(fixture.video, marker), true);
  fixture.video._echoPresentationStats.presentedFrames = 10;
  fixture.video._lastFrameTs = 101;
  assert.equal(didPhoneFullscreenFrameAdvance(fixture.video, marker), true);
  fixture.video._lastFrameTs = 100;
  fixture.video.currentTime = 2.1;
  assert.equal(didPhoneFullscreenFrameAdvance(fixture.video, marker), true);
});

test("phone fullscreen recovery measures once and calls play plus keyframe at most once", () => {
  const fixture = createScreenGeneration();
  let shellMeasurements = 0;
  let gridRecalculations = 0;
  let keyframes = 0;
  const context = createPhoneFullscreenRecoveryContext(fixture.generation, {
    getCurrentRoom: () => fixture.currentRoom,
    shell: { measureNow() { shellMeasurements += 1; } },
    recalculateGrid() { gridRecalculations += 1; },
    requestKeyFrame(publication, track) {
      assert.equal(publication, fixture.publication);
      assert.equal(track, fixture.track);
      keyframes += 1;
    },
  });
  assert.equal(context.isCurrent(), true);
  assert.equal(context.hasAdvanced(), false);
  context.measure();
  assert.equal(shellMeasurements, 1);
  assert.equal(gridRecalculations, 1);
  assert.equal(context.recover(), true);
  assert.equal(context.recover(), false);
  assert.equal(fixture.video.playCalls, 1);
  assert.equal(keyframes, 1);
});

test("phone fullscreen recovery contains no media replacement, subscription, or reconnect action", () => {
  const source = fs.readFileSync(path.join(__dirname, "participants-fullscreen.js"), "utf8");
  const match = source.match(/function createPhoneFullscreenRecoveryContext[\s\S]*?function schedulePhoneFullscreenExitStabilization/);
  assert.ok(match, "missing bounded phone fullscreen recovery helper");
  assert.doesNotMatch(match[0], /\.attach\s*\(|replaceWith|setSubscribed|connect\s*\(|disconnect\s*\(/);
  assert.match(
    source,
    /if \(restoreResponsiveState &&\s*!schedulePhoneFullscreenExitStabilization\(phoneFullscreenGeneration\)\) \{\s*restoreFullscreenResponsiveState\(responsiveSnapshot\);/,
    "non-phone fullscreen exit must retain the existing responsive restoration path"
  );
});
