(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  if (root.EchoThemeRuntime && root.EchoThemeRuntime.__echoThemeRuntimeApi) {
    return;
  }

  var api = factory();
  if (!api.__echoThemeRuntimeApi) {
    Object.defineProperty(api, "__echoThemeRuntimeApi", { value: true });
  }
  root.EchoThemeRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var GLOBAL_THEME_STORAGE_KEY = "echo-core-theme";
  var THEME_OVERRIDES_STORAGE_KEY = "echo-core-theme-overrides";
  var THEME_MOTION_STORAGE_KEY = "echo-core-theme-motion";
  var DEFAULT_THEME_ID = "frost";
  var DEFAULT_MOTION_LEVEL = "full";
  var REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

  function freezeCatalog(entries) {
    return Object.freeze(entries.map(function (entry) {
      return Object.freeze(entry);
    }));
  }

  var THEME_CATALOG = freezeCatalog([
    { collection: "core", id: "frost", label: "Aero" },
    { collection: "core", id: "cyberpunk", label: "Hyperpop" },
    { collection: "core", id: "aurora", label: "Aurora" },
    { collection: "core", id: "ember", label: "Afterglow" },
    { collection: "core", id: "midnight", label: "Noir" },
    { collection: "animated", id: "matrix", label: "Matrix" },
    { collection: "animated", id: "event-horizon", label: "Event Horizon" },
    { collection: "animated", id: "tempest", label: "Tempest" },
    { collection: "animated", id: "abyss", label: "Abyss" },
    { collection: "animated", id: "neon-wilds", label: "Neon Wilds" },
    { collection: "animated", id: "ultra-instinct", label: "Ultra Instinct" },
  ]);

  var MODULE_CATALOG = freezeCatalog([
    { id: "stage", label: "Stage", selector: ".room-main" },
    { id: "people", label: "People", selector: "#room-sidebar" },
    { id: "chat", label: "Chat", selector: "#chat-panel" },
    { id: "jam", label: "Jam", selector: "#jam-panel, #jam-banner, .jam-toast" },
    { id: "camera", label: "Camera Lobby", selector: "#camera-lobby" },
    {
      id: "soundboard",
      label: "Soundboard",
      selector: "#soundboard-compact, #soundboard",
    },
    { id: "settings", label: "Settings", selector: "#settings-panel" },
    { id: "capture", label: "Capture Picker", selector: "#capture-picker-overlay" },
  ]);

  var MOTION_LEVELS = freezeCatalog([
    { id: "still", label: "Still" },
    { id: "ambient", label: "Ambient" },
    { id: "full", label: "Full" },
  ]);

  var THEME_IDS = Object.freeze(THEME_CATALOG.map(function (theme) {
    return theme.id;
  }));
  var MODULE_IDS = Object.freeze(MODULE_CATALOG.map(function (moduleDefinition) {
    return moduleDefinition.id;
  }));
  var MOTION_IDS = Object.freeze(MOTION_LEVELS.map(function (motion) {
    return motion.id;
  }));
  var THEME_ID_SET = new Set(THEME_IDS);
  var MODULE_ID_SET = new Set(MODULE_IDS);
  var MOTION_ID_SET = new Set(MOTION_IDS);

  function normalizeCatalogId(value, validIds, fallback) {
    if (typeof value === "string") {
      var normalized = value.trim().toLowerCase();
      if (validIds.has(normalized)) return normalized;
    }
    if (typeof fallback === "string") {
      var normalizedFallback = fallback.trim().toLowerCase();
      if (validIds.has(normalizedFallback)) return normalizedFallback;
    }
    return null;
  }

  function normalizeThemeId(value, fallback) {
    return normalizeCatalogId(value, THEME_ID_SET, fallback);
  }

  function normalizeModuleId(value, fallback) {
    return normalizeCatalogId(value, MODULE_ID_SET, fallback);
  }

  function normalizeMotionLevel(value, fallback) {
    return normalizeCatalogId(value, MOTION_ID_SET, fallback);
  }

  function parseThemeOverrides(value) {
    var parsed = value;
    if (typeof value === "string") {
      if (!value.trim()) return {};
      try {
        parsed = JSON.parse(value);
      } catch (_error) {
        return {};
      }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    var normalized = {};
    MODULE_IDS.forEach(function (moduleId) {
      if (!Object.prototype.hasOwnProperty.call(parsed, moduleId)) return;
      var themeId = normalizeThemeId(parsed[moduleId]);
      if (themeId) normalized[moduleId] = themeId;
    });
    return normalized;
  }

  function serializeThemeOverrides(overrides) {
    var normalized = parseThemeOverrides(overrides);
    var ordered = {};
    MODULE_IDS.forEach(function (moduleId) {
      if (Object.prototype.hasOwnProperty.call(normalized, moduleId)) {
        ordered[moduleId] = normalized[moduleId];
      }
    });
    return JSON.stringify(ordered);
  }

  function resolveEffectiveMotion(requestedMotion, prefersReducedMotion) {
    var reduce = prefersReducedMotion === true ||
      !!(prefersReducedMotion && prefersReducedMotion.matches === true);
    if (reduce) return "still";
    return normalizeMotionLevel(requestedMotion, DEFAULT_MOTION_LEVEL);
  }

  function setDataAttribute(element, datasetKey, attributeName, value) {
    if (!element) return;
    if (element.dataset) {
      element.dataset[datasetKey] = String(value);
      return;
    }
    if (typeof element.setAttribute === "function") {
      element.setAttribute(attributeName, String(value));
    }
  }

  function removeDataAttribute(element, datasetKey, attributeName) {
    if (!element) return;
    if (element.dataset) {
      delete element.dataset[datasetKey];
    }
    if (typeof element.removeAttribute === "function") {
      element.removeAttribute(attributeName);
    }
  }

  function isBindableElement(value) {
    return !!value && typeof value === "object" &&
      (!!value.dataset || typeof value.setAttribute === "function");
  }

  function createThemeController(options) {
    var input = options || {};
    var documentRef = input.document;
    if (!documentRef || !documentRef.documentElement || !documentRef.body) {
      throw new Error("Echo theme runtime requires a document with html and body elements");
    }

    var rootElement = documentRef.documentElement;
    var readSetting = typeof input.readSetting === "function"
      ? input.readSetting
      : function () { return null; };
    var writeSetting = typeof input.writeSetting === "function"
      ? input.writeSetting
      : function () {};
    var syncEffects = typeof input.syncEffects === "function"
      ? input.syncEffects
      : function () {};
    var defaultView = documentRef.defaultView;
    var mediaMatcher = typeof input.matchMedia === "function"
      ? input.matchMedia
      : defaultView && typeof defaultView.matchMedia === "function"
        ? defaultView.matchMedia.bind(defaultView)
        : null;

    var globalTheme = DEFAULT_THEME_ID;
    var overrides = {};
    var requestedMotion = DEFAULT_MOTION_LEVEL;
    var reducedMotion = false;
    var destroyed = false;
    var subscribers = new Set();
    var boundRoots = new Map();
    var mediaQueryList = null;
    var removeMediaListener = null;
    var lastStateSignature = null;
    var lastEffectsSignature = null;

    function hasOverride(moduleId) {
      return Object.prototype.hasOwnProperty.call(overrides, moduleId);
    }

    function resolveTheme(moduleId) {
      if (moduleId == null) return globalTheme;
      var normalizedModule = normalizeModuleId(moduleId);
      if (!normalizedModule) return null;
      return hasOverride(normalizedModule)
        ? overrides[normalizedModule]
        : globalTheme;
    }

    function buildResolvedThemes() {
      var resolved = {};
      MODULE_IDS.forEach(function (moduleId) {
        resolved[moduleId] = resolveTheme(moduleId);
      });
      return resolved;
    }

    function getState() {
      var overrideSnapshot = Object.freeze(Object.assign({}, overrides));
      var resolvedSnapshot = Object.freeze(buildResolvedThemes());
      return Object.freeze({
        globalTheme: globalTheme,
        overrides: overrideSnapshot,
        resolvedThemes: resolvedSnapshot,
        requestedMotion: requestedMotion,
        effectiveMotion: resolveEffectiveMotion(requestedMotion, reducedMotion),
        reducedMotion: reducedMotion,
      });
    }

    function safeReadSetting(key) {
      try {
        return readSetting(key);
      } catch (_error) {
        return null;
      }
    }

    function safeWriteSetting(key, value) {
      try {
        writeSetting(key, value);
      } catch (_error) {
        // The active document still receives the requested state when browser
        // or native persistence is temporarily unavailable.
      }
    }

    function applyModuleAttributes(element, moduleId) {
      if (!isBindableElement(element)) return;
      setDataAttribute(element, "echoModule", "data-echo-module", moduleId);
      if (hasOverride(moduleId)) {
        setDataAttribute(
          element,
          "moduleTheme",
          "data-module-theme",
          overrides[moduleId]
        );
      } else {
        removeDataAttribute(element, "moduleTheme", "data-module-theme");
      }
    }

    function applyStaticModuleRoots() {
      if (typeof documentRef.querySelectorAll !== "function") return;
      MODULE_CATALOG.forEach(function (moduleDefinition) {
        var elements;
        try {
          elements = documentRef.querySelectorAll(moduleDefinition.selector);
        } catch (_error) {
          return;
        }
        if (!elements) return;
        Array.prototype.forEach.call(elements, function (element) {
          applyModuleAttributes(element, moduleDefinition.id);
        });
      });
    }

    function applyDocumentState() {
      setDataAttribute(documentRef.body, "theme", "data-theme", globalTheme);
      setDataAttribute(rootElement, "echoTheme", "data-echo-theme", globalTheme);
      setDataAttribute(
        rootElement,
        "themeMotionRequested",
        "data-theme-motion-requested",
        requestedMotion
      );
      setDataAttribute(
        rootElement,
        "themeMotionEffective",
        "data-theme-motion-effective",
        resolveEffectiveMotion(requestedMotion, reducedMotion)
      );
      applyStaticModuleRoots();
      boundRoots.forEach(function (moduleId, element) {
        applyModuleAttributes(element, moduleId);
      });
    }

    function effectsSignature(state) {
      return JSON.stringify({
        globalTheme: state.globalTheme,
        effectiveMotion: state.effectiveMotion,
      });
    }

    function stateSignature(state) {
      return JSON.stringify(state);
    }

    function publishState() {
      var state = getState();
      var nextEffectsSignature = effectsSignature(state);
      if (nextEffectsSignature !== lastEffectsSignature) {
        lastEffectsSignature = nextEffectsSignature;
        try {
          syncEffects(state);
        } catch (_error) {
          // Visual effects are optional decoration. A failed effect must not
          // leave theme state, settings, or the rest of the viewer stale.
        }
      }

      var nextStateSignature = stateSignature(state);
      if (nextStateSignature !== lastStateSignature) {
        lastStateSignature = nextStateSignature;
        subscribers.forEach(function (subscriber) {
          try {
            subscriber(state);
          } catch (_error) {
            // One consumer must not prevent other theme UI from updating.
          }
        });
      }
      return state;
    }

    function applyAndPublish() {
      applyDocumentState();
      return publishState();
    }

    function setGlobalTheme(themeId, options) {
      if (destroyed) return false;
      var normalizedTheme = normalizeThemeId(themeId);
      if (!normalizedTheme) return false;
      if (normalizedTheme === globalTheme) {
        applyDocumentState();
        return false;
      }
      globalTheme = normalizedTheme;
      if (!options || options.persist !== false) {
        safeWriteSetting(GLOBAL_THEME_STORAGE_KEY, globalTheme);
      }
      applyAndPublish();
      return true;
    }

    function clearOneModuleOverride(moduleId) {
      if (!hasOverride(moduleId)) return false;
      var nextOverrides = Object.assign({}, overrides);
      delete nextOverrides[moduleId];
      overrides = nextOverrides;
      safeWriteSetting(
        THEME_OVERRIDES_STORAGE_KEY,
        serializeThemeOverrides(overrides)
      );
      applyAndPublish();
      return true;
    }

    function setModuleTheme(moduleId, themeId) {
      if (destroyed) return false;
      var normalizedModule = normalizeModuleId(moduleId);
      if (!normalizedModule) return false;
      if (
        themeId == null ||
        (typeof themeId === "string" &&
          ["", "inherit", "global"].includes(themeId.trim().toLowerCase()))
      ) {
        return clearOneModuleOverride(normalizedModule);
      }

      var normalizedTheme = normalizeThemeId(themeId);
      if (!normalizedTheme) return false;
      if (
        hasOverride(normalizedModule) &&
        overrides[normalizedModule] === normalizedTheme
      ) {
        applyDocumentState();
        return false;
      }
      overrides = Object.assign({}, overrides, {
        [normalizedModule]: normalizedTheme,
      });
      safeWriteSetting(
        THEME_OVERRIDES_STORAGE_KEY,
        serializeThemeOverrides(overrides)
      );
      applyAndPublish();
      return true;
    }

    function clearModuleOverrides(moduleId) {
      if (destroyed) return false;
      if (moduleId != null) {
        var normalizedModule = normalizeModuleId(moduleId);
        if (!normalizedModule) return false;
        return clearOneModuleOverride(normalizedModule);
      }
      if (Object.keys(overrides).length === 0) {
        applyDocumentState();
        return false;
      }
      overrides = {};
      safeWriteSetting(THEME_OVERRIDES_STORAGE_KEY, "{}");
      applyAndPublish();
      return true;
    }

    function setMotion(motionLevel) {
      if (destroyed) return false;
      var normalizedMotion = normalizeMotionLevel(motionLevel);
      if (!normalizedMotion) return false;
      if (normalizedMotion === requestedMotion) {
        applyDocumentState();
        return false;
      }
      requestedMotion = normalizedMotion;
      safeWriteSetting(THEME_MOTION_STORAGE_KEY, requestedMotion);
      applyAndPublish();
      return true;
    }

    function reloadFromSettings() {
      if (destroyed) return getState();
      globalTheme = normalizeThemeId(
        safeReadSetting(GLOBAL_THEME_STORAGE_KEY),
        DEFAULT_THEME_ID
      );
      overrides = parseThemeOverrides(
        safeReadSetting(THEME_OVERRIDES_STORAGE_KEY)
      );
      requestedMotion = normalizeMotionLevel(
        safeReadSetting(THEME_MOTION_STORAGE_KEY),
        DEFAULT_MOTION_LEVEL
      );
      return applyAndPublish();
    }

    function bindModule(moduleOrElement, elementOrModule) {
      if (destroyed) return null;
      var moduleId = normalizeModuleId(moduleOrElement);
      var element = elementOrModule;
      if (!moduleId) {
        moduleId = normalizeModuleId(elementOrModule);
        element = moduleOrElement;
      }
      if (!moduleId || !isBindableElement(element)) return null;

      boundRoots.set(element, moduleId);
      applyModuleAttributes(element, moduleId);
      var active = true;
      return function unbindModule() {
        if (!active) return;
        active = false;
        if (boundRoots.get(element) === moduleId) {
          boundRoots.delete(element);
        }
      };
    }

    function subscribe(listener) {
      if (destroyed || typeof listener !== "function") {
        return function () {};
      }
      subscribers.add(listener);
      var active = true;
      return function unsubscribe() {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    }

    function handleReducedMotionChange(event) {
      if (destroyed) return;
      var nextReducedMotion = event && typeof event.matches === "boolean"
        ? event.matches
        : !!(mediaQueryList && mediaQueryList.matches);
      if (nextReducedMotion === reducedMotion) {
        applyDocumentState();
        return;
      }
      reducedMotion = nextReducedMotion;
      applyAndPublish();
    }

    function attachReducedMotionListener() {
      if (!mediaMatcher) return;
      try {
        mediaQueryList = mediaMatcher(REDUCED_MOTION_QUERY);
      } catch (_error) {
        mediaQueryList = null;
      }
      if (!mediaQueryList) return;
      reducedMotion = mediaQueryList.matches === true;
      if (typeof mediaQueryList.addEventListener === "function") {
        mediaQueryList.addEventListener("change", handleReducedMotionChange);
        removeMediaListener = function () {
          mediaQueryList.removeEventListener("change", handleReducedMotionChange);
        };
      } else if (typeof mediaQueryList.addListener === "function") {
        mediaQueryList.addListener(handleReducedMotionChange);
        removeMediaListener = function () {
          mediaQueryList.removeListener(handleReducedMotionChange);
        };
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (removeMediaListener) {
        try {
          removeMediaListener();
        } catch (_error) {}
      }
      removeMediaListener = null;
      mediaQueryList = null;
      subscribers.clear();
      boundRoots.clear();
      try {
        syncEffects(null);
      } catch (_error) {}
    }

    attachReducedMotionListener();
    reloadFromSettings();

    return Object.freeze({
      getCatalog: function () { return THEME_CATALOG; },
      getModules: function () { return MODULE_CATALOG; },
      getMotionLevels: function () { return MOTION_LEVELS; },
      getState: getState,
      resolveTheme: resolveTheme,
      setGlobalTheme: setGlobalTheme,
      setModuleTheme: setModuleTheme,
      clearModuleOverrides: clearModuleOverrides,
      setMotion: setMotion,
      reloadFromSettings: reloadFromSettings,
      bindModule: bindModule,
      subscribe: subscribe,
      isDestroyed: function () { return destroyed; },
      destroy: destroy,
    });
  }

  var exportedApi = {
    GLOBAL_THEME_STORAGE_KEY: GLOBAL_THEME_STORAGE_KEY,
    THEME_STORAGE_KEY: GLOBAL_THEME_STORAGE_KEY,
    THEME_OVERRIDES_STORAGE_KEY: THEME_OVERRIDES_STORAGE_KEY,
    OVERRIDES_STORAGE_KEY: THEME_OVERRIDES_STORAGE_KEY,
    THEME_MOTION_STORAGE_KEY: THEME_MOTION_STORAGE_KEY,
    MOTION_STORAGE_KEY: THEME_MOTION_STORAGE_KEY,
    DEFAULT_THEME_ID: DEFAULT_THEME_ID,
    DEFAULT_MOTION_LEVEL: DEFAULT_MOTION_LEVEL,
    REDUCED_MOTION_QUERY: REDUCED_MOTION_QUERY,
    THEME_CATALOG: THEME_CATALOG,
    MODULE_CATALOG: MODULE_CATALOG,
    MOTION_LEVELS: MOTION_LEVELS,
    THEME_IDS: THEME_IDS,
    MODULE_IDS: MODULE_IDS,
    MOTION_IDS: MOTION_IDS,
    normalizeThemeId: normalizeThemeId,
    normalizeModuleId: normalizeModuleId,
    normalizeMotionLevel: normalizeMotionLevel,
    parseThemeOverrides: parseThemeOverrides,
    serializeThemeOverrides: serializeThemeOverrides,
    resolveEffectiveMotion: resolveEffectiveMotion,
    createThemeController: createThemeController,
  };
  Object.defineProperty(exportedApi, "__echoThemeRuntimeApi", { value: true });
  return Object.freeze(exportedApi);
});
