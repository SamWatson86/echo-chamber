const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcilePublishIndicators } = require("./publish-state-reconcile.js");

test("camera/screen stale-on flags are corrected to false when unpublished", () => {
  const out = reconcilePublishIndicators(
    { camEnabled: true, screenEnabled: true },
    { cameraPublished: false, screenPublished: false }
  );

  assert.equal(out.next.camEnabled, false);
  assert.equal(out.next.screenEnabled, false);
  assert.equal(out.drift.camera, true);
  assert.equal(out.drift.screen, true);
});

test("published tracks force UI truth to enabled", () => {
  const out = reconcilePublishIndicators(
    { camEnabled: false, screenEnabled: false },
    { cameraPublished: true, screenPublished: true }
  );

  assert.equal(out.next.camEnabled, true);
  assert.equal(out.next.screenEnabled, true);
  assert.equal(out.anyDrift, true);
});

test("no drift when UI state already matches publication reality", () => {
  const out = reconcilePublishIndicators(
    { camEnabled: true, screenEnabled: false },
    { cameraPublished: true, screenPublished: false }
  );

  assert.equal(out.anyDrift, false);
  assert.deepEqual(out.next, { camEnabled: true, screenEnabled: false });
});

test("missing inputs default to unpublished false flags", () => {
  const out = reconcilePublishIndicators(undefined, undefined);

  assert.deepEqual(out.next, { camEnabled: false, screenEnabled: false });
  assert.equal(out.anyDrift, false);
});

test("camera and screen drift are tracked independently", () => {
  const out = reconcilePublishIndicators(
    { camEnabled: false, screenEnabled: true },
    { cameraPublished: true, screenPublished: true }
  );

  assert.equal(out.drift.camera, true);
  assert.equal(out.drift.screen, false);
  assert.equal(out.anyDrift, true);
});
