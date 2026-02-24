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

// Image lightbox — click chat image to view full-size, click or ESC to close
function openImageLightbox(src) {
  var overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  var img = document.createElement("img");
  img.src = src;
  overlay.appendChild(img);
  var hint = document.createElement("div");
  hint.className = "image-lightbox-hint";
  hint.textContent = "Click anywhere or press ESC to close";
  overlay.appendChild(hint);
  setTimeout(function() { hint.classList.add("fade-out"); }, 2000);

  overlay.addEventListener("click", function(e) {
    if (e.target === img) return; // clicking the image itself does nothing
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  });
  function onKey(e) {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
  }
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
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
  }, 50); // 20Hz — adequate for voice activity detection, was 50Hz which burned CPU
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
// Extract viewer version from the cache-busting ?v= param stamped on app.js by the server
var _viewerVersion = (function() {
  try {
    var scripts = document.querySelectorAll('script[src*="app.js"]');
    for (var i = 0; i < scripts.length; i++) {
      var m = scripts[i].src.match(/[?&]v=([^&]+)/);
      if (m) return m[1];
    }
  } catch(e) {}
  return null;
})();
let _latestScreenStats = null;
let currentRoomName = "main";
let _connectedRoomName = "main"; // Only updated after SFU connection succeeds — used by heartbeat
let currentAccessToken = "";
const IDENTITY_SUFFIX_KEY = "echo-core-identity-suffix";
const DEVICE_ID_KEY = "echo-core-device-id";
let audioMonitorTimer = null;
let roomAudioMuted = false;
let localScreenTrackSid = "";
let screenRestarting = false;
let _cameraReducedForScreenShare = false;
let _bwLimitedCount = 0; // consecutive stats ticks showing bandwidth limitation
let _bweLowTicks = 0;       // consecutive stats ticks with stuck-low BWE
let _bweKickAttempted = false; // true after BWE watchdog re-asserts encoder params
let _highPausedTicks = 0;   // consecutive ticks where HIGH simulcast layer is paused (0fps, limit=bandwidth)
let _latestOutboundBwe = 0; // latest BWE (kbps) from outbound stats — updated every tick, read by LOW restore interval
// ── Adaptive publisher bitrate control (publisher side) ──
// When a remote viewer detects packet loss on our screen share, they send a
// bitrate-cap data channel message. We apply the most restrictive cap across
// all requesters via RTCRtpSender.setParameters(). Caps expire after 15s TTL.
let _bitrateCaps = new Map();        // senderIdentity -> { high, med, low, timestamp }
let _currentAppliedCap = null;       // { high, med, low } currently applied, or null = uncapped
let _bitrateCapCleanupTimer = null;  // interval that expires stale caps
const BITRATE_CAP_TTL = 15000;       // 15s before a requester's cap expires
const BITRATE_DEFAULT_HIGH = 15_000_000;
const BITRATE_DEFAULT_MED = 5_000_000;
const BITRATE_DEFAULT_LOW = 1_500_000;
const screenReshareRequests = new Map();
const ENABLE_SCREEN_WATCHDOG = true;
// ── Shared AudioContext for participant volume boost (GainNode) ──
// A single AudioContext handles all participant audio routing. GainNode
// allows amplification beyond 1.0 (100%) for volume boost up to 300%.
let _participantAudioCtx = null;
function getParticipantAudioCtx() {
  if (!_participantAudioCtx || _participantAudioCtx.state === "closed") {
    _participantAudioCtx = new AudioContext();
    // Route to selected speaker device if one is chosen
    if (selectedSpeakerId && typeof _participantAudioCtx.setSinkId === "function") {
      _participantAudioCtx.setSinkId(selectedSpeakerId).catch(() => {});
    }
  }
  if (_participantAudioCtx.state === "suspended") {
    _participantAudioCtx.resume().catch(() => {});
  }
  return _participantAudioCtx;
}
let lastActiveSpeakerEvent = 0;
const screenRecoveryAttempts = new Map();
const AUDIO_MONITOR_INTERVAL = 200; // 5Hz — human speech detection doesn't need faster
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
const watchedScreens = new Set(); // Identities the user explicitly opted in to watch

/**
 * Returns true if this publication is a remote screen share (video or audio)
 * that the local user has NOT opted in to watch.
 * Used to gate all setSubscribed(true) calls so unwatched screens don't stream.
 */
function isUnwatchedScreenShare(publication, participant) {
  var LK = getLiveKitClient();
  if (!LK || !publication || !participant) return false;
  var source = publication.source || (publication.track ? publication.track.source : null);
  var isScreen = source === LK.Track.Source.ScreenShare ||
                 source === LK.Track.Source.ScreenShareAudio;
  if (!isScreen) return false;
  // Local user always watches their own screen
  if (room && room.localParticipant &&
      participant.identity === room.localParticipant.identity) return false;
  // If identity is in hiddenScreens, it's unwatched
  return hiddenScreens.has(participant.identity);
}

/** Reliably extract track source from publication + track. Used everywhere. */
function getTrackSource(publication, track) {
  return publication?.source || track?.source || null;
}

const chatHistory = [];
let chatDataChannel = null;
const CHAT_MESSAGE_TYPE = "chat-message";
const CHAT_FILE_TYPE = "chat-file";
const FIXED_ROOMS = ["main", "breakout-1", "breakout-2", "breakout-3"];

// ── Fast room switching: token cache + pre-warm state ──
const tokenCache = new Map(); // roomId -> { token, fetchedAt, expiresInSeconds }
const TOKEN_CACHE_MARGIN_MS = 60000; // Refresh tokens 60s before expiry
var _isRoomSwitch = false; // True during switchRoom(), cleared after fast-wave settles
var _isReconnecting = false; // True during signal/media reconnection — suppresses chimes and delays cleanup
var _pendingDisconnects = new Map(); // identity -> timeoutId, delayed cleanup during reconnection
var _lastTokenPrefetch = 0;
const avatarUrls = new Map(); // identity_base -> avatar URL
const deviceIdByIdentity = new Map(); // identityBase -> deviceId (for remote participants)
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
    const name = escapeHtml(u.name || "Unknown");
    const room = escapeHtml(u.room || "");
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
  "echo-core-identity-suffix", "echo-core-device-id",
  "echo-avatar-device", "echo-volume-prefs"
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

