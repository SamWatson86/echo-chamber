/* State variables and DOM refs are in state.js — loaded before this file */
/* Participant cards, video elements, tiles, avatars, and diagnostics are in participants.js */
/* Connection lifecycle (connect, disconnect, switchRoom, connectToRoom) are in connect.js */

if (nameInput) {
  const savedName = echoGet(REMEMBER_NAME_KEY);
  if (savedName) nameInput.value = savedName;
}
if (passwordInput) {
  const savedPass = echoGet(REMEMBER_PASS_KEY);
  if (savedPass) {
    passwordInput.value = savedPass;
    // Password is saved — keep the field hidden
  } else {
    // No saved password — show the field
    var pwField = document.getElementById("password-field");
    if (pwField) pwField.classList.remove("hidden");
  }
}

// Advanced toggle for URL/device fields on login page
var advancedToggle = document.getElementById("advanced-toggle");
var advancedSection = document.getElementById("advanced-section");
if (advancedToggle && advancedSection) {
  advancedToggle.addEventListener("click", function() {
    advancedSection.classList.toggle("hidden");
    advancedToggle.textContent = advancedSection.classList.contains("hidden") ? "Advanced" : "Hide Advanced";
  });
}

// Hide header while portal is showing (re-shown on connect, hidden on disconnect)
document.querySelector("header")?.classList.add("portal-hidden");

// Soundboard state vars (echoGet-dependent) are in soundboard.js

// ── Hardware capability detection ──
// Probe WebCodecs to detect hardware video encoding (NVENC/QSV/AMF).
// Results stored in window.__echoHwCaps for publishing decisions.
window.__echoHwCaps = { ready: false, h264Hw: false, h264Sw: false, av1Hw: false, av1Sw: false, canSimulcast: false };
(async function testHardwareEncoding() {
  try {
    if (typeof VideoEncoder === "undefined") {
      console.log("[NVENC] WebCodecs VideoEncoder not available");
      window.__echoHwCaps.ready = true;
      return;
    }
    const configs = [
      { codec: "avc1.640028", label: "H264-High", hwKey: "h264Hw", swKey: "h264Sw" },
      { codec: "av01.0.08M.08", label: "AV1", hwKey: "av1Hw", swKey: "av1Sw" },
    ];
    for (const { codec, label, hwKey, swKey } of configs) {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: 1920,
        height: 1080,
        framerate: 60,
        bitrate: 8_000_000,
        hardwareAcceleration: "prefer-hardware",
      });
      const supportSw = await VideoEncoder.isConfigSupported({
        codec,
        width: 1920,
        height: 1080,
        framerate: 60,
        bitrate: 8_000_000,
        hardwareAcceleration: "prefer-software",
      });
      window.__echoHwCaps[hwKey] = !!support.supported;
      window.__echoHwCaps[swKey] = !!supportSw.supported;
      console.log(`[NVENC] ${label}: hw=${support.supported}, sw=${supportSw.supported}`);
    }
    // Hardware H264 encoder = can handle multi-layer simulcast without crushing CPU/GPU
    window.__echoHwCaps.canSimulcast = window.__echoHwCaps.h264Hw;
    console.log("[NVENC] canSimulcast=" + window.__echoHwCaps.canSimulcast);
  } catch (e) {
    console.log("[NVENC] diagnostic error: " + e.message);
  } finally {
    window.__echoHwCaps.ready = true;
  }
})();

if (debugToggleBtn && debugPanel) {
  debugToggleBtn.addEventListener("click", () => {
    debugPanel.classList.toggle("hidden");
  });
}
if (debugCloseBtn && debugPanel) {
  debugCloseBtn.addEventListener("click", () => {
    debugPanel.classList.add("hidden");
  });
}
if (debugClearBtn) {
  debugClearBtn.addEventListener("click", () => {
    debugLines.length = 0;
    if (debugLogEl) debugLogEl.textContent = "";
  });
}
if (debugCopyBtn) {
  debugCopyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(debugLines.join("\n"));
    } catch {}
  });
}

