const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadLoader(environment) {
  const requests = [];
  const timers = [];
  const listeners = [];
  const document = {
    createElement(tagName) {
      assert.equal(tagName, "script");
      return { dataset: {} };
    },
    documentElement: { appendChild(script) { requests.push(script.src); } },
    head: { appendChild(script) { requests.push(script.src); } },
    querySelector(selector) {
      assert.equal(selector, 'script[data-echo-android-firefox-presentation-recovery="1"]');
      return requests.length > 0 ? { dataset: { echoAndroidFirefoxPresentationRecovery: "1" } } : null;
    },
  };
  const storageValues = new Map(Object.entries(environment.storage || {}));
  let storageReads = 0;
  const windowObject = {
    __ECHO_NATIVE__: environment.native === true,
    addEventListener() { listeners.push("window"); },
    document,
    location: { search: environment.search || "" },
    navigator: { userAgent: environment.userAgent },
    setInterval() { timers.push("interval"); },
    setTimeout() { timers.push("timeout"); },
  };
  Object.defineProperty(windowObject, "localStorage", {
    configurable: true,
    get() {
      storageReads += 1;
      if (environment.throwStorage === true) throw new Error("storage blocked");
      return { getItem(key) { return storageValues.get(key) ?? null; } };
    },
  });
  const context = {
    URLSearchParams,
    globalThis: null,
    module: { exports: {} },
    window: windowObject,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "android-firefox-presentation-recovery-loader.js"), "utf8"),
    context,
  );
  return { api: context.module.exports, context, document, listeners, requests, storageReads, timers };
}

const androidFirefox =
  "Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0";

test("only exact non-native Android Firefox phones request the recovery module", () => {
  const platforms = [
    ["Android Firefox phone", androidFirefox, false, 1],
    ["Windows Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36", false, 0],
    ["Windows Firefox", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0", false, 0],
    ["Windows WebView2 shell", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36 Edg/153.0", true, 0],
    ["macOS Chrome", "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/537.36 Chrome/153.0 Safari/537.36", false, 0],
    ["macOS Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15", false, 0],
    ["Android Chrome", "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 Chrome/153.0 Mobile Safari/537.36", false, 0],
    ["Android Firefox tablet", "Mozilla/5.0 (Android 16; Tablet; rv:153.0) Gecko/153.0 Firefox/153.0", false, 0],
    ["iOS Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1", false, 0],
    ["iOS Firefox", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 FxiOS/153.0 Mobile/15E148 Safari/605.1.15", false, 0],
  ];

  for (const [label, userAgent, native, expectedRequests] of platforms) {
    const result = loadLoader({ native, userAgent });
    assert.equal(result.requests.length, expectedRequests, label);
    if (!expectedRequests) {
      assert.deepEqual(result.listeners, [], label + " installs no listeners");
      assert.deepEqual(result.timers, [], label + " installs no timers");
    }
  }
});

test("the phone feature flag is an immediate module-level kill switch", () => {
  assert.equal(loadLoader({ userAgent: androidFirefox, search: "?echoAndroidFirefoxPresentationRecovery=0" }).requests.length, 0);
  assert.equal(loadLoader({ userAgent: androidFirefox, storage: { "echo-android-firefox-presentation-recovery": "0" } }).requests.length, 0);
  assert.equal(loadLoader({ userAgent: androidFirefox, search: "?echoAndroidFirefoxPresentationRecovery=1", storage: { "echo-android-firefox-presentation-recovery": "0" } }).requests.length, 1);
});

test("loader safely handles blocked storage and never reads it for non-target clients", () => {
  const target = loadLoader({ userAgent: androidFirefox, throwStorage: true });
  assert.equal(target.requests.length, 1);
  assert.equal(target.storageReads, 1);

  const desktop = loadLoader({
    throwStorage: true,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/153.0",
  });
  assert.equal(desktop.requests.length, 0);
  assert.equal(desktop.storageReads, 0);
});

test("loader is idempotent after its automatic exact-target request", () => {
  const result = loadLoader({ userAgent: androidFirefox });
  assert.equal(result.requests.length, 1);
  assert.equal(result.api.load({
    document: result.document,
    userAgent: androidFirefox,
  }), false);
  assert.equal(result.requests.length, 1);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "android-firefox-presentation-recovery-loader.js"), "utf8"),
    result.context,
  );
  assert.equal(result.requests.length, 1, "a duplicate loader evaluation finds the existing tag");
});

test("the shared runtime isolation allowlist contains only the loader seam", () => {
  const index = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.equal((index.match(/android-firefox-presentation-recovery-loader\.js/g) || []).length, 1);
  for (const sharedFile of [
    "app.js", "connect.js", "participants-grid.js", "participants-fullscreen.js",
    "screen-share-adaptive.js", "room-switch-state.js",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, sharedFile), "utf8");
    assert.doesNotMatch(source, /android-firefox-presentation-recovery\.js/,
      sharedFile + " must not load or depend on the presentation module");
  }
});
