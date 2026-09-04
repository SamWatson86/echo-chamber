const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  createFullscreenExitStabilizer,
  createPhoneAudioPlaybackRecovery,
  createPhonePresentationController,
  createPhoneScreenVideoBudget,
  createPhoneWakeLockManager,
  isPhoneBrowser,
  nearestSnap,
  resolveSheetHeights,
} = require("./phone-presentation.js");

const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 Chrome/153.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 Chrome/153.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36";

test("browser bootstrap publishes one frozen idempotent API without throwing", () => {
  const source = fs.readFileSync(path.join(__dirname, "phone-presentation.js"), "utf8");
  const domReadyListeners = [];
  const context = {
    document: {
      readyState: "loading",
      documentElement: { dataset: {} },
      addEventListener(type, listener) {
        if (type === "DOMContentLoaded") domReadyListeners.push(listener);
      },
    },
    navigator: { userAgent: ANDROID_PHONE },
  };
  context.globalThis = context;
  vm.createContext(context);

  assert.doesNotThrow(() => vm.runInContext(source, context, { filename: "phone-presentation.js" }));
  const firstApi = context.EchoPhonePresentation;
  assert.ok(firstApi);
  assert.equal(firstApi.__echoPhonePresentationApi, true);
  assert.equal(Object.isFrozen(firstApi), true);
  assert.equal(context.document.documentElement.dataset.echoPhone, "true");
  assert.equal(domReadyListeners.length, 1);

  assert.doesNotThrow(() => vm.runInContext(source, context, { filename: "phone-presentation.js" }));
  assert.equal(context.EchoPhonePresentation, firstApi);
  assert.equal(domReadyListeners.length, 1, "duplicate load must not install a second bootstrap");
});

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

function createMediaRoom(sid, localIdentity = "local") {
  return {
    sid,
    localParticipant: { identity: localIdentity },
    remoteParticipants: new Map(),
  };
}

function addRemote(room, identity) {
  const participant = { identity };
  room.remoteParticipants.set(identity, participant);
  return participant;
}

function screenPublication(trackSid) {
  return { trackSid, source: "screen_share", kind: "video" };
}

test("phone screen budget permits every track except all but one exact remote screen video", () => {
  const budget = createPhoneScreenVideoBudget({ isEnabled: true });
  const room = createMediaRoom("RM_one");
  const alex = addRemote(room, "alex$screen");
  const blake = addRemote(room, "blake");
  const alexScreen = screenPublication("TR_alex");
  const blakeScreen = screenPublication("TR_blake");
  budget.beginRoom(room);
  assert.equal(budget.observe(alexScreen, alex, room), true);
  assert.equal(budget.observe(blakeScreen, blake, room), true);
  assert.equal(budget.selectedIdentity(room), "alex");
  assert.equal(budget.isSelected(alexScreen, alex, room), true);
  assert.equal(budget.isSelected(blakeScreen, blake, room), false);

  assert.equal(budget.hide(room), true);
  assert.equal(budget.isSelected(alexScreen, alex, room), false);
  assert.equal(budget.isSelected(blakeScreen, blake, room), false);
  assert.equal(budget.selectIdentity("blake", room), true);
  assert.equal(budget.isSelected(blakeScreen, blake, room), true);
  assert.equal(budget.isSelected(alexScreen, alex, room), false);
});