// Clubhouse presentation controls are static DOM nodes. They proxy existing
// state owners instead of creating a second media/control implementation.
var dockOutputButton = document.getElementById("dock-output");
var dockLeaveButton = document.getElementById("dock-leave");
var shellUtilityButton = document.getElementById("shell-toggle-utility");
var shellMoreButton = document.getElementById("shell-more-actions");
var shellOverflowMenu = document.getElementById("shell-overflow-menu");
var shellHeader = document.querySelector('[data-ui-region="shell-header"]');
var shellLayout = document.querySelector('[data-ui-region="workspace"]');
var shellStage = document.querySelector('[data-ui-region="primary-stage"]');
var shellStageHeader = shellStage?.querySelector(":scope > .grid-header");
var shellScreenGrid = document.getElementById("screen-grid");
var shellStageModuleHost = document.getElementById("stage-module-host");
var shellUtilityHost = document.getElementById("utility-host");
var shellUtilityScrim = document.getElementById("utility-scrim");
var shellPeoplePanel = document.getElementById("room-sidebar");
var shellPeopleHeading = shellPeoplePanel?.querySelector(".sidebar-title-row h2");
var shellJamPanel = document.getElementById("jam-panel");
var shellOpenJamButton = document.getElementById("open-jam");
var shellCloseJamButton = document.getElementById("close-jam");
var shellCameraLobbyPanel = document.getElementById("camera-lobby");
var shellSoundboardCompactPanel = document.getElementById("soundboard-compact");
var shellSoundboardPanel = document.getElementById("soundboard");
var clubhouseShell = document.getElementById("clubhouse-shell");
var settingsScrim = document.getElementById("settings-scrim");
var settingsReturnFocus = null;
var settingsModalActive = false;
var activeStageModule = null;
var stageModuleOpeners = {
  chat: openChatButton,
  jam: shellOpenJamButton,
  camera: openCameraLobbyButton,
  soundboard: openSoundboardButton,
};
var stageModuleReturnFocus = Object.assign({}, stageModuleOpeners);
var legacyStageModuleControlIds = {
  chat: "chat-panel",
  jam: "jam-panel",
  camera: "camera-lobby",
  soundboard: "soundboard-compact",
};
var stageModulePortalAnchors = new Map();
var stageModulePortalFocusGeneration = 0;
var stageModulePortalPendingFocus = null;
var syncingClubhouseUtility = false;

function setShellOverflowOpen(open, options) {
  if (!shellHeader || !shellMoreButton) return;
  shellHeader.classList.toggle("shell-overflow-open", !!open);
  shellMoreButton.setAttribute("aria-expanded", open ? "true" : "false");
  if (open && (!options || options.focus !== false) && shellOverflowMenu) {
    var firstCommand = Array.from(shellOverflowMenu.querySelectorAll("button:not(.hidden):not(:disabled)"))
      .find(function(command) { return command.getClientRects().length > 0; });
    if (firstCommand) firstCommand.focus();
  } else if (!open && options && options.restoreFocus) {
    shellMoreButton.focus();
  }
}

function settingsFocusableElements() {
  if (!settingsPanel) return [];
  return Array.from(settingsPanel.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )).filter(function(element) {
    return element.getClientRects().length > 0;
  });
}

function isRenderedFocusable(element) {
  return !!(element
    && element.isConnected
    && !element.disabled
    && element.getClientRects().length > 0
    && !element.closest("[inert]"));
}

function setSettingsModalPresentation(modal) {
  settingsModalActive = !!modal;
  settingsPanel?.toggleAttribute("aria-modal", settingsModalActive);
  if (settingsScrim) settingsScrim.classList.toggle("hidden", !settingsModalActive);
  if (connectPanel) connectPanel.inert = settingsModalActive;
  if (clubhouseShell) clubhouseShell.inert = settingsModalActive;
  syncClubhouseUtilityPresentation();
}

function focusSettingsReturnTarget(preferred) {
  var isV2 = document.documentElement.dataset.uiShell === "v2";
  var candidates = isV2
    ? [preferred, shellMoreButton, openSettingsButton, shellUtilityButton, connectBtn]
    : [preferred, openSettingsButton, connectBtn];
  var target = candidates.find(isRenderedFocusable);
  if (target) target.focus();
}

function syncSettingsModalPresentation() {
  if (!settingsPanel) return;
  var panelOpen = !settingsPanel.classList.contains("hidden");
  var shouldBeModal = panelOpen && document.documentElement.dataset.uiShell === "v2";
  var becomingModal = shouldBeModal && !settingsModalActive;
  if (becomingModal && !settingsReturnFocus) {
    settingsReturnFocus = isRenderedFocusable(shellMoreButton) ? shellMoreButton : openSettingsButton;
  }
  setSettingsModalPresentation(shouldBeModal);
  if (becomingModal) {
    requestAnimationFrame(function() {
      var focusTarget = closeSettingsButton || settingsFocusableElements()[0];
      if (focusTarget) focusTarget.focus();
    });
  }
}

