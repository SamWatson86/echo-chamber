const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadConfig(performanceMode) {
  const logs = [];
  const context = {
    performanceMode: !!performanceMode,
    debugLog(message) { logs.push(message); },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "screen-share-config.js"), "utf8"),
    context,
    { filename: "screen-share-config.js" }
  );
  return { context, logs };
}

test("conservative browser publishing is single-layer 30fps", () => {
  const { context } = loadConfig(false);
  const options = context.getScreenSharePublishOptions(2560, 1440, true);

  assert.equal(options.videoCodec, "h264");
  assert.equal(options.simulcast, false);
  assert.equal(options.screenShareEncoding.maxBitrate, 5_000_000);
  assert.equal(options.screenShareEncoding.maxFramerate, 30);
  assert.equal(options.degradationPreference, "balanced");
});

test("ordinary browser publishing retains the existing simulcast profile", () => {
  const { context } = loadConfig(false);
  const options = context.getScreenSharePublishOptions(1920, 1080, false);

  assert.equal(options.simulcast, true);
  assert.equal(options.screenShareEncoding.maxBitrate, 15_000_000);
  assert.equal(options.screenShareEncoding.maxFramerate, 60);
  assert.equal(options.screenShareSimulcastLayers.length, 2);
});
