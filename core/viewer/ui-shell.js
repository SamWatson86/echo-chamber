(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  if (root.EchoUiShell && root.EchoUiShell.__echoUiShellApi) {
    return;
  }

  const api = factory();
  Object.defineProperty(api, "__echoUiShellApi", { value: true });
  root.EchoUiShell = api;
  if (root.document) {
    api.install({
      window: root,
      document: root.document,
      policy: root.EchoLayoutPolicy,
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FLAG_NAME = "echo-ui-shell-v2";
  const LEGACY_VARIANT = "legacy";
  const V2_VARIANT = "v2";
  let installedController = null;

  function parseFlagValue(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (value == null) return null;

    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "on", "yes", "enabled", V2_VARIANT].includes(normalized)) {
      return true;
    }
    if (["0", "false", "off", "no", "disabled", LEGACY_VARIANT].includes(normalized)) {
      return false;
    }
    return null;
  }

  function readQueryOverride(search) {
    try {
      const params = new URLSearchParams(String(search || ""));
      return parseFlagValue(params.get(FLAG_NAME));
    } catch (_error) {
      return null;
    }
  }

  function resolveShellVariant(options) {
    const input = options || {};
    const queryOverride = readQueryOverride(input.search);
    if (queryOverride != null) return queryOverride ? V2_VARIANT : LEGACY_VARIANT;

    const storedOverride = parseFlagValue(input.storedValue);
    if (storedOverride != null) return storedOverride ? V2_VARIANT : LEGACY_VARIANT;
    return LEGACY_VARIANT;
  }

  function normalizeVariant(value) {
    if (value === V2_VARIANT || parseFlagValue(value) === true) return V2_VARIANT;
    return LEGACY_VARIANT;
  }

  function safeReadStorage(storage) {
    try {
      return storage && typeof storage.getItem === "function"
        ? storage.getItem(FLAG_NAME)
        : null;
    } catch (_error) {
      return null;
    }
  }

  function safeWriteStorage(storage, variant) {
    try {
      if (storage && typeof storage.setItem === "function") {
        storage.setItem(FLAG_NAME, variant === V2_VARIANT ? "1" : "0");
      }
    } catch (_error) {
      // Storage can be unavailable in privacy-restricted webviews. The active
      // document still receives the requested presentation variant.
    }
  }

  function createShellController(options) {
    const input = options || {};
    const win = input.window;
    const doc = input.document;
    const policy = input.policy;
    const rootElement = doc && doc.documentElement;
    let previousMode = null;
    let scheduledFrame = null;
    let started = false;
    let lastNotification = null;

    if (!win || !doc || !rootElement) {
      throw new Error("Echo UI shell requires a window and document");
    }

    const requestFrame = typeof win.requestAnimationFrame === "function"
      ? win.requestAnimationFrame.bind(win)
      : function (callback) { return win.setTimeout(callback, 0); };
    const cancelFrame = typeof win.cancelAnimationFrame === "function"
      ? win.cancelAnimationFrame.bind(win)
      : function (handle) { win.clearTimeout(handle); };

    function clearResponsiveAttributes() {
      delete rootElement.dataset.uiMode;
      rootElement.removeAttribute("data-ui-short");
      rootElement.removeAttribute("data-ui-very-short");
    }

    function readViewport() {
      return {
        width: Number(rootElement.clientWidth) || Number(win.innerWidth) || 0,
        height: Number(rootElement.clientHeight) || Number(win.innerHeight) || 0,
      };
    }

    function notifyPresentationChange(resolved) {
      const detail = {
        variant: rootElement.dataset.uiShell || LEGACY_VARIANT,
        mode: resolved ? resolved.mode : null,
        isShort: !!(resolved && resolved.isShort),
        isVeryShort: !!(resolved && resolved.isVeryShort),
      };
      const signature = JSON.stringify(detail);
      if (signature === lastNotification) return;
      lastNotification = signature;
      if (typeof win.dispatchEvent === "function" && typeof win.CustomEvent === "function") {
        win.dispatchEvent(new win.CustomEvent("echo:ui-shell-change", { detail }));
      }
    }

    function measureNow() {
      if (rootElement.dataset.uiShell !== V2_VARIANT) {
        previousMode = null;
        clearResponsiveAttributes();
        notifyPresentationChange(null);
        return null;
      }

      if (!policy || typeof policy.resolveLayoutPolicy !== "function") {
        rootElement.dataset.uiShell = LEGACY_VARIANT;
        previousMode = null;
        clearResponsiveAttributes();
        notifyPresentationChange(null);
        return null;
      }

      const viewport = readViewport();
      const resolved = policy.resolveLayoutPolicy({
        width: viewport.width,
        height: viewport.height,
        previousMode,
      });
      previousMode = resolved.mode;
      rootElement.dataset.uiMode = resolved.mode;
      rootElement.toggleAttribute("data-ui-short", !!resolved.isShort);
      rootElement.toggleAttribute("data-ui-very-short", !!resolved.isVeryShort);
      notifyPresentationChange(resolved);
      return resolved;
    }

    function scheduleMeasure() {
      if (scheduledFrame != null) return;
      scheduledFrame = requestFrame(function () {
        scheduledFrame = null;
        measureNow();
      });
    }

    function applyVariant(value, applyOptions) {
      const requested = normalizeVariant(value);
      const nextVariant = requested === V2_VARIANT &&
        policy && typeof policy.resolveLayoutPolicy === "function"
        ? V2_VARIANT
        : LEGACY_VARIANT;
      const priorVariant = rootElement.dataset.uiShell;
      rootElement.dataset.uiShell = nextVariant;
      if (priorVariant !== nextVariant) previousMode = null;
      if (applyOptions && applyOptions.persist) {
        safeWriteStorage(win.localStorage, nextVariant);
      }
      return measureNow();
    }

    function start(initialVariant) {
      if (started) return measureNow();
      started = true;
      win.addEventListener("resize", scheduleMeasure, { passive: true });
      return applyVariant(initialVariant);
    }

    function stop() {
      if (!started) return;
      started = false;
      win.removeEventListener("resize", scheduleMeasure);
      if (scheduledFrame != null) {
        cancelFrame(scheduledFrame);
        scheduledFrame = null;
      }
    }

    return Object.freeze({
      applyVariant,
      measureNow,
      scheduleMeasure,
      start,
      stop,
    });
  }

  function install(options) {
    if (installedController) return installedController;
    const input = options || {};
    const win = input.window;
    const doc = input.document;
    if (!win || !doc) return null;

    const variant = resolveShellVariant({
      search: win.location && win.location.search,
      storedValue: safeReadStorage(win.localStorage),
    });
    installedController = createShellController({
      window: win,
      document: doc,
      policy: input.policy,
    });
    installedController.start(variant);
    return installedController;
  }

  function applyVariant(value, options) {
    return installedController ? installedController.applyVariant(value, options) : null;
  }

  return {
    FLAG_NAME,
    LEGACY_VARIANT,
    V2_VARIANT,
    applyVariant,
    createShellController,
    install,
    normalizeVariant,
    parseFlagValue,
    readQueryOverride,
    resolveShellVariant,
  };
});
