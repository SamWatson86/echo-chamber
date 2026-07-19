const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isMicrophoneActuallyEnabled,
  reconcilePublishIndicators,
} = require("./publish-state-reconcile.js");

const microphoneSource = "microphone";
const audioKind = "audio";

function microphonePublication(overrides = {}) {
  return {
    source: microphoneSource,
    kind: audioKind,
    isMuted: false,
    track: {
      kind: audioKind,
      isMuted: false,
      mediaStreamTrack: { readyState: "live" },
    },
    ...overrides,
  };
}

test("microphone truth requires both SDK enabled state and a live unmuted publication", () => {
  const livePublication = microphonePublication();

  assert.equal(isMicrophoneActuallyEnabled(
    { isMicrophoneEnabled: true }, [livePublication], microphoneSource, audioKind
  ), true);
  assert.equal(isMicrophoneActuallyEnabled(
    { isMicrophoneEnabled: false }, [livePublication], microphoneSource, audioKind
  ), false);
  assert.equal(isMicrophoneActuallyEnabled(
    { isMicrophoneEnabled: true }, [], microphoneSource, audioKind
  ), false);
});

test("muted, ended, and non-microphone publications never count as a live mic", () => {
  const participant = { isMicrophoneEnabled: true };

  assert.equal(isMicrophoneActuallyEnabled(
    participant, [microphonePublication({ isMuted: true })], microphoneSource, audioKind
  ), false);
  assert.equal(isMicrophoneActuallyEnabled(
    participant,
    [microphonePublication({ track: { kind: audioKind, isMuted: false, mediaStreamTrack: { readyState: "ended" } } })],
    microphoneSource,
    audioKind
  ), false);
  assert.equal(isMicrophoneActuallyEnabled(
    participant, [microphonePublication({ source: "screen_share_audio" })], microphoneSource, audioKind
  ), false);
});

test("mic/camera/screen stale-on flags are corrected to false when unpublished", () => {
  const out = reconcilePublishIndicators(
    { micEnabled: true, camEnabled: true, screenEnabled: true },
    { microphonePublished: false, cameraPublished: false, screenPublished: false }
  );

  assert.equal(out.next.micEnabled, false);
  assert.equal(out.next.camEnabled, false);
  assert.equal(out.next.screenEnabled, false);
  assert.equal(out.drift.microphone, true);
  assert.equal(out.drift.camera, true);
  assert.equal(out.drift.screen, true);
});

test("published tracks force UI truth to enabled", () => {
  const out = reconcilePublishIndicators(
    { micEnabled: false, camEnabled: false, screenEnabled: false },
    { microphonePublished: true, cameraPublished: true, screenPublished: true }
  );

  assert.equal(out.next.micEnabled, true);
  assert.equal(out.next.camEnabled, true);
  assert.equal(out.next.screenEnabled, true);
  assert.equal(out.anyDrift, true);
});

test("no drift when UI state already matches publication reality", () => {
  const out = reconcilePublishIndicators(
    { micEnabled: false, camEnabled: true, screenEnabled: false },
    { microphonePublished: false, cameraPublished: true, screenPublished: false }
  );

  assert.equal(out.anyDrift, false);
  assert.deepEqual(out.next, { micEnabled: false, camEnabled: true, screenEnabled: false });
});

test("missing inputs default to unpublished false flags", () => {
  const out = reconcilePublishIndicators(undefined, undefined);

  assert.deepEqual(out.next, { camEnabled: false, screenEnabled: false });
  assert.equal(out.anyDrift, false);
});

test("legacy camera/screen-only callers keep their original result shape", () => {
  const out = reconcilePublishIndicators(
    { camEnabled: true, screenEnabled: false },
    { cameraPublished: false, screenPublished: true }
  );

  assert.deepEqual(out.next, { camEnabled: false, screenEnabled: true });
  assert.deepEqual(out.drift, { camera: true, screen: true });
});

test("microphone, camera, and screen drift are tracked independently", () => {
  const out = reconcilePublishIndicators(
    { micEnabled: true, camEnabled: false, screenEnabled: true },
    { microphonePublished: false, cameraPublished: true, screenPublished: true }
  );

  assert.equal(out.drift.microphone, true);
  assert.equal(out.drift.camera, true);
  assert.equal(out.drift.screen, false);
  assert.equal(out.anyDrift, true);
});

test("an unconfirmed microphone cannot remain optimistically enabled", () => {
  const out = reconcilePublishIndicators(
    { micEnabled: true, camEnabled: false, screenEnabled: false },
    { microphonePublished: false, cameraPublished: false, screenPublished: false }
  );

  assert.equal(out.next.micEnabled, false);
  assert.equal(out.drift.microphone, true);
  assert.equal(out.anyDrift, true);
});
