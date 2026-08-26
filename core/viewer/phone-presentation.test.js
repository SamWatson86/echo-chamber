const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createFullscreenExitStabilizer,
  createPhonePresentationController,
  isPhoneBrowser,
  nearestSnap,
  resolveSheetHeights,
} = require("./phone-presentation.js");

const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 Chrome/153.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 Chrome/153.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36";

test("phone classification requires a non-native phone hint or exact phone UA", () => {
  const fixtures = [
    ["Android phone", { navigator: { userAgent: ANDROID_PHONE } }, true],
    ["iPhone", { navigator: { userAgent: IPHONE } }, true],
    ["mobile client hint", { navigator: { userAgent: WINDOWS, userAgentData: { mobile: true } } }, true],
    ["desktop client hint overrides a misleading UA", { navigator: { userAgent: ANDROID_PHONE, userAgentData: { mobile: false } } }, false],
    ["Android tablet", { navigator: { userAgent: ANDROID_TABLET } }, false],
    ["iPad", { navigator: { userAgent: IPAD } }, false],
    ["Windows desktop", { navigator: { userAgent: WINDOWS } }, false],
    ["touch Windows desktop", { navigator: { userAgent: WINDOWS, maxTouchPoints: 10 } }, false],
    ["native Android shell", { navigator: { userAgent: ANDROID_PHONE }, isNativeShell: true }, false],
  ];
  fixtures.forEach(([label, environment, expected]) => {
    assert.equal(isPhoneBrowser(environment), expected, label);
  });
});

test("desktop and ultrawide viewport sizes never affect phone classification", () => {
  [390, 1280, 1920, 3440, 5120].forEach((width) => {
    assert.equal(isPhoneBrowser({
      navigator: { userAgent: WINDOWS, maxTouchPoints: width === 390 ? 10 : 0 },
      viewportWidth: width,
    }), false, `${width}px Windows viewport`);
  });
});

test("sheet snaps preserve an exact peek and at least 96px of Stage", () => {
  const heights = resolveSheetHeights(600);
  assert.deepEqual(heights, { peek: 72, half: 204, full: 504 });
  assert.equal(600 - heights.full, 96);
  assert.equal(nearestSnap(80, heights), "peek");
  assert.equal(nearestSnap(220, heights), "half");
  assert.equal(nearestSnap(490, heights), "full");
});

test("supported portrait phone viewports retain the phone gate and Stage reserve", () => {
  [[360, 640], [390, 844], [412, 915]].forEach(([width, height]) => {
    assert.equal(isPhoneBrowser({
      navigator: { userAgent: ANDROID_PHONE },
      viewportWidth: width,
      viewportHeight: height,
    }), true, `${width}x${height}`);
    const snaps = resolveSheetHeights(height);
    assert.equal(snaps.peek, 72, `${width}x${height} peek`);
    assert.equal(height - snaps.full, 96, `${width}x${height} Stage reserve`);
  });
});

