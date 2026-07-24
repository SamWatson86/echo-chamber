const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  DEFAULT_MOTION_LEVEL,
  DEFAULT_THEME_ID,
  GLOBAL_THEME_STORAGE_KEY,
  MODULE_CATALOG,
  MODULE_IDS,
  MOTION_IDS,
  REDUCED_MOTION_QUERY,
  THEME_CATALOG,
  THEME_IDS,
  THEME_MOTION_STORAGE_KEY,
  THEME_OVERRIDES_STORAGE_KEY,
  createThemeController,
  normalizeModuleId,
  normalizeMotionLevel,
  normalizeThemeId,
  parseThemeOverrides,
  resolveEffectiveMotion,
  serializeThemeOverrides,
} = require("./theme-runtime.js");

function createElement(name) {
  const attributes = new Map();
  return {
    attributes,
    dataset: {},
    name,
    removeAttribute(attributeName) {
      attributes.delete(attributeName);
    },
    setAttribute(attributeName, value) {
      attributes.set(attributeName, String(value));
    },
  };
}

function createMediaQueryList(initialMatches = false) {
  const modernListeners = new Set();
  const legacyListeners = new Set();
  return {
    matches: initialMatches,
    media: REDUCED_MOTION_QUERY,
    addEventListener(type, listener) {
      if (type === "change") modernListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "change") modernListeners.delete(listener);
    },
    addListener(listener) {
      legacyListeners.add(listener);
    },
    removeListener(listener) {
      legacyListeners.delete(listener);
    },
    emit(matches) {
      this.matches = matches;
      const event = { matches, media: this.media };
      modernListeners.forEach((listener) => listener(event));
      legacyListeners.forEach((listener) => listener(event));
    },
    listenerCount() {
      return modernListeners.size + legacyListeners.size;
    },
  };
}

function createHarness(options = {}) {
  const rootElement = createElement("html");
  const body = createElement("body");
  const roots = {};
  const selectorResults = new Map();
  for (const moduleDefinition of MODULE_CATALOG) {
    const count = moduleDefinition.id === "soundboard" ? 2 : 1;
    roots[moduleDefinition.id] = Array.from({ length: count }, (_, index) =>
      createElement(`${moduleDefinition.id}-${index}`)
    );
    selectorResults.set(moduleDefinition.selector, roots[moduleDefinition.id]);
  }
  for (const moduleId of options.omitModules || []) {
    const definition = MODULE_CATALOG.find((entry) => entry.id === moduleId);
    selectorResults.set(definition.selector, []);
  }

  const document = {
    body,
    documentElement: rootElement,
    querySelectorAll(selector) {
      return selectorResults.get(selector) || [];
    },
  };
  const settings = new Map(Object.entries(options.settings || {}));
  const writes = [];
  const effectStates = [];
  const mediaQueryList = options.mediaQueryList ||
    createMediaQueryList(options.reducedMotion === true);
  const controller = createThemeController({
    document,
    matchMedia(query) {
      assert.equal(query, REDUCED_MOTION_QUERY);
      return mediaQueryList;
    },
    readSetting(key) {
      return settings.has(key) ? settings.get(key) : null;
    },
    writeSetting(key, value) {
      writes.push([key, value]);
      settings.set(key, value);
    },
    syncEffects(state) {
      effectStates.push(state);
    },
  });

  return {
    body,
    controller,
    document,
    effectStates,
    mediaQueryList,
    rootElement,
    roots,
    settings,
    writes,
  };
}