function setSettingsPanelOpen(open, returnFocusTarget) {
  if (!settingsPanel) return;
  var modal = !!open && document.documentElement.dataset.uiShell === "v2";
  if (open) {
    settingsReturnFocus = modal ? (returnFocusTarget || document.activeElement) : null;
    settingsPanel.classList.remove("hidden");
  } else {
    settingsPanel.classList.add("hidden");
  }
  setSettingsModalPresentation(modal);
  if (dockOutputButton) dockOutputButton.setAttribute("aria-expanded", open ? "true" : "false");
  if (openSettingsButton) openSettingsButton.setAttribute("aria-expanded", open ? "true" : "false");
  if (modal) {
    requestAnimationFrame(function() {
      var focusTarget = closeSettingsButton || settingsFocusableElements()[0];
      if (focusTarget) focusTarget.focus();
    });
  } else {
    var focusReturn = settingsReturnFocus;
    settingsReturnFocus = null;
    if (!open && focusReturn) focusSettingsReturnTarget(focusReturn);
  }
}

function normalizeStageModule(module) {
  return module === "chat" || module === "jam" || module === "camera" || module === "soundboard"
    ? module
    : null;
}

function stageModuleNodes(module) {
  if (module === "chat") return chatPanel ? [chatPanel] : [];
  if (module === "jam") return shellJamPanel ? [shellJamPanel] : [];
  if (module === "camera") return shellCameraLobbyPanel ? [shellCameraLobbyPanel] : [];
  if (module === "soundboard") {
    return [shellSoundboardCompactPanel, shellSoundboardPanel].filter(Boolean);
  }
  return [];
}

function allStageModuleNodes() {
  return ["chat", "jam", "camera", "soundboard"].flatMap(stageModuleNodes);
}

function stageModuleOpenerNodes(module) {
  return [stageModuleOpeners[module], stageModuleReturnFocus[module]].filter(function(opener, index, values) {
    return opener && values.indexOf(opener) === index;
  });
}

function rememberStageModulePortals() {
  allStageModuleNodes().forEach(function(panel) {
    if (stageModulePortalAnchors.has(panel) || !panel.parentNode) return;
    var anchor = document.createComment("echo-stage-module:" + (panel.id || "panel"));
    panel.parentNode.insertBefore(anchor, panel);
    stageModulePortalAnchors.set(panel, anchor);
  });
}

function restoreStageModulePortalFocus(element, panel, generation) {
  requestAnimationFrame(function() {
    if (generation !== stageModulePortalFocusGeneration) return;
    var clearPendingFocus = function() {
      if (stageModulePortalPendingFocus?.generation === generation) {
        stageModulePortalPendingFocus = null;
      }
    };
    if (!element || typeof element.focus !== "function" ||
        element.ownerDocument !== document || panel?.ownerDocument !== document ||
        !element.isConnected || !panel?.isConnected || !panel.contains(element)) {
      clearPendingFocus();
      return;
    }
    var current = document.activeElement;
    if (current !== element && current !== document.body && current !== document.documentElement) {
      clearPendingFocus();
      return;
    }
    if (!isRenderedFocusable(element)) {
      clearPendingFocus();
      return;
    }
    element.focus({ preventScroll: true });
    clearPendingFocus();
  });
}

function moveStageModulePanels(useStageHost) {
  rememberStageModulePortals();
  var panels = allStageModuleNodes();
  var focusedElement = document.activeElement;
  var focusedPanel = panels.find(function(panel) {
    return focusedElement && panel.contains(focusedElement);
  });
  if (!focusedPanel &&
      (focusedElement === document.body || focusedElement === document.documentElement) &&
      stageModulePortalPendingFocus?.element?.isConnected &&
      stageModulePortalPendingFocus.panel?.contains(stageModulePortalPendingFocus.element)) {
    focusedElement = stageModulePortalPendingFocus.element;
    focusedPanel = stageModulePortalPendingFocus.panel;
  }
  var willMove = panels.some(function(panel) {
    if (useStageHost && shellStageModuleHost) return panel.parentNode !== shellStageModuleHost;
    var anchor = stageModulePortalAnchors.get(panel);
    return !!anchor?.parentNode && panel.parentNode !== anchor.parentNode;
  });
  var focusGeneration = willMove
    ? ++stageModulePortalFocusGeneration
    : stageModulePortalFocusGeneration;
  if (willMove) {
    stageModulePortalPendingFocus = focusedPanel && focusedElement
      ? { element: focusedElement, panel: focusedPanel, generation: focusGeneration }
      : null;
  }

  panels.forEach(function(panel) {
    if (useStageHost && shellStageModuleHost) {
      if (panel.parentNode !== shellStageModuleHost) shellStageModuleHost.appendChild(panel);
      panel.classList.add("clubhouse-stage-module");
      panel.classList.toggle("clubhouse-utility-tool", panel === shellJamPanel);
      panel.setAttribute("role", "region");
      return;
    }
    var anchor = stageModulePortalAnchors.get(panel);
    if (anchor?.parentNode && panel.parentNode !== anchor.parentNode) {
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    }
    panel.classList.remove("clubhouse-stage-module", "clubhouse-utility-tool");
    panel.setAttribute("role", "dialog");
  });

  if (willMove && focusedPanel && focusedElement) {
    restoreStageModulePortalFocus(focusedElement, focusedPanel, focusGeneration);
  }
}