function createStabilizerHarness() {
  const frames = [];
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  const document = { fullscreenElement: null };
  const window = {
    visualViewport: { width: 390, height: 700, offsetLeft: 0, offsetTop: 0, scale: 1 },
    setTimeout() {},
    clearTimeout() {},
  };
  const stabilize = createFullscreenExitStabilizer({
    window,
    document,
    now: () => now,
    requestFrame(callback) { frames.push(callback); return frames.length; },
    setTimer(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimer(id) { timers.delete(id); },
  });
  return {
    document,
    window,
    stabilize,
    flushFrame() {
      const callback = frames.shift();
      assert.ok(callback, "expected a queued animation frame");
      callback();
    },
    fireTimer(delay) {
      const entry = Array.from(timers.entries()).find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
    setNow(value) { now = value; },
  };
}

test("fullscreen exit waits for two stable viewport frames, measures once, and recovers once", () => {
  const harness = createStabilizerHarness();
  let measurements = 0;
  let recoveries = 0;
  const context = {
    isCurrent: () => true,
    measure() { measurements += 1; },
    hasAdvanced: () => false,
    isPaused: () => false,
    recover() { recoveries += 1; },
  };
  assert.equal(harness.stabilize(context), true);
  harness.flushFrame();
  assert.equal(measurements, 0);
  harness.flushFrame();
  assert.equal(measurements, 1);
  harness.fireTimer(750);
  assert.equal(recoveries, 1);
  assert.equal(measurements, 1);
});

test("fullscreen exit skips recovery when the same generation advances", () => {
  const harness = createStabilizerHarness();
  let recoveries = 0;
  let advanced = false;
  harness.stabilize({
    isCurrent: () => true,
    measure() {},
    hasAdvanced: () => advanced,
    isPaused: () => false,
    recover() { recoveries += 1; },
  });
  harness.flushFrame();
  harness.flushFrame();
  advanced = true;
  harness.fireTimer(750);
  assert.equal(recoveries, 0);
});

test("fullscreen exit aborts stale media generations without measuring or recovering", () => {
  const harness = createStabilizerHarness();
  let current = true;
  let measurements = 0;
  let recoveries = 0;
  harness.stabilize({
    isCurrent: () => current,
    measure() { measurements += 1; },
    hasAdvanced: () => false,
    isPaused: () => true,
    recover() { recoveries += 1; },
  });
  harness.flushFrame();
  current = false;
  harness.flushFrame();
  assert.equal(measurements, 0);
  assert.equal(recoveries, 0);
});

test("ten sequential fullscreen exits remain bounded to one recovery each", () => {
  const harness = createStabilizerHarness();
  let measurements = 0;
  let recoveries = 0;
  for (let cycle = 0; cycle < 10; cycle += 1) {
    harness.stabilize({
      isCurrent: () => true,
      measure() { measurements += 1; },
      hasAdvanced: () => false,
      isPaused: () => true,
      recover() { recoveries += 1; },
    });
    harness.flushFrame();
    harness.flushFrame();
    harness.fireTimer(750);
  }
  assert.equal(measurements, 10);
  assert.equal(recoveries, 10);
});

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, String(value)); }
  removeProperty(name) { this.values.delete(name); }
  getPropertyValue(name) { return this.values.get(name) || ""; }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = {
      values: new Set(),
      contains: (value) => this.classList.values.has(value),
      add: (value) => this.classList.values.add(value),
    };
    this.clientHeight = 0;
    this.hidden = false;
    this.inert = false;
  }
  get firstChild() { return this.children[0] || null; }
  set className(value) { this._className = value; }
  get className() { return this._className || ""; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  insertBefore(child, reference) {
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    child.parentElement = this;
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type, event = {}) {
    (this.listeners.get(type) || []).forEach((listener) => listener(event));
  }
}

function createControllerHarness() {
  const root = new FakeElement("html");
  root.dataset.uiShell = "v2";
  const workspace = new FakeElement();
  workspace.clientHeight = 600;
  const utility = new FakeElement();
  const people = new FakeElement();
  const header = new FakeElement();
  const users = new FakeElement();
  people.append(header, users);
  const elements = new Map([
    ["utility-host", utility],
    ["room-sidebar", people],
  ]);
  const documentListeners = new Map();
  const document = {
    documentElement: root,
    fullscreenElement: null,
    createElement: (tagName) => new FakeElement(tagName),
    querySelector: (selector) => selector === '[data-ui-region="workspace"]' ? workspace : null,
    getElementById: (id) => elements.get(id) || null,
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    removeEventListener(type) { documentListeners.delete(type); },
  };
  const storage = new Map();
  const listeners = new Map();
  let portrait = true;
  let workspaceResize = null;
  const window = {
    navigator: { userAgent: ANDROID_PHONE },
    innerWidth: 390,
    innerHeight: 844,
    performance: { now: () => 0 },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    matchMedia: () => ({ matches: portrait }),
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    ResizeObserver: class {
      constructor(callback) { workspaceResize = callback; }
      observe() {}
      disconnect() {}
    },
  };
  return {
    document,
    header,
    people,
    root,
    storage,
    users,
    utility,
    window,
    workspace,
    resizeWorkspace() {
      assert.equal(typeof workspaceResize, "function");
      workspaceResize();
    },
    setPortrait(value) { portrait = value; },
  };
}

