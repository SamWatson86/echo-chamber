const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createVideoFrameRateTracker,
  getVideoPresentationSnapshot,
} = require("./participants-fullscreen.js");

test("video diagnostics use presentedFrames when callbacks skip frames", () => {
  let now = 0;
  const tracker = createVideoFrameRateTracker(() => now);

  tracker.noteFrame({ presentedFrames: 10 });
  now = 1000;
  tracker.noteFrame({ presentedFrames: 55 });

  assert.equal(tracker.sample(), 45);
  assert.equal(tracker.presentedFrames(), 55);
});

test("video diagnostics fall back to callback count without presentedFrames", () => {
  let now = 0;
  const tracker = createVideoFrameRateTracker(() => now);

  tracker.noteFrame();
  tracker.noteFrame();
  now = 1000;

  assert.equal(tracker.sample(), 2);
  assert.equal(tracker.presentedFrames(), null);
});

test("video presentation snapshot returns null for missing element", () => {
  assert.equal(getVideoPresentationSnapshot(null), null);
});

test("video presentation snapshot returns the element stats object", () => {
  const stats = { fps: 59.8, width: 1920, height: 1080 };
  assert.equal(getVideoPresentationSnapshot({ _echoPresentationStats: stats }), stats);
});