function inferVisibleStageModule() {
  return ["chat", "jam", "camera", "soundboard"].find(function(module) {
    return stageModuleNodes(module).some(function(panel) {
      return !panel.classList.contains("hidden");
    });
  }) || null;
}

function focusReturnTarget(preferred, module) {
  var candidates = [preferred, stageModuleOpeners[module], shellUtilityButton, shellMoreButton, connectBtn];
  var target = candidates.find(isRenderedFocusable);
  if (target) target.focus();
}

function focusActiveStageModule(module) {
  var target = module === "chat"
    ? chatInput
    : module === "jam"
      ? shellCloseJamButton
      : module === "camera"
        ? closeCameraLobbyButton
        : closeSoundboardButton;
  if (isRenderedFocusable(target)) target.focus();
}

function scheduleStageGridRecalc() {
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      if (shellStage?.classList.contains("stage-module-open")) return;
      if (typeof window._echoRecalcGrid === "function") window._echoRecalcGrid();
    });
  });
}

function syncStageModulePanels() {
  ["chat", "jam", "camera", "soundboard"].forEach(function(module) {
    var isActive = activeStageModule === module;
    var nodes = stageModuleNodes(module);
    if (isActive && module !== "soundboard") {
      nodes.forEach(function(panel) { panel.classList.remove("hidden"); });
    }
    if (isActive && module === "soundboard" && nodes.every(function(panel) {
      return panel.classList.contains("hidden");
    })) {
      shellSoundboardCompactPanel?.classList.remove("hidden");
    }
    nodes.forEach(function(panel) {
      if (!isActive) panel.classList.add("hidden");
      var visible = isActive && !panel.classList.contains("hidden");
      panel.inert = !visible || settingsModalActive;
      panel.setAttribute("aria-hidden", visible ? "false" : "true");
    });
  });
}

