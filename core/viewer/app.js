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
const soundboardPanel = document.getElementById("soundboard");
const toggleSoundboardVolumeButton = document.getElementById("toggle-soundboard-volume");
const soundboardVolumePanel = document.getElementById("soundboard-volume-panel");
const soundboardVolumeInput = document.getElementById("soundboard-volume");
const soundboardVolumeValue = document.getElementById("soundboard-volume-value");
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
let currentRoomName = "main";
let currentAccessToken = "";
const IDENTITY_SUFFIX_KEY = "echo-core-identity-suffix";
let audioMonitorTimer = null;
let roomAudioMuted = false;
let localScreenTrackSid = "";
let screenRestarting = false;
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
const chatHistory = [];
let chatDataChannel = null;
const CHAT_MESSAGE_TYPE = "chat-message";
const CHAT_FILE_TYPE = "chat-file";
const FIXED_ROOMS = ["main", "breakout-1", "breakout-2", "breakout-3"];
const ROOM_DISPLAY_NAMES = { "main": "Main", "breakout-1": "Breakout 1", "breakout-2": "Breakout 2", "breakout-3": "Breakout 3" };
let roomStatusTimer = null;
let heartbeatTimer = null;
let previousRoomParticipants = {};
let unreadChatCount = 0;
const chatBadge = document.getElementById("chat-badge");

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

if (nameInput) {
  const savedName = safeStorageGet(REMEMBER_NAME_KEY);
  if (savedName) nameInput.value = savedName;
}
if (passwordInput) {
  const savedPass = safeStorageGet(REMEMBER_PASS_KEY);
  if (savedPass) passwordInput.value = savedPass;
}

const soundboardSounds = new Map();
let soundboardSelectedIcon = null;
let soundboardLoadedRoomId = null;
let soundboardEditingId = null;
let soundboardUserVolume = Number(localStorage.getItem("echo-core-soundboard-volume") ?? "100");
if (!Number.isFinite(soundboardUserVolume)) soundboardUserVolume = 100;
soundboardUserVolume = Math.min(100, Math.max(0, soundboardUserVolume));
let soundboardClipVolume = Number(localStorage.getItem("echo-core-soundboard-clip-volume") ?? "100");
if (!Number.isFinite(soundboardClipVolume)) soundboardClipVolume = 100;
soundboardClipVolume = Math.min(200, Math.max(0, soundboardClipVolume));
let soundboardContext = null;
let soundboardMasterGain = null;
let soundboardCurrentSource = null;
const soundboardBufferCache = new Map();
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
  const existing = sessionStorage.getItem(IDENTITY_SUFFIX_KEY);
  if (existing) return existing;
  const fresh = `${Math.floor(Math.random() * 9000 + 1000)}`;
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

function getScreenShareCaptureOptions() {
  return {
    audio: true,
    resolution: { width: 1920, height: 1080 },
    frameRate: 60,
    surfaceSwitching: "exclude",
    selfBrowserSurface: "exclude",
    preferCurrentTab: false
  };
}

function getScreenSharePublishOptions() {
  return {
    videoEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
    simulcast: false,
  };
}

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
}

function setDefaultUrls() {
  if (!controlUrlInput.value) {
    controlUrlInput.value = `${window.location.protocol}//${window.location.host}`;
  }
  if (!sfuUrlInput.value) {
    if (window.location.protocol === "https:") {
      sfuUrlInput.value = `wss://${window.location.host}`;
    } else {
      sfuUrlInput.value = `ws://${window.location.hostname}:7880`;
    }
  }
}

