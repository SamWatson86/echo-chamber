const test = require("node:test");
const assert = require("node:assert/strict");
const {
  describeEchoDisplayName,
  getEchoDisplayStatusLabel,
  shouldShowEchoDisplayStatus,
  isEchoDisplayWarning,
} = require("./display-status.js");

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

test("display status label does not expose raw Windows display device names", () => {
  const label = getEchoDisplayStatusLabel({
    available: true,
    current_display_name: "\\\\.\\DISPLAY1",
    on_preferred_display: true,
    window_spans_displays: false,
  });

  assert.equal(label, "Full-tilt display");
  assert.equal(label.includes("\\\\.\\DISPLAY1"), false);
});

test("display warning label stays plain for non-technical users", () => {
  const label = getEchoDisplayStatusLabel({
    available: true,
    current_display_name: "\\\\.\\DISPLAY1",
    on_preferred_display: false,
    window_spans_displays: false,
  });

  assert.equal(label, "Check display path");
  assert.equal(label.includes("\\\\.\\DISPLAY1"), false);
});

test("raw Windows display device names are described generically in toasts", () => {
  assert.equal(describeEchoDisplayName("\\\\.\\DISPLAY1"), "current display");
  assert.equal(describeEchoDisplayName("Samsung Odyssey"), "Samsung Odyssey");
});

test("display status is hidden unless there is an actionable warning", () => {
  assert.equal(shouldShowEchoDisplayStatus(null), false);
  assert.equal(shouldShowEchoDisplayStatus({ available: false }), false);
  assert.equal(shouldShowEchoDisplayStatus({
    available: true,
    on_preferred_display: true,
    window_spans_displays: false,
  }), false);
  assert.equal(shouldShowEchoDisplayStatus({
    available: true,
    on_preferred_display: false,
    window_spans_displays: false,
  }), true);
});