test("catalogs retain legacy IDs and divide Core Looks from Animated Worlds", () => {
  assert.deepEqual(THEME_IDS, [
    "frost",
    "cyberpunk",
    "aurora",
    "ember",
    "midnight",
    "matrix",
    "event-horizon",
    "tempest",
    "abyss",
    "neon-wilds",
    "ultra-instinct",
  ]);
  assert.deepEqual(
    THEME_CATALOG.map(({ collection, id, label }) => [collection, id, label]),
    [
      ["core", "frost", "Aero"],
      ["core", "cyberpunk", "Hyperpop"],
      ["core", "aurora", "Aurora"],
      ["core", "ember", "Afterglow"],
      ["core", "midnight", "Noir"],
      ["animated", "matrix", "Matrix"],
      ["animated", "event-horizon", "Event Horizon"],
      ["animated", "tempest", "Tempest"],
      ["animated", "abyss", "Abyss"],
      ["animated", "neon-wilds", "Neon Wilds"],
      ["animated", "ultra-instinct", "Ultra Instinct"],
    ]
  );
  assert.deepEqual(MODULE_IDS, [
    "stage",
    "people",
    "chat",
    "jam",
    "camera",
    "soundboard",
    "settings",
    "capture",
  ]);
  assert.equal(
    MODULE_CATALOG.find(({ id }) => id === "stage").selector,
    ".room-main"
  );
  assert.equal(
    MODULE_CATALOG.find(({ id }) => id === "soundboard").selector,
    "#soundboard-compact, #soundboard"
  );
  assert.equal(
    MODULE_CATALOG.find(({ id }) => id === "jam").selector,
    "#jam-panel, #jam-banner, .jam-toast"
  );
  assert.deepEqual(MOTION_IDS, ["still", "ambient", "full"]);
  assert.equal(DEFAULT_THEME_ID, "frost");
  assert.equal(DEFAULT_MOTION_LEVEL, "full");
  assert.ok(Object.isFrozen(THEME_CATALOG));
  assert.ok(Object.isFrozen(THEME_CATALOG[0]));
});

test("pure normalization and override parsing reject malformed settings safely", () => {
  assert.equal(normalizeThemeId(" ULTRA-INSTINCT "), "ultra-instinct");
  assert.equal(normalizeThemeId(" EVENT-HORIZON "), "event-horizon");
  assert.equal(normalizeThemeId("NEON-WILDS"), "neon-wilds");
  assert.equal(normalizeThemeId("unknown"), null);
  assert.equal(normalizeThemeId("unknown", "frost"), "frost");
  assert.equal(normalizeModuleId(" Camera "), "camera");
  assert.equal(normalizeModuleId("lobby"), null);
  assert.equal(normalizeMotionLevel(" AMBIENT "), "ambient");
  assert.equal(normalizeMotionLevel("maximum"), null);

  assert.deepEqual(parseThemeOverrides(null), {});
  assert.deepEqual(parseThemeOverrides(""), {});
  assert.deepEqual(parseThemeOverrides("{not-json"), {});
  assert.deepEqual(parseThemeOverrides("[]"), {});
  assert.deepEqual(
    parseThemeOverrides(
      JSON.stringify({
        chat: " AURORA ",
        jam: "not-a-theme",
        stage: null,
        bogus: "matrix",
      })
    ),
    { chat: "aurora" }
  );
  assert.deepEqual(
    parseThemeOverrides({ capture: "matrix", settings: "MIDNIGHT" }),
    { settings: "midnight", capture: "matrix" }
  );
  assert.equal(
    serializeThemeOverrides({ capture: "matrix", chat: "aurora", nope: "frost" }),
    '{"chat":"aurora","capture":"matrix"}'
  );
  assert.equal(resolveEffectiveMotion("ambient", false), "ambient");
  assert.equal(resolveEffectiveMotion("full", { matches: true }), "still");
  assert.equal(resolveEffectiveMotion("invalid", false), "full");
});