function syncClubhouseUtilityPresentation() {
  if (!shellLayout || !shellStage || !shellUtilityHost || !shellStageModuleHost) return;
  if (syncingClubhouseUtility) return;
  syncingClubhouseUtility = true;
  try {
    var isV2 = document.documentElement.dataset.uiShell === "v2";
    var collapsed = shellLayout.classList.contains("utility-collapsed");

    if (!isV2) {
      var stageModuleWasOpen = shellStage.classList.contains("stage-module-open");
      if (!activeStageModule) activeStageModule = inferVisibleStageModule();
      moveStageModulePanels(false);
      delete document.documentElement.dataset.uiUtility;
      delete document.documentElement.dataset.stageModule;
      delete shellLayout.dataset.activeUtility;
      delete shellStage.dataset.activeModule;
      if (shellLayout.classList.contains("jam-open")) shellLayout.classList.remove("jam-open");
      if (activeStageModule === "chat" && !chatPanel?.classList.contains("hidden")) {
        if (!shellLayout.classList.contains("chat-open")) shellLayout.classList.add("chat-open");
      } else if (shellLayout.classList.contains("chat-open")) {
        shellLayout.classList.remove("chat-open");
      }
      shellStage.classList.remove("stage-module-open");
      shellStage.inert = false;
      if (shellStageHeader) shellStageHeader.inert = false;
      if (shellScreenGrid) shellScreenGrid.inert = false;
      shellStageModuleHost.classList.add("hidden");
      shellStageModuleHost.inert = true;
      shellStageModuleHost.dataset.activeModule = "";
      shellStageModuleHost.setAttribute("aria-hidden", "true");
      shellUtilityHost.inert = false;
      shellUtilityHost.removeAttribute("aria-hidden");
      shellPeoplePanel?.classList.remove("hidden");
      if (shellPeoplePanel) {
        shellPeoplePanel.setAttribute("aria-label", "People");
        shellPeoplePanel.inert = false;
        shellPeoplePanel.removeAttribute("aria-hidden");
      }
      if (shellPeopleHeading) shellPeopleHeading.textContent = "Active Users";
      allStageModuleNodes().forEach(function(panel) {
        panel.inert = false;
        panel.removeAttribute("aria-hidden");
      });
      Object.keys(stageModuleOpeners).forEach(function(module) {
        stageModuleOpenerNodes(module).forEach(function(opener) {
          opener.setAttribute("aria-controls", legacyStageModuleControlIds[module]);
          opener.setAttribute("aria-expanded", "false");
        });
      });
      if (shellSoundboardCompactPanel && !shellSoundboardCompactPanel.classList.contains("hidden") &&
          typeof positionLegacySoundboardCompact === "function") {
        positionLegacySoundboardCompact();
      }
      shellUtilityScrim?.classList.add("hidden");
      if (closeChatButton) {
        closeChatButton.textContent = "Close";
        closeChatButton.removeAttribute("aria-label");
      }
      if (shellCloseJamButton) {
        shellCloseJamButton.textContent = "Close";
        shellCloseJamButton.removeAttribute("aria-label");
      }
      if (closeCameraLobbyButton) {
        closeCameraLobbyButton.textContent = "Close";
        closeCameraLobbyButton.removeAttribute("aria-label");
      }
      if (closeSoundboardButton) {
        closeSoundboardButton.textContent = "Back";
        closeSoundboardButton.title = "Close";
        closeSoundboardButton.removeAttribute("aria-label");
      }
      if (stageModuleWasOpen) scheduleStageGridRecalc();
      return;
    }

    if (!activeStageModule) activeStageModule = inferVisibleStageModule();
    activeStageModule = normalizeStageModule(activeStageModule);
    moveStageModulePanels(true);
    shellUtilityHost.dataset.activeTool = "people";
    shellLayout.dataset.activeUtility = "people";
    document.documentElement.dataset.uiUtility = "people";
    if (shellLayout.classList.contains("chat-open")) shellLayout.classList.remove("chat-open");
    if (shellLayout.classList.contains("jam-open")) shellLayout.classList.remove("jam-open");

    if (activeStageModule) {
      document.documentElement.dataset.stageModule = activeStageModule;
      shellStage.dataset.activeModule = activeStageModule;
      shellStageModuleHost.dataset.activeModule = activeStageModule;
    } else {
      delete document.documentElement.dataset.stageModule;
      delete shellStage.dataset.activeModule;
      shellStageModuleHost.dataset.activeModule = "";
    }
    shellStage.classList.toggle("stage-module-open", !!activeStageModule);
    shellStage.inert = false;
    if (shellStageHeader) shellStageHeader.inert = !!activeStageModule || settingsModalActive;
    if (shellScreenGrid) shellScreenGrid.inert = !!activeStageModule || settingsModalActive;
    shellStageModuleHost.classList.toggle("hidden", !activeStageModule);
    shellStageModuleHost.inert = !activeStageModule || settingsModalActive;
    shellStageModuleHost.setAttribute("aria-hidden", activeStageModule ? "false" : "true");
    syncStageModulePanels();
    Object.keys(stageModuleOpeners).forEach(function(module) {
      stageModuleOpenerNodes(module).forEach(function(opener) {
        opener.setAttribute("aria-controls", "stage-module-host");
        opener.setAttribute("aria-expanded", String(activeStageModule === module));
      });
    });

    shellPeoplePanel?.classList.remove("hidden");
    if (shellPeoplePanel) {
      shellPeoplePanel.setAttribute("aria-label", "Active Users");
      shellPeoplePanel.inert = collapsed || settingsModalActive;
      shellPeoplePanel.setAttribute("aria-hidden", collapsed ? "true" : "false");
    }
    if (shellPeopleHeading) shellPeopleHeading.textContent = "Active Users";
    shellUtilityHost.inert = collapsed || settingsModalActive;
    shellUtilityHost.setAttribute("aria-hidden", collapsed ? "true" : "false");
    shellUtilityScrim?.classList.add("hidden");

    if (closeChatButton) {
      closeChatButton.textContent = "Back to Stage";
      closeChatButton.setAttribute("aria-label", "Back to Stage");
    }
    if (shellCloseJamButton) {
      shellCloseJamButton.textContent = "Back to Stage";
      shellCloseJamButton.setAttribute("aria-label", "Back to Stage");
    }
    if (closeCameraLobbyButton) {
      closeCameraLobbyButton.textContent = "Back to Stage";
      closeCameraLobbyButton.setAttribute("aria-label", "Back to Stage");
    }
    if (closeSoundboardButton) {
      closeSoundboardButton.textContent = "Back to Stage";
      closeSoundboardButton.title = "Back to Stage";
      closeSoundboardButton.setAttribute("aria-label", "Back to Stage");
    }
    if (shellUtilityButton) {
      shellUtilityButton.textContent = "Users";
      shellUtilityButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
      shellUtilityButton.setAttribute("aria-label", (collapsed ? "Show" : "Hide") + " active users");
    }
  } finally {
    syncingClubhouseUtility = false;
  }
}

