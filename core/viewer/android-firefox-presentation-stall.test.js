const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  getAndroidFirefoxPresentationRecoveryAction,
  isAndroidFirefoxPresentationRelayAction,
  markAndroidFirefoxPresentationRecoveryAction,
} = require("./participants-fullscreen.js");
const {
  getAndroidFirefoxStatsSingleFlight,
  isInboundScreenStatsPollCurrent,
  resolveInboundScreenStatsMonitorBinding,
  resolveSelectedIceCandidatePair,
} = require("./screen-share-adaptive.js");

const viewerDir = __dirname;
const rnnoiseSource = fs.readFileSync(path.join(viewerDir, "rnnoise.js"), "utf8");
function loadRealBrowserPredicate() {
  const context = {
    navigator: { userAgent: "", platform: "" },
    echoGet() { return null; },
    debugLog() {},
  };
  vm.createContext(context);
  vm.runInContext(rnnoiseSource, context, { filename: "rnnoise.js" });
  return context.isAndroidFirefoxBrowser;
}
const isAndroidFirefoxBrowser = loadRealBrowserPredicate();
global.isAndroidFirefoxBrowser = isAndroidFirefoxBrowser;
const {
  containAndroidFirefoxScreenTileClick,
  containAndroidFirefoxUtilityScrimClick,
  isPointInsideVisibleRemoteScreenPresentation,
  shouldSuppressAndroidFirefoxScreenPresentationInteractions,
} = require("./participants-grid.js");

test("presentation recovery is sink, subscription, relay and rearms only after sustained progress", () => {
  const states = new Map();
  const base = {
    enabled: true,
    current: true,
    trackSid: "TR_screen",
    recoveryStateBySid: states,
  };

  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 1000, presentedFrameTs: 1000,
  }), "progress");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 10000, presentedFrameTs: 1000,
  }), "none");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 13000, presentedFrameTs: 1000,
  }), "sink");
  assert.equal(markAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 13000, presentedFrameTs: 1000,
  }, "sink"), true);
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 16000, presentedFrameTs: 0,
  }), "none");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 19000, presentedFrameTs: 0,
  }), "subscription");
  states.set("TR_screen", {
    ...states.get("TR_screen"),
    subscriptionResetAttempted: true,
    subscriptionResetAt: 19000,
    subscriptionResetKind: "presentation",
  });
  assert.equal(markAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 19000, presentedFrameTs: 0,
  }, "subscription"), true);
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 22000, presentedFrameTs: 0,
  }), "none");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 25000, presentedFrameTs: 0,
  }), "relay");

  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 26000, presentedFrameTs: 26000,
  }), "progress");
  let recovered = states.get("TR_screen");
  assert.equal(recovered.presentationSinkResetAttempted, true,
    "one intermittent frame must not rearm the SID");
  assert.equal(recovered.presentationRearmProgressTicks, 1);

  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 29000, presentedFrameTs: 26000,
  }), "none");
  recovered = states.get("TR_screen");
  assert.equal(recovered.presentationRearmProgressTicks, undefined,
    "a no-progress watchdog tick breaks the recovery streak");

  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 30000, presentedFrameTs: 30000,
  }), "progress");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 33000, presentedFrameTs: 33000,
  }), "progress");
  recovered = states.get("TR_screen");
  assert.equal(recovered.presentationSinkResetAttempted, undefined);
  assert.equal(recovered.presentationSubscriptionResetAttempted, undefined);
  assert.equal(recovered.subscriptionResetAttempted, undefined);

  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 42000, presentedFrameTs: 33000,
  }), "none");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 48000, presentedFrameTs: 33000,
  }), "sink");
});

test("six-second watchdog jitter retains the first stale observation", () => {
  const states = new Map([["TR_jitter", { lastPresentedFrameTs: 1000 }]]);
  const base = {
    enabled: true,
    current: true,
    trackSid: "TR_jitter",
    presentedFrameTs: 1000,
    recoveryStateBySid: states,
  };
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({ ...base, nowMs: 10000 }), "none");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({ ...base, nowMs: 16000 }), "sink");
});