test("phone screen budget fences publication, participant, room SID, and room generations", () => {
  const budget = createPhoneScreenVideoBudget({ isEnabled: true });
  const roomOne = createMediaRoom("RM_one");
  const firstParticipant = addRemote(roomOne, "alex$screen");
  const firstPublication = screenPublication("TR_first");
  budget.beginRoom(roomOne);
  budget.observe(firstPublication, firstParticipant, roomOne);

  const replacementPublication = screenPublication("TR_replacement");
  assert.equal(budget.observe(replacementPublication, firstParticipant, roomOne), true);
  assert.equal(budget.isSelected(firstPublication, firstParticipant, roomOne), false);
  assert.equal(budget.isSelected(replacementPublication, firstParticipant, roomOne), true);
  assert.equal(budget.forget(firstPublication, firstParticipant, roomOne), false,
    "a late unpublish cannot remove its replacement");

  const replacementParticipant = { identity: "alex$screen" };
  roomOne.remoteParticipants.set(replacementParticipant.identity, replacementParticipant);
  const nextGenerationPublication = screenPublication("TR_next_generation");
  assert.equal(budget.observe(nextGenerationPublication, replacementParticipant, roomOne), true);
  assert.equal(budget.forgetParticipant(firstParticipant, roomOne), false,
    "a departed participant object cannot clear the current participant generation");
  assert.equal(budget.isSelected(nextGenerationPublication, replacementParticipant, roomOne), true);

  const roomTwo = createMediaRoom("RM_two");
  const roomTwoParticipant = addRemote(roomTwo, "blake");
  const roomTwoPublication = screenPublication("TR_room_two");
  budget.beginRoom(roomTwo);
  assert.equal(budget.observe(roomTwoPublication, roomTwoParticipant, roomTwo), true);
  assert.equal(budget.clearRoom(roomOne), false, "a stale room cannot clear the new generation");
  assert.equal(budget.isSelected(nextGenerationPublication, replacementParticipant, roomOne), false);
  assert.equal(budget.isSelected(roomTwoPublication, roomTwoParticipant, roomTwo), true);

  roomTwo.sid = "RM_mutated";
  assert.equal(budget.hide(roomTwo), false, "a changed room SID fails the exact-room fence");
});

test("disabled phone screen budget is an inert desktop pass-through", () => {
  const budget = createPhoneScreenVideoBudget({ isEnabled: false });
  const room = createMediaRoom("RM_desktop");
  const participant = addRemote(room, "desktop-publisher");
  const publication = screenPublication("TR_desktop");
  budget.beginRoom(room);
  assert.equal(budget.observe(publication, participant, room), false);
  assert.equal(budget.isSelected(publication, participant, room), true);
  assert.deepEqual(budget.entries(room), []);
});

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return Object.assign(initial, {
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      const values = listeners.get(type) || [];
      listeners.set(type, values.filter((value) => value !== listener));
    },
    dispatch(type, event = {}) {
      (listeners.get(type) || []).slice().forEach((listener) => listener(event));
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
  });
}

function createWakeSentinel(name) {
  const target = createEventTarget({ name, released: false, releases: 0 });
  target.release = async function () {
    if (!target.released) {
      target.released = true;
      target.releases += 1;
      target.dispatch("release");
    }
  };
  return target;
}

async function flushMicrotasks(turns = 6) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

test("phone wake lock is single-flight and follows visible, hidden, pageshow, and pagehide", async () => {
  const document = createEventTarget({ visibilityState: "visible" });
  const window = createEventTarget();
  const sentinels = [];
  let requests = 0;
  const manager = createPhoneWakeLockManager({
    isEnabled: true,
    document,
    window,
    navigator: {
      wakeLock: {
        async request(type) {
          assert.equal(type, "screen");
          requests += 1;
          const sentinel = createWakeSentinel(`sentinel-${requests}`);
          sentinels.push(sentinel);
          return sentinel;
        },
      },
    },
  });
  const room = { sid: "RM_wake" };

  await Promise.all([manager.setRoom(room), manager.setRoom(room), manager.setRoom(room)]);
  assert.equal(requests, 1);
  assert.equal(sentinels[0].released, false);
  assert.equal(document.listenerCount("visibilitychange"), 1);
  assert.equal(window.listenerCount("pageshow"), 1);
  assert.equal(window.listenerCount("pagehide"), 1);

  document.visibilityState = "hidden";
  document.dispatch("visibilitychange");
  await flushMicrotasks();
  assert.equal(sentinels[0].releases, 1);
  assert.equal(sentinels[0].released, true);

  document.visibilityState = "visible";
  document.dispatch("visibilitychange");
  document.dispatch("visibilitychange");
  window.dispatch("pageshow");
  await flushMicrotasks();
  assert.equal(requests, 2, "resume events coalesce into one wake-lock request");
  assert.equal(sentinels[1].released, false);

  window.dispatch("pagehide");
  await flushMicrotasks();
  assert.equal(sentinels[1].releases, 1);
  assert.equal(sentinels[1].released, true);
  await manager.clearRoom(room);
  assert.equal(document.listenerCount("visibilitychange"), 0);
  assert.equal(window.listenerCount("pageshow"), 0);
  assert.equal(window.listenerCount("pagehide"), 0);
});