test("global inheritance, isolated overrides, and clearing update every module root", () => {
  const harness = createHarness({
    settings: {
      [GLOBAL_THEME_STORAGE_KEY]: "cyberpunk",
      [THEME_OVERRIDES_STORAGE_KEY]: JSON.stringify({ chat: "aurora" }),
      [THEME_MOTION_STORAGE_KEY]: "ambient",
    },
  });
  const { controller, roots, writes, body, rootElement } = harness;

  assert.equal(body.dataset.theme, "cyberpunk");
  assert.equal(rootElement.dataset.echoTheme, "cyberpunk");
  assert.equal(rootElement.dataset.themeMotionRequested, "ambient");
  assert.equal(rootElement.dataset.themeMotionEffective, "ambient");
  assert.equal(controller.resolveTheme("stage"), "cyberpunk");
  assert.equal(controller.resolveTheme("chat"), "aurora");
  assert.equal(roots.stage[0].dataset.echoModule, "stage");
  assert.equal(roots.stage[0].dataset.moduleTheme, undefined);
  assert.equal(roots.chat[0].dataset.echoModule, "chat");
  assert.equal(roots.chat[0].dataset.moduleTheme, "aurora");
  assert.equal(roots.soundboard[0].dataset.echoModule, "soundboard");
  assert.equal(roots.soundboard[1].dataset.echoModule, "soundboard");

  assert.equal(controller.setGlobalTheme("ember"), true);
  assert.equal(body.dataset.theme, "ember");
  assert.equal(rootElement.dataset.echoTheme, "ember");
  assert.equal(controller.resolveTheme("stage"), "ember");
  assert.equal(controller.resolveTheme("chat"), "aurora");
  assert.equal(roots.stage[0].dataset.moduleTheme, undefined);
  assert.deepEqual(writes.at(-1), [GLOBAL_THEME_STORAGE_KEY, "ember"]);

  assert.equal(controller.setModuleTheme("jam", "matrix"), true);
  assert.equal(controller.resolveTheme("jam"), "matrix");
  assert.equal(roots.jam[0].dataset.moduleTheme, "matrix");
  assert.equal(roots.chat[0].dataset.moduleTheme, "aurora");
  assert.deepEqual(
    JSON.parse(writes.at(-1)[1]),
    { chat: "aurora", jam: "matrix" }
  );

  assert.equal(controller.clearModuleOverrides("chat"), true);
  assert.equal(controller.resolveTheme("chat"), "ember");
  assert.equal(roots.chat[0].dataset.echoModule, "chat");
  assert.equal(roots.chat[0].dataset.moduleTheme, undefined);
  assert.equal(roots.jam[0].dataset.moduleTheme, "matrix");

  assert.equal(controller.clearModuleOverrides(), true);
  assert.deepEqual(controller.getState().overrides, {});
  for (const moduleRoots of Object.values(roots)) {
    for (const root of moduleRoots) {
      assert.notEqual(root.dataset.echoModule, undefined);
      assert.equal(root.dataset.moduleTheme, undefined);
    }
  }
  assert.deepEqual(writes.at(-1), [THEME_OVERRIDES_STORAGE_KEY, "{}"]);

  const writeCount = writes.length;
  assert.equal(
    controller.setGlobalTheme("midnight", { persist: false }),
    true
  );
  assert.equal(body.dataset.theme, "midnight");
  assert.equal(writes.length, writeCount);
});

test("initialization and reload apply validated settings without writing them", () => {
  const harness = createHarness({
    settings: {
      [GLOBAL_THEME_STORAGE_KEY]: "midnight",
      [THEME_OVERRIDES_STORAGE_KEY]: "{malformed",
      [THEME_MOTION_STORAGE_KEY]: "still",
    },
  });
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.controller.getState().globalTheme, "midnight");
  assert.deepEqual(harness.controller.getState().overrides, {});
  assert.equal(harness.controller.getState().requestedMotion, "still");

  harness.settings.set(GLOBAL_THEME_STORAGE_KEY, "aurora");
  harness.settings.set(
    THEME_OVERRIDES_STORAGE_KEY,
    JSON.stringify({ camera: "ultra-instinct", other: "matrix" })
  );
  harness.settings.set(THEME_MOTION_STORAGE_KEY, "full");
  harness.controller.reloadFromSettings();

  assert.equal(harness.writes.length, 0);
  assert.equal(harness.body.dataset.theme, "aurora");
  assert.equal(harness.rootElement.dataset.echoTheme, "aurora");
  assert.equal(harness.roots.camera[0].dataset.moduleTheme, "ultra-instinct");
  assert.deepEqual(harness.controller.getState().overrides, {
    camera: "ultra-instinct",
  });
  const effectCount = harness.effectStates.length;
  harness.controller.reloadFromSettings();
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.effectStates.length, effectCount);
});

