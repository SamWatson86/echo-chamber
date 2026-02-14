const statusEl = document.getElementById("status");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const disconnectTopBtn = document.getElementById("disconnect-top");
const connectPanel = document.getElementById("connect-panel");
const screenGridEl = document.getElementById("screen-grid");
const userListEl = document.getElementById("user-list");
const audioBucketEl = document.getElementById("audio-bucket");
const micBtn = document.getElementById("toggle-mic");
const camBtn = document.getElementById("toggle-cam");
const screenBtn = document.getElementById("toggle-screen");
const micSelect = document.getElementById("mic-select");
const camSelect = document.getElementById("cam-select");
const speakerSelect = document.getElementById("speaker-select");
const refreshDevicesBtn = document.getElementById("refresh-devices");
const deviceStatusEl = document.getElementById("device-status");
const toggleRoomAudioButton = document.getElementById("toggle-room-audio");
const roomListEl = document.getElementById("room-list");
const createRoomBtn = document.getElementById("create-room");
const openSettingsButton = document.getElementById("open-settings");
const closeSettingsButton = document.getElementById("close-settings");
const settingsPanel = document.getElementById("settings-panel");
const settingsDevicePanel = document.getElementById("settings-device-panel");
const deviceActionsEl = document.querySelector(".device-actions");
const deviceActionsHome = deviceActionsEl?.parentElement || null;
const deviceStatusHome = deviceStatusEl?.parentElement || null;
const openSoundboardButton = document.getElementById("open-soundboard");
const closeSoundboardButton = document.getElementById("close-soundboard");
const soundboardCompactPanel = document.getElementById("soundboard-compact");
const soundboardCompactGrid = document.getElementById("soundboard-compact-grid");
const openSoundboardEditButton = document.getElementById("open-soundboard-edit");
const backToSoundboardButton = document.getElementById("back-to-soundboard");
const soundboardPanel = document.getElementById("soundboard");
const toggleSoundboardVolumeButton = document.getElementById("toggle-soundboard-volume");
const toggleSoundboardVolumeCompactButton = document.getElementById("toggle-soundboard-volume-compact");
const soundboardVolumePanel = document.getElementById("soundboard-volume-panel");
const soundboardVolumePanelCompact = document.getElementById("soundboard-volume-panel-compact");
const soundboardVolumeInput = document.getElementById("soundboard-volume");
const soundboardVolumeInputEdit = document.getElementById("soundboard-volume-edit");
const soundboardVolumeValue = document.getElementById("soundboard-volume-value");
const soundboardVolumeValueEdit = document.getElementById("soundboard-volume-value-edit");
const soundSearchInput = document.getElementById("sound-search");
const soundboardGrid = document.getElementById("soundboard-grid");
const soundNameInput = document.getElementById("sound-name");
const soundUploadButton = document.getElementById("sound-upload-button");
const soundCancelEditButton = document.getElementById("sound-cancel-edit");
const soundFileInput = document.getElementById("sound-file");
const soundFileLabel = document.getElementById("sound-file-label");
const soundClipVolumeInput = document.getElementById("sound-clip-volume");
const soundClipVolumeValue = document.getElementById("sound-clip-volume-value");
const soundboardIconGrid = document.getElementById("soundboard-icon-grid");
const soundboardHint = document.getElementById("soundboard-hint");
const refreshVideosButton = document.getElementById("refresh-videos");
const openCameraLobbyButton = document.getElementById("open-camera-lobby");
const closeCameraLobbyButton = document.getElementById("close-camera-lobby");
const cameraLobbyPanel = document.getElementById("camera-lobby");
const cameraLobbyGrid = document.getElementById("camera-lobby-grid");
const lobbyToggleMicButton = document.getElementById("lobby-toggle-mic");
const lobbyToggleCameraButton = document.getElementById("lobby-toggle-camera");

// Floating tooltip for soundboard icons (appended to body so it's never clipped)
const soundTooltipEl = document.createElement("div");
soundTooltipEl.id = "sound-tooltip";
document.body.appendChild(soundTooltipEl);
function showSoundTooltip(el, text) {
  const rect = el.getBoundingClientRect();
  soundTooltipEl.textContent = text;
  soundTooltipEl.classList.add("visible");
  soundTooltipEl.style.left = (rect.left + rect.width / 2) + "px";
  soundTooltipEl.style.top = (rect.top - 8) + "px";
  soundTooltipEl.style.transform = "translate(-50%, -100%)";
}
function hideSoundTooltip() {
  soundTooltipEl.classList.remove("visible");
}

// Fullscreen video helper — click video to exit, overlay hint shown on enter
function enterVideoFullscreen(videoEl) {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  // Wrap in a container so we can overlay a hint
  var wrapper = document.createElement("div");
  wrapper.className = "fullscreen-video-wrapper";
  var hint = document.createElement("div");
  hint.className = "fullscreen-hint";
  hint.textContent = "Click or press ESC to exit";
  wrapper.appendChild(hint);

  // Move video into wrapper temporarily
  var parent = videoEl.parentNode;
  var next = videoEl.nextSibling;
  wrapper.appendChild(videoEl);
  document.body.appendChild(wrapper);

  // Fade out hint after 2s
  setTimeout(function() { hint.classList.add("fade-out"); }, 2000);

  wrapper.requestFullscreen().then(function() {
    // Click anywhere on wrapper exits fullscreen
    wrapper.addEventListener("click", function() {
      if (document.fullscreenElement) document.exitFullscreen();
    });
  }).catch(function() {
    // Fullscreen denied — restore video
    parent.insertBefore(videoEl, next);
    wrapper.remove();
  });

  // When exiting fullscreen, restore video to original location
  var onFsChange = function() {
    if (!document.fullscreenElement) {
      document.removeEventListener("fullscreenchange", onFsChange);
      if (wrapper.contains(videoEl)) {
        parent.insertBefore(videoEl, next);
      }
      wrapper.remove();
    }
  };
  document.addEventListener("fullscreenchange", onFsChange);
}

// --- RNNoise Noise Cancellation ---
// Detects SIMD support for optimal WASM variant
async function detectSimdSupport() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11
    ]));
  } catch (e) { return false; }
}

// Noise cancellation applies ONLY to the microphone track — never screen share audio
async function enableNoiseCancellation() {
  if (!room || !micEnabled) return;
  var LK = getLiveKitClient();
  if (!LK) { debugLog("[noise-cancel] LiveKit SDK not loaded"); return; }
  var micPub = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
  if (!micPub || !micPub.track) return;
  if (micPub.source === LK.Track.Source.ScreenShareAudio) return;

  try {
    var mediaTrack = micPub.track.mediaStreamTrack;
    if (!mediaTrack) return;

    // Create audio context at mic's sample rate
    var sampleRate = mediaTrack.getSettings().sampleRate || 48000;
    rnnoiseCtx = new AudioContext({ sampleRate: sampleRate });

    // Register the RNNoise worklet
    await rnnoiseCtx.audioWorklet.addModule("rnnoise-processor.js");

    // Fetch the WASM binary (SIMD if supported)
    var simd = await detectSimdSupport();
    var wasmUrl = simd ? "rnnoise_simd.wasm" : "rnnoise.wasm";
    var wasmResp = await fetch(wasmUrl);
    var wasmBinary = await wasmResp.arrayBuffer();

    // Create source from mic track
    var source = rnnoiseCtx.createMediaStreamSource(new MediaStream([mediaTrack]));

    // Create the RNNoise worklet node
    rnnoiseNode = new AudioWorkletNode(rnnoiseCtx, "@sapphi-red/web-noise-suppressor/rnnoise", {
      processorOptions: { wasmBinary: wasmBinary, maxChannels: 1 }
    });

    // Wire: source → rnnoise → gate (gain) → destination
    var dest = rnnoiseCtx.createMediaStreamDestination();

    // Create noise gate: analyser monitors level, gain node mutes when below threshold
    ncGateNode = rnnoiseCtx.createGain();
    ncGateNode.gain.value = 1.0;
    ncAnalyser = rnnoiseCtx.createAnalyser();
    ncAnalyser.fftSize = 256;

    source.connect(rnnoiseNode);
    rnnoiseNode.connect(ncAnalyser);
    rnnoiseNode.connect(ncGateNode);
    ncGateNode.connect(dest);

    // Start gate monitoring loop (checks audio level every 20ms)
    startNoiseGate();

    // Save original track and swap in the processed one
    rnnoiseOriginalTrack = mediaTrack;
    var processedTrack = dest.stream.getAudioTracks()[0];

    // Replace the track in LiveKit's RTCRtpSender
    var sender = micPub.track.sender;
    if (sender) {
      await sender.replaceTrack(processedTrack);
    }

    debugLog("[noise-cancel] RNNoise enabled" + (simd ? " (SIMD)" : " (no SIMD)") + ", gate level=" + ncSuppressionLevel);
  } catch (err) {
    debugLog("[noise-cancel] Failed to enable: " + (err.message || err));
    disableNoiseCancellation();
    throw err;
  }
}

// Noise gate thresholds: [light, medium, strong]
// Light = no gate (RNNoise only), Medium = gentle gate, Strong = aggressive gate
var NC_GATE_THRESHOLDS = [0, 0.006, 0.012];

