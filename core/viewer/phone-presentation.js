(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  if (root.EchoPhonePresentation && root.EchoPhonePresentation.__echoPhonePresentationApi) {
    return;
  }

  var api = factory();
  Object.defineProperty(api, "__echoPhonePresentationApi", { value: true });
  root.EchoPhonePresentation = api;

  if (!root.document) return;

  var environment = {
    navigator: root.navigator,
    isNativeShell: root.__ECHO_NATIVE__ === true,
  };
  if (api.isPhoneBrowser(environment)) {
    root.document.documentElement.dataset.echoPhone = "true";
  }

  function installPhonePresentation() {
    environment.isNativeShell = root.__ECHO_NATIVE__ === true;
    if (!api.isPhoneBrowser(environment)) {
      delete root.document.documentElement.dataset.echoPhone;
      return;
    }
    api.install({ window: root, document: root.document });
  }

  if (root.document.readyState === "loading") {
    root.document.addEventListener("DOMContentLoaded", installPhonePresentation, { once: true });
  } else {
    installPhonePresentation();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var PHONE_SHEET_STORAGE_KEY = "echo-phone-sheet-snap";
  var PHONE_SHEET_SNAPS = Object.freeze(["peek", "half", "full"]);
  var PHONE_SHEET_PEEK_PX = 72;
  var PHONE_SHEET_HALF_RATIO = 0.34;
  var PHONE_STAGE_MIN_PX = 96;
  var installedController = null;

  function isPhoneBrowser(options) {
    var input = options || {};
    if (input.isNativeShell === true) return false;
    var navigatorObject = input.navigator || {};
    if (navigatorObject.userAgentData &&
        typeof navigatorObject.userAgentData.mobile === "boolean") {
      return navigatorObject.userAgentData.mobile;
    }
    var userAgent = String(navigatorObject.userAgent || input.userAgent || "");
    if (/\b(?:iPhone|iPod)\b/i.test(userAgent)) return true;
    if (/\bWindows Phone\b/i.test(userAgent)) return true;
    return /\bAndroid\b/i.test(userAgent) && /\bMobile\b/i.test(userAgent);
  }

  function normalizeSnap(value) {
    return PHONE_SHEET_SNAPS.includes(value) ? value : "half";
  }

  function resolveSheetHeights(workspaceHeight) {
    var height = Math.max(0, Math.round(Number(workspaceHeight) || 0));
    var full = Math.max(0, height - PHONE_STAGE_MIN_PX);
    var peek = Math.min(PHONE_SHEET_PEEK_PX, full);
    var half = Math.round(height * PHONE_SHEET_HALF_RATIO);
    half = Math.max(peek, Math.min(full, half));
    return Object.freeze({ peek: peek, half: half, full: full });
  }

  function nearestSnap(height, heights) {
    var target = Number(height) || 0;
    var resolved = heights || resolveSheetHeights(0);
    return PHONE_SHEET_SNAPS.reduce(function (best, snap) {
      return Math.abs(target - resolved[snap]) < Math.abs(target - resolved[best])
        ? snap
        : best;
    }, "peek");
  }

  function adjacentSnap(snap, direction) {
    var index = PHONE_SHEET_SNAPS.indexOf(normalizeSnap(snap));
    var nextIndex = Math.max(0, Math.min(PHONE_SHEET_SNAPS.length - 1, index + direction));
    return PHONE_SHEET_SNAPS[nextIndex];
  }

  function safeReadSnap(storage) {
    try {
      return normalizeSnap(storage && storage.getItem(PHONE_SHEET_STORAGE_KEY));
    } catch (_error) {
      return "half";
    }
  }

  function safeWriteSnap(storage, snap) {
    try {
      if (storage && typeof storage.setItem === "function") {
        storage.setItem(PHONE_SHEET_STORAGE_KEY, normalizeSnap(snap));
      }
    } catch (_error) {
      // Session storage can be blocked in privacy-restricted browsers.
    }
  }

  function isPortraitViewport(win) {
    try {
      if (typeof win.matchMedia === "function") {
        return win.matchMedia("(orientation: portrait)").matches;
      }
    } catch (_error) {}
    return (Number(win.innerHeight) || 0) >= (Number(win.innerWidth) || 0);
  }

  function viewportSignature(win) {
    var viewport = win.visualViewport;
    if (!viewport) {
      return [Number(win.innerWidth) || 0, Number(win.innerHeight) || 0, 0, 0, 1].join(":");
    }
    return [
      Number(viewport.width) || 0,
      Number(viewport.height) || 0,
      Number(viewport.offsetLeft) || 0,
      Number(viewport.offsetTop) || 0,
      Number(viewport.scale) || 1,
    ].join(":");
  }

  function createFullscreenExitStabilizer(options) {
    var input = options || {};
    var win = input.window;
    var doc = input.document;
    var requestFrame = input.requestFrame || (typeof win.requestAnimationFrame === "function"
      ? win.requestAnimationFrame.bind(win)
      : function (callback) { return win.setTimeout(callback, 16); });
    var setTimer = input.setTimer || win.setTimeout.bind(win);
    var clearTimer = input.clearTimer || win.clearTimeout.bind(win);
    var now = input.now || function () {
      return win.performance && typeof win.performance.now === "function"
        ? win.performance.now()
        : Date.now();
    };
    var sequence = 0;

    return function stabilizeFullscreenExit(context) {
      if (!context || typeof context.isCurrent !== "function") return false;
      var ownSequence = ++sequence;
      var startedAt = now();
      var previousSignature = null;
      var stableFrames = 0;
      var settled = false;
      var capTimer = null;

      function current() {
        return ownSequence === sequence && context.isCurrent() === true;
      }

      function finishSettle() {
        if (settled) return;
        settled = true;
        if (capTimer != null) clearTimer(capTimer);
        if (!current() || doc.fullscreenElement) return;
        if (typeof context.measure === "function") context.measure();
        setTimer(function () {
          if (!current() || doc.fullscreenElement) return;
          var advanced = typeof context.hasAdvanced === "function" && context.hasAdvanced() === true;
          var paused = typeof context.isPaused === "function" && context.isPaused() === true;
          if (!advanced || paused) {
            if (typeof context.recover === "function") context.recover();
          }
        }, 750);
      }

      function inspectFrame() {
        if (settled || !current()) {
          if (capTimer != null) clearTimer(capTimer);
          return;
        }
        if (doc.fullscreenElement) {
          if (now() - startedAt >= 500) finishSettle();
          else requestFrame(inspectFrame);
          return;
        }
        var signature = viewportSignature(win);
        stableFrames = signature === previousSignature ? stableFrames + 1 : 1;
        previousSignature = signature;
        if (stableFrames >= 2 || now() - startedAt >= 500) finishSettle();
        else requestFrame(inspectFrame);
      }

      capTimer = setTimer(finishSettle, 500);
      requestFrame(inspectFrame);
      return true;
    };
  }

  function createSheetToolbar(doc) {
    var toolbar = doc.createElement("div");
    toolbar.className = "phone-sheet-toolbar";
    toolbar.hidden = true;

    var handle = doc.createElement("div");
    handle.className = "phone-sheet-handle";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-label", "Resize People and Tools panel");

    var grip = doc.createElement("span");
    grip.className = "phone-sheet-grip";
    grip.setAttribute("aria-hidden", "true");
    var label = doc.createElement("span");
    label.className = "phone-sheet-label";
    label.textContent = "People & Tools";
    handle.append(grip, label);

    var minimize = doc.createElement("button");
    minimize.type = "button";
    minimize.className = "phone-sheet-minimize";
    minimize.textContent = "−";
    minimize.title = "Make People and Tools smaller";
    minimize.setAttribute("aria-label", "Make People and Tools smaller");

    var expand = doc.createElement("button");
    expand.type = "button";
    expand.className = "phone-sheet-expand";
    expand.textContent = "+";
    expand.title = "Make People and Tools larger";
    expand.setAttribute("aria-label", "Make People and Tools larger");

    toolbar.append(handle, minimize, expand);
    return { toolbar: toolbar, handle: handle, minimize: minimize, expand: expand };
  }

  function createPhonePresentationController(options) {
    var input = options || {};
    var win = input.window;
    var doc = input.document;
    var rootElement = doc && doc.documentElement;
    var workspace = doc && doc.querySelector('[data-ui-region="workspace"]');
    var utilityHost = doc && doc.getElementById("utility-host");
    var peoplePanel = doc && doc.getElementById("room-sidebar");
    if (!win || !doc || !rootElement || !workspace || !utilityHost || !peoplePanel) {
      throw new Error("Echo phone presentation requires the connected shell DOM");
    }

    var requestFrame = typeof win.requestAnimationFrame === "function"
      ? win.requestAnimationFrame.bind(win)
      : function (callback) { return win.setTimeout(callback, 0); };
    var cancelFrame = typeof win.cancelAnimationFrame === "function"
      ? win.cancelAnimationFrame.bind(win)
      : function (handle) { win.clearTimeout(handle); };
    var controls = createSheetToolbar(doc);
    var contentNodes = Array.from(peoplePanel.children);
    peoplePanel.insertBefore(controls.toolbar, peoplePanel.firstChild || null);
    var snap = safeReadSnap(win.sessionStorage);
    var scheduledFrame = null;
    var started = false;
    var drag = null;
    var latestHeights = resolveSheetHeights(0);
    var stabilizeFullscreenExit = createFullscreenExitStabilizer({ window: win, document: doc });

    function workspaceHeight() {
      var clientHeight = Number(workspace.clientHeight) || 0;
      if (clientHeight > 0) return clientHeight;
      var rect = typeof workspace.getBoundingClientRect === "function"
        ? workspace.getBoundingClientRect()
        : null;
      return Number(rect && rect.height) || 0;
    }

    function isSheetActive() {
      return rootElement.dataset.uiShell === "v2" && isPortraitViewport(win);
    }

    function syncPeekAccessibility() {
      var hideContent = isSheetActive() && snap === "peek";
      contentNodes.forEach(function (node) {
        node.inert = hideContent;
        if (hideContent) node.setAttribute("aria-hidden", "true");
        else node.removeAttribute("aria-hidden");
      });
    }

    function syncControls() {
      var index = PHONE_SHEET_SNAPS.indexOf(snap);
      controls.handle.setAttribute("aria-valuemin", "0");
      controls.handle.setAttribute("aria-valuemax", String(PHONE_SHEET_SNAPS.length - 1));
      controls.handle.setAttribute("aria-valuenow", String(index));
      controls.handle.setAttribute("aria-valuetext", snap);
      controls.minimize.disabled = index === 0;
      controls.expand.disabled = index === PHONE_SHEET_SNAPS.length - 1;
      syncPeekAccessibility();
    }

    function measureNow() {
      var portrait = isPortraitViewport(win);
      rootElement.dataset.echoPhoneOrientation = portrait ? "portrait" : "landscape";
      controls.toolbar.hidden = !(portrait && rootElement.dataset.uiShell === "v2");
      if (!isSheetActive()) {
        utilityHost.style.removeProperty("--echo-phone-sheet-height");
        syncPeekAccessibility();
        return null;
      }
      latestHeights = resolveSheetHeights(workspaceHeight());
      utilityHost.style.setProperty("--echo-phone-sheet-height", latestHeights[snap] + "px");
      rootElement.dataset.echoPhoneSheetSnap = snap;
      syncControls();
      return Object.freeze({ snap: snap, height: latestHeights[snap], heights: latestHeights });
    }

    function scheduleMeasure() {
      if (scheduledFrame != null) return;
      scheduledFrame = requestFrame(function () {
        scheduledFrame = null;
        measureNow();
      });
    }

    function setSnap(nextSnap, persist) {
      snap = normalizeSnap(nextSnap);
      if (persist !== false) safeWriteSnap(win.sessionStorage, snap);
      measureNow();
      return snap;
    }

    function onHandleKeydown(event) {
      var next = null;
      if (event.key === "ArrowUp") next = adjacentSnap(snap, 1);
      else if (event.key === "ArrowDown") next = adjacentSnap(snap, -1);
      else if (event.key === "Home") next = "peek";
      else if (event.key === "End") next = "full";
      if (!next) return;
      event.preventDefault();
      setSnap(next);
    }

    function onPointerDown(event) {
      if (!isSheetActive() || (event.button != null && event.button !== 0)) return;
      latestHeights = resolveSheetHeights(workspaceHeight());
      drag = {
        pointerId: event.pointerId,
        startY: Number(event.clientY) || 0,
        startHeight: latestHeights[snap],
        currentHeight: latestHeights[snap],
      };
      rootElement.setAttribute("data-echo-phone-sheet-dragging", "");
      if (typeof controls.handle.setPointerCapture === "function") {
        try { controls.handle.setPointerCapture(event.pointerId); } catch (_error) {}
      }
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId || !isSheetActive()) return;
      var desired = drag.startHeight + drag.startY - (Number(event.clientY) || 0);
      drag.currentHeight = Math.max(latestHeights.peek, Math.min(latestHeights.full, desired));
      utilityHost.style.setProperty("--echo-phone-sheet-height", Math.round(drag.currentHeight) + "px");
      event.preventDefault();
    }

    function finishPointer(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      var finalHeight = drag.currentHeight;
      drag = null;
      rootElement.removeAttribute("data-echo-phone-sheet-dragging");
      setSnap(nearestSnap(finalHeight, latestHeights));
      event.preventDefault();
    }

    function start() {
      if (started) return measureNow();
      started = true;
      rootElement.dataset.echoPhone = "true";
      controls.handle.addEventListener("keydown", onHandleKeydown);
      controls.handle.addEventListener("pointerdown", onPointerDown);
      controls.handle.addEventListener("pointermove", onPointerMove);
      controls.handle.addEventListener("pointerup", finishPointer);
      controls.handle.addEventListener("pointercancel", finishPointer);
      controls.minimize.addEventListener("click", function () { setSnap(adjacentSnap(snap, -1)); });
      controls.expand.addEventListener("click", function () { setSnap(adjacentSnap(snap, 1)); });
      win.addEventListener("resize", scheduleMeasure, { passive: true });
      win.addEventListener("orientationchange", scheduleMeasure, { passive: true });
      win.addEventListener("echo:ui-shell-change", scheduleMeasure);
      if (win.visualViewport && typeof win.visualViewport.addEventListener === "function") {
        win.visualViewport.addEventListener("resize", scheduleMeasure, { passive: true });
      }
      return measureNow();
    }

    function stop() {
      if (!started) return;
      started = false;
      win.removeEventListener("resize", scheduleMeasure);
      win.removeEventListener("orientationchange", scheduleMeasure);
      win.removeEventListener("echo:ui-shell-change", scheduleMeasure);
      if (win.visualViewport && typeof win.visualViewport.removeEventListener === "function") {
        win.visualViewport.removeEventListener("resize", scheduleMeasure);
      }
      if (scheduledFrame != null) cancelFrame(scheduledFrame);
      scheduledFrame = null;
      controls.toolbar.remove();
      utilityHost.style.removeProperty("--echo-phone-sheet-height");
      delete rootElement.dataset.echoPhoneOrientation;
      delete rootElement.dataset.echoPhoneSheetSnap;
      rootElement.removeAttribute("data-echo-phone-sheet-dragging");
      contentNodes.forEach(function (node) {
        node.inert = false;
        node.removeAttribute("aria-hidden");
      });
    }

    return Object.freeze({
      isPhone: function () { return true; },
      measureNow: measureNow,
      setSnap: setSnap,
      snap: function () { return snap; },
      stabilizeFullscreenExit: stabilizeFullscreenExit,
      start: start,
      stop: stop,
    });
  }

  function install(options) {
    if (installedController) return installedController;
    var input = options || {};
    if (!isPhoneBrowser({
      navigator: input.window && input.window.navigator,
      isNativeShell: input.window && input.window.__ECHO_NATIVE__ === true,
    })) return null;
    installedController = createPhonePresentationController(input);
    installedController.start();
    return installedController;
  }

  function isPhone() {
    return !!installedController;
  }

  function stabilizeFullscreenExit(context) {
    if (!installedController) return false;
    return installedController.stabilizeFullscreenExit(context);
  }

  return Object.freeze({
    PHONE_SHEET_SNAPS: PHONE_SHEET_SNAPS,
    adjacentSnap: adjacentSnap,
    createFullscreenExitStabilizer: createFullscreenExitStabilizer,
    createPhonePresentationController: createPhonePresentationController,
    install: install,
    isPhone: isPhone,
    isPhoneBrowser: isPhoneBrowser,
    nearestSnap: nearestSnap,
    normalizeSnap: normalizeSnap,
    resolveSheetHeights: resolveSheetHeights,
    stabilizeFullscreenExit: stabilizeFullscreenExit,
  });
});
