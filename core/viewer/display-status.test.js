const test = require("node:test");
const assert = require("node:assert/strict");
const { isEchoDisplayWarning } = require("./display-status.js");

test("display warning is false when native status is unavailable", () => {
  assert.equal(isEchoDisplayWarning(null), false);
  assert.equal(isEchoDisplayWarning({ available: false }), false);
});

test("display warning is true when Echo is off the preferred display", () => {
  assert.equal(isEchoDisplayWarning({
    available: true,
    on_preferred_display: false,
    window_spans_displays: false,
  }), true);
});

test("display warning is true when Echo spans displays", () => {
  assert.equal(isEchoDisplayWarning({
    available: true,
    on_preferred_display: true,
    window_spans_displays: true,
  }), true);
});