function startNoiseGate() {
  stopNoiseGate();
  if (ncSuppressionLevel === 0 || !ncAnalyser || !ncGateNode) return; // light = no gate
  var dataArray = new Float32Array(ncAnalyser.fftSize);
  ncGateInterval = setInterval(function() {
    if (!ncAnalyser || !ncGateNode) return;
    ncAnalyser.getFloatTimeDomainData(dataArray);
    // Compute RMS level
    var sum = 0;
    for (var i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    var rms = Math.sqrt(sum / dataArray.length);
    var threshold = NC_GATE_THRESHOLDS[ncSuppressionLevel] || 0.008;
    // Smooth gate: ramp gain up/down to avoid clicks
    var target = rms > threshold ? 1.0 : 0.0;
    ncGateNode.gain.setTargetAtTime(target, ncGateNode.context.currentTime, target > 0.5 ? 0.01 : 0.05);
  }, 20);
}

function stopNoiseGate() {
  if (ncGateInterval) { clearInterval(ncGateInterval); ncGateInterval = null; }
  if (ncGateNode) ncGateNode.gain.value = 1.0;
}

function updateNoiseGateLevel(level) {
  ncSuppressionLevel = level;
  echoSet("echo-nc-level", String(level));
  debugLog("[noise-cancel] Suppression level changed to " + ["Light", "Medium", "Strong"][level]);
  if (noiseCancelEnabled && ncGateNode) {
    if (level === 0) { stopNoiseGate(); ncGateNode.gain.value = 1.0; }
    else startNoiseGate();
  }
}

function disableNoiseCancellation() {
  stopNoiseGate();
  if (rnnoiseNode) {
    try { rnnoiseNode.port.postMessage("destroy"); } catch (e) {}
    rnnoiseNode.disconnect();
    rnnoiseNode = null;
  }
  ncGateNode = null;
  ncAnalyser = null;

  // Restore original track if we have one
  if (rnnoiseOriginalTrack && room) {
    var LK = getLiveKitClient();
    var micPub = LK ? room.localParticipant.getTrackPublication(LK.Track.Source.Microphone) : null;
    if (micPub && micPub.track && micPub.track.sender) {
      micPub.track.sender.replaceTrack(rnnoiseOriginalTrack).catch(function() {});
    }
    rnnoiseOriginalTrack = null;
  }

  if (rnnoiseCtx) {
    rnnoiseCtx.close().catch(function() {});
    rnnoiseCtx = null;
  }

  debugLog("[noise-cancel] RNNoise disabled");
}

function updateNoiseCancelUI() {
  var btn = document.getElementById("nc-toggle-btn");
  if (btn) {
    btn.textContent = noiseCancelEnabled ? "ON" : "OFF";
    btn.classList.toggle("is-on", noiseCancelEnabled);
  }
}

const openChatButton = document.getElementById("open-chat");
const closeChatButton = document.getElementById("close-chat");
const chatPanel = document.getElementById("chat-panel");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const chatUploadBtn = document.getElementById("chat-upload-btn");
const chatEmojiBtn = document.getElementById("chat-emoji-btn");
const chatFileInput = document.getElementById("chat-file-input");
const chatEmojiPicker = document.getElementById("chat-emoji-picker");

const openThemeButton = document.getElementById("open-theme");
const closeThemeButton = document.getElementById("close-theme");
const themePanel = document.getElementById("theme-panel");
const THEME_STORAGE_KEY = "echo-core-theme";
const uiOpacitySlider = document.getElementById("ui-opacity-slider");
const uiOpacityValue = document.getElementById("ui-opacity-value");
const UI_OPACITY_KEY = "echo-core-ui-opacity";

const controlUrlInput = document.getElementById("control-url");
const sfuUrlInput = document.getElementById("sfu-url");
const roomInput = document.getElementById("room");
const identityInput = document.getElementById("identity");
const nameInput = document.getElementById("name");
const passwordInput = document.getElementById("admin-password");
const REMEMBER_NAME_KEY = "echo-core-remember-name";
const REMEMBER_PASS_KEY = "echo-core-remember-pass";

let room = null;
let micEnabled = false;
let camEnabled = false;
let screenEnabled = false;
let noiseCancelEnabled = echoGet("echo-noise-cancel") === "true";
let ncSuppressionLevel = parseInt(echoGet("echo-nc-level") || "1", 10); // 0=light, 1=medium, 2=strong
let rnnoiseNode = null;
let rnnoiseCtx = null;
let rnnoiseOriginalTrack = null;
let ncGateNode = null;
let ncAnalyser = null;
let ncGateInterval = null;
const screenTileBySid = new Map();
const screenTrackMeta = new Map();
let screenWatchdogTimer = null;
const audioElBySid = new Map();
const participantCards = new Map();
const participantState = new Map();
let activeSpeakerIds = new Set();
let selectedMicId = "";
let selectedCamId = "";
let selectedSpeakerId = "";
let adminToken = "";
let _latestScreenStats = null;
let currentRoomName = "main";
let currentAccessToken = "";
const IDENTITY_SUFFIX_KEY = "echo-core-identity-suffix";
let audioMonitorTimer = null;
let roomAudioMuted = false;
let localScreenTrackSid = "";
let screenRestarting = false;
let _cameraReducedForScreenShare = false;
let _bwLimitedCount = 0; // consecutive stats ticks showing bandwidth limitation
const screenReshareRequests = new Map();
const ENABLE_SCREEN_WATCHDOG = true;
let lastActiveSpeakerEvent = 0;
const screenRecoveryAttempts = new Map();
const AUDIO_MONITOR_INTERVAL = 80;
let audioUnlocked = false;
const screenResubscribeIntent = new Map();
let mediaReconcileTimer = null;
let reconcilePending = false;
const reconcileTimers = new Set();
const cameraRecoveryAttempts = new Map();
let lastSubscriptionReset = 0;
const cameraVideoBySid = new Map();
const lastTrackHandled = new Map();
const cameraClearTimers = new Map();
const screenTileByIdentity = new Map();
const hiddenScreens = new Set();
const chatHistory = [];
let chatDataChannel = null;
const CHAT_MESSAGE_TYPE = "chat-message";
const CHAT_FILE_TYPE = "chat-file";
const FIXED_ROOMS = ["main", "breakout-1", "breakout-2", "breakout-3"];
const avatarUrls = new Map(); // identity_base -> avatar URL
const ROOM_DISPLAY_NAMES = { "main": "Main", "breakout-1": "Breakout 1", "breakout-2": "Breakout 2", "breakout-3": "Breakout 3" };
let roomStatusTimer = null;
let heartbeatTimer = null;
let previousRoomParticipants = {};
let previousDetectedRoom = null;
let unreadChatCount = 0;
const chatBadge = document.getElementById("chat-badge");
let onlineUsersTimer = null;
const onlineUsersEl = document.getElementById("online-users");

// ─── Who's Online polling (pre-connect) ───
function getControlUrl() {
  const val = controlUrlInput?.value?.trim();
  if (val) return val;
  return `https://${window.location.host}`;
}

async function fetchOnlineUsers(controlUrl) {
  try {
    const resp = await fetch(`${controlUrl}/api/online`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

function renderOnlineUsers(users) {
  if (!onlineUsersEl) return;
  if (!users || users.length === 0) {
    onlineUsersEl.innerHTML = '<div class="online-users-empty">No one is currently online</div>';
    return;
  }
  const pills = users.map(u => {
    const name = u.name || "Unknown";
    const room = u.room || "";
    const title = room ? `In room: ${room}` : "";
    return `<span class="online-user-pill" title="${title}">${name}</span>`;
  }).join("");
  onlineUsersEl.innerHTML =
    `<div class="online-users-header">Currently Online (${users.length})</div>` +
    `<div class="online-users-list">${pills}</div>`;
}

function startOnlineUsersPolling() {
  if (onlineUsersTimer) return;
  const poll = async () => {
    const users = await fetchOnlineUsers(getControlUrl());
    renderOnlineUsers(users);
  };
  poll(); // immediate first fetch
  onlineUsersTimer = setInterval(poll, 10000);
}

function stopOnlineUsersPolling() {
  if (onlineUsersTimer) {
    clearInterval(onlineUsersTimer);
    onlineUsersTimer = null;
  }
  if (onlineUsersEl) onlineUsersEl.innerHTML = "";
}

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage errors (private mode / blocked storage)
  }
}

// ─── Persistent Settings (origin-independent) ───
// In native client, settings are stored in a JSON file via Tauri IPC.
// In browser, falls back to localStorage. echoGet/echoSet are synchronous
// after the initial async loadAllSettings() call at startup.
var _settingsCache = {};
var _settingsLoaded = false;
var _settingsSaveTimer = null;

var _SETTINGS_KEYS = [
  "echo-core-theme", "echo-core-ui-opacity",
  "echo-core-soundboard-volume", "echo-core-soundboard-clip-volume",
  "echo-soundboard-favorites", "echo-soundboard-order",
  "echo-noise-cancel", "echo-nc-level",
  "echo-device-mic", "echo-device-cam", "echo-device-speaker",
  "echo-core-remember-name", "echo-core-remember-pass",
  "echo-core-identity-suffix"
];

async function loadAllSettings() {
  if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
    try {
      var json = await tauriInvoke("load_settings");
      _settingsCache = JSON.parse(json || "{}");
      debugLog("[settings] loaded " + Object.keys(_settingsCache).length + " settings from file");
    } catch (e) {
      debugLog("[settings] load_settings failed: " + e + " — using defaults");
      _settingsCache = {};
    }
  }
  // If cache is empty (first run or browser mode), try localStorage migration
  if (Object.keys(_settingsCache).length === 0) {
    var migrated = 0;
    for (var i = 0; i < _SETTINGS_KEYS.length; i++) {
      try {
        var v = localStorage.getItem(_SETTINGS_KEYS[i]);
        if (v !== null) { _settingsCache[_SETTINGS_KEYS[i]] = v; migrated++; }
      } catch (e) {}
    }
    // Also migrate dynamic avatar keys
    try {
      for (var j = 0; j < localStorage.length; j++) {
        var k = localStorage.key(j);
        if (k && k.startsWith("echo-avatar-")) {
          _settingsCache[k] = localStorage.getItem(k);
          migrated++;
        }
      }
    } catch (e) {}
    if (migrated > 0) {
      debugLog("[settings] migrated " + migrated + " settings from localStorage");
      _persistSettings();
    }
  }
  _settingsLoaded = true;
}

function echoGet(key) {
  // Before _settingsCache is assigned (var hoisting), fall back to localStorage
  if (_settingsCache) {
    var v = _settingsCache[key];
    if (v !== undefined) return v;
  }
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function echoSet(key, value) {
  _settingsCache[key] = String(value);
  // Also write to localStorage as fallback
  try { localStorage.setItem(key, String(value)); } catch (e) {}
  // Debounced persist to file (batch rapid writes like volume slider)
  _debouncedPersist();
}

function _debouncedPersist() {
  if (!window.__ECHO_NATIVE__ || !hasTauriIPC()) return;
  // Don't persist until settings have been loaded from file — prevents
  // synchronous init code from overwriting the saved file with defaults
  if (!_settingsLoaded) return;
  if (_settingsSaveTimer) clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(_persistSettings, 300);
}

function _persistSettings() {
  if (!window.__ECHO_NATIVE__ || !hasTauriIPC()) return;
  tauriInvoke("save_settings", { settings: JSON.stringify(_settingsCache) }).catch(function(e) {
    debugLog("[settings] save failed: " + e);
  });
}

function _reapplySettingsAfterLoad() {
  // Theme
  var savedTheme = echoGet(THEME_STORAGE_KEY);
  if (savedTheme && savedTheme !== document.body.dataset.theme) {
    debugLog("[settings] reapplying theme: " + savedTheme);
    applyTheme(savedTheme, true);
  }
  // UI opacity
  var savedOpacity = echoGet(UI_OPACITY_KEY);
  if (savedOpacity) applyUiOpacity(parseInt(savedOpacity, 10));
  // Name + password in lobby
  var savedName = echoGet(REMEMBER_NAME_KEY);
  if (savedName && nameInput) nameInput.value = savedName;
  var savedPass = echoGet(REMEMBER_PASS_KEY);
  if (savedPass && passwordInput) passwordInput.value = savedPass;
}

// Fire settings load at startup — async, re-applies settings when loaded
var _settingsReadyPromise = loadAllSettings().then(function() {
  debugLog("[settings] ready (" + Object.keys(_settingsCache).length + " keys)");
  // Re-apply settings that were initialized with defaults before the file loaded
  _reapplySettingsAfterLoad();
}).catch(function(e) {
  debugLog("[settings] loadAllSettings error: " + e);
});

if (nameInput) {
  const savedName = echoGet(REMEMBER_NAME_KEY);
  if (savedName) nameInput.value = savedName;
}
if (passwordInput) {
  const savedPass = echoGet(REMEMBER_PASS_KEY);
  if (savedPass) passwordInput.value = savedPass;
}

const soundboardSounds = new Map();
let soundboardSelectedIcon = null;
let soundboardLoadedRoomId = null;
let soundboardEditingId = null;
let soundboardUserVolume = Number(echoGet("echo-core-soundboard-volume") ?? "100");
if (!Number.isFinite(soundboardUserVolume)) soundboardUserVolume = 100;
soundboardUserVolume = Math.min(100, Math.max(0, soundboardUserVolume));
let soundboardClipVolume = Number(echoGet("echo-core-soundboard-clip-volume") ?? "100");
if (!Number.isFinite(soundboardClipVolume)) soundboardClipVolume = 100;
soundboardClipVolume = Math.min(200, Math.max(0, soundboardClipVolume));
let soundboardContext = null;
let soundboardMasterGain = null;
let soundboardCurrentSource = null;
const soundboardBufferCache = new Map();
let soundboardFavorites = (() => {
  try { return JSON.parse(echoGet("echo-soundboard-favorites")) || []; } catch { return []; }
})();
let soundboardCustomOrder = (() => {
  try { return JSON.parse(echoGet("echo-soundboard-order")) || []; } catch { return []; }
})();
let soundboardDragId = null;
const debugPanel = document.getElementById("debug-panel");
const debugToggleBtn = document.getElementById("debug-toggle");
const debugCloseBtn = document.getElementById("debug-close");
const debugClearBtn = document.getElementById("debug-clear");
const debugCopyBtn = document.getElementById("debug-copy");
const debugLogEl = document.getElementById("debug-log");
const debugLines = [];
const DEBUG_LIMIT = 180;

function debugLog(message) {
  if (!message) return;
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${message}`;
  debugLines.push(line);
  while (debugLines.length > DEBUG_LIMIT) debugLines.shift();
  if (debugLogEl) {
    debugLogEl.textContent = debugLines.join("\n");
  }
}

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

function ensureIdentitySuffix() {
  // Check persistent storage first so identity survives app restarts
  const persisted = echoGet(IDENTITY_SUFFIX_KEY);
  if (persisted) return persisted;
  // Fall back to sessionStorage (legacy)
  const session = sessionStorage.getItem(IDENTITY_SUFFIX_KEY);
  if (session) { echoSet(IDENTITY_SUFFIX_KEY, session); return session; }
  const fresh = `${Math.floor(Math.random() * 9000 + 1000)}`;
  echoSet(IDENTITY_SUFFIX_KEY, fresh);
  sessionStorage.setItem(IDENTITY_SUFFIX_KEY, fresh);
  return fresh;
}

function slugifyIdentity(text) {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildIdentity(name) {
  const base = slugifyIdentity(name) || "viewer";
  return `${base}-${ensureIdentitySuffix()}`;
}

function getParticipantPublications(participant) {
  if (!participant) return [];
  if (typeof participant.getTrackPublications === "function") {
    return participant.getTrackPublications();
  }
  if (participant.trackPublications?.values) {
    return Array.from(participant.trackPublications.values());
  }
  if (participant.tracks?.values) {
    return Array.from(participant.tracks.values());
  }
  return Array.from(participant.tracks || []);
}

function wasRecentlyHandled(key, windowMs = 200) {
  if (!key) return false;
  const last = lastTrackHandled.get(key) || 0;
  const timeSinceLast = performance.now() - last;
  if (timeSinceLast < windowMs) {
    debugLog(`track recently handled: ${key} (${Math.floor(timeSinceLast)}ms ago)`);
  }
  return timeSinceLast < windowMs;
}

function markHandled(key) {
  if (!key) return;
  lastTrackHandled.set(key, performance.now());
}

function hookPublication(publication, participant) {
  if (!publication || !participant) return;
  if (!publication._echoHooked) {
    publication._echoHooked = true;
    if (publication.setSubscribed) {
      publication.setSubscribed(true);
    }
    const LK = getLiveKitClient();
    const subscribedEvt = LK?.TrackEvent?.Subscribed || "subscribed";
    const unsubscribedEvt = LK?.TrackEvent?.Unsubscribed || "unsubscribed";
    if (publication.on) {
      publication.on(subscribedEvt, (track) => {
        if (track) handleTrackSubscribed(track, publication, participant);
      });
      publication.on(unsubscribedEvt, (track) => {
        if (track) handleTrackUnsubscribed(track, publication, participant);
      });
    }
  }
  // Always try to handle existing tracks, even if recently handled (for late joins)
  if (publication.track && publication.isSubscribed) {
    const trackSid = getTrackSid(publication, publication.track, `${participant.identity}-${publication.source || publication.kind}`);
    const LK = getLiveKitClient();
    const source = publication.source || publication.track?.source;
    // Check if track is actually being displayed
    let isDisplayed = false;
    if (source === LK?.Track?.Source?.ScreenShare) {
      isDisplayed = trackSid && screenTileBySid.has(trackSid);
    } else if (source === LK?.Track?.Source?.Camera) {
      isDisplayed = trackSid && cameraVideoBySid.has(trackSid);
    } else if (publication.track.kind === "audio") {
      isDisplayed = trackSid && audioElBySid.has(trackSid);
    }
    // Only handle if not already displayed
    if (!isDisplayed) {
      handleTrackSubscribed(publication.track, publication, participant);
    }
  }
  const src = publication.source || publication.track?.source || publication.kind;
  debugLog(`pub hook ${participant.identity} src=${src} subscribed=${publication.isSubscribed ?? "?"} hasTrack=${!!publication.track}`);
}

function setDeviceStatus(text, isError = false) {
  deviceStatusEl.textContent = text || "";
  deviceStatusEl.style.color = isError ? "#f87171" : "";
}

function markResubscribeIntent(trackSid) {
  if (!trackSid) return;
  const now = performance.now();
  screenResubscribeIntent.set(trackSid, now);
  setTimeout(() => {
    const ts = screenResubscribeIntent.get(trackSid);
    if (ts && performance.now() - ts > 5000) {
      screenResubscribeIntent.delete(trackSid);
    }
  }, 6000);
}

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.02);
    ctx.resume?.().catch(() => {});
    setTimeout(() => {
      ctx.close?.().catch(() => {});
    }, 800);
  } catch {}
}

function getScreenSharePublishOptions() {
  return {
    videoCodec: "h264",
    simulcast: false,
    // Start at 4 Mbps — lets congestion control ramp up gradually instead of
    // bursting 10 Mbps which overwhelms Hyper-V vSwitch / Docker network adapters.
    // WebRTC will increase bitrate if the path can handle it.
    screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 60 },
    degradationPreference: "balanced",
  };
}

// Track refs for manual screen share (so we can unpublish on stop)
let _screenShareVideoTrack = null;
let _screenShareAudioTrack = null;
let _screenShareStatsInterval = null;

// Native per-process audio capture (Tauri client only)
var _nativeAudioCtx = null;        // AudioContext for worklet
var _nativeAudioWorklet = null;     // AudioWorkletNode
var _nativeAudioDest = null;        // MediaStreamDestination
var _nativeAudioTrack = null;       // Published LiveKit track
var _nativeAudioUnlisten = null;    // Tauri event unlisten function
var _nativeAudioActive = false;
var _echoServerUrl = ""; // Server URL for API calls (set by Tauri get_control_url on native client)

// Tauri IPC — viewer loaded locally so window.__TAURI__ is available natively
function tauriInvoke(cmd, args) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  return Promise.reject(new Error("Tauri IPC not available"));
}
function tauriListen(eventName, callback) {
  if (window.__TAURI__ && window.__TAURI__.event) {
    return window.__TAURI__.event.listen(eventName, callback);
  }
  return Promise.reject(new Error("Tauri event system not available"));
}
function hasTauriIPC() {
  return !!(window.__TAURI__ && window.__TAURI__.core);
}
function isAdminMode() {
  return !!window.__ECHO_ADMIN__;
}

// Build absolute URL for API calls. Native client uses the configured server URL
// since the page is loaded locally (tauri://). Browser uses relative paths.
function apiUrl(path) {
  if (window.__ECHO_NATIVE__ && _echoServerUrl) {
    return _echoServerUrl + path;
  }
  return path;
}

async function startScreenShareManual() {
  const LK = getLiveKitClient();

  // Call getDisplayMedia ourselves — no fixed width/height so ultrawides
  // capture at native aspect ratio instead of being forced to 16:9
  var isNativeClient = !!window.__ECHO_NATIVE__;
  var gdmConstraints = {
    video: {
      width: { max: 3840 },
      height: { max: 2160 },
      frameRate: { ideal: 60 },
    },
    surfaceSwitching: "exclude",
    selfBrowserSurface: "exclude",
    preferCurrentTab: false,
  };
  // Always request audio from getDisplayMedia — works as baseline for all clients
  // Native client will additionally try WASAPI per-process capture for better quality
  gdmConstraints.audio = {
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false,
  };
  gdmConstraints.systemAudio = "include";
  const stream = await navigator.mediaDevices.getDisplayMedia(gdmConstraints);

  // Log the actual capture frame rate
  const videoMst = stream.getVideoTracks()[0];
  if (videoMst) {
    const settings = videoMst.getSettings();
    debugLog("Screen capture actual FPS: " + (settings.frameRate || "unknown") +
      ", resolution: " + settings.width + "x" + settings.height);

    // Set content hint for smooth motion (gaming/video)
    videoMst.contentHint = "motion";

    // Bypass Chrome's 30fps screen capture cap by rendering through a canvas.
    // Chrome caps getDisplayMedia-derived tracks at 30fps in WebRTC encoding,
    // regardless of codec or encoding params. Canvas captureStream creates a
    // completely new pixel source with no screen-capture tag.
    let publishMst = videoMst;
    try {
      const _offVideo = document.createElement("video");
      _offVideo.srcObject = new MediaStream([videoMst]);
      _offVideo.muted = true;
      _offVideo.playsInline = true;
      await _offVideo.play();

      // Wait for actual video dimensions (first frame decode) — critical for ultrawides
      // videoWidth/Height may be 0 immediately after play() if frame hasn't decoded yet
      if (!_offVideo.videoWidth || !_offVideo.videoHeight) {
        await new Promise((resolve) => {
          const onResize = () => { _offVideo.removeEventListener("resize", onResize); resolve(); };
          _offVideo.addEventListener("resize", onResize);
          // Timeout fallback in case resize never fires
          setTimeout(resolve, 500);
        });
      }
      let cw = _offVideo.videoWidth || settings.width || 1920;
      let ch = _offVideo.videoHeight || settings.height || 1080;
      debugLog("Canvas pipeline: source dimensions " + cw + "x" + ch + " (ratio " + (cw/ch).toFixed(2) + ")");
      const _offCanvas = document.createElement("canvas");
      _offCanvas.width = cw;
      _offCanvas.height = ch;
      const _ctx = _offCanvas.getContext("2d");

      // captureStream(0) = manual frame pushing
      const canvasStream = _offCanvas.captureStream(0);
      publishMst = canvasStream.getVideoTracks()[0];
      publishMst.contentHint = "motion";

      // Push frames at 60fps using setTimeout (NOT requestAnimationFrame).
      // rAF gets throttled when the Tauri window is behind the shared screen.
      // setTimeout is not throttled for occluded (non-backgrounded) windows.
      const TARGET_FPS = 60;
      const FRAME_INTERVAL = 1000 / TARGET_FPS;
      let _frameCount = 0;
      let _fpsStart = performance.now();
      function _pushFrame() {
        if (videoMst.readyState === "ended") return;
        // Resize canvas if source dimensions changed (e.g. window resize during capture)
        const vw = _offVideo.videoWidth, vh = _offVideo.videoHeight;
        if (vw && vh && (vw !== _offCanvas.width || vh !== _offCanvas.height)) {
          _offCanvas.width = vw;
          _offCanvas.height = vh;
          debugLog("Canvas pipeline: resized to " + vw + "x" + vh + " (ratio " + (vw/vh).toFixed(2) + ")");
        }
        // Draw at native dimensions — never stretch
        _ctx.drawImage(_offVideo, 0, 0, _offCanvas.width, _offCanvas.height);
        publishMst.requestFrame();
        _frameCount++;
        // Log actual canvas FPS every 5 seconds
        const now = performance.now();
        const elapsed = now - _fpsStart;
        if (elapsed >= 5000) {
          debugLog("Canvas pipeline: " + Math.round(_frameCount / (elapsed / 1000)) + " fps pushed @ " + _offCanvas.width + "x" + _offCanvas.height);
          _frameCount = 0;
          _fpsStart = now;
        }
        window._canvasFrameLoop = setTimeout(_pushFrame, FRAME_INTERVAL);
      }
      window._canvasFrameLoop = setTimeout(_pushFrame, FRAME_INTERVAL);
      window._canvasOffVideo = _offVideo;
      debugLog("Screen capture routed through canvas pipeline (bypasses 30fps cap)");
    } catch (e) {
      debugLog("Canvas pipeline failed, using raw track: " + e.message);
    }

    // Ghost subscriber REMOVED — was causing DTLS timeouts and encoder death.
    // SDP bandwidth munging (b=AS:8000 + b=TIAS:8000000) now handles BWE priming.

    // Create LiveKit LocalVideoTrack and publish
    _screenShareVideoTrack = new LK.LocalVideoTrack(publishMst, undefined, false);
    await room.localParticipant.publishTrack(_screenShareVideoTrack, {
      source: LK.Track.Source.ScreenShare,
      ...getScreenSharePublishOptions(),
    });

    // Set initial sender parameters — prioritize framerate over resolution.
    // Do NOT lock bitrate — let congestion control adapt per-viewer.
    // High bandwidth viewers get full quality, low bandwidth viewers get lower resolution but smooth FPS.
    const sender = _screenShareVideoTrack?.sender;
    if (sender) {
      const params = sender.getParameters();
      params.degradationPreference = "maintain-framerate";
      if (params.encodings) {
        for (const enc of params.encodings) {
          enc.maxFramerate = 60;
          enc.priority = "high";
          enc.networkPriority = "high";
        }
      }
      await sender.setParameters(params);
      const vp = sender.getParameters();
      const vEnc = vp.encodings?.[0];
      debugLog("Screen share params: fps=" + vEnc?.maxFramerate + " bps=" + vEnc?.maxBitrate +
        " scale=" + vEnc?.scaleResolutionDownBy + " degPref=" + vp.degradationPreference);

      // Diagnostic: dump actual SDP bandwidth after 3s to see if munging worked
      setTimeout(() => {
        try {
          const pc = room.engine?.pcManager?.publisher?.pc;
          if (pc) {
            const ldBas = pc.localDescription?.sdp?.match(/b=(AS|TIAS):\d+/g) || ["NONE"];
            const rdBas = pc.remoteDescription?.sdp?.match(/b=(AS|TIAS):\d+/g) || ["NONE"];
            debugLog("SDP-CHECK local: " + ldBas.join(", ") + " | remote: " + rdBas.join(", "));
            // Also check if x-google params exist
            const xg = pc.localDescription?.sdp?.match(/x-google-start-bitrate=\d+/g) || ["NONE"];
            debugLog("SDP-CHECK x-google: " + xg.join(", "));
          } else {
            debugLog("SDP-CHECK: cannot access PeerConnection (engine.pcManager.publisher.pc)");
          }
        } catch (e) { debugLog("SDP-CHECK error: " + e.message); }
      }, 3000);
    }

    // Monitor encoding stats every 2s
    if (_screenShareStatsInterval) clearInterval(_screenShareStatsInterval);
    let _lastBytesSent = 0;
    let _lastStatsTime = Date.now();
    _screenShareStatsInterval = setInterval(async () => {
      try {
        const sender = _screenShareVideoTrack?.sender;
        if (!sender) return;

        // Check if capture track is still alive
        const captureTrack = sender.track;
        if (captureTrack && captureTrack.readyState !== "live") {
          debugLog("Screen share: CAPTURE TRACK DEAD: " + captureTrack.readyState);
        }

        // Get BWE + ICE candidate info from sender stats
        let bwe = "?";
        let iceInfo = "";
        let lType = "?", rType = "?";
        const stats = await sender.getStats();
        const candidateMap = new Map();
        stats.forEach((report) => {
          if (report.type === "local-candidate" || report.type === "remote-candidate") {
            candidateMap.set(report.id, report);
          }
        });
        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded") {
            bwe = Math.round((report.availableOutgoingBitrate || 0) / 1000);
            const local = candidateMap.get(report.localCandidateId);
            const remote = candidateMap.get(report.remoteCandidateId);
            lType = local?.candidateType || "?";
            rType = remote?.candidateType || "?";
            const lAddr = local ? `${local.address}:${local.port}` : "?";
            const rAddr = remote ? `${remote.address}:${remote.port}` : "?";
            iceInfo = `ice=${lType}->${rType} ${lAddr}->${rAddr}`;
          }
        });

        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "video") {
            const fps = report.framesPerSecond || 0;
            const w = report.frameWidth || 0;
            const h = report.frameHeight || 0;
            const now = Date.now();
            const elapsed = (now - _lastStatsTime) / 1000;
            const bytesDelta = report.bytesSent - _lastBytesSent;
            const kbps = elapsed > 0 ? Math.round((bytesDelta * 8) / elapsed / 1000) : 0;
            _lastBytesSent = report.bytesSent;
            _lastStatsTime = now;
            const codec = report.encoderImplementation || "unknown";
            const limit = report.qualityLimitationReason || "none";
            debugLog(`Screen: ${fps}fps ${w}x${h} ${kbps}kbps bwe=${bwe}kbps codec=${codec} limit=${limit} ${iceInfo}`);

            _latestScreenStats = {
              screen_fps: fps, screen_width: w, screen_height: h,
              screen_bitrate_kbps: kbps,
              bwe_kbps: typeof bwe === "number" ? bwe : null,
              quality_limitation: limit, encoder: codec,
              ice_local_type: lType !== "?" ? lType : null,
              ice_remote_type: rType !== "?" ? rType : null,
            };

            // Report stats to admin dashboard
            if (adminToken && _echoServerUrl) {
              fetch(apiUrl("/admin/api/stats"), {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
                body: JSON.stringify({
                  identity: room?.localParticipant?.identity || "",
                  name: room?.localParticipant?.name || "",
                  room: currentRoomName || "",
                  screen_fps: fps, screen_width: w, screen_height: h,
                  screen_bitrate_kbps: kbps,
                  bwe_kbps: typeof bwe === "number" ? bwe : null,
                  quality_limitation: limit, encoder: codec,
                  ice_local_type: lType !== "?" ? lType : null,
                  ice_remote_type: rType !== "?" ? rType : null,
                }),
              }).catch(() => {});
            }

            // Adaptive camera quality: reduce camera when bandwidth-constrained during screen share
            if (limit === "bandwidth" || fps === 0) {
              _bwLimitedCount++;
            } else {
              _bwLimitedCount = Math.max(0, _bwLimitedCount - 1);
            }
            // Reduce camera after 3 consecutive bandwidth-limited ticks (~6 seconds)
            if (_bwLimitedCount >= 3 && camEnabled && !_cameraReducedForScreenShare) {
              _cameraReducedForScreenShare = true;
              debugLog("Adaptive: reducing camera to 360p/15fps to free bandwidth for screen share");
              reduceCameraForScreenShare();
            }
            // Restore camera after 5 consecutive non-limited ticks (~10 seconds of good bandwidth)
            if (_bwLimitedCount === 0 && _cameraReducedForScreenShare) {
              _cameraReducedForScreenShare = false;
              debugLog("Adaptive: restoring camera to full quality (bandwidth recovered)");
              restoreCameraQuality();
            }
          }
        });
      } catch {}
    }, 2000);

    // Handle browser "Stop sharing" button
    videoMst.addEventListener("ended", () => {
      debugLog("Screen share ended by browser stop button");
      stopScreenShareManual().catch(() => {});
      screenEnabled = false;
      renderPublishButtons();
    });
  }

  // Publish audio track if available
  const audioTracks = stream.getAudioTracks();
  debugLog("Screen share audio tracks: " + audioTracks.length);
  const audioMst = audioTracks[0];
  if (audioMst) {
    debugLog("Screen share audio track: label=" + audioMst.label + " enabled=" + audioMst.enabled + " muted=" + audioMst.muted);
    _screenShareAudioTrack = new LK.LocalAudioTrack(audioMst, undefined, false);
    await room.localParticipant.publishTrack(_screenShareAudioTrack, {
      source: LK.Track.Source.ScreenShareAudio,
      dtx: false,        // DTX kills non-voice audio (games, music) — must be off
      red: false,         // No redundant encoding needed for continuous audio
      audioBitrate: 128000, // 128kbps for high quality screen audio
    });
    debugLog("Screen share audio published via LiveKit");
  } else {
    debugLog("No screen share audio track available (user may not have checked 'Share audio' or sharing a window)");
  }

  // In native client, auto-detect and capture per-process audio via WASAPI
  if (isNativeClient && hasTauriIPC()) {
    var shareTrackLabel = videoMst ? videoMst.label : "";
    autoDetectNativeAudio(shareTrackLabel).catch(function(err) {
      debugLog("[native-audio] autoDetect error: " + err);
    });
  }
}

async function stopScreenShareManual() {
  // Stop native per-process audio capture if active
  await stopNativeAudioCapture();
  // Clean up canvas pipeline
  if (window._canvasFrameLoop) { clearTimeout(window._canvasFrameLoop); window._canvasFrameLoop = null; }
  if (window._canvasOffVideo) { window._canvasOffVideo.pause(); window._canvasOffVideo.srcObject = null; window._canvasOffVideo = null; }
  // Ghost subscriber removed (was causing DTLS timeouts)
  if (window._ghostSubscriber) {
    try { window._ghostSubscriber.disconnect(); } catch {}
    window._ghostSubscriber = null;
  }
  if (_screenShareStatsInterval) {
    clearInterval(_screenShareStatsInterval);
    _screenShareStatsInterval = null;
  }
  // Restore camera quality if it was reduced for screen share
  if (_cameraReducedForScreenShare) {
    _cameraReducedForScreenShare = false;
    _bwLimitedCount = 0;
    restoreCameraQuality();
    debugLog("Adaptive: camera quality restored (screen share stopped)");
  }
  try {
    if (_screenShareVideoTrack) {
      await room.localParticipant.unpublishTrack(_screenShareVideoTrack, true);
      _screenShareVideoTrack.mediaStreamTrack?.stop();
      _screenShareVideoTrack = null;
    }
    if (_screenShareAudioTrack) {
      await room.localParticipant.unpublishTrack(_screenShareAudioTrack, true);
      _screenShareAudioTrack.mediaStreamTrack?.stop();
      _screenShareAudioTrack = null;
    }
  } catch (e) {
    debugLog("stopScreenShareManual error: " + e.message);
  }
  // Native audio capture stopped in stopNativeAudioCapture() above
}

// ---------- Native per-process audio capture (Tauri client only) ----------

var _nativeAudioWorkletCode = [
  "class NativeAudioProcessor extends AudioWorkletProcessor {",
  "  constructor() {",
  "    super();",
  "    this.buf = new Float32Array(96000);", // ~1s at 48kHz stereo
  "    this.wr = 0; this.rd = 0; this.len = 96000;",
  "    this.port.onmessage = (e) => {",
  "      var samples = e.data;",
  "      for (var i = 0; i < samples.length; i++) {",
  "        this.buf[this.wr] = samples[i];",
  "        this.wr = (this.wr + 1) % this.len;",
  "      }",
  "    };",
  "  }",
  "  process(inputs, outputs) {",
  "    var out = outputs[0];",
  "    var ch = out.length;",
  "    for (var i = 0; i < out[0].length; i++) {",
  "      for (var c = 0; c < ch; c++) {",
  "        if (this.rd !== this.wr) {",
  "          out[c][i] = this.buf[this.rd];",
  "          this.rd = (this.rd + 1) % this.len;",
  "        } else { out[c][i] = 0; }",
  "      }",
  "    }",
  "    return true;",
  "  }",
  "}",
  "registerProcessor('native-audio-proc', NativeAudioProcessor);",
].join("\n");

async function autoDetectNativeAudio(trackLabel) {
  if (!hasTauriIPC()) {
    debugLog("[native-audio] No Tauri IPC — skipping auto-detect");
    return;
  }
  try {
    var windows = await tauriInvoke("list_capturable_windows");
    debugLog("[native-audio] auto-detect: track label='" + trackLabel + "', " + windows.length + " capturable windows");

    // Try to match the screen share track label against windows
    var matched = null;
    var trackLower = (trackLabel || "").toLowerCase();

    // Strategy 1: Match by HWND from track label "window:HWND:monitor"
    var hwndMatch = trackLabel.match(/^window:(\d+):/);
    if (hwndMatch) {
      var targetHwnd = parseInt(hwndMatch[1], 10);
      debugLog("[native-audio] track label contains HWND: " + targetHwnd);
      for (var i = 0; i < windows.length; i++) {
        if (windows[i].hwnd === targetHwnd) {
          matched = windows[i];
          debugLog("[native-audio] matched by HWND: '" + matched.title + "' pid=" + matched.pid);
          break;
        }
      }
    }

    // Strategy 2: Track label contains window title or vice versa
    if (!matched) {
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        var titleLower = w.title.toLowerCase();
        if (titleLower.indexOf("echo chamber") !== -1) continue;
        if (trackLower.indexOf(titleLower) !== -1 || titleLower.indexOf(trackLower) !== -1) {
          matched = w;
          debugLog("[native-audio] matched by title: '" + w.title + "' pid=" + w.pid);
          break;
        }
      }
    }

    // Strategy 3: Partial word match
    if (!matched && trackLower.length > 3) {
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        var titleLower = w.title.toLowerCase();
        if (titleLower.indexOf("echo chamber") !== -1) continue;
        var words = trackLower.split(/[\s\-\_\.\|]+/).filter(function(word) { return word.length >= 3; });
        for (var j = 0; j < words.length; j++) {
          if (titleLower.indexOf(words[j]) !== -1) {
            matched = w;
            debugLog("[native-audio] matched by word '" + words[j] + "': '" + w.title + "' pid=" + w.pid);
            break;
          }
        }
        if (matched) break;
      }
    }

    // Strategy 4: Match by exe name from track label
    // Chromium/Edge track labels for window shares often contain the process/exe name
    if (!matched && trackLower.length > 2) {
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (!w.exe_name) continue;
        var exeLower = w.exe_name.toLowerCase().replace(/\.exe$/, "");
        if (exeLower.length < 3) continue;
        if (w.title.toLowerCase().indexOf("echo chamber") !== -1) continue;
        if (trackLower.indexOf(exeLower) !== -1 || exeLower.indexOf(trackLower) !== -1) {
          matched = w;
          debugLog("[native-audio] matched by exe name '" + w.exe_name + "': '" + w.title + "' pid=" + w.pid);
          break;
        }
      }
    }

    if (matched) {
      debugLog("[native-audio] auto-starting capture for '" + matched.title + "' (pid " + matched.pid + ")");
      try {
        await startNativeAudioCapture(matched.pid);
        debugLog("[native-audio] auto-capture started successfully");
        // WASAPI per-process audio is now active — remove the system-wide audio
        // from getDisplayMedia to prevent echo (it captures ALL system audio including voices)
        if (_screenShareAudioTrack) {
          debugLog("[native-audio] replacing system audio with per-process audio");
          await room.localParticipant.unpublishTrack(_screenShareAudioTrack, true);
          _screenShareAudioTrack.mediaStreamTrack?.stop();
          _screenShareAudioTrack = null;
        }
      } catch (err) {
        var errStr = String(err);
        debugLog("[native-audio] auto-capture failed: " + errStr);
        if (errStr.indexOf("build") !== -1 || errStr.indexOf("20348") !== -1) {
          setStatus("Window audio requires Windows 11 — share full screen with system audio instead", true);
        } else {
          setStatus("Window audio capture failed: " + errStr, true);
        }
      }
    } else {
      debugLog("[native-audio] no matching window found for track label '" + trackLabel + "'");
      setStatus("Could not detect window audio — share full screen with system audio for best results", true);
      // Log available windows for debugging
      for (var i = 0; i < Math.min(windows.length, 10); i++) {
        debugLog("[native-audio]   available: '" + windows[i].title + "' (" + windows[i].exe_name + ") hwnd=" + windows[i].hwnd);
      }
    }
  } catch (err) {
    debugLog("[native-audio] auto-detect error: " + err);
  }
}

async function startNativeAudioCapture(pid, opts) {
  opts = opts || {};
  // Stop existing capture first
  await stopNativeAudioCapture();

  if (!hasTauriIPC()) throw new Error("Tauri IPC not available");

  var LK = getLiveKitClient();
  var trackSource = opts.source || LK.Track.Source.ScreenShareAudio;
  var trackName = opts.name || undefined;

  // Create AudioContext — DON'T hardcode sample rate, let it match system default
  // WASAPI will report its actual format and we adapt
  _nativeAudioCtx = new AudioContext();
  // Resume immediately — Chrome suspends new AudioContexts by default
  if (_nativeAudioCtx.state === "suspended") {
    await _nativeAudioCtx.resume();
  }
  debugLog("[native-audio] AudioContext state=" + _nativeAudioCtx.state + " sampleRate=" + _nativeAudioCtx.sampleRate);

  var blob = new Blob([_nativeAudioWorkletCode], { type: "application/javascript" });
  var url = URL.createObjectURL(blob);
  await _nativeAudioCtx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  _nativeAudioWorklet = new AudioWorkletNode(_nativeAudioCtx, "native-audio-proc", {
    outputChannelCount: [2],
  });
  _nativeAudioDest = _nativeAudioCtx.createMediaStreamDestination();
  _nativeAudioWorklet.connect(_nativeAudioDest);

  // Debug: track data flow
  var _dataChunkCount = 0;
  var _dataSampleCount = 0;
  var _firstNonSilentLogged = false;

  // Listen for audio data from Rust via Tauri events
  var captureFormat = null;
  var formatUn = await tauriListen("audio-capture-format", function (ev) {
    captureFormat = ev.payload;
    debugLog("[native-audio] WASAPI format: " + JSON.stringify(captureFormat));
  });

  _nativeAudioUnlisten = await tauriListen("audio-capture-data", function (ev) {
    try {
      // Decode base64 → ArrayBuffer → Float32Array
      var b64 = ev.payload;
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var floats = new Float32Array(bytes.buffer);

      _dataChunkCount++;
      _dataSampleCount += floats.length;

      // Check peak level for this chunk
      var maxVal = 0;
      for (var j = 0; j < Math.min(floats.length, 200); j++) {
        var abs = Math.abs(floats[j]);
        if (abs > maxVal) maxVal = abs;
      }

      // Log first non-silent chunk (confirms real audio is flowing)
      if (!_firstNonSilentLogged && maxVal > 0.001) {
        _firstNonSilentLogged = true;
        debugLog("[native-audio] FIRST NON-SILENT chunk at #" + _dataChunkCount +
          " peak=" + maxVal.toFixed(4) + " samples=" + floats.length +
          " — audio data is flowing!");
      }

      // Log first few chunks and then every 50th for diagnostics
      if (_dataChunkCount <= 3 || _dataChunkCount % 50 === 0) {
        debugLog("[native-audio] chunk #" + _dataChunkCount + " samples=" + floats.length +
          " totalSamples=" + _dataSampleCount + " peak=" + maxVal.toFixed(4));
      }

      // Send to AudioWorklet
      if (_nativeAudioWorklet) {
        _nativeAudioWorklet.port.postMessage(floats);
      }
    } catch (e) {
      debugLog("[native-audio] decode error: " + e);
    }
  });

  // Also listen for errors/stopped
  var errorUn = await tauriListen("audio-capture-error", function (ev) {
    debugLog("[native-audio] capture error: " + ev.payload);
    var st = document.getElementById("native-audio-status");
    if (st) { st.textContent = "Error: " + ev.payload; st.classList.remove("active"); }
  });

  var stoppedUn = await tauriListen("audio-capture-stopped", function () {
    debugLog("[native-audio] capture stopped by Rust");
  });

  // Store unlisteners for cleanup
  var origUnlisten = _nativeAudioUnlisten;
  _nativeAudioUnlisten = function () {
    origUnlisten(); formatUn(); errorUn(); stoppedUn();
  };

  // Start the WASAPI capture on Rust side
  await tauriInvoke("start_audio_capture", { pid: pid });
  debugLog("[native-audio] WASAPI started for PID " + pid);

  // Publish the audio track via LiveKit
  var audioTrack = _nativeAudioDest.stream.getAudioTracks()[0];
  debugLog("[native-audio] MediaStream track: " + (audioTrack ? "exists, enabled=" + audioTrack.enabled + " muted=" + audioTrack.muted + " state=" + audioTrack.readyState : "MISSING"));
  if (audioTrack) {
    _nativeAudioTrack = new LK.LocalAudioTrack(audioTrack, undefined, false);
    var publishOpts = {
      source: trackSource,
      dtx: false,
      red: false,
      audioBitrate: 128000,
    };
    if (trackName) publishOpts.name = trackName;
    await room.localParticipant.publishTrack(_nativeAudioTrack, publishOpts);
    debugLog("[native-audio] published to LiveKit as " + (trackName || "ScreenShareAudio"));
  } else {
    debugLog("[native-audio] ERROR: no audio track from MediaStreamDestination!");
  }

  _nativeAudioActive = true;

  // Show native audio indicator
  var indicator = document.getElementById("native-audio-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "native-audio-indicator";
    indicator.style.cssText = "position:fixed;bottom:8px;right:8px;background:rgba(0,200,0,0.8);color:#fff;padding:4px 10px;border-radius:12px;font-size:12px;z-index:99999;pointer-events:none;";
    document.body.appendChild(indicator);
  }
  indicator.textContent = "Native Audio Active";
  indicator.style.display = "";
}

async function stopNativeAudioCapture() {
  if (!_nativeAudioActive) return;
  _nativeAudioActive = false;
  debugLog("[native-audio] stopping capture");

  // Hide native audio indicator
  var indicator = document.getElementById("native-audio-indicator");
  if (indicator) indicator.style.display = "none";

  // Tell Rust to stop
  try {
    if (hasTauriIPC()) {
      await tauriInvoke("stop_audio_capture");
    }
  } catch (e) {
    debugLog("[native-audio] stop_audio_capture error: " + e);
  }

  // Unlisten Tauri events
  if (_nativeAudioUnlisten) {
    try { _nativeAudioUnlisten(); } catch (e) {}
    _nativeAudioUnlisten = null;
  }

  // Unpublish LiveKit track
  if (_nativeAudioTrack && room) {
    try {
      await room.localParticipant.unpublishTrack(_nativeAudioTrack, true);
      _nativeAudioTrack.mediaStreamTrack?.stop();
    } catch (e) {}
    _nativeAudioTrack = null;
  }

  // Close AudioContext
  if (_nativeAudioWorklet) {
    try { _nativeAudioWorklet.disconnect(); } catch (e) {}
    _nativeAudioWorklet = null;
  }
  _nativeAudioDest = null;
  if (_nativeAudioCtx) {
    try { _nativeAudioCtx.close(); } catch (e) {}
    _nativeAudioCtx = null;
  }

  var st = document.getElementById("native-audio-status");
  if (st) { st.textContent = ""; st.classList.remove("active"); }
}

// ---------- End native audio capture ----------

document.addEventListener(
  "pointerdown",
  () => {
    unlockAudio();
  },
  { once: true }
);

function setRoomAudioMutedState(next) {
  roomAudioMuted = Boolean(next);
  if (toggleRoomAudioButton) {
    toggleRoomAudioButton.textContent = roomAudioMuted ? "Unmute All" : "Mute All";
  }
  participantState.forEach((state) => {
    applyParticipantAudioVolumes(state);
  });
  updateSoundboardMasterGain();
  // Mute/unmute Jam audio
  if (typeof _jamGainNode !== "undefined" && _jamGainNode) {
    _jamGainNode.gain.value = roomAudioMuted ? 0 : (_jamVolume / 100);
  }
}

function setDefaultUrls() {
  if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
    // Native client: get server URL from Tauri config
    tauriInvoke("get_control_url").then(function(url) {
      _echoServerUrl = url;
      if (!controlUrlInput.value) controlUrlInput.value = url;
      if (!sfuUrlInput.value) {
        // SFU is proxied through the control plane — same host:port, just wss://
        sfuUrlInput.value = url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
      }
      debugLog("[native] server URL from Tauri config: " + url);
    }).catch(function(e) {
      debugLog("[native] get_control_url failed: " + e);
      // Fallback to defaults
      if (!controlUrlInput.value) controlUrlInput.value = "https://echo.fellowshipoftheboatrace.party:9443";
      if (!sfuUrlInput.value) sfuUrlInput.value = "wss://echo.fellowshipoftheboatrace.party:9443";
    });
  } else {
    if (!controlUrlInput.value) {
      controlUrlInput.value = window.location.protocol + "//" + window.location.host;
    }
    if (!sfuUrlInput.value) {
      if (window.location.protocol === "https:") {
        sfuUrlInput.value = "wss://" + window.location.host;
      } else {
        sfuUrlInput.value = "ws://" + window.location.hostname + ":7880";
      }
    }
  }
}

function normalizeUrls() {
  // For native client, URLs are set by setDefaultUrls via Tauri IPC
  if (window.__ECHO_NATIVE__) return;
  if (window.location.protocol !== "https:") return;
  if (!controlUrlInput.value) {
    controlUrlInput.value = "https://" + window.location.host;
  }
  if (!sfuUrlInput.value) {
    sfuUrlInput.value = "wss://" + window.location.host;
  }
}

function getLiveKitClient() {
  return window.LiveKitClient || window.LivekitClient || window.LiveKit;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#f87171" : "";
}

function describeDisconnectReason(reason, LK) {
  if (reason == null) return "unknown";
  if (typeof reason === "string") return reason;
  if (typeof reason === "number" && LK?.DisconnectReason) {
    const entry = Object.entries(LK.DisconnectReason).find(([, value]) => value === reason);
    if (entry) return entry[0];
  }
  return String(reason);
}

async function fetchAdminToken(baseUrl, password) {
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`Login failed (${login.status})`);
  const loginData = await login.json();
  return loginData.token;
}

async function fetchRoomToken(baseUrl, adminToken, room, identity, name) {
  const token = await fetch(`${baseUrl}/v1/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ room, identity, name }),
  });
  if (!token.ok) throw new Error(`Token failed (${token.status})`);
  const tokenData = await token.json();
  return tokenData.token;
}