test("phone wake lock forgets a terminal pagehide before a later room reconnect", async () => {
  const document = createEventTarget({ visibilityState: "visible" });
  const window = createEventTarget();
  let requests = 0;
  const manager = createPhoneWakeLockManager({
    isEnabled: true,
    document,
    window,
    navigator: {
      wakeLock: {
        async request() {
          requests += 1;
          return createWakeSentinel(`sentinel-${requests}`);
        },
      },
    },
  });
  const roomOne = { sid: "RM_one" };
  const roomTwo = { sid: "RM_two" };

  assert.equal(await manager.setRoom(roomOne), true);
  window.dispatch("pagehide");
  await flushMicrotasks();
  assert.equal(await manager.clearRoom(roomOne), false);

  // The old lifecycle removed its pageshow listener. A new visible Room must
  // still request a fresh lock instead of inheriting the stale pagehide flag.
  window.dispatch("pageshow");
  assert.equal(await manager.setRoom(roomTwo), true);
  assert.equal(requests, 2);
  await manager.clearRoom(roomTwo);
});

test("phone wake lock releases a late stale-room grant and only retains the exact new room", async () => {
  const document = createEventTarget({ visibilityState: "visible" });
  const window = createEventTarget();
  const firstSentinel = createWakeSentinel("first");
  const secondSentinel = createWakeSentinel("second");
  let resolveFirst;
  let requests = 0;
  const firstRequest = new Promise((resolve) => { resolveFirst = resolve; });
  const manager = createPhoneWakeLockManager({
    isEnabled: true,
    document,
    window,
    navigator: {
      wakeLock: {
        request() {
          requests += 1;
          return requests === 1 ? firstRequest : Promise.resolve(secondSentinel);
        },
      },
    },
  });
  const roomOne = { sid: "RM_one" };
  const roomTwo = { sid: "RM_two" };
  const oldSet = manager.setRoom(roomOne);
  await flushMicrotasks();
  assert.equal(requests, 1);
  const newSet = manager.setRoom(roomTwo);
  resolveFirst(firstSentinel);
  assert.equal(await oldSet, false);
  assert.equal(await newSet, true);
  assert.equal(requests, 2);
  assert.equal(firstSentinel.releases, 1, "the stale grant is immediately released");
  assert.equal(secondSentinel.released, false);
  assert.equal(await manager.clearRoom(roomOne), false, "a stale room cannot release the new room lock");
  assert.equal(secondSentinel.released, false);
  assert.equal(await manager.clearRoom(roomTwo), true);
  assert.equal(secondSentinel.releases, 1);
});

test("phone wake lock stays held across an exact room switch", async () => {
  const document = createEventTarget({ visibilityState: "visible" });
  const window = createEventTarget();
  const sentinel = createWakeSentinel("shared");
  let requests = 0;
  const manager = createPhoneWakeLockManager({
    isEnabled: true,
    document,
    window,
    navigator: { wakeLock: { async request() { requests += 1; return sentinel; } } },
  });
  const roomOne = { sid: "RM_one" };
  const roomTwo = { sid: "RM_two" };

  assert.equal(await manager.setRoom(roomOne), true);
  assert.equal(await manager.setRoom(roomTwo), true);
  assert.equal(requests, 1, "a held screen lock is not released and reacquired while switching rooms");
  assert.equal(sentinel.releases, 0);
  assert.equal(await manager.clearRoom(roomOne), false);
  assert.equal(await manager.clearRoom(roomTwo), true);
  assert.equal(sentinel.releases, 1);
});

test("phone wake lock releases instead of transferring during a hidden-state room switch", async () => {
  const document = createEventTarget({ visibilityState: "visible" });
  const window = createEventTarget();
  const firstSentinel = createWakeSentinel("first");
  const secondSentinel = createWakeSentinel("second");
  let requests = 0;
  const manager = createPhoneWakeLockManager({
    isEnabled: true,
    document,
    window,
    navigator: { wakeLock: { async request() { requests += 1; return requests === 1 ? firstSentinel : secondSentinel; } } },
  });
  const roomOne = { sid: "RM_one" };
  const roomTwo = { sid: "RM_two" };

  await manager.setRoom(roomOne);
  document.visibilityState = "hidden";
  assert.equal(await manager.setRoom(roomTwo), false);
  assert.equal(firstSentinel.releases, 1);
  assert.equal(requests, 1);
  document.visibilityState = "visible";
  document.dispatch("visibilitychange");
  await flushMicrotasks();
  assert.equal(requests, 2);
  await manager.clearRoom(roomTwo);
});