function setClubhouseUtilityCollapsed(collapsed, options) {
  if (!shellLayout) return false;
  shellLayout.classList.toggle("utility-collapsed", !!collapsed);
  syncClubhouseUtilityPresentation();
  if (collapsed && options && options.restoreFocus) {
    requestAnimationFrame(function() { focusReturnTarget(shellUtilityButton); });
  }
  return true;
}

function openStageModule(module, opener, options) {
  var normalized = normalizeStageModule(module);
  if (!normalized) return false;
  if (activeStageModule === "jam" && normalized !== "jam" &&
      typeof pauseJamAudioVisualizer === "function") {
    pauseJamAudioVisualizer();
  }
  if (activeStageModule === "camera" && normalized !== "camera" &&
      typeof clearCameraLobbyMedia === "function") {
    clearCameraLobbyMedia();
  }
  activeStageModule = normalized;
  if (isRenderedFocusable(opener)) stageModuleReturnFocus[normalized] = opener;
  if (document.documentElement.dataset.uiShell !== "v2") return false;
  syncClubhouseUtilityPresentation();
  if (!options || options.focus !== false) {
    requestAnimationFrame(function() { focusActiveStageModule(normalized); });
  }
  return true;
}

function closeStageModule(module, options) {
  var normalized = normalizeStageModule(module || activeStageModule);
  if (!normalized) return false;
  if (document.documentElement.dataset.uiShell !== "v2") {
    if (activeStageModule === normalized) activeStageModule = null;
    return false;
  }
  var returnTarget = stageModuleReturnFocus[normalized];
  stageModuleNodes(normalized).forEach(function(panel) { panel.classList.add("hidden"); });
  if (activeStageModule === normalized) activeStageModule = null;
  syncClubhouseUtilityPresentation();
  if (!activeStageModule) scheduleStageGridRecalc();
  if ((!options || options.restoreFocus !== false) && !activeStageModule) {
    requestAnimationFrame(function() { focusReturnTarget(returnTarget, normalized); });
  }
  return true;
}

function hasHigherPriorityEscapeSurface() {
  if (document.fullscreenElement) return true;
  var candidates = document.querySelectorAll([
    ".image-lightbox",
    "#capture-picker-overlay",
    ".modal-overlay",
    ".whats-new-overlay",
    '[role="dialog"]:not(#chat-panel):not(#jam-panel):not(#settings-panel)',
  ].join(","));
  return Array.from(candidates).some(function(element) {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  });
}

function keepFocusedUtilityControlVisible() {
  if (document.documentElement.dataset.uiShell !== "v2" ||
      settingsModalActive) return;
  var active = document.activeElement;
  var activePanel = activeStageModule
    ? stageModuleNodes(activeStageModule).find(function(panel) { return panel.contains(active); })
    : shellPeoplePanel;
  if (!active || !activePanel?.contains(active) || typeof active.scrollIntoView !== "function") return;
  requestAnimationFrame(function() {
    if (document.activeElement === active) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });
}

window.EchoStageModules = Object.freeze({
  activeModule: function() { return activeStageModule; },
  close: closeStageModule,
  open: openStageModule,
  sync: syncClubhouseUtilityPresentation,
});

// Compatibility bridge for the existing Chat and Jam state owners. In V2 they
// now target the Stage; legacy continues to use each feature's original panel.
window.EchoClubhouseUtility = Object.freeze({
  activeTool: function() { return activeStageModule || "people"; },
  close: closeStageModule,
  collapse: setClubhouseUtilityCollapsed,
  open: openStageModule,
  sync: syncClubhouseUtilityPresentation,
});

if (dockOutputButton && settingsPanel) {
  dockOutputButton.addEventListener("click", function() {
    if (!dockOutputButton.disabled) setSettingsPanelOpen(true, dockOutputButton);
  });
}

if (settingsScrim) {
  settingsScrim.addEventListener("click", function() {
    setSettingsPanelOpen(false);
  });
}

if (dockLeaveButton && disconnectTopBtn) {
  dockLeaveButton.addEventListener("click", function() {
    if (!disconnectTopBtn.disabled) disconnectTopBtn.click();
  });
}