async function ensureRoomExists(baseUrl, adminToken, roomId) {
  await fetch(`${baseUrl}/v1/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ room_id: roomId }),
  }).catch(() => {});
}

async function fetchRooms(baseUrl, adminToken) {
  const res = await fetch(`${baseUrl}/v1/rooms`, {
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

async function fetchRoomStatus(baseUrl, adminToken) {
  try {
    const res = await fetch(`${baseUrl}/v1/room-status`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// ---- Room chime sounds (Web Audio API) ----
let chimeAudioCtx = null;
const chimeBufferCache = new Map(); // "identityBase-enter" or "identityBase-exit" -> { buffer, ts }
const CHIME_CACHE_TTL_MS = 60000; // Re-fetch chimes after 60 seconds so updates are picked up
function getChimeCtx() {
  if (!chimeAudioCtx) chimeAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return chimeAudioCtx;
}

function playJoinChime() {
  try {
    const ctx = getChimeCtx();
    const now = ctx.currentTime;
    // Cheerful ascending two-note chime
    [[523.25, 0], [659.25, 0.12]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.4);
    });
  } catch {}
}

function playLeaveChime() {
  try {
    const ctx = getChimeCtx();
    const now = ctx.currentTime;
    // Comedic descending "womp womp"
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(380, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.3);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.55);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.setValueAtTime(0.05, now + 0.25);
    gain.gain.setValueAtTime(0.18, now + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.75);
  } catch {}
}

function playSwitchChime() {
  try {
    const ctx = getChimeCtx();
    const now = ctx.currentTime;
    // Sci-fi teleport swoosh: quick rising sweep then a soft landing ping
    const swoosh = ctx.createOscillator();
    const swooshGain = ctx.createGain();
    swoosh.type = "sawtooth";
    swoosh.frequency.setValueAtTime(200, now);
    swoosh.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
    swoosh.frequency.exponentialRampToValueAtTime(800, now + 0.2);
    swooshGain.gain.setValueAtTime(0.08, now);
    swooshGain.gain.linearRampToValueAtTime(0.12, now + 0.08);
    swooshGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    swoosh.connect(swooshGain).connect(ctx.destination);
    swoosh.start(now);
    swoosh.stop(now + 0.25);
    // Landing ping
    const ping = ctx.createOscillator();
    const pingGain = ctx.createGain();
    ping.type = "sine";
    ping.frequency.value = 880;
    pingGain.gain.setValueAtTime(0.15, now + 0.18);
    pingGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    ping.connect(pingGain).connect(ctx.destination);
    ping.start(now + 0.18);
    ping.stop(now + 0.55);
  } catch {}
}

async function fetchChimeBuffer(identityBase, kind) {
  const cacheKey = identityBase + "-" + kind;
  const cached = chimeBufferCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CHIME_CACHE_TTL_MS) return cached.buffer;
  try {
    // Add cache-buster to bypass browser cache — chimes may be updated at any time
    const res = await fetch(apiUrl("/api/chime/" + encodeURIComponent(identityBase) + "/" + kind + "?v=" + Date.now()));
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const ctx = getChimeCtx();
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    chimeBufferCache.set(cacheKey, { buffer: decoded, ts: Date.now() });
    return decoded;
  } catch {
    return null;
  }
}

function playCustomChime(buffer) {
  try {
    const ctx = getChimeCtx();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    source.connect(gain).connect(ctx.destination);
    source.start(0);
  } catch {}
}

async function playChimeForIdentities(identities, kind) {
  for (const id of identities) {
    const identityBase = getIdentityBase(id);
    const buffer = await fetchChimeBuffer(identityBase, kind);
    if (buffer) {
      playCustomChime(buffer);
      return;
    }
  }
  if (kind === "enter") playJoinChime();
  else playLeaveChime();
}

function detectRoomChanges(statusMap) {
  const currentIds = {};
  FIXED_ROOMS.forEach((roomId) => {
    currentIds[roomId] = new Set((statusMap[roomId] || []).map((p) => p.identity));
  });
  const myIdentity = identityInput ? identityInput.value : "";
  const myRoom = currentRoomName;
  // If Sam just switched rooms (or this is the first poll), skip chime detection.
  // Stale previousRoomParticipants for the new room would trigger false leave/join chimes.
  if (previousDetectedRoom !== myRoom) {
    previousDetectedRoom = myRoom;
    previousRoomParticipants = currentIds;
    return;
  }
  // Build flat lookup: identity -> room for previous and current
  const prevByUser = {};
  const currByUser = {};
  FIXED_ROOMS.forEach((roomId) => {
    (previousRoomParticipants[roomId] || new Set()).forEach((id) => { prevByUser[id] = roomId; });
    currentIds[roomId].forEach((id) => { currByUser[id] = roomId; });
  });
  // Perspective-based: only care about people entering/leaving MY room
  const enteredIds = [];
  const leftIds = [];
  let someoneSwitchedAway = false;
  const prevMyRoom = previousRoomParticipants[myRoom] || new Set();
  const currMyRoom = currentIds[myRoom] || new Set();
  // Someone appeared in my room (join or switch — either way, welcome them)
  for (const id of currMyRoom) {
    if (id === myIdentity) continue;
    if (!prevMyRoom.has(id)) enteredIds.push(id);
  }
  // Someone disappeared from my room
  for (const id of prevMyRoom) {
    if (id === myIdentity) continue;
    if (!currMyRoom.has(id)) {
      if (currByUser[id]) someoneSwitchedAway = true;
      else leftIds.push(id);
    }
  }
  previousRoomParticipants = currentIds;
  if (enteredIds.length > 0) playChimeForIdentities(enteredIds, "enter");
  else if (someoneSwitchedAway) playSwitchChime();
  else if (leftIds.length > 0) playChimeForIdentities(leftIds, "exit");
}

async function refreshRoomList(baseUrl, adminToken, activeRoom) {
  if (!roomListEl) return;
  const statusList = await fetchRoomStatus(baseUrl, adminToken);
  const statusMap = {};
  if (Array.isArray(statusList)) {
    statusList.forEach((r) => { statusMap[r.room_id] = r.participants || []; });
  }
  detectRoomChanges(statusMap);
  roomListEl.innerHTML = "";
  FIXED_ROOMS.forEach((roomId) => {
    const participants = statusMap[roomId] || [];
    const displayName = ROOM_DISPLAY_NAMES[roomId] || roomId;
    const isActive = roomId === activeRoom;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "room-status-btn" + (isActive ? " is-active" : "");
    const nameSpan = document.createElement("span");
    nameSpan.className = "room-status-name";
    nameSpan.textContent = displayName;
    btn.appendChild(nameSpan);
    const countSpan = document.createElement("span");
    countSpan.className = "room-status-count";
    countSpan.textContent = participants.length > 0 ? participants.length : "";
    btn.appendChild(countSpan);
    if (participants.length > 0) {
      btn.classList.add("has-users");
      const tooltip = document.createElement("div");
      tooltip.className = "room-status-tooltip";
      participants.forEach((p) => {
        const row = document.createElement("div");
        row.className = "room-status-tooltip-name";
        row.textContent = p.name || p.identity;
        tooltip.appendChild(row);
      });
      btn.appendChild(tooltip);
    }
    btn.addEventListener("click", () => {
      if (roomId === currentRoomName) return;
      switchRoom(roomId).catch(() => {});
    });
    roomListEl.appendChild(btn);
  });
}

function startRoomStatusPolling() {
  stopRoomStatusPolling();
  const controlUrl = controlUrlInput.value.trim();
  if (!controlUrl || !adminToken) return;
  roomStatusTimer = setInterval(() => {
    refreshRoomList(controlUrl, adminToken, currentRoomName).catch(() => {});
  }, 2000);
}

function stopRoomStatusPolling() {
  if (roomStatusTimer) {
    clearInterval(roomStatusTimer);
    roomStatusTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  const controlUrl = controlUrlInput.value.trim();
  if (!controlUrl || !adminToken) return;
  const sendBeat = () => {
    const identity = identityInput ? identityInput.value : "";
    const name = nameInput.value.trim() || "Viewer";
    fetch(`${controlUrl}/v1/participants/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ room: currentRoomName, identity, name }),
    }).catch(() => {});
  };
  sendBeat();
  heartbeatTimer = setInterval(sendBeat, 10000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendLeaveNotification() {
  const controlUrl = controlUrlInput.value.trim();
  const identity = identityInput ? identityInput.value : "";
  if (!controlUrl || !adminToken || !identity) return;
  fetch(`${controlUrl}/v1/participants/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ identity }),
  }).catch(() => {});
}

let switchingRoom = false;
let connectSequence = 0;

async function switchRoom(roomId) {
  if (!room) return;
  if (roomId === currentRoomName) return;
  if (switchingRoom) {
    debugLog(`Switch to ${roomId} ignored — already switching`);
    return;
  }
  switchingRoom = true;
  debugLog(`Switching from ${currentRoomName} to ${roomId}`);
  currentRoomName = roomId;
  try {
    const controlUrl = controlUrlInput.value.trim();
    const sfuUrl = sfuUrlInput.value.trim();
    const name = nameInput.value.trim() || "Viewer";
    const identity = buildIdentity(name);
    if (identityInput) {
      identityInput.value = identity;
    }
    await connectToRoom({ controlUrl, sfuUrl, roomId, identity, name, reuseAdmin: true });
  } finally {
    switchingRoom = false;
  }
}

function addTile(label, element) {
  const tile = document.createElement("div");
  tile.className = "tile";
  const title = document.createElement("h3");
  title.textContent = label;
  tile.appendChild(title);
  tile.appendChild(element);
  screenGridEl.appendChild(tile);
  return tile;
}

function addScreenTile(label, element, trackSid) {
  configureVideoElement(element, true);
  // Force contain so ultrawides and non-standard ratios are never stretched
  element.style.objectFit = "contain";
  element.style.width = "100%";
  element.style.height = "100%";
  element.style.background = "transparent";
  ensureVideoPlays(element._lkTrack, element);
  const tile = addTile(label, element);
  tile.addEventListener("click", () => {
    if (screenGridEl.classList.contains("is-focused") && tile.classList.contains("is-focused")) {
      screenGridEl.classList.remove("is-focused");
      tile.classList.remove("is-focused");
      return;
    }
    screenGridEl.classList.add("is-focused");
    screenGridEl.querySelectorAll(".tile.is-focused").forEach((el) => el.classList.remove("is-focused"));
    tile.classList.add("is-focused");
  });
  const overlay = document.createElement("div");
  overlay.className = "tile-overlay";
  tile.appendChild(overlay);
  if (trackSid) {
    tile.dataset.trackSid = trackSid;
    screenTileBySid.set(trackSid, tile);
  }
  if (element && element.tagName === "VIDEO") {
    attachVideoDiagnostics(element._lkTrack || null, element, overlay);
    // Once video dimensions are known, tag the tile's aspect ratio class
    const tagAspect = () => {
      const vw = element.videoWidth, vh = element.videoHeight;
      if (vw && vh) {
        const ratio = vw / vh;
        tile.classList.toggle("ultrawide", ratio > 2.0);
        tile.classList.toggle("superwide", ratio > 2.8);
        tile.dataset.aspectRatio = ratio.toFixed(2);
      }
    };
    element.addEventListener("loadedmetadata", tagAspect);
    element.addEventListener("resize", tagAspect);
    // Check immediately in case already loaded
    tagAspect();
  }
  return tile;
}

function registerScreenTrack(trackSid, publication, tile, identity) {
  if (!trackSid || !tile) return;
  screenTrackMeta.set(trackSid, {
    publication,
    tile,
    lastFix: 0,
    lastKeyframe: 0,
    retryCount: 0,
    identity: identity || "",
    createdAt: performance.now()
  });
  if (ENABLE_SCREEN_WATCHDOG) startScreenWatchdog();
}

function unregisterScreenTrack(trackSid) {
  if (!trackSid) return;
  screenTrackMeta.delete(trackSid);
  if (screenTrackMeta.size === 0 && screenWatchdogTimer) {
    clearInterval(screenWatchdogTimer);
    screenWatchdogTimer = null;
  }
}

function clearScreenTracksForIdentity(identity, keepTrackSid) {
  if (!identity) return;
  screenTrackMeta.forEach((meta, trackSid) => {
    if (meta.identity === identity && trackSid !== keepTrackSid) {
      removeScreenTile(trackSid);
      unregisterScreenTrack(trackSid);
    }
  });
  const state = participantState.get(identity);
  if (state?.screenTrackSid && state.screenTrackSid !== keepTrackSid) {
    state.screenTrackSid = null;
  }
}

function startScreenWatchdog() {
  if (screenWatchdogTimer) return;
  screenWatchdogTimer = setInterval(() => {
    const now = performance.now();
    screenTrackMeta.forEach((meta, trackSid) => {
      const tile = meta.tile;
      if (!tile || !tile.isConnected) return;
      const video = tile.querySelector("video");
      if (!video) return;
      const lastFrame = video._lastFrameTs || 0;
      const age = now - lastFrame;
      const hasFrames = video.videoWidth > 0 && video.videoHeight > 0;
      const isBlack = video._isBlack === true;
      if (isBlack) {
        meta.blackSince = meta.blackSince || now;
      } else {
        meta.blackSince = 0;
        meta.blackAttempts = 0;
      }
      const blackFor = meta.blackSince ? now - meta.blackSince : 0;
      const firstFrameTs = video._firstFrameTs || 0;
      const sinceFirstFrame = firstFrameTs ? now - firstFrameTs : 0;
      const publication = meta.publication;
      const track = publication?.track;

      if (hasFrames && !isBlack && age < 4500) return;
      // Grace period: don't run recovery on tiles less than 8 seconds old.
      // New tiles need time to receive first frames before recovery kicks in.
      var tileAge = now - (meta.createdAt || 0);
      if (tileAge < 8000) return;
      if (isBlack && blackFor > 1200 && track) {
        if (!meta.lastSwap || now - meta.lastSwap > 2500) {
          meta.lastSwap = now;
          replaceScreenVideoElement(tile, track, publication);
        }
        if (blackFor > 3500 && (!meta.lastResub || now - meta.lastResub > 6000)) {
          meta.lastResub = now;
          meta.blackAttempts = (meta.blackAttempts || 0) + 1;
          if (publication?.setSubscribed) {
            markResubscribeIntent(trackSid);
            publication.setSubscribed(false);
            setTimeout(() => publication.setSubscribed(true), 500);
          }
        }
      }
      if (now - (meta.lastKeyframe || 0) > 2500) {
        meta.lastKeyframe = now;
        requestVideoKeyFrame(publication, track);
      }
      // Give new tracks time to settle before trying aggressive recovery.
      if (!isBlack && sinceFirstFrame > 0 && sinceFirstFrame < 5000 && age < 5000) return;
      const stalled = age > 1200;
      if (!stalled) return;
      const minFixInterval = meta.lastFix ? (isBlack ? 2200 : 8000) : (isBlack ? 1200 : 2000);
      if (now - (meta.lastFix || 0) < minFixInterval) return;

      meta.lastFix = now;
      meta.retryCount = (meta.retryCount || 0) + 1;

      if (track) {
        if (publication?.setSubscribed) {
          publication.setSubscribed(true);
        }
        try {
          track.detach(video);
          video.srcObject = null;
        } catch {}
        try {
          track.attach(video);
          video._lkTrack = track;
          configureVideoElement(video, true);
        } catch {}
        ensureVideoPlays(track, video);
        ensureVideoSubscribed(publication, video);
        forceVideoLayer(publication, video);
        requestVideoKeyFrame(publication, track);
        video._isBlack = false;
      }

      // Only flip subscription as a last resort, and not too frequently.
      if (meta.retryCount >= 2 && publication?.setSubscribed && (age > 12000 || (isBlack && stalled))) {
        meta.retryCount = 0;
        markResubscribeIntent(trackSid);
        publication.setSubscribed(false);
        setTimeout(() => {
          publication.setSubscribed(true);
        }, 400);
      }
      // Avoid forcing remote users to re-share (re-prompts).
    });
  }, 1500);
}

function forceReattachVideo(publication, participant) {
  const LK = getLiveKitClient();
  if (!publication || !participant) return;
  const track = publication.track;
  if (!track || track.kind !== "video") return;
  const source = publication.source || track.source;
  const label = `${participant.name || "Guest"} (Screen)`;
  if (source === LK.Track.Source.ScreenShare) {
    clearScreenTracksForIdentity(participant.identity, publication.trackSid);
    if (publication.trackSid) {
      unregisterScreenTrack(publication.trackSid);
      removeScreenTile(publication.trackSid);
    }
    const element = track.attach();
    element._lkTrack = track;
    configureVideoElement(element, true);
    ensureVideoPlays(track, element);
    ensureVideoSubscribed(publication, element);
    const tile = addScreenTile(label, element, publication.trackSid);
    if (publication.trackSid) {
      registerScreenTrack(publication.trackSid, publication, tile);
    }
    requestVideoKeyFrame(publication, track);
    forceVideoLayer(publication, element);
  } else if (source === LK.Track.Source.Camera) {
    const cardRef = ensureParticipantCard(participant);
    updateAvatarVideo(cardRef, track);
    const video = cardRef.avatar.querySelector("video");
    if (video) {
      ensureVideoPlays(track, video);
      ensureVideoSubscribed(publication, video);
    }
    forceVideoLayer(publication, video);
  }
}

function removeScreenTile(trackSid) {
  if (!trackSid) return;
  const tile = screenTileBySid.get(trackSid);
  if (tile) {
    const overlay = tile.querySelector(".tile-overlay");
    cleanupVideoDiagnostics(overlay);
    if (tile.classList.contains("is-focused")) {
      screenGridEl.classList.remove("is-focused");
    }
    tile.remove();
    screenTileBySid.delete(trackSid);
  }
}

function clearMedia() {
  screenGridEl.innerHTML = "";
  screenTileBySid.clear();
  screenTrackMeta.clear();
  screenRecoveryAttempts.clear();
  screenResubscribeIntent.clear();
  cameraRecoveryAttempts.clear();
  cameraVideoBySid.clear();
  lastTrackHandled.clear();
  cameraClearTimers.forEach((timer) => clearTimeout(timer));
  cameraClearTimers.clear();
  if (screenWatchdogTimer) {
    clearInterval(screenWatchdogTimer);
    screenWatchdogTimer = null;
  }
  stopMediaReconciler();
  stopAudioMonitor();
  audioBucketEl.innerHTML = "";
  audioElBySid.clear();
  userListEl.innerHTML = "";
  participantCards.clear();
  participantState.clear();
}

function getInitials(name) {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("");
}

function getIdentityBase(identity) {
  // Strip the -XXXX numeric suffix from "name-1234" -> "name"
  return identity ? identity.replace(/-\d+$/, "") : identity;
}

function showRefreshButton() {
  if (refreshVideosButton && window._pausedVideos && window._pausedVideos.size > 0) {
    refreshVideosButton.classList.remove('hidden');
  }
}

function hideRefreshButton() {
  if (refreshVideosButton) {
    refreshVideosButton.classList.add('hidden');
  }
}

function createLockedVideoElement(track) {
  // Create video element with muted property LOCKED to prevent autoplay failures
  const element = document.createElement('video');
  element.srcObject = new MediaStream([track.mediaStreamTrack]);
  element._lkTrack = track;
  element.muted = true;  // CRITICAL: Must stay muted for autoplay
  element.autoplay = true;
  element.playsInline = true;

  // CRITICAL: Force video to STAY muted by locking the property
  // This prevents LiveKit or browser from unmuting and breaking autoplay
  Object.defineProperty(element, 'muted', {
    get: () => true,
    set: () => {},  // Ignore all attempts to unmute
    configurable: true
  });

  return element;
}

function configureVideoElement(element, muted = true) {
  if (!element) return;
  element.autoplay = true;
  element.playsInline = true;
  element.muted = muted;
  element.controls = false;
  // Force contain on ALL video elements — prevents stretching regardless of
  // what the LiveKit SDK sets via inline styles after attach()
  if (element.tagName === "VIDEO") {
    element.style.objectFit = "contain";
  }
  element._attachedAt = performance.now();
  const tryPlay = async () => {
    try {
      await element.play();
      debugLog(`video play() succeeded for ${element._lkTrack?.sid || 'unknown'}, muted=${element.muted}`);
    } catch (err) {
      debugLog(`ERROR: video play() FAILED for ${element._lkTrack?.sid || 'unknown'}: ${err.message}`);

      // Try to refresh autoplay permission by replaying the dummy video, then retry
      if (window._dummyVideo && !element._autoplayRetried) {
        element._autoplayRetried = true;
        try {
          await window._dummyVideo.play();
          await new Promise(resolve => setTimeout(resolve, 50));
          await element.play();
          debugLog(`video play() SUCCEEDED after autoplay refresh for ${element._lkTrack?.sid || 'unknown'}`);
        } catch (retryErr) {
          debugLog(`video play() still failed after autoplay refresh: ${retryErr.message}`);

          // Track this video for enabling on next user interaction
          if (window._pausedVideos) {
            window._pausedVideos.add(element);
            debugLog(`Video ${element._lkTrack?.sid || 'unknown'} queued for next user interaction`);
            showRefreshButton();
          }
        }
      } else if (window._pausedVideos) {
        // Already retried, just queue for user interaction
        window._pausedVideos.add(element);
        debugLog(`Video ${element._lkTrack?.sid || 'unknown'} queued for next user interaction`);
        showRefreshButton();
      }
    }
  };
  if (element.readyState >= 1) {
    tryPlay();
  } else {
    element.addEventListener("loadedmetadata", tryPlay, { once: true });
  }
  setTimeout(tryPlay, 400);
}

function startBasicVideoMonitor(element) {
  if (!element || element._monitorTimer) return;
  element._lastFrameTs = element._lastFrameTs || performance.now();
  element._frameCount = 0;
  const firstFrameDeadline = performance.now() + 2200;
  if (typeof element.requestVideoFrameCallback === "function") {
    const onFrame = () => {
      element._lastFrameTs = performance.now();
      element._frameCount += 1;
      if (!element._firstFrameTs) {
        element._firstFrameTs = element._lastFrameTs;
        debugLog(`video first frame ${element._lkTrack?.sid || "unknown"}`);
      }
      element.requestVideoFrameCallback(onFrame);
    };
    element.requestVideoFrameCallback(onFrame);
  }
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  element._monitorTimer = setInterval(() => {
    if (!element.isConnected) {
      clearInterval(element._monitorTimer);
      element._monitorTimer = null;
      return;
    }
    if (!ctx) return;
    if (element.videoWidth <= 0 || element.videoHeight <= 0) return;
    try {
      ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 16) {
        sum += data[i] + data[i + 1] + data[i + 2];
        count += 1;
      }
      const avg = count ? sum / (count * 3) : 0;
      element._isBlack = avg < 3;
    } catch {
      // ignore sampling errors
    }
    if (!element._reportedNoFrames && performance.now() > firstFrameDeadline && element._frameCount === 0) {
      element._reportedNoFrames = true;
      debugLog(`video no frames ${element._lkTrack?.sid || "unknown"} size=${element.videoWidth}x${element.videoHeight}`);
    }
  }, 900);
}

function configureAudioElement(element) {
  if (!element) return;
  element.autoplay = true;
  element.muted = false;
  element.controls = false;
  const tryPlay = () => {
    const res = element.play();
    if (res && typeof res.catch === "function") {
      res.catch((err) => {
        debugLog(`audio play() failed for ${element._lkTrack?.sid || "unknown"}: ${err.message}`);
        if (window._pausedVideos) {
          window._pausedVideos.add(element);
        }
      });
    }
  };
  tryPlay();
  setTimeout(tryPlay, 300);
}

function ensureAudioPlays(element) {
  if (!element) return;
  let attempts = 0;
  const tryPlay = () => {
    attempts += 1;
    if (!element.isConnected) return;
    try {
      const res = element.play();
      if (res && typeof res.catch === "function") {
        res.catch((err) => {
          if (attempts >= 6) {
            debugLog(`audio ensurePlay gave up after ${attempts} attempts for ${element._lkTrack?.sid || "unknown"}: ${err.message}`);
            if (window._pausedVideos) {
              window._pausedVideos.add(element);
              debugLog(`Audio ${element._lkTrack?.sid || "unknown"} queued for next user interaction`);
            }
          }
        });
      }
    } catch {}
    if (attempts < 6) {
      setTimeout(tryPlay, 700);
    }
  };
  tryPlay();
}

function ensureVideoPlays(track, element) {
  if (!track || !element) return;
  // Cancel any previous ensureVideoPlays chain for this element
  if (element._ensurePlayId) {
    element._ensurePlayId++;
  }
  const playId = (element._ensurePlayId || 0) + 1;
  element._ensurePlayId = playId;

  let attempts = 0;
  const check = () => {
    // Abort if a newer chain was started
    if (element._ensurePlayId !== playId) return;
    attempts += 1;
    if (!element.isConnected) return;
    if (element.videoWidth > 0 || element.videoHeight > 0) return;
    if (track.mediaStreamTrack && track.mediaStreamTrack.muted) {
      if (attempts < 8) {
        setTimeout(check, 800);
      }
      return;
    }
    try {
      track.requestKeyFrame?.();
    } catch {}
    try {
      track.attach(element);
      element._lkTrack = track;
      configureVideoElement(element, true);
    } catch {}
    if (attempts < 8) {
      setTimeout(check, 800);
    }
  };
  setTimeout(check, 400);
  const kick = () => {
    if (!element.isConnected) return;
    if (element.videoWidth > 0 || element.videoHeight > 0) return;
    if (element.paused) {
      element.play().catch(() => {});
    }
  };
  kick();
  const kickTimer = setInterval(() => {
    if (!element.isConnected) return clearInterval(kickTimer);
    if (element.videoWidth > 0 || element.videoHeight > 0) return clearInterval(kickTimer);
    kick();
  }, 400);
}

function replaceScreenVideoElement(tile, track, publication) {
  if (!tile || !track) return;
  const overlay = tile.querySelector(".tile-overlay");
  const oldVideo = tile.querySelector("video");
  if (oldVideo && overlay) {
    cleanupVideoDiagnostics(overlay);
  }
  const newEl = createLockedVideoElement(track);
  if (!newEl) return;
  configureVideoElement(newEl, true);
  if (oldVideo && oldVideo.parentElement) {
    oldVideo.replaceWith(newEl);
  } else if (overlay && overlay.parentElement) {
    overlay.parentElement.insertBefore(newEl, overlay);
  } else {
    tile.appendChild(newEl);
  }
  if (overlay) {
    attachVideoDiagnostics(track, newEl, overlay);
  }
  ensureVideoPlays(track, newEl);
  ensureVideoSubscribed(publication, newEl);
  forceVideoLayer(publication, newEl);
  requestVideoKeyFrame(publication, track);
}

function kickStartScreenVideo(publication, track, element) {
  if (!track || !element) return;
  const start = performance.now();
  let attempts = 0;
  const tick = () => {
    if (!element.isConnected) return;
    if (element.videoWidth > 0 || element.videoHeight > 0) return;
    attempts += 1;
    if (publication?.setSubscribed) {
      publication.setSubscribed(true);
    }
    requestVideoKeyFrame(publication, track);
    if (performance.now() - start < 2500) {
      setTimeout(tick, 400);
    }
  };
  setTimeout(tick, 120);
}

function scheduleScreenRecovery(trackSid, publication, element) {
  if (!trackSid || !publication || !element) return;
  const attempt = screenRecoveryAttempts.get(trackSid) || 0;
  if (attempt >= 1) return;
  setTimeout(() => {
    if (!element.isConnected) return;
    const isBlack = element._isBlack === true;
    const lastFrame = element._lastFrameTs || 0;
    const stalled = performance.now() - lastFrame > 1200;
    if (!isBlack || !stalled) return;
    screenRecoveryAttempts.set(trackSid, attempt + 1);
    if (publication.setSubscribed) {
      markResubscribeIntent(trackSid);
      publication.setSubscribed(false);
      setTimeout(() => publication.setSubscribed(true), 300);
    }
    requestVideoKeyFrame(publication, publication.track);
    element._isBlack = false;
  }, 700);
}

function requestVideoKeyFrame(publication, track) {
  try {
    if (publication?.videoTrack?.requestKeyFrame) {
      publication.videoTrack.requestKeyFrame();
      return;
    }
    if (track?.requestKeyFrame) {
      track.requestKeyFrame();
    }
  } catch {}
}

function forceVideoLayer(publication, element) {
  if (!publication) return;
  if (element && element.videoWidth === 0 && element.videoHeight === 0) {
    setTimeout(() => forceVideoLayer(publication, element), 800);
    return;
  }
  const LK = getLiveKitClient();
  try {
    // Start with LOW quality to ensure video displays, then upgrade
    const initialQuality = LK?.VideoQuality?.LOW || LK?.VideoQuality?.MEDIUM;
    const targetQuality = LK?.VideoQuality?.HIGH;

    if (publication.setVideoQuality && initialQuality != null) {
      publication.setVideoQuality(initialQuality);
    }
    if (publication.setPreferredLayer && initialQuality != null) {
      publication.setPreferredLayer({ quality: initialQuality });
    }

    // Upgrade to HIGH quality after video is playing
    setTimeout(() => {
      if (element && element.videoWidth > 0 && targetQuality != null) {
        try {
          if (publication.setVideoQuality) {
            publication.setVideoQuality(targetQuality);
          }
          if (publication.setPreferredLayer) {
            publication.setPreferredLayer({ quality: targetQuality });
          }
        } catch {}
      }
    }, 2000);
  } catch {}
}

function ensureVideoSubscribed(publication, element) {
  if (!publication || !publication.setSubscribed) return;
  let attempts = 0;
  const check = () => {
    attempts += 1;
    if (!element.isConnected) return;
    if (element.videoWidth > 0 || element.videoHeight > 0) return;
    publication.setSubscribed(false);
    setTimeout(() => {
      publication.setSubscribed(true);
    }, 200);
    if (attempts < 3) {
      setTimeout(check, 2000);
    }
  };
  setTimeout(check, 2000);
}

function getTrackSid(publication, track, fallback) {
  return publication?.trackSid || track?.sid || fallback || null;
}

function attachVideoDiagnostics(track, element, overlay) {
  if (!element || !overlay) return;
  const mediaTrack = track?.mediaStreamTrack;
  let frames = 0;
  let lastFrames = 0;
  let lastTs = performance.now();
  element._lastFrameTs = performance.now();
  element._firstFrameTs = element._firstFrameTs || 0;
  let lastMediaTime = element.currentTime || 0;
  let blackStreak = 0;
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 9;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const detectBlack = () => {
    if (!ctx) return false;
    if (element.videoWidth <= 0 || element.videoHeight <= 0) return false;
    try {
      ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 16) {
        sum += data[i] + data[i + 1] + data[i + 2];
        count += 1;
      }
      const avg = count ? sum / (count * 3) : 0;
      if (avg < 3) {
        blackStreak += 1;
      } else {
        blackStreak = 0;
      }
    } catch {
      // ignore sampling errors
    }
    const isBlack = blackStreak >= 3;
    element._isBlack = isBlack;
    overlay.parentElement?.classList.toggle("is-black", isBlack);
    return isBlack;
  };

  const updateOverlay = () => {
    const now = performance.now();
    const currentTime = element.currentTime;
    if (currentTime !== lastMediaTime) {
      element._lastFrameTs = now;
      lastMediaTime = currentTime;
      if (!element._firstFrameTs && element.videoWidth > 0) {
        element._firstFrameTs = now;
      }
    }
    const elapsed = (now - lastTs) / 1000;
    const fps = elapsed > 0 ? (frames - lastFrames) / elapsed : 0;
    lastFrames = frames;
    lastTs = now;
    const w = element.videoWidth || 0;
    const h = element.videoHeight || 0;
    const ready = element.readyState;
    const muted = mediaTrack?.muted ? "muted" : "live";
    const isBlack = detectBlack();
    overlay.textContent = `${w}x${h} | fps ${fps.toFixed(1)} | ${muted} | rs ${ready}${isBlack ? " | black" : ""}`;
  };

  if (typeof element.requestVideoFrameCallback === "function") {
    const onFrame = () => {
      frames += 1;
      element._lastFrameTs = performance.now();
      if (!element._firstFrameTs) {
        element._firstFrameTs = element._lastFrameTs;
      }
      element.requestVideoFrameCallback(onFrame);
    };
    element.requestVideoFrameCallback(onFrame);
  }

  const timer = setInterval(updateOverlay, 1000);
  overlay.dataset.timer = String(timer);

  if (mediaTrack) {
    mediaTrack.onmute = () => {
      overlay.textContent = "track muted";
    };
    mediaTrack.onunmute = () => {
      overlay.textContent = "track unmuted";
    };
    mediaTrack.onended = () => {
      overlay.textContent = "track ended";
    };
  }
}

function cleanupVideoDiagnostics(overlay) {
  if (!overlay) return;
  const timer = Number(overlay.dataset.timer || 0);
  if (timer) clearInterval(timer);
}

function iconSvg(name) {
  if (name === "mic") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/>
      </svg>`;
  }
  if (name === "camera") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M17 10.5V6c0-1.1-.9-2-2-2H4C2.9 4 2 4.9 2 6v12c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2v-4.5l5 4v-11l-5 4z"/>
      </svg>`;
  }
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 5h18v14H3zM5 7v10h14V7H5zm2 12h10v2H7z"/>
    </svg>`;
}

const SOUNDBOARD_ICONS = [
  "\u{1F973}",
  "\u{1F389}",
  "\u{1F38A}",
  "\u{1F44F}",
  "\u{1F64C}",
  "\u{1F929}",
  "\u{1F60E}",
  "\u{1F60D}",
  "\u{1F618}",
  "\u{1F61C}",
  "\u{1F917}",
  "\u{1F642}",
  "\u{1F610}",
  "\u{1F928}",
  "\u{1F914}",
  "\u{1F9D0}",
  "\u{1F92A}",
  "\u{1F92B}",
  "\u{1F602}",
  "\u{1F923}",
  "\u{1F62D}",
  "\u{1F92F}",
  "\u{1F631}",
  "\u{1F621}",
  "\u{1F92C}",
  "\u{1F4A9}",
  "\u{1F4A5}",
  "\u{1F525}",
  "\u2728",
  "\u26A1",
  "\u{1F387}",
  "\u{1F386}",
  "\u{1F4A8}",
  "\u{1F31F}",
  "\u{1F308}",
  "\u2600\uFE0F",
  "\u26C5",
  "\u{1F9E8}",
  "\u{1F6A8}",
  "\u{1F4E3}",
  "\u{1F4E2}",
  "\u{1F514}",
  "\u{1F515}",
  "\u{1F50A}",
  "\u{1F3B5}",
  "\u{1F3B6}",
  "\u{1F3BA}",
  "\u{1F3B8}",
  "\u{1F941}",
  "\u{1F3BB}",
  "\u{1F3A4}",
  "\u{1F3A7}",
  "\u{1F4FB}",
  "\u{1F399}\uFE0F",
  "\u{1F3AC}",
  "\u{1F3AE}",
  "\u{1F3B2}",
  "\u{1F3AF}",
  "\u{1F37F}",
  "\u{1F95E}",
  "\u{1F355}",
  "\u{1F354}",
  "\u{1F35F}",
  "\u{1F953}",
  "\u{1F96A}",
  "\u{1F32E}",
  "\u{1F36A}",
  "\u{1F369}",
  "\u{1F36D}",
  "\u{1F36F}",
  "\u{1F37A}",
  "\u{1F942}",
  "\u{1F379}",
  "\u{1F4B8}",
  "\u{1F4B0}",
  "\u{1F4AF}",
  "\u{1F4A1}",
  "\u{1F9E0}",
  "\u{1F52A}",
  "\u{1F9EF}",
  "\u{1F9F8}",
  "\u{1F4CD}",
  "\u{1F680}",
  "\u{1F6F8}",
  "\u{1F9A0}",
  "\u{1F984}",
  "\u{1F4A7}",
  "\u{1F525}",
  "\u{1F30A}",
  "\u{1F31D}",
  "\u{1F31A}",
  "\u{1F4AB}",
  "\u{1F4A2}",
  "\u{1F6A5}",
  "\u{1F6B2}",
  "\u{1F3C6}",
  "\u{1F3C0}",
  "\u{26BD}",
  "\u{1F3C8}",
  "\u{1F3BE}",
  "\u{1F3D2}",
  "\u{1F9B5}",
  "\u{1F3C1}",
  "\u{1F3AF}",
  "\u{1F3A8}",
  "\u{1F3A5}",
  "\u{1F50C}",
  "\u{1F4AC}",
  "\u{1F4F1}",
  "\u{1F4BB}",
  "\u{1F5A5}",
  "\u{1F5A8}",
  "\u{1F4E1}",
  "\u{1F4F7}",
  "\u{1F4F9}",
  "\u{1F58A}",
  "\u{1F4DD}",
  "\u{1F3AE}",
  "\u{1F48E}",
  "\u{1F451}",
  "\u{1F48D}"
];

if (!soundboardSelectedIcon) {
  soundboardSelectedIcon = SOUNDBOARD_ICONS[0] ?? "\u{1F50A}";
}

function ensureParticipantCard(participant, isLocal = false) {
  const key = participant.identity;
  // Hide ghost subscriber from UI
  if (key.startsWith("__echo_ghost_")) return null;
  if (participantCards.has(key)) {
    debugLog(`participant card already exists for ${key}`);
    return participantCards.get(key);
  }
  debugLog(`creating NEW participant card for ${key}, isLocal=${isLocal}`);
  const card = document.createElement("div");
  card.className = "user-card";
  card.dataset.identity = key;

  const title = document.createElement("div");
  title.className = "user-name";
  title.textContent = participant.name || "Guest";
  card.append(title);

  const header = document.createElement("div");
  header.className = "user-header";
  const avatar = document.createElement("div");
  avatar.className = "user-avatar";
  avatar.textContent = getInitials(participant.name || participant.identity);
  if (isLocal) {
    avatar.classList.add("user-avatar-local");
    const avatarFileInput = document.createElement("input");
    avatarFileInput.type = "file";
    avatarFileInput.accept = "image/*";
    avatarFileInput.className = "hidden";
    avatarFileInput.addEventListener("change", async () => {
      const file = avatarFileInput.files?.[0];
      if (!file) return;
      await uploadAvatar(file);
      avatarFileInput.value = "";
    });
    avatar.appendChild(avatarFileInput);
    avatar.style.cursor = "pointer";
    avatar.title = "Click to upload avatar";
    avatar.addEventListener("click", (e) => {
      // If camera video is playing, go fullscreen
      const video = avatar.querySelector("video");
      if (video && video.videoWidth > 0) {
        enterVideoFullscreen(video);
        return;
      }
      avatarFileInput.click();
    });
  } else {
    // Remote users: click avatar video to fullscreen
    avatar.style.cursor = "pointer";
    avatar.addEventListener("click", () => {
      const video = avatar.querySelector("video");
      if (video && video.videoWidth > 0) {
        enterVideoFullscreen(video);
      }
    });
  }
  const meta = document.createElement("div");
  meta.className = "user-meta";
  let micIndicator = null;
  let screenIndicator = null;
  let micMuteButton = null;
  let screenMuteButton = null;
  let micSlider = null;
  let screenSlider = null;
  let micRow = null;
  let screenRow = null;
  if (!isLocal) {
    const indicators = document.createElement("div");
    indicators.className = "user-indicators";
    const micIndicatorRow = document.createElement("div");
    micIndicatorRow.className = "indicator-row";
    const screenIndicatorRow = document.createElement("div");
    screenIndicatorRow.className = "indicator-row";
    micIndicator = document.createElement("button");
    micIndicator.type = "button";
    micIndicator.className = "icon-button indicator-only";
    micIndicator.innerHTML = iconSvg("mic");
    micMuteButton = document.createElement("button");
    micMuteButton.type = "button";
    micMuteButton.className = "mute-button";
    micMuteButton.textContent = "Mute";
    screenIndicator = document.createElement("button");
    screenIndicator.type = "button";
    screenIndicator.className = "icon-button indicator-only";
    screenIndicator.innerHTML = iconSvg("screen");
    screenMuteButton = document.createElement("button");
    screenMuteButton.type = "button";
    screenMuteButton.className = "mute-button";
    screenMuteButton.textContent = "Mute";
    micIndicatorRow.append(micIndicator, micMuteButton);
    screenIndicatorRow.append(screenIndicator, screenMuteButton);
    var watchToggleBtn = document.createElement("button");
    watchToggleBtn.type = "button";
    watchToggleBtn.className = "watch-toggle-btn";
    watchToggleBtn.textContent = "Stop Watching";
    watchToggleBtn.style.display = "none";
    watchToggleBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      var identity = participant.identity;
      var pState = participantState.get(identity);
      if (hiddenScreens.has(identity)) {
        hiddenScreens.delete(identity);
        var tile = screenTileByIdentity.get(identity);
        if (tile) tile.style.display = "";
        // Unmute screen share audio
        if (pState && pState.screenAudioEls) {
          pState.screenAudioEls.forEach(function(el) { el.muted = false; });
        }
        watchToggleBtn.textContent = "Stop Watching";
      } else {
        hiddenScreens.add(identity);
        var tile = screenTileByIdentity.get(identity);
        if (tile) {
          if (tile.classList.contains("is-focused")) {
            tile.classList.remove("is-focused");
            screenGridEl.classList.remove("is-focused");
          }
          tile.style.display = "none";
        }
        // Mute screen share audio
        if (pState && pState.screenAudioEls) {
          pState.screenAudioEls.forEach(function(el) { el.muted = true; });
        }
        watchToggleBtn.textContent = "Start Watching";
      }
    });
    screenIndicatorRow.append(watchToggleBtn);
    // Admin-only: kick & mute buttons
    if (isAdminMode()) {
      var adminRow = document.createElement("div");
      adminRow.className = "admin-controls admin-only";
      var kickBtn = document.createElement("button");
      kickBtn.type = "button";
      kickBtn.className = "admin-kick-btn";
      kickBtn.textContent = "Kick";
      kickBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        adminKickParticipant(participant.identity);
      });
      var muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.className = "admin-mute-btn";
      muteBtn.textContent = "Server Mute";
      muteBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        adminMuteParticipant(participant.identity);
      });
      adminRow.append(muteBtn, kickBtn);
      indicators.append(adminRow);
    }
    indicators.append(micIndicatorRow, screenIndicatorRow);
    const audioControls = document.createElement("div");
    audioControls.className = "audio-controls";
    micRow = document.createElement("div");
    micRow.className = "audio-row hidden";
    const micLabel = document.createElement("span");
    micLabel.textContent = "Mic";
    micSlider = document.createElement("input");
    micSlider.type = "range";
    micSlider.min = "0";
    micSlider.max = "1";
    micSlider.step = "0.01";
    micSlider.value = "1";
    micRow.append(micLabel, micSlider);
    screenRow = document.createElement("div");
    screenRow.className = "audio-row hidden";
    const screenLabel = document.createElement("span");
    screenLabel.textContent = "Screen";
    screenSlider = document.createElement("input");
    screenSlider.type = "range";
    screenSlider.min = "0";
    screenSlider.max = "1";
    screenSlider.step = "0.01";
    screenSlider.value = "1";
    screenRow.append(screenLabel, screenSlider);
    audioControls.append(micRow, screenRow);
    meta.append(indicators, audioControls);
  }
  header.append(avatar, meta);
  card.append(header);

  let controls = null;
  let micStatusEl = micIndicator;
  let screenStatusEl = screenIndicator;
  if (isLocal) {
    controls = document.createElement("div");
    controls.className = "user-controls";
    const enableAll = document.createElement("button");
    enableAll.type = "button";
    enableAll.className = "enable-all";
    enableAll.textContent = "Enable All";
    enableAll.addEventListener("click", () => enableAllMedia().catch(() => {}));
    const row = document.createElement("div");
    row.className = "control-row";
    const micControl = document.createElement("button");
    micControl.type = "button";
    micControl.className = "icon-button";
    micControl.innerHTML = iconSvg("mic");
    micControl.addEventListener("click", () => toggleMic().catch(() => {}));
    const camControl = document.createElement("button");
    camControl.type = "button";
    camControl.className = "icon-button";
    camControl.innerHTML = iconSvg("camera");
    camControl.addEventListener("click", () => toggleCam().catch(() => {}));
    const screenControl = document.createElement("button");
    screenControl.type = "button";
    screenControl.className = "icon-button";
    screenControl.innerHTML = iconSvg("screen");
    screenControl.addEventListener("click", () => toggleScreen().catch(() => {}));
    row.append(micControl, camControl, screenControl);
    controls.append(enableAll, row);
    // Add watch toggle button for local user's own screen share
    var watchToggleBtn = document.createElement("button");
    watchToggleBtn.type = "button";
    watchToggleBtn.className = "watch-toggle-btn";
    watchToggleBtn.textContent = "Stop Watching";
    watchToggleBtn.style.display = "none";
    watchToggleBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      var identity = participant.identity;
      var pState = participantState.get(identity);
      if (hiddenScreens.has(identity)) {
        hiddenScreens.delete(identity);
        var tile = screenTileByIdentity.get(identity);
        if (tile) tile.style.display = "";
        if (pState && pState.screenAudioEls) {
          pState.screenAudioEls.forEach(function(el) { el.muted = false; });
        }
        watchToggleBtn.textContent = "Stop Watching";
      } else {
        hiddenScreens.add(identity);
        var tile = screenTileByIdentity.get(identity);
        if (tile) {
          if (tile.classList.contains("is-focused")) {
            tile.classList.remove("is-focused");
            screenGridEl.classList.remove("is-focused");
          }
          tile.style.display = "none";
        }
        if (pState && pState.screenAudioEls) {
          pState.screenAudioEls.forEach(function(el) { el.muted = true; });
        }
        watchToggleBtn.textContent = "Start Watching";
      }
    });
    controls.append(watchToggleBtn);
    meta.append(controls);
    micStatusEl = micControl;
    screenStatusEl = screenControl;
  }
  userListEl.appendChild(card);

  const state = {
    cameraTrackSid: null,
    screenTrackSid: null,
    micSid: null,
    screenAudioSid: null,
    micMuted: false,
    micVolume: 1,
    screenVolume: 1,
    micUserMuted: false,
    screenUserMuted: false,
    micAudioEls: new Set(),
    screenAudioEls: new Set(),
    micAnalyser: null,
    screenAnalyser: null,
    micLevel: 0,
    screenLevel: 0,
    micFloor: null,
    screenFloor: null,
    lastMicActive: 0,
    lastScreenActive: 0,
    micActive: false,
    micActiveStreak: 0,
    micInactiveStreak: 0,
    micFloorSamples: 0,
  };
  if (micIndicator && micRow) {
    micIndicator.addEventListener("click", () => {
      micRow.classList.toggle("hidden");
    });
  }
  if (screenIndicator && screenRow) {
    screenIndicator.addEventListener("click", () => {
      screenRow.classList.toggle("hidden");
    });
  }
  if (micMuteButton) {
    micMuteButton.addEventListener("click", () => {
      state.micUserMuted = !state.micUserMuted;
      micMuteButton.textContent = state.micUserMuted ? "Unmute" : "Mute";
      micMuteButton.classList.toggle("is-muted", state.micUserMuted);
      applyParticipantAudioVolumes(state);
      updateActiveSpeakerUi();
    });
  }
  if (screenMuteButton) {
    screenMuteButton.addEventListener("click", () => {
      state.screenUserMuted = !state.screenUserMuted;
      screenMuteButton.textContent = state.screenUserMuted ? "Unmute" : "Mute";
      screenMuteButton.classList.toggle("is-muted", state.screenUserMuted);
      applyParticipantAudioVolumes(state);
    });
  }
  if (micSlider) {
    micSlider.addEventListener("input", () => {
      state.micVolume = Number(micSlider.value);
      applyParticipantAudioVolumes(state);
    });
  }
  if (screenSlider) {
    screenSlider.addEventListener("input", () => {
      state.screenVolume = Number(screenSlider.value);
      applyParticipantAudioVolumes(state);
    });
  }

  participantCards.set(key, {
    card,
    avatar,
    isLocal,
    controls,
    micStatusEl,
    screenStatusEl,
    micSlider,
    screenSlider,
    micMuteButton,
    screenMuteButton,
    micRow,
    screenRow,
    watchToggleBtn: typeof watchToggleBtn !== "undefined" ? watchToggleBtn : null
  });
  participantState.set(key, state);
  debugLog(`participant card created and added to DOM for ${key}, card.isConnected=${card.isConnected}, avatar exists=${!!avatar}`);
  // Show avatar image if one exists for this user
  updateAvatarDisplay(key);
  return participantCards.get(key);
}

