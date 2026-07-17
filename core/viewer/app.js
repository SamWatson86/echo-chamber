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
var clubhouseShell = document.getElementById("clubhouse-shell");
var settingsScrim = document.getElementById("settings-scrim");
var settingsReturnFocus = null;
var settingsModalActive = false;

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

function syncClubhouseUtilityPresentation() {
  if (!shellLayout || !shellStage) return;
  var isV2 = document.documentElement.dataset.uiShell === "v2";
  var mode = document.documentElement.dataset.uiMode;
  var collapsed = shellLayout.classList.contains("utility-collapsed");
  var chatOpen = shellLayout.classList.contains("chat-open") && chatPanel && !chatPanel.classList.contains("hidden");
  var overlaysStage = mode === "lounge" || mode === "compact" || mode === "mini";
  shellStage.inert = !!(isV2 && overlaysStage && !collapsed);
  if (shellUtilityButton) {
    shellUtilityButton.textContent = chatOpen ? "Chat" : "People";
    shellUtilityButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
    shellUtilityButton.setAttribute(
      "aria-label",
      (collapsed ? "Show " : "Hide ") + (chatOpen ? "Chat" : "People and tools")
    );
  }
}

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
    shellLayout.classList.toggle("utility-collapsed");
    syncClubhouseUtilityPresentation();
  });
}

if (openChatButton) openChatButton.addEventListener("click", syncClubhouseUtilityPresentation);
if (closeChatButton) closeChatButton.addEventListener("click", syncClubhouseUtilityPresentation);
window.addEventListener("echo:ui-shell-change", function() {
  syncClubhouseUtilityPresentation();
  syncSettingsModalPresentation();
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
  if (event.key !== "Escape" || !shellHeader?.classList.contains("shell-overflow-open")) return;
  event.preventDefault();
  setShellOverflowOpen(false, { restoreFocus: true });
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
  setDeviceStatus("");
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
  speakerSelect.disabled = false;
  refreshDevicesBtn.disabled = false;
});

window.addEventListener("beforeunload", () => {
  sendLeaveNotification();
});

// ── Jam Session ──

var openJamButton = document.getElementById("open-jam");
if (openJamButton) openJamButton.addEventListener("click", function() { openJamPanel(); });

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