if (shellMoreButton) {
  shellMoreButton.addEventListener("click", function(event) {
    event.stopPropagation();
    var open = !shellHeader.classList.contains("shell-overflow-open");
    setShellOverflowOpen(open, { focus: open });
  });
}

if (shellOverflowMenu) {
  shellOverflowMenu.addEventListener("click", function(event) {
    var command = event.target.closest("button");
    if (!command) return;
    setShellOverflowOpen(false);
    requestAnimationFrame(function() {
      if (document.activeElement === command) shellMoreButton?.focus();
    });
  });
}

if (shellUtilityButton && shellLayout) {
  shellUtilityButton.addEventListener("click", function() {
    setClubhouseUtilityCollapsed(!shellLayout.classList.contains("utility-collapsed"));
  });
}

window.addEventListener("echo:ui-shell-change", function() {
  syncClubhouseUtilityPresentation();
  syncSettingsModalPresentation();
  keepFocusedUtilityControlVisible();
  if (!shellHeader?.classList.contains("shell-overflow-open")) return;
  var canRestoreMoreFocus = document.documentElement.dataset.uiShell === "v2"
    && shellMoreButton
    && shellMoreButton.getClientRects().length > 0;
  setShellOverflowOpen(false, { restoreFocus: canRestoreMoreFocus });
});
if (shellLayout && typeof MutationObserver === "function") {
  var shellLayoutObserver = new MutationObserver(syncClubhouseUtilityPresentation);
  shellLayoutObserver.observe(shellLayout, { attributes: true, attributeFilter: ["class"] });
}

document.addEventListener("click", function(event) {
  if (shellHeader && !shellHeader.contains(event.target)) setShellOverflowOpen(false);
});