function resubscribeParticipantTracks(participant) {
  const pubs = getParticipantPublications(participant);
  if (!pubs.length) return;
  pubs.forEach((pub) => {
    if (pub?.setSubscribed) pub.setSubscribed(true);
    if (pub?.kind === getLiveKitClient()?.Track?.Kind?.Video) {
      requestVideoKeyFrame(pub, pub.track);
    }
    hookPublication(pub, participant);
  });
}

function attachParticipantTracks(participant) {
  const pubs = getParticipantPublications(participant);
  if (!pubs.length) return;
  pubs.forEach((pub) => {
    if (pub?.setSubscribed) pub.setSubscribed(true);
    hookPublication(pub, participant);
  });
}

function updateAvatarVideo(cardRef, track) {
  if (!cardRef || !cardRef.avatar) {
    debugLog(`ERROR: updateAvatarVideo called with invalid cardRef or avatar! cardRef=${!!cardRef}, avatar=${!!cardRef?.avatar}`);
    return;
  }
  const { avatar } = cardRef;
  // Preserve the hidden file input for local user avatar upload
  const fileInput = avatar.querySelector('input[type="file"]');
  avatar.innerHTML = "";
  if (fileInput) avatar.appendChild(fileInput);
  if (track) {
    const element = createLockedVideoElement(track);
    configureVideoElement(element, true);
    startBasicVideoMonitor(element);
    avatar.appendChild(element);
    debugLog(`video attached to avatar for track ${track.sid || 'unknown'}`);
  } else {
    avatar.textContent = getInitials(cardRef.card.querySelector(".user-name")?.textContent || "");
    if (fileInput) avatar.appendChild(fileInput);
    // Show avatar image if one exists (replaces initials)
    const identity = cardRef.card?.dataset?.identity;
    if (identity) updateAvatarDisplay(identity);
  }
}