test("OS reduced motion forces still without overwriting the requested level", () => {
  const harness = createHarness({
    reducedMotion: true,
    settings: {
      [GLOBAL_THEME_STORAGE_KEY]: "ultra-instinct",
      [THEME_MOTION_STORAGE_KEY]: "full",
    },
  });
  const { controller, effectStates, mediaQueryList, rootElement, writes } = harness;

  assert.equal(controller.getState().requestedMotion, "full");
  assert.equal(controller.getState().effectiveMotion, "still");
  assert.equal(rootElement.dataset.themeMotionRequested, "full");
  assert.equal(rootElement.dataset.themeMotionEffective, "still");
  assert.equal(effectStates.length, 1);

  assert.equal(controller.setMotion("ambient"), true);
  assert.deepEqual(writes.at(-1), [THEME_MOTION_STORAGE_KEY, "ambient"]);
  assert.equal(controller.getState().requestedMotion, "ambient");
  assert.equal(controller.getState().effectiveMotion, "still");
  assert.equal(rootElement.dataset.themeMotionRequested, "ambient");
  assert.equal(rootElement.dataset.themeMotionEffective, "still");
  assert.equal(effectStates.length, 1);

  mediaQueryList.emit(false);
  assert.equal(controller.getState().requestedMotion, "ambient");
  assert.equal(controller.getState().effectiveMotion, "ambient");
  assert.equal(rootElement.dataset.themeMotionEffective, "ambient");
  assert.equal(effectStates.length, 2);
  assert.deepEqual(writes, [[THEME_MOTION_STORAGE_KEY, "ambient"]]);

  const effectCountBeforeDestroy = effectStates.length;
  controller.destroy();
  assert.equal(mediaQueryList.listenerCount(), 0);
  assert.equal(controller.isDestroyed(), true);
  assert.equal(effectStates.length, effectCountBeforeDestroy + 1);
  assert.equal(effectStates.at(-1), null);
  mediaQueryList.emit(true);
  assert.equal(controller.getState().effectiveMotion, "ambient");
});

test("dynamic roots can bind in either argument order and retain explicit-only attributes", () => {
  const harness = createHarness({
    omitModules: ["capture"],
    settings: {
      [GLOBAL_THEME_STORAGE_KEY]: "frost",
      [THEME_OVERRIDES_STORAGE_KEY]: JSON.stringify({ capture: "matrix" }),
    },
  });
  const dynamicCapture = createElement("dynamic-capture");
  const dynamicChat = createElement("dynamic-chat");

  const unbindCapture = harness.controller.bindModule("capture", dynamicCapture);
  assert.equal(typeof unbindCapture, "function");
  assert.equal(dynamicCapture.dataset.echoModule, "capture");
  assert.equal(dynamicCapture.dataset.moduleTheme, "matrix");

  const unbindChat = harness.controller.bindModule(dynamicChat, "chat");
  assert.equal(typeof unbindChat, "function");
  assert.equal(dynamicChat.dataset.echoModule, "chat");
  assert.equal(dynamicChat.dataset.moduleTheme, undefined);

  harness.controller.setModuleTheme("chat", "aurora");
  assert.equal(dynamicChat.dataset.moduleTheme, "aurora");
  harness.controller.setModuleTheme("capture", "inherit");
  assert.equal(dynamicCapture.dataset.echoModule, "capture");
  assert.equal(dynamicCapture.dataset.moduleTheme, undefined);

  unbindChat();
  unbindChat();
  harness.controller.setModuleTheme("chat", "matrix");
  assert.equal(dynamicChat.dataset.moduleTheme, "aurora");
  unbindCapture();
});