document.addEventListener("keydown", function(event) {
  if (event.defaultPrevented) return;
  if (settingsModalActive && settingsPanel && !settingsPanel.classList.contains("hidden")) {
    if (event.key === "Escape") {
      event.preventDefault();
      setSettingsPanelOpen(false);
      return;
    }
    if (event.key === "Tab") {
      var focusable = settingsFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (event.key !== "Escape") return;
  if (shellHeader?.classList.contains("shell-overflow-open")) {
    event.preventDefault();
    setShellOverflowOpen(false, { restoreFocus: true });
    return;
  }
  // A single Escape dismisses only the topmost surface. Dynamic lightboxes,
  // capture pickers, fullscreen media, and true modal dialogs own it before a
  // Stage module. The Active Users rail is changed only by its explicit button.
  if (hasHigherPriorityEscapeSurface()) return;
  if (document.documentElement.dataset.uiShell !== "v2") return;
  if (activeStageModule) {
    event.preventDefault();
    if (activeStageModule === "chat" && typeof closeChat === "function") closeChat();
    else if (activeStageModule === "jam" && typeof closeJamPanel === "function") closeJamPanel();
    else if (activeStageModule === "camera" && typeof closeCameraLobby === "function") closeCameraLobby();
    else if (activeStageModule === "soundboard" && typeof closeSoundboard === "function") closeSoundboard();
    else closeStageModule(activeStageModule);
    return;
  }
});

syncClubhouseUtilityPresentation();

// Connection lifecycle (hookPublication, switchRoom, connectToRoom, connect, disconnect,
// setPublishButtonsEnabled, renderPublishButtons, reconcileLocalPublishIndicators,
// buildChimeSettingsUI) are in connect.js

// Media toggles (toggleMic, toggleCam, toggleScreen, etc.) → media-controls.js

micBtn.addEventListener("click", () => {
  toggleMic().catch(() => {});
});

camBtn.addEventListener("click", () => {
  toggleCam().catch(() => {});
});

screenBtn.addEventListener("click", () => {
  toggleScreen().catch(() => {});
});

if (flipCamBtn) {
  flipCamBtn.addEventListener("click", () => {
    flipCam().catch(() => {});
  });
}

refreshDevicesBtn.addEventListener("click", async () => {
  setDeviceStatus("Refreshing devices...");
  await ensureDevicePermissions();
  await refreshDevices();
});

// Create Room button removed in favor of fixed rooms (Main, Breakout 1-3)

// On mobile, hide camera device dropdown (labels are cryptic) and show flip button
if (_isMobileDevice) {
  var camLabel = camSelect?.closest("label.device-field");
  if (camLabel) camLabel.style.display = "none";
}

micSelect.addEventListener("change", () => {
  switchMic(micSelect.value).catch(() => {});
});

camSelect.addEventListener("change", () => {
  switchCam(camSelect.value).catch(() => {});
});

speakerSelect.addEventListener("change", () => {
  switchSpeaker(speakerSelect.value).catch(() => {});
});

if (refreshVideosButton) {
  refreshVideosButton.addEventListener("click", async () => {
    if (window._enableAllMedia) {
      await window._enableAllMedia();
    }
  });
}

// Soundboard event listeners are in soundboard.js

// Camera Lobby event listeners
if (openCameraLobbyButton) {
  openCameraLobbyButton.addEventListener("click", () => {
    openCameraLobby();
  });
}

if (closeCameraLobbyButton) {
  closeCameraLobbyButton.addEventListener("click", () => {
    closeCameraLobby();
  });
}

if (lobbyToggleMicButton) {
  lobbyToggleMicButton.addEventListener("click", async () => {
    await toggleMic();
    if (micEnabled) {
      lobbyToggleMicButton.classList.remove('active');
      lobbyToggleMicButton.innerHTML = '<span class="mic-icon">🎤</span> Mute Mic';
    } else {
      lobbyToggleMicButton.classList.add('active');
      lobbyToggleMicButton.innerHTML = '<span class="mic-icon">🔇</span> Unmute Mic';
    }
  });
}

if (lobbyToggleCameraButton) {
  lobbyToggleCameraButton.addEventListener("click", async () => {
    await toggleCam();
    if (camEnabled) {
      lobbyToggleCameraButton.classList.remove('active');
      lobbyToggleCameraButton.innerHTML = '<span class="camera-icon">📹</span> Turn Off Camera';
    } else {
      lobbyToggleCameraButton.classList.add('active');
      lobbyToggleCameraButton.innerHTML = '<span class="camera-icon">📷</span> Turn On Camera';
    }
    // Refresh lobby to show/hide local camera
    if (!cameraLobbyPanel.classList.contains('hidden')) {
      populateCameraLobby();
    }
  });
}


// Soundboard clip volume, file, upload, cancel listeners are in soundboard.js

if (toggleRoomAudioButton) {
  toggleRoomAudioButton.addEventListener("click", () => {
    setRoomAudioMutedState(!roomAudioMuted);
  });
}

if (openSettingsButton && settingsPanel) {
  openSettingsButton.addEventListener("click", function() {
    var returnTarget = document.documentElement.dataset.uiShell === "v2" && shellMoreButton
      ? shellMoreButton
      : openSettingsButton;
    setSettingsPanelOpen(settingsPanel.classList.contains("hidden"), returnTarget);
  });
}

if (closeSettingsButton && settingsPanel) {
  closeSettingsButton.addEventListener("click", function() {
    setSettingsPanelOpen(false);
  });
}

renderPublishButtons();
setPublishButtonsEnabled(false);
setDefaultUrls();
// Admin mode initialization
if (isAdminMode()) {
  document.body.classList.add("admin-mode");
  // Show admin-only elements
  document.querySelectorAll(".admin-only").forEach(function(el) {
    if (el.id === "admin-dash-panel") return; // Panel shown via toggleAdminDash()
    el.classList.remove("hidden");
  });
  // Auto-login: fetch password from Tauri config and auto-connect
  if (hasTauriIPC()) {
    tauriInvoke("get_admin_password").then(function(pw) {
      if (pw && passwordInput) {
        passwordInput.value = pw;
        setTimeout(function() {
          var btn = document.getElementById("connect-button");
          if (btn) btn.click();
        }, 800);
      }
    }).catch(function() {});
  }
}
setRoomAudioMutedState(false);
// On page load, just try to enumerate devices without requesting permissions.
// The real getUserMedia permission request happens when the user connects (post-connect flow).
// This avoids premature permission prompts on macOS WKWebView.
refreshDevices().catch(() => {}).then(() => {
  micSelect.disabled = false;
  camSelect.disabled = false;
  applyAudioOutputCapability();
  refreshDevicesBtn.disabled = false;
});

window.addEventListener("beforeunload", () => {
  sendLeaveNotification();
});

// ── Jam Session ──

var openJamButton = document.getElementById("open-jam");
if (openJamButton) openJamButton.addEventListener("click", function() { openJamPanel(openJamButton); });

// Start Who's Online polling on page load (only while not connected)
startOnlineUsersPolling();

// Admin login UI and auto-restore — must run after the modal/badge/panel
// HTML at the end of <body> has been parsed. app.js is loaded mid-body, so
// at this point the trailing admin scaffolding may not exist yet. Defer to
// DOMContentLoaded if we're still parsing, otherwise run inline.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    setupAdminLoginUi();
    bootAdminFromStorage();
  });
} else {
  setupAdminLoginUi();
  bootAdminFromStorage();
}