test("a prior generic SID reset skips the duplicate presentation toggle after a later recovered episode", () => {
  const states = new Map([["TR_reused", {
    subscriptionResetAttempted: true,
    subscriptionResetAt: 2000,
    lastPresentedFrameTs: 5000,
  }]]);
  const base = {
    enabled: true,
    current: true,
    trackSid: "TR_reused",
    recoveryStateBySid: states,
  };

  // The earlier muted episode recovered for real; its generic one-shot remains
  // consumed, but normal presentation progress is recorded for the later stall.
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 8000, presentedFrameTs: 8000,
  }), "progress");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 11000, presentedFrameTs: 11000,
  }), "progress");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 20000, presentedFrameTs: 11000,
  }), "none");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 26000, presentedFrameTs: 11000,
  }), "sink");
  assert.equal(markAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 26000, presentedFrameTs: 11000,
  }, "sink"), true);
  const afterSink = states.get("TR_reused");
  assert.equal(afterSink.presentationSubscriptionResetSkipped, true);
  assert.equal(afterSink.presentationSubscriptionResetAt, 26000);
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 31999, presentedFrameTs: 0,
  }), "none");
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    ...base, nowMs: 32000, presentedFrameTs: 0,
  }), "relay", "the ladder must not request a second false-to-true toggle");
});

test("relay presentation action bypasses fresh generic frame age and missing lastFix", () => {
  assert.equal(isAndroidFirefoxPresentationRelayAction("relay"), true);
  assert.equal(isAndroidFirefoxPresentationRelayAction("subscription"), false);
  const fullscreenSource = fs.readFileSync(path.join(viewerDir, "participants-fullscreen.js"), "utf8");
  assert.match(fullscreenSource,
    /hasFrames && !isBlack && age < 4500 && !presentationRelayReady/);
  assert.match(fullscreenSource,
    /\(stalled \|\| presentationRelayReady\)[\s\S]*?\(presentationRelayReady \|\|[\s\S]*?meta\.lastFix > 0/);
});

test("presentation recovery never starts without a prior presented frame or current generation", () => {
  const states = new Map();
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    enabled: true,
    current: true,
    trackSid: "TR_none",
    nowMs: 60000,
    presentedFrameTs: 0,
    recoveryStateBySid: states,
  }), "none");
  states.set("TR_stale", { lastPresentedFrameTs: 1000, presentationStalledTicks: 1 });
  assert.equal(getAndroidFirefoxPresentationRecoveryAction({
    enabled: true,
    current: false,
    trackSid: "TR_stale",
    nowMs: 60000,
    presentedFrameTs: 1000,
    recoveryStateBySid: states,
  }), "none");
});

test("only non-native Android Firefox suppresses screen presentation interactions", () => {
  const cases = [
    ["Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0", false, true],
    ["Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0", true, false],
    ["Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Mobile", false, false],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0", false, false],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", false, false],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile", false, false],
  ];
  for (const [userAgent, native, expected] of cases) {
    assert.equal(
      shouldSuppressAndroidFirefoxScreenPresentationInteractions({ userAgent }, native),
      expected,
      userAgent
    );
  }
});

function createVisibleScreenFixture(options = {}) {
  const track = { mediaStreamTrack: { readyState: options.readyState || "live" } };
  const video = { isConnected: true, _lkTrack: track };
  const rect = options.rect || { left: 20, top: 40, right: 220, bottom: 240, width: 200, height: 200 };
  const tile = {
    isConnected: true,
    hidden: options.hidden === true,
    style: {
      display: options.display || "",
      visibility: options.visibility || "",
    },
    getClientRects: () => options.noRects ? [] : [rect],
    getBoundingClientRect: () => rect,
    querySelector: (selector) => selector === "video" ? video : null,
  };
  const publication = {
    track,
    isSubscribed: options.subscribed !== false,
  };
  const sid = "TR_screen";
  const meta = {
    identity: options.identity || "remote-user",
    publication,
    tile,
  };
  return {
    documentObject: { visibilityState: options.documentHidden ? "hidden" : "visible" },
    getComputedStyle: () => ({
      display: options.display || "block",
      visibility: options.visibility || "visible",
    }),
    hiddenIdentities: new Set(options.identityHidden ? [meta.identity] : []),
    localIdentity: "local-user",
    metaBySid: new Map([[sid, meta]]),
    tileBySid: new Map([[sid, tile]]),
  };
}

