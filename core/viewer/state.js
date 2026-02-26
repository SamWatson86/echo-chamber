/* =========================================================
   STATE — Shared state variables and DOM references
   Loaded BEFORE all other viewer scripts.
   ========================================================= */

// ── DOM element references ──
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

// ── Chat DOM refs ──
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

// ── Theme refs & keys ──
const openThemeButton = document.getElementById("open-theme");
const closeThemeButton = document.getElementById("close-theme");
const themePanel = document.getElementById("theme-panel");
const THEME_STORAGE_KEY = "echo-core-theme";
const uiOpacitySlider = document.getElementById("ui-opacity-slider");
const uiOpacityValue = document.getElementById("ui-opacity-value");
const UI_OPACITY_KEY = "echo-core-ui-opacity";

// ── URL / identity inputs & keys ──
const controlUrlInput = document.getElementById("control-url");
const sfuUrlInput = document.getElementById("sfu-url");
const roomInput = document.getElementById("room");
const identityInput = document.getElementById("identity");
const nameInput = document.getElementById("name");
const passwordInput = document.getElementById("admin-password");
const REMEMBER_NAME_KEY = "echo-core-remember-name";
const REMEMBER_PASS_KEY = "echo-core-remember-pass";

// ── Media & room state ──
let room = null;
let micEnabled = false;
let camEnabled = false;
let screenEnabled = false;
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
let _connectedRoomName = "main"; // Only updated after SFU connection succeeds — used by heartbeat
let currentAccessToken = "";
const roomSwitchState = (window.EchoRoomSwitchState && window.EchoRoomSwitchState.createRoomSwitchState)
  ? window.EchoRoomSwitchState.createRoomSwitchState({ initialRoomName: currentRoomName, cooldownMs: 500 })
  : null;
const publishStateReconcile = (window.EchoPublishStateReconcile && window.EchoPublishStateReconcile.reconcilePublishIndicators)
  ? window.EchoPublishStateReconcile.reconcilePublishIndicators
  : null;
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

// ── Chat state ──
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

// ── Soundboard state ──
const soundboardSounds = new Map();
let soundboardSelectedIcon = null;
let soundboardLoadedRoomId = null;
let soundboardEditingId = null;
let soundboardContext = null;
let soundboardMasterGain = null;
let soundboardCurrentSource = null;
const soundboardBufferCache = new Map();
let soundboardDragId = null;

// ── Viewer version (extracted from our own ?v= cache-busting param) ──
var _viewerVersion = (function() {
  try {
    var scripts = document.querySelectorAll('script[src*="state.js"]');
    for (var i = 0; i < scripts.length; i++) {
      var m = scripts[i].src.match(/[?&]v=([^&]+)/);
      if (m) return m[1];
    }
  } catch(e) {}
  return null;
})();

// ── Debug panel refs ──
const debugPanel = document.getElementById("debug-panel");
const debugToggleBtn = document.getElementById("debug-toggle");
const debugCloseBtn = document.getElementById("debug-close");
const debugClearBtn = document.getElementById("debug-clear");
const debugCopyBtn = document.getElementById("debug-copy");
const debugLogEl = document.getElementById("debug-log");
const debugLines = [];
