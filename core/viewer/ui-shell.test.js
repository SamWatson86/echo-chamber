const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createShellController,
  parseFlagValue,
  resolveShellVariant,
} = require("./ui-shell.js");

function createHarness(policyOverride) {
  const attributes = new Set();
  const rootElement = {
    clientWidth: 1280,
    clientHeight: 720,
    dataset: {},
    removeAttribute(name) {
      attributes.delete(name);
    },
    toggleAttribute(name, force) {
      if (force) attributes.add(name);
      else attributes.delete(name);
    },
  };
  const listeners = new Map();
  const frames = new Map();
  let frameId = 0;
  const storage = new Map();
  const win = {
    innerWidth: 1280,
    innerHeight: 720,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((value) => value !== listener));
    },
    requestAnimationFrame(callback) {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  };
  const policy = policyOverride === undefined
    ? {
      resolveLayoutPolicy({ width, height, previousMode }) {
        const mode = width >= 1280 && height >= 720
          ? "theater"
          : width >= 900 && height >= 600
            ? "lounge"
            : width >= 640 && height >= 480
              ? "compact"
              : "mini";
        return {
          mode: previousMode === "compact" && width === 600 ? "compact" : mode,
          width,
          height,
          isShort: height < 650,
          isVeryShort: height < 520,
        };
      },
    }
    : policyOverride;

  return {
    attributes,
    document: { documentElement: rootElement },
    flushFrame() {
      const pending = Array.from(frames.entries());
      frames.clear();
      pending.forEach(([, callback]) => callback());
    },
    frames,
    listeners,
    policy,
    rootElement,
    storage,
    window: win,
  };
}

test("flag parsing accepts explicit on and off values without guessing", () => {
  for (const value of [true, 1, "1", "true", "on", "yes", "enabled", "v2"]) {
    assert.equal(parseFlagValue(value), true, String(value));
  }
  for (const value of [false, 0, "0", "false", "off", "no", "disabled", "legacy"]) {
    assert.equal(parseFlagValue(value), false, String(value));
  }
  for (const value of [null, undefined, "", "surprise"]) {
    assert.equal(parseFlagValue(value), null, String(value));
  }
});

test("query override wins over storage and absence defaults to v2", () => {
  assert.equal(resolveShellVariant({ search: "", storedValue: null }), "v2");
  assert.equal(resolveShellVariant({ search: "", storedValue: "1" }), "v2");
  assert.equal(resolveShellVariant({ search: "", storedValue: "0" }), "legacy");
  assert.equal(resolveShellVariant({ search: "?echo-ui-shell-v2=1", storedValue: "0" }), "v2");
  assert.equal(resolveShellVariant({ search: "?echo-ui-shell-v2=0", storedValue: "1" }), "legacy");
});

test("controller writes responsive attributes and clears them in legacy mode", () => {
  const harness = createHarness();
  const controller = createShellController(harness);

  controller.start("v2");
  assert.equal(harness.rootElement.dataset.uiShell, "v2");
  assert.equal(harness.rootElement.dataset.uiMode, "theater");
  assert.equal(harness.attributes.has("data-ui-short"), false);
  assert.equal(harness.attributes.has("data-ui-very-short"), false);

  harness.rootElement.clientWidth = 640;
  harness.rootElement.clientHeight = 480;
  controller.measureNow();
  assert.equal(harness.rootElement.dataset.uiMode, "compact");
  assert.equal(harness.attributes.has("data-ui-short"), true);
  assert.equal(harness.attributes.has("data-ui-very-short"), true);

  controller.applyVariant("legacy");
  assert.equal(harness.rootElement.dataset.uiShell, "legacy");
  assert.equal(harness.rootElement.dataset.uiMode, undefined);
  assert.equal(harness.attributes.has("data-ui-short"), false);
  assert.equal(harness.attributes.has("data-ui-very-short"), false);
});

test("resize bursts coalesce into one animation-frame measurement", () => {
  let measurements = 0;
  const harness = createHarness({
    resolveLayoutPolicy({ width, height }) {
      measurements += 1;
      return { mode: "lounge", width, height, isShort: false, isVeryShort: false };
    },
  });
  const controller = createShellController(harness);
  controller.start("v2");
  assert.equal(measurements, 1);
  assert.equal(harness.listeners.get("resize").length, 1);

  const resize = harness.listeners.get("resize")[0];
  resize();
  resize();
  resize();
  assert.equal(harness.frames.size, 1);
  assert.equal(measurements, 1);
  harness.flushFrame();
  assert.equal(measurements, 2);

  controller.start("v2");
  assert.equal(harness.listeners.get("resize").length, 1);
  controller.stop();
  assert.equal(harness.listeners.get("resize").length, 0);
});

test("missing layout policy fails closed to the legacy presentation", () => {
  const harness = createHarness(null);
  const controller = createShellController(harness);
  assert.equal(controller.start("v2"), null);
  assert.equal(harness.rootElement.dataset.uiShell, "legacy");
  assert.equal(harness.rootElement.dataset.uiMode, undefined);
});

test("runtime variant changes can persist without rebuilding the controller", () => {
  const harness = createHarness();
  const controller = createShellController(harness);
  controller.start("legacy");
  controller.applyVariant("v2", { persist: true });
  assert.equal(harness.storage.get("echo-ui-shell-v2"), "1");
  controller.applyVariant("legacy", { persist: true });
  assert.equal(harness.storage.get("echo-ui-shell-v2"), "0");
  assert.equal(harness.listeners.get("resize").length, 1);
});