test("disabled phone wake lock never touches the desktop lifecycle", async () => {
  const document = createEventTarget({ visibilityState: "visible" });
  const window = createEventTarget();
  let requests = 0;
  const manager = createPhoneWakeLockManager({
    isEnabled: false,
    document,
    window,
    navigator: { wakeLock: { request() { requests += 1; } } },
  });
  assert.equal(await manager.setRoom({ sid: "RM_desktop" }), false);
  assert.equal(requests, 0);
  assert.equal(document.listenerCount("visibilitychange"), 0);
  assert.equal(window.listenerCount("pageshow"), 0);
});

test("phone audio recovery queues all current audio and clears only after confirmed single-flight success", async () => {
  let videoPlayCalls = 0;
  const video = {
    id: "pending-video",
    tagName: "VIDEO",
    async play() { videoPlayCalls += 1; },
  };
  const voice = { id: "voice" };
  const screenAudio = { id: "screen-audio" };
  const detachedAudio = { id: "detached", isConnected: false };
  const pending = new Set([video]);
  const prompts = [];
  let currentRoom;
  let resolveStart;
  let starts = 0;
  const startFlight = new Promise((resolve) => { resolveStart = resolve; });
  const room = {
    sid: "RM_audio",
    canPlaybackAudio: false,
    startAudio() {
      starts += 1;
      return startFlight;
    },
  };
  currentRoom = room;
  const recovery = createPhoneAudioPlaybackRecovery({
    isEnabled: true,
    getCurrentRoom: () => currentRoom,
    getAudioElements: () => [voice, screenAudio, detachedAudio],
    getPendingElements: () => pending,
    onPromptChange: (state) => prompts.push(state),
  });

  recovery.setRoom(room);
  assert.equal(recovery.handlePlaybackStatus(room, false), true);
  assert.deepEqual(new Set(pending), new Set([video, voice, screenAudio]));
  assert.deepEqual(prompts.at(-1), { visible: true, label: "Restore audio", blocked: true });
  const firstRecover = recovery.recover(room);
  const secondRecover = recovery.recover(room);
  assert.equal(firstRecover, secondRecover, "concurrent recovery attempts share one promise");
  await flushMicrotasks();
  assert.equal(starts, 1);
  room.canPlaybackAudio = true;
  resolveStart();
  assert.equal(await firstRecover, true);
  assert.equal(videoPlayCalls, 1, "the same gesture also retries legacy pending video");
  assert.deepEqual(new Set(pending), new Set(), "confirmed audio and video playback clear their own entries");
  assert.equal(recovery.isBlocked(room), false);
  assert.deepEqual(prompts.at(-1), { visible: false, label: "Enable Videos", blocked: false });
});

test("phone audio recovery keeps the prompt and queue on rejection or unconfirmed playback", async () => {
  const audio = { id: "audio" };
  const blockedVideo = {
    id: "blocked-video",
    tagName: "VIDEO",
    play: () => Promise.reject(new Error("video still blocked")),
  };
  const pending = new Set([blockedVideo]);
  const prompts = [];
  let currentRoom;
  let attempt = 0;
  const room = {
    sid: "RM_audio_failure",
    canPlaybackAudio: false,
    startAudio() {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("gesture lost"));
      return Promise.resolve();
    },
  };
  currentRoom = room;
  const recovery = createPhoneAudioPlaybackRecovery({
    isEnabled: true,
    getCurrentRoom: () => currentRoom,
    getAudioElements: () => [audio],
    getPendingElements: () => pending,
    onPromptChange: (state) => prompts.push(state),
  });
  recovery.setRoom(room);

  assert.equal(await recovery.recover(room), false);
  assert.equal(recovery.isBlocked(room), true);
  assert.equal(pending.has(audio), true);
  assert.equal(pending.has(blockedVideo), true, "a failed video retry remains available to the next gesture");
  assert.deepEqual(prompts.at(-1), { visible: true, label: "Restore audio", blocked: true });
  assert.equal(await recovery.recover(room), false, "a resolved startAudio without canPlaybackAudio is not success");
  assert.equal(pending.has(audio), true);
  assert.equal(recovery.isBlocked(room), true);

  room.canPlaybackAudio = true;
  assert.equal(recovery.handlePlaybackStatus(room, true), true);
  assert.equal(pending.has(audio), false);
  assert.equal(pending.has(blockedVideo), true);
  assert.equal(recovery.isBlocked(room), false);
  assert.deepEqual(prompts.at(-1), { visible: true, label: "Enable Videos", blocked: false });
});