// ─── Per-participant volume persistence ───
function _getVolumePrefs() {
  try { return JSON.parse(echoGet("echo-volume-prefs") || "{}"); } catch(e) { return {}; }
}
function _saveVolumePrefs(prefs) {
  echoSet("echo-volume-prefs", JSON.stringify(prefs));
}
function saveParticipantVolume(identity, mic, screen) {
  var prefs = _getVolumePrefs();
  prefs[identity] = { mic: mic, screen: screen };
  _saveVolumePrefs(prefs);
}
function getParticipantVolume(identity) {
  var prefs = _getVolumePrefs();
  return prefs[identity] || null;
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

var _debugDirty = false;
var _debugRafPending = false;
function debugLog(message) {
  if (!message) return;
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${message}`;
  debugLines.push(line);
  while (debugLines.length > DEBUG_LIMIT) debugLines.shift();
  // Batch DOM updates — only repaint debug panel once per animation frame
  if (debugLogEl && !_debugRafPending) {
    _debugDirty = true;
    _debugRafPending = true;
    requestAnimationFrame(function() {
      _debugRafPending = false;
      if (_debugDirty && debugLogEl) {
        debugLogEl.textContent = debugLines.join("\n");
        _debugDirty = false;
      }
    });
  }
}

// ── Persistent event logging (server-side JSONL) ──
// Captures important events (freeze, screen share start/stop, layer changes)
// to daily stats log files for offline diagnosis.
function logEvent(eventName, detail) {
  try {
    if (!room?.localParticipant?.identity) return;
    fetch(apiUrl("/api/stats-log"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: room.localParticipant.identity,
        room: currentRoomName || "",
        event: eventName,
        event_detail: detail || null,
      }),
    }).catch(function() {});
  } catch (e) {}
}

// ── General toast notification ──
function showToast(message, durationMs) {
  var existing = document.querySelector(".jam-toast");
  if (existing) existing.remove();
  var toast = document.createElement("div");
  toast.className = "jam-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function() { toast.classList.add("jam-toast-visible"); }, 10);
  setTimeout(function() {
    toast.classList.remove("jam-toast-visible");
    setTimeout(function() { toast.remove(); }, 400);
  }, durationMs || 4000);
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

// Stable device UUID — persists across sessions regardless of what name the user types.
// Used to key profile data (avatar, chimes) to the DEVICE, not the name.
function ensureDeviceId() {
  var existing = echoGet(DEVICE_ID_KEY);
  if (existing) return existing;
  // Generate a UUID-v4 using crypto API (or fallback to Math.random)
  var uuid;
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    uuid = crypto.randomUUID();
  } else if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    var hex = Array.from(bytes, function(b) { return b.toString(16).padStart(2, "0"); }).join("");
    uuid = hex.slice(0,8) + "-" + hex.slice(8,12) + "-" + hex.slice(12,16) + "-" + hex.slice(16,20) + "-" + hex.slice(20);
  } else {
    uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  echoSet(DEVICE_ID_KEY, uuid);
  return uuid;
}

// Get the device ID for the local user (shorthand used throughout profile code)
function getLocalDeviceId() {
  return ensureDeviceId();
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
    if (publication.setSubscribed && !isUnwatchedScreenShare(publication, participant)) {
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

function getScreenSharePublishOptions(srcW, srcH) {
  // Compute simulcast layers dynamically based on actual source dimensions.
  // This prevents the MEDIUM layer from matching HIGH when the source height
  // is less than 1080 (e.g. ultrawide 1920x804 after canvas cap).
  // Layers: MEDIUM = half resolution, LOW = third resolution.
  var medW = Math.round((srcW || 1920) / 2);
  var medH = Math.round((srcH || 1080) / 2);
  medW = medW - (medW % 2); medH = medH - (medH % 2); // even dims for H.264
  var lowW = Math.round((srcW || 1920) / 3);
  var lowH = Math.round((srcH || 1080) / 3);
  lowW = lowW - (lowW % 2); lowH = lowH - (lowH % 2);
  debugLog("[simulcast] layers: HIGH=" + (srcW||1920) + "x" + (srcH||1080) +
    " MED=" + medW + "x" + medH + " LOW=" + lowW + "x" + lowH);
  return {
    // H264 High profile with hardware encoding (NVENC/QSV/AMF) via WebView2 flags.
    // SDP is munged to upgrade Constrained Baseline (42e0) -> High (6400) to force
    // hardware encoder selection. Software encoders (OpenH264, libvpx) max ~25fps.
    videoCodec: "h264",
    // Simulcast: 3 quality layers so each receiver gets what their hardware can decode.
    // HIGH = source resolution @60fps. MEDIUM = half @60fps. LOW = third @30fps.
    // Layers are computed dynamically to guarantee MEDIUM < HIGH (ultrawide fix).
    // SFU selects the best layer per subscriber based on bandwidth + decode capability.
    simulcast: true,
    screenShareEncoding: { maxBitrate: 15_000_000, maxFramerate: 60 },
    screenShareSimulcastLayers: [
      { width: medW, height: medH, encoding: { maxBitrate: 5_000_000, maxFramerate: 60 } },
      { width: lowW, height: lowH, encoding: { maxBitrate: 1_500_000, maxFramerate: 30 } },
    ],
    // "maintain-framerate" drops resolution under pressure instead of FPS.
    // Critical for gaming — smooth 60fps at lower quality beats choppy high-res.
    // Old note: "caused encoder startup issues with NVENC (0fps)" — that was the
    // 12-second encoder death bug, now fixed by the canvas pipeline keeping frames flowing.
    degradationPreference: "maintain-framerate",
  };
}

// Track refs for manual screen share (so we can unpublish on stop)
let _screenShareVideoTrack = null;
let _screenShareAudioTrack = null;
let _screenShareStatsInterval = null;
let _inboundScreenStatsInterval = null;
let _inboundScreenLastBytes = new Map(); // identity -> { bytes, time }
// Adaptive layer selection: track quality per inbound video (screen shares + cameras)
// to auto-downgrade when decoder/network can't keep up, and upgrade when stable.
let _inboundDropTracker = new Map(); // "identity-source" -> { lastDropped, lastDecoded, highDropTicks, lowFpsTicks, stableTicks, currentQuality }
// ── Adaptive publisher bitrate control (receiver side) ──
// AIMD algorithm: when we detect loss on a remote screen share, we compute an
// optimal bitrate cap and send it to the publisher via data channel. The publisher
// applies it to their RTCRtpSender, reducing upload without changing resolution.
let _pubBitrateControl = new Map(); // publisherIdentity -> AIMD controller state

function startInboundScreenStatsMonitor() {
  if (_inboundScreenStatsInterval) return;
  _inboundScreenStatsInterval = setInterval(async () => {
    try {
      if (!room || !room.remoteParticipants) return;
      const LK = getLiveKitClient();
      // Extract ICE candidate-pair info once per poll cycle (from subscriber PeerConnection)
      var _iceType = "";
      try {
        const subPc = room.engine?.pcManager?.subscriber?.pc;
        if (subPc) {
          const pcStats = await subPc.getStats();
          const iceCandidates = new Map();
          pcStats.forEach(function(r) {
            if (r.type === "local-candidate" || r.type === "remote-candidate") iceCandidates.set(r.id, r);
          });
          pcStats.forEach(function(r) {
            if (r.type === "candidate-pair" && r.state === "succeeded") {
              const lc = iceCandidates.get(r.localCandidateId);
              const rc = iceCandidates.get(r.remoteCandidateId);
              var lType = lc?.candidateType || "?";
              var rType = rc?.candidateType || "?";
              var rtt = r.currentRoundTripTime ? Math.round(r.currentRoundTripTime * 1000) : "?";
              _iceType = `ice=${lType}->${rType} rtt=${rtt}ms`;
            }
          });
        }
      } catch (e) { /* ignore ICE stats errors */ }
      room.remoteParticipants.forEach(async (participant) => {
        const pubs = getParticipantPublications(participant);
        for (const pub of pubs) {
          // Monitor both screen shares and cameras (video only)
          if (pub?.source !== LK?.Track?.Source?.ScreenShare &&
              pub?.source !== LK?.Track?.Source?.Camera) continue;
          if (pub?.kind !== LK?.Track?.Kind?.Video) continue;
          if (!pub.track || !pub.isSubscribed) continue;
          // Skip unwatched screen shares
          if (pub.source === LK?.Track?.Source?.ScreenShare && hiddenScreens.has(participant.identity)) continue;
          // Get receiver stats from the track's mediaStreamTrack
          const mst = pub.track.mediaStreamTrack;
          if (!mst) continue;
          const pc = room.engine?.pcManager?.subscriber?.pc;
          if (!pc) continue;
          const receivers = pc.getReceivers();
          const receiver = receivers.find(r => r.track === mst);
          if (!receiver) continue;
          const stats = await receiver.getStats();
          var isCamera = pub.source === LK?.Track?.Source?.Camera;
          var sourceLabel = isCamera ? "camera" : "screen";
          stats.forEach((report) => {
            if (report.type === "inbound-rtp" && report.kind === "video") {
              const fps = report.framesPerSecond || 0;
              const w = report.frameWidth || 0;
              const h = report.frameHeight || 0;
              const now = Date.now();
              // Source-aware key so camera + screen for same participant are tracked independently
              const key = participant.identity + "-" + sourceLabel;
              const prev = _inboundScreenLastBytes.get(key);
              let kbps = 0;
              if (prev) {
                const elapsed = (now - prev.time) / 1000;
                const bytesDelta = report.bytesReceived - prev.bytes;
                kbps = elapsed > 0 ? Math.round((bytesDelta * 8) / elapsed / 1000) : 0;
              }
              _inboundScreenLastBytes.set(key, { bytes: report.bytesReceived, time: now });
              // Get codec info
              let codec = "?";
              if (report.codecId) {
                const codecReport = stats.get(report.codecId);
                if (codecReport) codec = codecReport.mimeType?.replace("video/", "") || "?";
              }
              const jitter = report.jitter ? Math.round(report.jitter * 1000) : 0;
              const pktLost = report.packetsLost || 0;
              const decoder = report.decoderImplementation || "?";
              const dropped = report.framesDropped || 0;
              const decoded = report.framesDecoded || 0;
              const nacks = report.nackCount || 0;
              const plis = report.pliCount || 0;

              // ── Adaptive layer selection: rolling average approach ──
              // Previous approach counted individual bad ticks but failed when FPS oscillates
              // (e.g. 13→23→29→14→25→18) — counter went up/down without ever triggering.
              // Now we track a rolling window of FPS samples and decide based on the AVERAGE.
              var dt = _inboundDropTracker.get(key);
              if (!dt) {
                // Cameras start on LOW (forceVideoLayer sends LOW first, then upgrades).
                // Screen shares start on HIGH. Initialize to match actual requested layer
                // to prevent false "HIGH is failing" downgrades.
                var initQuality = isCamera ? "LOW" : "HIGH";
                dt = {
                  lastDropped: dropped, lastDecoded: decoded,
                  lastLost: pktLost,    // track packet loss delta for proactive keyframe requests
                  fpsHistory: [],       // last N fps readings (rolling window)
                  lossHistory: [],      // last N ticks of packet loss deltas (rolling window for loss-rate detection)
                  lossDowngraded: false, // true if currently downgraded due to packet loss
                  lossStableTicks: 0,   // consecutive ticks with zero loss (for promote-back)
                  stableTicks: 0,
                  currentQuality: initQuality,
                  lastLayerChangeTime: 0,
                };
                _inboundDropTracker.set(key, dt);
              }
              var deltaDropped = dropped - dt.lastDropped;
              var deltaDecoded = decoded - dt.lastDecoded;
              dt.lastDropped = dropped;
              dt.lastDecoded = decoded;
              var dropRatio = deltaDecoded > 0 ? deltaDropped / (deltaDropped + deltaDecoded) : 0;

              // ── Proactive keyframe request on packet loss ──
              // When packets are lost, the decoder may stall waiting for a reference frame.
              // Rather than waiting for the natural PLI cycle (which can take seconds), we
              // detect new losses and immediately request a keyframe to speed recovery.
              // This is especially important for TURN relay users where RTT is 40-80ms —
              // NACK retransmission alone may not recover in time.
              var deltaLost = pktLost - (dt.lastLost || 0);
              dt.lastLost = pktLost;
              if (deltaLost > 0) {
                debugLog(`[packet-loss] ${key}: ${deltaLost} new packets lost (total=${pktLost}), requesting keyframe`);
                try {
                  if (pub.track?.requestKeyFrame) pub.track.requestKeyFrame();
                  else if (pub.videoTrack?.requestKeyFrame) pub.videoTrack.requestKeyFrame();
                } catch (e) { /* ignore */ }
              }
              // Also detect FPS stall (0fps when we previously had frames) — decoder is stuck
              if (fps === 0 && dt.fpsHistory.length > 0 && dt.fpsHistory[dt.fpsHistory.length - 1] > 0) {
                debugLog(`[stall-recovery] ${key}: FPS dropped to 0 (was ${dt.fpsHistory[dt.fpsHistory.length - 1]}), requesting keyframe`);
                try {
                  if (pub.track?.requestKeyFrame) pub.track.requestKeyFrame();
                  else if (pub.videoTrack?.requestKeyFrame) pub.videoTrack.requestKeyFrame();
                } catch (e) { /* ignore */ }
              }

              var qualityChanged = false;

              // ── SCREEN SHARES: Adaptive Publisher Bitrate Control (AIMD) ──
              // Instead of switching simulcast layers (which causes 1080p→360p jumps),
              // we tell the PUBLISHER to reduce their encoder bitrate. Resolution stays
              // 1080p@60fps; only compression level changes. Uses data channel messages.
              if (!isCamera && participant && room?.localParticipant) {
                var pubIdent = participant.identity;
                var ctrl = _pubBitrateControl.get(pubIdent);
                if (!ctrl) {
                  ctrl = {
                    lossHistory: [], kbpsHistory: [],
                    currentCapHigh: BITRATE_DEFAULT_HIGH, capped: false,
                    probePhase: "idle", probeBitrate: 0, probeCleanTicks: 0,
                    lastCapSendTime: 0, lastLossTime: 0, cleanTicksSinceLoss: 0,
                    ackReceived: false, firstCapSendTime: 0, fallbackToLayers: false,
                    _lockedHigh: false,
                  };
                  _pubBitrateControl.set(pubIdent, ctrl);
                }

                // Feed data into AIMD
                ctrl.lossHistory.push(deltaLost);
                if (ctrl.lossHistory.length > 10) ctrl.lossHistory.shift();
                ctrl.kbpsHistory.push(kbps);
                if (ctrl.kbpsHistory.length > 10) ctrl.kbpsHistory.shift();

                // EWMA loss (alpha=0.3, recent ticks weighted more)
                var ewmaLoss = 0, weightSum = 0;
                for (var ei = 0; ei < ctrl.lossHistory.length; ei++) {
                  var w_e = Math.pow(0.7, ctrl.lossHistory.length - 1 - ei);
                  ewmaLoss += ctrl.lossHistory[ei] * w_e;
                  weightSum += w_e;
                }
                ewmaLoss = weightSum > 0 ? ewmaLoss / weightSum : 0;

                // Average received kbps
                var avgKbps = ctrl.kbpsHistory.reduce(function(a, b) { return a + b; }, 0) /
                              Math.max(1, ctrl.kbpsHistory.length);

                // Estimate loss rate
                var lossRate = 0;
                if (avgKbps > 0 && ewmaLoss > 0) {
                  var estTotalPkts = (avgKbps * 1000 / 8 / 1200) * 3 + ewmaLoss;
                  lossRate = ewmaLoss / Math.max(1, estTotalPkts);
                }

                // ── AIMD trigger: use loss RATE not absolute count ──
                // At 12Mbps/60fps through TURN relay, ~4000 packets per 3s tick.
                // TURN relay normally produces 0.03% loss (small bursts of 1-50 pkts).
                // Only trigger AIMD when loss rate exceeds 0.5% (genuine congestion).
                var estPktsPerTick = Math.max(100, (avgKbps * 1000 / 8 / 1200) * 3);
                var tickLossRate = deltaLost / estPktsPerTick;
                var isCongestion = tickLossRate > 0.005; // >0.5% loss rate
                var isSevereCongestion = tickLossRate > 0.02; // >2% loss rate
                var targetHighBps = ctrl.currentCapHigh;
                var nowCtrl = Date.now();

                if (isCongestion) {
                  // ── LOSS DETECTED: multiplicative decrease ──
                  ctrl.lastLossTime = nowCtrl;
                  ctrl.cleanTicksSinceLoss = 0;
                  ctrl.probePhase = "backing-off";
                  ctrl.probeCleanTicks = 0;

                  if (!ctrl.capped) {
                    // First congestion: cut to 70% of received bitrate
                    targetHighBps = Math.round(avgKbps * 1000 * 0.7);
                  } else {
                    // Already capped, still congested: ×0.7 multiplicative decrease
                    targetHighBps = Math.round(ctrl.currentCapHigh * 0.7);
                  }
                  // Severe congestion: more aggressive (50%)
                  if (isSevereCongestion) {
                    targetHighBps = Math.round(avgKbps * 1000 * 0.5);
                  }
                  // Floor 1Mbps, ceiling 15Mbps
                  targetHighBps = Math.max(1_000_000, Math.min(targetHighBps, BITRATE_DEFAULT_HIGH));
                  ctrl.currentCapHigh = targetHighBps;
                  ctrl.capped = true;
                  debugLog("[bitrate-ctrl] " + pubIdent + ": lossRate=" +
                    (tickLossRate * 100).toFixed(2) + "% (" + deltaLost + "/" +
                    Math.round(estPktsPerTick) + " pkts) → cap=" +
                    Math.round(targetHighBps / 1000) + "kbps");

                } else {
                  // ── LOW/MODERATE LOSS (below congestion threshold): recover ──
                  // Allow recovery even during stalls (fps=0) — the old fps>0 check
                  // caused a deadlock: AIMD capped → stall → couldn't uncap because fps=0
                  // TURN relay normally has 0.03-0.15% loss — this is NOT congestion.
                  ctrl.cleanTicksSinceLoss++;

                  // ── BURST DETECTION: instant snap-back for transient loss ──
                  // TURN relay bursts are transient (wifi interference, buffer overflow).
                  // Pattern: large loss in one tick, then immediately clean.
                  // If the FIRST tick after capping is clean, path capacity is unchanged
                  // — snap back immediately instead of slow 12s probe ramp.
                  if (ctrl.capped && ctrl.cleanTicksSinceLoss === 1 && ctrl.probePhase === "backing-off") {
                    // First tick after loss is clean → burst, not sustained congestion
                    debugLog("[bitrate-ctrl] " + pubIdent + ": burst detected (clean after 1 tick) — INSTANT SNAP BACK");
                    targetHighBps = BITRATE_DEFAULT_HIGH;
                    ctrl.currentCapHigh = targetHighBps;
                    ctrl.capped = false;
                    ctrl.probePhase = "idle";
                    ctrl.lossHistory = [];
                    ctrl.kbpsHistory = [];
                  }
                  // Sustained congestion recovery: slow probe ramp
                  else if (ctrl.capped && ctrl.cleanTicksSinceLoss >= 3) {
                    // 3 consecutive clean ticks (~9s) = sustained congestion has cleared
                    debugLog("[bitrate-ctrl] " + pubIdent + ": 9s low-loss — SNAP BACK to full bitrate");
                    targetHighBps = BITRATE_DEFAULT_HIGH;
                    ctrl.currentCapHigh = targetHighBps;
                    ctrl.capped = false;
                    ctrl.probePhase = "idle";
                    ctrl.lossHistory = [];
                    ctrl.kbpsHistory = [];
                  } else if (ctrl.capped && ctrl.probePhase === "backing-off" && ctrl.cleanTicksSinceLoss >= 2) {
                    // 2 clean ticks but not burst (loss continued for >1 tick) — start probing
                    ctrl.probePhase = "probing";
                    ctrl.probeCleanTicks = 0;
                    ctrl.probeBitrate = ctrl.currentCapHigh + 3_000_000; // faster: +3Mbps steps
                    ctrl.probeBitrate = Math.min(ctrl.probeBitrate, BITRATE_DEFAULT_HIGH);
                    targetHighBps = ctrl.probeBitrate;
                    ctrl.currentCapHigh = targetHighBps;
                  } else if (ctrl.probePhase === "probing") {
                    ctrl.probeCleanTicks++;
                    // 1 clean tick (~3s) per step, +3Mbps per step
                    if (ctrl.probeCleanTicks >= 1) {
                      ctrl.probeCleanTicks = 0;
                      ctrl.probeBitrate = ctrl.currentCapHigh + 3_000_000;
                      if (ctrl.probeBitrate >= BITRATE_DEFAULT_HIGH) {
                        // Reached full bitrate — uncap
                        targetHighBps = BITRATE_DEFAULT_HIGH;
                        ctrl.currentCapHigh = targetHighBps;
                        ctrl.capped = false;
                        ctrl.probePhase = "idle";
                        ctrl.lossHistory = [];
                        ctrl.kbpsHistory = [];
                      } else {
                        targetHighBps = ctrl.probeBitrate;
                        ctrl.currentCapHigh = targetHighBps;
                      }
                    }
                  }
                }

                // Send cap or restore to publisher
                if (ctrl.capped && nowCtrl - ctrl.lastCapSendTime >= 2000) {
                  ctrl.lastCapSendTime = nowCtrl;
                  if (!ctrl.firstCapSendTime) ctrl.firstCapSendTime = nowCtrl;
                  var capMsg = {
                    type: "bitrate-cap", version: 1,
                    targetBitrateHigh: targetHighBps,
                    targetBitrateMed: Math.round(targetHighBps * 0.33),
                    targetBitrateLow: Math.round(targetHighBps * 0.1),
                    reason: isSevereCongestion ? "severe" : isCongestion ? "congestion" :
                            ctrl.probePhase === "probing" ? "probe" : "hold",
                    lossRate: Math.round(lossRate * 1000) / 1000,
                    senderIdentity: room.localParticipant.identity
                  };
                  try {
                    room.localParticipant.publishData(
                      new TextEncoder().encode(JSON.stringify(capMsg)),
                      { reliable: true, destinationIdentities: [pubIdent] }
                    );
                    debugLog("[bitrate-ctrl] sent cap to " + pubIdent + ": HIGH=" +
                      Math.round(targetHighBps / 1000) + "kbps phase=" + ctrl.probePhase +
                      " reason=" + capMsg.reason);
                  } catch (e) { /* ignore send failure */ }

                  // Ensure we stay on HIGH layer (don't also downgrade layer)
                  if (!ctrl._lockedHigh && LK?.VideoQuality) {
                    try {
                      if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.HIGH);
                    } catch (e) {}
                    ctrl._lockedHigh = true;
                  }
                }

                // Send restore when uncapped (once)
                if (!ctrl.capped && ctrl.lastCapSendTime > 0) {
                  var restoreMsg = {
                    type: "bitrate-cap", version: 1,
                    targetBitrateHigh: BITRATE_DEFAULT_HIGH,
                    targetBitrateMed: BITRATE_DEFAULT_MED,
                    targetBitrateLow: BITRATE_DEFAULT_LOW,
                    reason: "restore", lossRate: 0,
                    senderIdentity: room.localParticipant.identity
                  };
                  try {
                    room.localParticipant.publishData(
                      new TextEncoder().encode(JSON.stringify(restoreMsg)),
                      { reliable: true, destinationIdentities: [pubIdent] }
                    );
                    debugLog("[bitrate-ctrl] sent RESTORE to " + pubIdent);
                  } catch (e) { /* ignore */ }
                  ctrl.lastCapSendTime = 0;
                  ctrl.firstCapSendTime = 0;
                  ctrl._lockedHigh = false;
                }

                // Fallback: if publisher never ack'd after 10s, revert to v3 layer switching
                if (ctrl.capped && ctrl.firstCapSendTime > 0 && !ctrl.ackReceived &&
                    nowCtrl - ctrl.firstCapSendTime > 10000) {
                  debugLog("[bitrate-ctrl] " + pubIdent + " no ack after 10s — falling back to layer switching");
                  ctrl.fallbackToLayers = true;
                  _pubBitrateControl.delete(pubIdent);
                }
              }

              // ── CAMERAS (or screen share fallback): v3 layer switching ──
              // Only used for camera tracks, or screen shares where bitrate control failed.
              var _bitrateCtrlActive = !isCamera && _pubBitrateControl.has(participant?.identity);
              if (!_bitrateCtrlActive) {
                dt.lossHistory.push(deltaLost);
                if (dt.lossHistory.length > 8) dt.lossHistory.shift();
                var nowMsLoss = Date.now();
                var timeSinceLastLossChange = nowMsLoss - (dt.lastLayerChangeTime || 0);
                var prevFps = dt.fpsHistory.length > 0 ? dt.fpsHistory[dt.fpsHistory.length - 1] : 0;
                var isStalled = fps === 0 && prevFps > 0;
                var isTanking = fps > 0 && fps < 30 && prevFps >= 30 && deltaLost > 15;
                var isBurstNuke = deltaLost >= 50;
                var shouldDropLow = (isStalled && deltaLost > 0) || isTanking || isBurstNuke;

                if (shouldDropLow && dt.currentQuality !== "LOW" && timeSinceLastLossChange >= 3000 && LK?.VideoQuality) {
                  var oldQ = dt.currentQuality;
                  dt.currentQuality = "LOW";
                  dt.lossDowngraded = true;
                  dt.lossStableTicks = 0;
                  dt.fpsHistory = [];
                  dt.stableTicks = 0;
                  dt.lastLayerChangeTime = nowMsLoss;
                  dt.lossHistory = [];
                  qualityChanged = true;
                  var dropReason = isStalled ? "stall+loss(" + deltaLost + ")" : isTanking ? "fps-tanking(" + fps + "fps+" + deltaLost + "lost)" : "burst-nuke(" + deltaLost + "lost)";
                  debugLog("[adaptive-loss] " + key + ": INSTANT DROP " + oldQ + " -> LOW (" + dropReason + ")");
                  logEvent("loss-drop", key + ": " + oldQ + "->LOW " + dropReason);
                  try {
                    if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.LOW);
                    if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.LOW });
                  } catch (e) { debugLog("[adaptive-loss] drop failed: " + e.message); }
                }

                if (dt.lossDowngraded) {
                  if (deltaLost === 0 && fps > 0) {
                    dt.lossStableTicks++;
                  } else {
                    dt.lossStableTicks = 0;
                  }
                  if (dt.lossStableTicks >= 4 && timeSinceLastLossChange >= 12000 && LK?.VideoQuality) {
                    dt.currentQuality = "HIGH";
                    dt.lossDowngraded = false;
                    dt.fpsHistory = [];
                    dt.stableTicks = 0;
                    dt.lossStableTicks = 0;
                    dt.lossHistory = [];
                    dt.lastLayerChangeTime = nowMsLoss;
                    qualityChanged = true;
                    debugLog("[adaptive-loss] " + key + ": clean 12s, SNAP BACK LOW -> HIGH");
                    logEvent("loss-snapback", key + ": LOW->HIGH");
                    try {
                      if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.HIGH);
                      if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.HIGH });
                    } catch (e) { debugLog("[adaptive-loss] snapback failed: " + e.message); }
                  }
                }
              }

              // Push FPS into rolling window (keep last 5 ticks = 15 seconds)
              if (fps > 0) dt.fpsHistory.push(fps);
              if (dt.fpsHistory.length > 5) dt.fpsHistory.shift();

              // Calculate rolling average FPS (used by both layer switching and debug log)
              var avgFps = 0;
              if (dt.fpsHistory.length > 0) {
                avgFps = dt.fpsHistory.reduce(function(a, b) { return a + b; }, 0) / dt.fpsHistory.length;
              }

              // ── FPS-based layer switching ──
              // Skip for screen shares when AIMD bitrate control is active — bitrate
              // control handles quality smoothly without resolution jumps. Only used
              // for cameras, or screen shares where bitrate control isn't active/failed.
              if (!_bitrateCtrlActive) {

              // Downgrade when rolling average is clearly bad:
              // - avgFps < 30 over 15 seconds = consistently struggling (catches Jeff's 13-29fps oscillation)
              // - OR decode struggles (> 40% frame drop ratio)
              // Spencer on fiber at 50-60fps will never hit avgFps < 30.
              var shouldDowngrade = (dt.fpsHistory.length >= 4 && avgFps < 30) || dropRatio > 0.4;
              var reason = dropRatio > 0.4 ? "decode (drop=" + Math.round(dropRatio * 100) + "%)"
                : "low avg fps (" + Math.round(avgFps) + "fps avg over " + dt.fpsHistory.length + " ticks)";

              // Cooldown: don't switch layers more than once per 30 seconds to prevent thrashing
              var nowMs = Date.now();
              var timeSinceLastChange = nowMs - dt.lastLayerChangeTime;
              var layerCooldown = 30000;

              if (shouldDowngrade && timeSinceLastChange >= layerCooldown && dt.currentQuality === "HIGH" && LK?.VideoQuality) {
                var newQuality = isCamera ? "LOW" : "MEDIUM";
                var newLKQuality = isCamera ? LK.VideoQuality.LOW : LK.VideoQuality.MEDIUM;
                dt.currentQuality = newQuality;
                dt.fpsHistory = []; // reset window after layer change
                dt.stableTicks = 0;
                dt.lastLayerChangeTime = nowMs;
                qualityChanged = true;
                debugLog("[adaptive-layer] " + key + ": " + reason + ", downgrading HIGH -> " + newQuality);
                logEvent("layer-downgrade", key + ": HIGH->" + newQuality + " " + reason);
                try {
                  if (pub.setVideoQuality) pub.setVideoQuality(newLKQuality);
                  if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: newLKQuality });
                } catch (e) { debugLog("[adaptive-layer] downgrade failed: " + e.message); }
              } else if (shouldDowngrade && timeSinceLastChange >= layerCooldown && dt.currentQuality === "MEDIUM" && !isCamera && LK?.VideoQuality) {
                // Only downgrade MEDIUM -> LOW if there are actual decode problems (frame drops).
                // If dropRatio is near zero, the frames that arrive decode fine — the bottleneck is
                // the SFU transport pacer (e.g. TURN relay users), and downgrading to LOW just gives
                // worse resolution at the same FPS. Better to stay on MEDIUM (1080p@20fps > 720p@20fps).
                if (dropRatio > 0.1) {
                  dt.currentQuality = "LOW";
                  dt.fpsHistory = [];
                  dt.stableTicks = 0;
                  dt.lastLayerChangeTime = nowMs;
                  qualityChanged = true;
                  debugLog("[adaptive-layer] " + key + ": " + reason + " + decode drops=" + Math.round(dropRatio*100) + "%, downgrading MEDIUM -> LOW");
                  logEvent("layer-downgrade", key + ": MEDIUM->LOW drops=" + Math.round(dropRatio*100) + "%");
                  try {
                    if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.LOW);
                    if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.LOW });
                  } catch (e) { debugLog("[adaptive-layer] downgrade failed: " + e.message); }
                } else {
                  debugLog("[adaptive-layer] " + key + ": " + reason + " but drops=" + Math.round(dropRatio*100) + "% (near-zero), staying on MEDIUM (SFU pacer bottleneck, not decode)");
                }
              }

              // ── Upgrade: climb back when rolling average is good for current layer ──
              // Compare against what's achievable at current layer:
              // - LOW layer caps at 30fps → upgrade if avgFps >= 27 (90% of cap) and low jitter
              // - MEDIUM layer caps at 60fps → upgrade if avgFps >= 45
              // Bug fix: old code required avgFps >= 45 always, which is impossible on LOW (30fps cap)
              // LOW cameras through TURN relay often cap at ~25fps, so 27fps threshold
              // creates a permanent stuck-on-LOW feedback loop. Use 20fps for LOW.
              var upgradeThreshold = dt.currentQuality === "LOW" ? 20 : 45;
              // Don't let FPS-based system upgrade when loss system is holding quality down
              var shouldUpgrade = !shouldDowngrade && !dt.lossDowngraded && avgFps >= upgradeThreshold && jitter < 25 && dropRatio < 0.15;
              if (shouldUpgrade && dt.currentQuality !== "HIGH") {
                dt.stableTicks++;
              } else if (dt.currentQuality !== "HIGH") {
                dt.stableTicks = Math.max(0, dt.stableTicks - 1);
              }
              // Cameras: 4 good ticks (12s), Screen shares: 8 ticks (24s) + cooldown
              var upgradeTicksNeeded = isCamera ? 4 : 8;
              if (dt.stableTicks >= upgradeTicksNeeded && timeSinceLastChange >= layerCooldown && dt.currentQuality !== "HIGH" && LK?.VideoQuality) {
                if (dt.currentQuality === "LOW" && !isCamera) {
                  dt.currentQuality = "MEDIUM";
                  dt.fpsHistory = [];
                  dt.stableTicks = 0;
                  dt.lastLayerChangeTime = nowMs;
                  qualityChanged = true;
                  debugLog("[adaptive-layer] " + key + ": stable 24s (avg " + Math.round(avgFps) + "fps), upgrading LOW -> MEDIUM");
                  logEvent("layer-upgrade", key + ": LOW->MEDIUM avgFps=" + Math.round(avgFps));
                  try {
                    if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.MEDIUM);
                    if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.MEDIUM });
                  } catch (e) { debugLog("[adaptive-layer] upgrade failed: " + e.message); }
                } else {
                  dt.currentQuality = "HIGH";
                  dt.fpsHistory = [];
                  dt.stableTicks = 0;
                  dt.lastLayerChangeTime = nowMs;
                  qualityChanged = true;
                  debugLog("[adaptive-layer] " + key + ": stable 24s (avg " + Math.round(avgFps) + "fps), upgrading -> HIGH");
                  logEvent("layer-upgrade", key + ": ->HIGH avgFps=" + Math.round(avgFps));
                  try {
                    if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.HIGH);
                    if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.HIGH });
                  } catch (e) { debugLog("[adaptive-layer] upgrade failed: " + e.message); }
                }
              }
              } // end if (!_bitrateCtrlActive) — FPS-based layer switching guard

              var layerInfo = qualityChanged ? " [LAYER->" + dt.currentQuality + "]" : "";
              // Store latest report for persistent stats logging
              dt._lastReport = { fps: fps, w: w, h: h, kbps: kbps, jitter: jitter, lost: pktLost, dropped: dropped, decoded: decoded, nack: nacks, pli: plis, codec: codec !== "?" ? codec : null, _deltaLost: deltaLost };
              debugLog(`Inbound ${sourceLabel} ${participant.identity}: ${fps}fps ${w}x${h} ${kbps}kbps codec=${codec} decoder=${decoder} jitter=${jitter}ms lost=${pktLost} dropped=${dropped}/${decoded} (${Math.round(dropRatio*100)}%/tick) nack=${nacks} pli=${plis} avgFps=${Math.round(avgFps)} layer=${dt.currentQuality}${layerInfo}${_iceType ? " " + _iceType : ""}`);
            }
          });
        }
      });
    } catch {}
  }, 3000);
}

function stopInboundScreenStatsMonitor() {
  if (_inboundScreenStatsInterval) {
    clearInterval(_inboundScreenStatsInterval);
    _inboundScreenStatsInterval = null;
  }
  _inboundScreenLastBytes.clear();
  _inboundDropTracker.clear();
}

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
      // Capture at native resolution — NVENC handles 4K with zero CPU cost.
      // No width/height cap so 4K monitors capture at 3840x2160.
      frameRate: { ideal: 60 },
      // Don't resize window captures to monitor resolution — preserve native window size.
      // Without this, sharing a small window on an ultrawide captures at 3432x1440 and stretches.
      resizeMode: "none",
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

    // ── Canvas pipeline: strip screen-capture tag for 60fps H264 encoding ──
    // Chromium caps getDisplayMedia tracks at 30fps for H264 encoding (screen-capture flag).
    // Drawing through a canvas creates a new track without this flag, unlocking 60fps.
    // With NVENC hardware encoding, the canvas drawImage overhead is trivial (GPU-composited).
    // A Web Worker timer drives requestFrame() to avoid setTimeout throttling when occluded.
    let publishMst;
    let canvasW = settings.width || 1920;
    let canvasH = settings.height || 1080;
    // ── Smart downscaling for ultrawide/4K captures ──
    // At 15Mbps/60fps, standard 1080p (2.07M px) gets 0.12 bits/pixel — good.
    // A 3440x1440 ultrawide (4.95M px) gets only 0.05 bpp — causes encoder stalls.
    // Cap at MAX_CANVAS_WIDTH to keep bits/pixel healthy while preserving aspect ratio.
    // 2560px wide covers the largest viewer tile with room to spare.
    var MAX_CANVAS_WIDTH = 1920;
    var MAX_CANVAS_PIXELS = 2_100_000; // ~1920x1094
    // Helper: cap resolution for ultrawide/4K while preserving aspect ratio
    function capCanvasRes(w, h, label) {
      var px = w * h;
      if (w > MAX_CANVAS_WIDTH || px > MAX_CANVAS_PIXELS) {
        var sc = Math.min(MAX_CANVAS_WIDTH / w, Math.sqrt(MAX_CANVAS_PIXELS / px));
        var nw = Math.round(w * sc); var nh = Math.round(h * sc);
        nw = nw - (nw % 2); nh = nh - (nh % 2); // H.264 needs even dims
        debugLog("[canvas-pipe] " + label + " downscale: " + w + "x" + h +
          " (" + (px / 1e6).toFixed(1) + "M px) -> " + nw + "x" + nh +
          " (" + (nw * nh / 1e6).toFixed(1) + "M px), scale=" + sc.toFixed(2));
        return { w: nw, h: nh };
      }
      return null; // no cap needed
    }
    var capped = capCanvasRes(canvasW, canvasH, "initial");
    if (capped) { canvasW = capped.w; canvasH = capped.h; }
    // Use a regular (DOM) canvas — OffscreenCanvas doesn't support captureStream
    var pipeCanvas = document.createElement("canvas");
    pipeCanvas.width = canvasW;
    pipeCanvas.height = canvasH;
    pipeCanvas.style.display = "none";
    document.body.appendChild(pipeCanvas);
    var ctx2d = pipeCanvas.getContext("2d", { alpha: false, desynchronized: true });
    var offVideo = document.createElement("video");
    offVideo.srcObject = new MediaStream([videoMst]);
    offVideo.muted = true;
    offVideo.playsInline = true;
    window._canvasOffVideo = offVideo;
    window._canvasPipeEl = pipeCanvas;
    // captureStream(60) = auto-capture at 60fps — browser drives frame timing
    // This is more reliable than captureStream(0) + requestFrame() in WebView2
    var canvasStream = pipeCanvas.captureStream(60);
    publishMst = canvasStream.getVideoTracks()[0];
    publishMst.contentHint = "motion";
    debugLog("[canvas-pipe] canvasStream created, track: readyState=" + publishMst.readyState + " id=" + publishMst.id);
    // Draw loop: rAF + Worker fallback to keep canvas fed with fresh frames
    var _canvasFrameCount = 0;
    var _canvasDrawActive = false;
    function canvasDraw() {
      if (!offVideo || !_canvasDrawActive) return;
      if (offVideo.readyState >= 2 && offVideo.videoWidth > 0) {
        // Fallback resize check (primary is the 'resize' event on offVideo)
        if (_canvasFrameCount > 0 && _canvasFrameCount % 30 === 0) {
          var srcW = offVideo.videoWidth;
          var srcH = offVideo.videoHeight;
          if (srcW > 0 && srcH > 0) {
            // Apply ultrawide cap to the source dimensions
            var rc = capCanvasRes(srcW, srcH, "fallback-resize");
            var targetW = rc ? rc.w : srcW;
            var targetH = rc ? rc.h : srcH;
            if (targetW !== canvasW || targetH !== canvasH) {
              debugLog("[canvas-pipe] source resized: " + canvasW + "x" + canvasH + " -> " + targetW + "x" + targetH + " (raw=" + srcW + "x" + srcH + ")");
              canvasW = targetW;
              canvasH = targetH;
              pipeCanvas.width = canvasW;
              pipeCanvas.height = canvasH;
              // Re-acquire context after canvas resize (spec says old context is lost)
              ctx2d = pipeCanvas.getContext("2d", { alpha: false, desynchronized: true });
            }
          }
        }
        ctx2d.drawImage(offVideo, 0, 0, canvasW, canvasH);
        _canvasFrameCount++;
        if (_canvasFrameCount === 1) {
          debugLog("[canvas-pipe] FIRST FRAME drawn! offVideo: " + offVideo.videoWidth + "x" + offVideo.videoHeight + " readyState=" + offVideo.readyState);
        } else if (_canvasFrameCount === 60) {
          debugLog("[canvas-pipe] 60 frames drawn — pipeline confirmed working");
        } else if (_canvasFrameCount === 300) {
          debugLog("[canvas-pipe] 300 frames drawn (5 seconds of 60fps)");
        }
      }
      window._canvasRafId = requestAnimationFrame(canvasDraw);
    }
    // Worker timer: backup draw loop for when rAF is throttled (page behind shared screen)
    var workerBlob = new Blob([
      "var iv; onmessage = function(e) { if (e.data === 'stop') { clearInterval(iv); return; } iv = setInterval(function() { postMessage('t'); }, e.data); };"
    ], { type: "application/javascript" });
    var worker = new Worker(URL.createObjectURL(workerBlob));
    worker.onmessage = function() {
      if (!offVideo || !_canvasDrawActive) return;
      if (offVideo.readyState >= 2 && offVideo.videoWidth > 0) {
        ctx2d.drawImage(offVideo, 0, 0, canvasW, canvasH);
        _canvasFrameCount++;
      }
    };
    window._canvasFrameWorker = worker;
    // Start drawing once video has data
    function startCanvasDraw() {
      if (_canvasDrawActive) return;
      _canvasDrawActive = true;
      debugLog("[canvas-pipe] starting draw loops — offVideo: " + offVideo.videoWidth + "x" + offVideo.videoHeight + " readyState=" + offVideo.readyState);
      // Start rAF loop
      window._canvasRafId = requestAnimationFrame(canvasDraw);
      // Start worker backup at 60fps
      worker.postMessage(Math.floor(1000 / 60));
      // Draw first frame immediately
      if (offVideo.readyState >= 2 && offVideo.videoWidth > 0) {
        ctx2d.drawImage(offVideo, 0, 0, canvasW, canvasH);
        _canvasFrameCount++;
        debugLog("[canvas-pipe] drew initial frame synchronously");
      }
    }
    offVideo.addEventListener("loadeddata", function() {
      debugLog("[canvas-pipe] loadeddata fired: " + offVideo.videoWidth + "x" + offVideo.videoHeight + " readyState=" + offVideo.readyState);
      startCanvasDraw();
    });
    // Resize canvas immediately when captured window changes size (e.g. user resizes Chrome window).
    // Without this, drawImage stretches the smaller source to fill the old larger canvas — causing
    // distortion AND wasting encoder bandwidth (encoding 3840x2088 when source is only 1600x900).
    offVideo.addEventListener("resize", function() {
      var srcW = offVideo.videoWidth;
      var srcH = offVideo.videoHeight;
      if (srcW > 0 && srcH > 0) {
        // Apply ultrawide cap to the new source dimensions
        var rc = capCanvasRes(srcW, srcH, "resize-event");
        var targetW = rc ? rc.w : srcW;
        var targetH = rc ? rc.h : srcH;
        if (targetW !== canvasW || targetH !== canvasH) {
          debugLog("[canvas-pipe] source window resized: " + canvasW + "x" + canvasH + " -> " + targetW + "x" + targetH + " (raw=" + srcW + "x" + srcH + ")");
          canvasW = targetW;
          canvasH = targetH;
          pipeCanvas.width = canvasW;
          pipeCanvas.height = canvasH;
          ctx2d = pipeCanvas.getContext("2d", { alpha: false, desynchronized: true });
        }
      }
    });
    // Safety: if already has data
    if (offVideo.readyState >= 2) {
      debugLog("[canvas-pipe] offVideo already has data (readyState=" + offVideo.readyState + ")");
      startCanvasDraw();
    }
    // Safety timeout
    setTimeout(function() {
      if (!_canvasDrawActive) {
        debugLog("[canvas-pipe] WARNING: no data after 2s — force-starting (readyState=" + offVideo.readyState + " videoWidth=" + offVideo.videoWidth + ")");
        startCanvasDraw();
      }
    }, 2000);
    // Play the video
    offVideo.play().then(function() {
      debugLog("[canvas-pipe] offVideo.play() resolved, readyState=" + offVideo.readyState);
      // Trigger start if loadeddata was missed
      if (!_canvasDrawActive && offVideo.readyState >= 2) startCanvasDraw();
    }).catch(function(e) {
      debugLog("[canvas-pipe] offVideo.play() FAILED: " + e.message);
    });
    debugLog("Screen capture: canvas pipeline active (" + canvasW + "x" + canvasH + " @60fps captureStream(60), NVENC H264)");
    logEvent("screen-share-start", canvasW + "x" + canvasH + " @60fps canvas+NVENC");

    // ── Resource shedding: tear down pre-warmed room connections ──
    // Each pre-warmed room holds a WebRTC peer connection (ICE, DTLS, STUN keepalives).
    // During screen share, every CPU/GPU cycle counts — free these resources.
    if (prewarmedRooms.size > 0) {
      debugLog("Screen share: closing " + prewarmedRooms.size + " pre-warmed connections to free resources");
      prewarmedRooms.forEach(function(entry) { try { entry.room.disconnect(); } catch (e) {} });
      prewarmedRooms.clear();
    }

    // Ghost subscriber REMOVED — was causing DTLS timeouts and encoder death.
    // SDP bandwidth munging (b=AS:25000 + b=TIAS:25000000) handles BWE priming for simulcast.

    // Create LiveKit LocalVideoTrack and publish
    _screenShareVideoTrack = new LK.LocalVideoTrack(publishMst, undefined, false);
    await room.localParticipant.publishTrack(_screenShareVideoTrack, {
      source: LK.Track.Source.ScreenShare,
      ...getScreenSharePublishOptions(canvasW, canvasH),
    });

    // Set initial sender parameters for simulcast screen share.
    // 3 layers: HIGH (4K@60), MEDIUM (1080p@60), LOW (720p@30).
    // Each layer gets explicit bitrate, framerate, and scale factor.
    const sender = _screenShareVideoTrack?.sender;
    debugLog("Screen share sender: " + (sender ? "found" : "NULL") +
      " track.sender=" + (typeof _screenShareVideoTrack?.sender) +
      " mediaStreamTrack=" + (publishMst ? publishMst.readyState + " " + publishMst.getSettings().width + "x" + publishMst.getSettings().height : "null"));
    if (sender) {
      try {
        const params = sender.getParameters();
        debugLog("Screen share encodings BEFORE override: " + JSON.stringify(params.encodings));
        // Note: degradationPreference cannot be set via setParameters (Chromium rejects it).
        // It's already set via addTransceiver init options.
        if (params.encodings) {
          for (const enc of params.encodings) {
            // Note: priority/networkPriority cannot be set via setParameters in Chromium
            // (throws "unimplemented parameter"). They are already set via addTransceiver init.
            if (enc.rid === "f" || (!enc.rid && params.encodings.length === 1)) {
              // HIGH layer: native resolution @60fps, 15 Mbps
              // 12 Mbps wasn't enough for 4K@60 during high-motion gaming — encoder starved.
              enc.maxFramerate = 60;
              enc.maxBitrate = 15_000_000;
              enc.scaleResolutionDownBy = 1;
            } else if (enc.rid === "h") {
              // MEDIUM layer: 1080p @60fps, 5 Mbps
              enc.maxFramerate = 60;
              enc.maxBitrate = 5_000_000;
              enc.scaleResolutionDownBy = 2;
            } else if (enc.rid === "q") {
              // LOW layer: 720p @30fps, 1.5 Mbps
              enc.maxFramerate = 30;
              enc.maxBitrate = 1_500_000;
              enc.scaleResolutionDownBy = 3;
            }
          }
        }
        await sender.setParameters(params);
        const vp = sender.getParameters();
        debugLog("Screen share encodings AFTER override: " + JSON.stringify(vp.encodings));
      if (vp.encodings) {
        for (const enc of vp.encodings) {
          debugLog("Screen share layer " + (enc.rid || "single") + ": fps=" + enc.maxFramerate +
            " bps=" + enc.maxBitrate + " scale=" + enc.scaleResolutionDownBy);
        }
      }
      debugLog("Screen share degPref=" + vp.degradationPreference + " layers=" + (vp.encodings?.length || 1));

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
      } catch (e) {
        debugLog("Screen share post-publish setParameters FAILED: " + e.message);
      }
    }

    // Monitor capture track health — log if track ends/mutes unexpectedly
    if (publishMst) {
      publishMst.addEventListener("ended", () => {
        debugLog("WARNING: screen capture MediaStreamTrack ENDED (readyState=" + publishMst.readyState + ")");
      });
      publishMst.addEventListener("mute", () => {
        debugLog("WARNING: screen capture MediaStreamTrack MUTED");
      });
      publishMst.addEventListener("unmute", () => {
        debugLog("screen capture MediaStreamTrack unmuted");
      });
      debugLog("Screen capture track: readyState=" + publishMst.readyState + " enabled=" + publishMst.enabled + " muted=" + publishMst.muted +
        " width=" + publishMst.getSettings().width + " height=" + publishMst.getSettings().height + " fps=" + publishMst.getSettings().frameRate);
    }

    // Monitor encoding stats every 2s — simulcast-aware (per-layer tracking)
    if (_screenShareStatsInterval) clearInterval(_screenShareStatsInterval);
    const _layerBytes = new Map(); // rid -> { lastBytes, lastTime }
    _screenShareStatsInterval = setInterval(async () => {
      try {
        const sender = _screenShareVideoTrack?.sender;
        if (!sender) return;

        // Check if capture track and canvas pipeline are still alive
        const captureTrack = sender.track;
        var _pipeHealth = "";
        if (window._canvasOffVideo) {
          var ov = window._canvasOffVideo;
          var srcTrack = ov.srcObject && ov.srcObject.getVideoTracks ? ov.srcObject.getVideoTracks()[0] : null;
          _pipeHealth = " pipe[offVid:rs=" + ov.readyState + "/p=" + ov.paused + "/w=" + ov.videoWidth +
            " src:" + (srcTrack ? "rs=" + srcTrack.readyState + "/en=" + srcTrack.enabled + "/mt=" + srcTrack.muted : "NONE") +
            " canv:" + (captureTrack ? "rs=" + captureTrack.readyState + "/en=" + captureTrack.enabled + "/mt=" + captureTrack.muted : "NONE") + "]";
        }
        if (captureTrack && captureTrack.readyState !== "live") {
          debugLog("Screen share: CAPTURE TRACK DEAD: " + captureTrack.readyState + _pipeHealth);
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
            _latestOutboundBwe = bwe; // update module-level for LOW restore interval to read
            const local = candidateMap.get(report.localCandidateId);
            const remote = candidateMap.get(report.remoteCandidateId);
            lType = local?.candidateType || "?";
            rType = remote?.candidateType || "?";
            const lAddr = local ? `${local.address}:${local.port}` : "?";
            const rAddr = remote ? `${remote.address}:${remote.port}` : "?";
            iceInfo = `ice=${lType}->${rType} ${lAddr}->${rAddr}`;
          }
        });

        // Collect per-layer stats (simulcast: multiple outbound-rtp with rid)
        const layers = [];
        let highLayerFps = 0;
        let highLayerLimit = "none";
        let totalKbps = 0;
        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "video") {
            const rid = report.rid || "single";
            const fps = report.framesPerSecond || 0;
            const w = report.frameWidth || 0;
            const h = report.frameHeight || 0;
            const now = Date.now();
            const prev = _layerBytes.get(rid) || { lastBytes: report.bytesSent, lastTime: now };
            const elapsed = (now - prev.lastTime) / 1000;
            const bytesDelta = report.bytesSent - prev.lastBytes;
            const kbps = elapsed > 0 ? Math.round((bytesDelta * 8) / elapsed / 1000) : 0;
            _layerBytes.set(rid, { lastBytes: report.bytesSent, lastTime: now });
            const codec = report.encoderImplementation || "unknown";
            const limit = report.qualityLimitationReason || "none";
            totalKbps += kbps;
            layers.push({ rid, fps, w, h, kbps, codec, limit });
            // Track HIGH layer stats for adaptive camera + admin reporting
            if (rid === "f" || rid === "single") {
              highLayerFps = fps;
              highLayerLimit = limit;
            }
          }
        });

        // Log per-layer stats
        if (layers.length > 1) {
          // Simulcast: compact per-layer summary
          var layerSummary = layers.map(function(l) {
            var label = l.rid === "f" ? "HIGH" : l.rid === "h" ? "MED" : l.rid === "q" ? "LOW" : l.rid;
            return label + ":" + l.fps + "fps/" + l.w + "x" + l.h + "/" + l.kbps + "kbps";
          }).join(" ");
          var limitStr = highLayerLimit && highLayerLimit !== "none" ? " limit=" + highLayerLimit : "";
          var statsLine = "Screen: " + layerSummary + " total=" + totalKbps + "kbps bwe=" + bwe + "kbps" + limitStr + " " + layers[0].codec + " " + iceInfo;
          if (highLayerFps === 0 && _pipeHealth) statsLine += _pipeHealth;
          debugLog(statsLine);
        } else if (layers.length === 1) {
          // Single layer fallback
          var l = layers[0];
          var statsLine = `Screen: ${l.fps}fps ${l.w}x${l.h} ${l.kbps}kbps bwe=${bwe}kbps codec=${l.codec} limit=${l.limit} ${iceInfo}`;
          if (l.fps === 0 && _pipeHealth) statsLine += _pipeHealth;
          debugLog(statsLine);
        }

        // Use HIGH layer stats for admin dashboard + adaptive camera
        var highLayer = layers.find(function(l) { return l.rid === "f" || l.rid === "single"; }) || layers[0];
        if (highLayer) {
          _latestScreenStats = {
            screen_fps: highLayer.fps, screen_width: highLayer.w, screen_height: highLayer.h,
            screen_bitrate_kbps: totalKbps,
            bwe_kbps: typeof bwe === "number" ? bwe : null,
            quality_limitation: highLayer.limit, encoder: highLayer.codec,
            ice_local_type: lType !== "?" ? lType : null,
            ice_remote_type: rType !== "?" ? rType : null,
            simulcast_layers: layers.length,
          };

          // Report stats to admin dashboard (apiUrl handles native vs browser path)
          if (adminToken) {
            fetch(apiUrl("/admin/api/stats"), {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
              body: JSON.stringify({
                identity: room?.localParticipant?.identity || "",
                name: room?.localParticipant?.name || "",
                room: currentRoomName || "",
                screen_fps: highLayer.fps, screen_width: highLayer.w, screen_height: highLayer.h,
                screen_bitrate_kbps: totalKbps,
                bwe_kbps: typeof bwe === "number" ? bwe : null,
                quality_limitation: highLayer.limit, encoder: highLayer.codec,
                ice_local_type: lType !== "?" ? lType : null,
                ice_remote_type: rType !== "?" ? rType : null,
                simulcast_layers: layers.length,
              }),
            }).catch(() => {});
          }

          // ── Persistent stats log (daily JSONL on server) ──
          // Captures both outbound encoder stats and inbound viewer stats
          // for offline analysis across sessions.
          try {
            var inboundArr = [];
            _inboundDropTracker.forEach(function(dt, key) {
              var lastBytes = _inboundScreenLastBytes.get(key);
              if (!lastBytes) return;
              var parts = key.split("-");
              var source = parts[parts.length - 1]; // "screen" or "camera"
              var fromId = parts.slice(0, parts.length - 1).join("-");
              var avgF = dt.fpsHistory.length > 0
                ? dt.fpsHistory.reduce(function(a, b) { return a + b; }, 0) / dt.fpsHistory.length : 0;
              // Pull latest stats from the last debugLog data (stored in tracker)
              if (dt._lastReport) {
                inboundArr.push({
                  from: fromId, source: source,
                  fps: dt._lastReport.fps, width: dt._lastReport.w, height: dt._lastReport.h,
                  bitrate_kbps: dt._lastReport.kbps, jitter_ms: dt._lastReport.jitter,
                  lost: dt._lastReport.lost, dropped: dt._lastReport.dropped,
                  decoded: dt._lastReport.decoded, nack: dt._lastReport.nack,
                  pli: dt._lastReport.pli, avg_fps: Math.round(avgF),
                  layer: dt.currentQuality, codec: dt._lastReport.codec || null,
                });
              }
            });
            fetch(apiUrl("/api/stats-log"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                identity: room?.localParticipant?.identity || "",
                room: currentRoomName || "",
                out_fps: highLayer.fps, out_width: highLayer.w, out_height: highLayer.h,
                out_bitrate_kbps: totalKbps,
                out_bwe_kbps: typeof bwe === "number" ? bwe : null,
                out_limit: highLayer.limit || null,
                out_encoder: highLayer.codec || null,
                out_layers: layers.length,
                out_ice: iceInfo || null,
                inbound: inboundArr.length > 0 ? inboundArr : null,
              }),
            }).catch(function() {});
          } catch (e) {}

          // Adaptive camera quality: reduce camera when HIGH layer is bandwidth-constrained
          if (highLayerLimit === "bandwidth" || highLayerFps === 0) {
            _bwLimitedCount++;
          } else {
            _bwLimitedCount = Math.max(0, _bwLimitedCount - 1);
          }
          if (_bwLimitedCount >= 3 && camEnabled && !_cameraReducedForScreenShare) {
            _cameraReducedForScreenShare = true;
            debugLog("Adaptive: reducing camera to 360p/15fps to free bandwidth for screen share");
            logEvent("camera-reduced", "360p/15fps bandwidth-limited " + _bwLimitedCount + " ticks");
            reduceCameraForScreenShare();
          }
          if (_bwLimitedCount === 0 && _cameraReducedForScreenShare) {
            _cameraReducedForScreenShare = false;
            debugLog("Adaptive: restoring camera to full quality (bandwidth recovered)");
            logEvent("camera-restored", "bandwidth recovered");
            restoreCameraQuality();
          }

          // ── BWE watchdog: detect stuck-low bitrate and kick encoder ──
          // Chrome BWE starts at ~300kbps and probes up. If SFU congestion control
          // or TURN relay causes slow ramp-up, the HIGH layer can stay at <1Mbps for
          // a long time. After 10s of low total bitrate, re-assert minimum bitrate
          // via setParameters to nudge the BWE prober.
          if (!_bweKickAttempted && typeof bwe === "number" && bwe < 2000 && totalKbps < 1000) {
            _bweLowTicks++;
            if (_bweLowTicks >= 5) { // 5 ticks × 2s = 10s of stuck-low BWE
              _bweKickAttempted = true;
              debugLog("[bwe-watchdog] BWE stuck at " + bwe + "kbps (total send " + totalKbps + "kbps) — re-asserting encoder params");
              logEvent("bwe-watchdog-kick", "bwe=" + bwe + "kbps total=" + totalKbps + "kbps after " + _bweLowTicks + " ticks");
              try {
                var kickParams = sender.getParameters();
                if (kickParams.encodings) {
                  // Respect active bitrate cap from AIMD — don't override to defaults
                  var capHigh = _currentAppliedCap ? _currentAppliedCap.high : 15_000_000;
                  var capMed = _currentAppliedCap ? _currentAppliedCap.med : 5_000_000;
                  var capLow = _currentAppliedCap ? _currentAppliedCap.low : 1_500_000;
                  for (var kEnc of kickParams.encodings) {
                    if (kEnc.rid === "f" || (!kEnc.rid && kickParams.encodings.length === 1)) {
                      kEnc.maxBitrate = capHigh;
                    } else if (kEnc.rid === "h") {
                      kEnc.maxBitrate = capMed;
                    } else if (kEnc.rid === "q") {
                      kEnc.maxBitrate = capLow;
                    }
                  }
                }
                sender.setParameters(kickParams).then(function() {
                  debugLog("[bwe-watchdog] encoder params re-asserted — waiting for BWE ramp-up");
                }).catch(function(e) {
                  debugLog("[bwe-watchdog] setParameters failed: " + e.message);
                });
              } catch (e) { debugLog("[bwe-watchdog] kick failed: " + e.message); }
            }
          } else {
            _bweLowTicks = Math.max(0, _bweLowTicks - 1);
          }

          // ── HIGH layer rescue: detect BWE crash pausing HIGH layer ──
          // When BWE drops from 25Mbps to ~5Mbps (e.g. jitter spike on TURN relay),
          // WebRTC disables the HIGH simulcast layer (0fps, limit=bandwidth) and only
          // sends MED+LOW. The BWE may recover slowly on its own, but the HIGH layer
          // can stay paused for 30+ seconds. This watchdog detects the pattern and
          // actively re-enables the HIGH layer by temporarily disabling LOW to free
          // bandwidth headroom for BWE to probe back up.
          var highPaused = highLayerFps === 0 && highLayerLimit === "bandwidth" && layers.length > 1;
          if (highPaused) {
            _highPausedTicks = (_highPausedTicks || 0) + 1;
          } else {
            _highPausedTicks = 0;
          }
          // After 3 ticks (6s) of HIGH layer paused, try rescue
          if (_highPausedTicks === 3) {
            debugLog("[bwe-rescue] HIGH layer paused for 6s (bwe=" + bwe + "kbps) — temporarily disabling LOW layer to free bandwidth for HIGH recovery");
            logEvent("bwe-rescue", "HIGH paused 6s, bwe=" + bwe + "kbps total=" + totalKbps + "kbps");
            try {
              var rescueParams = sender.getParameters();
              if (rescueParams.encodings) {
                // Respect active bitrate cap from AIMD
                var rescueCapHigh = _currentAppliedCap ? _currentAppliedCap.high : 15_000_000;
                for (var rEnc of rescueParams.encodings) {
                  if (rEnc.rid === "q") {
                    // Disable LOW layer temporarily to free ~1.5Mbps for HIGH
                    rEnc.active = false;
                  }
                  if (rEnc.rid === "f") {
                    // Re-assert HIGH layer active with fresh bitrate
                    rEnc.active = true;
                    rEnc.maxBitrate = rescueCapHigh;
                  }
                }
              }
              sender.setParameters(rescueParams).then(function() {
                debugLog("[bwe-rescue] LOW layer disabled, HIGH re-asserted — BWE should ramp up");
                // Restore LOW layer once BWE has recovered enough (>= 10Mbps) or after 20s max.
                // Check every 2s instead of a blind 10s timer — prevents re-triggering HIGH pause
                // when BWE hasn't recovered enough to sustain all 3 layers.
                var _lowRestoreChecks = 0;
                var _lowRestoreInterval = setInterval(function() {
                  _lowRestoreChecks++;
                  try {
                    // Read current BWE from the module-level variable (updated every stats tick)
                    var currentBwe = _latestOutboundBwe || 0;
                    // If BWE >= 10Mbps or we've waited 20s, restore LOW
                    if (currentBwe >= 10000 || _lowRestoreChecks >= 10) {
                      clearInterval(_lowRestoreInterval);
                      var restoreParams = sender.getParameters();
                      if (restoreParams.encodings) {
                        var restoreCapLow = _currentAppliedCap ? _currentAppliedCap.low : 1_500_000;
                        for (var rEnc2 of restoreParams.encodings) {
                          if (rEnc2.rid === "q") {
                            rEnc2.active = true;
                            rEnc2.maxBitrate = restoreCapLow;
                          }
                        }
                      }
                      sender.setParameters(restoreParams).then(function() {
                        debugLog("[bwe-rescue] LOW layer restored (bwe=" + currentBwe + "kbps, checks=" + _lowRestoreChecks + ")");
                      }).catch(function() {});
                    }
                  } catch (e2) { clearInterval(_lowRestoreInterval); }
                }, 2000);
              }).catch(function(e) {
                debugLog("[bwe-rescue] setParameters failed: " + e.message);
              });
            } catch (e) { debugLog("[bwe-rescue] rescue failed: " + e.message); }
          }
          // If HIGH is still paused after 15 ticks (30s), try a harder rescue:
          // re-assert all layer params to force BWE re-evaluation
          if (_highPausedTicks === 15) {
            debugLog("[bwe-rescue] HIGH layer still paused after 30s — hard re-asserting all encoder params");
            logEvent("bwe-rescue-hard", "HIGH paused 30s, bwe=" + bwe + "kbps");
            try {
              var hardParams = sender.getParameters();
              if (hardParams.encodings) {
                // Respect active bitrate cap from AIMD
                var hardCapHigh = _currentAppliedCap ? _currentAppliedCap.high : 15_000_000;
                var hardCapMed = _currentAppliedCap ? _currentAppliedCap.med : 5_000_000;
                var hardCapLow = _currentAppliedCap ? _currentAppliedCap.low : 1_500_000;
                for (var hEnc of hardParams.encodings) {
                  hEnc.active = true;
                  if (hEnc.rid === "f" || (!hEnc.rid && hardParams.encodings.length === 1)) {
                    hEnc.maxBitrate = hardCapHigh;
                    hEnc.maxFramerate = 60;
                  } else if (hEnc.rid === "h") {
                    hEnc.maxBitrate = hardCapMed;
                    hEnc.maxFramerate = 60;
                  } else if (hEnc.rid === "q") {
                    hEnc.maxBitrate = hardCapLow;
                    hEnc.maxFramerate = 30;
                  }
                }
              }
              sender.setParameters(hardParams).then(function() {
                debugLog("[bwe-rescue] hard re-assert complete — all layers active with target bitrates");
              }).catch(function(e) {
                debugLog("[bwe-rescue] hard setParameters failed: " + e.message);
              });
            } catch (e) { debugLog("[bwe-rescue] hard rescue failed: " + e.message); }
            // Reset counter so we can try again in another 30s if still stuck
            _highPausedTicks = 0;
          }
        }
      } catch {}
    }, 2000);

    // Handle browser "Stop sharing" button
    videoMst.addEventListener("ended", () => {
      debugLog("Screen share ended by browser stop button");
      logEvent("screen-share-stop", "browser stop button");
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
  // Clean up canvas pipeline (Web Worker frame timer)
  if (window._canvasFrameWorker) {
    try { window._canvasFrameWorker.postMessage("stop"); window._canvasFrameWorker.terminate(); } catch {}
    window._canvasFrameWorker = null;
  }
  if (window._canvasRafId) { cancelAnimationFrame(window._canvasRafId); window._canvasRafId = null; }
  if (window._canvasOffVideo) { window._canvasOffVideo.pause(); window._canvasOffVideo.srcObject = null; window._canvasOffVideo = null; }
  if (window._canvasPipeEl) { window._canvasPipeEl.remove(); window._canvasPipeEl = null; }
  // Ghost subscriber removed (was causing DTLS timeouts)
  if (window._ghostSubscriber) {
    try { window._ghostSubscriber.disconnect(); } catch {}
    window._ghostSubscriber = null;
  }
  if (_screenShareStatsInterval) {
    clearInterval(_screenShareStatsInterval);
    _screenShareStatsInterval = null;
  }
  logEvent("screen-share-stop", "manual stop");
  // Always reset BWE watchdog state when screen share stops
  _bweLowTicks = 0;
  _bweKickAttempted = false;
  _highPausedTicks = 0;
  _latestOutboundBwe = 0;
  // Clean up publisher-side bitrate cap state
  _bitrateCaps.clear();
  _currentAppliedCap = null;
  if (_bitrateCapCleanupTimer) {
    clearInterval(_bitrateCapCleanupTimer);
    _bitrateCapCleanupTimer = null;
  }
  debugLog("[bitrate-ctrl] publisher-side caps cleared (screen share stopped)");
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
  if (token.status === 409) throw new Error("Name is already in use by another connected user. Please choose a different name.");
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

// ── Fast room switching: token prefetch ──
async function prefetchRoomTokens() {
  if (!adminToken) return;
  var cUrl = controlUrlInput.value.trim();
  if (!cUrl) return;
  var nm = nameInput.value.trim() || "Viewer";
  var id = identityInput ? identityInput.value : buildIdentity(nm);
  for (var i = 0; i < FIXED_ROOMS.length; i++) {
    var rid = FIXED_ROOMS[i];
    if (rid === currentRoomName) continue;
    var cached = tokenCache.get(rid);
    if (cached) {
      var age = Date.now() - cached.fetchedAt;
      if (age < (cached.expiresInSeconds * 1000) - TOKEN_CACHE_MARGIN_MS) continue;
    }
    try {
      var res = await fetch(cUrl + "/v1/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
        body: JSON.stringify({ room: rid, identity: id, name: nm }),
      });
      if (!res.ok) continue;
      var data = await res.json();
      tokenCache.set(rid, { token: data.token, fetchedAt: Date.now(), expiresInSeconds: data.expires_in_seconds || 14400 });
      debugLog("[fast-switch] prefetched token for " + rid);
    } catch (e) { /* silent — fall back to live fetch on switch */ }
  }
}

async function getCachedOrFetchToken(baseUrl, adminToken, roomId, identity, name) {
  var cached = tokenCache.get(roomId);
  if (cached) {
    var age = Date.now() - cached.fetchedAt;
    if (age < (cached.expiresInSeconds * 1000) - TOKEN_CACHE_MARGIN_MS) {
      debugLog("[fast-switch] using cached token for " + roomId + " (age " + Math.round(age / 1000) + "s)");
      return cached.token;
    }
    tokenCache.delete(roomId);
  }
  return fetchRoomToken(baseUrl, adminToken, roomId, identity, name);
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

function playScreenShareChime() {
  try {
    const ctx = getChimeCtx();
    const now = ctx.currentTime;
    // Digital broadcast alert: three-note ascending sparkle with a shimmer tail
    // Notes: G5 (783.99) → B5 (987.77) → D6 (1174.66) — a bright G major triad arpeggio
    var notes = [783.99, 987.77, 1174.66];
    notes.forEach(function(freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      var onset = i * 0.08; // 80ms between notes — quick arpeggio
      gain.gain.setValueAtTime(0.001, now + onset);
      gain.gain.linearRampToValueAtTime(0.16, now + onset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + onset + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + onset);
      osc.stop(now + onset + 0.4);
    });
    // Shimmer tail: quiet high-frequency sine that fades out slowly
    var shimmer = ctx.createOscillator();
    var shimmerGain = ctx.createGain();
    shimmer.type = "sine";
    shimmer.frequency.value = 2349.32; // D7 — one octave above the last note
    shimmerGain.gain.setValueAtTime(0.001, now + 0.2);
    shimmerGain.gain.linearRampToValueAtTime(0.06, now + 0.25);
    shimmerGain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    shimmer.connect(shimmerGain).connect(ctx.destination);
    shimmer.start(now + 0.2);
    shimmer.stop(now + 0.75);
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
    var chimeKey = getChimeKey(id);
    const buffer = await fetchChimeBuffer(chimeKey, kind);
    if (buffer) {
      playCustomChime(buffer);
      return;
    }
  }
  if (kind === "enter") playJoinChime();
  else playLeaveChime();
}

// Get the chime lookup key for a participant — deviceId if known, else identityBase (fallback)
function getChimeKey(identity) {
  var identityBase = getIdentityBase(identity);
  // Check if we know this participant's device ID
  var deviceId = deviceIdByIdentity.get(identityBase);
  return deviceId || identityBase;
}

// Pre-fetch chime buffers for all participants in the current room so playback is instant
function prefetchChimeBuffersForRoom() {
  if (!room || !room.remoteParticipants) return;
  room.remoteParticipants.forEach(function(participant) {
    var chimeKey = getChimeKey(participant.identity);
    // Fetch both enter and exit chimes into cache
    fetchChimeBuffer(chimeKey, "enter").catch(function() {});
    fetchChimeBuffer(chimeKey, "exit").catch(function() {});
  });
}

// Play chime for a single participant — instant if pre-fetched, async fetch otherwise
async function playChimeForParticipant(identity, kind) {
  var chimeKey = getChimeKey(identity);
  var buffer = await fetchChimeBuffer(chimeKey, kind);
  if (buffer) {
    playCustomChime(buffer);
  } else if (kind === "enter") {
    playJoinChime();
  } else {
    playLeaveChime();
  }
}

function detectRoomChanges(statusMap) {
  // Track participant sets for room list UI (chimes are now handled by real-time LiveKit events)
  const currentIds = {};
  FIXED_ROOMS.forEach((roomId) => {
    currentIds[roomId] = new Set((statusMap[roomId] || []).map((p) => p.identity));
  });
  const myRoom = currentRoomName;
  if (previousDetectedRoom !== myRoom) {
    previousDetectedRoom = myRoom;
  }
  previousRoomParticipants = currentIds;
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
      // Optimistic UI: immediately show this room as active
      roomListEl.querySelectorAll(".room-status-btn").forEach(function(b) { b.classList.remove("is-active"); });
      btn.classList.add("is-active");
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
    // Refresh token cache every 5 minutes
    if (Date.now() - _lastTokenPrefetch > 300000) {
      _lastTokenPrefetch = Date.now();
      prefetchRoomTokens();
    }
  }, 5000);
}

function stopRoomStatusPolling() {
  if (roomStatusTimer) {
    clearInterval(roomStatusTimer);
    roomStatusTimer = null;
  }
}

// ── Auto update check ──
var _updateCheckTimer = null;
var _updateDismissed = false;
function startUpdateCheckPolling() {
  if (_updateCheckTimer) return;
  // Check once after 10s, then every 5 minutes
  setTimeout(checkForUpdateNotification, 10000);
  _updateCheckTimer = setInterval(checkForUpdateNotification, 5 * 60 * 1000);
}
function isNewerVersion(latest, current) {
  var a = latest.split(".").map(Number);
  var b = current.split(".").map(Number);
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    var x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
async function checkForUpdateNotification() {
  if (_updateDismissed) return;
  try {
    var currentVer = "";
    if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
      try {
        var info = await tauriInvoke("get_app_info");
        currentVer = info.version || "";
      } catch (e) { /* ignore */ }
    }
    if (!currentVer) return; // browser viewer doesn't have a version to compare
    var cUrl = controlUrlInput ? controlUrlInput.value.trim() : "";
    if (!cUrl) return;
    var resp = await fetch(cUrl + "/api/version");
    if (!resp.ok) return;
    var data = await resp.json();
    var latestClient = data.latest_client || "";
    if (latestClient && isNewerVersion(latestClient, currentVer)) {
      showUpdateBanner(latestClient);
    }
  } catch (e) {
    // silent
  }
}
function showUpdateBanner(version) {
  if (document.getElementById("update-banner")) return;
  var banner = document.createElement("div");
  banner.id = "update-banner";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:500;background:linear-gradient(90deg,rgba(56,189,248,0.15),rgba(139,92,246,0.15));backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(56,189,248,0.3);padding:8px 16px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:13px;color:var(--text,#e2e8f0);";
  banner.innerHTML = '<span>Update available: <strong>v' + version + '</strong> — restart the app to update</span><button type="button" style="background:none;border:none;color:var(--muted,#94a3b8);cursor:pointer;font-size:16px;padding:2px 6px;" title="Dismiss">&times;</button>';
  banner.querySelector("button").addEventListener("click", function() {
    banner.remove();
    _updateDismissed = true;
  });
  document.body.appendChild(banner);
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
      body: JSON.stringify({ room: _connectedRoomName, identity, name, viewer_version: _viewerVersion }),
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

// ── Fast room switching: pre-warmed connections ──
const prewarmedRooms = new Map(); // roomId -> { room: LK.Room, createdAt }
const PREWARM_MAX_AGE_MS = 300000; // 5 minutes

async function prewarmRooms() {
  // Don't pre-warm while screen sharing — each pre-warmed connection burns
  // CPU/GPU via WebRTC peer connections (ICE, DTLS, STUN). During screen share
  // every resource matters for maintaining 60fps.
  if (_screenShareVideoTrack) return;
  var LK = getLiveKitClient();
  if (!LK || !LK.Room) return;
  var sfu = sfuUrlInput.value.trim();
  if (!sfu) return;
  for (var i = 0; i < FIXED_ROOMS.length; i++) {
    var rid = FIXED_ROOMS[i];
    if (rid === currentRoomName) continue;
    var existing = prewarmedRooms.get(rid);
    if (existing && (Date.now() - existing.createdAt) < PREWARM_MAX_AGE_MS) continue;
    var cached = tokenCache.get(rid);
    if (!cached) continue;
    // Clean up stale pre-warmed room
    if (existing && existing.room) {
      try { existing.room.disconnect(); } catch (e) {}
    }
    try {
      var warmRoom = new LK.Room({ adaptiveStream: false, dynacast: false, autoSubscribe: true });
      await warmRoom.prepareConnection(sfu, cached.token);
      prewarmedRooms.set(rid, { room: warmRoom, createdAt: Date.now() });
      debugLog("[fast-switch] pre-warmed connection for " + rid);
    } catch (e) {
      debugLog("[fast-switch] pre-warm failed for " + rid + ": " + (e.message || e));
    }
  }
}

function cleanupPrewarmedRooms() {
  prewarmedRooms.forEach(function(entry) {
    try { entry.room.disconnect(); } catch (e) {}
  });
  prewarmedRooms.clear();
  tokenCache.clear();
}

var _lastRoomSwitchTime = 0;
async function switchRoom(roomId) {
  if (!room) return;
  if (roomId === currentRoomName) return;
  if (switchingRoom) {
    debugLog(`Switch to ${roomId} ignored — already switching`);
    return;
  }
  // Cooldown: prevent rapid switching (500ms minimum — safe with pre-warmed connections)
  var now = Date.now();
  if (now - _lastRoomSwitchTime < 500) {
    debugLog(`Switch to ${roomId} ignored — cooldown`);
    return;
  }
  _lastRoomSwitchTime = now;
  switchingRoom = true;
  _isRoomSwitch = true;
  // Remember mic state before switch so we can restore it
  var wasMicEnabled = micEnabled;
  debugLog(`Switching from ${currentRoomName} to ${roomId} (mic was ${wasMicEnabled ? "on" : "off"})`);
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
  element.style.setProperty("object-fit", "contain", "important");
  element.style.width = "100%";
  element.style.height = "100%";
  element.style.background = "transparent";
  // MutationObserver: enforce object-fit:contain even if SDK re-sets inline styles
  if (!element._objectFitGuard) {
    element._objectFitGuard = new MutationObserver(() => {
      if (element.style.objectFit !== "contain") {
        element.style.setProperty("object-fit", "contain", "important");
      }
    });
    element._objectFitGuard.observe(element, { attributes: true, attributeFilter: ["style"] });
  }
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

  // Fullscreen button — appears on hover
  var fsBtn = document.createElement("button");
  fsBtn.className = "tile-fullscreen-btn";
  fsBtn.title = "Fullscreen";
  fsBtn.innerHTML = "&#x26F6;"; // ⛶ fullscreen icon
  fsBtn.addEventListener("click", function(e) {
    e.stopPropagation(); // don't trigger tile focus toggle
    var video = tile.querySelector("video");
    if (video) enterVideoFullscreen(video);
  });
  tile.appendChild(fsBtn);

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
    // Diagnostic: log actual object-fit to debug stretching
    setTimeout(() => {
      const computed = window.getComputedStyle(element).objectFit;
      const inline = element.style.objectFit;
      debugLog("[object-fit] screen video: computed=" + computed + " inline=" + inline +
        " videoW=" + element.videoWidth + " videoH=" + element.videoHeight +
        " clientW=" + element.clientWidth + " clientH=" + element.clientHeight);
    }, 2000);
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
      // Skip recovery for unwatched remote screens
      if (meta.identity && hiddenScreens.has(meta.identity)) {
        var isLocal = room && room.localParticipant && room.localParticipant.identity === meta.identity;
        if (!isLocal) return;
      }
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
  screenTileByIdentity.clear();
  screenTrackMeta.clear();
  screenRecoveryAttempts.clear();
  screenResubscribeIntent.clear();
  stopInboundScreenStatsMonitor();
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
    element.style.setProperty("object-fit", "contain", "important");
  }
  element._attachedAt = performance.now();
  // Cancel any previous play chain for this element
  element._playGeneration = (element._playGeneration || 0) + 1;
  const playGen = element._playGeneration;
  const sid = () => element._lkTrack?.sid || 'unknown';

  const tryPlay = async () => {
    // Abort if a newer configureVideoElement call started
    if (element._playGeneration !== playGen) return;
    if (!element.isConnected) return;
    try {
      await element.play();
      debugLog(`video play() succeeded for ${sid()}, muted=${element.muted}`);
    } catch (err) {
      if (element._playGeneration !== playGen) return;
      // "interrupted by a new load request" = SDP renegotiation changed srcObject mid-play.
      // This is NOT an autoplay policy issue — never queue for user interaction.
      // Instead, wait for the new srcObject to be ready via loadedmetadata, then retry.
      if (err.message && err.message.indexOf("interrupted") !== -1) {
        debugLog(`video play() interrupted for ${sid()} — waiting for loadedmetadata`);
        element.addEventListener("loadedmetadata", function onReady() {
          if (element._playGeneration !== playGen) return;
          element.play().then(function() {
            debugLog(`video play() succeeded after load for ${sid()}`);
          }).catch(function() {
            // Still interrupted — another renegotiation happened. The next
            // loadedmetadata will trigger another attempt automatically.
          });
        }, { once: true });
        // Fallback: if loadedmetadata doesn't fire within 3s, try play anyway
        setTimeout(function() {
          if (element._playGeneration !== playGen) return;
          if (element.paused && element.isConnected) {
            element.play().catch(function() {});
          }
        }, 3000);
        return;
      }
      debugLog(`ERROR: video play() FAILED for ${sid()}: ${err.message}`);
      // Genuine autoplay policy failure — queue for user interaction
      if (window._pausedVideos) {
        window._pausedVideos.add(element);
        debugLog(`Video ${sid()} queued for next user interaction`);
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
    // Stop monitoring once video is confirmed working (has frames and isn't black)
    if (element._frameCount > 10 && !element._isBlack) {
      clearInterval(element._monitorTimer);
      element._monitorTimer = null;
    }
  }, 2000);
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
  element._ensurePlayId = (element._ensurePlayId || 0) + 1;
  const playId = element._ensurePlayId;

  // If already playing with frames, nothing to do
  if (!element.paused && element.videoWidth > 0) return;

  let attempts = 0;
  const check = () => {
    if (element._ensurePlayId !== playId) return;
    if (!element.isConnected) return;
    if (element.videoWidth > 0 || element.videoHeight > 0) return;
    attempts += 1;
    if (track.mediaStreamTrack && track.mediaStreamTrack.muted) {
      if (attempts < 8) setTimeout(check, 800);
      return;
    }
    // Request keyframe to help decoder recover — but do NOT call track.attach()
    // as that sets a new srcObject which interrupts any pending play().
    try { track.requestKeyFrame?.(); } catch {}
    // Only call play() if paused — don't re-trigger configureVideoElement
    if (element.paused) {
      element.play().catch(function() {});
    }
    if (attempts < 8) setTimeout(check, 800);
  };
  setTimeout(check, 400);
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
  // Don't kick-start unwatched screen shares
  var ksSid = publication?.trackSid || track?.sid;
  var ksMeta = ksSid ? screenTrackMeta.get(ksSid) : null;
  if (ksMeta && ksMeta.identity && hiddenScreens.has(ksMeta.identity)) {
    var ksLocal = room && room.localParticipant && room.localParticipant.identity === ksMeta.identity;
    if (!ksLocal) return;
  }
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
  // Don't schedule recovery for unwatched screen shares
  var srMeta = screenTrackMeta.get(trackSid);
  if (srMeta && srMeta.identity && hiddenScreens.has(srMeta.identity)) {
    var srLocal = room && room.localParticipant && room.localParticipant.identity === srMeta.identity;
    if (!srLocal) return;
  }
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
    const source = publication.source || publication.track?.source;
    const isScreenShare = source === LK?.Track?.Source?.ScreenShare;
    const targetQuality = LK?.VideoQuality?.HIGH;

    if (isScreenShare) {
      // Screen shares: request HIGH quality — with simulcast enabled, the SFU sends
      // the best layer the receiver can handle. Requesting HIGH ensures capable receivers
      // get 4K@60 while bandwidth-limited ones auto-downgrade to 1080p or 720p.
      if (publication.setVideoQuality && targetQuality != null) {
        publication.setVideoQuality(targetQuality);
      }
      if (publication.setPreferredLayer && targetQuality != null) {
        publication.setPreferredLayer({ quality: targetQuality });
      }
    } else {
      // Cameras: start LOW then upgrade to HIGH to ensure fast first frame
      const initialQuality = LK?.VideoQuality?.LOW || LK?.VideoQuality?.MEDIUM;
      if (publication.setVideoQuality && initialQuality != null) {
        publication.setVideoQuality(initialQuality);
      }
      if (publication.setPreferredLayer && initialQuality != null) {
        publication.setPreferredLayer({ quality: initialQuality });
      }
      // Upgrade to HIGH quality after video is playing — retry at 2s, 5s, 10s
      // TURN relay users may take longer to produce first frames
      var _upgradeAttempts = [2000, 5000, 10000];
      _upgradeAttempts.forEach(function(delay) {
        setTimeout(() => {
          if (element && element.videoWidth > 0 && targetQuality != null) {
            try {
              if (publication.setVideoQuality) {
                publication.setVideoQuality(targetQuality);
              }
              if (publication.setPreferredLayer) {
                publication.setPreferredLayer({ quality: targetQuality });
              }
              debugLog("[camera-upgrade] promoted to HIGH after " + delay + "ms");
            } catch {}
          }
        }, delay);
      });
    }
  } catch {}
}

function ensureVideoSubscribed(publication, element) {
  if (!publication || !publication.setSubscribed) return;
  // Don't re-subscribe unwatched screen shares
  var evsSource = publication.source || (publication.track ? publication.track.source : null);
  var LK_evs = getLiveKitClient();
  if (evsSource === LK_evs?.Track?.Source?.ScreenShare) {
    var evsSid = publication.trackSid || (publication.track ? publication.track.sid : null);
    var evsMeta = evsSid ? screenTrackMeta.get(evsSid) : null;
    if (evsMeta && evsMeta.identity && hiddenScreens.has(evsMeta.identity)) {
      var evsLocal = room && room.localParticipant && room.localParticipant.identity === evsMeta.identity;
      if (!evsLocal) return;
    }
  }
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
  let micPct = null;
  let screenPct = null;
  let micRow = null;
  let screenRow = null;
  let camOverlay = null;
  let ovMicBtn = null;
  let ovMicMute = null;
  let ovScreenBtn = null;
  let ovScreenMute = null;
  let ovWatchClone = null;
  let popMicSlider = null;
  let popMicPct = null;
  let popScreenSlider = null;
  let popScreenPct = null;
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
      var LK_wt = getLiveKitClient();

      if (hiddenScreens.has(identity)) {
        // === START WATCHING: subscribe to screen share tracks ===
        hiddenScreens.delete(identity);
        watchedScreens.add(identity);
        watchToggleBtn.textContent = "Stop Watching";
        if (ovWatchClone) ovWatchClone.textContent = "Stop Watching";
        debugLog("[opt-in] user opted in to watch " + identity);

        // Find the remote participant and subscribe to their screen share tracks
        var remote = null;
        if (room && room.remoteParticipants) {
          if (room.remoteParticipants.get) {
            remote = room.remoteParticipants.get(identity);
          }
          if (!remote) {
            room.remoteParticipants.forEach(function(p) {
              if (p.identity === identity) remote = p;
            });
          }
        }
        if (remote) {
          var pubs = getParticipantPublications(remote);
          pubs.forEach(function(pub) {
            var src = pub ? (pub.source || (pub.track ? pub.track.source : null)) : null;
            if (src === LK_wt.Track.Source.ScreenShare || src === LK_wt.Track.Source.ScreenShareAudio) {
              // Subscribe to the track on the SFU
              if (pub.setSubscribed) pub.setSubscribed(true);
              // Ensure publication is hooked (event listeners registered)
              hookPublication(pub, remote);
              // If the track is already available (SDK cached it), process immediately
              if (pub.track && pub.isSubscribed) {
                debugLog("[opt-in] track already available for " + src + " " + identity + " — processing immediately");
                handleTrackSubscribed(pub.track, pub, remote);
              } else {
                debugLog("[opt-in] subscribed to " + src + " for " + identity + " — waiting for track (subscribed=" + (pub.isSubscribed ?? "?") + " hasTrack=" + !!pub.track + ")");
              }
            }
          });
          // Fallback at 500ms: check if tracks arrived and process them
          setTimeout(function() {
            var remoteFb = null;
            if (room && room.remoteParticipants) {
              if (room.remoteParticipants.get) remoteFb = room.remoteParticipants.get(identity);
              if (!remoteFb) room.remoteParticipants.forEach(function(p) { if (p.identity === identity) remoteFb = p; });
            }
            if (!remoteFb) return;
            var fbPubs = getParticipantPublications(remoteFb);
            fbPubs.forEach(function(pub) {
              var src = pub ? (pub.source || (pub.track ? pub.track.source : null)) : null;
              if (src === LK_wt.Track.Source.ScreenShare) {
                if (pub.track && pub.isSubscribed && !screenTileByIdentity.has(identity)) {
                  debugLog("[opt-in] fallback@500ms: processing screen track for " + identity);
                  handleTrackSubscribed(pub.track, pub, remoteFb);
                }
                // If still not subscribed, force re-subscribe
                if (!pub.isSubscribed && pub.setSubscribed) {
                  debugLog("[opt-in] fallback@500ms: re-subscribing screen for " + identity);
                  pub.setSubscribed(true);
                }
              }
              if (src === LK_wt.Track.Source.ScreenShareAudio) {
                var fbState = participantState.get(identity);
                if (pub.track && pub.isSubscribed && fbState && fbState.screenAudioEls.size === 0) {
                  debugLog("[opt-in] fallback@500ms: processing screen audio for " + identity);
                  handleTrackSubscribed(pub.track, pub, remoteFb);
                }
                if (!pub.isSubscribed && pub.setSubscribed) {
                  debugLog("[opt-in] fallback@500ms: re-subscribing screen audio for " + identity);
                  pub.setSubscribed(true);
                }
              }
            });
          }, 500);
          // Fallback at 1500ms: full reconcile to catch anything still missing
          setTimeout(function() {
            var remoteFb2 = null;
            if (room && room.remoteParticipants) {
              if (room.remoteParticipants.get) remoteFb2 = room.remoteParticipants.get(identity);
              if (!remoteFb2) room.remoteParticipants.forEach(function(p) { if (p.identity === identity) remoteFb2 = p; });
            }
            if (remoteFb2) {
              debugLog("[opt-in] fallback@1500ms: full reconcile for " + identity);
              reconcileParticipantMedia(remoteFb2);
            }
          }, 1500);
          // Schedule reconcile waves to ensure everything settles
          scheduleReconcileWaves("opt-in-watch");
        }
        // Show existing tile if it was created
        var tile = screenTileByIdentity.get(identity);
        if (tile) tile.style.display = "";
        // Unmute screen share audio
        if (pState && pState.screenAudioEls) {
          pState.screenAudioEls.forEach(function(el) {
            el.muted = false;
            var gn = pState.screenGainNodes?.get(el);
            if (gn) gn.gain.gain.value = pState.screenVolume || 1;
          });
        }
      } else {
        // === STOP WATCHING: unsubscribe from screen share tracks ===
        hiddenScreens.add(identity);
        watchedScreens.delete(identity);
        watchToggleBtn.textContent = "Start Watching";
        if (ovWatchClone) ovWatchClone.textContent = "Start Watching";
        debugLog("[opt-in] user stopped watching " + identity);

        // Find the remote participant and unsubscribe from their screen share tracks
        var remote = null;
        if (room && room.remoteParticipants) {
          if (room.remoteParticipants.get) {
            remote = room.remoteParticipants.get(identity);
          }
          if (!remote) {
            room.remoteParticipants.forEach(function(p) {
              if (p.identity === identity) remote = p;
            });
          }
        }
        if (remote) {
          var pubs = getParticipantPublications(remote);
          pubs.forEach(function(pub) {
            var src = pub ? (pub.source || (pub.track ? pub.track.source : null)) : null;
            if (src === LK_wt.Track.Source.ScreenShare || src === LK_wt.Track.Source.ScreenShareAudio) {
              if (pub.setSubscribed) pub.setSubscribed(false);
            }
          });
        }
        // Hide tile
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
          pState.screenAudioEls.forEach(function(el) {
            el.muted = true;
            var gn = pState.screenGainNodes?.get(el);
            if (gn) gn.gain.gain.value = 0;
          });
        }
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
    micSlider.max = "3";
    micSlider.step = "0.01";
    micSlider.value = "1";
    micPct = document.createElement("span");
    micPct.className = "vol-pct";
    micPct.textContent = "100%";
    micRow.append(micLabel, micSlider, micPct);
    screenRow = document.createElement("div");
    screenRow.className = "audio-row hidden";
    const screenLabel = document.createElement("span");
    screenLabel.textContent = "Screen";
    screenSlider = document.createElement("input");
    screenSlider.type = "range";
    screenSlider.min = "0";
    screenSlider.max = "3";
    screenSlider.step = "0.01";
    screenSlider.value = "1";
    screenPct = document.createElement("span");
    screenPct.className = "vol-pct";
    screenPct.textContent = "100%";
    screenRow.append(screenLabel, screenSlider, screenPct);
    audioControls.append(micRow, screenRow);
    meta.append(indicators, audioControls);

    // ─── Camera Overlay Bar (for has-camera mode) ───
    try {
    camOverlay = document.createElement("div");
    camOverlay.className = "cam-overlay";

    var overlayName = document.createElement("span");
    overlayName.className = "cam-overlay-name";
    overlayName.textContent = participant.name || "Guest";

    var overlayControls = document.createElement("div");
    overlayControls.className = "cam-overlay-controls";

    // Overlay mic icon — click toggles volume popup
    ovMicBtn = document.createElement("button");
    ovMicBtn.type = "button";
    ovMicBtn.className = "icon-button indicator-only";
    ovMicBtn.innerHTML = iconSvg("mic");
    ovMicBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      var popup = camOverlay.querySelector(".vol-popup");
      if (popup) popup.classList.toggle("is-open");
    });

    // Overlay mic mute button
    ovMicMute = document.createElement("button");
    ovMicMute.type = "button";
    ovMicMute.className = "mute-button";
    ovMicMute.textContent = "Mute";
    ovMicMute.addEventListener("click", function(e) {
      e.stopPropagation();
      micMuteButton.click();
    });

    // Overlay screen icon — click toggles volume popup
    ovScreenBtn = document.createElement("button");
    ovScreenBtn.type = "button";
    ovScreenBtn.className = "icon-button indicator-only";
    ovScreenBtn.innerHTML = iconSvg("screen");
    ovScreenBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      var popup = camOverlay.querySelector(".vol-popup");
      if (popup) popup.classList.toggle("is-open");
    });

    // Overlay screen mute button
    ovScreenMute = document.createElement("button");
    ovScreenMute.type = "button";
    ovScreenMute.className = "mute-button";
    ovScreenMute.textContent = "Mute";
    ovScreenMute.addEventListener("click", function(e) {
      e.stopPropagation();
      screenMuteButton.click();
    });

    // Overlay watch toggle clone
    ovWatchClone = document.createElement("button");
    ovWatchClone.type = "button";
    ovWatchClone.className = "watch-toggle-btn";
    ovWatchClone.textContent = watchToggleBtn.textContent;
    ovWatchClone.style.display = watchToggleBtn.style.display;
    ovWatchClone.addEventListener("click", function(e) {
      e.stopPropagation();
      watchToggleBtn.click();
    });

    overlayControls.append(ovMicBtn, ovMicMute, ovScreenBtn, ovScreenMute, ovWatchClone);

    // Overlay admin controls (if admin)
    if (isAdminMode()) {
      var ovAdminRow = document.createElement("div");
      ovAdminRow.className = "admin-controls admin-only";
      var ovKick = document.createElement("button");
      ovKick.type = "button";
      ovKick.className = "admin-kick-btn";
      ovKick.textContent = "Kick";
      ovKick.addEventListener("click", function(e) {
        e.stopPropagation();
        adminKickParticipant(participant.identity);
      });
      var ovMuteServer = document.createElement("button");
      ovMuteServer.type = "button";
      ovMuteServer.className = "admin-mute-btn";
      ovMuteServer.textContent = "S.Mute";
      ovMuteServer.addEventListener("click", function(e) {
        e.stopPropagation();
        adminMuteParticipant(participant.identity);
      });
      ovAdminRow.append(ovMuteServer, ovKick);
      overlayControls.append(ovAdminRow);
    }

    // Volume popup (appears above overlay)
    var volPopup = document.createElement("div");
    volPopup.className = "vol-popup";

    var popMicRow = document.createElement("div");
    popMicRow.className = "audio-row";
    var popMicLabel = document.createElement("span");
    popMicLabel.textContent = "Mic";
    popMicSlider = document.createElement("input");
    popMicSlider.type = "range";
    popMicSlider.min = "0";
    popMicSlider.max = "3";
    popMicSlider.step = "0.01";
    popMicSlider.value = micSlider.value;
    popMicPct = document.createElement("span");
    popMicPct.className = "vol-pct";
    popMicPct.textContent = micPct.textContent;
    if (Number(micSlider.value) > 1) popMicPct.classList.add("boosted");
    popMicRow.append(popMicLabel, popMicSlider, popMicPct);

    var popScreenRow = document.createElement("div");
    popScreenRow.className = "audio-row";
    var popScreenLabel = document.createElement("span");
    popScreenLabel.textContent = "Screen";
    popScreenSlider = document.createElement("input");
    popScreenSlider.type = "range";
    popScreenSlider.min = "0";
    popScreenSlider.max = "3";
    popScreenSlider.step = "0.01";
    popScreenSlider.value = screenSlider.value;
    popScreenPct = document.createElement("span");
    popScreenPct.className = "vol-pct";
    popScreenPct.textContent = screenPct.textContent;
    if (Number(screenSlider.value) > 1) popScreenPct.classList.add("boosted");
    popScreenRow.append(popScreenLabel, popScreenSlider, popScreenPct);

    volPopup.append(popMicRow, popScreenRow);
    camOverlay.append(overlayName, overlayControls, volPopup);

    // Close popup when clicking outside
    document.addEventListener("click", function(e) {
      if (!camOverlay.contains(e.target)) {
        volPopup.classList.remove("is-open");
      }
    });

    header.appendChild(camOverlay);
    } catch (overlayErr) {
      debugLog("[cam-overlay] ERROR creating overlay for " + key + ": " + overlayErr.message);
      camOverlay = null;
    }
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
          pState.screenAudioEls.forEach(function(el) {
            el.muted = false;
            var gn = pState.screenGainNodes?.get(el);
            if (gn) gn.gain.gain.value = pState.screenVolume || 1;
          });
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
          pState.screenAudioEls.forEach(function(el) {
            el.muted = true;
            var gn = pState.screenGainNodes?.get(el);
            if (gn) gn.gain.gain.value = 0;
          });
        }
        watchToggleBtn.textContent = "Start Watching";
      }
    });
    controls.append(watchToggleBtn);
    meta.append(controls);
    micStatusEl = micControl;
    screenStatusEl = screenControl;
  }
  if (isLocal) {
    userListEl.prepend(card);
  } else {
    userListEl.appendChild(card);
  }

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
    micGainNodes: new Map(),     // audioEl -> { source, gain } for volume boost
    screenGainNodes: new Map(),  // audioEl -> { source, gain } for volume boost
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
      // Sync overlay mute button
      if (ovMicMute) {
        ovMicMute.textContent = state.micUserMuted ? "Unmute" : "Mute";
        ovMicMute.classList.toggle("is-muted", state.micUserMuted);
      }
      applyParticipantAudioVolumes(state);
      updateActiveSpeakerUi();
    });
  }
  if (screenMuteButton) {
    screenMuteButton.addEventListener("click", () => {
      state.screenUserMuted = !state.screenUserMuted;
      screenMuteButton.textContent = state.screenUserMuted ? "Unmute" : "Mute";
      screenMuteButton.classList.toggle("is-muted", state.screenUserMuted);
      // Sync overlay mute button
      if (ovScreenMute) {
        ovScreenMute.textContent = state.screenUserMuted ? "Unmute" : "Mute";
        ovScreenMute.classList.toggle("is-muted", state.screenUserMuted);
      }
      applyParticipantAudioVolumes(state);
    });
  }
  if (micSlider) {
    micSlider.addEventListener("input", () => {
      state.micVolume = Number(micSlider.value);
      if (micPct) micPct.textContent = Math.round(state.micVolume * 100) + "%";
      if (micPct) micPct.classList.toggle("boosted", state.micVolume > 1);
      // Sync popup slider
      if (popMicSlider) popMicSlider.value = state.micVolume;
      if (popMicPct) { popMicPct.textContent = Math.round(state.micVolume * 100) + "%"; popMicPct.classList.toggle("boosted", state.micVolume > 1); }
      applyParticipantAudioVolumes(state);
      saveParticipantVolume(key, state.micVolume, state.screenVolume);
    });
  }
  if (screenSlider) {
    screenSlider.addEventListener("input", () => {
      state.screenVolume = Number(screenSlider.value);
      if (screenPct) screenPct.textContent = Math.round(state.screenVolume * 100) + "%";
      if (screenPct) screenPct.classList.toggle("boosted", state.screenVolume > 1);
      // Sync popup slider
      if (popScreenSlider) popScreenSlider.value = state.screenVolume;
      if (popScreenPct) { popScreenPct.textContent = Math.round(state.screenVolume * 100) + "%"; popScreenPct.classList.toggle("boosted", state.screenVolume > 1); }
      applyParticipantAudioVolumes(state);
      saveParticipantVolume(key, state.micVolume, state.screenVolume);
    });
  }
  // Popup slider handlers (sync back to original sliders)
  if (popMicSlider) {
    popMicSlider.addEventListener("input", function() {
      var val = Number(popMicSlider.value);
      state.micVolume = val;
      if (micSlider) micSlider.value = val;
      var pctText = Math.round(val * 100) + "%";
      if (popMicPct) { popMicPct.textContent = pctText; popMicPct.classList.toggle("boosted", val > 1); }
      if (micPct) { micPct.textContent = pctText; micPct.classList.toggle("boosted", val > 1); }
      applyParticipantAudioVolumes(state);
      saveParticipantVolume(key, state.micVolume, state.screenVolume);
    });
  }
  if (popScreenSlider) {
    popScreenSlider.addEventListener("input", function() {
      var val = Number(popScreenSlider.value);
      state.screenVolume = val;
      if (screenSlider) screenSlider.value = val;
      var pctText = Math.round(val * 100) + "%";
      if (popScreenPct) { popScreenPct.textContent = pctText; popScreenPct.classList.toggle("boosted", val > 1); }
      if (screenPct) { screenPct.textContent = pctText; screenPct.classList.toggle("boosted", val > 1); }
      applyParticipantAudioVolumes(state);
      saveParticipantVolume(key, state.micVolume, state.screenVolume);
    });
  }
  // Restore saved volume preferences for this participant
  if (!isLocal) {
    var savedVol = getParticipantVolume(key);
    if (savedVol) {
      if (savedVol.mic != null && micSlider) {
        state.micVolume = savedVol.mic;
        micSlider.value = savedVol.mic;
        if (micPct) micPct.textContent = Math.round(savedVol.mic * 100) + "%";
        if (micPct) micPct.classList.toggle("boosted", savedVol.mic > 1);
        // Sync popup slider
        if (popMicSlider) popMicSlider.value = savedVol.mic;
        if (popMicPct) { popMicPct.textContent = Math.round(savedVol.mic * 100) + "%"; popMicPct.classList.toggle("boosted", savedVol.mic > 1); }
      }
      if (savedVol.screen != null && screenSlider) {
        state.screenVolume = savedVol.screen;
        screenSlider.value = savedVol.screen;
        if (screenPct) screenPct.textContent = Math.round(savedVol.screen * 100) + "%";
        if (screenPct) screenPct.classList.toggle("boosted", savedVol.screen > 1);
        // Sync popup slider
        if (popScreenSlider) popScreenSlider.value = savedVol.screen;
        if (popScreenPct) { popScreenPct.textContent = Math.round(savedVol.screen * 100) + "%"; popScreenPct.classList.toggle("boosted", savedVol.screen > 1); }
      }
      applyParticipantAudioVolumes(state);
      debugLog("[vol-prefs] restored " + key + " mic=" + (savedVol.mic || 1) + " screen=" + (savedVol.screen || 1));
    }
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
    watchToggleBtn: typeof watchToggleBtn !== "undefined" ? watchToggleBtn : null,
    camOverlay,
    ovMicBtn,
    ovMicMute,
    ovScreenBtn,
    ovScreenMute,
    ovWatchClone,
    popMicSlider,
    popMicPct,
    popScreenSlider,
    popScreenPct
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
    if (pub?.setSubscribed && !isUnwatchedScreenShare(pub, participant)) pub.setSubscribed(true);
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
    if (pub?.setSubscribed && !isUnwatchedScreenShare(pub, participant)) pub.setSubscribed(true);
    hookPublication(pub, participant);
  });
}

function updateAvatarVideo(cardRef, track) {
  if (!cardRef || !cardRef.avatar) {
    debugLog("ERROR: updateAvatarVideo called with invalid cardRef or avatar! cardRef=" + !!cardRef + ", avatar=" + !!cardRef?.avatar);
    return;
  }
  var avatar = cardRef.avatar;
  var card = cardRef.card;
  var isLocal = cardRef.isLocal;
  // Preserve the hidden file input for local user avatar upload
  var fileInput = avatar.querySelector('input[type="file"]');
  avatar.innerHTML = "";
  if (fileInput) avatar.appendChild(fileInput);
  if (track) {
    var element = createLockedVideoElement(track);
    configureVideoElement(element, true);
    startBasicVideoMonitor(element);
    avatar.appendChild(element);
    debugLog("video attached to avatar for track " + (track.sid || "unknown"));
    // Toggle camera-first layout for remote users
    if (!isLocal && card) {
      card.classList.add("has-camera");
    }
  } else {
    avatar.textContent = getInitials(card?.querySelector(".user-name")?.textContent || "");
    if (fileInput) avatar.appendChild(fileInput);
    // Show avatar image if one exists (replaces initials)
    var identity = card?.dataset?.identity;
    if (identity) updateAvatarDisplay(identity);
    // Revert to compact layout for remote users
    if (!isLocal && card) {
      card.classList.remove("has-camera");
    }
    // Close any open volume popup
    if (cardRef.camOverlay) {
      var popup = cardRef.camOverlay.querySelector(".vol-popup");
      if (popup) popup.classList.remove("is-open");
    }
  }
}

async function uploadAvatar(file) {
  if (!adminToken || !room?.localParticipant) return;
  if (file.size > 50 * 1024 * 1024) {
    showToast("Avatar too large (max 50MB)");
    return;
  }
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
    var deviceId = getLocalDeviceId();
    const res = await fetch(apiUrl(`/api/avatar/upload?identity=${encodeURIComponent(deviceId)}`), {
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
      echoSet("echo-avatar-device", relativePath); // store by device, not name

      // Update own card
      updateAvatarDisplay(room.localParticipant.identity);

      // Broadcast relative path so remote users resolve via their own server
      broadcastAvatar(identityBase, relativePath);

      debugLog("Avatar uploaded for " + identityBase + " (device=" + deviceId + "), url=" + avatarUrl);
    } else {
      var errMsg = data?.error || "Upload failed";
      debugLog("Avatar upload NOT ok: " + JSON.stringify(data));
      showToast(errMsg);
    }
  } catch (e) {
    debugLog("Avatar upload failed: " + e.message);
    showToast("Avatar upload failed: " + e.message);
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

// Broadcast our device ID so other participants can map identity -> device for chime/profile lookups
function broadcastDeviceId() {
  if (!room?.localParticipant) return;
  var identityBase = getIdentityBase(room.localParticipant.identity);
  var deviceId = getLocalDeviceId();
  var msg = JSON.stringify({ type: "device-id", identityBase: identityBase, deviceId: deviceId });
  try {
    room.localParticipant.publishData(new TextEncoder().encode(msg), { reliable: true });
    debugLog("[device-profile] broadcast deviceId " + deviceId + " for " + identityBase);
  } catch (e) {
    debugLog("[device-profile] broadcast failed: " + e.message);
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
  // Guard: NEVER put a screen share track in the camera avatar
  var LK_ec = getLiveKitClient();
  var pubSource = publication?.source || track?.source;
  if (pubSource === LK_ec?.Track?.Source?.ScreenShare || pubSource === LK_ec?.Track?.Source?.ScreenShareAudio) {
    debugLog(`ERROR: ensureCameraVideo called with screen share track! identity=${cardRef.card?.dataset?.identity} source=${pubSource} trackSid=${track.sid || "?"}`);
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
    // Opt-in: skip unwatched remote screen shares entirely
    if (isUnwatchedScreenShare(pub, participant)) return;
    if (pub.setSubscribed) pub.setSubscribed(true);
    const track = pub.track;
    if (!track) return;
    const source = getTrackSource(pub, track);
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

// Fast reconcile for room switches — ICE is warm, tracks arrive quickly
function scheduleReconcileWavesFast(reason) {
  if (reconcilePending) {
    const timer = setTimeout(() => runFullReconcile(reason), 200);
    reconcileTimers.add(timer);
    return;
  }
  reconcilePending = true;
  var delays = [100, 400];
  delays.forEach(function(delay) {
    var timer = setTimeout(function() { runFullReconcile(reason); }, delay);
    reconcileTimers.add(timer);
  });
  var resetTimer = setTimeout(function() {
    reconcilePending = false;
    _isRoomSwitch = false; // Room switch settled
  }, 600);
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
      if (isUnwatchedScreenShare(pub, participant)) return;
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

// Lazily create a GainNode for an audio element (only when boost > 100% needed)
// createMediaStreamSource captures the stream into WebAudio so the HTML element
// can no longer output audio independently — only call this when actually boosting.
function ensureGainNode(state, audioEl, isScreen) {
  var map = isScreen ? state.screenGainNodes : state.micGainNodes;
  if (map.has(audioEl)) return map.get(audioEl);
  try {
    var actx = getParticipantAudioCtx();
    if (actx.state === "suspended") actx.resume().catch(function() {});
    if (!audioEl.srcObject) return null;
    var srcNode = actx.createMediaStreamSource(audioEl.srcObject);
    var gainNode = actx.createGain();
    gainNode.gain.value = 1.0;
    srcNode.connect(gainNode);
    gainNode.connect(actx.destination);
    audioEl.volume = 0; // GainNode now handles output
    audioEl.muted = false;
    var ref = { source: srcNode, gain: gainNode };
    map.set(audioEl, ref);
    return ref;
  } catch (e) {
    debugLog("[vol-boost] lazy GainNode failed: " + e.message);
    return null;
  }
}

// Clean up WebAudio gain nodes when an audio element is removed
function cleanupGainNode(state, audioEl, isScreen) {
  if (!state) return;
  var map = isScreen ? state.screenGainNodes : state.micGainNodes;
  if (map) {
    var gn = map.get(audioEl);
    if (gn) {
      try { gn.gain.disconnect(); } catch (e) {}
      try { gn.source.disconnect(); } catch (e) {}
      map.delete(audioEl);
    }
  }
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
    var gn = state.micGainNodes?.get(el);
    if (!gn && state.micVolume > 1) {
      // Lazily create GainNode only when boosting above 100%
      gn = ensureGainNode(state, el, false);
    }
    if (gn) {
      gn.gain.gain.value = micVolume;
    } else {
      el.volume = Math.min(1, micVolume);
    }
  });
  const screenVolume = roomAudioMuted || state.screenUserMuted ? 0 : state.screenVolume;
  state.screenAudioEls.forEach((el) => {
    var gn = state.screenGainNodes?.get(el);
    if (!gn && state.screenVolume > 1) {
      gn = ensureGainNode(state, el, true);
    }
    if (gn) {
      gn.gain.gain.value = screenVolume;
    } else {
      el.volume = Math.min(1, screenVolume);
    }
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
    // Sync overlay mic button state
    try {
      if (cardRef.ovMicBtn) {
        cardRef.ovMicBtn.classList.toggle("is-muted", !!muted);
        if (muted) {
          cardRef.ovMicBtn.classList.remove("is-active");
        } else {
          var hasRecentAS = performance.now() - lastActiveSpeakerEvent < 1500;
          var remAct = hasRecentAS ? activeSpeakerIds.has(identity) : Boolean(state?.micActive);
          var locAct = Boolean(state?.micActive);
          var act = cardRef.isLocal ? locAct : remAct;
          cardRef.ovMicBtn.classList.toggle("is-active", act);
        }
      }
    } catch (_e) {}
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
  const source = getTrackSource(publication, track);
  const cardRef = ensureParticipantCard(participant);
  debugLog("[track-source] " + participant.identity + " kind=" + track.kind +
    " source=" + source + " pub.source=" + publication?.source +
    " track.source=" + track?.source);
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
  if (publication?.setSubscribed && !isUnwatchedScreenShare(publication, participant)) {
    publication.setSubscribed(true);
  }
  if (track.kind === "video") {
    requestVideoKeyFrame(publication, track);
    setTimeout(() => requestVideoKeyFrame(publication, track), 500);
  }
  if (track.kind === "video" && source === LK.Track.Source.ScreenShare) {
    // Opt-in: remote screen shares default to unwatched — unsubscribe unless explicitly watching
    var _isLocalScreen = room && room.localParticipant && participant.identity === room.localParticipant.identity;
    if (!_isLocalScreen && isUnwatchedScreenShare(publication, participant)) {
      if (publication?.setSubscribed) publication.setSubscribed(false);
      if (cardRef && cardRef.watchToggleBtn) {
        cardRef.watchToggleBtn.style.display = "";
        cardRef.watchToggleBtn.textContent = "Start Watching";
        if (cardRef.ovWatchClone) { cardRef.ovWatchClone.style.display = ""; cardRef.ovWatchClone.textContent = "Start Watching"; }
      }
      debugLog("[opt-in] auto-unsubscribed unwatched screen " + participant.identity);
      return;
    }
    const identity = participant.identity;
    const screenTrackSid = publication?.trackSid || track?.sid || null;
    const existingTile = screenTileByIdentity.get(identity) || (screenTrackSid ? screenTileBySid.get(screenTrackSid) : null);
    if (existingTile && existingTile.isConnected) {
      const existingVideo = existingTile.querySelector("video");
      if (cardRef && cardRef.watchToggleBtn) {
        cardRef.watchToggleBtn.style.display = "";
        cardRef.watchToggleBtn.textContent = hiddenScreens.has(identity) ? "Start Watching" : "Stop Watching";
        if (cardRef.ovWatchClone) { cardRef.ovWatchClone.style.display = ""; cardRef.ovWatchClone.textContent = cardRef.watchToggleBtn.textContent; }
      }
      // If same track object, NEVER replace the element — just ensure it plays.
      // SDP renegotiations fire unsub/resub for the same track every ~2s. Replacing
      // the video element interrupts play(), creating a loop of "interrupted by new load".
      if (existingVideo && existingVideo._lkTrack === track) {
        ensureVideoPlays(track, existingVideo);
        ensureVideoSubscribed(publication, existingVideo);
        forceVideoLayer(publication, existingVideo);
        return;
      }
      // Different track — replace video element in existing tile (don't recreate tile)
      replaceScreenVideoElement(existingTile, track, publication);
      // Clean up old trackSid references so watchdog doesn't monitor stale data
      const oldTrackSid = existingTile.dataset.trackSid;
      if (oldTrackSid && oldTrackSid !== screenTrackSid) {
        screenTileBySid.delete(oldTrackSid);
        unregisterScreenTrack(oldTrackSid);
        debugLog("[screen-tile] migrated trackSid: " + oldTrackSid + " -> " + screenTrackSid + " for " + identity);
      }
      if (screenTrackSid) {
        existingTile.dataset.trackSid = screenTrackSid;
        screenTileBySid.set(screenTrackSid, existingTile);
        registerScreenTrack(screenTrackSid, publication, existingTile, participant.identity);
        scheduleScreenRecovery(screenTrackSid, publication, existingTile.querySelector("video"));
      }
      screenTileByIdentity.set(identity, existingTile);
      // Update participantState to track new screenTrackSid
      const pState = participantState.get(identity);
      if (pState) pState.screenTrackSid = screenTrackSid;
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
    // Minimize video playout delay for screen share to reduce A/V desync
    var _isRemoteScreen = room && room.localParticipant && participant.identity !== room.localParticipant.identity;
    if (_isRemoteScreen && track?.mediaStreamTrack) {
      try {
        const pc = room?.engine?.pcManager?.subscriber?.pc;
        if (pc) {
          const receivers = pc.getReceivers();
          const videoReceiver = receivers.find(r => r.track === track.mediaStreamTrack);
          if (videoReceiver && "playoutDelayHint" in videoReceiver) {
            videoReceiver.playoutDelayHint = 0; // Minimum playout delay
            debugLog("[sync] set video playoutDelayHint=0 for " + participant.identity);
          }
        }
      } catch {}
    }
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
    // Start inbound stats monitor for remote screen shares
    var _isLocalTile = room && room.localParticipant && participant.identity === room.localParticipant.identity;
    if (!_isLocalTile) startInboundScreenStatsMonitor();
    // Opt-in screen shares: tile was created because user is watching (or it's local)
    // No need to hide — the intercept at the top of this function already unsubscribed unwatched screens
    if (cardRef && cardRef.watchToggleBtn) {
      cardRef.watchToggleBtn.style.display = "";
      cardRef.watchToggleBtn.textContent = hiddenScreens.has(participant.identity) ? "Start Watching" : "Stop Watching";
      if (cardRef.ovWatchClone) { cardRef.ovWatchClone.style.display = ""; cardRef.ovWatchClone.textContent = cardRef.watchToggleBtn.textContent; }
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
    // Start inbound stats monitor for remote cameras (adaptive layer selection)
    var _isLocalCam = room && room.localParticipant && participant.identity === room.localParticipant.identity;
    if (!_isLocalCam) startInboundScreenStatsMonitor();
    return;
  }
  // Defensive fallback: video track with unknown/null source
  // Try to infer source from track label, resolution, or existing state before routing
  if (track.kind === "video" && source !== LK.Track.Source.ScreenShare && source !== LK.Track.Source.Camera) {
    var mstLabel = track?.mediaStreamTrack?.label || "";
    var mstW = track?.mediaStreamTrack?.getSettings?.()?.width || 0;
    // Heuristics: screen shares typically have "screen"/"window"/"monitor" in label, or very wide resolution
    var looksLikeScreen = /screen|window|monitor|display/i.test(mstLabel) || mstW > 1280;
    debugLog("[source-detect] WARNING: video track with unknown source for " +
      participant.identity + " — pub.source=" + publication?.source +
      " track.source=" + track?.source + " label=" + mstLabel +
      " width=" + mstW + " looksLikeScreen=" + looksLikeScreen);
    if (looksLikeScreen) {
      // Route to screen share path instead of clobbering the camera avatar
      debugLog("[source-detect] routing unknown video as screen share for " + participant.identity);
      handleTrackSubscribed(track, Object.assign({}, publication, { source: LK.Track.Source.ScreenShare }), participant);
    } else {
      ensureCameraVideo(cardRef, track, publication);
    }
    return;
  }
  if (track.kind === "audio") {
    // Opt-in: don't attach audio for unwatched remote screen shares
    if (isUnwatchedScreenShare(publication, participant)) {
      if (publication?.setSubscribed) publication.setSubscribed(false);
      debugLog("[opt-in] auto-unsubscribed unwatched screen audio " + participant.identity);
      return;
    }
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
    // Volume boost: GainNode is created lazily in applyParticipantAudioVolumes()
    // only when the user boosts above 100%. At normal volume, the plain HTML
    // audio element handles playback directly.
    // Minimize audio playout delay for screen share audio to reduce A/V desync
    if (source === LK.Track.Source.ScreenShareAudio) {
      try {
        const pc = room?.engine?.pcManager?.subscriber?.pc;
        if (pc && track.mediaStreamTrack) {
          const receivers = pc.getReceivers();
          const audioReceiver = receivers.find(r => r.track === track.mediaStreamTrack);
          if (audioReceiver && "playoutDelayHint" in audioReceiver) {
            audioReceiver.playoutDelayHint = 0; // Minimum playout delay
            debugLog("[sync] set audio playoutDelayHint=0 for " + participant.identity);
          }
        }
      } catch {}
    }
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
  const source = getTrackSource(publication, track);
  const trackSid = getTrackSid(
    publication,
    track,
    participant ? `${participant.identity}-${source || track.kind}` : null
  );
  debugLog("[unsub] handleTrackUnsubscribed " + (participant?.identity || "?") + " src=" + source + " sid=" + trackSid + " kind=" + track.kind);
  const intentTs = trackSid ? screenResubscribeIntent.get(trackSid) : null;
  const suppressRemoval = intentTs && performance.now() - intentTs < 5000;
  if (trackSid) {
    screenRecoveryAttempts.delete(trackSid);
  }
  if (track.kind === "video" && source === LK.Track.Source.ScreenShare) {
    const identity = participant?.identity;
    const tile = trackSid ? screenTileBySid.get(trackSid) : null;
    // Check if the publisher is still sharing — if so, this is a transient unsub
    // from SDP renegotiation and we should NOT destroy the tile.
    var stillPublishing = false;
    if (identity && room && room.remoteParticipants) {
      var remoteP = null;
      if (room.remoteParticipants.get) remoteP = room.remoteParticipants.get(identity);
      if (!remoteP) {
        room.remoteParticipants.forEach(function(p) { if (p.identity === identity) remoteP = p; });
      }
      if (remoteP) {
        var pubs = getParticipantPublications(remoteP);
        stillPublishing = pubs.some(function(pub) {
          return pub && pub.source === LK.Track.Source.ScreenShare && pub.kind === LK?.Track?.Kind?.Video;
        });
      }
    }
    // Don't remove tile if user just opted out (stopped watching) — they may re-watch.
    // Only remove if the publisher actually stopped sharing or if suppressRemoval is active.
    var userOptedOut = identity && hiddenScreens.has(identity);
    if (stillPublishing && tile) {
      // Transient unsub during SDP renegotiation — keep tile alive
      debugLog("[unsub] SUPPRESSED tile removal for " + identity + " (publisher still sharing, transient SDP unsub)");
    } else if (!suppressRemoval && !userOptedOut && tile && tile.dataset.trackSid === trackSid) {
      debugLog("[unsub] removing tile for " + identity + " sid=" + trackSid);
      removeScreenTile(trackSid);
      unregisterScreenTrack(trackSid);
      if (identity) screenTileByIdentity.delete(identity);
      if (trackSid) screenResubscribeIntent.delete(trackSid);
    } else if (userOptedOut && tile) {
      // User stopped watching — hide tile but keep it in the DOM for fast re-watch
      tile.style.display = "none";
      debugLog("[opt-in] hiding tile (user opted out, publisher still sharing) " + identity);
    }
    if (identity) {
      // Only clear hiddenScreens and hide watch button if the participant
      // actually stopped sharing (not just user unsubscribing via opt-out)
      var stillPublishing = false;
      var remoteP = null;
      if (room && room.remoteParticipants) {
        if (room.remoteParticipants.get) remoteP = room.remoteParticipants.get(identity);
        if (!remoteP) {
          room.remoteParticipants.forEach(function(p) { if (p.identity === identity) remoteP = p; });
        }
      }
      if (remoteP) {
        var rPubs = getParticipantPublications(remoteP);
        stillPublishing = rPubs.some(function(pub) {
          return pub && pub.source === LK.Track.Source.ScreenShare;
        });
      }
      if (!stillPublishing) {
        // Participant stopped sharing — clean up fully
        hiddenScreens.delete(identity);
        watchedScreens.delete(identity);
        // Clean up receiver-side AIMD bitrate control state for this publisher
        if (_pubBitrateControl.has(identity)) {
          _pubBitrateControl.delete(identity);
          debugLog("[bitrate-ctrl] cleared AIMD state for " + identity + " (screen share ended)");
        }
        var cardRef2 = participantCards.get(identity);
        if (cardRef2 && cardRef2.watchToggleBtn) {
          cardRef2.watchToggleBtn.style.display = "none";
          cardRef2.watchToggleBtn.textContent = "Stop Watching";
          if (cardRef2.ovWatchClone) { cardRef2.ovWatchClone.style.display = "none"; cardRef2.ovWatchClone.textContent = "Stop Watching"; }
        }
      }
      // If still publishing but user unsubscribed, keep hiddenScreens and button as-is
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
              cleanupGainNode(pState, audioEl, true);
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
    // Grace period for mic audio during reconnection: delay removal so audio survives brief reconnects
    if (_isReconnecting && source === LK.Track.Source.Microphone && audioEl && participant) {
      debugLog(`[reconnect] mic audio unsubscribe ${participant.identity} sid=${trackSid} — delaying removal (2s grace)`);
      const micIdentity = participant.identity;
      setTimeout(() => {
        const currentEl = audioElBySid.get(trackSid);
        if (currentEl === audioEl) {
          const pubs = participant.trackPublications ? Array.from(participant.trackPublications.values()) : [];
          const hasMic = pubs.some((pub) => pub?.source === LK.Track.Source.Microphone && pub.track && pub.isSubscribed);
          if (!hasMic) {
            debugLog(`mic audio removed after grace period: ${micIdentity} sid=${trackSid}`);
            audioEl.remove();
            audioElBySid.delete(trackSid);
            const pState = participantState.get(micIdentity);
            if (pState) {
              cleanupGainNode(pState, audioEl, false);
              pState.micAudioEls.delete(audioEl);
              pState.micMuted = true;
              if (pState.micAnalyser?.cleanup) pState.micAnalyser.cleanup();
              pState.micAnalyser = null;
              updateActiveSpeakerUi();
            }
          } else {
            debugLog(`mic audio kept (track returned): ${micIdentity} sid=${trackSid}`);
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
          cleanupGainNode(state, audioEl, true);
          state.screenAudioEls.delete(audioEl);
          if (state.screenAnalyser?.cleanup) {
            state.screenAnalyser.cleanup();
          }
          state.screenAnalyser = null;
        } else {
          cleanupGainNode(state, audioEl, false);
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
  // Route participant volume-boost AudioContext to selected speaker
  if (_participantAudioCtx && typeof _participantAudioCtx.setSinkId === "function") {
    var sinkId = selectedSpeakerId && selectedSpeakerId.length > 0 ? selectedSpeakerId : "default";
    try { await _participantAudioCtx.setSinkId(sinkId); } catch {}
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
      sendSoundboardMessage({ type: "sound-play", soundId: sound.id, senderName: room?.localParticipant?.name || "", soundName: sound.name || "" });
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
      sendSoundboardMessage({ type: "sound-play", soundId: sound.id, senderName: room?.localParticipant?.name || "", soundName: sound.name || "" });
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
  // Fetch token (cached on room switch, live on first connect)
  const accessToken = reuseAdmin
    ? await getCachedOrFetchToken(controlUrl, adminToken, roomId, identity, name)
    : await fetchRoomToken(controlUrl, adminToken, roomId, identity, name);
  if (seq !== connectSequence) return;
  currentAccessToken = accessToken;
  tokenCache.delete(roomId); // Invalidate cache for room we just joined

  // Save reference to old room so we can disconnect AFTER new room connects
  const oldRoom = room;
  const hadOldRoom = !!oldRoom;

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
          result.push("b=AS:25000");
          result.push("b=TIAS:25000000");
          addedBW = true;
        }
      }
      return result.join("\r\n");
    }

    // Profile + level upgrade — only for local/offer SDPs (publisher side).
    // Changing profiles in remote (SFU answer) SDPs breaks negotiation.
    function _upgradeH264Profile(sdp) {
      // Constrained Baseline (42e0) routes to OpenH264 (software, ~25fps max for 1080p).
      // High profile (6400) routes to hardware encoder (NVENC/QSV/AMF, 60fps easy).
      // Level 5.1 (0x33) supports up to 4096x2304@60fps — needed for 4K simulcast HIGH layer.
      sdp = sdp.replace(/profile-level-id=([0-9a-fA-F]{4})([0-9a-fA-F]{2})/g, function(match, profile, level) {
        var newProfile = profile;
        var newLevel = level;
        // Upgrade Constrained Baseline (42e0/42c0) or Baseline (4200) to High (6400)
        var profileLower = profile.toLowerCase();
        if (profileLower === "42e0" || profileLower === "42c0" || profileLower === "4200" || profileLower === "4d00") {
          newProfile = "6400";
          debugLog("[SDP] H264 profile " + profile + " -> 6400 (High, for hardware encoder)");
        }
        // Upgrade level to 5.1 for 4K@60fps simulcast
        var lvl = parseInt(level, 16);
        if (lvl < 0x33) {
          newLevel = "33";
          debugLog("[SDP] H264 level " + level + " -> 33 (5.1 for 4K@60fps)");
        }
        return "profile-level-id=" + newProfile + newLevel;
      });
      return sdp;
    }

    // Level-only upgrade for remote SDPs — don't change profiles in SFU answers
    function _upgradeLevelOnly(sdp) {
      sdp = sdp.replace(/profile-level-id=([0-9a-fA-F]{4})([0-9a-fA-F]{2})/g, function(match, profile, level) {
        var lvl = parseInt(level, 16);
        if (lvl < 0x33) {
          debugLog("[SDP] H264 level " + level + " -> 33 (5.1 for 4K@60fps)");
          return "profile-level-id=" + profile + "33";
        }
        return match;
      });
      return sdp;
    }

    function _addCodecBitrateHints(sdp) {

      // ── H264 fmtp bitrate hints ──
      const h264Matches = sdp.matchAll(/a=rtpmap:(\d+) H264\/90000/g);
      for (const m of h264Matches) {
        const pt = m[1];
        const re = new RegExp(`(a=fmtp:${pt} [^\\r\\n]*)`, "g");
        if (re.test(sdp)) {
          sdp = sdp.replace(new RegExp(`(a=fmtp:${pt} [^\\r\\n]*)`, "g"),
            "$1;x-google-start-bitrate=10000;x-google-min-bitrate=5000;x-google-max-bitrate=25000;max-fr=60");
        }
      }

      // ── VP8/VP9 x-google bitrate hints ──
      // These help Chrome's BWE ramp up faster for VP8/VP9 screen share
      for (const codec of ["VP8", "VP9"]) {
        const vpMatches = sdp.matchAll(new RegExp("a=rtpmap:(\\d+) " + codec + "/90000", "g"));
        for (const vm of vpMatches) {
          const pt = vm[1];
          // Check if fmtp line exists for this payload type
          const fmtpRe = new RegExp("(a=fmtp:" + pt + " [^\\r\\n]*)", "g");
          if (fmtpRe.test(sdp)) {
            // Append x-google hints if not already present
            if (sdp.indexOf("a=fmtp:" + pt + " ") >= 0 && sdp.indexOf("x-google-start-bitrate") === -1) {
              sdp = sdp.replace(new RegExp("(a=fmtp:" + pt + " [^\\r\\n]*)", "g"),
                "$1;x-google-start-bitrate=10000;x-google-min-bitrate=5000;x-google-max-bitrate=25000");
            }
          }
        }
      }
      return sdp;
    }

    // Hook createOffer to catch SDP before LiveKit passes it anywhere
    const _origCreateOffer = RTCPeerConnection.prototype.createOffer;
    RTCPeerConnection.prototype.createOffer = async function(...args) {
      const offer = await _origCreateOffer.apply(this, args);
      if (offer && offer.sdp) {
        // Offers: upgrade profile + level + bitrate hints (publisher side)
        offer.sdp = _upgradeH264Profile(_addCodecBitrateHints(_mungeSDPBandwidth(offer.sdp)));
        debugLog("[SDP] OFFER munged: profile=High lvl=5.1 + b=AS:25000 + codec hints");
      }
      return offer;
    };

    const _origSLD = RTCPeerConnection.prototype.setLocalDescription;
    RTCPeerConnection.prototype.setLocalDescription = function(desc, ...args) {
      if (desc && desc.sdp) {
        // Local descriptions (our offers/answers): upgrade profile + level
        desc = { type: desc.type, sdp: _upgradeH264Profile(_addCodecBitrateHints(_mungeSDPBandwidth(desc.sdp))) };
        debugLog("[SDP] LOCAL munged (profile+level+bw)");
      } else if (!desc) {
        debugLog("[SDP] WARNING: implicit setLocalDescription (no SDP to munge)");
      }
      return _origSLD.apply(this, [desc, ...args]);
    };

    const _origSRD = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function(desc, ...args) {
      if (desc && desc.sdp) {
        // Remote descriptions (SFU answers): level upgrade + bandwidth only.
        // Do NOT change profiles — SFU negotiated a specific profile, changing it breaks encoding.
        desc = { type: desc.type, sdp: _upgradeLevelOnly(_addCodecBitrateHints(_mungeSDPBandwidth(desc.sdp))) };
        debugLog("[SDP] REMOTE munged: level+bw (profile preserved)");
      }
      return _origSRD.apply(this, [desc, ...args]);
    };

    // Override addTransceiver to enforce per-layer encoding params — SCREEN SHARE ONLY.
    // LiveKit SDK defaults screen share to 15fps (h1080fps15 preset).
    // With simulcast, there are 3 encodings (rids: q=LOW, h=MEDIUM, f=HIGH).
    // We force 60fps on HIGH+MEDIUM, allow 30fps on LOW, and set per-layer bitrate floors.
    const _origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
    RTCPeerConnection.prototype.addTransceiver = function(trackOrKind, init, ...args) {
      // Detect if this is a screen share track
      var isScreenTrack = false;
      try {
        if (trackOrKind && typeof trackOrKind === "object" && trackOrKind.kind === "video") {
          var ssMst = _screenShareVideoTrack?.mediaStreamTrack;
          if (ssMst && trackOrKind === ssMst) isScreenTrack = true;
          if (!isScreenTrack && trackOrKind.contentHint === "motion" && _screenShareVideoTrack) isScreenTrack = true;
        }
      } catch (_) {}
      if (isScreenTrack && init && init.sendEncodings) {
        for (const enc of init.sendEncodings) {
          var isLow = enc.rid === "q" || (enc.scaleResolutionDownBy && enc.scaleResolutionDownBy >= 2.5);
          if (isLow) {
            // LOW layer (720p@30): allow 30fps, floor at 1.5 Mbps
            if (typeof enc.maxFramerate === "number" && enc.maxFramerate < 30) {
              debugLog("[TRANSCEIVER] Screen LOW: maxFramerate " + enc.maxFramerate + " -> 30");
              enc.maxFramerate = 30;
            }
            if (typeof enc.maxBitrate === "number" && enc.maxBitrate < 1000000) {
              enc.maxBitrate = 1500000;
            }
          } else {
            // HIGH or MEDIUM layer: force 60fps
            if (typeof enc.maxFramerate === "number" && enc.maxFramerate < 60) {
              debugLog("[TRANSCEIVER] Screen " + (enc.rid || "?") + ": maxFramerate " + enc.maxFramerate + " -> 60");
              enc.maxFramerate = 60;
            }
            // Bitrate floor: 5 Mbps for MEDIUM, 15 Mbps for HIGH
            var isMedium = enc.rid === "h" || (enc.scaleResolutionDownBy && enc.scaleResolutionDownBy >= 1.5);
            var bitrateFloor = isMedium ? 5000000 : 15000000;
            if (typeof enc.maxBitrate === "number" && enc.maxBitrate < bitrateFloor) {
              enc.maxBitrate = bitrateFloor;
            }
          }
        }
      }
      return _origAddTransceiver.apply(this, [trackOrKind, init, ...args]);
    };

    // Override setParameters to prevent LiveKit SDK from capping screen share framerate.
    // After our publishTrack() + setParameters(60fps), the SDK may asynchronously
    // call setParameters again with its own encoding defaults (h1080fps15 = 15fps).
    // With simulcast: enforce 60fps on HIGH+MEDIUM layers, allow 30fps on LOW layer.
    // Camera senders are left alone (adaptive quality needs to throttle them).
    const _origSetParams = RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters = function(params, ...args) {
      var isScreenSender = false;
      try {
        var ssTrk = _screenShareVideoTrack?.sender;
        if (ssTrk && this === ssTrk) isScreenSender = true;
        if (!isScreenSender && this.track && _screenShareVideoTrack?.mediaStreamTrack) {
          if (this.track === _screenShareVideoTrack.mediaStreamTrack) isScreenSender = true;
        }
      } catch (_) {}
      if (isScreenSender && params && params.encodings) {
        for (const enc of params.encodings) {
          var isLow = enc.rid === "q";
          var minFps = isLow ? 30 : 60;
          if (typeof enc.maxFramerate === "number" && enc.maxFramerate < minFps) {
            debugLog("[SENDER] Screen " + (enc.rid || "?") + ": maxFramerate " + enc.maxFramerate + " -> " + minFps);
            enc.maxFramerate = minFps;
          }
        }
      }
      return _origSetParams.apply(this, [params, ...args]);
    };

    debugLog("SDP + transceiver + setParameters overrides installed (H264 High 5.1, simulcast 3-layer, 20Mbps aggregate)");
  }

  const LK = getLiveKitClient();
  if (!LK || !LK.Room) {
    throw new Error("LiveKit client failed to load. Please refresh and try again.");
  }
  // ── Fast room switching: use pre-warmed room if available ──
  var prewarmed = reuseAdmin ? prewarmedRooms.get(roomId) : null;
  var newRoom;
  if (prewarmed && prewarmed.room) {
    newRoom = prewarmed.room;
    prewarmedRooms.delete(roomId);
    debugLog("[fast-switch] using pre-warmed Room for " + roomId);
  } else {
    if (prewarmed) prewarmedRooms.delete(roomId);
    newRoom = new LK.Room({
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
        screenShareEncoding: { maxBitrate: 15_000_000, maxFramerate: 60 },
        dtx: true,
        degradationPreference: "maintain-resolution",
      },
    });
  }
  try {
    if (typeof newRoom.startAudio === "function") {
      newRoom.startAudio().catch(() => {});
    }
  } catch {}
  if (LK.RoomEvent?.ConnectionStateChanged) {
    newRoom.on(LK.RoomEvent.ConnectionStateChanged, (state) => {
      if (!state) return;
      debugLog("[connection] state changed: " + state);
      if (state === "reconnecting") {
        _isReconnecting = true;
      } else if (state === "connected") {
        _isReconnecting = false;
      }
      if (state === "disconnected") {
        _isReconnecting = false;
        setStatus(`Connection: ${state}`, true);
      } else {
        setStatus(`Connection: ${state}`);
      }
    });
  }
  if (LK.RoomEvent?.Disconnected) {
    newRoom.on(LK.RoomEvent.Disconnected, (reason) => {
      const detail = describeDisconnectReason(reason, LK);
      setStatus(`Disconnected: ${detail}`, true);
      logEvent("room-disconnect", detail);
    });
  }
  if (LK.RoomEvent?.SignalReconnecting) {
    newRoom.on(LK.RoomEvent.SignalReconnecting, () => {
      _isReconnecting = true;
      setStatus("Signal reconnecting...", true);
      logEvent("signal-reconnecting", "");
      debugLog("[reconnect] signal reconnecting — suppressing chimes and delaying cleanup");
      // Safety: auto-reset after 10s if reconnection stalls
      setTimeout(() => { if (_isReconnecting) { _isReconnecting = false; debugLog("[reconnect] safety timeout — resetting reconnecting flag"); } }, 10000);
    });
  }
  if (LK.RoomEvent?.SignalReconnected) {
    newRoom.on(LK.RoomEvent.SignalReconnected, () => {
      _isReconnecting = false;
      setStatus("Signal reconnected");
      logEvent("signal-reconnected", "");
      debugLog("[reconnect] signal reconnected — cancelling pending disconnects");
      // Cancel any pending disconnect cleanups — the participant is back
      for (const [pendingKey, pendingTimer] of _pendingDisconnects) {
        clearTimeout(pendingTimer);
        debugLog("[reconnect] cancelled pending disconnect for " + pendingKey);
      }
      _pendingDisconnects.clear();
      // Reset adaptive layer tracker to HIGH after reconnection
      for (const [dtKey, dtVal] of _inboundDropTracker) {
        if (dtVal.currentQuality !== "HIGH" && LK?.VideoQuality) {
          debugLog("[reconnect] resetting adaptive quality for " + dtKey + " to HIGH");
          dtVal.currentQuality = "HIGH";
          dtVal.fpsHistory = [];
          dtVal.stableTicks = 0;
          dtVal.lowFpsTicks = 0;
          dtVal.highDropTicks = 0;
          dtVal.lastLayerChangeTime = performance.now();
        }
      }
    });
  }
  // Room-level reconnecting/reconnected (covers media reconnection too)
  if (LK.RoomEvent?.Reconnecting) {
    newRoom.on(LK.RoomEvent.Reconnecting, () => {
      _isReconnecting = true;
      setStatus("Reconnecting...", true);
      logEvent("reconnecting", "");
      debugLog("[reconnect] room reconnecting — suppressing chimes and delaying cleanup");
      setTimeout(() => { if (_isReconnecting) { _isReconnecting = false; debugLog("[reconnect] safety timeout — resetting reconnecting flag"); } }, 10000);
    });
  }
  if (LK.RoomEvent?.Reconnected) {
    newRoom.on(LK.RoomEvent.Reconnected, () => {
      _isReconnecting = false;
      setStatus("Reconnected");
      logEvent("reconnected", "");
      debugLog("[reconnect] room reconnected — cancelling pending disconnects");
      for (const [pendingKey, pendingTimer] of _pendingDisconnects) {
        clearTimeout(pendingTimer);
        debugLog("[reconnect] cancelled pending disconnect for " + pendingKey);
      }
      _pendingDisconnects.clear();
      // Reset adaptive layer tracker to HIGH after reconnection so quality recovers immediately
      for (const [dtKey, dtVal] of _inboundDropTracker) {
        if (dtVal.currentQuality !== "HIGH" && LK?.VideoQuality) {
          debugLog("[reconnect] resetting adaptive quality for " + dtKey + " to HIGH");
          dtVal.currentQuality = "HIGH";
          dtVal.fpsHistory = [];
          dtVal.stableTicks = 0;
          dtVal.lowFpsTicks = 0;
          dtVal.highDropTicks = 0;
          dtVal.lastLayerChangeTime = performance.now();
        }
      }
    });
  }
  if (LK.RoomEvent?.ConnectionError) {
    newRoom.on(LK.RoomEvent.ConnectionError, (err) => {
      const detail = err?.message || String(err || "unknown");
      setStatus(`Connection error: ${detail}`, true);
    });
  }
  const localIdentity = identity;
  ensureParticipantCard({ identity: localIdentity, name }, true);
  newRoom.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
    // Opt-in: if a remote screen share arrives but identity isn't in hiddenScreens yet
    // (TrackSubscribed fired before TrackPublished race), add to hiddenScreens now
    // But skip if user explicitly opted in via watchedScreens
    var _subSource = getTrackSource(publication, track);
    var _subIsRemoteScreen = participant && room && room.localParticipant &&
      participant.identity !== room.localParticipant.identity &&
      (_subSource === LK.Track.Source.ScreenShare || _subSource === LK.Track.Source.ScreenShareAudio);
    if (_subIsRemoteScreen && !hiddenScreens.has(participant.identity) && !watchedScreens.has(participant.identity)) {
      hiddenScreens.add(participant.identity);
    }
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
    newRoom.on(LK.RoomEvent.TrackSubscriptionFailed, (publication, participant, err) => {
      const detail = err?.message || String(err || "track subscription failed");
      setStatus(`Track subscription failed: ${detail}`, true);
      debugLog(`track subscription failed ${participant?.identity || "unknown"} ${detail}`);
      if (publication?.setSubscribed) {
        // Don't retry subscription for unwatched screen shares
        if (isUnwatchedScreenShare(publication, participant)) {
          debugLog("[opt-in] skipping subscription retry for unwatched screen " + (participant?.identity || "unknown"));
          return;
        }
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
    newRoom.on(LK.RoomEvent.TrackPublished, (publication, participant) => {
      var pubSource = getTrackSource(publication, publication?.track);
      var isRemoteScreen = participant && room && room.localParticipant &&
        participant.identity !== room.localParticipant.identity &&
        (pubSource === LK.Track.Source.ScreenShare || pubSource === LK.Track.Source.ScreenShareAudio);

      if (isRemoteScreen) {
        // Opt-in: don't subscribe to remote screen shares by default
        if (!hiddenScreens.has(participant.identity)) {
          hiddenScreens.add(participant.identity);
        }
        // Play screen share chime for video track only (not audio), and not during room switches
        if (!_isRoomSwitch && pubSource === LK.Track.Source.ScreenShare) {
          playScreenShareChime();
        }
        var cardRef = participantCards.get(participant.identity);
        if (cardRef && cardRef.watchToggleBtn) {
          cardRef.watchToggleBtn.style.display = "";
          cardRef.watchToggleBtn.textContent = "Start Watching";
          if (cardRef.ovWatchClone) { cardRef.ovWatchClone.style.display = ""; cardRef.ovWatchClone.textContent = "Start Watching"; }
        }
        debugLog(`[opt-in] track published (screen, unwatched) ${participant.identity} src=${pubSource}`);
        // Still hook so we can subscribe later when user opts in
        if (participant) hookPublication(publication, participant);
        return;
      }

      if (publication && publication.setSubscribed) {
        publication.setSubscribed(true);
      }
      debugLog(`track published ${participant?.identity || "unknown"} src=${pubSource}`);
      if (publication?.kind === LK.Track.Kind.Video) {
        requestVideoKeyFrame(publication, publication.track);
        var _kfDelay = _isRoomSwitch ? 300 : 700;
        setTimeout(() => requestVideoKeyFrame(publication, publication.track), _kfDelay);
      }
      if (participant) {
        hookPublication(publication, participant);
      }
      if (participant) {
        var _resubDelay = _isRoomSwitch ? 200 : 900;
        setTimeout(() => resubscribeParticipantTracks(participant), _resubDelay);
      }
      if (_isRoomSwitch) {
        scheduleReconcileWavesFast("track-published");
      } else {
        scheduleReconcileWaves("track-published");
      }
    });
  }
  newRoom.on(LK.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    handleTrackUnsubscribed(track, publication, participant);
  });
  newRoom.on(LK.RoomEvent.ParticipantConnected, (participant) => {
    ensureParticipantCard(participant);
    debugLog(`participant connected ${participant.identity} (reconnecting=${_isReconnecting})`);
    // Cancel any pending disconnect cleanup — this participant just came back
    var wasPendingDisconnect = _pendingDisconnects.has(participant.identity);
    if (wasPendingDisconnect) {
      clearTimeout(_pendingDisconnects.get(participant.identity));
      _pendingDisconnects.delete(participant.identity);
      debugLog(`[reconnect] participant ${participant.identity} reconnected — cancelled pending disconnect`);
    }
    // Real-time enter chime — fires instantly via WebSocket, no polling delay
    // Suppress during reconnection (they never actually left) or brief disconnect/rejoin
    if (!_isRoomSwitch && !_isReconnecting && !wasPendingDisconnect) {
      playChimeForParticipant(participant.identity, "enter");
    }
    // Attach tracks — immediate on room switch (tracks already published), delayed on first connect
    var _trackDelay = _isRoomSwitch ? 0 : 200;
    if (_trackDelay === 0) {
      attachParticipantTracks(participant);
      resubscribeParticipantTracks(participant);
      if (cameraLobbyPanel && !cameraLobbyPanel.classList.contains('hidden')) {
        populateCameraLobby();
      }
    } else {
      setTimeout(() => {
        attachParticipantTracks(participant);
        resubscribeParticipantTracks(participant);
        if (cameraLobbyPanel && !cameraLobbyPanel.classList.contains('hidden')) {
          populateCameraLobby();
        }
      }, _trackDelay);
    }
    if (_isRoomSwitch) {
      scheduleReconcileWavesFast("participant-connected");
    } else {
      scheduleReconcileWaves("participant-connected");
    }
    // Re-broadcast own avatar so new participant receives it
    var _avatarDelay = _isRoomSwitch ? 200 : 1000;
    setTimeout(() => {
      const identityBase = getIdentityBase(room.localParticipant.identity);
      var savedAvatar = echoGet("echo-avatar-device") || echoGet("echo-avatar-" + identityBase);
      if (savedAvatar) {
        const relativePath = savedAvatar.startsWith("/") ? savedAvatar
          : savedAvatar.replace(/^https?:\/\/[^/]+/, "");
        broadcastAvatar(identityBase, relativePath);
      }
      broadcastDeviceId();
    }, _avatarDelay);
  });
  if (LK.RoomEvent?.ParticipantNameChanged) {
    newRoom.on(LK.RoomEvent.ParticipantNameChanged, (participant) => {
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
  newRoom.on(LK.RoomEvent.ParticipantDisconnected, (participant) => {
    const key = participant.identity;
    debugLog(`participant disconnected ${participant.identity} (reconnecting=${_isReconnecting})`);

    // Always use a grace period for participant disconnects.
    // Participants may briefly disconnect and rejoin (e.g. when stopping/starting
    // screen share triggers a full SDP renegotiation through the signaling proxy).
    // The ParticipantConnected handler cancels this timer if they come back.
    var graceMs = _isReconnecting ? 5000 : 8000;
    debugLog(`[reconnect] delaying disconnect cleanup for ${key} (${graceMs}ms grace period)`);
    if (_pendingDisconnects.has(key)) {
      clearTimeout(_pendingDisconnects.get(key));
    }
    const timer = setTimeout(() => {
      _pendingDisconnects.delete(key);
      debugLog(`[reconnect] grace period expired for ${key} — cleaning up`);
      const cardRef = participantCards.get(key);
      if (cardRef) cardRef.card.remove();
      participantCards.delete(key);
      participantState.delete(key);
      // Check if they moved to another room or fully left
      if (!_isRoomSwitch) {
        (async function() {
          try {
            var statusList = await fetchRoomStatus(controlUrlInput.value.trim(), adminToken);
            var inAnotherRoom = false;
            if (Array.isArray(statusList)) {
              for (var i = 0; i < statusList.length; i++) {
                var r = statusList[i];
                if (r.room_id === currentRoomName) continue;
                var parts = r.participants || [];
                for (var j = 0; j < parts.length; j++) {
                  if (parts[j].identity === key) { inAnotherRoom = true; break; }
                }
                if (inAnotherRoom) break;
              }
            }
            if (inAnotherRoom) {
              playSwitchChime();
            } else {
              playChimeForParticipant(key, "exit");
          }
        } catch (e) {
          // Fallback: play leave chime if status check fails
          playChimeForParticipant(key, "exit");
        }
      })();
      } else {
        playChimeForParticipant(key, "exit");
      }
    }, graceMs);
    _pendingDisconnects.set(key, timer);
  });
  if (LK.RoomEvent?.TrackMuted) {
    newRoom.on(LK.RoomEvent.TrackMuted, (publication, participant) => {
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
    newRoom.on(LK.RoomEvent.TrackUnmuted, (publication, participant) => {
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
    newRoom.on(LK.RoomEvent.ActiveSpeakers, (speakers) => {
      activeSpeakerIds = new Set(speakers.map((p) => p.identity));
      lastActiveSpeakerEvent = performance.now();
      updateActiveSpeakerUi();
    });
  }
  if (LK.RoomEvent?.DataReceived) {
    newRoom.on(LK.RoomEvent.DataReceived, (payload, participant) => {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);
        if (!msg || !msg.type) return;
        if (msg.type === "sound-play" && msg.soundId) {
          primeSoundboardAudio();
          playSoundboardSound(msg.soundId).catch(() => {});
          // Show toast with who triggered it and what sound
          if (msg.senderName && msg.soundName) {
            showToast(msg.senderName + " played " + msg.soundName, 2500);
          } else if (msg.senderName) {
            showToast(msg.senderName + " played a sound", 2500);
          }
        } else if (msg.type === "sound-added" && msg.sound) {
          upsertSoundboardSound(msg.sound);
        } else if (msg.type === "sound-updated" && msg.sound) {
          upsertSoundboardSound(msg.sound);
        } else if (msg.type === "request-reshare") {
          // Ignore remote re-share requests to avoid repeated user prompts.
          // We handle black frames locally via resubscribe + keyframe.
        } else if (msg.type === CHAT_MESSAGE_TYPE || msg.type === CHAT_FILE_TYPE) {
          handleIncomingChatData(payload, participant);
        } else if (msg.type === "chat-delete" && msg.id) {
          var delIdx = chatHistory.findIndex(function(m) { return m.id === msg.id; });
          if (delIdx !== -1) chatHistory.splice(delIdx, 1);
          var delEl = chatMessages?.querySelector('[data-msg-id="' + CSS.escape(msg.id) + '"]');
          if (delEl) delEl.remove();
        } else if (msg.type === "jam-started" && msg.host) {
          if (typeof showJamToast === "function") showJamToast(msg.host + " started a Jam Session!");
          if (typeof handleJamDataMessage === "function") handleJamDataMessage(msg);
        } else if (msg.type === "jam-stopped") {
          if (typeof showJamToast === "function") showJamToast("Jam Session ended");
          if (typeof handleJamDataMessage === "function") handleJamDataMessage(msg);
          if (typeof stopJamAudioStream === "function") stopJamAudioStream();
        } else if (msg.type === "device-id" && msg.identityBase && msg.deviceId) {
          // Map remote participant's identity to their device ID (for chime/profile lookups)
          deviceIdByIdentity.set(msg.identityBase, msg.deviceId);
          debugLog("[device-profile] mapped " + msg.identityBase + " -> " + msg.deviceId);
          // Pre-fetch their chime buffers now that we know their device ID
          fetchChimeBuffer(msg.deviceId, "enter").catch(function() {});
          fetchChimeBuffer(msg.deviceId, "exit").catch(function() {});
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
        } else if (msg.type === "bitrate-cap" && msg.version === 1 && msg.targetBitrateHigh) {
          handleBitrateCapRequest(msg, participant);
        } else if (msg.type === "bitrate-cap-ack" && msg.version === 1) {
          debugLog("[bitrate-ctrl] " + (msg.identity || "?") + " ack'd cap: " +
            Math.round((msg.appliedBitrateHigh || 0) / 1000) + "kbps");
          // Mark ack received on the controller for this publisher
          var ackCtrl = _pubBitrateControl.get(msg.identity);
          if (ackCtrl) ackCtrl.ackReceived = true;
        }
      } catch {
        // ignore
      }
    });
  }
  if (LK.RoomEvent?.LocalTrackPublished) {
    newRoom.on(LK.RoomEvent.LocalTrackPublished, (publication) => {
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
    newRoom.on(LK.RoomEvent.LocalTrackUnpublished, (publication) => {
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

  await newRoom.connect(sfuUrl, accessToken, {
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
  if (seq !== connectSequence) { newRoom.disconnect(); return; }

  // New room is connected — NOW disconnect old room and swap
  if (hadOldRoom && oldRoom) {
    oldRoom.disconnect();
    clearMedia();
    clearSoundboardState();
    hiddenScreens.clear();
    watchedScreens.clear();
  }
  room = newRoom;
  _connectedRoomName = currentRoomName; // Heartbeat now safe to report this room
  // Recreate local participant card immediately so it's first in the list
  ensureParticipantCard({ identity: localIdentity, name }, true);
  startMediaReconciler();
  try {
    room.startAudio?.();
  } catch {}

  // ── HIGH PRIORITY: Re-enable mic ASAP so users aren't muted after room switch ──
  // On first connect we need ensureDevicePermissions; on room switch we already have it.
  currentRoomName = roomId;
  setPublishButtonsEnabled(true);
  if (reuseAdmin && micEnabled) {
    // Room switch: mic was already on, re-enable immediately without permission dance
    micEnabled = false; // reset so toggleMicOn proceeds
    toggleMicOn().catch((err) => {
      debugLog("[mic] room-switch re-enable failed: " + (err.message || err));
    });
  } else {
    // First connect: go through full permission flow
    ensureDevicePermissions().then(() => refreshDevices()).then(() => {
      toggleMicOn().catch((err) => {
        debugLog("[mic] auto-enable failed: " + (err.message || err));
        setStatus("Mic failed to start — check permissions in System Settings", true);
      });
    }).catch((err) => {
      debugLog("[devices] post-connect device setup failed: " + (err.message || err));
    });
  }

  // ── Attach existing remote participants ──
  const remoteList = room.remoteParticipants
    ? (typeof room.remoteParticipants.forEach === "function"
        ? Array.from(room.remoteParticipants.values ? room.remoteParticipants.values() : room.remoteParticipants)
        : Array.isArray(room.remoteParticipants) ? room.remoteParticipants : [])
    : [];
  remoteList.forEach((participant) => {
    ensureParticipantCard(participant);
    attachParticipantTracks(participant);
    // Opt-in: detect existing screen shares and show "Start Watching" button
    var pubs = getParticipantPublications(participant);
    var hasScreen = pubs.some(function(pub) {
      return pub && pub.source === LK.Track.Source.ScreenShare;
    });
    if (hasScreen) {
      if (!hiddenScreens.has(participant.identity)) {
        hiddenScreens.add(participant.identity);
      }
      var cardRef = participantCards.get(participant.identity);
      if (cardRef && cardRef.watchToggleBtn) {
        cardRef.watchToggleBtn.style.display = "";
        cardRef.watchToggleBtn.textContent = "Start Watching";
        if (cardRef.ovWatchClone) { cardRef.ovWatchClone.style.display = ""; cardRef.ovWatchClone.textContent = "Start Watching"; }
      }
    }
  });
  // Retry existing participants — fast on room switch, full on first connect
  if (reuseAdmin) {
    // Room switch: single quick retry (ICE warm, tracks arrive fast)
    setTimeout(() => {
      remoteList.forEach((participant) => {
        attachParticipantTracks(participant);
        resubscribeParticipantTracks(participant);
      });
    }, 300);
  } else {
    // First connect: full retry schedule for async track loading
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
  }
  // ── Reconcile: use fast waves on room switch, full waves on first connect ──
  if (reuseAdmin) {
    scheduleReconcileWavesFast("room-switch");
  } else {
    scheduleReconcileWaves("post-connect");
  }
  startAudioMonitor();

  // ── First-connect-only UI setup (skip on room switch) ──
  if (!reuseAdmin) {
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
    stopOnlineUsersPolling();
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    disconnectTopBtn.disabled = false;
    roomListEl.classList.remove("hidden");
    connectPanel.classList.add("hidden");
    startUpdateCheckPolling();
  }

  // ── Every connect/switch: room-specific data ──
  loadSoundboardList().catch(() => {});
  loadChatHistory(roomId);
  startHeartbeat();
  startRoomStatusPolling();
  refreshRoomList(controlUrl, adminToken, roomId).catch(() => {});
  setStatus(`Connected to ${roomId}`);
  logEvent("room-join", roomId + " as " + identity);
  if (typeof startBannerPolling === "function") startBannerPolling();

  // Load own avatar from device-keyed storage and broadcast to room
  {
    const identityBase = getIdentityBase(identity);
    // Try device-keyed storage first, then fall back to old name-keyed storage (migration)
    var savedAvatar = echoGet("echo-avatar-device");
    if (!savedAvatar) {
      // Migrate from old name-based key if it exists
      savedAvatar = echoGet("echo-avatar-" + identityBase);
      if (savedAvatar) {
        echoSet("echo-avatar-device", savedAvatar);
        debugLog("[device-profile] migrated avatar from echo-avatar-" + identityBase + " to echo-avatar-device");
      }
    }
    if (savedAvatar) {
      const relativePath = savedAvatar.startsWith("/") ? savedAvatar
        : savedAvatar.replace(/^https?:\/\/[^/]+/, "");
      const resolvedAvatar = apiUrl(relativePath);
      avatarUrls.set(identityBase, resolvedAvatar);
      updateAvatarDisplay(identity);
      // Faster broadcast on room switch (already primed), slower on first connect
      var avatarDelay = reuseAdmin ? 200 : 2000;
      setTimeout(() => broadcastAvatar(identityBase, relativePath), avatarDelay);
    }
    // One-time server-side avatar migration: copy from old identityBase key to deviceId key
    if (!reuseAdmin) {
      var _deviceId = getLocalDeviceId();
      (async function() {
        try {
          // Check if avatar exists on server under deviceId
          var checkRes = await fetch(apiUrl("/api/avatar/" + encodeURIComponent(_deviceId)), { method: "HEAD" });
          if (!checkRes.ok) {
            // No avatar under deviceId — check under old identityBase
            var oldRes = await fetch(apiUrl("/api/avatar/" + encodeURIComponent(identityBase)));
            if (oldRes.ok) {
              var blob = await oldRes.blob();
              // Re-upload under deviceId
              await fetch(apiUrl("/api/avatar/upload?identity=" + encodeURIComponent(_deviceId)), {
                method: "POST",
                headers: { Authorization: "Bearer " + adminToken, "Content-Type": blob.type || "image/jpeg" },
                body: blob
              });
              // Update local storage to point to new server path
              var newPath = "/api/avatar/" + encodeURIComponent(_deviceId) + "?t=" + Date.now();
              echoSet("echo-avatar-device", newPath);
              avatarUrls.set(identityBase, apiUrl(newPath));
              updateAvatarDisplay(identity);
              broadcastAvatar(identityBase, newPath);
              debugLog("[device-profile] migrated server avatar from " + identityBase + " to " + _deviceId);
            }
          }
          // Also migrate chimes: copy from old identityBase key to deviceId key
          var kinds = ["enter", "exit"];
          for (var ci = 0; ci < kinds.length; ci++) {
            var ck = kinds[ci];
            var chimeCheck = await fetch(apiUrl("/api/chime/" + encodeURIComponent(_deviceId) + "/" + ck), { method: "HEAD" });
            if (!chimeCheck.ok) {
              var oldChime = await fetch(apiUrl("/api/chime/" + encodeURIComponent(identityBase) + "/" + ck));
              if (oldChime.ok) {
                var chimeBlob = await oldChime.blob();
                await fetch(apiUrl("/api/chime/upload?identity=" + encodeURIComponent(_deviceId) + "&kind=" + ck), {
                  method: "POST",
                  headers: { Authorization: "Bearer " + adminToken, "Content-Type": chimeBlob.type || "audio/mpeg" },
                  body: chimeBlob
                });
                debugLog("[device-profile] migrated server chime " + ck + " from " + identityBase + " to " + _deviceId);
              }
            }
          }
        } catch (e) {
          debugLog("[device-profile] server profile migration error: " + (e.message || e));
        }
      })();
    }
    // Broadcast device ID so other participants can map identity -> device for chime lookups
    var deviceIdDelay = reuseAdmin ? 100 : 1500;
    setTimeout(() => broadcastDeviceId(), deviceIdDelay);
  }

  // ── Fast room switching: prefetch tokens then pre-warm connections ──
  setTimeout(() => {
    prefetchRoomTokens().then(() => {
      setTimeout(() => prewarmRooms(), 500);
    });
  }, 1000);

  // Pre-fetch chime audio buffers for all current room participants so playback is instant
  setTimeout(() => prefetchChimeBuffersForRoom(), 500);

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
  // Clean up canvas pipeline before disconnecting
  if (window._canvasFrameWorker) {
    try { window._canvasFrameWorker.postMessage("stop"); window._canvasFrameWorker.terminate(); } catch {}
    window._canvasFrameWorker = null;
  }
  if (window._canvasRafId) { cancelAnimationFrame(window._canvasRafId); window._canvasRafId = null; }
  if (window._canvasOffVideo) { window._canvasOffVideo.pause(); window._canvasOffVideo.srcObject = null; window._canvasOffVideo = null; }
  if (window._canvasPipeEl) { window._canvasPipeEl.remove(); window._canvasPipeEl = null; }
  _screenShareVideoTrack?.mediaStreamTrack?.stop();
  _screenShareAudioTrack?.mediaStreamTrack?.stop();
  _screenShareVideoTrack = null;
  _screenShareAudioTrack = null;
  disableNoiseCancellation();
  room.disconnect();
  room = null;
  cleanupPrewarmedRooms(); // Clean up pre-warmed connections and token cache
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

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function linkifyText(text) {
  const escaped = escapeHtml(text);
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return escaped.replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
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
  if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
    // Tauri client: open on THIS user's machine via IPC
    tauriInvoke("open_external_url", { url: href }).catch(function(err) {
      debugLog("[link] tauriInvoke open_external_url failed: " + err);
    });
  } else {
    // Regular browser: just open in new tab
    window.open(href, "_blank");
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
  if (message.id) {
    messageEl.dataset.msgId = message.id;
  }

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

  // Delete button — own messages only
  if (message.identity === room?.localParticipant?.identity && message.id) {
    var deleteBtn = document.createElement("button");
    deleteBtn.className = "chat-message-delete";
    deleteBtn.textContent = "\u00D7";
    deleteBtn.title = "Delete message";
    deleteBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      deleteChatMessage(message);
    });
    messageEl.appendChild(deleteBtn);
  }

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

      imgEl.addEventListener("click", () => {
        // Open full-size image in lightbox overlay
        if (imgEl.src) openImageLightbox(imgEl.src);
      });
      messageEl.appendChild(imgEl);

      if (message.text) {
        const contentEl = document.createElement("div");
        contentEl.className = "chat-message-content";
        contentEl.innerHTML = linkifyText(message.text);
        messageEl.appendChild(contentEl);
      }
    } else if (message.fileType?.startsWith("video/")) {
      // Inline video player with download button
      const videoUrl = message.fileUrl.startsWith('http')
        ? message.fileUrl
        : `${controlUrlInput?.value || 'https://127.0.0.1:9443'}${message.fileUrl}`;
      const videoEl = document.createElement("video");
      videoEl.className = "chat-message-video";
      videoEl.controls = true;
      videoEl.preload = "metadata";
      videoEl.style.maxWidth = "100%";
      videoEl.style.maxHeight = "300px";
      videoEl.style.borderRadius = "var(--radius-sm)";
      // Fetch with auth and set blob src
      (async () => {
        try {
          const token = currentAccessToken || adminToken;
          const response = await fetch(videoUrl, {
            headers: { "Authorization": `Bearer ${token}` }
          });
          const blob = await response.blob();
          videoEl.src = URL.createObjectURL(blob);
        } catch (err) {
          debugLog(`Failed to load video: ${err.message}`);
        }
      })();
      messageEl.appendChild(videoEl);

      // Download link below video
      const dlLink = document.createElement("div");
      dlLink.className = "chat-message-file";
      dlLink.style.marginTop = "4px";
      dlLink.style.cursor = "pointer";
      dlLink.innerHTML = '<div class="chat-message-file-icon">💾</div><div class="chat-message-file-name">' + escapeHtml(message.fileName || "Video") + '</div>';
      dlLink.addEventListener("click", async () => {
        try {
          const token = currentAccessToken || adminToken;
          const dlUrl = message.fileUrl.startsWith('http') ? message.fileUrl : apiUrl(message.fileUrl);
          const response = await fetch(dlUrl, { headers: { "Authorization": `Bearer ${token}` } });
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = message.fileName || "video.mp4";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (err) {
          debugLog(`Failed to download video: ${err.message}`);
        }
      });
      messageEl.appendChild(dlLink);
    } else if (message.fileType?.startsWith("audio/")) {
      // Inline audio player
      const audioUrl = message.fileUrl.startsWith('http')
        ? message.fileUrl
        : `${controlUrlInput?.value || 'https://127.0.0.1:9443'}${message.fileUrl}`;
      const audioEl = document.createElement("audio");
      audioEl.className = "chat-message-audio";
      audioEl.controls = true;
      audioEl.preload = "metadata";
      audioEl.style.width = "100%";
      (async () => {
        try {
          const token = currentAccessToken || adminToken;
          const response = await fetch(audioUrl, {
            headers: { "Authorization": `Bearer ${token}` }
          });
          const blob = await response.blob();
          audioEl.src = URL.createObjectURL(blob);
        } catch (err) {
          debugLog(`Failed to load audio: ${err.message}`);
        }
      })();
      messageEl.appendChild(audioEl);
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

  const ts = Date.now();
  const message = {
    type: fileData ? CHAT_FILE_TYPE : CHAT_MESSAGE_TYPE,
    identity: room.localParticipant.identity,
    name: room.localParticipant.name || room.localParticipant.identity,
    text: text.trim(),
    timestamp: ts,
    room: currentRoomName,
    id: room.localParticipant.identity + "-" + ts
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

    // Guard: if user switched rooms while fetch was in-flight, discard stale result
    if (roomName !== currentRoomName) return;

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

async function deleteChatMessage(message) {
  if (!message.id || !room || !room.localParticipant) return;
  if (message.identity !== room.localParticipant.identity) return;
  // Remove from server
  try {
    var controlUrl = controlUrlInput?.value || "https://127.0.0.1:9443";
    await fetch(controlUrl + "/api/chat/delete", {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ id: message.id, identity: room.localParticipant.identity, room: currentRoomName })
    });
  } catch (err) {
    debugLog("Failed to delete chat message: " + err.message);
    return;
  }
  // Remove from local history
  var idx = chatHistory.findIndex(function(m) { return m.id === message.id; });
  if (idx !== -1) chatHistory.splice(idx, 1);
  // Remove from DOM
  var msgEl = chatMessages?.querySelector('[data-msg-id="' + CSS.escape(message.id) + '"]');
  if (msgEl) msgEl.remove();
  // Broadcast deletion to other users
  try {
    var encoder = new TextEncoder();
    room.localParticipant.publishData(
      encoder.encode(JSON.stringify({ type: "chat-delete", id: message.id, identity: room.localParticipant.identity, room: currentRoomName })),
      { reliable: true }
    );
  } catch (err) {
    debugLog("Failed to broadcast chat deletion: " + err.message);
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

// ── Adaptive publisher bitrate control — publisher-side functions ──
// Receives bitrate-cap messages from viewers and applies to local screen share sender.
function handleBitrateCapRequest(msg, participant) {
  if (!_screenShareVideoTrack?.sender) {
    debugLog("[bitrate-ctrl] ignoring cap request — not screen sharing");
    return;
  }
  var senderIdent = msg.senderIdentity || participant?.identity || "unknown";
  var capHigh = Math.max(500_000, Math.min(msg.targetBitrateHigh || BITRATE_DEFAULT_HIGH, BITRATE_DEFAULT_HIGH));
  var capMed = Math.max(300_000, Math.min(msg.targetBitrateMed || Math.round(capHigh * 0.33), BITRATE_DEFAULT_MED));
  var capLow = Math.max(200_000, Math.min(msg.targetBitrateLow || Math.round(capHigh * 0.1), BITRATE_DEFAULT_LOW));
  // Enforce layer ordering: HIGH > MED > LOW
  if (capMed >= capHigh) capMed = Math.round(capHigh * 0.6);
  if (capLow >= capMed) capLow = Math.round(capMed * 0.5);

  _bitrateCaps.set(senderIdent, {
    high: capHigh, med: capMed, low: capLow,
    timestamp: Date.now(), reason: msg.reason || "unknown"
  });
  debugLog("[bitrate-ctrl] cap from " + senderIdent + ": HIGH=" +
    Math.round(capHigh / 1000) + "kbps reason=" + (msg.reason || "?") +
    " lossRate=" + (msg.lossRate || "?"));

  // Start cleanup timer if not already running
  if (!_bitrateCapCleanupTimer) {
    _bitrateCapCleanupTimer = setInterval(cleanupAndApplyBitrateCaps, 5000);
  }
  applyMostRestrictiveCap();

  // Ack back to requester
  try {
    var ack = JSON.stringify({
      type: "bitrate-cap-ack", version: 1,
      appliedBitrateHigh: capHigh, identity: room?.localParticipant?.identity
    });
    room.localParticipant.publishData(
      new TextEncoder().encode(ack),
      { reliable: true, destinationIdentities: [senderIdent] }
    );
  } catch (e) { /* ignore ack failure */ }
}

function cleanupAndApplyBitrateCaps() {
  var now = Date.now();
  var expired = [];
  _bitrateCaps.forEach(function(cap, ident) {
    if (now - cap.timestamp > BITRATE_CAP_TTL) expired.push(ident);
  });
  expired.forEach(function(ident) {
    _bitrateCaps.delete(ident);
    debugLog("[bitrate-ctrl] cap expired from " + ident);
  });
  if (_bitrateCaps.size === 0 && _currentAppliedCap !== null) {
    debugLog("[bitrate-ctrl] all caps expired, restoring defaults");
    _currentAppliedCap = null;
    applyBitrateToSender(BITRATE_DEFAULT_HIGH, BITRATE_DEFAULT_MED, BITRATE_DEFAULT_LOW);
    clearInterval(_bitrateCapCleanupTimer);
    _bitrateCapCleanupTimer = null;
  } else if (_bitrateCaps.size > 0) {
    applyMostRestrictiveCap();
  }
}

function applyMostRestrictiveCap() {
  var minHigh = BITRATE_DEFAULT_HIGH;
  var minMed = BITRATE_DEFAULT_MED;
  var minLow = BITRATE_DEFAULT_LOW;
  _bitrateCaps.forEach(function(cap) {
    if (cap.high < minHigh) minHigh = cap.high;
    if (cap.med < minMed) minMed = cap.med;
    if (cap.low < minLow) minLow = cap.low;
  });
  if (_currentAppliedCap &&
      _currentAppliedCap.high === minHigh &&
      _currentAppliedCap.med === minMed) {
    return; // no change
  }
  _currentAppliedCap = { high: minHigh, med: minMed, low: minLow };
  applyBitrateToSender(minHigh, minMed, minLow);
}

function applyBitrateToSender(highBps, medBps, lowBps) {
  var sender = _screenShareVideoTrack?.sender;
  if (!sender) return;
  try {
    var params = sender.getParameters();
    if (!params.encodings) return;
    for (var i = 0; i < params.encodings.length; i++) {
      var enc = params.encodings[i];
      if (enc.rid === "f" || (!enc.rid && params.encodings.length === 1)) {
        enc.maxBitrate = highBps;
      } else if (enc.rid === "h") {
        enc.maxBitrate = medBps;
      } else if (enc.rid === "q") {
        enc.maxBitrate = lowBps;
      }
    }
    sender.setParameters(params).then(function() {
      debugLog("[bitrate-ctrl] applied: HIGH=" + Math.round(highBps / 1000) +
        "kbps MED=" + Math.round(medBps / 1000) + "kbps LOW=" + Math.round(lowBps / 1000) + "kbps");
      logEvent("bitrate-cap-applied", "HIGH=" + Math.round(highBps / 1000) + "kbps");
    }).catch(function(e) {
      debugLog("[bitrate-ctrl] setParameters failed: " + e.message);
    });
  } catch (e) {
    debugLog("[bitrate-ctrl] apply failed: " + e.message);
  }
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
        var chimeDeviceId = getLocalDeviceId();
        var res = await fetch(apiUrl("/api/chime/upload?identity=" + encodeURIComponent(chimeDeviceId) + "&kind=" + kind), {
          method: "POST",
          headers: { Authorization: "Bearer " + adminToken, "Content-Type": mime },
          body: file
        });
        var data = await res.json().catch(function() { return {}; });
        if (data && data.ok) {
          statusEl.textContent = file.name;
          previewBtn.classList.remove("hidden");
          removeBtn.classList.remove("hidden");
          chimeBufferCache.delete(chimeDeviceId + "-" + kind);
        } else {
          statusEl.textContent = (data && data.error) || "Upload failed";
        }
      } catch (e) {
        statusEl.textContent = "Upload error";
      }
      fileInput.value = "";
    });

    previewBtn.addEventListener("click", async function() {
      var chimeDeviceId = getLocalDeviceId();
      chimeBufferCache.delete(chimeDeviceId + "-" + kind);
      var buf = await fetchChimeBuffer(chimeDeviceId, kind);
      if (buf) playCustomChime(buf);
    });

    removeBtn.addEventListener("click", async function() {
      var chimeDeviceId = getLocalDeviceId();
      try {
        await fetch(apiUrl("/api/chime/delete"), {
          method: "POST",
          headers: { Authorization: "Bearer " + adminToken, "Content-Type": "application/json" },
          body: JSON.stringify({ identity: chimeDeviceId, kind: kind })
        });
        chimeBufferCache.delete(chimeDeviceId + "-" + kind);
        previewBtn.classList.add("hidden");
        removeBtn.classList.add("hidden");
        statusEl.textContent = "";
      } catch (e) {}
    });

    // Check if chime already exists
    (async function() {
      if (!room || !room.localParticipant) return;
      var chimeDeviceId = getLocalDeviceId();
      try {
        var res = await fetch(apiUrl("/api/chime/" + encodeURIComponent(chimeDeviceId) + "/" + kind), { method: "HEAD" });
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

  // Check for updates — query server /api/version then try Tauri auto-update
  updateBtn.addEventListener("click", async function() {
    updateBtn.disabled = true;
    updateStatus.textContent = "Checking...";
    try {
      var cUrl = controlUrlInput ? controlUrlInput.value.trim() : "";
      var currentVer = versionLabel.textContent.replace(/^Version:\s*v?/, "").split(" ")[0];
      var latestClient = "";
      if (cUrl) {
        var verResp = await fetch(cUrl + "/api/version");
        if (verResp.ok) {
          var verData = await verResp.json();
          latestClient = verData.latest_client || "";
        }
      }
      if (latestClient && currentVer && currentVer !== "browser" && currentVer !== "unknown" && currentVer !== "..." && isNewerVersion(latestClient, currentVer)) {
        updateStatus.textContent = "Update available: v" + latestClient + "!";
        // Try Tauri auto-update if available
        if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
          try {
            var result = await tauriInvoke("check_for_updates");
            if (result !== "up_to_date") {
              updateStatus.textContent = "Installing v" + latestClient + "... app will restart.";
            }
          } catch (e2) { /* auto-update unavailable */ }
        }
      } else if (currentVer && currentVer !== "browser" && currentVer !== "unknown" && currentVer !== "...") {
        updateStatus.textContent = "You're on the latest version!";
      } else {
        // Fallback for browser viewer or unknown version
        if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
          var result = await tauriInvoke("check_for_updates");
          updateStatus.textContent = result === "up_to_date" ? "You're on the latest version!" : "Installing... app will restart.";
        } else {
          updateStatus.textContent = "Version check not available in browser.";
        }
      }
    } catch (e) {
      debugLog("[updater] check failed: " + (e.message || e));
      updateStatus.textContent = "Update check failed.";
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
var bugReportFileInput = document.getElementById("bug-report-file");
var bugReportScreenshotBtn = document.getElementById("bug-report-screenshot-btn");
var bugReportFileName = document.getElementById("bug-report-file-name");
var bugReportPreview = document.getElementById("bug-report-screenshot-preview");
var _bugReportScreenshotUrl = null;

function openBugReport() {
  if (!bugReportModal) return;
  bugReportModal.classList.remove("hidden");
  if (bugReportDesc) bugReportDesc.value = "";
  if (bugReportStatusEl) bugReportStatusEl.textContent = "";
  // Reset screenshot state
  _bugReportScreenshotUrl = null;
  if (bugReportFileInput) bugReportFileInput.value = "";
  if (bugReportFileName) bugReportFileName.textContent = "";
  if (bugReportPreview) { bugReportPreview.innerHTML = ""; bugReportPreview.classList.add("hidden"); }
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
  if (_bugReportScreenshotUrl) {
    payload.screenshot_url = _bugReportScreenshotUrl;
  }
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
// Screenshot attachment for bug reports
if (bugReportScreenshotBtn && bugReportFileInput) {
  bugReportScreenshotBtn.addEventListener("click", function() {
    bugReportFileInput.click();
  });
  bugReportFileInput.addEventListener("change", async function() {
    var file = bugReportFileInput.files && bugReportFileInput.files[0];
    if (!file) return;
    if (bugReportFileName) bugReportFileName.textContent = file.name;
    // Show preview
    if (bugReportPreview) {
      var imgPreview = document.createElement("img");
      imgPreview.src = URL.createObjectURL(file);
      bugReportPreview.innerHTML = "";
      bugReportPreview.appendChild(imgPreview);
      bugReportPreview.classList.remove("hidden");
    }
    // Upload to server using chat upload endpoint
    try {
      if (bugReportStatusEl) bugReportStatusEl.textContent = "Uploading screenshot...";
      var formData = new FormData();
      formData.append("file", file);
      var uploadResp = await fetch(apiUrl("/api/chat/upload"), {
        method: "POST",
        headers: { Authorization: "Bearer " + adminToken },
        body: formData,
      });
      var uploadData = await uploadResp.json().catch(function() { return {}; });
      if (uploadData.ok && uploadData.url) {
        _bugReportScreenshotUrl = uploadData.url;
        if (bugReportStatusEl) bugReportStatusEl.textContent = "Screenshot attached.";
      } else {
        if (bugReportStatusEl) bugReportStatusEl.textContent = "Screenshot upload failed.";
      }
    } catch (e) {
      if (bugReportStatusEl) bugReportStatusEl.textContent = "Screenshot upload error: " + e.message;
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
  var roomId = currentRoomName;
  if (!roomId) return;
  fetch(apiUrl("/v1/rooms/" + encodeURIComponent(roomId) + "/kick/" + encodeURIComponent(identity)), {
    method: "POST",
    headers: { "Authorization": "Bearer " + adminToken }
  }).then(function(res) {
    if (res.ok) {
      setStatus("Kicked " + identity);
      // Remove the card immediately since they're gone
      var cardRef = participantCards.get(identity);
      if (cardRef) cardRef.card.remove();
      participantCards.delete(identity);
      participantState.delete(identity);
    } else if (res.status === 502) {
      // 502 = SFU returned error (e.g. 404 participant not found)
      setStatus(identity + " already left the room", true);
      // Clean up stale card
      var cardRef = participantCards.get(identity);
      if (cardRef) cardRef.card.remove();
      participantCards.delete(identity);
      participantState.delete(identity);
    } else {
      setStatus("Kick failed: " + res.status, true);
    }
  }).catch(function(e) {
    setStatus("Kick error: " + e.message, true);
  });
}

function adminMuteParticipant(identity) {
  var roomId = currentRoomName;
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
    fetchAdminDashboardMetrics();
    fetchAdminMetrics();
    fetchAdminBugs();
    _adminDashTimer = setInterval(function() {
      fetchAdminDashboard();
      fetchAdminMetrics();
    }, 3000);
  } else {
    panel.classList.add("hidden");
    if (_adminDashTimer) {
      clearInterval(_adminDashTimer);
      _adminDashTimer = null;
    }
  }
}

(function initAdminResize() {
  var panel = document.getElementById("admin-dash-panel");
  if (!panel) return;
  var handle = document.createElement("div");
  handle.className = "admin-dash-resize-handle";
  panel.appendChild(handle);

  var saved = localStorage.getItem("admin-panel-width");
  if (saved) panel.style.setProperty("--admin-panel-width", saved + "px");

  var dragging = false;
  handle.addEventListener("mousedown", function(e) {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", function(e) {
    if (!dragging) return;
    var w = window.innerWidth - e.clientX;
    if (w < 400) w = 400;
    if (w > window.innerWidth * 0.8) w = window.innerWidth * 0.8;
    panel.style.setProperty("--admin-panel-width", w + "px");
  });
  document.addEventListener("mouseup", function() {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    var current = panel.style.getPropertyValue("--admin-panel-width");
    if (current) localStorage.setItem("admin-panel-width", parseInt(current));
  });
})();

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
    var sv = data.server_version || "";
    var html = '<div class="adm-stat-row"><span class="adm-stat-label">Online' + (sv ? ' · v' + sv : '') + '</span><span class="adm-stat-value">' + total + '</span></div>';
    if (data.rooms && data.rooms.length > 0) {
      data.rooms.forEach(function(room) {
        var pCount = room.participants ? room.participants.length : 0;
        html += '<div class="adm-room-card"><div class="adm-room-header">' + escAdm(room.room_id) + ' <span class="adm-room-count">' + pCount + '</span></div>';
        (room.participants || []).forEach(function(p) {
          var s = p.stats || {};
          var chips = "";
          // Version badge
          var vv = p.viewer_version;
          if (!vv) {
            chips += '<span class="adm-badge adm-badge-bad">STALE</span>';
          } else if (sv && vv !== sv) {
            chips += '<span class="adm-badge adm-badge-bad">v' + escAdm(vv) + '</span>';
          } else {
            chips += '<span class="adm-badge adm-badge-ok">v' + escAdm(vv) + '</span>';
          }
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
    var lastDateKey = "";
    events.forEach(function(ev) {
      var d = new Date(ev.timestamp * 1000);
      var dateKey = d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
      if (dateKey !== lastDateKey) {
        html += '<tr class="adm-date-sep"><td colspan="5">' + dateKey + '</td></tr>';
        lastDateKey = dateKey;
      }
      var isJoin = ev.event_type === "join";
      html += '<tr><td>' + fmtTime(ev.timestamp) + '</td><td><span class="adm-badge ' + (isJoin ? 'adm-join' : 'adm-leave') + '">' + (isJoin ? 'JOIN' : 'LEAVE') + '</span></td><td>' + escAdm(ev.name || ev.identity) + '</td><td>' + escAdm(ev.room_id) + '</td><td>' + (ev.duration_secs != null ? fmtDur(ev.duration_secs) : '') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {}
}

var _admUserColors = [
  "#e8922f","#3b9dda","#49b86d","#c75dba","#d65757","#c9b83e","#6ec4c4","#8b7dd6",
  "#e06080","#40c090","#d4a030","#5c8de0","#c0604c","#50d0b0","#a070e0","#d09050",
  "#60b858","#9060c0","#e07898","#44b8c8","#b8a040","#7088d8","#c87858","#48c868",
  "#b860a8","#e0a870","#58a0d0","#a0c048","#d870a0","#60d0a0"
];
function _admUserColor(name) {
  var hash = 5381;
  for (var i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  return _admUserColors[hash % _admUserColors.length];
}

var _admDashboardData = null;
var _admBugData = null;
var _admSelectedUser = null;
var _admHeatmapUsers = {};

function _admSelectUser(name) {
  _admSelectedUser = (_admSelectedUser === name) ? null : name;
  renderAdminDashboard();
}

function _admHeatCellClick(e, dateKey, hour) {
  var old = document.getElementById("adm-heat-popup");
  if (old) old.remove();
  var users = (_admHeatmapUsers[dateKey] && _admHeatmapUsers[dateKey][hour]) || {};
  var names = Object.keys(users);
  if (names.length === 0) return;
  names.sort(function(a, b) { return users[b] - users[a]; });
  var dt = new Date(dateKey + "T00:00:00");
  var dayLabel = dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  var hourLabel = (hour % 12 || 12) + (hour < 12 ? "a" : "p");
  var ph = '<div class="adm-heat-popup-title">' + dayLabel + ' ' + hourLabel + '</div>';
  names.forEach(function(n) {
    ph += '<div class="adm-heat-popup-row"><span class="adm-heat-popup-dot" style="background:' + _admUserColor(n) + '"></span>' + escAdm(n) + '<span class="adm-heat-popup-count">' + users[n] + '</span></div>';
  });
  var popup = document.createElement("div");
  popup.id = "adm-heat-popup";
  popup.className = "adm-heat-popup";
  popup.innerHTML = ph;
  document.body.appendChild(popup);
  var rect = e.target.getBoundingClientRect();
  popup.style.top = (rect.bottom + 4) + "px";
  popup.style.left = Math.min(rect.left, window.innerWidth - 200) + "px";
  setTimeout(function() {
    document.addEventListener("click", function dismiss(ev) {
      if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener("click", dismiss); }
    });
  }, 0);
}

async function fetchAdminDashboardMetrics() {
  try {
    var res = await fetch(apiUrl("/admin/api/metrics/dashboard"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) { console.error("[admin] dashboard metrics fetch failed:", res.status); return; }
    _admDashboardData = await res.json();
    // Also fetch bug data for charts
    try {
      var bugRes = await fetch(apiUrl("/admin/api/bugs"), {
        headers: { "Authorization": "Bearer " + adminToken }
      });
      if (bugRes.ok) _admBugData = await bugRes.json();
    } catch (e2) { console.error("[admin] bug fetch error:", e2); }
    renderAdminDashboard();
  } catch (e) { console.error("[admin] fetchAdminDashboardMetrics error:", e); }
}

function renderAdminDashboard() {
  var el = document.getElementById("admin-dash-metrics");
  if (!el || !_admDashboardData) return;
  var d = _admDashboardData;
  var s = d.summary || {};
  var html = "";

  // ── Summary Cards ──
  html += '<div class="adm-cards">';
  html += '<div class="adm-card"><div class="adm-card-value">' + (s.total_sessions || 0) + '</div><div class="adm-card-label">Sessions (30d)</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (s.unique_users || 0) + '</div><div class="adm-card-label">Unique Users</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (s.total_hours || 0) + '</div><div class="adm-card-label">Total Hours</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (s.avg_duration_mins || 0) + 'm</div><div class="adm-card-label">Avg Duration</div></div>';
  html += '</div>';

  // ── User Leaderboard (clickable) ──
  var users = d.per_user || [];
  if (users.length > 0) {
    var maxCount = users[0].session_count || 1;
    html += '<div class="adm-section"><div class="adm-section-title">User Leaderboard (30d)</div>';
    users.forEach(function(u) {
      var uname = u.name || u.identity;
      var pct = Math.max(2, (u.session_count / maxCount) * 100);
      var col = _admUserColor(uname);
      var selClass = _admSelectedUser === uname ? " adm-lb-selected" : "";
      html += '<div class="adm-leaderboard-bar' + selClass + '" onclick="_admSelectUser(\'' + escAdm(uname).replace(/'/g, "\\'") + '\')"><span class="adm-leaderboard-name">' + escAdm(uname) + '</span><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + col + '"></div><span class="adm-leaderboard-count">' + u.session_count + ' (' + u.total_hours + 'h)</span></div>';
    });
    html += '</div>';
  }

  // ── Activity Heatmap (client-side timezone, per-user tracking) ──
  var heatJoins = d.heatmap_joins || [];
  if (heatJoins.length > 0) {
    var heatmap = {};
    _admHeatmapUsers = {};
    heatJoins.forEach(function(j) {
      var dt = new Date(j.timestamp * 1000);
      var dateKey = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
      var hour = dt.getHours();
      var name = j.name || "Unknown";
      if (!_admHeatmapUsers[dateKey]) _admHeatmapUsers[dateKey] = {};
      if (!_admHeatmapUsers[dateKey][hour]) _admHeatmapUsers[dateKey][hour] = {};
      _admHeatmapUsers[dateKey][hour][name] = (_admHeatmapUsers[dateKey][hour][name] || 0) + 1;
      if (!_admSelectedUser || name === _admSelectedUser) {
        if (!heatmap[dateKey]) heatmap[dateKey] = {};
        heatmap[dateKey][hour] = (heatmap[dateKey][hour] || 0) + 1;
      }
    });
    var heatDays = Object.keys(_admHeatmapUsers).sort().slice(-7);
    var heatMax = 1;
    heatDays.forEach(function(dk) {
      if (!heatmap[dk]) return;
      Object.keys(heatmap[dk]).forEach(function(h) { if (heatmap[dk][h] > heatMax) heatMax = heatmap[dk][h]; });
    });

    html += '<div class="adm-section"><div class="adm-section-title">Activity Heatmap (7d)</div>';
    if (_admSelectedUser) {
      html += '<div style="margin-bottom:8px;"><button class="adm-show-all-btn" onclick="_admSelectUser(null)">Show All</button> Filtered: <strong>' + escAdm(_admSelectedUser) + '</strong></div>';
    }
    html += '<div class="adm-chart-wrap"><div class="adm-heatmap-wrap"><div class="adm-heatmap-grid">';
    html += '<div class="adm-heatmap-label"></div>';
    for (var h = 0; h < 24; h++) {
      html += '<div class="adm-heatmap-hlabel">' + (h % 3 === 0 ? h + "" : "") + '</div>';
    }
    var selColor = _admSelectedUser ? _admUserColor(_admSelectedUser) : null;
    heatDays.forEach(function(dk) {
      var dayLabel = new Date(dk + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      html += '<div class="adm-heatmap-label">' + dayLabel + '</div>';
      for (var hr = 0; hr < 24; hr++) {
        var count = (heatmap[dk] && heatmap[dk][hr]) || 0;
        var intensity = count / heatMax;
        var bg;
        if (count === 0) {
          bg = "rgba(255,255,255,0.03)";
        } else if (selColor) {
          // Use selected user's color
          var r = parseInt(selColor.slice(1,3),16), g = parseInt(selColor.slice(3,5),16), b = parseInt(selColor.slice(5,7),16);
          bg = "rgba(" + r + "," + g + "," + b + "," + (0.2 + intensity * 0.8).toFixed(2) + ")";
        } else {
          bg = "rgba(232,146,47," + (0.2 + intensity * 0.8).toFixed(2) + ")";
        }
        html += '<div class="adm-heatmap-cell" style="background:' + bg + ';cursor:pointer" title="' + dayLabel + ' ' + hr + ':00 — ' + count + ' joins" onclick="_admHeatCellClick(event,\'' + dk + '\',' + hr + ')"></div>';
      }
    });
    html += '</div></div></div></div>';
  }

  // ── Session Timeline (today, local timezone) ──
  var tlEvents = d.timeline_events || [];
  if (tlEvents.length > 0) {
    var nowDate = new Date();
    var todayLocal = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    var todayStartTs = todayLocal.getTime() / 1000;
    var nowTs = Date.now() / 1000;
    var todayEvts = tlEvents.filter(function(e) { return e.timestamp >= todayStartTs; });
    var tlMap = {};
    var openJoins = {};
    todayEvts.sort(function(a, b) { return a.timestamp - b.timestamp; });
    todayEvts.forEach(function(ev) {
      var key = ev.name || ev.identity;
      if (ev.event_type === "join") {
        openJoins[ev.identity] = { ts: ev.timestamp, name: key };
        if (!tlMap[key]) tlMap[key] = [];
      } else if (ev.event_type === "leave") {
        var start = openJoins[ev.identity] ? openJoins[ev.identity].ts : todayStartTs;
        delete openJoins[ev.identity];
        if (!tlMap[key]) tlMap[key] = [];
        tlMap[key].push({ start: start, end: ev.timestamp });
      }
    });
    Object.keys(openJoins).forEach(function(id) {
      var oj = openJoins[id];
      if (!tlMap[oj.name]) tlMap[oj.name] = [];
      tlMap[oj.name].push({ start: oj.ts, end: nowTs });
    });
    var tlUsers = Object.keys(tlMap);
    if (tlUsers.length > 0) {
      html += '<div class="adm-section"><div class="adm-section-title">Today\'s Sessions</div><div class="adm-chart-wrap">';
      html += '<div class="adm-timeline-axis">';
      for (var th = 0; th < 24; th += 3) {
        html += '<span>' + (th === 0 ? '12a' : th < 12 ? th + 'a' : th === 12 ? '12p' : (th - 12) + 'p') + '</span>';
      }
      html += '</div>';
      tlUsers.forEach(function(uname) {
        var col = _admUserColor(uname);
        html += '<div class="adm-timeline-row"><span class="adm-timeline-name">' + escAdm(uname) + '</span><div class="adm-timeline-track">';
        (tlMap[uname] || []).forEach(function(sp) {
          var left = Math.max(0, ((sp.start - todayStartTs) / 86400) * 100);
          var width = Math.max(0.5, ((sp.end - sp.start) / 86400) * 100);
          html += '<div class="adm-timeline-span" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%;background:' + col + '"></div>';
        });
        html += '</div></div>';
      });
      html += '</div></div>';
    }
  }

  // ── Bug Reports Summary (on Metrics tab) ──
  var bugs = (_admBugData && _admBugData.reports) || [];
  if (bugs.length > 0) {
    var bugsByUser = {};
    bugs.forEach(function(b) {
      var name = b.name || b.reporter || b.identity || "Unknown";
      bugsByUser[name] = (bugsByUser[name] || 0) + 1;
    });
    var bugUserArr = Object.keys(bugsByUser).map(function(n) {
      return { name: n, count: bugsByUser[n] };
    }).sort(function(a, b) { return b.count - a.count; });
    var bugMax = bugUserArr[0].count;

    html += '<div class="adm-section"><div class="adm-section-title">Bug Reports by User</div>';
    bugUserArr.forEach(function(u) {
      var pct = (u.count / bugMax) * 100;
      html += '<div class="adm-leaderboard-bar"><div class="adm-leaderboard-name">' + escAdm(u.name) + '</div><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + _admUserColor(u.name) + '"></div><div class="adm-leaderboard-count">' + u.count + '</div></div>';
    });
    html += '</div>';

    // Bugs by Day
    var bugsByDay = {};
    bugs.forEach(function(b) {
      var dt = new Date(b.timestamp * 1000);
      var dk = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
      bugsByDay[dk] = (bugsByDay[dk] || 0) + 1;
    });
    var bugDays = Object.keys(bugsByDay).sort();
    var bugDayMax = Math.max.apply(null, bugDays.map(function(d) { return bugsByDay[d]; }));

    html += '<div class="adm-section"><div class="adm-section-title">Bugs by Day</div>';
    html += '<div class="adm-bugs-by-day">';
    bugDays.forEach(function(dk) {
      var count = bugsByDay[dk];
      var pct = (count / bugDayMax) * 100;
      var dt = new Date(dk + "T12:00:00");
      var label = dt.toLocaleDateString([], { month: "short", day: "numeric" });
      html += '<div class="adm-bug-day-col"><div class="adm-bug-day-bar" style="height:' + pct + '%" title="' + label + ': ' + count + ' bugs"></div><div class="adm-bug-day-count">' + count + '</div><div class="adm-bug-day-label">' + label + '</div></div>';
    });
    html += '</div></div>';
  }

  // Quality stats rendered below by renderAdminQuality
  html += '<div id="admin-dash-metrics-quality"></div>';
  el.innerHTML = html;
}

var _admQualityData = null;

async function fetchAdminMetrics() {
  try {
    var res = await fetch(apiUrl("/admin/api/metrics"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    _admQualityData = await res.json();
    renderAdminQuality();
  } catch (e) {}
}

function renderAdminQuality() {
  var container = document.getElementById("admin-dash-metrics-quality");
  if (!container || !_admQualityData) return;
  var users = _admQualityData.users || [];
  if (users.length === 0) {
    container.innerHTML = '<div class="adm-empty">No quality data yet</div>';
    return;
  }

  var html = '';

  // ── Quality Summary Cards ──
  var totalFps = 0, totalBitrate = 0, totalBw = 0, totalCpu = 0, n = users.length;
  users.forEach(function(u) {
    totalFps += u.avg_fps;
    totalBitrate += u.avg_bitrate_kbps;
    totalBw += u.pct_bandwidth_limited;
    totalCpu += u.pct_cpu_limited;
  });
  html += '<div class="adm-section"><div class="adm-section-title">Stream Quality Overview</div>';
  html += '<div class="adm-cards">';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalFps / n).toFixed(1) + '</div><div class="adm-card-label">Avg FPS</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalBitrate / n / 1000).toFixed(1) + '</div><div class="adm-card-label">Avg Mbps</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalBw / n).toFixed(1) + '%</div><div class="adm-card-label">BW Limited</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalCpu / n).toFixed(1) + '%</div><div class="adm-card-label">CPU Limited</div></div>';
  html += '</div></div>';

  // ── Quality Score Ranking ──
  var scored = users.map(function(u) {
    var fpsNorm = Math.min(u.avg_fps / 60, 1);
    var brNorm = Math.min(u.avg_bitrate_kbps / 15000, 1);
    var cleanPct = 1 - (u.pct_bandwidth_limited + u.pct_cpu_limited) / 100;
    if (cleanPct < 0) cleanPct = 0;
    var score = Math.round(fpsNorm * 40 + brNorm * 30 + cleanPct * 30);
    return { name: u.name || u.identity, score: score, u: u };
  }).sort(function(a, b) { return b.score - a.score; });

  html += '<div class="adm-section"><div class="adm-section-title">Quality Score Ranking</div>';
  scored.forEach(function(s) {
    var badgeClass = s.score >= 80 ? "adm-score-good" : (s.score >= 50 ? "adm-score-ok" : "adm-score-bad");
    html += '<div class="adm-leaderboard-bar" style="cursor:default"><div class="adm-leaderboard-name">' + escAdm(s.name) + '</div><div class="adm-leaderboard-fill" style="width:' + s.score + '%;background:' + _admUserColor(s.name) + '"></div><div class="adm-score-badge ' + badgeClass + '">' + s.score + '</div></div>';
  });
  html += '</div>';

  // ── Per-User FPS & Bitrate Bars ──
  var maxFps = Math.max.apply(null, users.map(function(u) { return u.avg_fps || 1; }));
  var maxBr = Math.max.apply(null, users.map(function(u) { return u.avg_bitrate_kbps || 1; }));

  html += '<div class="adm-section"><div class="adm-section-title">Per-User Quality</div>';
  html += '<div class="adm-quality-dual">';
  html += '<div class="adm-quality-col"><div class="adm-quality-col-title">Avg FPS</div>';
  users.slice().sort(function(a, b) { return b.avg_fps - a.avg_fps; }).forEach(function(u) {
    var pct = maxFps > 0 ? (u.avg_fps / maxFps) * 100 : 0;
    var name = u.name || u.identity;
    html += '<div class="adm-leaderboard-bar" style="cursor:default"><div class="adm-leaderboard-name">' + escAdm(name) + '</div><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + _admUserColor(name) + '"></div><div class="adm-leaderboard-count">' + u.avg_fps.toFixed(1) + '</div></div>';
  });
  html += '</div>';
  html += '<div class="adm-quality-col"><div class="adm-quality-col-title">Avg Bitrate (Mbps)</div>';
  users.slice().sort(function(a, b) { return b.avg_bitrate_kbps - a.avg_bitrate_kbps; }).forEach(function(u) {
    var pct = maxBr > 0 ? (u.avg_bitrate_kbps / maxBr) * 100 : 0;
    var name = u.name || u.identity;
    html += '<div class="adm-leaderboard-bar" style="cursor:default"><div class="adm-leaderboard-name">' + escAdm(name) + '</div><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + _admUserColor(name) + '"></div><div class="adm-leaderboard-count">' + (u.avg_bitrate_kbps / 1000).toFixed(1) + '</div></div>';
  });
  html += '</div></div></div>';

  // ── Quality Limitation Breakdown ──
  html += '<div class="adm-section"><div class="adm-section-title">Quality Limitations</div>';
  users.forEach(function(u) {
    var name = u.name || u.identity;
    var clean = Math.max(0, 100 - u.pct_bandwidth_limited - u.pct_cpu_limited);
    html += '<div class="adm-limit-row"><div class="adm-leaderboard-name">' + escAdm(name) + '</div>';
    html += '<div class="adm-limit-bar">';
    if (clean > 0) html += '<div class="adm-limit-seg adm-limit-clean" style="width:' + clean + '%" title="Clean: ' + clean.toFixed(1) + '%"></div>';
    if (u.pct_cpu_limited > 0) html += '<div class="adm-limit-seg adm-limit-cpu" style="width:' + u.pct_cpu_limited + '%" title="CPU: ' + u.pct_cpu_limited.toFixed(1) + '%"></div>';
    if (u.pct_bandwidth_limited > 0) html += '<div class="adm-limit-seg adm-limit-bw" style="width:' + u.pct_bandwidth_limited + '%" title="BW: ' + u.pct_bandwidth_limited.toFixed(1) + '%"></div>';
    html += '</div></div>';
  });
  html += '</div>';

  // ── Encoder & ICE Connection ──
  html += '<div class="adm-section"><div class="adm-section-title">Encoder & Connection</div>';
  html += '<table class="adm-table"><thead><tr><th>User</th><th>Encoder</th><th>Local ICE</th><th>Remote ICE</th><th>Samples</th><th>Time</th></tr></thead><tbody>';
  users.forEach(function(u) {
    var name = u.name || u.identity;
    var enc = u.encoder || "\u2014";
    var iceL = u.ice_local_type || "\u2014";
    var iceR = u.ice_remote_type || "\u2014";
    var iceClass = iceR === "relay" ? "adm-ice-relay" : (iceL === "host" ? "adm-ice-host" : "adm-ice-srflx");
    html += '<tr><td><span class="adm-heat-popup-dot" style="background:' + _admUserColor(name) + ';display:inline-block;vertical-align:middle;margin-right:4px"></span>' + escAdm(name) + '</td>';
    html += '<td><span class="adm-enc-badge">' + escAdm(enc) + '</span></td>';
    html += '<td>' + escAdm(iceL) + '</td>';
    html += '<td><span class="' + iceClass + '">' + escAdm(iceR) + '</span></td>';
    html += '<td>' + u.sample_count + '</td>';
    html += '<td>' + u.total_minutes.toFixed(1) + 'm</td></tr>';
  });
  html += '</tbody></table></div>';

  container.innerHTML = html;
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
      html += '<div class="adm-bug"><div class="adm-bug-header"><strong>' + escAdm(r.name || r.identity) + '</strong><span class="adm-time">' + fmtTime(r.timestamp) + '</span></div><div class="adm-bug-desc">' + escAdm(r.description) + '</div></div>';
    });
    el.innerHTML = html;
  } catch (e) {}
}