test("phone controller defaults visible at half and restores its snap across orientation", () => {
  const harness = createControllerHarness();
  const controller = createPhonePresentationController(harness);
  controller.start();
  assert.equal(harness.root.dataset.echoPhone, "true");
  assert.equal(harness.root.dataset.echoPhoneSheetSnap, "half");
  assert.equal(harness.utility.style.getPropertyValue("--echo-phone-sheet-height"), "204px");
  assert.equal(harness.people.children[0].className, "phone-sheet-toolbar");
  assert.equal(harness.people.children[0].hidden, false);

  controller.setSnap("peek");
  assert.equal(harness.header.inert, true);
  assert.equal(harness.users.inert, true);
  controller.setSnap("half");
  assert.equal(harness.header.inert, false);
  assert.equal(harness.users.inert, false);

  controller.setSnap("full");
  assert.equal(harness.storage.get("echo-phone-sheet-snap"), "full");
  assert.equal(harness.utility.style.getPropertyValue("--echo-phone-sheet-height"), "504px");

  harness.root.classList.add("utility-collapsed");
  harness.setPortrait(false);
  controller.measureNow();
  assert.equal(harness.root.dataset.echoPhoneOrientation, "landscape");
  assert.equal(harness.utility.style.getPropertyValue("--echo-phone-sheet-height"), "");
  assert.equal(harness.root.classList.contains("utility-collapsed"), true);

  harness.setPortrait(true);
  controller.measureNow();
  assert.equal(controller.snap(), "full");
  assert.equal(harness.utility.style.getPropertyValue("--echo-phone-sheet-height"), "504px");
  assert.equal(harness.root.classList.contains("utility-collapsed"), true);
  assert.equal(harness.people.listeners.size, 0, "dragging is not attached to the People panel");
  const toolbar = harness.people.children[0];
  assert.equal(toolbar.children[0].attributes.get("role"), "separator");
  assert.equal(toolbar.children[1].attributes.get("aria-label"), "Make People and Tools smaller");
  assert.equal(toolbar.children[2].attributes.get("aria-label"), "Make People and Tools larger");
});

test("phone sheet drag and buttons move only between the three bounded snaps", () => {
  const harness = createControllerHarness();
  const controller = createPhonePresentationController(harness);
  controller.start();
  const toolbar = harness.people.children[0];
  const handle = toolbar.children[0];
  const minimize = toolbar.children[1];
  const expand = toolbar.children[2];
  const pointerEvent = (overrides) => Object.assign({
    button: 0,
    pointerId: 7,
    clientY: 400,
    preventDefault() {},
  }, overrides);

  handle.dispatch("pointerdown", pointerEvent());
  handle.dispatch("pointermove", pointerEvent({ clientY: 100 }));
  handle.dispatch("pointerup", pointerEvent({ clientY: 100 }));
  assert.equal(controller.snap(), "full");
  assert.equal(harness.utility.style.getPropertyValue("--echo-phone-sheet-height"), "504px");

  handle.dispatch("pointerdown", pointerEvent({ clientY: 100 }));
  handle.dispatch("pointermove", pointerEvent({ clientY: 600 }));
  handle.dispatch("pointerup", pointerEvent({ clientY: 600 }));
  assert.equal(controller.snap(), "peek");
  assert.equal(harness.utility.style.getPropertyValue("--echo-phone-sheet-height"), "72px");

  expand.dispatch("click", {});
  assert.equal(controller.snap(), "half");
  minimize.dispatch("click", {});
  assert.equal(controller.snap(), "peek");
  assert.equal(harness.people.children[1], harness.header, "existing People header must not be cloned");
  assert.equal(harness.people.children[2], harness.users, "existing user list must not be cloned");
});

test("phone workspace waits for its first visible size instead of locking to zero", () => {
  const harness = createControllerHarness();
  harness.workspace.clientHeight = 0;
  const controller = createPhonePresentationController(harness);
  controller.start();
  assert.equal(harness.utility.style.getPropertyValue("--echo-phone-sheet-height"), "");
  assert.equal(harness.root.dataset.echoPhoneSheetSnap, "half");

  harness.workspace.clientHeight = 600;
  harness.resizeWorkspace();
  assert.equal(harness.utility.style.getPropertyValue("--echo-phone-sheet-height"), "204px");
});

test("phone presentation CSS has no unscoped desktop selectors", () => {
  const css = fs.readFileSync(path.join(__dirname, "phone-presentation.css"), "utf8");
  const selectorLines = css.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return (trimmed.endsWith(",") || trimmed.endsWith("{")) && !trimmed.startsWith("@media");
  });
  selectorLines.forEach((line) => {
    assert.match(
      line.trim(),
      /^:root\[data-ui-shell="v2"\]\[data-echo-phone="true"\]\[data-echo-phone-orientation="portrait"\]/,
      line
    );
  });
  assert.match(css, /max-height:\s*calc\(100% - 96px\)/);
  assert.doesNotMatch(css, /@media\s*\(max-width:/);
});