async function uploadAvatar(file) {
  if (!adminToken || !room?.localParticipant) return;
  const identityBase = getIdentityBase(room.localParticipant.identity);

  // GIFs: upload raw file to preserve animation. Others: resize to 160x160 via canvas.
  let uploadBlob;
  let uploadMime;
  if (file.type === "image/gif") {
    uploadBlob = file;
    uploadMime = "image/gif";
  } else {
    uploadMime = "image/jpeg";
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.src = url;
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 160;
    const ctx = canvas.getContext("2d");
    const size = Math.min(img.width, img.height);
    const sx = (img.width - size) / 2;
    const sy = (img.height - size) / 2;
    ctx.drawImage(img, sx, sy, size, size, 0, 0, 160, 160);
    URL.revokeObjectURL(url);
    uploadBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!uploadBlob) { debugLog("Avatar: canvas.toBlob returned null"); return; }
  }

  try {
    const res = await fetch(apiUrl(`/api/avatar/upload?identity=${encodeURIComponent(identityBase)}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": uploadMime
      },
      body: uploadBlob
    });
    const data = await res.json().catch(() => ({}));
    debugLog("Avatar upload response: " + JSON.stringify(data));
    if (data?.ok && data?.url) {
      const relativePath = data.url + "?t=" + Date.now(); // relative path for storage/broadcast
      const avatarUrl = apiUrl(data.url) + "?t=" + Date.now(); // full URL for local rendering
      avatarUrls.set(identityBase, avatarUrl);
      echoSet("echo-avatar-" + identityBase, relativePath); // store relative, not absolute

      // Update own card
      updateAvatarDisplay(room.localParticipant.identity);

      // Broadcast relative path so remote users resolve via their own server
      broadcastAvatar(identityBase, relativePath);

      debugLog("Avatar uploaded for " + identityBase + ", url=" + avatarUrl);
    } else {
      debugLog("Avatar upload NOT ok: " + JSON.stringify(data));
    }
  } catch (e) {
    debugLog("Avatar upload failed: " + e.message);
  }
}

function updateAvatarDisplay(identity) {
  const cardRef = participantCards.get(identity);
  if (!cardRef) return;
  const avatar = cardRef.avatar;
  if (!avatar) return;

  // If camera is active and showing video, don't change
  const video = avatar.querySelector("video");
  if (video && video.videoWidth > 0 && !video.paused) return;

  const identityBase = getIdentityBase(identity);
  const avatarUrl = avatarUrls.get(identityBase);

  if (avatarUrl) {
    // Show avatar image
    let img = avatar.querySelector("img.avatar-img");
    if (!img) {
      // Clear initials text nodes
      const textNodes = Array.from(avatar.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
      textNodes.forEach(n => n.remove());

      img = document.createElement("img");
      img.className = "avatar-img";
      img.alt = "Avatar";
      avatar.appendChild(img);
    }
    img.src = avatarUrl;
  } else {
    // No avatar -- show initials (current behavior)
    const img = avatar.querySelector("img.avatar-img");
    if (img) img.remove();
  }
}

function broadcastAvatar(identityBase, avatarUrl) {
  if (!room?.localParticipant) return;
  const msg = JSON.stringify({ type: "avatar-update", identityBase, avatarUrl });
  try {
    room.localParticipant.publishData(new TextEncoder().encode(msg), { reliable: true });
  } catch (e) {
    debugLog("Avatar broadcast failed: " + e.message);
  }
}

function scheduleCameraRecovery(identity, cardRef, publication) {
  if (!identity || !cardRef || !publication) return;
  const key = `${identity}-camera`;
  const attempt = cameraRecoveryAttempts.get(key) || 0;
  if (attempt >= 2) return;
  setTimeout(() => {
    const video = cardRef.avatar.querySelector("video");
    if (!video || !video.isConnected) return;
    const lastFrame = video._lastFrameTs || 0;
    const stalled = performance.now() - lastFrame > 1400;
    const isBlack = video._isBlack === true;
    const noSize = video.videoWidth === 0 || video.videoHeight === 0;
    if (!stalled && !isBlack && !noSize) return;
    cameraRecoveryAttempts.set(key, attempt + 1);
    if (publication?.setSubscribed) {
      publication.setSubscribed(false);
      setTimeout(() => publication.setSubscribed(true), 300);
    }
    if (publication?.track) {
      updateAvatarVideo(cardRef, publication.track);
      const next = cardRef.avatar.querySelector("video");
      if (next) {
        ensureVideoPlays(publication.track, next);
        ensureVideoSubscribed(publication, next);
        requestVideoKeyFrame(publication, publication.track);
      }
    }
  }, 900);
}

function ensureCameraVideo(cardRef, track, publication) {
  if (!cardRef || !track) {
    debugLog(`ERROR: ensureCameraVideo called with invalid params! cardRef=${!!cardRef}, track=${!!track}`);
    return;
  }
  const cardIdentity = cardRef.card?.dataset?.identity || 'unknown';
  debugLog(`ensureCameraVideo called for track ${track.sid || 'unknown'}, participant=${cardIdentity}, cardRef.avatar=${!!cardRef.avatar}`);
  const existing = cardRef.avatar.querySelector("video");
  if (existing && existing._lkTrack === track) {
    ensureVideoPlays(track, existing);
    ensureVideoSubscribed(publication, existing);
    const age = performance.now() - (existing._attachedAt || 0);
    if (age > 1500 && (existing.videoWidth === 0 || existing.videoHeight === 0)) {
      updateAvatarVideo(cardRef, track);
      const next = cardRef.avatar.querySelector("video");
      if (next) {
        ensureVideoPlays(track, next);
        ensureVideoSubscribed(publication, next);
        requestVideoKeyFrame(publication, track);
      }
    }
    scheduleCameraRecovery(cardRef.card?.dataset?.identity || "", cardRef, publication);
    return;
  }
  updateAvatarVideo(cardRef, track);
  const video = cardRef.avatar.querySelector("video");
  if (video) {
    ensureVideoPlays(track, video);
    ensureVideoSubscribed(publication, video);
    requestVideoKeyFrame(publication, track);
    scheduleCameraRecovery(cardRef.card?.dataset?.identity || "", cardRef, publication);
  }
}

function reconcileParticipantMedia(participant) {
  const LK = getLiveKitClient();
  if (!participant || !participant.tracks) return;
  const cardRef = ensureParticipantCard(participant);
  const pubs = getParticipantPublications(participant);
  pubs.forEach((pub) => {
    if (!pub) return;
    if (pub.setSubscribed) pub.setSubscribed(true);
    const source = pub.source;
    const track = pub.track;
    if (!track) return;
    if (pub.kind === LK?.Track?.Kind?.Video && source === LK.Track.Source.ScreenShare) {
      const trackSid = getTrackSid(pub, track, `${participant.identity}-screen`);
      const existingTile = trackSid ? screenTileBySid.get(trackSid) : null;
      if (!existingTile) {
        handleTrackSubscribed(track, pub, participant);
        return;
      }
      const video = existingTile.querySelector("video");
      if (video && video._isBlack && performance.now() - (video._lastFrameTs || 0) > 1200) {
        replaceScreenVideoElement(existingTile, track, pub);
      }
      return;
    }
    if (pub.kind === LK?.Track?.Kind?.Video && source === LK.Track.Source.Camera) {
      ensureCameraVideo(cardRef, track, pub);
      return;
    }
    if (pub.kind === LK?.Track?.Kind?.Audio) {
      const audioSid = getTrackSid(pub, track, `${participant.identity}-${source || "audio"}`);
      if (audioSid && audioElBySid.has(audioSid)) return;
      handleTrackSubscribed(track, pub, participant);
    }
  });
}

function runFullReconcile(reason) {
  if (!room) return;
  if (room.remoteParticipants?.forEach) {
    room.remoteParticipants.forEach((participant) => reconcileParticipantMedia(participant));
  }
  // Diagnostic: log remote participants and their screen share status
  if (room.remoteParticipants?.size > 0) {
    const LK = getLiveKitClient();
    const parts = [];
    room.remoteParticipants.forEach((p) => {
      const pubs = getParticipantPublications(p);
      const screenPub = pubs.find(pub => pub?.source === LK?.Track?.Source?.ScreenShare && pub?.kind === LK?.Track?.Kind?.Video);
      const hasTile = screenTileByIdentity.has(p.identity);
      if (screenPub) {
        parts.push(`${p.identity}: screen=${screenPub.isSubscribed ? "sub" : "unsub"} track=${screenPub.track ? "yes" : "no"} tile=${hasTile}`);
      }
    });
    if (parts.length > 0) {
      debugLog("[reconcile] remote screens: " + parts.join(", "));
    }
  }
}

function scheduleReconcileWaves(reason) {
  if (reconcilePending) {
    const timer = setTimeout(() => runFullReconcile(reason), 400);
    reconcileTimers.add(timer);
    return;
  }
  reconcilePending = true;
  const delays = [150, 600, 1500, 3000];
  delays.forEach((delay) => {
    const timer = setTimeout(() => runFullReconcile(reason), delay);
    reconcileTimers.add(timer);
  });
  const resetTimer = setTimeout(() => {
    reconcilePending = false;
  }, 3200);
  reconcileTimers.add(resetTimer);
}

function resetRemoteSubscriptions(reason) {
  if (!room || !room.remoteParticipants) return;
  const now = performance.now();
  if (now - lastSubscriptionReset < 3500) return;
  lastSubscriptionReset = now;
  const LK = getLiveKitClient();
  const participants = room.remoteParticipants.values
    ? Array.from(room.remoteParticipants.values())
    : Array.from(room.remoteParticipants);
  participants.forEach((participant) => {
    const pubs = getParticipantPublications(participant);
    pubs.forEach((pub) => {
      if (!pub?.setSubscribed) return;
      if (pub.kind === LK?.Track?.Kind?.Video) {
        pub.setSubscribed(false);
        setTimeout(() => {
          pub.setSubscribed(true);
          requestVideoKeyFrame(pub, pub.track);
        }, 220);
      }
    });
  });
}

function startMediaReconciler() {
  scheduleReconcileWaves("start");
}

function stopMediaReconciler() {
  reconcileTimers.forEach((timer) => clearTimeout(timer));
  reconcileTimers.clear();
  reconcilePending = false;
}

function stopAudioMonitor() {
  if (!audioMonitorTimer) return;
  clearInterval(audioMonitorTimer);
  audioMonitorTimer = null;
}

function applyParticipantAudioVolumes(state) {
  if (!state) return;
  const micVolume = roomAudioMuted || state.micUserMuted ? 0 : state.micVolume;
  state.micAudioEls.forEach((el) => {
    el.volume = micVolume;
  });
  const screenVolume = roomAudioMuted || state.screenUserMuted ? 0 : state.screenVolume;
  state.screenAudioEls.forEach((el) => {
    el.volume = screenVolume;
  });
}

function updateActiveSpeakerUi() {
  participantCards.forEach((cardRef, identity) => {
    const micEl = cardRef.micStatusEl;
    const state = participantState.get(identity);
    const muted = state?.micMuted || state?.micUserMuted || (cardRef.isLocal && !micEnabled);
    if (micEl) {
      micEl.classList.toggle("is-muted", !!muted);
      if (muted) {
        micEl.classList.remove("is-active");
      } else {
        const hasRecentActiveSpeakers = performance.now() - lastActiveSpeakerEvent < 1500;
        const remoteActive = hasRecentActiveSpeakers ? activeSpeakerIds.has(identity) : Boolean(state?.micActive);
        const localActive = Boolean(state?.micActive);
        const active = cardRef.isLocal ? localActive : remoteActive;
        micEl.classList.toggle("is-active", active);
      }
    }
  });

  // Update Camera Lobby speaking indicators
  updateCameraLobbySpeakingIndicators();
}

function startAudioMonitor() {
  if (audioMonitorTimer) return;
  audioMonitorTimer = setInterval(() => {
    const now = performance.now();
    participantCards.forEach((cardRef, identity) => {
      const state = participantState.get(identity);
      if (!state) return;
      const micMuted = state.micMuted || state.micUserMuted || (cardRef.isLocal && !micEnabled);
      const micRaw = micMuted || !state.micAnalyser ? 0 : state.micAnalyser.calculateVolume();
      const screenRaw = !state.screenAnalyser ? 0 : state.screenAnalyser.calculateVolume();
      if (state.micAnalyser) resumeAnalyser(state.micAnalyser);
      if (state.screenAnalyser) resumeAnalyser(state.screenAnalyser);

      if (micMuted || !state.micAnalyser) {
        state.micLevel = 0;
        state.micActive = false;
        state.micActiveStreak = 0;
        state.micInactiveStreak = 0;
        state.micFloor = 0;
        state.micFloorSamples = 0;
      } else {
        if (!Number.isFinite(state.micLevel)) state.micLevel = micRaw;
        state.micLevel = state.micLevel * 0.7 + micRaw * 0.3;
        if (state.micFloor == null || state.micFloorSamples < 20) {
          const prev = state.micFloor ?? 0;
          const samples = state.micFloorSamples ?? 0;
          state.micFloor = (prev * samples + state.micLevel) / (samples + 1);
          state.micFloorSamples = samples + 1;
        } else {
          state.micFloor = Math.min(state.micFloor * 0.98 + state.micLevel * 0.02, state.micLevel);
        }
      }
      state.screenLevel = (state.screenLevel || 0) * 0.6 + screenRaw * 0.4;

      if (state.screenFloor == null) state.screenFloor = state.screenLevel;
      if (state.screenLevel < state.screenFloor) {
        state.screenFloor = state.screenFloor * 0.9 + state.screenLevel * 0.1;
      } else {
        state.screenFloor = state.screenFloor * 0.995 + state.screenLevel * 0.005;
      }

      const micThreshold = Math.max(0.015, (state.micFloor || 0) + 0.012);
      const screenThreshold = Math.max(0.03, state.screenFloor * 1.8 + 0.008);

      if (!micMuted && state.micAnalyser) {
        if (state.micLevel >= micThreshold) {
          state.lastMicActive = now;
        }
        const activeWindow = now - (state.lastMicActive || 0);
        state.micActive = activeWindow < 120;
      }
      if (state.screenLevel > screenThreshold) state.lastScreenActive = now;
      // mic indicator now driven by analyser gate + hysteresis
      const screenEl = cardRef.screenStatusEl;
      if (screenEl) {
        const active = now - (state.lastScreenActive || 0) < 350;
        screenEl.classList.toggle("is-active", active);
      }
    });
    updateActiveSpeakerUi();
  }, AUDIO_MONITOR_INTERVAL);
}

function handleTrackSubscribed(track, publication, participant) {
  const LK = getLiveKitClient();
  const source = publication?.source || track.source;
  const cardRef = ensureParticipantCard(participant);
  const handleKey = track.kind === "video" ? `${participant.identity}-${source || track.kind}` : getTrackSid(publication, track, `${participant.identity}-${source || track.kind}`);

  // Check if recently handled, but also verify track is actually displayed
  if (handleKey && wasRecentlyHandled(handleKey)) {
    let isActuallyDisplayed = false;

    // For screen shares, check if the track is actually rendering
    if (track.kind === "video" && source === LK.Track.Source.ScreenShare) {
      const screenTrackSid = publication?.trackSid || track?.sid || null;
      const existingTile = screenTileByIdentity.get(participant.identity) || (screenTrackSid ? screenTileBySid.get(screenTrackSid) : null);
      if (existingTile) {
        const videoEl = existingTile.querySelector("video");
        // Consider displayed if: video exists + connected + right track + (playing OR attached very recently)
        const recentlyAttached = videoEl?._attachedAt && (performance.now() - videoEl._attachedAt) < 2000;
        isActuallyDisplayed = !!(videoEl && videoEl.isConnected && videoEl._lkTrack === track && (recentlyAttached || (!videoEl.paused && videoEl.readyState >= 2)));
      }
    }
    // For camera tracks, check if the track is actually rendering
    else if (track.kind === "video" && source === LK.Track.Source.Camera) {
      const camTrackSid = publication?.trackSid || track?.sid || null;
      if (camTrackSid && cameraVideoBySid.has(camTrackSid)) {
        const videoEl = cameraVideoBySid.get(camTrackSid);
        // Consider displayed if: video exists + connected + right track + (playing OR attached very recently)
        const recentlyAttached = videoEl?._attachedAt && (performance.now() - videoEl._attachedAt) < 2000;
        isActuallyDisplayed = !!(videoEl && videoEl.isConnected && videoEl._lkTrack === track && (recentlyAttached || (!videoEl.paused && videoEl.readyState >= 2)));
      }
    }
    // For audio tracks, check if audio element actually exists
    else if (track.kind === "audio") {
      const audioSid = getTrackSid(publication, track, `${participant.identity}-${source || "audio"}`);
      const audioEl = audioElBySid.get(audioSid);
      isActuallyDisplayed = !!(audioEl && audioEl.isConnected && audioEl._lkTrack === track);
      if (!isActuallyDisplayed) {
        debugLog(`audio track ${audioSid} not actually displayed - will reprocess`);
      }
    }
    // For other tracks, assume displayed if recently handled
    else {
      isActuallyDisplayed = true;
    }

    if (!isActuallyDisplayed) {
      // Track was "handled" but not displayed - process it anyway
      debugLog(`track recently handled but not displayed: ${handleKey} - processing anyway`);
      markHandled(handleKey);
    } else {
      // Track is displayed, safe to skip
      debugLog(`skipping duplicate track subscription for ${handleKey} (already displayed)`);
      return;
    }
  } else {
    markHandled(handleKey);
  }
  if (publication?.setSubscribed) {
    publication.setSubscribed(true);
  }
  if (track.kind === "video") {
    requestVideoKeyFrame(publication, track);
    setTimeout(() => requestVideoKeyFrame(publication, track), 500);
  }
  if (track.kind === "video" && source === LK.Track.Source.ScreenShare) {
    const identity = participant.identity;
    const screenTrackSid = publication?.trackSid || track?.sid || null;
    const existingTile = screenTileByIdentity.get(identity) || (screenTrackSid ? screenTileBySid.get(screenTrackSid) : null);
    if (existingTile && existingTile.isConnected) {
      const existingVideo = existingTile.querySelector("video");
      if (cardRef && cardRef.watchToggleBtn) {
        cardRef.watchToggleBtn.style.display = "";
        cardRef.watchToggleBtn.textContent = hiddenScreens.has(identity) ? "Start Watching" : "Stop Watching";
      }
      // If same track and has frames OR was attached recently, just ensure it plays
      const recentlyAttached = existingVideo?._attachedAt && (performance.now() - existingVideo._attachedAt) < 3000;
      if (existingVideo && existingVideo._lkTrack === track && (existingVideo.videoWidth > 0 || recentlyAttached)) {
        ensureVideoPlays(track, existingVideo);
        ensureVideoSubscribed(publication, existingVideo);
        forceVideoLayer(publication, existingVideo);
        return;
      }
      // Different track or stale — replace video element in existing tile (don't recreate tile)
      replaceScreenVideoElement(existingTile, track, publication);
      if (screenTrackSid) {
        existingTile.dataset.trackSid = screenTrackSid;
        screenTileBySid.set(screenTrackSid, existingTile);
      }
      screenTileByIdentity.set(identity, existingTile);
      return;
    }
    // Clean up stale references if tile was removed from DOM
    if (existingTile && !existingTile.isConnected) {
      screenTileByIdentity.delete(identity);
      if (screenTrackSid) screenTileBySid.delete(screenTrackSid);
    }
    clearScreenTracksForIdentity(participant.identity, screenTrackSid);
    const label = `${participant.name || "Guest"} (Screen)`;
    const element = createLockedVideoElement(track);
    configureVideoElement(element, true);
    if (track?.mediaStreamTrack) {
      track.mediaStreamTrack.onunmute = () => {
        requestVideoKeyFrame(publication, track);
        ensureVideoPlays(track, element);
      };
    }
    ensureVideoPlays(track, element);
    kickStartScreenVideo(publication, track, element);
    requestVideoKeyFrame(publication, track);
    setTimeout(() => requestVideoKeyFrame(publication, track), 200);
    setTimeout(() => requestVideoKeyFrame(publication, track), 600);
    const tile = addScreenTile(label, element, screenTrackSid);
    debugLog("[screen-tile] CREATED for " + participant.identity + " trackSid=" + screenTrackSid + " label=" + label);
    ensureVideoSubscribed(publication, element);
    if (screenTrackSid) {
      registerScreenTrack(screenTrackSid, publication, tile, participant.identity);
      scheduleScreenRecovery(screenTrackSid, publication, element);
      screenResubscribeIntent.delete(screenTrackSid);
    }
    screenTileByIdentity.set(participant.identity, tile);
    // Screen share is opt-in: hide by default for remote participants
    var isLocal = room && room.localParticipant && participant.identity === room.localParticipant.identity;
    if (!isLocal && !hiddenScreens.has(participant.identity)) {
      // First time seeing this screen — default to hidden (opt-in)
      hiddenScreens.add(participant.identity);
    }
    if (hiddenScreens.has(participant.identity)) {
      tile.style.display = "none";
    }
    if (cardRef && cardRef.watchToggleBtn) {
      cardRef.watchToggleBtn.style.display = "";
      cardRef.watchToggleBtn.textContent = hiddenScreens.has(participant.identity) ? "Start Watching" : "Stop Watching";
    }
    participantState.get(participant.identity).screenTrackSid = screenTrackSid;
    forceVideoLayer(publication, element);
    return;
  }
  if (track.kind === "video" && source === LK.Track.Source.Camera) {
    const camTrackSid = publication?.trackSid || track?.sid || null;
    if (camTrackSid && cameraVideoBySid.has(camTrackSid)) {
      const existingVideo = cameraVideoBySid.get(camTrackSid);
      if (existingVideo && existingVideo.isConnected && existingVideo._lkTrack === track) {
        ensureVideoPlays(track, existingVideo);
        ensureVideoSubscribed(publication, existingVideo);
        forceVideoLayer(publication, existingVideo);
        return;
      }
    }
    if (track?.mediaStreamTrack) {
      track.mediaStreamTrack.onunmute = () => {
        requestVideoKeyFrame(publication, track);
        ensureCameraVideo(cardRef, track, publication);
      };
    }
    ensureCameraVideo(cardRef, track, publication);
    participantState.get(participant.identity).cameraTrackSid = camTrackSid || getTrackSid(publication, track, `${participant.identity}-camera`);
    const camEl = cardRef?.avatar?.querySelector("video");
    if (!camEl) {
      debugLog(`ERROR: camera video element not found for ${participant.identity} after ensureCameraVideo`);
      debugLog(`  cardRef: ${!!cardRef}, avatar: ${!!cardRef?.avatar}, trackSid: ${camTrackSid}`);
    }
    forceVideoLayer(publication, camEl);
    if (camTrackSid && camEl) {
      cameraVideoBySid.set(camTrackSid, camEl);
      debugLog(`camera video registered in map: ${participant.identity} sid=${camTrackSid}`);
    }
    setTimeout(() => {
      if (camEl) {
        debugLog(`camera size ${participant.identity} ${camEl.videoWidth}x${camEl.videoHeight} muted=${track.mediaStreamTrack?.muted ?? "?"}`);
      }
    }, 900);
    return;
  }
  if (track.kind === "audio") {
    const audioSid = getTrackSid(publication, track, `${participant.identity}-${source || "audio"}`);
    if (audioSid && audioElBySid.has(audioSid)) {
      return;
    }
    // Create audio element — use track.attach() then verify srcObject
    const element = track.attach();
    element._lkTrack = track;
    // Safety: ensure srcObject is set (some SDK versions may not set it immediately)
    if (!element.srcObject && track.mediaStreamTrack) {
      element.srcObject = new MediaStream([track.mediaStreamTrack]);
    }
    element.volume = 1.0;
    // Append to DOM FIRST, then configure and play (some browsers need element in DOM)
    audioBucketEl.appendChild(element);
    // Apply selected speaker device BEFORE playing so audio routes correctly from the start
    if (selectedSpeakerId && typeof element.setSinkId === "function") {
      element.setSinkId(selectedSpeakerId).catch(() => {});
    }
    configureAudioElement(element);
    ensureAudioPlays(element);
    // Re-trigger play when track's mediaStreamTrack unmutes (first data arrives)
    if (track.mediaStreamTrack) {
      track.mediaStreamTrack.addEventListener("unmute", () => {
        debugLog(`audio track unmuted ${participant.identity} src=${source}`);
        ensureAudioPlays(element);
      });
    }
    debugLog(`audio element created: ${participant.identity} src=${source} sid=${audioSid} srcObj=${!!element.srcObject} mst=${!!track.mediaStreamTrack} mstEnabled=${track.mediaStreamTrack?.enabled} mstMuted=${track.mediaStreamTrack?.muted}`);
    if (audioSid) {
      audioElBySid.set(audioSid, element);
    }
    const state = participantState.get(participant.identity);
    if (source === LK.Track.Source.ScreenShareAudio) {
      state.screenAudioSid = getTrackSid(publication, track, `${participant.identity}-screen-audio`);
      state.screenAudioEls.add(element);
      // Mute screen audio if user has unwatched this screen share
      if (hiddenScreens.has(participant.identity)) {
        element.muted = true;
      }
      if (!state.screenAnalyser && LK?.createAudioAnalyser) {
        state.screenAnalyser = LK.createAudioAnalyser(track);
        resumeAnalyser(state.screenAnalyser);
      }
    } else {
      state.micSid = getTrackSid(publication, track, `${participant.identity}-mic`);
      state.micMuted = publication?.isMuted || false;
      state.micAudioEls.add(element);
      if (!state.micAnalyser && LK?.createAudioAnalyser) {
        state.micAnalyser = LK.createAudioAnalyser(track);
        resumeAnalyser(state.micAnalyser);
      }
      updateActiveSpeakerUi();
    }
    applyParticipantAudioVolumes(state);
    applySpeakerToMedia().catch(() => {});
    try {
      room?.startAudio?.();
    } catch {}
  }
}

function handleTrackUnsubscribed(track, publication, participant) {
  const LK = getLiveKitClient();
  const source = publication?.source || track.source;
  const trackSid = getTrackSid(
    publication,
    track,
    participant ? `${participant.identity}-${source || track.kind}` : null
  );
  const intentTs = trackSid ? screenResubscribeIntent.get(trackSid) : null;
  const suppressRemoval = intentTs && performance.now() - intentTs < 5000;
  if (trackSid) {
    screenRecoveryAttempts.delete(trackSid);
  }
  if (track.kind === "video" && source === LK.Track.Source.ScreenShare) {
    const identity = participant?.identity;
    const tile = trackSid ? screenTileBySid.get(trackSid) : null;
    if (!suppressRemoval && tile && tile.dataset.trackSid === trackSid) {
      removeScreenTile(trackSid);
      unregisterScreenTrack(trackSid);
      if (identity) screenTileByIdentity.delete(identity);
      if (trackSid) screenResubscribeIntent.delete(trackSid);
    }
    if (identity) {
      hiddenScreens.delete(identity);
      var cardRef2 = participantCards.get(identity);
      if (cardRef2 && cardRef2.watchToggleBtn) {
        cardRef2.watchToggleBtn.style.display = "none";
        cardRef2.watchToggleBtn.textContent = "Stop Watching";
      }
    }
  } else if (track.kind === "video" && source === LK.Track.Source.Camera) {
    const identity = participant?.identity;
    const cardRef = identity ? participantCards.get(identity) : null;
    if (trackSid) cameraVideoBySid.delete(trackSid);
    if (identity) {
      const pubs = participant ? getParticipantPublications(participant) : [];
      const hasCam = pubs.some((pub) => pub?.source === LK.Track.Source.Camera && pub.track);
      if (hasCam) {
        debugLog(`camera unsubscribe ignored ${identity} (active cam present)`);
        return;
      }
      const existingTimer = cameraClearTimers.get(identity);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        cameraClearTimers.delete(identity);
        const state = participantState.get(identity);
        const latestPubs = participant ? getParticipantPublications(participant) : [];
        const activeCam = latestPubs.find((pub) => pub?.source === LK.Track.Source.Camera && pub.track);
        if (activeCam?.track) {
          debugLog(`camera clear aborted ${identity} (cam returned)`);
          return;
        }
        if (cardRef) {
          updateAvatarVideo(cardRef, null);
        }
        if (state) state.cameraTrackSid = null;
        debugLog(`camera cleared ${identity} after unsubscribe`);
      }, 800);
      cameraClearTimers.set(identity, timer);
    } else if (cardRef) {
      updateAvatarVideo(cardRef, null);
    }
  } else if (track.kind === "audio") {
    const audioEl = audioElBySid.get(trackSid);
    // Grace period for screen share audio: delay removal to survive SDP renegotiations
    if (source === LK.Track.Source.ScreenShareAudio && audioEl && participant) {
      debugLog(`screen share audio unsubscribe ${participant.identity} sid=${trackSid} — delaying removal`);
      const identity = participant.identity;
      setTimeout(() => {
        // Check if a new audio element was created for this track in the meantime
        const currentEl = audioElBySid.get(trackSid);
        if (currentEl === audioEl) {
          // Still the same element — check if participant still has screen share audio
          const pState = participantState.get(identity);
          const pubs = participant.trackPublications ? Array.from(participant.trackPublications.values()) : [];
          const hasScreenAudio = pubs.some((pub) => pub?.source === LK.Track.Source.ScreenShareAudio && pub.track && pub.isSubscribed);
          if (!hasScreenAudio) {
            debugLog(`screen share audio removed after grace period: ${identity} sid=${trackSid}`);
            audioEl.remove();
            audioElBySid.delete(trackSid);
            if (pState) {
              pState.screenAudioEls.delete(audioEl);
              if (pState.screenAnalyser?.cleanup) pState.screenAnalyser.cleanup();
              pState.screenAnalyser = null;
            }
          } else {
            debugLog(`screen share audio kept (track returned): ${identity} sid=${trackSid}`);
          }
        }
      }, 2000);
      return; // Don't remove yet
    }
    if (audioEl) {
      audioEl.remove();
      audioElBySid.delete(trackSid);
    }
    if (participant) {
      const state = participantState.get(participant.identity);
      if (state) {
        if (source === LK.Track.Source.ScreenShareAudio) {
          state.screenAudioEls.delete(audioEl);
          if (state.screenAnalyser?.cleanup) {
            state.screenAnalyser.cleanup();
          }
          state.screenAnalyser = null;
        } else {
          state.micAudioEls.delete(audioEl);
          state.micMuted = true;
          if (state.micAnalyser?.cleanup) {
            state.micAnalyser.cleanup();
          }
          state.micAnalyser = null;
          updateActiveSpeakerUi();
        }
      }
    }
  }
  const el = track.detach();
  el.forEach((node) => node.parentElement?.remove());
}

function setPublishButtonsEnabled(enabled) {
  micBtn.disabled = !enabled;
  camBtn.disabled = !enabled;
  screenBtn.disabled = !enabled;
  // Device selects stay enabled so users can choose devices before connecting
}

function renderPublishButtons() {
  micBtn.textContent = micEnabled ? "Disable Mic" : "Enable Mic";
  camBtn.textContent = camEnabled ? "Disable Camera" : "Enable Camera";
  screenBtn.textContent = screenEnabled ? "Stop Sharing" : "Share Screen";
  micBtn.classList.toggle("is-on", micEnabled);
  camBtn.classList.toggle("is-on", camEnabled);
  screenBtn.classList.toggle("is-on", screenEnabled);
}

function setSelectOptions(select, items, placeholder) {
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.appendChild(empty);
  const kindLabels = { audioinput: "Microphone", videoinput: "Camera", audiooutput: "Speaker" };
  items.forEach((item, i) => {
    const option = document.createElement("option");
    option.value = item.deviceId;
    option.textContent = item.label || `${kindLabels[item.kind] || item.kind} ${i + 1}`;
    select.appendChild(option);
  });
}

async function ensureDevicePermissions() {
  let gotAudio = false;
  let gotVideo = false;

  // Request audio and video separately so one failing doesn't block the other.
  // macOS WKWebView (Tauri on Mac) can reject combined requests if either
  // device type is unavailable or permission is denied.
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioStream.getTracks().forEach((t) => t.stop());
    gotAudio = true;
  } catch (err) {
    debugLog("[devices] audio permission denied or unavailable: " + err.message);
  }

  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
    videoStream.getTracks().forEach((t) => t.stop());
    gotVideo = true;
  } catch (err) {
    debugLog("[devices] video permission denied or unavailable: " + err.message);
  }

  if (!gotAudio && !gotVideo) {
    setDeviceStatus("Device permissions denied or no devices found.", true);
    return false;
  }
  if (!gotAudio) {
    setDeviceStatus("Microphone unavailable — check permissions or connection.");
  } else if (!gotVideo) {
    setDeviceStatus("Camera unavailable — audio devices loaded.");
  }
  return true;
}

async function refreshDevices() {
  if (!window.isSecureContext) {
    setDeviceStatus("Device access requires HTTPS or localhost.", true);
    return;
  }
  if (!navigator.mediaDevices?.enumerateDevices) {
    setDeviceStatus("Device enumeration not supported.", true);
    return;
  }
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    setDeviceStatus("Unable to enumerate devices. Check browser permissions.", true);
    return;
  }
  const mics = devices.filter((d) => d.kind === "audioinput");
  const cams = devices.filter((d) => d.kind === "videoinput");
  const speakers = devices.filter((d) => d.kind === "audiooutput");

  // Detect macOS permission-denied scenario: devices exist but all have empty labels
  const allLabelsEmpty = devices.length > 0 && devices.every((d) => !d.label);
  if (allLabelsEmpty) {
    debugLog("[devices] enumerateDevices returned " + devices.length + " devices but all labels are empty (permissions not granted)");
  }

  setSelectOptions(micSelect, mics, "Default mic");
  setSelectOptions(camSelect, cams, "Default camera");
  setSelectOptions(speakerSelect, speakers, "Default output");
  // Restore saved device selections from localStorage if not already set
  if (!selectedMicId) {
    selectedMicId = echoGet("echo-device-mic") || "";
  }
  if (!selectedCamId) {
    selectedCamId = echoGet("echo-device-cam") || "";
  }
  if (!selectedSpeakerId) {
    selectedSpeakerId = echoGet("echo-device-speaker") || "";
  }
  // Apply selections — only if the saved device still exists in the dropdown
  if (selectedMicId) {
    const opt = Array.from(micSelect.options).find(o => o.value === selectedMicId);
    if (opt) micSelect.value = selectedMicId;
    else selectedMicId = "";
  }
  if (selectedCamId) {
    const opt = Array.from(camSelect.options).find(o => o.value === selectedCamId);
    if (opt) camSelect.value = selectedCamId;
    else selectedCamId = "";
  }
  if (selectedSpeakerId) {
    const opt = Array.from(speakerSelect.options).find(o => o.value === selectedSpeakerId);
    if (opt) speakerSelect.value = selectedSpeakerId;
    else selectedSpeakerId = "";
  }
  if (allLabelsEmpty) {
    setDeviceStatus("Devices detected but permissions not granted. On Mac: System Settings \u2192 Privacy & Security \u2192 Microphone/Camera, then restart the app.", true);
  } else if (!mics.length && !cams.length) {
    setDeviceStatus("No audio or video devices found. Check permissions.");
  } else if (!mics.length) {
    setDeviceStatus("No microphones found — check permissions or connection.");
  } else if (!cams.length) {
    // Camera-less is common (e.g. desktops without webcam) — not an error
    setDeviceStatus("");
  } else {
    setDeviceStatus("");
  }
}

async function applySpeakerToMedia() {
  const audioEls = audioBucketEl.querySelectorAll("audio");
  if (selectedSpeakerId) {
    audioEls.forEach((el) => {
      if (typeof el.setSinkId === "function") {
        el.setSinkId(selectedSpeakerId).catch(() => {});
      }
    });
  }
  if (soundboardContext) {
    await applySoundboardOutputDevice();
  }
}

function resumeAnalyser(analyserObj) {
  try {
    const ctx = analyserObj?.analyser?.context;
    if (ctx && typeof ctx.resume === "function" && ctx.state !== "running") {
      ctx.resume().catch(() => {});
    }
  } catch {}
}

async function switchMic(deviceId) {
  selectedMicId = deviceId || "";
  echoSet("echo-device-mic", selectedMicId);
  if (!room || !micEnabled) return;
  // Tear down existing noise cancellation before switching
  disableNoiseCancellation();
  await room.localParticipant.setMicrophoneEnabled(true, { deviceId: selectedMicId || undefined });
  // Re-apply noise cancellation to new mic track
  if (noiseCancelEnabled) {
    try { await enableNoiseCancellation(); } catch (e) {
      debugLog("[noise-cancel] Could not re-apply after mic switch: " + (e.message || e));
    }
  }
}

async function switchCam(deviceId) {
  selectedCamId = deviceId || "";
  echoSet("echo-device-cam", selectedCamId);
  if (!room || !camEnabled) return;
  await room.localParticipant.setCameraEnabled(true, { deviceId: selectedCamId || undefined });
}

async function switchSpeaker(deviceId) {
  selectedSpeakerId = deviceId || "";
  echoSet("echo-device-speaker", selectedSpeakerId);
  await applySpeakerToMedia();
}

function setSoundboardHint(text, isError = false) {
  if (!soundboardHint) return;
  soundboardHint.textContent = text ?? "";
  soundboardHint.classList.toggle("is-error", Boolean(isError));
}

function updateSoundboardEditControls() {
  if (!soundUploadButton || !soundCancelEditButton) return;
  const isEditing = Boolean(soundboardEditingId);
  soundUploadButton.textContent = isEditing ? "Save" : "Upload";
  soundCancelEditButton.classList.toggle("hidden", !isEditing);
  if (soundFileInput) {
    soundFileInput.disabled = isEditing;
  }
  if (soundFileLabel) {
    if (isEditing) {
      soundFileLabel.textContent = "Audio locked";
      soundFileLabel.title = "Audio cannot be changed after upload.";
    } else {
      const file = soundFileInput?.files?.[0];
      soundFileLabel.textContent = file ? "Change audio" : "Select audio";
      soundFileLabel.title = file?.name || "";
    }
  }
}

function updateSoundboardVolumeUi() {
  const vol = String(soundboardUserVolume);
  const pct = `${Math.round(soundboardUserVolume)}%`;
  if (soundboardVolumeInput) soundboardVolumeInput.value = vol;
  if (soundboardVolumeInputEdit) soundboardVolumeInputEdit.value = vol;
  if (soundboardVolumeValue) soundboardVolumeValue.textContent = pct;
  if (soundboardVolumeValueEdit) soundboardVolumeValueEdit.textContent = pct;
  updateSoundboardMasterGain();
}

function updateSoundClipVolumeUi(value) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric) ? Math.min(200, Math.max(0, numeric)) : 100;
  if (soundClipVolumeInput) {
    soundClipVolumeInput.value = String(normalized);
  }
  if (soundClipVolumeValue) {
    soundClipVolumeValue.textContent = `${Math.round(normalized)}%`;
  }
}

function updateSoundboardMasterGain() {
  if (!soundboardMasterGain) return;
  const base = roomAudioMuted ? 0 : soundboardUserVolume / 100;
  soundboardMasterGain.gain.value = Math.max(0, base);
}

async function applySoundboardOutputDevice() {
  if (!soundboardContext) return;
  const sinkId = selectedSpeakerId && selectedSpeakerId.length > 0 ? selectedSpeakerId : "default";
  if (typeof soundboardContext.setSinkId === "function") {
    try {
      await soundboardContext.setSinkId(sinkId);
    } catch {
      // ignore
    }
  }
}

function getSoundboardContext() {
  if (soundboardContext && soundboardMasterGain) return soundboardContext;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  soundboardContext = new AudioCtx();
  soundboardMasterGain = soundboardContext.createGain();
  soundboardMasterGain.connect(soundboardContext.destination);
  updateSoundboardMasterGain();
  void applySoundboardOutputDevice();
  return soundboardContext;
}

function stopSoundboardPlayback() {
  if (!soundboardCurrentSource) return;
  try {
    soundboardCurrentSource.stop();
  } catch {
    // ignore
  }
  soundboardCurrentSource = null;
}

function primeSoundboardAudio() {
  const ctx = getSoundboardContext();
  if (!ctx) return;
  try {
    const p = ctx.resume();
    if (p && typeof p.catch === "function") {
      p.catch(() => {});
    }
  } catch {
    // ignore
  }
}

async function fetchSoundboardBuffer(soundId) {
  if (soundboardBufferCache.has(soundId)) {
    return soundboardBufferCache.get(soundId);
  }
  const ctx = getSoundboardContext();
  if (!ctx || !currentAccessToken) return null;
  const res = await fetch(apiUrl(`/api/soundboard/file/${encodeURIComponent(soundId)}`), {
    headers: {
      Authorization: `Bearer ${currentAccessToken}`
    }
  });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const decoded = await ctx.decodeAudioData(buf.slice(0));
  soundboardBufferCache.set(soundId, decoded);
  return decoded;
}

async function playSoundboardSound(soundId) {
  const ctx = getSoundboardContext();
  if (!ctx || !soundboardMasterGain) return;
  const sound = soundboardSounds.get(soundId);
  if (!sound) return;
  const buffer = await fetchSoundboardBuffer(soundId);
  if (!buffer) {
    setSoundboardHint("Unable to play sound.", true);
    return;
  }
  stopSoundboardPlayback();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const clipGain = ctx.createGain();
  const clipVolume = Number.isFinite(sound.volume) ? sound.volume : 100;
  clipGain.gain.value = Math.max(0, clipVolume / 100);
  source.connect(clipGain);
  clipGain.connect(soundboardMasterGain);
  source.onended = () => {
    if (soundboardCurrentSource === source) {
      soundboardCurrentSource = null;
    }
  };
  soundboardCurrentSource = source;
  try {
    source.start(0);
  } catch {
    // ignore
  }
}

function upsertSoundboardSound(sound) {
  if (!sound || !sound.id) return;
  soundboardSounds.set(sound.id, sound);
  // Re-render whichever view is visible
  if (soundboardCompactPanel && !soundboardCompactPanel.classList.contains("hidden")) {
    renderSoundboardCompact();
  }
  if (soundboardPanel && !soundboardPanel.classList.contains("hidden")) {
    renderSoundboard();
  }
}

function renderSoundboardIconPicker() {
  if (!soundboardIconGrid) return;
  soundboardIconGrid.innerHTML = "";
  SOUNDBOARD_ICONS.forEach((icon) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = icon;
    if (icon === soundboardSelectedIcon) {
      btn.classList.add("is-selected");
    }
    btn.addEventListener("click", () => {
      soundboardSelectedIcon = icon;
      renderSoundboardIconPicker();
    });
    soundboardIconGrid.appendChild(btn);
  });
}

function toggleSoundboardFavorite(soundId) {
  const idx = soundboardFavorites.indexOf(soundId);
  if (idx >= 0) {
    soundboardFavorites.splice(idx, 1);
    debugLog("[soundboard] Unfavorited: " + soundId);
  } else {
    soundboardFavorites.push(soundId);
    debugLog("[soundboard] Favorited: " + soundId);
  }
  echoSet("echo-soundboard-favorites", JSON.stringify(soundboardFavorites));
  renderAllSoundboardViews();
}

function saveSoundboardOrder(orderedIds) {
  soundboardCustomOrder = orderedIds;
  echoSet("echo-soundboard-order", JSON.stringify(soundboardCustomOrder));
}

function sortSoundboardSounds(sounds) {
  const favSet = new Set(soundboardFavorites);
  const favs = [];
  const rest = [];
  sounds.forEach((s) => (favSet.has(s.id) ? favs : rest).push(s));
  // Sort each group by custom order if available
  const orderMap = new Map();
  soundboardCustomOrder.forEach((id, i) => orderMap.set(id, i));
  const bySavedOrder = (a, b) => {
    const ai = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
    const bi = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;
    return ai - bi;
  };
  favs.sort(bySavedOrder);
  rest.sort(bySavedOrder);
  return [...favs, ...rest];
}

function getSoundboardSoundsFiltered(query) {
  return Array.from(soundboardSounds.values()).filter((sound) => {
    if (soundboardLoadedRoomId && sound.roomId && sound.roomId !== soundboardLoadedRoomId) return false;
    if (!query) return true;
    const name = (sound.name || "").toLowerCase();
    return name.includes(query);
  });
}

function attachSoundboardDragDrop(el, sound, gridEl, selectorClass, rerenderFn) {
  const favSet = new Set(soundboardFavorites);
  el.addEventListener("dragstart", (e) => {
    soundboardDragId = sound.id;
    el.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", sound.id);
  });
  el.addEventListener("dragend", () => {
    soundboardDragId = null;
    el.classList.remove("is-dragging");
    gridEl.querySelectorAll("." + selectorClass + ".drag-over").forEach((x) => x.classList.remove("drag-over"));
  });
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (soundboardDragId && soundboardDragId !== sound.id) {
      el.classList.add("drag-over");
    }
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("drag-over");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (!soundboardDragId || soundboardDragId === sound.id) return;
    // Unrestricted reorder — any sound can be dragged to any position
    const children = Array.from(gridEl.querySelectorAll("[data-sound-id]"));
    const ids = children.map((t) => t.dataset.soundId);
    const fromIdx = ids.indexOf(soundboardDragId);
    const toIdx = ids.indexOf(sound.id);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, soundboardDragId);
    debugLog("[soundboard] Reordered sounds");
    saveSoundboardOrder(ids);
    rerenderFn();
  });
}

function renderSoundboardCompact() {
  if (!soundboardCompactGrid) return;
  const sounds = getSoundboardSoundsFiltered("");
  soundboardCompactGrid.innerHTML = "";
  if (sounds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.style.gridColumn = "1 / -1";
    empty.style.fontSize = "11px";
    empty.textContent = "No sounds yet.";
    soundboardCompactGrid.appendChild(empty);
    return;
  }
  const sorted = sortSoundboardSounds(sounds);
  const favSet = new Set(soundboardFavorites);

  sorted.forEach((sound) => {
    const btn = document.createElement("div");
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.className = "sound-icon-btn";
    btn.dataset.soundId = sound.id;
    btn.draggable = true;
    btn.setAttribute("draggable", "true");
    btn.dataset.soundName = sound.name || "Sound";
    btn.textContent = sound.icon || "\u{1F50A}";
    btn.addEventListener("mouseenter", function() { showSoundTooltip(btn, btn.dataset.soundName); });
    btn.addEventListener("mouseleave", hideSoundTooltip);
    if (favSet.has(sound.id)) {
      btn.classList.add("is-favorite");
    }
    btn.addEventListener("click", () => {
      if (!room) return;
      primeSoundboardAudio();
      playSoundboardSound(sound.id).catch(() => {});
      sendSoundboardMessage({ type: "sound-play", soundId: sound.id });
    });
    attachSoundboardDragDrop(btn, sound, soundboardCompactGrid, "sound-icon-btn", renderAllSoundboardViews);
    soundboardCompactGrid.appendChild(btn);
  });
}

function renderSoundboard() {
  if (!soundboardGrid) return;
  const query = (soundSearchInput?.value ?? "").trim().toLowerCase();
  const sounds = getSoundboardSoundsFiltered(query);
  soundboardGrid.innerHTML = "";
  if (sounds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No sounds yet. Upload one below.";
    soundboardGrid.appendChild(empty);
    return;
  }
  const sorted = sortSoundboardSounds(sounds);
  const favSet = new Set(soundboardFavorites);

  sorted.forEach((sound) => {
    const tile = document.createElement("div");
    tile.className = "sound-tile";
    tile.dataset.soundId = sound.id;
    tile.draggable = true;
    tile.setAttribute("draggable", "true");
    if (sound.id === soundboardEditingId) {
      tile.classList.add("is-editing");
    }
    if (favSet.has(sound.id)) {
      tile.classList.add("is-favorite");
    }

    // --- Favorite button ---
    const favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "sound-fav" + (favSet.has(sound.id) ? " is-active" : "");
    favBtn.title = favSet.has(sound.id) ? "Remove from favorites" : "Add to favorites";
    favBtn.draggable = false;
    favBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
    favBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSoundboardFavorite(sound.id);
    });
    favBtn.addEventListener("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });

    const main = document.createElement("div");
    main.className = "sound-tile-main";
    main.draggable = false;
    const iconEl = document.createElement("div");
    iconEl.className = "sound-icon";
    iconEl.draggable = false;
    iconEl.textContent = sound.icon || "\u{1F50A}";
    const nameEl = document.createElement("div");
    nameEl.className = "sound-name";
    nameEl.draggable = false;
    nameEl.textContent = sound.name || "Sound";
    main.append(iconEl, nameEl);
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "sound-edit";
    editBtn.draggable = false;
    editBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
      </svg>`;
    editBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      enterSoundboardEditMode(sound);
    });
    editBtn.addEventListener("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });
    tile.append(favBtn, main, editBtn);
    tile.addEventListener("click", () => {
      if (!room) return;
      primeSoundboardAudio();
      playSoundboardSound(sound.id).catch(() => {});
      sendSoundboardMessage({ type: "sound-play", soundId: sound.id });
    });

    // --- Drag and drop (unrestricted) ---
    attachSoundboardDragDrop(tile, sound, soundboardGrid, "sound-tile", renderAllSoundboardViews);

    soundboardGrid.appendChild(tile);
  });
}

function renderAllSoundboardViews() {
  renderSoundboardCompact();
  renderSoundboard();
}

function enterSoundboardEditMode(sound) {
  if (!sound) return;
  soundboardEditingId = sound.id;
  if (soundNameInput) soundNameInput.value = sound.name || "";
  soundboardSelectedIcon = sound.icon || "\u{1F50A}";
  renderSoundboardIconPicker();
  updateSoundClipVolumeUi(sound.volume ?? 100);
  updateSoundboardEditControls();
  const iconsSection = document.getElementById("soundboard-icons-section");
  if (iconsSection) iconsSection.classList.remove("hidden");
  setSoundboardHint(`Editing "${sound.name ?? "Sound"}". Update name/icon/volume and click Save.`);
  renderSoundboard();
}

function exitSoundboardEditMode() {
  soundboardEditingId = null;
  if (soundNameInput) soundNameInput.value = "";
  if (soundFileInput) soundFileInput.value = "";
  soundboardSelectedIcon = SOUNDBOARD_ICONS[0] ?? "\u{1F50A}";
  updateSoundClipVolumeUi(soundboardClipVolume);
  updateSoundboardEditControls();
  const iconsSection = document.getElementById("soundboard-icons-section");
  if (iconsSection) iconsSection.classList.add("hidden");
  renderSoundboard();
}