test("late audio success and stale status cannot clear a replacement room generation", async () => {
  const roomOneAudio = { id: "room-one-audio" };
  const roomTwoAudio = { id: "room-two-audio" };
  const pending = new Set();
  let currentRoom;
  let currentAudio = [roomOneAudio];
  let resolveOldStart;
  const oldStart = new Promise((resolve) => { resolveOldStart = resolve; });
  const roomOne = { sid: "RM_one", canPlaybackAudio: false, startAudio: () => oldStart };
  const roomTwo = { sid: "RM_two", canPlaybackAudio: false, startAudio: () => Promise.resolve() };
  currentRoom = roomOne;
  const recovery = createPhoneAudioPlaybackRecovery({
    isEnabled: true,
    getCurrentRoom: () => currentRoom,
    getAudioElements: () => currentAudio,
    getPendingElements: () => pending,
    onPromptChange() {},
  });
  recovery.setRoom(roomOne);
  recovery.handlePlaybackStatus(roomOne, false);
  const staleRecovery = recovery.recover(roomOne);
  await flushMicrotasks();

  currentRoom = roomTwo;
  currentAudio = [roomTwoAudio];
  recovery.setRoom(roomTwo);
  recovery.handlePlaybackStatus(roomTwo, false);
  assert.equal(pending.has(roomTwoAudio), true);
  roomOne.canPlaybackAudio = true;
  resolveOldStart();
  assert.equal(await staleRecovery, false);
  assert.equal(pending.has(roomTwoAudio), true, "late success cannot clear the current room queue");
  assert.equal(recovery.isBlocked(roomTwo), true);
  assert.equal(recovery.handlePlaybackStatus(roomOne, true), false, "stale playback events are ignored");
  assert.equal(recovery.isBlocked(roomTwo), true);
});

test("a never-settling old Room cannot block new-Room audio recovery", async () => {
  const pending = new Set();
  let currentRoom;
  let newStarts = 0;
  const roomOne = { sid: "RM_stuck", canPlaybackAudio: false, startAudio: () => new Promise(() => {}) };
  const roomTwo = {
    sid: "RM_current",
    canPlaybackAudio: true,
    startAudio() { newStarts += 1; return Promise.resolve(); },
  };
  currentRoom = roomOne;
  const recovery = createPhoneAudioPlaybackRecovery({
    isEnabled: true,
    getCurrentRoom: () => currentRoom,
    getAudioElements: () => [],
    getPendingElements: () => pending,
    onPromptChange() {},
  });
  recovery.setRoom(roomOne);
  recovery.recover(roomOne);
  currentRoom = roomTwo;
  recovery.setRoom(roomTwo);
  assert.equal(await recovery.recover(roomTwo), true);
  assert.equal(newStarts, 1);
});

test("room boundaries and retries prune removed pending media", async () => {
  const removedVideo = {
    isConnected: false,
    play: () => Promise.reject(new Error("removed")),
  };
  const currentVideo = {
    isConnected: true,
    play: () => Promise.reject(new Error("still blocked")),
  };
  const pending = new Set([removedVideo, currentVideo]);
  let currentRoom;
  const room = { sid: "RM_prune", canPlaybackAudio: false, startAudio: () => Promise.reject(new Error("blocked")) };
  currentRoom = room;
  const recovery = createPhoneAudioPlaybackRecovery({
    isEnabled: true,
    getCurrentRoom: () => currentRoom,
    getAudioElements: () => [],
    getPendingElements: () => pending,
    onPromptChange() {},
  });
  recovery.setRoom(room);
  await recovery.recover(room);
  assert.equal(pending.has(removedVideo), false);
  assert.equal(pending.has(currentVideo), true);
  recovery.clearRoom(room);
  assert.equal(pending.size, 0, "terminal room cleanup removes its stale retry nodes");
});