test("utility scrim consumes only Android Firefox clicks intersecting a visible remote screen", () => {
  const androidFirefoxUa =
    "Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0";
  const androidChromeUa =
    "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/153.0 Mobile Safari/537.36";
  const desktopFirefoxUa =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0";
  const windowsChromeUa =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36";

  function runCase(options) {
    let prevented = 0;
    let stopped = 0;
    let collapsed = 0;
    let intersectionScans = 0;
    let intersects = false;
    const fixture = options.fixture || createVisibleScreenFixture();
    const contained = containAndroidFirefoxUtilityScrimClick({
      event: {
        preventDefault() { prevented += 1; },
        stopPropagation() { stopped += 1; },
      },
      navigatorObject: { userAgent: options.userAgent },
      isNativeShell: options.native === true,
      isTargetBrowser: isAndroidFirefoxBrowser,
      intersectsVisibleRemoteScreen() {
        intersectionScans += 1;
        intersects = isPointInsideVisibleRemoteScreenPresentation({
          ...fixture,
          clientX: options.clientX,
          clientY: options.clientY,
        });
        return intersects;
      },
    });
    if (!contained) collapsed += 1;
    return { collapsed, contained, intersectionScans, intersects, prevented, stopped };
  }

  assert.deepEqual(runCase({
    userAgent: androidFirefoxUa, clientX: 100, clientY: 100,
  }), {
    collapsed: 0,
    contained: true,
    intersectionScans: 1,
    intersects: true,
    prevented: 1,
    stopped: 1,
  });

  const collapseCases = [
    ["outside tile", { userAgent: androidFirefoxUa, clientX: 300, clientY: 300 }],
    ["keyboard/no coordinates", { userAgent: androidFirefoxUa }],
    ["no screen", {
      userAgent: androidFirefoxUa,
      clientX: 100,
      clientY: 100,
      fixture: {
        ...createVisibleScreenFixture(),
        metaBySid: new Map(),
        tileBySid: new Map(),
      },
    }],
    ["Android Chrome", { userAgent: androidChromeUa, clientX: 100, clientY: 100 }],
    ["desktop Firefox", { userAgent: desktopFirefoxUa, clientX: 100, clientY: 100 }],
    ["Windows Chrome", { userAgent: windowsChromeUa, clientX: 100, clientY: 100 }],
    ["macOS Safari", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15",
      clientX: 100,
      clientY: 100,
    }],
    ["iOS Safari", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      clientX: 100,
      clientY: 100,
    }],
    ["native Android Firefox", {
      userAgent: androidFirefoxUa, native: true, clientX: 100, clientY: 100,
    }],
    ["local screen", {
      userAgent: androidFirefoxUa,
      clientX: 100,
      clientY: 100,
      fixture: createVisibleScreenFixture({ identity: "local-user" }),
    }],
    ["hidden remote screen", {
      userAgent: androidFirefoxUa,
      clientX: 100,
      clientY: 100,
      fixture: createVisibleScreenFixture({ identityHidden: true }),
    }],
  ];
  for (const [label, options] of collapseCases) {
    const result = runCase(options);
    assert.equal(result.collapsed, 1, label);
    assert.equal(result.contained, false, label);
    assert.equal(result.prevented, 0, label);
    assert.equal(result.stopped, 0, label);
    const isTargetBrowser = label === "outside tile" || label === "no screen" ||
      label === "keyboard/no coordinates" || label === "local screen" ||
      label === "hidden remote screen";
    assert.equal(result.intersectionScans, isTargetBrowser ? 1 : 0,
      label + " layout/intersection scans");
  }
});

test("direct target tile clicks are consumed without focus mutation while non-target clicks retain it", () => {
  const androidFirefoxUa =
    "Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0";
  const androidChromeUa =
    "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/153.0 Mobile Safari/537.36";

  function runTileClick(userAgent) {
    let prevented = 0;
    let stopped = 0;
    let focusMutations = 0;
    const event = {
      preventDefault() { prevented += 1; },
      stopPropagation() { stopped += 1; },
    };
    const shouldContain = shouldSuppressAndroidFirefoxScreenPresentationInteractions(
      { userAgent },
      false
    );
    if (!containAndroidFirefoxScreenTileClick(event, shouldContain)) focusMutations += 1;
    return { focusMutations, prevented, stopped };
  }

  assert.deepEqual(runTileClick(androidFirefoxUa), {
    focusMutations: 0, prevented: 1, stopped: 1,
  });
  assert.deepEqual(runTileClick(androidChromeUa), {
    focusMutations: 1, prevented: 0, stopped: 0,
  });
});