test("invalid controller input is rejected without writes, effects, or state changes", () => {
  const harness = createHarness();
  const initialState = harness.controller.getState();
  const initialEffects = harness.effectStates.length;
  const invalidElement = createElement("invalid");

  assert.equal(harness.controller.setGlobalTheme("brand-new"), false);
  assert.equal(harness.controller.setGlobalTheme(null), false);
  assert.equal(harness.controller.setModuleTheme("unknown-module", "aurora"), false);
  assert.equal(harness.controller.setModuleTheme("chat", "brand-new"), false);
  assert.equal(harness.controller.clearModuleOverrides("unknown-module"), false);
  assert.equal(harness.controller.setMotion("cinematic"), false);
  assert.equal(harness.controller.bindModule("unknown-module", invalidElement), null);
  assert.equal(harness.controller.bindModule("chat", null), null);
  assert.equal(invalidElement.dataset.echoModule, undefined);
  assert.deepEqual(harness.controller.getState(), initialState);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.effectStates.length, initialEffects);
});

test("subscriptions and special-effect synchronization are idempotent", () => {
  const harness = createHarness();
  const states = [];
  const unsubscribe = harness.controller.subscribe((state) => {
    states.push(state);
  });

  assert.equal(states.length, 0);
  assert.equal(harness.effectStates.length, 1);
  assert.ok(Object.isFrozen(harness.effectStates[0]));

  // An explicit override is observable UI state, even when it resolves to the
  // same theme as the global setting. Effects do not need to restart.
  assert.equal(harness.controller.setModuleTheme("chat", "frost"), true);
  assert.equal(states.length, 1);
  assert.equal(harness.effectStates.length, 1);
  assert.equal(harness.controller.setModuleTheme("chat", "frost"), false);
  assert.equal(states.length, 1);
  assert.equal(harness.effectStates.length, 1);

  assert.equal(harness.controller.clearModuleOverrides("chat"), true);
  assert.equal(states.length, 2);
  assert.equal(harness.effectStates.length, 1);
  assert.equal(harness.controller.clearModuleOverrides(), false);
  assert.equal(states.length, 2);

  assert.equal(harness.controller.setGlobalTheme("aurora"), true);
  assert.equal(states.length, 3);
  assert.equal(harness.effectStates.length, 2);
  assert.equal(harness.controller.setGlobalTheme(" AURORA "), false);
  assert.equal(states.length, 3);
  assert.equal(harness.effectStates.length, 2);

  assert.equal(harness.controller.setMotion("ambient"), true);
  assert.equal(states.length, 4);
  assert.equal(harness.effectStates.length, 3);
  unsubscribe();
  unsubscribe();
  harness.controller.setGlobalTheme("ember");
  assert.equal(states.length, 4);
  assert.equal(harness.effectStates.length, 4);
});

test("module overrides never resynchronize the page-wide effect renderer", () => {
  const harness = createHarness();
  harness.controller.setGlobalTheme("matrix");
  const effectCount = harness.effectStates.length;
  const animatedThemes = [
    "event-horizon",
    "tempest",
    "abyss",
    "neon-wilds",
    "ultra-instinct",
  ];

  MODULE_IDS.forEach((moduleId, index) => {
    assert.equal(
      harness.controller.setModuleTheme(
        moduleId,
        animatedThemes[index % animatedThemes.length],
      ),
      true,
    );
    assert.equal(harness.effectStates.length, effectCount);
  });
  assert.equal(harness.controller.clearModuleOverrides(), true);
  assert.equal(harness.effectStates.length, effectCount);

  assert.equal(harness.controller.setGlobalTheme("event-horizon"), true);
  assert.equal(harness.effectStates.length, effectCount + 1);
});

test("the UMD build exposes one stable browser-global namespace", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "theme-runtime.js"),
    "utf8"
  );
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "theme-runtime.js" });
  const firstApi = sandbox.EchoThemeRuntime;
  assert.ok(firstApi);
  assert.deepEqual(Array.from(firstApi.THEME_IDS), Array.from(THEME_IDS));
  assert.equal(firstApi.__echoThemeRuntimeApi, true);

  vm.runInContext(source, sandbox, { filename: "theme-runtime.js" });
  assert.equal(sandbox.EchoThemeRuntime, firstApi);
});