test("strict phone gate owns all three LiveKit auto-subscribe seams", () => {
  const stateSource = fs.readFileSync(path.join(__dirname, "state.js"), "utf8");
  const authSource = fs.readFileSync(path.join(__dirname, "auth.js"), "utf8");
  const connectSource = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const combined = authSource + "\n" + connectSource;

  assert.match(stateSource, /function isPhoneSessionStabilityEnabled\(\)[\s\S]*?EchoPhonePresentation\?\.isPhoneBrowser[\s\S]*?isNativeShell:\s*window\.__ECHO_NATIVE__ === true/);
  assert.equal((combined.match(/autoSubscribe:\s*!isPhoneSessionStabilityEnabled\(\)/g) || []).length, 3);
  assert.doesNotMatch(combined, /autoSubscribe:\s*true/);

  const orderedAssets = ["phone-presentation.js", "state.js", "auth.js", "audio-routing.js", "connect.js"];
  let previous = -1;
  orderedAssets.forEach((asset) => {
    const position = indexSource.indexOf(`src="${asset}?`);
    assert.ok(position > previous, `${asset} must load after the preceding stability dependency`);
    previous = position;
  });
  assert.equal((indexSource.match(/src="phone-presentation\.js\?/g) || []).length, 1);
});

test("phone integration subscribes all audio and switches only one screen video", () => {
  const participantSource = fs.readFileSync(path.join(__dirname, "participants.js"), "utf8");
  const calls = [];
  const makePublication = (owner, sid, source, kind) => ({
    owner,
    trackSid: sid,
    source,
    kind,
    isDesired: false,
    isSubscribed: false,
    setSubscribed(value) {
      this.isDesired = value;
      this.isSubscribed = value;
      calls.push(`${this.trackSid}:${value}`);
    },
  });
  const room = createMediaRoom("RM_integrated");
  const alex = addRemote(room, "alex$screen");
  const blake = addRemote(room, "blake$screen");
  alex.publications = [
    makePublication("alex", "alex-mic", "microphone", "audio"),
    makePublication("alex", "alex-game", "screen_share_audio", "audio"),
    makePublication("alex", "alex-video", "screen_share", "video"),
  ];
  blake.publications = [
    makePublication("blake", "blake-mic", "microphone", "audio"),
    makePublication("blake", "blake-game", "screen_share_audio", "audio"),
    makePublication("blake", "blake-video", "screen_share", "video"),
  ];
  const budget = createPhoneScreenVideoBudget({ isEnabled: true });
  budget.beginRoom(room);
  const context = {
    room,
    phoneScreenVideoBudget: budget,
    isPhoneSessionStabilityEnabled: () => true,
    getLiveKitClient: () => ({
      Track: {
        Kind: { Audio: "audio", Video: "video" },
        Source: { Camera: "camera", Microphone: "microphone", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" },
      },
    }),
    patchScreenCompanionSource() {},
    getParticipantPublications: (participant) => participant.publications || [],
    hiddenScreens: new Set(),
    participantCards: new Map(),
    participantState: new Map(),
    screenTrackMeta: new Map(),
    removeScreenTile() {},
    unregisterScreenTrack() {},
  };
  vm.createContext(context);
  vm.runInContext(participantSource, context, { filename: "participants.js" });

  assert.equal(context.reconcilePhoneScreenVideoSubscriptions(room), true);
  const all = [...alex.publications, ...blake.publications];
  assert.equal(all.filter((publication) => publication.kind === "audio" && publication.isDesired).length, 4);
  assert.deepEqual(all.filter((publication) => publication.source === "screen_share" && publication.isDesired)
    .map((publication) => publication.trackSid), ["alex-video"]);

  calls.length = 0;
  assert.equal(context.selectPhoneScreenVideoIdentity("blake", room), true);
  assert.deepEqual(calls.filter((value) => /-video:/.test(value)), ["alex-video:false", "blake-video:true"],
    "the old video is disabled before the replacement is enabled");
  assert.equal(all.filter((publication) => publication.kind === "audio" && publication.isDesired).length, 4);

  calls.length = 0;
  assert.equal(context.hidePhoneScreenVideo(room), true);
  assert.deepEqual(calls.filter((value) => /-video:/.test(value)), ["blake-video:false"]);
  assert.equal(all.filter((publication) => publication.kind === "audio" && publication.isDesired).length, 4,
    "hiding Stage video never hides voice or shared audio");
});

test("phone managers bind and clear at exact room boundaries", () => {
  const source = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");
  const swap = source.indexOf("room = newRoom;");
  const remoteScan = source.indexOf("const remoteList = room.remoteParticipants", swap);
  [
    "phoneScreenVideoBudget?.beginRoom?.(newRoom);",
    "phoneAudioPlaybackRecovery?.setRoom?.(newRoom);",
    "phoneWakeLockManager?.setRoom?.(newRoom);",
  ].forEach((statement) => {
    const position = source.indexOf(statement, swap);
    assert.ok(position > swap && position < remoteScan, `${statement} must bind the committed Room before media scan`);
  });

  const terminalStart = source.indexOf("newRoom.on(LK.RoomEvent.Disconnected");
  const terminalEnd = source.indexOf("if (LK.RoomEvent?.AudioPlaybackStatusChanged)", terminalStart);
  const terminal = source.slice(terminalStart, terminalEnd);
  const controlledReturn = terminal.indexOf("newRoom._echoRecoveryDisconnect === true");
  ["phoneWakeLockManager", "phoneAudioPlaybackRecovery", "phoneScreenVideoBudget"].forEach((name) => {
    const clear = terminal.indexOf(`${name}?.clearRoom?.(newRoom);`);
    assert.ok(clear >= 0 && clear < controlledReturn, `${name} must release the exact terminal Room`);
  });

  const disconnectStart = source.indexOf("async function disconnect()");
  const disconnectBody = source.slice(disconnectStart);
  const disconnectCall = disconnectBody.indexOf("disconnectingRoom.disconnect();");
  ["phoneWakeLockManager", "phoneAudioPlaybackRecovery", "phoneScreenVideoBudget"].forEach((name) => {
    const clear = disconnectBody.indexOf(`${name}?.clearRoom?.(disconnectingRoom);`);
    assert.ok(clear >= 0 && clear < disconnectCall, `${name} must clear before explicit disconnect`);
  });
});

test("phone audio attempts report through one recovery boundary", () => {
  const connectSource = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");
  const routingSource = fs.readFileSync(path.join(__dirname, "audio-routing.js"), "utf8");
  const helperStart = connectSource.indexOf("async function startRoomAudioWithRecovery(roomRef)");
  const helperEnd = connectSource.indexOf("function unlockAudio()", helperStart);
  const helper = connectSource.slice(helperStart, helperEnd);
  assert.match(helper, /await roomRef\.startAudio\(\)/);
  assert.match(helper, /phoneAudioPlaybackRecovery\.handlePlaybackStatus/);
  assert.match(helper, /phoneAudioPlaybackRecovery\.noteStartAudioFailure/);
  assert.ok((connectSource.match(/startRoomAudioWithRecovery\((?:newRoom|room)\)/g) || []).length >= 2);
  assert.match(routingSource, /startRoomAudioWithRecovery\(room\)\.catch/);

  const statusStart = connectSource.indexOf("LK.RoomEvent.AudioPlaybackStatusChanged");
  const staleGuard = connectSource.indexOf('ignoreStaleRoomEvent("audio playback status")', statusStart);
  const statusHandled = connectSource.indexOf("phoneAudioPlaybackRecovery?.handlePlaybackStatus", statusStart);
  assert.ok(statusStart >= 0 && staleGuard > statusStart && statusHandled > staleGuard);

  const interactionStart = connectSource.indexOf("const enableAllMedia = async () =>");
  const phoneRecover = connectSource.indexOf("await phoneAudioPlaybackRecovery.recover(room);", interactionStart);
  const desktopLegacy = connectSource.indexOf("room?.startAudio?.()", interactionStart);
  assert.ok(phoneRecover > interactionStart && desktopLegacy > phoneRecover,
    "phone recovery must return before the unchanged desktop gesture path");
});