test("Android Firefox getStats timeout stays single-flight until the raw promise settles", async () => {
  let calls = 0;
  let release;
  const target = {
    getStats() {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { release = resolve; });
      return Promise.resolve(new Map());
    },
  };
  const flights = new WeakMap();
  const first = getAndroidFirefoxStatsSingleFlight(target, 1, flights);
  const second = getAndroidFirefoxStatsSingleFlight(target, 1, flights);
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(calls, 1);
  assert.equal(await getAndroidFirefoxStatsSingleFlight(target, 1, flights), null);
  assert.equal(calls, 1);
  release(new Map());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(await getAndroidFirefoxStatsSingleFlight(target, 20, flights) instanceof Map);
  assert.equal(calls, 2);
});

test("stopped or replaced inbound-stats polls reject stale async continuations", () => {
  const firstRoom = { sid: "RM_old" };
  const nextRoom = { sid: "RM_new" };
  const snapshot = { room: firstRoom, generation: 7 };
  assert.equal(isInboundScreenStatsPollCurrent(snapshot, firstRoom, 7, true), true);
  assert.equal(isInboundScreenStatsPollCurrent(snapshot, nextRoom, 7, true), false);
  assert.equal(isInboundScreenStatsPollCurrent(snapshot, firstRoom, 8, true), false);
  assert.equal(isInboundScreenStatsPollCurrent(snapshot, firstRoom, 7, false), false);
});

test("precommit stats start is refused, then the monitor binds the committed replacement on every platform", () => {
  const scheduledIntervals = [];
  const clearedIntervals = [];
  const monitorContext = {
    clearInterval(interval) { clearedIntervals.push(interval); },
    clearTimeout,
    console,
    fetch() { throw new Error("stats callback must not run in this binding test"); },
    navigator: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0",
    },
    room: null,
    setInterval(callback, delay) {
      const interval = { callback, delay };
      scheduledIntervals.push(interval);
      return interval;
    },
    setTimeout,
    TextEncoder,
    window: { __ECHO_NATIVE__: false },
  };
  vm.createContext(monitorContext);
  vm.runInContext(
    fs.readFileSync(path.join(viewerDir, "screen-share-state.js"), "utf8"),
    monitorContext,
    { filename: "screen-share-state.js" }
  );
  vm.runInContext(
    fs.readFileSync(path.join(viewerDir, "screen-share-adaptive.js"), "utf8"),
    monitorContext,
    { filename: "screen-share-adaptive.js" }
  );

  const replacementRoom = { sid: "RM_new" };
  assert.equal(monitorContext.startInboundScreenStatsMonitor(replacementRoom), false,
    "TrackSubscribed before Room commit must not bind a null/currently stale Room");
  assert.equal(scheduledIntervals.length, 0);

  monitorContext.room = replacementRoom;
  assert.equal(monitorContext.startInboundScreenStatsMonitor(replacementRoom), false,
    "the current Room must still be explicitly committed");
  assert.equal(scheduledIntervals.length, 0);
  replacementRoom._echoDiagnosticsCommitted = true;
  assert.equal(monitorContext.startInboundScreenStatsMonitor(replacementRoom), true);
  assert.equal(scheduledIntervals.length, 1,
    "the post-commit start must create the diagnostics monitor on Windows too");
  assert.equal(scheduledIntervals[0].delay, 3000);
  assert.equal(resolveInboundScreenStatsMonitorBinding({
    requestedRoom: replacementRoom,
    currentRoom: replacementRoom,
    boundRoom: replacementRoom,
    active: true,
  }), "keep");

  const laterRoom = { sid: "RM_later", _echoDiagnosticsCommitted: true };
  monitorContext.room = laterRoom;
  assert.equal(monitorContext.startInboundScreenStatsMonitor(laterRoom), true);
  assert.equal(clearedIntervals.length, 1,
    "committing a different Room invalidates the old monitor before rebinding");
  assert.equal(clearedIntervals[0], scheduledIntervals[0]);
  assert.equal(scheduledIntervals.length, 2);
  assert.equal(resolveInboundScreenStatsMonitorBinding({
    requestedRoom: laterRoom,
    currentRoom: laterRoom,
    boundRoom: laterRoom,
    active: true,
  }), "keep");

  // The binding policy deliberately has no browser gate: committed PC/Mac
  // rooms retain the normal diagnostics path.
  for (const label of ["Windows", "macOS", "Android Chrome", "iOS"]) {
    const roomForPlatform = { sid: label, _echoDiagnosticsCommitted: true };
    assert.equal(resolveInboundScreenStatsMonitorBinding({
      requestedRoom: roomForPlatform,
      currentRoom: roomForPlatform,
      boundRoom: null,
      active: false,
    }), "start", label);
  }

  monitorContext.stopInboundScreenStatsMonitor();
  assert.equal(clearedIntervals.length, 2);

  const connectSource = fs.readFileSync(path.join(viewerDir, "connect.js"), "utf8");
  assert.match(connectSource,
    /room = newRoom;[\s\S]*?newRoom\._echoDiagnosticsCommitted = true;[\s\S]*?startInboundScreenStatsMonitor\(newRoom\)/);
});