function normalizeUrls() {
  if (window.location.protocol !== "https:") return;
  if (!controlUrlInput.value) {
    controlUrlInput.value = `https://${window.location.host}`;
  }
  if (!sfuUrlInput.value) {
    sfuUrlInput.value = `wss://${window.location.host}`;
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

function detectRoomChanges(statusMap) {
  const currentIds = {};
  FIXED_ROOMS.forEach((roomId) => {
    currentIds[roomId] = new Set((statusMap[roomId] || []).map((p) => p.identity));
  });
  const myIdentity = identityInput ? identityInput.value : "";
  const myRoom = currentRoomName;
  // Build flat lookup: identity -> room for previous and current
  const prevByUser = {};
  const currByUser = {};
  FIXED_ROOMS.forEach((roomId) => {
    (previousRoomParticipants[roomId] || new Set()).forEach((id) => { prevByUser[id] = roomId; });
    currentIds[roomId].forEach((id) => { currByUser[id] = roomId; });
  });
  // Perspective-based: only care about people entering/leaving MY room
  let someoneEnteredMyRoom = false;
  let someoneSwitchedAway = false;
  let someoneLeftEntirely = false;
  const prevMyRoom = previousRoomParticipants[myRoom] || new Set();
  const currMyRoom = currentIds[myRoom] || new Set();
  // Someone appeared in my room (join or switch — either way, welcome them)
  for (const id of currMyRoom) {
    if (id === myIdentity) continue;
    if (!prevMyRoom.has(id)) someoneEnteredMyRoom = true;
  }
  // Someone disappeared from my room
  for (const id of prevMyRoom) {
    if (id === myIdentity) continue;
    if (!currMyRoom.has(id)) {
      if (currByUser[id]) someoneSwitchedAway = true;
      else someoneLeftEntirely = true;
    }
  }
  previousRoomParticipants = currentIds;
  if (someoneEnteredMyRoom) playJoinChime();
  else if (someoneSwitchedAway) playSwitchChime();
  else if (someoneLeftEntirely) playLeaveChime();
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
    identity: identity || ""
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
  let attempts = 0;
  const check = () => {
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
    screenRow
  });
  participantState.set(key, state);
  debugLog(`participant card created and added to DOM for ${key}, card.isConnected=${card.isConnected}, avatar exists=${!!avatar}`);
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
  avatar.innerHTML = "";
  if (track) {
    const element = createLockedVideoElement(track);
    configureVideoElement(element, true);
    startBasicVideoMonitor(element);
    avatar.appendChild(element);
    debugLog(`video attached to avatar for track ${track.sid || 'unknown'}`);
  } else {
    avatar.textContent = getInitials(cardRef.card.querySelector(".user-name")?.textContent || "");
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
        // Consider it displayed ONLY if video exists, is connected, has the right track, AND is actually playing
        // If video is paused (autoplay failed), we need to retry
        isActuallyDisplayed = !!(videoEl && videoEl.isConnected && videoEl._lkTrack === track && !videoEl.paused && videoEl.readyState >= 2);
      }
    }
    // For camera tracks, check if the track is actually rendering
    else if (track.kind === "video" && source === LK.Track.Source.Camera) {
      const camTrackSid = publication?.trackSid || track?.sid || null;
      if (camTrackSid && cameraVideoBySid.has(camTrackSid)) {
        const videoEl = cameraVideoBySid.get(camTrackSid);
        // Consider it displayed ONLY if video exists, is connected, has the right track, AND is actually playing
        // If video is paused (autoplay failed), we need to retry
        isActuallyDisplayed = !!(videoEl && videoEl.isConnected && videoEl._lkTrack === track && !videoEl.paused && videoEl.readyState >= 2);
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
    if (existingTile) {
      const existingVideo = existingTile.querySelector("video");
      if (existingVideo && existingVideo._lkTrack === track && existingVideo.videoWidth > 0) {
        ensureVideoPlays(track, existingVideo);
        ensureVideoSubscribed(publication, existingVideo);
        forceVideoLayer(publication, existingVideo);
        return;
      }
      replaceScreenVideoElement(existingTile, track, publication);
      if (screenTrackSid) {
        existingTile.dataset.trackSid = screenTrackSid;
        screenTileBySid.set(screenTrackSid, existingTile);
      }
      screenTileByIdentity.set(identity, existingTile);
      return;
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
    ensureVideoSubscribed(publication, element);
    if (screenTrackSid) {
      registerScreenTrack(screenTrackSid, publication, tile, participant.identity);
      scheduleScreenRecovery(screenTrackSid, publication, element);
      screenResubscribeIntent.delete(screenTrackSid);
    }
    screenTileByIdentity.set(participant.identity, tile);
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
    const element = track.attach();
    element._lkTrack = track;
    configureAudioElement(element);
    ensureAudioPlays(element);
    audioBucketEl.appendChild(element);
    if (audioSid) {
      audioElBySid.set(audioSid, element);
    }
    const state = participantState.get(participant.identity);
    if (source === LK.Track.Source.ScreenShareAudio) {
      state.screenAudioSid = getTrackSid(publication, track, `${participant.identity}-screen-audio`);
      state.screenAudioEls.add(element);
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
  micSelect.disabled = !enabled;
  camSelect.disabled = !enabled;
  speakerSelect.disabled = !enabled;
  refreshDevicesBtn.disabled = !enabled;
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
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.deviceId;
    option.textContent = item.label || `${item.kind}`;
    select.appendChild(option);
  });
}

async function ensureDevicePermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (err) {
    setDeviceStatus("Device permissions denied or blocked.", true);
    return false;
  }
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
  setSelectOptions(micSelect, mics, "Default mic");
  setSelectOptions(camSelect, cams, "Default camera");
  setSelectOptions(speakerSelect, speakers, "Default output");
  if (selectedMicId) micSelect.value = selectedMicId;
  if (selectedCamId) camSelect.value = selectedCamId;
  if (selectedSpeakerId) speakerSelect.value = selectedSpeakerId;
  if (!mics.length || !cams.length) {
    setDeviceStatus("Device names may be hidden until permissions are granted.");
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
  if (!room || !micEnabled) return;
  await room.localParticipant.setMicrophoneEnabled(true, { deviceId: selectedMicId || undefined });
}

async function switchCam(deviceId) {
  selectedCamId = deviceId || "";
  if (!room || !camEnabled) return;
  await room.localParticipant.setCameraEnabled(true, { deviceId: selectedCamId || undefined });
}

async function switchSpeaker(deviceId) {
  selectedSpeakerId = deviceId || "";
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
  if (soundboardVolumeInput) {
    soundboardVolumeInput.value = String(soundboardUserVolume);
  }
  if (soundboardVolumeValue) {
    soundboardVolumeValue.textContent = `${Math.round(soundboardUserVolume)}%`;
  }
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
  const res = await fetch(`/api/soundboard/file/${encodeURIComponent(soundId)}`, {
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

function renderSoundboard() {
  if (!soundboardGrid) return;
  const query = (soundSearchInput?.value ?? "").trim().toLowerCase();
  const sounds = Array.from(soundboardSounds.values()).filter((sound) => {
    if (soundboardLoadedRoomId && sound.roomId && sound.roomId !== soundboardLoadedRoomId) return false;
    if (!query) return true;
    const name = (sound.name || "").toLowerCase();
    return name.includes(query);
  });
  soundboardGrid.innerHTML = "";
  if (sounds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No sounds yet. Upload one below.";
    soundboardGrid.appendChild(empty);
    return;
  }
  sounds.forEach((sound) => {
    const tile = document.createElement("div");
    tile.className = "sound-tile";
    if (sound.id === soundboardEditingId) {
      tile.classList.add("is-editing");
    }
    const main = document.createElement("div");
    main.className = "sound-tile-main";
    const iconEl = document.createElement("div");
    iconEl.className = "sound-icon";
    iconEl.textContent = sound.icon || "\u{1F50A}";
    const nameEl = document.createElement("div");
    nameEl.className = "sound-name";
    nameEl.textContent = sound.name || "Sound";
    main.append(iconEl, nameEl);
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "sound-edit";
    editBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
      </svg>`;
    editBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      enterSoundboardEditMode(sound);
    });
    tile.append(main, editBtn);
    tile.addEventListener("click", () => {
      if (!room) return;
      primeSoundboardAudio();
      playSoundboardSound(sound.id).catch(() => {});
      sendSoundboardMessage({ type: "sound-play", soundId: sound.id });
    });
    soundboardGrid.appendChild(tile);
  });
}

function enterSoundboardEditMode(sound) {
  if (!sound) return;
  soundboardEditingId = sound.id;
  if (soundNameInput) soundNameInput.value = sound.name || "";
  soundboardSelectedIcon = sound.icon || "\u{1F50A}";
  renderSoundboardIconPicker();
  updateSoundClipVolumeUi(sound.volume ?? 100);
  updateSoundboardEditControls();
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
  renderSoundboard();
}

function openSoundboard() {
  if (!soundboardPanel) return;
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
  if (currentRoomName) {
    void loadSoundboardList();
  }
  renderSoundboard();
  primeSoundboardAudio();
}

function closeSoundboard() {
  if (!soundboardPanel) return;
  soundboardPanel.classList.add("hidden");
  soundboardEditingId = null;
  updateSoundboardEditControls();
  setSoundboardHint("");
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

  allParticipants.forEach(participant => {
    const tile = createCameraTile(participant);
    if (tile) {
      cameraLobbyGrid.appendChild(tile);
    }
  });
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
    const res = await fetch(`/api/soundboard/list?roomId=${encodeURIComponent(roomId)}`, {
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
    const res = await fetch(`/api/soundboard/upload?${qs.toString()}`, {
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
    const res = await fetch("/api/soundboard/update", {
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
  const LK = getLiveKitClient();
  if (!LK || !LK.Room) {
    throw new Error("LiveKit client failed to load. Please refresh and try again.");
  }
  room = new LK.Room({
    adaptiveStream: false,
    dynacast: true,
    autoSubscribe: true,
    videoCaptureDefaults: {
      resolution: { width: 1920, height: 1080, frameRate: 60 },
    },
    publishDefaults: {
      simulcast: true,
      videoCodec: "h264",
      videoEncoding: { maxBitrate: 5_000_000, maxFramerate: 60 },
      videoSimulcastLayers: [
        { width: 960, height: 540, encoding: { maxBitrate: 1_500_000, maxFramerate: 30 } },
        { width: 480, height: 270, encoding: { maxBitrate: 400_000, maxFramerate: 15 } },
      ],
      screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
      screenShareSimulcastLayers: [],
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
        if (publication.trackSid) {
          registerScreenTrack(publication.trackSid, publication, tile, room?.localParticipant?.identity || "");
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

  await room.connect(sfuUrl, accessToken, { autoSubscribe: true });
  if (seq !== connectSequence) { room.disconnect(); return; }
  startMediaReconciler();
  try {
    room.startAudio?.();
  } catch {}
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
  if (toggleRoomAudioButton) {
    toggleRoomAudioButton.disabled = false;
    setRoomAudioMutedState(false);
  }
  if (openSettingsButton) openSettingsButton.disabled = false;
  if (settingsDevicePanel && deviceActionsEl) {
    settingsDevicePanel.appendChild(deviceActionsEl);
    if (deviceStatusEl) settingsDevicePanel.appendChild(deviceStatusEl);
  }
  primeSoundboardAudio();
  initializeEmojiPicker();
  loadChatHistory(roomId);
  connectBtn.disabled = true;
  disconnectBtn.disabled = false;
  disconnectTopBtn.disabled = false;
  roomListEl.classList.remove("hidden");
  connectPanel.classList.add("hidden");
  setPublishButtonsEnabled(true);
  refreshDevices().catch(() => {});
  toggleMicOn().catch(() => {});
  startHeartbeat();
  startRoomStatusPolling();
  refreshRoomList(controlUrl, adminToken, roomId).catch(() => {});
  setStatus(`Connected to ${roomId}`);
}

async function connect() {
  // CRITICAL: Prime and MAINTAIN autoplay permission by playing a continuous silent audio loop
  // This keeps the browser's autoplay permission active indefinitely
  // This MUST happen IMMEDIATELY while we still have the user gesture from the button click
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
  if (nameInput) safeStorageSet(REMEMBER_NAME_KEY, name);
  if (passwordInput) safeStorageSet(REMEMBER_PASS_KEY, passwordInput.value);
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
  room.disconnect();
  room = null;
  clearMedia();
  clearSoundboardState();
  currentAccessToken = "";
  if (openSoundboardButton) openSoundboardButton.disabled = true;
  if (openCameraLobbyButton) openCameraLobbyButton.disabled = true;
  if (openChatButton) openChatButton.disabled = true;
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
          const response = await fetch(message.fileUrl, {
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
          const response = await fetch(message.fileUrl, {
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
  chatInput.focus();
  clearUnreadChat();
}

function closeChat() {
  if (!chatPanel) return;
  chatPanel.classList.add("hidden");
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
    renderPublishButtons();
    if (room?.localParticipant) {
      const cardRef = ensureParticipantCard(room.localParticipant, true);
      if (cardRef.controls) {
        cardRef.controls.querySelectorAll(".icon-button")[0]?.classList.toggle("is-on", micEnabled);
      }
    }
    updateActiveSpeakerUi();
  } catch (err) {
    setStatus(err.message || "Mic failed", true);
  } finally {
    micBtn.disabled = false;
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
    setStatus(err.message || "Camera failed", true);
  } finally {
    camBtn.disabled = false;
  }
}

async function toggleScreen() {
  if (!room) return;
  const desired = !screenEnabled;
  screenBtn.disabled = true;
  try {
    await room.localParticipant.setScreenShareEnabled(desired, getScreenShareCaptureOptions(), getScreenSharePublishOptions());
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
    await room.localParticipant.setScreenShareEnabled(false);
    screenEnabled = false;
    renderPublishButtons();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await room.localParticipant.setScreenShareEnabled(true, getScreenShareCaptureOptions(), getScreenSharePublishOptions());
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

if (toggleSoundboardVolumeButton && soundboardVolumePanel) {
  toggleSoundboardVolumeButton.addEventListener("click", () => {
    soundboardVolumePanel.classList.toggle("hidden");
    const isOpen = !soundboardVolumePanel.classList.contains("hidden");
    toggleSoundboardVolumeButton.setAttribute("aria-expanded", String(isOpen));
    soundboardVolumePanel.setAttribute("aria-hidden", String(!isOpen));
  });
}

if (soundboardVolumeInput) {
  soundboardVolumeInput.addEventListener("input", () => {
    const value = Number(soundboardVolumeInput.value);
    soundboardUserVolume = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
    localStorage.setItem("echo-core-soundboard-volume", String(soundboardUserVolume));
    updateSoundboardVolumeUi();
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
      localStorage.setItem("echo-core-soundboard-clip-volume", String(soundboardClipVolume));
    }
    renderSoundboard();
  });
}

if (soundFileInput) {
  soundFileInput.addEventListener("change", () => {
    updateSoundboardEditControls();
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

renderPublishButtons();
setPublishButtonsEnabled(false);
setDefaultUrls();
setRoomAudioMutedState(false);
ensureDevicePermissions().then(() => refreshDevices()).catch(() => {});

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

function applyTheme(name) {
  document.body.dataset.theme = name;
  localStorage.setItem(THEME_STORAGE_KEY, name);
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
  const saved = localStorage.getItem(THEME_STORAGE_KEY) || "frost";
  applyTheme(saved);
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
  localStorage.setItem(UI_OPACITY_KEY, clamped);
  if (uiOpacityValue) uiOpacityValue.textContent = `${clamped}%`;
  if (uiOpacitySlider && parseInt(uiOpacitySlider.value, 10) !== clamped) {
    uiOpacitySlider.value = clamped;
  }
}

// Init from saved value
applyUiOpacity(parseInt(localStorage.getItem(UI_OPACITY_KEY) || "100", 10));

if (uiOpacitySlider) {
  uiOpacitySlider.addEventListener("input", (e) => {
    applyUiOpacity(parseInt(e.target.value, 10));
  });
}