function openSoundboard() {
  if (!soundboardCompactPanel) return;
  soundboardEditingId = null;
  // Reset compact volume panel
  if (soundboardVolumePanelCompact) {
    soundboardVolumePanelCompact.classList.add("hidden");
    soundboardVolumePanelCompact.setAttribute("aria-hidden", "true");
  }
  updateSoundboardVolumeUi();
  // Make sure edit mode is hidden, show compact
  if (soundboardPanel) soundboardPanel.classList.add("hidden");
  // Position compact panel directly below the Soundboard button
  const btn = openSoundboardButton;
  if (btn) {
    const rect = btn.getBoundingClientRect();
    soundboardCompactPanel.style.top = (rect.bottom + 6) + "px";
    soundboardCompactPanel.style.right = (window.innerWidth - rect.right) + "px";
  }
  soundboardCompactPanel.classList.remove("hidden");
  if (currentRoomName) {
    void loadSoundboardList();
  }
  renderSoundboardCompact();
  primeSoundboardAudio();
}

function closeSoundboard() {
  // Close both compact and edit views
  if (soundboardCompactPanel) soundboardCompactPanel.classList.add("hidden");
  if (soundboardPanel) {
    soundboardPanel.classList.add("hidden");
    soundboardEditingId = null;
    updateSoundboardEditControls();
    setSoundboardHint("");
  }
}

function openSoundboardEdit() {
  if (!soundboardPanel) return;
  // Hide compact, show edit
  if (soundboardCompactPanel) soundboardCompactPanel.classList.add("hidden");
  soundboardEditingId = null;
  if (soundboardVolumePanel) {
    soundboardVolumePanel.classList.add("hidden");
    soundboardVolumePanel.setAttribute("aria-hidden", "true");
  }
  updateSoundboardVolumeUi();
  updateSoundClipVolumeUi(soundboardClipVolume);
  soundboardSelectedIcon = soundboardSelectedIcon || SOUNDBOARD_ICONS[0] || "\u{1F50A}";
  renderSoundboardIconPicker();
  updateSoundboardEditControls();
  soundboardPanel.classList.remove("hidden");
  renderSoundboard();
}

function closeSoundboardEdit() {
  // Hide edit, return to compact
  if (soundboardPanel) {
    soundboardPanel.classList.add("hidden");
    soundboardEditingId = null;
    updateSoundboardEditControls();
    setSoundboardHint("");
  }
  if (soundboardCompactPanel) {
    soundboardCompactPanel.classList.remove("hidden");
    renderSoundboardCompact();
  }
}

// Camera Lobby Management
let enlargedCameraTile = null;

function openCameraLobby() {
  if (!cameraLobbyPanel) return;
  cameraLobbyPanel.classList.remove("hidden");
  populateCameraLobby();
  debugLog('Camera Lobby opened');
}

function closeCameraLobby() {
  if (!cameraLobbyPanel) return;
  cameraLobbyPanel.classList.add("hidden");
  enlargedCameraTile = null;
  debugLog('Camera Lobby closed');
}

function populateCameraLobby() {
  if (!cameraLobbyGrid || !room) return;

  cameraLobbyGrid.innerHTML = '';

  const allParticipants = [room.localParticipant, ...Array.from(room.remoteParticipants.values())];
  let count = 0;

  allParticipants.forEach(participant => {
    const tile = createCameraTile(participant);
    if (tile) {
      cameraLobbyGrid.appendChild(tile);
      count++;
    }
  });

  cameraLobbyGrid.dataset.count = Math.min(count, 6);
}

function createCameraTile(participant) {
  if (!participant) return null;

  const tile = document.createElement('div');
  tile.className = 'camera-lobby-tile';
  tile.dataset.identity = participant.identity;

  // Get camera track if available
  const LK = getLiveKitClient();
  const cameraPublication = Array.from(participant.trackPublications.values()).find(
    pub => pub.source === LK.Track.Source.Camera && pub.kind === LK.Track.Kind.Video
  );

  const cameraTrack = cameraPublication?.track;

  // Only create tile if participant has an active camera
  if (!cameraTrack || !cameraTrack.mediaStreamTrack) {
    return null;
  }

  // Create video element for camera
  const video = createLockedVideoElement(cameraTrack);
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'contain';
  configureVideoElement(video, true);
  startBasicVideoMonitor(video);
  tile.appendChild(video);

  // Add name label
  const nameLabel = document.createElement('div');
  nameLabel.className = 'name-label';
  nameLabel.textContent = participant.name || participant.identity;
  if (participant === room.localParticipant) {
    nameLabel.textContent += ' (You)';
  }
  tile.appendChild(nameLabel);

  // Add click to enlarge functionality
  tile.addEventListener('click', () => toggleEnlargeTile(tile));

  return tile;
}

function toggleEnlargeTile(tile) {
  if (!tile) return;

  if (enlargedCameraTile === tile) {
    // Un-enlarge
    tile.classList.remove('enlarged');
    enlargedCameraTile = null;
  } else {
    // Enlarge this tile, un-enlarge any other
    if (enlargedCameraTile) {
      enlargedCameraTile.classList.remove('enlarged');
    }
    tile.classList.add('enlarged');
    enlargedCameraTile = tile;
  }
}

function updateCameraLobbySpeakingIndicators() {
  if (!cameraLobbyGrid || cameraLobbyPanel.classList.contains('hidden')) return;

  const tiles = cameraLobbyGrid.querySelectorAll('.camera-lobby-tile');
  tiles.forEach(tile => {
    const identity = tile.dataset.identity;
    if (!identity) return;

    const state = participantState.get(identity);
    const isSpeaking = state?.micActive || false;

    if (isSpeaking) {
      tile.classList.add('speaking');
    } else {
      tile.classList.remove('speaking');
    }
  });
}

function clearSoundboardState() {
  soundboardLoadedRoomId = null;
  soundboardEditingId = null;
  soundboardSounds.clear();
  soundboardBufferCache.clear();
  if (soundboardGrid) soundboardGrid.innerHTML = "";
  if (soundboardCompactGrid) soundboardCompactGrid.innerHTML = "";
  updateSoundboardEditControls();
  stopSoundboardPlayback();
  setSoundboardHint("");
  closeSoundboard();
}

async function loadSoundboardList() {
  if (!currentAccessToken) return;
  const roomId = currentRoomName;
  soundboardLoadedRoomId = roomId;
  try {
    const res = await fetch(apiUrl(`/api/soundboard/list?roomId=${encodeURIComponent(roomId)}`), {
      headers: {
        Authorization: `Bearer ${currentAccessToken}`
      }
    });
    if (!res.ok) {
      if (soundboardPanel && !soundboardPanel.classList.contains("hidden")) {
        setSoundboardHint("Unable to load soundboard.", true);
      }
      return;
    }
    const data = await res.json().catch(() => ({}));
    soundboardSounds.clear();
    (data?.sounds || []).forEach((sound) => {
      if (sound?.id) soundboardSounds.set(sound.id, sound);
    });
    if (soundboardCompactPanel && !soundboardCompactPanel.classList.contains("hidden")) {
      renderSoundboardCompact();
    }
    if (soundboardPanel && !soundboardPanel.classList.contains("hidden")) {
      renderSoundboard();
    }
  } catch {
    if (soundboardPanel && !soundboardPanel.classList.contains("hidden")) {
      setSoundboardHint("Unable to load soundboard.", true);
    }
  }
}

async function uploadSoundboardSound() {
  if (soundboardEditingId) {
    await updateSoundboardSound();
    return;
  }
  if (!currentAccessToken) {
    setSoundboardHint("Join a room first.", true);
    return;
  }
  const file = soundFileInput?.files?.[0];
  if (!file) {
    setSoundboardHint("Select an audio file first.", true);
    return;
  }
  const rawName = (soundNameInput?.value ?? "").trim();
  const defaultName = file.name ? file.name.replace(/\.[^/.]+$/, "") : "";
  const name = (rawName || defaultName || "Sound").slice(0, 60);
  const icon = soundboardSelectedIcon || "\u{1F50A}";
  const volumeRaw = Number(soundClipVolumeInput?.value ?? soundboardClipVolume);
  const volume = Number.isFinite(volumeRaw) ? Math.min(200, Math.max(0, Math.round(volumeRaw))) : 100;

  setSoundboardHint("Uploading...");

  try {
    const qs = new URLSearchParams({
      roomId: currentRoomName,
      name,
      icon,
      volume: String(volume)
    });
    const res = await fetch(apiUrl(`/api/soundboard/upload?${qs.toString()}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentAccessToken}`,
        "Content-Type": file.type && file.type.length > 0 ? file.type : "application/octet-stream"
      },
      body: file
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      setSoundboardHint(data?.error || "Upload failed.", true);
      return;
    }
    if (data?.sound) {
      upsertSoundboardSound(data.sound);
      sendSoundboardMessage({ type: "sound-added", sound: data.sound });
    }
    if (soundNameInput) soundNameInput.value = "";
    if (soundFileInput) soundFileInput.value = "";
    updateSoundboardEditControls();
    const iconsSection = document.getElementById("soundboard-icons-section");
    if (iconsSection) iconsSection.classList.add("hidden");
    setSoundboardHint("Uploaded!");
  } catch {
    setSoundboardHint("Upload failed.", true);
  }
}

async function updateSoundboardSound() {
  if (!currentAccessToken || !soundboardEditingId) {
    setSoundboardHint("Join a room first.", true);
    return;
  }
  const rawName = (soundNameInput?.value ?? "").trim();
  const name = (rawName || "Sound").slice(0, 60);
  const icon = soundboardSelectedIcon || "\u{1F50A}";
  const soundId = soundboardEditingId;
  const volumeRaw = Number(soundClipVolumeInput?.value ?? 100);
  const volume = Number.isFinite(volumeRaw) ? Math.min(200, Math.max(0, Math.round(volumeRaw))) : 100;

  setSoundboardHint("Saving...");
  try {
    const res = await fetch(apiUrl("/api/soundboard/update"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        roomId: currentRoomName,
        soundId,
        name,
        icon,
        volume
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      setSoundboardHint(data?.error || "Save failed.", true);
      return;
    }
    if (data?.sound) {
      upsertSoundboardSound(data.sound);
      sendSoundboardMessage({ type: "sound-updated", sound: data.sound });
    }
    exitSoundboardEditMode();
    setSoundboardHint("Saved!");
  } catch {
    setSoundboardHint("Save failed.", true);
  }
}

function sendSoundboardMessage(message) {
  if (!room || !message) return;
  const payload = JSON.stringify(message);
  const encoder = new TextEncoder();
  try {
    room.localParticipant.publishData(encoder.encode(payload), { reliable: true });
  } catch {
    // ignore
  }
}

async function connectToRoom({ controlUrl, sfuUrl, roomId, identity, name, reuseAdmin }) {
  if (!controlUrl || !sfuUrl) {
    setStatus("Enter control URL and SFU URL.", true);
    return;
  }
  if (!reuseAdmin) {
    const password = passwordInput.value;
    if (!password) {
      setStatus("Enter admin password.", true);
      return;
    }
    adminToken = await fetchAdminToken(controlUrl, password);
  }

  setStatus("Requesting token...");
  const seq = ++connectSequence;
  if (!reuseAdmin) {
    // First connect: ensure room exists (not needed for subsequent switches of fixed rooms)
    await ensureRoomExists(controlUrl, adminToken, roomId);
  }
  // Disconnect old room ASAP to reduce perceived lag
  if (room) {
    room.disconnect();
    clearMedia();
    clearSoundboardState();
  }
  if (seq !== connectSequence) return; // a newer connect started, bail
  const accessToken = await fetchRoomToken(controlUrl, adminToken, roomId, identity, name);
  if (seq !== connectSequence) return;
  currentAccessToken = accessToken;

  setStatus("Connecting to SFU...");

  // ── SDP munging: Force high bandwidth to prevent BWE starvation ──
  // Chrome BWE starts at ~300kbps and probes up. If the SFU answer caps bandwidth
  // (b=AS or b=TIAS), Chrome never probes higher. We munge BOTH local and remote
  // descriptions to set 8Mbps bandwidth and add x-google bitrate hints.
  if (!window._sdpMungingInstalled) {
    window._sdpMungingInstalled = true;

    function _mungeSDPBandwidth(sdp) {
      const lines = sdp.split("\r\n");
      const result = [];
      let inVideo = false;
      let addedBW = false;
      for (const line of lines) {
        if (line.startsWith("m=video")) { inVideo = true; addedBW = false; }
        else if (line.startsWith("m=")) { inVideo = false; }
        // Remove existing bandwidth lines in video section
        if (inVideo && (line.startsWith("b=AS:") || line.startsWith("b=TIAS:"))) continue;
        result.push(line);
        // Add our bandwidth right after c= line in video section
        if (inVideo && line.startsWith("c=") && !addedBW) {
          result.push("b=AS:10000");
          result.push("b=TIAS:10000000");
          addedBW = true;
        }
      }
      return result.join("\r\n");
    }

    function _addH264BitrateHints(sdp) {
      // Upgrade H264 profile level to at least 4.2 (0x2A) for 1080p@60fps.
      // Level 4.0 (0x28) caps at 30fps for 1080p (245,760 max MBps / 8,160 MBs = 30fps).
      // Level 4.2 (0x2A) allows 64fps at 1080p (522,240 max MBps).
      sdp = sdp.replace(/profile-level-id=([0-9a-fA-F]{4})([0-9a-fA-F]{2})/g, function(match, profile, level) {
        const lvl = parseInt(level, 16);
        if (lvl < 0x2A) {
          debugLog("[SDP] H264 level " + level + " -> 2A (4.0->4.2 for 60fps)");
          return "profile-level-id=" + profile + "2A";
        }
        return match;
      });

      // Add max-fr=60 to H264 fmtp lines
      const h264Matches = sdp.matchAll(/a=rtpmap:(\d+) H264\/90000/g);
      for (const m of h264Matches) {
        const pt = m[1];
        const re = new RegExp(`(a=fmtp:${pt} [^\\r\\n]*)`, "g");
        if (re.test(sdp)) {
          sdp = sdp.replace(new RegExp(`(a=fmtp:${pt} [^\\r\\n]*)`, "g"),
            "$1;x-google-start-bitrate=6000;x-google-min-bitrate=4000;x-google-max-bitrate=8000;max-fr=60");
        }
      }
      return sdp;
    }

    // Hook createOffer to catch SDP before LiveKit passes it anywhere
    const _origCreateOffer = RTCPeerConnection.prototype.createOffer;
    RTCPeerConnection.prototype.createOffer = async function(...args) {
      const offer = await _origCreateOffer.apply(this, args);
      if (offer && offer.sdp) {
        offer.sdp = _addH264BitrateHints(_mungeSDPBandwidth(offer.sdp));
        debugLog("[SDP] OFFER munged: b=AS:8000 + H264 hints");
      }
      return offer;
    };

    const _origSLD = RTCPeerConnection.prototype.setLocalDescription;
    RTCPeerConnection.prototype.setLocalDescription = function(desc, ...args) {
      if (desc && desc.sdp) {
        desc = { type: desc.type, sdp: _addH264BitrateHints(_mungeSDPBandwidth(desc.sdp)) };
        debugLog("[SDP] LOCAL munged");
      } else if (!desc) {
        debugLog("[SDP] WARNING: implicit setLocalDescription (no SDP to munge)");
      }
      return _origSLD.apply(this, [desc, ...args]);
    };

    const _origSRD = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function(desc, ...args) {
      if (desc && desc.sdp) {
        // Apply bandwidth AND H264 level upgrade to SFU answer too
        desc = { type: desc.type, sdp: _addH264BitrateHints(_mungeSDPBandwidth(desc.sdp)) };
        debugLog("[SDP] REMOTE munged: bandwidth + H264 level upgrade");
      }
      return _origSRD.apply(this, [desc, ...args]);
    };

    // Override addTransceiver to force 60fps from creation.
    // LiveKit SDK defaults screen share to 15fps (h1080fps15 preset).
    // Chrome may not allow setParameters() to override maxFramerate set in addTransceiver.
    const _origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
    RTCPeerConnection.prototype.addTransceiver = function(trackOrKind, init, ...args) {
      if (init && init.sendEncodings) {
        for (const enc of init.sendEncodings) {
          if (typeof enc.maxFramerate === "number" && enc.maxFramerate < 60) {
            debugLog("[TRANSCEIVER] Overriding maxFramerate " + enc.maxFramerate + " -> 60");
            enc.maxFramerate = 60;
          }
          // Don't override bitrate — let it adapt. Only ensure high initial ceiling.
          if (typeof enc.maxBitrate === "number" && enc.maxBitrate < 3000000) {
            enc.maxBitrate = 10000000;
          }
        }
      }
      return _origAddTransceiver.apply(this, [trackOrKind, init, ...args]);
    };

    debugLog("SDP + transceiver overrides installed (60fps, 8Mbps, b=AS:8000)");
  }

  const LK = getLiveKitClient();
  if (!LK || !LK.Room) {
    throw new Error("LiveKit client failed to load. Please refresh and try again.");
  }
  room = new LK.Room({
    adaptiveStream: false,
    dynacast: false,
    autoSubscribe: true,
    videoCaptureDefaults: {
      resolution: { width: 1920, height: 1080, frameRate: 60 },
    },
    publishDefaults: {
      simulcast: true,
      videoCodec: "h264",
      videoEncoding: { maxBitrate: 5_000_000, maxFramerate: 60 },
      videoSimulcastLayers: [
        { width: 960, height: 540, encoding: { maxBitrate: 2_000_000, maxFramerate: 30 } },
      ],
      screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 60 },
      dtx: true,
      degradationPreference: "maintain-resolution",
    },
  });
  try {
    if (typeof room.startAudio === "function") {
      room.startAudio().catch(() => {});
    }
  } catch {}
  if (LK.RoomEvent?.ConnectionStateChanged) {
    room.on(LK.RoomEvent.ConnectionStateChanged, (state) => {
      if (!state) return;
      if (state === "disconnected") {
        setStatus(`Connection: ${state}`, true);
      } else {
        setStatus(`Connection: ${state}`);
      }
    });
  }
  if (LK.RoomEvent?.Disconnected) {
    room.on(LK.RoomEvent.Disconnected, (reason) => {
      const detail = describeDisconnectReason(reason, LK);
      setStatus(`Disconnected: ${detail}`, true);
    });
  }
  if (LK.RoomEvent?.SignalReconnecting) {
    room.on(LK.RoomEvent.SignalReconnecting, () => {
      setStatus("Signal reconnecting...", true);
    });
  }
  if (LK.RoomEvent?.SignalReconnected) {
    room.on(LK.RoomEvent.SignalReconnected, () => {
      setStatus("Signal reconnected");
    });
  }
  if (LK.RoomEvent?.ConnectionError) {
    room.on(LK.RoomEvent.ConnectionError, (err) => {
      const detail = err?.message || String(err || "unknown");
      setStatus(`Connection error: ${detail}`, true);
    });
  }
  const localIdentity = identity;
  ensureParticipantCard({ identity: localIdentity, name }, true);
  room.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
    handleTrackSubscribed(track, publication, participant);
    scheduleReconcileWaves("track-subscribed");
    if (participant) hookPublication(publication, participant);
    debugLog(`track subscribed ${participant?.identity || "unknown"} src=${publication?.source || track.source} kind=${track.kind}`);

    // Refresh Camera Lobby if open and it's a camera track
    const LK = getLiveKitClient();
    if (track.kind === 'video' && publication?.source === LK?.Track?.Source?.Camera) {
      if (cameraLobbyPanel && !cameraLobbyPanel.classList.contains('hidden')) {
        setTimeout(() => populateCameraLobby(), 100);
      }
    }
  });
  if (LK.RoomEvent?.TrackSubscriptionFailed) {
    room.on(LK.RoomEvent.TrackSubscriptionFailed, (publication, participant, err) => {
      const detail = err?.message || String(err || "track subscription failed");
      setStatus(`Track subscription failed: ${detail}`, true);
      debugLog(`track subscription failed ${participant?.identity || "unknown"} ${detail}`);
      if (publication?.setSubscribed) {
        publication.setSubscribed(false);
        setTimeout(() => {
          publication.setSubscribed(true);
          if (publication?.track && participant) {
            handleTrackSubscribed(publication.track, publication, participant);
          }
          scheduleReconcileWaves("track-subscription-failed");
        }, 500);
      }
    });
  }
  if (LK.RoomEvent?.TrackPublished) {
    room.on(LK.RoomEvent.TrackPublished, (publication, participant) => {
      if (publication && publication.setSubscribed) {
        publication.setSubscribed(true);
      }
      debugLog(`track published ${participant?.identity || "unknown"} src=${publication?.source || publication?.kind}`);
      if (publication?.kind === LK.Track.Kind.Video) {
        requestVideoKeyFrame(publication, publication.track);
        setTimeout(() => requestVideoKeyFrame(publication, publication.track), 700);
      }
      if (participant) {
        hookPublication(publication, participant);
      }
      if (participant) {
        setTimeout(() => resubscribeParticipantTracks(participant), 900);
      }
      scheduleReconcileWaves("track-published");
    });
  }
  room.on(LK.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    handleTrackUnsubscribed(track, publication, participant);
  });
  room.on(LK.RoomEvent.ParticipantConnected, (participant) => {
    ensureParticipantCard(participant);
    debugLog(`participant connected ${participant.identity}`);
    // Small delay to let tracks be published before attaching
    setTimeout(() => {
      attachParticipantTracks(participant);
      resubscribeParticipantTracks(participant);
      // Refresh Camera Lobby if open
      if (cameraLobbyPanel && !cameraLobbyPanel.classList.contains('hidden')) {
        populateCameraLobby();
      }
    }, 200);
    scheduleReconcileWaves("participant-connected");
    // Re-broadcast own avatar so new participant receives it (relative path)
    setTimeout(() => {
      const identityBase = getIdentityBase(room.localParticipant.identity);
      const savedAvatar = echoGet("echo-avatar-" + identityBase);
      if (savedAvatar) {
        const relativePath = savedAvatar.startsWith("/") ? savedAvatar
          : savedAvatar.replace(/^https?:\/\/[^/]+/, "");
        broadcastAvatar(identityBase, relativePath);
      }
    }, 1000);
  });
  if (LK.RoomEvent?.ParticipantNameChanged) {
    room.on(LK.RoomEvent.ParticipantNameChanged, (participant) => {
      const cardRef = participantCards.get(participant.identity);
      if (!cardRef) return;
      const label = participant.name || "Guest";
      const nameEl = cardRef.card.querySelector(".user-name");
      if (nameEl) nameEl.textContent = label;
      if (!cardRef.avatar.querySelector("video")) {
        cardRef.avatar.textContent = getInitials(label);
        updateAvatarDisplay(participant.identity);
      }
    });
  }
  room.on(LK.RoomEvent.ParticipantDisconnected, (participant) => {
    const key = participant.identity;
    const cardRef = participantCards.get(key);
    if (cardRef) cardRef.card.remove();
    participantCards.delete(key);
    participantState.delete(key);
    debugLog(`participant disconnected ${participant.identity}`);
  });
  if (LK.RoomEvent?.TrackMuted) {
    room.on(LK.RoomEvent.TrackMuted, (publication, participant) => {
      if (!participant) return;
      const source = publication?.source;
      if (publication?.kind === LK.Track.Kind.Audio && source === LK.Track.Source.Microphone) {
        const state = participantState.get(participant.identity);
        if (state) {
          state.micMuted = true;
          applyParticipantAudioVolumes(state);
          updateActiveSpeakerUi();
        }
      } else if (publication?.kind === LK.Track.Kind.Video && source === LK.Track.Source.Camera) {
        const cardRef = participantCards.get(participant.identity);
        if (cardRef) {
          updateAvatarVideo(cardRef, null);
          debugLog(`camera muted for ${participant.identity}, avatar cleared`);
        }
      }
    });
  }
  if (LK.RoomEvent?.TrackUnmuted) {
    room.on(LK.RoomEvent.TrackUnmuted, (publication, participant) => {
      if (!participant) return;
      const source = publication?.source;
      if (publication?.kind === LK.Track.Kind.Audio && source === LK.Track.Source.Microphone) {
        const state = participantState.get(participant.identity);
        if (state) {
          state.micMuted = false;
          applyParticipantAudioVolumes(state);
          updateActiveSpeakerUi();
        }
      } else if (publication?.kind === LK.Track.Kind.Video && source === LK.Track.Source.Camera) {
        const cardRef = participantCards.get(participant.identity);
        if (cardRef && publication.track) {
          updateAvatarVideo(cardRef, publication.track);
          const video = cardRef.avatar?.querySelector("video");
          if (video) ensureVideoPlays(publication.track, video);
          debugLog(`camera unmuted for ${participant.identity}, avatar restored`);
        }
      }
    });
  }
  if (LK.RoomEvent?.ActiveSpeakers) {
    room.on(LK.RoomEvent.ActiveSpeakers, (speakers) => {
      activeSpeakerIds = new Set(speakers.map((p) => p.identity));
      lastActiveSpeakerEvent = performance.now();
      updateActiveSpeakerUi();
    });
  }
  if (LK.RoomEvent?.DataReceived) {
    room.on(LK.RoomEvent.DataReceived, (payload, participant) => {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);
        if (!msg || !msg.type) return;
        if (msg.type === "sound-play" && msg.soundId) {
          primeSoundboardAudio();
          playSoundboardSound(msg.soundId).catch(() => {});
        } else if (msg.type === "sound-added" && msg.sound) {
          upsertSoundboardSound(msg.sound);
        } else if (msg.type === "sound-updated" && msg.sound) {
          upsertSoundboardSound(msg.sound);
        } else if (msg.type === "request-reshare") {
          // Ignore remote re-share requests to avoid repeated user prompts.
          // We handle black frames locally via resubscribe + keyframe.
        } else if (msg.type === CHAT_MESSAGE_TYPE || msg.type === CHAT_FILE_TYPE) {
          handleIncomingChatData(payload, participant);
        } else if (msg.type === "jam-started" && msg.host) {
          if (typeof showJamToast === "function") showJamToast(msg.host + " started a Jam Session!");
          if (typeof handleJamDataMessage === "function") handleJamDataMessage(msg);
        } else if (msg.type === "jam-stopped") {
          if (typeof showJamToast === "function") showJamToast("Jam Session ended");
          if (typeof handleJamDataMessage === "function") handleJamDataMessage(msg);
          if (typeof stopJamAudioStream === "function") stopJamAudioStream();
        } else if (msg.type === "avatar-update" && msg.identityBase && msg.avatarUrl) {
          // Resolve relative paths through our own server URL
          var resolved = msg.avatarUrl.startsWith("/") ? apiUrl(msg.avatarUrl) : msg.avatarUrl;
          avatarUrls.set(msg.identityBase, resolved);
          // Update all cards that match this identity base
          participantCards.forEach((cardRef, ident) => {
            if (getIdentityBase(ident) === msg.identityBase) {
              updateAvatarDisplay(ident);
            }
          });
        }
      } catch {
        // ignore
      }
    });
  }
  if (LK.RoomEvent?.LocalTrackPublished) {
    room.on(LK.RoomEvent.LocalTrackPublished, (publication) => {
      const local = room.localParticipant;
      if (!local || !publication) return;
      const source = publication.source;
      if (publication.track?.kind === "video" && source === LK.Track.Source.ScreenShare) {
        localScreenTrackSid = publication.trackSid || "";
        const element = publication.track.attach();
        const label = `${name} (Screen)`;
        const tile = addScreenTile(label, element, publication.trackSid);
        const localIdentity = local.identity;
        screenTileByIdentity.set(localIdentity, tile);
        if (publication.trackSid) {
          registerScreenTrack(publication.trackSid, publication, tile, localIdentity);
        }
        // Show "Stop Watching" button for local screen share
        const localCardRef = participantCards.get(localIdentity);
        if (localCardRef && localCardRef.watchToggleBtn) {
          localCardRef.watchToggleBtn.style.display = "";
          localCardRef.watchToggleBtn.textContent = hiddenScreens.has(localIdentity) ? "Start Watching" : "Stop Watching";
        }
      } else if (publication.track?.kind === "video" && source === LK.Track.Source.Camera) {
        updateAvatarVideo(ensureParticipantCard(local, true), publication.track);
      } else if (publication.track?.kind === "audio") {
        const state = participantState.get(local.identity);
        if (!state) return;
        if (source === LK.Track.Source.ScreenShareAudio) {
          if (LK?.createAudioAnalyser && !state.screenAnalyser) {
            state.screenAnalyser = LK.createAudioAnalyser(publication.track);
          }
        } else {
          if (LK?.createAudioAnalyser && !state.micAnalyser) {
            state.micAnalyser = LK.createAudioAnalyser(publication.track);
          }
        }
      }
    });
  }
  if (LK.RoomEvent?.LocalTrackUnpublished) {
    room.on(LK.RoomEvent.LocalTrackUnpublished, (publication) => {
      const source = publication.source;
      if (publication.track?.kind === "video" && source === LK.Track.Source.ScreenShare) {
        removeScreenTile(publication.trackSid);
        unregisterScreenTrack(publication.trackSid);
        if (publication.trackSid === localScreenTrackSid) {
          localScreenTrackSid = "";
        }
        // Hide "Stop Watching" button when local screen share ends
        const localId = room?.localParticipant?.identity;
        if (localId) {
          hiddenScreens.delete(localId);
          screenTileByIdentity.delete(localId);
          const localCard = participantCards.get(localId);
          if (localCard && localCard.watchToggleBtn) {
            localCard.watchToggleBtn.style.display = "none";
            localCard.watchToggleBtn.textContent = "Stop Watching";
          }
        }
      } else if (publication.track?.kind === "video" && source === LK.Track.Source.Camera) {
        const cardRef = participantCards.get(room?.localParticipant?.identity || "");
        if (cardRef) updateAvatarVideo(cardRef, null);
      } else if (publication.track?.kind === "audio") {
        const local = room?.localParticipant;
        if (!local) return;
        const state = participantState.get(local.identity);
        if (!state) return;
        if (source === LK.Track.Source.ScreenShareAudio) {
          if (state.screenAnalyser?.cleanup) state.screenAnalyser.cleanup();
          state.screenAnalyser = null;
        } else {
          if (state.micAnalyser?.cleanup) state.micAnalyser.cleanup();
          state.micAnalyser = null;
        }
      }
    });
  }

  // Extract server hostname for TURN — window.location.hostname is wrong in Tauri (tauri.localhost)
  var turnHost = window.location.hostname;
  try {
    var _u = new URL(sfuUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
    turnHost = _u.hostname;
  } catch(e) {}

  await room.connect(sfuUrl, accessToken, {
    autoSubscribe: true,
    rtcConfig: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        {
          urls: "turn:" + turnHost + ":3478?transport=udp",
          username: "echo",
          credential: "chamber",
        },
      ],
    },
  });
  if (seq !== connectSequence) { room.disconnect(); return; }
  startMediaReconciler();
  try {
    room.startAudio?.();
  } catch {}
  // Pre-load soundboard sounds so remote playback works even if user never opens the panel
  loadSoundboardList().catch(() => {});
  // Check if a Jam is already running so the Now Playing banner appears
  if (typeof startBannerPolling === "function") startBannerPolling();
  const remoteList = room.remoteParticipants
    ? (typeof room.remoteParticipants.forEach === "function"
        ? Array.from(room.remoteParticipants.values ? room.remoteParticipants.values() : room.remoteParticipants)
        : Array.isArray(room.remoteParticipants) ? room.remoteParticipants : [])
    : [];
  remoteList.forEach((participant) => {
    ensureParticipantCard(participant);
    attachParticipantTracks(participant);
  });
  // Retry existing participants after a delay to catch tracks that load asynchronously
  setTimeout(() => {
    remoteList.forEach((participant) => {
      attachParticipantTracks(participant);
      resubscribeParticipantTracks(participant);
    });
  }, 500);
  setTimeout(() => {
    remoteList.forEach((participant) => {
      attachParticipantTracks(participant);
      resubscribeParticipantTracks(participant);
    });
  }, 1500);
  scheduleReconcileWaves("post-connect");
  startAudioMonitor();
  currentRoomName = roomId;
  if (openSoundboardButton) openSoundboardButton.disabled = false;
  if (openCameraLobbyButton) openCameraLobbyButton.disabled = false;
  if (openChatButton) openChatButton.disabled = false;
  if (bugReportBtn) bugReportBtn.disabled = false;
  if (openJamButton) openJamButton.disabled = false;
  if (toggleRoomAudioButton) {
    toggleRoomAudioButton.disabled = false;
    setRoomAudioMutedState(false);
  }
  if (openSettingsButton) openSettingsButton.disabled = false;
  if (settingsDevicePanel && deviceActionsEl) {
    settingsDevicePanel.appendChild(deviceActionsEl);
    if (deviceStatusEl) settingsDevicePanel.appendChild(deviceStatusEl);
  }
  buildChimeSettingsUI();
  buildVersionSection();
  primeSoundboardAudio();
  initializeEmojiPicker();
  loadChatHistory(roomId);
  // Load own avatar from localStorage and broadcast to room
  {
    const identityBase = getIdentityBase(identity);
    const savedAvatar = echoGet("echo-avatar-" + identityBase);
    if (savedAvatar) {
      // Normalize: strip server origin if stored as absolute URL (legacy)
      const relativePath = savedAvatar.startsWith("/") ? savedAvatar
        : savedAvatar.replace(/^https?:\/\/[^/]+/, "");
      const resolvedAvatar = apiUrl(relativePath);
      avatarUrls.set(identityBase, resolvedAvatar);
      updateAvatarDisplay(identity);
      // Broadcast relative path so remote users resolve via their own server
      setTimeout(() => broadcastAvatar(identityBase, relativePath), 2000);
    }
  }
  stopOnlineUsersPolling();
  connectBtn.disabled = true;
  disconnectBtn.disabled = false;
  disconnectTopBtn.disabled = false;
  roomListEl.classList.remove("hidden");
  connectPanel.classList.add("hidden");
  setPublishButtonsEnabled(true);
  // Refresh devices, then auto-enable mic. On macOS WKWebView, getUserMedia may
  // need to be called first to unlock device labels, so we ensure permissions
  // before toggling mic on.
  ensureDevicePermissions().then(() => refreshDevices()).then(() => {
    toggleMicOn().catch((err) => {
      debugLog("[mic] auto-enable failed: " + (err.message || err));
      setStatus("Mic failed to start — check permissions in System Settings", true);
    });
  }).catch((err) => {
    debugLog("[devices] post-connect device setup failed: " + (err.message || err));
  });
  startHeartbeat();
  startRoomStatusPolling();
  refreshRoomList(controlUrl, adminToken, roomId).catch(() => {});
  setStatus(`Connected to ${roomId}`);

}

