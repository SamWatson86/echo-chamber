const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isUnsupportedSystemCaptureSource,
} = require("./capture-picker.js");

test("capture picker rejects Windows shell surfaces that only produce black frames", () => {
  assert.equal(isUnsupportedSystemCaptureSource({
    source_type: "window",
    title: "Windows Input Experience",
  }), true);
  assert.equal(isUnsupportedSystemCaptureSource({
    source_type: "window",
    title: "MSCTFIME UI",
  }), true);
  assert.equal(isUnsupportedSystemCaptureSource({
    source_type: "game",
    title: "Default IME",
  }), true);
});

test("capture picker keeps monitor and normal application sources", () => {
  assert.equal(isUnsupportedSystemCaptureSource({
    source_type: "monitor",
    title: "Monitor 1 (\\\\.\\DISPLAY1)",
  }), false);
  assert.equal(isUnsupportedSystemCaptureSource({
    source_type: "window",
    title: "PowerPoint - Quarterly Review",
  }), false);
});
