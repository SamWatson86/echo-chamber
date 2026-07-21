const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "rnnoise.js"), "utf8");

function loadRnnoise(options = {}) {
  const logs = [];
  const context = {
    navigator: {
      userAgent: options.userAgent || "",
      platform: options.platform || "",
      userAgentData: options.userAgentData,
    },
    echoGet(key) {
      return key === "echo-noise-cancel" ? options.savedNoiseCancel ?? null : null;
    },
    debugLog(message) {
      logs.push(message);
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "rnnoise.js" });
  return {
    context,
    logs,
    blocked: vm.runInContext("isNoiseCancellationBlockedForPlatform()", context),
    enabled: vm.runInContext("noiseCancelEnabled", context),
  };
}

test("desktop macOS blocks the optional RNNoise sender-track replacement", () => {
  const loaded = loadRnnoise({
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
    savedNoiseCancel: "true",
  });

  assert.equal(loaded.blocked, true);
  assert.equal(loaded.enabled, false);
});

test("macOS detection supports Chromium userAgentData", () => {
  const loaded = loadRnnoise({
    platform: "",
    userAgent: "Mozilla/5.0",
    userAgentData: { platform: "macOS" },
  });

  assert.equal(loaded.blocked, true);
  assert.equal(loaded.enabled, false);
});

test("Windows keeps the existing RNNoise default and saved preference", () => {
  const defaultOn = loadRnnoise({
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  });
  const savedOff = loadRnnoise({
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    savedNoiseCancel: "false",
  });

  assert.equal(defaultOn.blocked, false);
  assert.equal(defaultOn.enabled, true);
  assert.equal(savedOff.blocked, false);
  assert.equal(savedOff.enabled, false);
});

test("macOS enable request exits before touching room or media state", async () => {
  const loaded = loadRnnoise({
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
  });

  await vm.runInContext("enableNoiseCancellation()", loaded.context);
  assert.deepEqual(loaded.logs, [
    "[noise-cancel] Skipped on macOS to preserve microphone stability",
  ]);
});
