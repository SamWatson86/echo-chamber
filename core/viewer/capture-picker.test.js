const test = require("node:test");
const assert = require("node:assert/strict");

const {
  _renderSection,
  captureSourceFromCard,
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

test("capture picker carries native executable metadata into the selected source", () => {
  const html = _renderSection("Games", "Game Capture", [{
    id: 4242,
    title: "Battlefield 6",
    source_type: "game",
    pid: 9001,
    exe_name: "bf6.exe",
  }]);
  assert.match(html, /data-exe-name="bf6\.exe"/);

  assert.deepEqual(captureSourceFromCard({
    dataset: {
      id: "4242",
      title: "Battlefield 6",
      type: "game",
      pid: "9001",
      exeName: "bf6.exe",
    },
  }), {
    id: 4242,
    title: "Battlefield 6",
    sourceType: "game",
    isMonitor: false,
    pid: 9001,
    exeName: "bf6.exe",
    captureMode: "auto",
  });
});

test("capture picker keeps executable metadata optional for older clients", () => {
  const source = captureSourceFromCard({
    dataset: {
      id: "7",
      title: "Monitor 1",
      type: "monitor",
      pid: "0",
    },
  });

  assert.equal(source.exeName, null);
  assert.equal(source.captureMode, null);
});