test("ICE diagnostics choose the transport-selected pair instead of an arbitrary succeeded pair", () => {
  const reports = new Map([
    ["local-host", { id: "local-host", type: "local-candidate", candidateType: "host" }],
    ["remote-prflx", { id: "remote-prflx", type: "remote-candidate", candidateType: "prflx" }],
    ["local-relay", { id: "local-relay", type: "local-candidate", candidateType: "relay" }],
    ["remote-relay", { id: "remote-relay", type: "remote-candidate", candidateType: "relay" }],
    ["unused", {
      id: "unused", type: "candidate-pair", state: "succeeded", nominated: false,
      localCandidateId: "local-relay", remoteCandidateId: "remote-relay",
    }],
    ["selected", {
      id: "selected", type: "candidate-pair", state: "succeeded", nominated: true,
      localCandidateId: "local-host", remoteCandidateId: "remote-prflx",
    }],
    ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "selected" }],
  ]);
  const selected = resolveSelectedIceCandidatePair(reports);
  assert.equal(selected.pair.id, "selected");
  assert.equal(selected.local.candidateType, "host");
  assert.equal(selected.remote.candidateType, "prflx");
});

test("runtime wiring keeps every automated target recovery relay-only and bounded", () => {
  const appSource = fs.readFileSync(path.join(viewerDir, "app.js"), "utf8");
  const connectSource = fs.readFileSync(path.join(viewerDir, "connect.js"), "utf8");
  const fullscreenSource = fs.readFileSync(path.join(viewerDir, "participants-fullscreen.js"), "utf8");
  const gridSource = fs.readFileSync(path.join(viewerDir, "participants-grid.js"), "utf8");
  assert.match(connectSource, /function reconnectAndroidFirefoxRoomOverRelay[\s\S]*?forceRelay: true/);
  assert.match(connectSource, /handleReconnecting\(\{[\s\S]*?reconnect: reconnectAndroidFirefoxRoomOverRelay/);
  assert.match(connectSource, /handleDisconnected\(\{[\s\S]*?reconnect: reconnectAndroidFirefoxRoomOverRelay/);
  assert.match(connectSource, /rtcConfig\.iceTransportPolicy = "relay"/);
  assert.match(connectSource, /alreadyUsingRelay: newRoom\._echoAndroidFirefoxRelayAttempted === true/);
  assert.match(fullscreenSource, /_lastPresentedFrameTs = element\._lastFrameTs/);
  assert.match(fullscreenSource, /replaceAndroidFirefoxPresentationVideoElement/);
  assert.match(gridSource,
    /containAndroidFirefoxScreenTileClick\([\s\S]*?suppressAndroidFirefoxPresentationInteractions[\s\S]*?\)\) return/);
  assert.match(appSource,
    /shellUtilityScrim\.addEventListener\("click", function\(event\)[\s\S]*?intersectsVisibleRemoteScreen: function\(\)[\s\S]*?event\.clientX[\s\S]*?event\.clientY[\s\S]*?if \(containScrimClick\) return;[\s\S]*?setClubhouseUtilityCollapsed\(true/);
  const toolsHandlerStart = appSource.indexOf('if (shellUtilityButton && shellLayout)');
  const scrimHandlerStart = appSource.indexOf('if (shellUtilityScrim)', toolsHandlerStart);
  assert.ok(toolsHandlerStart >= 0 && scrimHandlerStart > toolsHandlerStart);
  const toolsHandler = appSource.slice(toolsHandlerStart, scrimHandlerStart);
  assert.match(toolsHandler, /setClubhouseUtilityCollapsed/);
  assert.doesNotMatch(toolsHandler, /containAndroidFirefox|isPointInsideVisibleRemoteScreen/);
});