async function connect() {
  // CRITICAL: Prime and MAINTAIN autoplay permission by playing a continuous silent audio loop
  // This keeps the browser's autoplay permission active indefinitely
  // This MUST happen IMMEDIATELY while we still have the user gesture from the button click
  // Also prime soundboard AudioContext NOW (user gesture) so remote sound-play events work
  getSoundboardContext();
  try {
    // Create a silent audio loop to maintain autoplay permission
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    gainNode.gain.value = 0; // Silent
    oscillator.start();

    debugLog('Autoplay permission maintained with silent audio loop');

    // Also prime video autoplay with a canvas stream
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillRect(0, 0, 1, 1);
    const stream = canvas.captureStream(1);

    const dummyVideo = document.createElement('video');
    dummyVideo.srcObject = stream;
    dummyVideo.muted = true;
    dummyVideo.playsInline = true;
    await dummyVideo.play();

    debugLog('Autoplay primed successfully within user gesture');

    // Keep the dummy video playing in the background to maintain permission
    dummyVideo.style.position = 'fixed';
    dummyVideo.style.width = '1px';
    dummyVideo.style.height = '1px';
    dummyVideo.style.opacity = '0';
    dummyVideo.style.pointerEvents = 'none';
    document.body.appendChild(dummyVideo);

    // CRITICAL: Store reference globally so videos can check if autoplay is primed
    window._autoplayPrimed = true;
    window._dummyVideo = dummyVideo;

    // CRITICAL: Add global interaction handler to enable videos on ANY page interaction
    // This captures clicks, touches, keyboard - any user gesture enables all videos
    window._pausedVideos = new Set();
    const enableAllMedia = async () => {
      if (!window._pausedVideos || window._pausedVideos.size === 0) {
        // Still try room.startAudio() on any interaction even without paused media
        try { room?.startAudio?.(); } catch {}
        return;
      }

      debugLog(`User interaction detected - enabling ${window._pausedVideos.size} paused media elements`);

      const elements = Array.from(window._pausedVideos);
      window._pausedVideos.clear();
      hideRefreshButton();

      // Resume LiveKit audio context first
      try { room?.startAudio?.(); } catch {}

      for (const el of elements) {
        if (el && el.paused && el.isConnected) {
          try {
            await el.play();
            const kind = el.tagName === "AUDIO" ? "audio" : "video";
            debugLog(`Enabled ${kind} ${el._lkTrack?.sid || 'unknown'} via user interaction`);
          } catch (e) {
            const kind = el.tagName === "AUDIO" ? "audio" : "video";
            debugLog(`Still failed to enable ${kind} ${el._lkTrack?.sid || 'unknown'}: ${e.message}`);
          }
        }
      }
    };

    // Make enableAllMedia globally accessible for the refresh button
    window._enableAllMedia = enableAllMedia;

    // Listen for ANY interaction on the page (persistent - handles late-joining participants)
    const interactionEvents = ['click', 'touchstart', 'keydown', 'mousedown'];
    interactionEvents.forEach(event => {
      document.addEventListener(event, enableAllMedia, { capture: true });
    });
  } catch (e) {
    debugLog('WARNING: Failed to prime autoplay: ' + e.message);
    window._autoplayPrimed = false;
  }

  // CRITICAL: Wait a moment for autoplay permission to fully settle before connecting
  await new Promise(resolve => setTimeout(resolve, 100));

  normalizeUrls();
  unlockAudio();
  const controlUrl = controlUrlInput.value.trim();
  const sfuUrl = sfuUrlInput.value.trim();
  const name = nameInput.value.trim() || "Viewer";
  if (nameInput) echoSet(REMEMBER_NAME_KEY, name);
  if (passwordInput) echoSet(REMEMBER_PASS_KEY, passwordInput.value);
  const roomName = currentRoomName || "main";
  const identity = buildIdentity(name);
  if (identityInput) {
    identityInput.value = identity;
  }

  try {
    await connectToRoom({ controlUrl, sfuUrl, roomId: roomName, identity, name, reuseAdmin: false });
  } catch (err) {
    setStatus(err.message || "Connect failed", true);
  }
}

async function disconnect() {
  if (!room) return;
  sendLeaveNotification();
  stopHeartbeat();
  stopRoomStatusPolling();
  // Clean up manual screen share tracks before disconnecting
  _screenShareVideoTrack?.mediaStreamTrack?.stop();
  _screenShareAudioTrack?.mediaStreamTrack?.stop();
  _screenShareVideoTrack = null;
  _screenShareAudioTrack = null;
  disableNoiseCancellation();
  room.disconnect();
  room = null;
  clearMedia();
  clearSoundboardState();
  currentAccessToken = "";
  if (openSoundboardButton) openSoundboardButton.disabled = true;
  if (openCameraLobbyButton) openCameraLobbyButton.disabled = true;
  if (openChatButton) openChatButton.disabled = true;
  if (bugReportBtn) bugReportBtn.disabled = true;
  if (openJamButton) openJamButton.disabled = true;
  if (typeof cleanupJam === "function") cleanupJam();
  _latestScreenStats = null;
  if (toggleRoomAudioButton) toggleRoomAudioButton.disabled = true;
  if (openSettingsButton) openSettingsButton.disabled = true;
  if (deviceActionsEl && deviceActionsHome) {
    deviceActionsHome.appendChild(deviceActionsEl);
  }
  if (deviceStatusEl && deviceStatusHome) {
    deviceStatusHome.appendChild(deviceStatusEl);
  }
  if (settingsPanel) settingsPanel.classList.add("hidden");
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  disconnectTopBtn.disabled = true;
  roomListEl.classList.add("hidden");
  connectPanel.classList.remove("hidden");
  startOnlineUsersPolling();
  setPublishButtonsEnabled(false);
  micEnabled = false;
  camEnabled = false;
  screenEnabled = false;
  renderPublishButtons();
  setDeviceStatus("");
  setStatus("Disconnected");
}

// ==================== CHAT FUNCTIONALITY ====================

const EMOJI_LIST = [
  "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇",
  "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "🥲", "😋", "😛", "😜", "🤪", "😝",
  "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄",
  "😬", "🤥", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🤧",
  "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "🥸", "😎", "🤓", "🧐", "😕", "😟",
  "🙁", "☹️", "😮", "😯", "😲", "😳", "🥺", "😦", "😧", "😨", "😰", "😥", "😢",
  "😭", "😱", "😖", "😣", "😞", "😓", "😩", "😫", "🥱", "😤", "😡", "😠", "🤬",
  "😈", "👿", "💀", "☠️", "💩", "🤡", "👹", "👺", "👻", "👽", "👾", "🤖", "😺",
  "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾", "👋", "🤚", "🖐️", "✋", "🖖",
  "👌", "🤌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇",
  "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏",
  "✍️", "💅", "🤳", "💪", "🦾", "🦿", "🦵", "🦶", "👂", "🦻", "👃", "🧠", "🫀",
  "🫁", "🦷", "🦴", "👀", "👁️", "👅", "👄", "💋", "🩸", "❤️", "🧡", "💛", "💚",
  "💙", "💜", "🤎", "🖤", "🤍", "💔", "❣️", "💕", "💞", "💓", "💗", "💖", "💘",
  "💝", "💟", "☮️", "✝️", "☪️", "🕉️", "☸️", "✡️", "🔯", "🕎", "☯️", "☦️", "🛐",
  "⛎", "♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓", "🆔", "⚛️",
  "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚫", "⚪", "🟥", "🟧", "🟨", "🟩",
  "🟦", "🟪", "🟫", "⬛", "⬜", "🔶", "🔷", "🔸", "🔹", "🔺", "🔻", "💠", "🔘",
  "🔳", "🔲", "🏁", "🚩", "🎌", "🏴", "🏳️", "🏳️‍🌈", "🏳️‍⚧️", "🏴‍☠️", "🇺🇳"
];

function linkifyText(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

// Open external links in system browser
document.addEventListener("click", function(e) {
  var link = e.target.closest("a[href]");
  if (!link) return;
  var href = link.getAttribute("href");
  if (!href || !/^https?:\/\//.test(href)) return;
  if (href.startsWith(window.location.origin)) return; // skip internal links
  e.preventDefault();
  debugLog("[link] clicked: " + href);
  // Try window.open first (works in regular browsers)
  var w = window.open(href, "_blank");
  if (!w && adminToken) {
    // Popup blocked (Tauri/WebView2) + user is admin — ask server to open in system browser
    debugLog("[link] window.open blocked, using server /api/open-url (admin)");
    fetch(apiUrl("/api/open-url"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + adminToken },
      body: JSON.stringify({ url: href })
    }).catch(function(err) { debugLog("[link] open-url failed: " + err); });
  }
});

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

async function fetchImageAsBlob(url) {
  try {
    // Use LiveKit access token so all room participants can view images
    const token = currentAccessToken || adminToken;
    debugLog(`fetchImageAsBlob: url=${url}, hasCurrentAccessToken=${!!currentAccessToken}, hasAdminToken=${!!adminToken}, usingToken=${token ? 'yes' : 'no'}`);

    if (!token) {
      debugLog(`ERROR: No token available for image fetch!`);
      return null;
    }

    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    debugLog(`fetchImageAsBlob: response status=${response.status}, ok=${response.ok}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unable to read error');
      debugLog(`fetchImageAsBlob: server error - ${errorText}`);
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    debugLog(`Failed to fetch image: ${err.message}`);
    return null;
  }
}

function renderChatMessage(message) {
  const messageEl = document.createElement("div");
  messageEl.className = "chat-message";

  const headerEl = document.createElement("div");
  headerEl.className = "chat-message-header";

  const authorEl = document.createElement("div");
  authorEl.className = "chat-message-author";
  if (message.identity === room?.localParticipant?.identity) {
    authorEl.classList.add("self");
  }
  authorEl.textContent = message.name || message.identity;

  const timeEl = document.createElement("div");
  timeEl.className = "chat-message-time";
  timeEl.textContent = formatTime(message.timestamp);

  headerEl.appendChild(authorEl);
  headerEl.appendChild(timeEl);
  messageEl.appendChild(headerEl);

  if (message.type === CHAT_FILE_TYPE && message.fileUrl) {
    if (message.fileType?.startsWith("image/")) {
      const imgEl = document.createElement("img");
      imgEl.className = "chat-message-image";
      imgEl.alt = message.fileName || "Image";
      imgEl.loading = "lazy";

      // Resolve relative URLs using current controlUrl
      const imageUrl = message.fileUrl.startsWith('http')
        ? message.fileUrl
        : `${controlUrlInput?.value || 'https://127.0.0.1:9443'}${message.fileUrl}`;

      // Fetch image with auth and create blob URL
      fetchImageAsBlob(imageUrl).then(blobUrl => {
        if (blobUrl) {
          imgEl.src = blobUrl;
        } else {
          imgEl.src = ""; // Show broken image
          imgEl.alt = "Failed to load image";
        }
      });

      imgEl.addEventListener("click", async () => {
        // Open image in new tab by fetching with auth
        try {
          const token = currentAccessToken || adminToken;
          const clickUrl = message.fileUrl.startsWith('http') ? message.fileUrl : apiUrl(message.fileUrl);
          const response = await fetch(clickUrl, {
            headers: { "Authorization": `Bearer ${token}` }
          });
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          window.open(url, "_blank");
        } catch (err) {
          debugLog(`Failed to open image: ${err.message}`);
        }
      });
      messageEl.appendChild(imgEl);

      if (message.text) {
        const contentEl = document.createElement("div");
        contentEl.className = "chat-message-content";
        contentEl.innerHTML = linkifyText(message.text);
        messageEl.appendChild(contentEl);
      }
    } else {
      const fileEl = document.createElement("div");
      fileEl.className = "chat-message-file";
      fileEl.addEventListener("click", async () => {
        // Download file with auth
        try {
          const token = currentAccessToken || adminToken;
          const dlUrl = message.fileUrl.startsWith('http') ? message.fileUrl : apiUrl(message.fileUrl);
          const response = await fetch(dlUrl, {
            headers: { "Authorization": `Bearer ${token}` }
          });
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = message.fileName || "file";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (err) {
          debugLog(`Failed to download file: ${err.message}`);
        }
      });

      const iconEl = document.createElement("div");
      iconEl.className = "chat-message-file-icon";
      iconEl.textContent = "📄";

      const nameEl = document.createElement("div");
      nameEl.className = "chat-message-file-name";
      nameEl.textContent = message.fileName || "File";

      fileEl.appendChild(iconEl);
      fileEl.appendChild(nameEl);
      messageEl.appendChild(fileEl);

      if (message.text) {
        const contentEl = document.createElement("div");
        contentEl.className = "chat-message-content";
        contentEl.innerHTML = linkifyText(message.text);
        messageEl.appendChild(contentEl);
      }
    }
  } else if (message.text) {
    const contentEl = document.createElement("div");
    contentEl.className = "chat-message-content";
    contentEl.innerHTML = linkifyText(message.text);
    messageEl.appendChild(contentEl);
  }

  return messageEl;
}

function addChatMessage(message) {
  chatHistory.push(message);
  const messageEl = renderChatMessage(message);
  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Persist to server
  saveChatMessage(message);
}

function sendChatMessage(text, fileData = null) {
  if (!room || !room.localParticipant) return;

  const message = {
    type: fileData ? CHAT_FILE_TYPE : CHAT_MESSAGE_TYPE,
    identity: room.localParticipant.identity,
    name: room.localParticipant.name || room.localParticipant.identity,
    text: text.trim(),
    timestamp: Date.now(),
    room: currentRoomName
  };

  if (fileData) {
    message.fileUrl = fileData.url;
    message.fileName = fileData.name;
    message.fileType = fileData.type;
  }

  // Send via LiveKit data channel
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(message));
    room.localParticipant.publishData(data, {reliable: true});
  } catch (err) {
    debugLog(`Failed to send chat message: ${err.message}`);
  }

  // Add to local chat
  addChatMessage(message);
}

function handleIncomingChatData(payload, participant) {
  try {
    const decoder = new TextDecoder();
    const text = decoder.decode(payload);
    const message = JSON.parse(text);

    // Only handle messages for current room
    if (message.room && message.room !== currentRoomName) return;

    // Ignore messages from self (already added locally)
    if (participant && participant.identity === room?.localParticipant?.identity) return;

    if (message.type === CHAT_MESSAGE_TYPE || message.type === CHAT_FILE_TYPE) {
      // Ensure message has required fields
      if (!message.identity) {
        message.identity = participant?.identity || "unknown";
      }
      if (!message.name) {
        message.name = participant?.name || participant?.identity || "Unknown";
      }
      if (!message.timestamp) {
        message.timestamp = Date.now();
      }

      chatHistory.push(message);
      const messageEl = renderChatMessage(message);
      chatMessages.appendChild(messageEl);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      // Show notification badge if chat is closed
      incrementUnreadChat();
    }
  } catch (err) {
    debugLog(`Failed to parse chat data: ${err.message}`);
  }
}

function updateChatBadge() {
  if (!chatBadge) return;
  if (unreadChatCount > 0) {
    chatBadge.textContent = unreadChatCount > 99 ? "99+" : unreadChatCount;
    chatBadge.classList.remove("hidden");
  } else {
    chatBadge.classList.add("hidden");
  }
}

function incrementUnreadChat() {
  // Only increment if chat is closed
  if (chatPanel && chatPanel.classList.contains("hidden")) {
    unreadChatCount++;
    updateChatBadge();

    // Trigger pulse animation on chat button
    if (openChatButton) {
      openChatButton.classList.remove("has-unread");
      // Force reflow to restart animation
      void openChatButton.offsetWidth;
      openChatButton.classList.add("has-unread");
    }
  }
}

function clearUnreadChat() {
  unreadChatCount = 0;
  updateChatBadge();
  if (openChatButton) {
    openChatButton.classList.remove("has-unread");
  }
}

function openChat() {
  if (!chatPanel) return;
  chatPanel.classList.remove("hidden");
  document.querySelector(".room-layout")?.classList.add("chat-open");
  chatMessages.scrollTop = chatMessages.scrollHeight;
  chatInput.focus();
  clearUnreadChat();
}

function closeChat() {
  if (!chatPanel) return;
  chatPanel.classList.add("hidden");
  document.querySelector(".room-layout")?.classList.remove("chat-open");
}

function initializeEmojiPicker() {
  if (!chatEmojiPicker) return;
  chatEmojiPicker.innerHTML = "";
  EMOJI_LIST.forEach(emoji => {
    const emojiEl = document.createElement("div");
    emojiEl.className = "chat-emoji";
    emojiEl.textContent = emoji;
    emojiEl.addEventListener("click", () => {
      const cursorPos = chatInput.selectionStart;
      const textBefore = chatInput.value.substring(0, cursorPos);
      const textAfter = chatInput.value.substring(cursorPos);
      chatInput.value = textBefore + emoji + textAfter;
      chatInput.focus();
      chatInput.selectionStart = chatInput.selectionEnd = cursorPos + emoji.length;
      chatEmojiPicker.classList.add("hidden");
    });
    chatEmojiPicker.appendChild(emojiEl);
  });
}

function toggleEmojiPicker() {
  if (!chatEmojiPicker) return;
  chatEmojiPicker.classList.toggle("hidden");
}

async function fixImageOrientation(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Set canvas size to image size
        canvas.width = img.width;
        canvas.height = img.height;

        // Draw image onto canvas (this strips EXIF and normalizes orientation)
        ctx.drawImage(img, 0, 0);

        // Convert canvas back to blob
        canvas.toBlob((blob) => {
          resolve(blob || file);
        }, file.type || 'image/png', 0.95);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

async function handleChatImagePaste(file) {
  if (!file) {
    debugLog("No file provided to upload");
    return null;
  }

  if (!adminToken) {
    debugLog("Cannot upload file: Not authenticated (adminToken missing)");
    setStatus("Cannot upload: Not connected", true);
    return null;
  }

  // Fix image orientation if it's an image
  if (file.type.startsWith('image/')) {
    debugLog("Fixing image orientation...");
    file = await fixImageOrientation(file);
  }

  try {
    const controlUrl = controlUrlInput?.value || "https://127.0.0.1:9443";
    debugLog(`Uploading file: ${file.name} (${file.type}, ${file.size} bytes)`);

    const fileBytes = await file.arrayBuffer();
    const response = await fetch(`${controlUrl}/api/chat/upload?room=${encodeURIComponent(currentRoomName)}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminToken}`
      },
      body: fileBytes
    });

    debugLog(`Upload response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      debugLog(`Upload failed: ${errorText}`);
      throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    debugLog(`Upload result: ${JSON.stringify(result)}`);

    if (!result.ok || !result.url) {
      throw new Error(result.error || "Upload failed");
    }

    debugLog(`File uploaded successfully: ${result.url}`);

    // Store relative URL so it works for all users regardless of their control URL
    return {
      url: result.url,  // Store relative path like /api/chat/uploads/filename
      name: file.name,
      type: file.type
    };
  } catch (err) {
    debugLog(`Failed to upload file: ${err.message}`);
    setStatus(`Upload failed: ${err.message}`, true);
    return null;
  }
}

async function handleChatFileUpload() {
  if (!chatFileInput || !chatFileInput.files || chatFileInput.files.length === 0) return;

  const file = chatFileInput.files[0];
  const fileData = await handleChatImagePaste(file);

  if (fileData) {
    sendChatMessage("", fileData);
  }

  chatFileInput.value = "";
}

async function loadChatHistory(roomName) {
  try {
    const controlUrl = controlUrlInput?.value || "https://127.0.0.1:9443";
    const response = await fetch(`${controlUrl}/api/chat/history/${encodeURIComponent(roomName)}`, {
      headers: {
        "Authorization": `Bearer ${adminToken}`
      }
    });

    if (!response.ok) return;

    const history = await response.json();
    chatHistory.length = 0;
    chatMessages.innerHTML = "";

    history.forEach(message => {
      chatHistory.push(message);
      const messageEl = renderChatMessage(message);
      chatMessages.appendChild(messageEl);
    });

    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Clear unread count when loading history (user sees all messages)
    clearUnreadChat();
  } catch (err) {
    debugLog(`Failed to load chat history: ${err.message}`);
  }
}

async function saveChatMessage(message) {
  try {
    const controlUrl = controlUrlInput?.value || "https://127.0.0.1:9443";
    await fetch(`${controlUrl}/api/chat/message`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message)
    });
  } catch (err) {
    debugLog(`Failed to save chat message: ${err.message}`);
  }
}

/* switchRoom is defined earlier (line ~491) - this block loads chat and reconnects */

connectBtn.addEventListener("click", () => {
  connect().catch(() => {});
});

disconnectBtn.addEventListener("click", () => {
  disconnect();
});

disconnectTopBtn.addEventListener("click", () => {
  disconnect();
});

async function toggleMic() {
  if (!room) return;
  const desired = !micEnabled;
  micBtn.disabled = true;
  try {
    await room.localParticipant.setMicrophoneEnabled(desired, {
      deviceId: selectedMicId || undefined,
    });
    micEnabled = desired;

    // Apply or remove noise cancellation
    if (desired && noiseCancelEnabled) {
      try { await enableNoiseCancellation(); } catch (e) {
        debugLog("[noise-cancel] Could not enable on mic toggle: " + (e.message || e));
      }
    } else if (!desired) {
      disableNoiseCancellation();
    }

    renderPublishButtons();
    if (room?.localParticipant) {
      const cardRef = ensureParticipantCard(room.localParticipant, true);
      if (cardRef.controls) {
        cardRef.controls.querySelectorAll(".icon-button")[0]?.classList.toggle("is-on", micEnabled);
      }
    }
    updateActiveSpeakerUi();
  } catch (err) {
    debugLog("[mic] toggle error: " + (err.message || err) + " (name=" + err.name + ")");
    // Provide actionable error messages for common Mac issues
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      setStatus("Mic permission denied — grant access in System Settings > Privacy > Microphone", true);
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      setStatus("No microphone found — check your audio input device", true);
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      setStatus("Mic is in use by another app or unavailable", true);
    } else {
      setStatus(err.message || "Mic failed", true);
    }
  } finally {
    micBtn.disabled = false;
  }
}

// Adaptive camera quality: reduce camera when screen share is bandwidth-constrained
async function reduceCameraForScreenShare() {
  try {
    const LK = getLiveKitClient();
    const pubs = getParticipantPublications(room.localParticipant);
    const camPub = pubs.find((p) => p?.source === LK?.Track?.Source?.Camera && p.track);
    if (!camPub?.track?.sender) return;
    const sender = camPub.track.sender;
    const params = sender.getParameters();
    if (params.encodings && params.encodings.length > 0) {
      params.encodings[0].maxBitrate = 300000; // 300kbps
      params.encodings[0].maxFramerate = 15;
      params.encodings[0].scaleResolutionDownBy = 2; // halve resolution
      await sender.setParameters(params);
    }
  } catch (e) { debugLog("Adaptive camera reduce failed: " + e.message); }
}

async function restoreCameraQuality() {
  try {
    const LK = getLiveKitClient();
    const pubs = getParticipantPublications(room.localParticipant);
    const camPub = pubs.find((p) => p?.source === LK?.Track?.Source?.Camera && p.track);
    if (!camPub?.track?.sender) return;
    const sender = camPub.track.sender;
    const params = sender.getParameters();
    if (params.encodings && params.encodings.length > 0) {
      delete params.encodings[0].maxBitrate;
      params.encodings[0].maxFramerate = 30;
      delete params.encodings[0].scaleResolutionDownBy;
      await sender.setParameters(params);
    }
  } catch (e) { debugLog("Adaptive camera restore failed: " + e.message); }
}

async function toggleCam() {
  if (!room) return;
  const desired = !camEnabled;
  camBtn.disabled = true;
  try {
    await room.localParticipant.setCameraEnabled(desired, {
      deviceId: selectedCamId || undefined,
    });
    camEnabled = desired;
    renderPublishButtons();
    if (room?.localParticipant) {
      const cardRef = ensureParticipantCard(room.localParticipant, true);
      if (!camEnabled) {
        updateAvatarVideo(cardRef, null);
      } else {
        const pubs = getParticipantPublications(room.localParticipant);
        const camPub = pubs.find((p) => p?.source === getLiveKitClient()?.Track?.Source?.Camera && p.track);
        if (camPub?.track) {
          updateAvatarVideo(cardRef, camPub.track);
          const video = cardRef.avatar?.querySelector("video");
          if (video) ensureVideoPlays(camPub.track, video);
        }
      }
      if (cardRef.controls) {
        cardRef.controls.querySelectorAll(".icon-button")[1]?.classList.toggle("is-on", camEnabled);
      }
    }
  } catch (err) {
    debugLog("[cam] toggle error: " + (err.message || err) + " (name=" + err.name + ")");
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      setStatus("Camera permission denied — grant access in System Settings > Privacy > Camera", true);
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      setStatus("No camera found", true);
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      setStatus("Camera is in use by another app or unavailable", true);
    } else {
      setStatus(err.message || "Camera failed", true);
    }
  } finally {
    camBtn.disabled = false;
  }
}

async function toggleScreen() {
  if (!room) return;
  const desired = !screenEnabled;
  screenBtn.disabled = true;
  try {
    if (desired) {
      await startScreenShareManual();
    } else {
      await stopScreenShareManual();
    }
    screenEnabled = desired;
    renderPublishButtons();
    if (room?.localParticipant) {
      const cardRef = ensureParticipantCard(room.localParticipant, true);
      if (cardRef.controls) {
        cardRef.controls.querySelectorAll(".icon-button")[2]?.classList.toggle("is-on", screenEnabled);
      }
    }
  } catch (err) {
    setStatus(err.message || "Screen share failed", true);
  } finally {
    screenBtn.disabled = false;
  }
}

async function restartScreenShare() {
  if (!room || !screenEnabled || screenRestarting) return;
  screenRestarting = true;
  try {
    await stopScreenShareManual();
    screenEnabled = false;
    renderPublishButtons();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await startScreenShareManual();
    screenEnabled = true;
    renderPublishButtons();
  } catch (err) {
    setStatus(err.message || "Screen restart failed", true);
  } finally {
    screenRestarting = false;
  }
}

async function enableAllMedia() {
  if (!room) return;
  await toggleMicOn();
  await toggleCamOn();
  await toggleScreenOn();
}

async function toggleMicOn() {
  if (micEnabled) return;
  await toggleMic();
}

async function toggleCamOn() {
  if (camEnabled) return;
  await toggleCam();
}

async function toggleScreenOn() {
  if (screenEnabled) return;
  await toggleScreen();
}

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
// createRoomBtn.addEventListener("click", async () => {
//   if (!adminToken) return;
//   const controlUrl = controlUrlInput.value.trim();
//   const roomId = prompt("New room name");
//   if (!roomId) return;
//   await ensureRoomExists(controlUrl, adminToken, roomId.trim());
//   await refreshRoomList(controlUrl, adminToken, currentRoomName);
// });

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

if (openSoundboardButton) {
  openSoundboardButton.addEventListener("click", () => {
    openSoundboard();
  });
}

if (closeSoundboardButton) {
  closeSoundboardButton.addEventListener("click", () => {
    closeSoundboard();
  });
}

if (openSoundboardEditButton) {
  openSoundboardEditButton.addEventListener("click", () => {
    openSoundboardEdit();
  });
}

if (backToSoundboardButton) {
  backToSoundboardButton.addEventListener("click", () => {
    closeSoundboardEdit();
  });
}

// Compact view volume toggle
if (toggleSoundboardVolumeCompactButton && soundboardVolumePanelCompact) {
  toggleSoundboardVolumeCompactButton.addEventListener("click", () => {
    soundboardVolumePanelCompact.classList.toggle("hidden");
    const isOpen = !soundboardVolumePanelCompact.classList.contains("hidden");
    toggleSoundboardVolumeCompactButton.setAttribute("aria-expanded", String(isOpen));
    soundboardVolumePanelCompact.setAttribute("aria-hidden", String(!isOpen));
  });
}

// Edit view volume toggle
if (toggleSoundboardVolumeButton && soundboardVolumePanel) {
  toggleSoundboardVolumeButton.addEventListener("click", () => {
    soundboardVolumePanel.classList.toggle("hidden");
    const isOpen = !soundboardVolumePanel.classList.contains("hidden");
    toggleSoundboardVolumeButton.setAttribute("aria-expanded", String(isOpen));
    soundboardVolumePanel.setAttribute("aria-hidden", String(!isOpen));
  });
}

// Volume input handler — works for both compact and edit sliders
function handleSoundboardVolumeChange(inputEl) {
  const value = Number(inputEl.value);
  soundboardUserVolume = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
  echoSet("echo-core-soundboard-volume", String(soundboardUserVolume));
  updateSoundboardVolumeUi();
}

if (soundboardVolumeInput) {
  soundboardVolumeInput.addEventListener("input", () => {
    handleSoundboardVolumeChange(soundboardVolumeInput);
    // Sync the edit slider if it exists
    if (soundboardVolumeInputEdit) soundboardVolumeInputEdit.value = soundboardVolumeInput.value;
  });
}

if (soundboardVolumeInputEdit) {
  soundboardVolumeInputEdit.addEventListener("input", () => {
    handleSoundboardVolumeChange(soundboardVolumeInputEdit);
    // Sync the compact slider if it exists
    if (soundboardVolumeInput) soundboardVolumeInput.value = soundboardVolumeInputEdit.value;
  });
}

if (soundSearchInput) {
  soundSearchInput.addEventListener("input", () => {
    renderSoundboard();
  });
}

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

// Chat event listeners
if (openChatButton) {
  openChatButton.addEventListener("click", () => {
    openChat();
  });
}

if (closeChatButton) {
  closeChatButton.addEventListener("click", () => {
    closeChat();
  });
}

