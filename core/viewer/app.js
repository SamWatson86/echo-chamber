/* State variables and DOM refs are in state.js — loaded before this file */
/* Participant cards, video elements, tiles, avatars, and diagnostics are in participants.js */
/* Connection lifecycle (connect, disconnect, switchRoom, connectToRoom) are in connect.js */

if (nameInput) {
  const savedName = echoGet(REMEMBER_NAME_KEY);
  if (savedName) nameInput.value = savedName;
}
if (passwordInput) {
  const savedPass = echoGet(REMEMBER_PASS_KEY);
  if (savedPass) passwordInput.value = savedPass;
}

// Soundboard state vars (echoGet-dependent) are in soundboard.js

// ── WebCodecs NVENC diagnostic ──
// Test if hardware video encoding is available via WebCodecs API.
(async function testHardwareEncoding() {
  try {
    if (typeof VideoEncoder === "undefined") {
      console.log("[NVENC] WebCodecs VideoEncoder not available");
      return;
    }
    const configs = [
      { codec: "avc1.640028", label: "H264-High" },
      { codec: "av01.0.08M.08", label: "AV1" },
    ];
    for (const { codec, label } of configs) {
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
      console.log(`[NVENC] ${label}: hw=${support.supported}, sw=${supportSw.supported}`);
    }
  } catch (e) {
    console.log("[NVENC] diagnostic error: " + e.message);
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

refreshDevicesBtn.addEventListener("click", async () => {
  setDeviceStatus("Refreshing devices...");
  await ensureDevicePermissions();
  await refreshDevices();
  setDeviceStatus("");
});

// Create Room button removed in favor of fixed rooms (Main, Breakout 1-3)

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
  openSettingsButton.addEventListener("click", () => {
    settingsPanel.classList.toggle("hidden");
  });
}

if (closeSettingsButton && settingsPanel) {
  closeSettingsButton.addEventListener("click", () => {
    settingsPanel.classList.add("hidden");
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
