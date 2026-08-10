const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "rnnoise.js"), "utf8");
const connectSource = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");

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

test("Android Firefox 153 is the only browser that bypasses custom RTC overrides", () => {
  const loaded = loadRnnoise();
  const isTarget = loaded.context.isAndroidFirefoxBrowser;
  const cases = [
    {
      name: "Android Firefox 153",
      expected: true,
      navigator: {
        userAgent: "Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0",
      },
    },
    {
      name: "Android Chrome 153",
      expected: false,
      navigator: {
        userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
      },
    },
    {
      name: "iOS Safari",
      expected: false,
      navigator: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
      },
    },
    {
      name: "Windows Chrome",
      expected: false,
      navigator: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      },
    },
    {
      name: "macOS Safari",
      expected: false,
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
      },
    },
    {
      name: "macOS Chrome",
      expected: false,
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      },
    },
  ];

  for (const testCase of cases) {
    assert.equal(isTarget(testCase.navigator, false), testCase.expected, testCase.name);
  }
  assert.equal(isTarget(cases[3].navigator, true), false, "Windows Tauri");
  assert.equal(isTarget(cases[0].navigator, true), false, "native shells never bypass overrides");
});

test("connect gates the complete custom RTC override installer with the Android Firefox predicate", () => {
  assert.match(
    connectSource,
    /isAndroidFirefoxBrowser\(navigator, window\.__ECHO_NATIVE__ === true\)/
  );
  assert.match(
    connectSource,
    /if \(!_skipAndroidFirefoxRtcOverrides && !window\._sdpMungingInstalled\) \{/
  );
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