if (chatSendBtn) {
  chatSendBtn.addEventListener("click", () => {
    const text = chatInput.value.trim();
    if (text) {
      sendChatMessage(text);
      chatInput.value = "";
      chatInput.style.height = "auto";
    }
  });
}

if (chatInput) {
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (text) {
        sendChatMessage(text);
        chatInput.value = "";
        chatInput.style.height = "auto";
      }
    }
  });

  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  chatInput.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const fileData = await handleChatImagePaste(file);
          if (fileData) {
            const text = chatInput.value.trim();
            sendChatMessage(text, fileData);
            chatInput.value = "";
            chatInput.style.height = "auto";
          }
        }
        break;
      }
    }
  });
}

if (chatEmojiBtn) {
  chatEmojiBtn.addEventListener("click", () => {
    toggleEmojiPicker();
  });
}

if (chatUploadBtn) {
  chatUploadBtn.addEventListener("click", () => {
    if (chatFileInput) {
      chatFileInput.click();
    }
  });
}

if (chatFileInput) {
  chatFileInput.addEventListener("change", () => {
    handleChatFileUpload();
  });
}


if (soundClipVolumeInput) {
  soundClipVolumeInput.addEventListener("input", () => {
    const value = Number(soundClipVolumeInput.value);
    const normalized = Number.isFinite(value) ? Math.min(200, Math.max(0, value)) : 100;
    updateSoundClipVolumeUi(normalized);
    if (!soundboardEditingId) {
      soundboardClipVolume = normalized;
      echoSet("echo-core-soundboard-clip-volume", String(soundboardClipVolume));
    }
    renderSoundboard();
  });
}

if (soundFileInput) {
  soundFileInput.addEventListener("change", () => {
    updateSoundboardEditControls();
    // Show icon picker when a file is selected for upload
    const iconsSection = document.getElementById("soundboard-icons-section");
    if (iconsSection && soundFileInput.files && soundFileInput.files.length > 0) {
      iconsSection.classList.remove("hidden");
    }
  });
}

if (soundUploadButton) {
  soundUploadButton.addEventListener("click", () => {
    primeSoundboardAudio();
    void uploadSoundboardSound();
  });
}

if (soundCancelEditButton) {
  soundCancelEditButton.addEventListener("click", () => {
    exitSoundboardEditMode();
    setSoundboardHint("");
  });
}

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

function buildChimeSettingsUI() {
  debugLog("[settings] buildChimeSettingsUI called, panel exists: " + !!settingsDevicePanel);
  if (!settingsDevicePanel) { debugLog("[settings] NO settingsDevicePanel - aborting"); return; }

  // --- Noise Cancellation toggle ---
  var existingNc = document.getElementById("nc-settings-section");
  if (existingNc) existingNc.remove();

  var ncSection = document.createElement("div");
  ncSection.id = "nc-settings-section";
  ncSection.className = "chime-settings-section";

  var ncTitle = document.createElement("div");
  ncTitle.className = "chime-settings-title";
  ncTitle.textContent = "Noise Cancellation";
  ncSection.appendChild(ncTitle);

  var ncRow = document.createElement("div");
  ncRow.className = "nc-toggle-row";

  var ncLabel = document.createElement("span");
  ncLabel.className = "nc-toggle-label";
  ncLabel.textContent = "Enable Noise Cancellation";

  var ncBtn = document.createElement("button");
  ncBtn.type = "button";
  ncBtn.id = "nc-toggle-btn";
  ncBtn.className = "nc-toggle-btn" + (noiseCancelEnabled ? " is-on" : "");
  ncBtn.textContent = noiseCancelEnabled ? "ON" : "OFF";

  ncBtn.addEventListener("click", async function() {
    debugLog("[noise-cancel] Button clicked, was: " + noiseCancelEnabled + ", micEnabled: " + micEnabled + ", room: " + !!room);
    noiseCancelEnabled = !noiseCancelEnabled;
    debugLog("[noise-cancel] Now: " + noiseCancelEnabled);
    echoSet("echo-noise-cancel", noiseCancelEnabled ? "true" : "false");
    ncBtn.textContent = noiseCancelEnabled ? "ON" : "OFF";
    ncBtn.classList.toggle("is-on", noiseCancelEnabled);

    if (noiseCancelEnabled && micEnabled && room) {
      debugLog("[noise-cancel] Enabling RNNoise...");
      try {
        await enableNoiseCancellation();
        debugLog("[noise-cancel] RNNoise enable completed OK");
      } catch (err) {
        debugLog("[noise-cancel] RNNoise enable failed: " + (err.message || err));
        noiseCancelEnabled = false;
        echoSet("echo-noise-cancel", "false");
        ncBtn.textContent = "OFF";
        ncBtn.classList.remove("is-on");
        setStatus("Noise cancellation failed: " + (err.message || err), true);
      }
    } else if (!noiseCancelEnabled) {
      debugLog("[noise-cancel] Disabling RNNoise...");
      disableNoiseCancellation();
    } else {
      debugLog("[noise-cancel] Toggled ON but mic not active or no room - will activate when mic is enabled");
    }
  });

  ncRow.append(ncLabel, ncBtn);
  ncSection.appendChild(ncRow);

  var ncDesc = document.createElement("div");
  ncDesc.className = "nc-description";
  ncDesc.textContent = "Reduces background noise like fans, AC, and keyboard sounds.";
  ncSection.appendChild(ncDesc);

  // Suppression strength selector
  var ncLevelRow = document.createElement("div");
  ncLevelRow.className = "nc-level-row";
  var ncLevelLabel = document.createElement("span");
  ncLevelLabel.className = "nc-toggle-label";
  ncLevelLabel.textContent = "Suppression strength";
  var ncLevelBtns = document.createElement("div");
  ncLevelBtns.className = "nc-level-btns";
  ["Light", "Medium", "Strong"].forEach(function(label, idx) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nc-level-btn" + (ncSuppressionLevel === idx ? " is-active" : "");
    btn.textContent = label;
    btn.addEventListener("click", function() {
      updateNoiseGateLevel(idx);
      ncLevelBtns.querySelectorAll(".nc-level-btn").forEach(function(b, i) {
        b.classList.toggle("is-active", i === idx);
      });
    });
    ncLevelBtns.appendChild(btn);
  });
  ncLevelRow.append(ncLevelLabel, ncLevelBtns);
  ncSection.appendChild(ncLevelRow);

  var ncLevelDesc = document.createElement("div");
  ncLevelDesc.className = "nc-description";
  ncLevelDesc.textContent = "Light = AI denoise only. Medium/Strong adds a noise gate that mutes silence.";
  ncSection.appendChild(ncLevelDesc);

  settingsDevicePanel.appendChild(ncSection);
  debugLog("[settings] NC section appended, button id: " + ncBtn.id + ", button in DOM: " + ncBtn.isConnected);

  // --- Custom Sounds section ---
  var existing = document.getElementById("chime-settings-section");
  if (existing) existing.remove();

  var section = document.createElement("div");
  section.id = "chime-settings-section";
  section.className = "chime-settings-section";

  var title = document.createElement("div");
  title.className = "chime-settings-title";
  title.textContent = "Custom Sounds";
  section.appendChild(title);

  ["enter", "exit"].forEach(function(kind) {
    var row = document.createElement("div");
    row.className = "chime-upload-row";

    var label = document.createElement("label");
    label.className = "chime-label";
    label.textContent = kind === "enter" ? "Enter Sound" : "Exit Sound";

    var controls = document.createElement("div");
    controls.className = "chime-controls";

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "audio/mpeg,audio/wav,audio/ogg,audio/webm,.mp3,.wav,.ogg,.webm";
    fileInput.className = "hidden";

    var uploadBtn = document.createElement("button");
    uploadBtn.type = "button";
    uploadBtn.className = "chime-btn";
    uploadBtn.textContent = "Upload";

    var previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "chime-btn chime-preview hidden";
    previewBtn.textContent = "Play";

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chime-btn chime-remove hidden";
    removeBtn.textContent = "Remove";

    var statusEl = document.createElement("span");
    statusEl.className = "chime-status";

    controls.append(fileInput, uploadBtn, previewBtn, removeBtn, statusEl);
    row.append(label, controls);
    section.appendChild(row);

    uploadBtn.addEventListener("click", function() { fileInput.click(); });

    fileInput.addEventListener("change", async function() {
      var file = fileInput.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        statusEl.textContent = "Too large (max 2MB)";
        return;
      }
      statusEl.textContent = "Uploading...";
      try {
        var identityBase = getIdentityBase(room.localParticipant.identity);
        // Infer MIME from extension if browser doesn't provide one
        var mime = file.type;
        if (!mime || mime === "application/octet-stream") {
          var ext = (file.name || "").split(".").pop().toLowerCase();
          var mimeMap = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg" };
          mime = mimeMap[ext] || "audio/mpeg";
        }
        var res = await fetch(apiUrl("/api/chime/upload?identity=" + encodeURIComponent(identityBase) + "&kind=" + kind), {
          method: "POST",
          headers: { Authorization: "Bearer " + adminToken, "Content-Type": mime },
          body: file
        });
        var data = await res.json().catch(function() { return {}; });
        if (data && data.ok) {
          statusEl.textContent = file.name;
          previewBtn.classList.remove("hidden");
          removeBtn.classList.remove("hidden");
          chimeBufferCache.delete(identityBase + "-" + kind);
        } else {
          statusEl.textContent = (data && data.error) || "Upload failed";
        }
      } catch (e) {
        statusEl.textContent = "Upload error";
      }
      fileInput.value = "";
    });

    previewBtn.addEventListener("click", async function() {
      var identityBase = getIdentityBase(room.localParticipant.identity);
      chimeBufferCache.delete(identityBase + "-" + kind);
      var buf = await fetchChimeBuffer(identityBase, kind);
      if (buf) playCustomChime(buf);
    });

    removeBtn.addEventListener("click", async function() {
      var identityBase = getIdentityBase(room.localParticipant.identity);
      try {
        await fetch(apiUrl("/api/chime/delete"), {
          method: "POST",
          headers: { Authorization: "Bearer " + adminToken, "Content-Type": "application/json" },
          body: JSON.stringify({ identity: identityBase, kind: kind })
        });
        chimeBufferCache.delete(identityBase + "-" + kind);
        previewBtn.classList.add("hidden");
        removeBtn.classList.add("hidden");
        statusEl.textContent = "";
      } catch (e) {}
    });

    // Check if chime already exists
    (async function() {
      if (!room || !room.localParticipant) return;
      var identityBase = getIdentityBase(room.localParticipant.identity);
      try {
        var res = await fetch(apiUrl("/api/chime/" + encodeURIComponent(identityBase) + "/" + kind), { method: "HEAD" });
        if (res.ok) {
          previewBtn.classList.remove("hidden");
          removeBtn.classList.remove("hidden");
          statusEl.textContent = "Custom sound set";
        }
      } catch (e) {}
    })();
  });

  settingsDevicePanel.appendChild(section);
}

// ── Version info + Update button at bottom of settings ──
// Called after room connect so it appears at the bottom (after device/NC/chime sections)
function buildVersionSection() {
  if (!settingsDevicePanel) return;
  if (document.getElementById("version-settings-section")) return; // already built
  var section = document.createElement("div");
  section.id = "version-settings-section";
  section.className = "chime-settings-section";
  section.innerHTML = '<div class="chime-settings-title">About</div>';
  var versionRow = document.createElement("div");
  versionRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-top:6px;";
  var versionLabel = document.createElement("span");
  versionLabel.id = "app-version-label";
  versionLabel.textContent = "Version: ...";
  versionLabel.style.cssText = "opacity:0.7; font-size:13px;";
  var updateBtn = document.createElement("button");
  updateBtn.type = "button";
  updateBtn.textContent = "Check for Updates";
  updateBtn.style.cssText = "font-size:12px; padding:4px 10px; cursor:pointer;";
  var updateStatus = document.createElement("span");
  updateStatus.id = "update-status";
  updateStatus.style.cssText = "font-size:12px; opacity:0.7; margin-left:4px;";
  versionRow.appendChild(versionLabel);
  versionRow.appendChild(updateBtn);
  versionRow.appendChild(updateStatus);
  section.appendChild(versionRow);
  settingsDevicePanel.appendChild(section);

  // Populate version from Tauri IPC or fallback
  (async function() {
    try {
      if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
        var info = await tauriInvoke("get_app_info");
        versionLabel.textContent = "Version: v" + info.version + " (" + info.platform + ")";
      } else {
        versionLabel.textContent = "Version: browser viewer";
      }
    } catch (e) {
      versionLabel.textContent = "Version: unknown";
    }
  })();

  // Check for updates button — calls Rust IPC command
  updateBtn.addEventListener("click", async function() {
    if (!window.__ECHO_NATIVE__ || !hasTauriIPC()) {
      updateStatus.textContent = "Updates only available in native client";
      return;
    }
    updateBtn.disabled = true;
    updateStatus.textContent = "Checking...";
    try {
      var result = await tauriInvoke("check_for_updates");
      if (result === "up_to_date") {
        updateStatus.innerHTML = 'You\'re on the latest version! <a href="https://github.com/SamWatson86/echo-chamber/releases/latest" target="_blank" style="color:var(--accent)">Check GitHub releases</a>';
      } else {
        // If we get here, update was found and installed — app will restart
        updateStatus.textContent = "Installing... app will restart.";
      }
    } catch (e) {
      var errStr = e.message || String(e);
      debugLog("[updater] check failed: " + errStr);
      updateStatus.innerHTML = 'Auto-update unavailable. <a href="https://github.com/SamWatson86/echo-chamber/releases/latest" target="_blank" style="color:var(--accent)">Download latest from GitHub</a>';
    }
    updateBtn.disabled = false;
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

// ═══════════════════════════════════════════
// THEME SYSTEM
// ═══════════════════════════════════════════

let matrixCanvas = null;
let matrixAnimationId = null;
let matrixResizeHandler = null;

function startMatrixRain() {
  if (matrixCanvas) return;
  matrixCanvas = document.createElement("canvas");
  matrixCanvas.id = "matrix-rain";
  document.body.prepend(matrixCanvas);
  const ctx = matrixCanvas.getContext("2d");
  const resize = () => {
    matrixCanvas.width = window.innerWidth;
    matrixCanvas.height = window.innerHeight;
  };
  resize();
  matrixResizeHandler = resize;
  window.addEventListener("resize", matrixResizeHandler);
  const fontSize = 14;
  let columns = Math.floor(matrixCanvas.width / fontSize);
  let drops = new Array(columns).fill(0).map(() => Math.random() * -50);
  const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF";
  function draw() {
    const cols = Math.floor(matrixCanvas.width / fontSize);
    if (cols !== columns) {
      columns = cols;
      drops = new Array(columns).fill(0).map(() => Math.random() * -50);
    }
    ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
    ctx.fillRect(0, 0, matrixCanvas.width, matrixCanvas.height);
    ctx.fillStyle = "#00ff41";
    ctx.font = `${fontSize}px monospace`;
    for (let i = 0; i < drops.length; i++) {
      const char = chars[Math.floor(Math.random() * chars.length)];
      const x = i * fontSize;
      const y = drops[i] * fontSize;
      ctx.globalAlpha = 0.8 + Math.random() * 0.2;
      ctx.fillText(char, x, y);
      if (y > matrixCanvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
    ctx.globalAlpha = 1;
    matrixAnimationId = requestAnimationFrame(draw);
  }
  draw();
}

function stopMatrixRain() {
  if (matrixAnimationId) {
    cancelAnimationFrame(matrixAnimationId);
    matrixAnimationId = null;
  }
  if (matrixResizeHandler) {
    window.removeEventListener("resize", matrixResizeHandler);
    matrixResizeHandler = null;
  }
  if (matrixCanvas) {
    matrixCanvas.remove();
    matrixCanvas = null;
  }
}

// ── Ultra Instinct energy particles ──
let uiParticleCanvas = null;
let uiParticleAnimationId = null;
let uiParticleResizeHandler = null;

function startUltraInstinctParticles() {
  if (uiParticleCanvas) return;
  uiParticleCanvas = document.createElement("canvas");
  uiParticleCanvas.id = "ui-particles";
  document.body.prepend(uiParticleCanvas);
  const ctx = uiParticleCanvas.getContext("2d");

  let w, h;

  // ── Sparkle particles (overlay on top of GIF background) ──
  const PARTICLE_COUNT = 80;
  const particles = [];

  function spawnParticle() {
    const type = Math.random();
    if (type < 0.55) {
      // White sparks — fast rising
      return {
        x: Math.random() * w,
        y: h + Math.random() * 30,
        vx: (Math.random() - 0.5) * 1.0,
        vy: -(1.0 + Math.random() * 2.0),
        size: 1 + Math.random() * 1.5,
        life: 1,
        decay: 0.005 + Math.random() * 0.006,
        kind: "spark",
      };
    } else if (type < 0.8) {
      // Silver orbs — slow drift
      return {
        x: Math.random() * w,
        y: h + Math.random() * 60,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -(0.3 + Math.random() * 0.6),
        size: 2 + Math.random() * 3,
        life: 1,
        decay: 0.001 + Math.random() * 0.002,
        kind: "orb",
      };
    } else {
      // Blue-silver wisps
      return {
        x: Math.random() * w,
        y: h + Math.random() * 80,
        vx: (Math.random() - 0.5) * 0.6,
        vy: -(0.4 + Math.random() * 0.8),
        size: 2 + Math.random() * 3,
        life: 1,
        decay: 0.002 + Math.random() * 0.003,
        kind: "wisp",
      };
    }
  }

  const resize = () => {
    w = uiParticleCanvas.width = window.innerWidth;
    h = uiParticleCanvas.height = window.innerHeight;
  };
  resize();
  uiParticleResizeHandler = resize;
  window.addEventListener("resize", uiParticleResizeHandler);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = spawnParticle();
    p.y = Math.random() * h;
    p.life = 0.3 + Math.random() * 0.7;
    particles.push(p);
  }

  let lastTime = performance.now();

  function draw(now) {
    const dt = Math.min((now - lastTime) / 16.667, 3);
    lastTime = now;
    ctx.clearRect(0, 0, w, h);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= p.decay * dt;

      if (p.kind === "wisp") {
        p.x += Math.sin(now * 0.001 + i) * 0.2 * dt;
      }

      if (p.life <= 0 || p.y < -20) {
        particles[i] = spawnParticle();
        continue;
      }

      const alpha = p.life * (p.kind === "spark" ? 0.85 : 0.5);

      if (p.kind === "orb") {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3);
        grad.addColorStop(0, `rgba(225, 230, 240, ${alpha})`);
        grad.addColorStop(0.4, `rgba(200, 208, 220, ${alpha * 0.5})`);
        grad.addColorStop(1, `rgba(180, 188, 200, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === "spark") {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 2);
        grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
        grad.addColorStop(0.5, `rgba(215, 225, 245, ${alpha * 0.4})`);
        grad.addColorStop(1, `rgba(190, 205, 235, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 4);
        grad.addColorStop(0, `rgba(150, 195, 250, ${alpha * 0.6})`);
        grad.addColorStop(0.5, `rgba(120, 165, 235, ${alpha * 0.25})`);
        grad.addColorStop(1, `rgba(90, 135, 215, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    uiParticleAnimationId = requestAnimationFrame(draw);
  }

  uiParticleAnimationId = requestAnimationFrame(draw);
}

function stopUltraInstinctParticles() {
  if (uiParticleAnimationId) {
    cancelAnimationFrame(uiParticleAnimationId);
    uiParticleAnimationId = null;
  }
  if (uiParticleResizeHandler) {
    window.removeEventListener("resize", uiParticleResizeHandler);
    uiParticleResizeHandler = null;
  }
  if (uiParticleCanvas) {
    uiParticleCanvas.remove();
    uiParticleCanvas = null;
  }
}

function applyTheme(name, skipSave) {
  document.body.dataset.theme = name;
  if (!skipSave) echoSet(THEME_STORAGE_KEY, name);
  // Toggle matrix rain
  if (name === "matrix") {
    startMatrixRain();
  } else {
    stopMatrixRain();
  }
  // Toggle ultra instinct particles
  if (name === "ultra-instinct") {
    startUltraInstinctParticles();
  } else {
    stopUltraInstinctParticles();
  }
  // Update active state on theme cards
  if (themePanel) {
    themePanel.querySelectorAll(".theme-card").forEach((card) => {
      card.classList.toggle("is-active", card.dataset.theme === name);
    });
  }
}

function initTheme() {
  const saved = echoGet(THEME_STORAGE_KEY) || "frost";
  // skipSave=true: don't overwrite saved settings before loadAllSettings() finishes
  applyTheme(saved, true);
}

// Theme panel open/close
if (openThemeButton && themePanel) {
  openThemeButton.addEventListener("click", () => {
    themePanel.classList.toggle("hidden");
  });
}

if (closeThemeButton && themePanel) {
  closeThemeButton.addEventListener("click", () => {
    themePanel.classList.add("hidden");
  });
}

// Theme card clicks
if (themePanel) {
  themePanel.querySelectorAll(".theme-card").forEach((card) => {
    card.addEventListener("click", () => {
      const theme = card.dataset.theme;
      if (theme) applyTheme(theme);
    });
  });
}

// Initialize theme on load
initTheme();

// ── UI Transparency slider ──
function applyUiOpacity(val) {
  const clamped = Math.max(20, Math.min(100, val));
  document.documentElement.style.setProperty("--ui-bg-alpha", clamped / 100);
  echoSet(UI_OPACITY_KEY, clamped);
  if (uiOpacityValue) uiOpacityValue.textContent = `${clamped}%`;
  if (uiOpacitySlider && parseInt(uiOpacitySlider.value, 10) !== clamped) {
    uiOpacitySlider.value = clamped;
  }
}

// Init from saved value
applyUiOpacity(parseInt(echoGet(UI_OPACITY_KEY) || "100", 10));

if (uiOpacitySlider) {
  uiOpacitySlider.addEventListener("input", (e) => {
    applyUiOpacity(parseInt(e.target.value, 10));
  });
}

// ── Jam Session ──

var openJamButton = document.getElementById("open-jam");
if (openJamButton) openJamButton.addEventListener("click", function() { openJamPanel(); });

// ── Bug Report ──

var bugReportBtn = document.getElementById("open-bug-report");
var bugReportModal = document.getElementById("bug-report-modal");
var bugReportDesc = document.getElementById("bug-report-desc");
var bugReportStatsEl = document.getElementById("bug-report-stats");
var bugReportStatusEl = document.getElementById("bug-report-status");
var submitBugReportBtn = document.getElementById("submit-bug-report");
var closeBugReportBtn = document.getElementById("close-bug-report");

function openBugReport() {
  if (!bugReportModal) return;
  bugReportModal.classList.remove("hidden");
  if (bugReportDesc) bugReportDesc.value = "";
  if (bugReportStatusEl) bugReportStatusEl.textContent = "";
  if (bugReportStatsEl) {
    if (_latestScreenStats) {
      var s = _latestScreenStats;
      bugReportStatsEl.innerHTML =
        '<div class="bug-stats-preview">Auto-captured: ' + (s.screen_fps || 0) + 'fps ' +
        (s.screen_width || 0) + 'x' + (s.screen_height || 0) + ' ' +
        ((s.screen_bitrate_kbps || 0) / 1000).toFixed(1) + 'Mbps ' +
        'BWE=' + ((s.bwe_kbps || 0) / 1000).toFixed(1) + 'Mbps ' +
        (s.encoder || '?') + ' ' + (s.quality_limitation || 'none') + '</div>';
    } else {
      bugReportStatsEl.innerHTML = '<div class="bug-stats-preview">No active screen share stats</div>';
    }
  }
  if (bugReportDesc) bugReportDesc.focus();
}

function closeBugReportModal() {
  if (bugReportModal) bugReportModal.classList.add("hidden");
}

async function sendBugReport() {
  if (!bugReportDesc) return;
  var desc = bugReportDesc.value.trim();
  if (!desc) {
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Please describe the issue.";
    return;
  }
  var token = adminToken;
  if (!token) {
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Not connected.";
    return;
  }
  var payload = {
    description: desc,
    identity: room?.localParticipant?.identity || "",
    name: room?.localParticipant?.name || "",
    room: currentRoomName || "",
  };
  if (_latestScreenStats) {
    Object.assign(payload, _latestScreenStats);
  }
  try {
    if (submitBugReportBtn) submitBugReportBtn.disabled = true;
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Sending...";
    var res = await fetch(apiUrl("/api/bug-report"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      if (bugReportStatusEl) bugReportStatusEl.textContent = "Report sent! Thank you.";
      bugReportDesc.value = "";
      setTimeout(closeBugReportModal, 1500);
    } else {
      if (bugReportStatusEl) bugReportStatusEl.textContent = "Failed (status " + res.status + ")";
    }
  } catch (e) {
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Error: " + e.message;
  } finally {
    if (submitBugReportBtn) submitBugReportBtn.disabled = false;
  }
}

if (bugReportBtn) {
  bugReportBtn.addEventListener("click", openBugReport);
}
if (closeBugReportBtn) {
  closeBugReportBtn.addEventListener("click", closeBugReportModal);
}
if (submitBugReportBtn) {
  submitBugReportBtn.addEventListener("click", sendBugReport);
}
if (bugReportDesc) {
  bugReportDesc.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      sendBugReport();
    }
  });
}

// Start Who's Online polling on page load (only while not connected)
startOnlineUsersPolling();

// ═══════════════════════════════════════════
// ADMIN PANEL
// ═══════════════════════════════════════════

var _adminDashTimer = null;
var _adminDashOpen = false;

function adminKickParticipant(identity) {
  if (!confirm("Kick " + identity + " from the room?")) return;
  var roomId = currentRoomId;
  if (!roomId) return;
  fetch(apiUrl("/v1/rooms/" + encodeURIComponent(roomId) + "/kick/" + encodeURIComponent(identity)), {
    method: "POST",
    headers: { "Authorization": "Bearer " + adminToken }
  }).then(function(res) {
    if (res.ok) {
      setStatus("Kicked " + identity);
    } else {
      setStatus("Kick failed: " + res.status, true);
    }
  }).catch(function(e) {
    setStatus("Kick error: " + e.message, true);
  });
}

function adminMuteParticipant(identity) {
  var roomId = currentRoomId;
  if (!roomId) return;
  fetch(apiUrl("/v1/rooms/" + encodeURIComponent(roomId) + "/mute/" + encodeURIComponent(identity)), {
    method: "POST",
    headers: { "Authorization": "Bearer " + adminToken }
  }).then(function(res) {
    if (res.ok) {
      setStatus("Server-muted " + identity);
    } else {
      setStatus("Mute failed: " + res.status, true);
    }
  }).catch(function(e) {
    setStatus("Mute error: " + e.message, true);
  });
}

function toggleAdminDash() {
  var panel = document.getElementById("admin-dash-panel");
  if (!panel) return;
  _adminDashOpen = !_adminDashOpen;
  if (_adminDashOpen) {
    panel.classList.remove("hidden");
    fetchAdminDashboard();
    fetchAdminHistory();
    fetchAdminMetrics();
    fetchAdminBugs();
    _adminDashTimer = setInterval(function() {
      fetchAdminDashboard();
    }, 3000);
  } else {
    panel.classList.add("hidden");
    if (_adminDashTimer) {
      clearInterval(_adminDashTimer);
      _adminDashTimer = null;
    }
  }
}

function switchAdminTab(btn, tabId) {
  document.querySelectorAll(".admin-dash-content").forEach(function(el) { el.classList.add("hidden"); });
  document.querySelectorAll(".adm-tab").forEach(function(el) { el.classList.remove("active"); });
  var tab = document.getElementById(tabId);
  if (tab) tab.classList.remove("hidden");
  btn.classList.add("active");
}

function escAdm(s) {
  var d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function fmtDur(secs) {
  if (secs == null) return "";
  var h = Math.floor(secs / 3600);
  var m = Math.floor((secs % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return Math.max(1, Math.floor(secs)) + "s";
}

function fmtTime(ts) {
  var d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function fetchAdminDashboard() {
  try {
    var res = await fetch(apiUrl("/admin/api/dashboard"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    var data = await res.json();
    var el = document.getElementById("admin-dash-live");
    if (!el) return;
    var total = data.total_online || 0;
    var html = '<div class="adm-stat-row"><span class="adm-stat-label">Online</span><span class="adm-stat-value">' + total + '</span></div>';
    if (data.rooms && data.rooms.length > 0) {
      data.rooms.forEach(function(room) {
        var pCount = room.participants ? room.participants.length : 0;
        html += '<div class="adm-room-card"><div class="adm-room-header">' + escAdm(room.room_id) + ' <span class="adm-room-count">' + pCount + '</span></div>';
        (room.participants || []).forEach(function(p) {
          var s = p.stats || {};
          var chips = "";
          if (s.ice_remote_type) chips += '<span class="adm-badge adm-ice-' + s.ice_remote_type + '">' + s.ice_remote_type + '</span>';
          if (s.screen_fps != null) chips += '<span class="adm-chip">' + s.screen_fps + 'fps ' + s.screen_width + 'x' + s.screen_height + '</span>';
          if (s.quality_limitation && s.quality_limitation !== "none") chips += '<span class="adm-badge adm-badge-warn">' + s.quality_limitation + '</span>';
          html += '<div class="adm-participant"><span>' + escAdm(p.name || p.identity) + '</span><span class="adm-time">' + fmtDur(p.online_seconds) + '</span>' + chips + '</div>';
        });
        html += '</div>';
      });
    } else {
      html += '<div class="adm-empty">No active rooms</div>';
    }
    el.innerHTML = html;
  } catch (e) {}
}

async function fetchAdminHistory() {
  try {
    var res = await fetch(apiUrl("/admin/api/sessions"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    var data = await res.json();
    var el = document.getElementById("admin-dash-history");
    if (!el) return;
    var events = data.events || [];
    if (events.length === 0) {
      el.innerHTML = '<div class="adm-empty">No session history</div>';
      return;
    }
    var html = '<table class="adm-table"><thead><tr><th>Time</th><th>Event</th><th>User</th><th>Room</th><th>Duration</th></tr></thead><tbody>';
    events.forEach(function(ev) {
      var isJoin = ev.event_type === "join";
      html += '<tr><td>' + fmtTime(ev.timestamp) + '</td><td><span class="adm-badge ' + (isJoin ? 'adm-join' : 'adm-leave') + '">' + (isJoin ? 'JOIN' : 'LEAVE') + '</span></td><td>' + escAdm(ev.name || ev.identity) + '</td><td>' + escAdm(ev.room_id) + '</td><td>' + (ev.duration_secs != null ? fmtDur(ev.duration_secs) : '') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {}
}

async function fetchAdminMetrics() {
  try {
    var res = await fetch(apiUrl("/admin/api/metrics"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    var data = await res.json();
    var el = document.getElementById("admin-dash-metrics");
    if (!el) return;
    var users = data.users || [];
    if (users.length === 0) {
      el.innerHTML = '<div class="adm-empty">No metrics data</div>';
      return;
    }
    var html = '<table class="adm-table"><thead><tr><th>User</th><th>Avg FPS</th><th>Avg Bitrate</th><th>Time</th><th>BW Limited</th><th>CPU Limited</th></tr></thead><tbody>';
    users.forEach(function(u) {
      html += '<tr><td>' + escAdm(u.name || u.identity) + '</td><td>' + u.avg_fps + '</td><td>' + (u.avg_bitrate_kbps / 1000).toFixed(1) + ' Mbps</td><td>' + u.total_minutes.toFixed(1) + 'm</td><td>' + u.pct_bandwidth_limited + '%</td><td>' + u.pct_cpu_limited + '%</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {}
}

async function fetchAdminBugs() {
  try {
    var res = await fetch(apiUrl("/admin/api/bugs"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    var data = await res.json();
    var el = document.getElementById("admin-dash-bugs");
    if (!el) return;
    var reports = data.reports || [];
    if (reports.length === 0) {
      el.innerHTML = '<div class="adm-empty">No bug reports</div>';
      return;
    }
    var html = "";
    reports.forEach(function(r) {
      html += '<div class="adm-bug"><div class="adm-bug-header"><strong>' + escAdm(r.reporter || r.identity) + '</strong><span class="adm-time">' + fmtTime(r.timestamp) + '</span></div><div class="adm-bug-desc">' + escAdm(r.description) + '</div></div>';
    });
    el.innerHTML = html;
  } catch (e) {}
}
