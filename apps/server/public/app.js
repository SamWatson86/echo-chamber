const statusEl = document.getElementById("status");
const serverNameEl = document.getElementById("server-name");
const envBadge = document.getElementById("env-badge");
const roomListEl = document.getElementById("room-list");
const messageEl = document.getElementById("message");
const loginSection = document.getElementById("login");
const lobbySection = document.getElementById("lobby");
const callSection = document.getElementById("call");
const loginForm = document.getElementById("login-form");
const joinForm = document.getElementById("join-form");
const joinButton = joinForm.querySelector("button");
const passwordInput = document.getElementById("password");
const rememberPasswordInput = document.getElementById("remember-password");
const displayNameInput = document.getElementById("displayName");
const roomNameInput = document.getElementById("roomName");
const micSelect = document.getElementById("mic-select");
const cameraSelect = document.getElementById("camera-select");
const speakerSelect = document.getElementById("speaker-select");
const screenQualitySelect = document.getElementById("screen-quality");
const copyLinkButton = document.getElementById("copy-link");
const shareStatus = document.getElementById("share-status");
const screenGrid = document.getElementById("screen-grid");
const cameraGrid = document.getElementById("camera-grid");
const diagnosticsPanel = document.getElementById("diagnostics");
const diagnosticsBody = document.getElementById("diagnostics-body");
const diagnosticsToggle = document.getElementById("toggle-diagnostics");
const diagnosticsClose = document.getElementById("close-diagnostics");
const cameraLobbyPanel = document.getElementById("camera-lobby");
const cameraLobbyEmpty = document.getElementById("camera-lobby-empty");
const openCameraLobbyButton = document.getElementById("open-camera-lobby");
const closeCameraLobbyButton = document.getElementById("close-camera-lobby");
const soundboardPanel = document.getElementById("soundboard");
const openSoundboardButton = document.getElementById("open-soundboard");
const closeSoundboardButton = document.getElementById("close-soundboard");
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
const restartAppButton = document.getElementById("restart-app");
const openSettingsButton = document.getElementById("open-settings");
const closeSettingsButton = document.getElementById("close-settings");
const settingsPanel = document.getElementById("settings-panel");
const openAdminButton = document.getElementById("open-admin");
const adminPanel = document.getElementById("admin-panel");
const adminCloseButton = document.getElementById("admin-close");
const adminRefreshButton = document.getElementById("admin-refresh");
const adminPasswordInput = document.getElementById("admin-password");
const adminLoginButton = document.getElementById("admin-login-button");
const adminLoginSection = document.getElementById("admin-login");
const adminLoginHint = document.getElementById("admin-login-hint");
const adminContent = document.getElementById("admin-content");
const adminRestartButton = document.getElementById("admin-restart");
const adminLogoutButton = document.getElementById("admin-logout");
const adminUptime = document.getElementById("admin-uptime");
const adminRoomCount = document.getElementById("admin-room-count");
const adminPeerCount = document.getElementById("admin-peer-count");
const adminRoomList = document.getElementById("admin-room-list");
const adminLogsOutput = document.getElementById("admin-logs-output");
const adminRefreshLogsButton = document.getElementById("admin-refresh-logs");
const toggleRoomAudioButton = document.getElementById("toggle-room-audio");
const toggleRoomAudioLobbyButton = document.getElementById("toggle-room-audio-lobby");
const toggleMicLobbyButton = document.getElementById("toggle-mic-lobby");
const toggleCameraLobbyButton = document.getElementById("toggle-camera-lobby");
const userList = document.getElementById("user-list");
const avatarInput = document.getElementById("avatar-input");
const avatarButton = document.getElementById("avatar-button");
const toggleAllButton = document.getElementById("toggle-all");
const toggleMicButton = document.getElementById("toggle-mic");
const toggleCameraButton = document.getElementById("toggle-camera");
const toggleScreenButton = document.getElementById("toggle-screen");
const leaveRoomButton = document.getElementById("leave-room");
const createRoomButton = document.getElementById("create-room");
const localScreenVideo = document.getElementById("local-screen");
const localCameraVideo = document.getElementById("local-camera");
const localMicStatus = document.getElementById("local-mic");
const localCameraStatus = document.getElementById("local-camera-status");
const localScreenStatus = document.getElementById("local-screen-status");

const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const TRACK_TYPES = {
  MIC: "mic",
  SCREEN_AUDIO: "screenAudio",
  SCREEN: "screen",
  CAMERA: "camera",
  UNKNOWN: "unknown"
};

const ICONS = {
  mic: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10a7 7 0 0 0 14 0"></path><path d="M12 17v4"></path><path d="M8 21h8"></path></svg>`,
  camera: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="7" width="13" height="10" rx="2"></rect><path d="M15.5 9.5l6-3.5v12l-6-3.5z"></path><circle cx="9" cy="12" r="2.5"></circle></svg>`,
  screen: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8"></path><path d="M12 16v4"></path></svg>`
};

const SOUNDBOARD_ICONS_LEGACY = [
  "🥳",
  "👏",
  "😂",
  "💥",
  "🚨",
  "🎺",
  "🎉",
  "😱",
  "😤",
  "😴",
  "🤯",
  "🤔",
  "🤡",
  "💀",
  "🔥",
  "💯",
  "🧠",
  "🧨",
  "🪄",
  "🪙",
  "🍿",
  "🥞",
  "🍕",
  "🥓",
  "🫡",
  "🎮",
  "🎬",
  "🎵",
  "🔔",
  "🔊",
  "🛎️",
  "📣"
];

// Keep the icon set ASCII-safe (Unicode escapes) to avoid encoding issues on Windows.
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
  "\u{1F4A3}",
  "\u{1F52E}",
  "\u{1F5E1}\uFE0F",
  "\u{1F480}",
  "\u{1F47B}",
  "\u{1F608}",
  "\u{1F47F}",
  "\u{1F47D}",
  "\u{1F47E}",
  "\u{1F916}",
  "\u{1F44D}",
  "\u{1F44E}",
  "\u{1F44B}",
  "\u{1F648}",
  "\u{1F649}",
  "\u{1F64A}",
  "\u2705",
  "\u274C",
  "\u26D4",
  "\u{1F6AB}",
  "\u{1F6A7}",
  "\u{1F6D1}",
  "\u{1F9EF}",
  "\u{1F4AA}",
  "\u{1F3C6}",
  "\u{1F3C1}",
  "\u{1F947}",
  "\u{1F948}",
  "\u{1F949}",
  "\u{1F680}",
  "\u{1F6F0}\uFE0F",
  "\u{1F4CC}",
  "\u{1F4CE}",
  "\u{1F4E6}",
  "\u{1F4E7}",
  "\u{1F4F1}",
  "\u{1F4BB}",
  "\u{1F5A5}\uFE0F",
  "\u{1F5A8}\uFE0F",
  "\u{1F4F8}",
  "\u{1F4F9}",
  "\u{1F4FD}\uFE0F",
  "\u{1F436}",
  "\u{1F431}",
  "\u{1F981}",
  "\u{1F42F}",
  "\u{1F98A}",
  "\u{1F987}",
  "\u{1F9A5}",
  "\u{1F98D}",
  "\u{1F409}",
  "\u{1F98E}"
];

const state = {
  token: localStorage.getItem("echo-token"),
  ws: null,
  roomId: null,
  displayName: null,
  peerId: null,
  localAudioTrack: null,
  localScreenTrack: null,
  localScreenAudioTrack: null,
  localCameraTrack: null,
  iceServers: null,
  serverName: null,
  maxPeersPerRoom: null,
  makingOffer: new Map(),
  ignoreOffer: new Map(),
  isSettingRemoteAnswerPending: new Map(),
  pendingNegotiation: new Map(),
  pendingCandidates: new Map(),
  peerConnections: new Map(),
  peerSenders: new Map(),
  peerVideoEls: new Map(),
  peerAudioEls: new Map(),
  peerAudioStreams: new Map(),
  peerTrackMeta: new Map(),
  peerStreamMeta: new Map(),
  peerAudioTracks: new Map(),
  peerProfiles: new Map(),
  peerAvatarEls: new Map(),
  peerWatchButtons: new Map(),
  offerInitiator: new Map(),
  roomAudioMuted: false,
  hiddenScreenPeers: new Set(),
  peerIceRestartAt: new Map(),
  pendingIceRestart: new Set(),
  soundboardSounds: new Map(),
  localStreams: {
    mic: new MediaStream(),
    screenAudio: new MediaStream(),
    screen: new MediaStream(),
    camera: new MediaStream()
  }
};

if (!window.isSecureContext) {
  setMessage("Screen sharing requires HTTPS or localhost.", true);
}

if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
  setMessage("Screen sharing is not supported in this browser.", true);
}

let selectedMicId = localStorage.getItem("echo-mic-id") ?? "";
let selectedCameraId = localStorage.getItem("echo-camera-id") ?? "";
let selectedSpeakerId = localStorage.getItem("echo-speaker-id") ?? "";
const DESKTOP_PASSWORD_KEY = "echo-desktop-password";
const DESKTOP_AVATAR_KEY = "echo-desktop-avatar";
let localAvatarData = localStorage.getItem("echo-avatar") ?? "";
let selectedScreenQuality = localStorage.getItem("echo-screen-quality") ?? "native";
const isElectronEnv =
  typeof navigator !== "undefined" && typeof navigator.userAgent === "string" && /electron/i.test(navigator.userAgent);
const isDesktopApp = Boolean(typeof window !== "undefined" && window.echoDesktop) || isElectronEnv;
let savedPassword = localStorage.getItem("echo-password") ?? "";
if (isDesktopApp && !savedPassword) {
  savedPassword = localStorage.getItem(DESKTOP_PASSWORD_KEY) ?? "";
}
const storedRemember = localStorage.getItem("echo-remember");
let rememberPassword = storedRemember ? storedRemember === "true" : isDesktopApp;
if (storedRemember === null && isDesktopApp) {
  localStorage.setItem("echo-remember", "true");
}
if (isDesktopApp && savedPassword) {
  localStorage.setItem("echo-password", savedPassword);
  localStorage.setItem("echo-remember", "true");
  rememberPassword = true;
}
let focusedScreen = null;
let focusedCamera = null;
let activeRooms = [];
const sinkIdSupported =
  typeof HTMLMediaElement !== "undefined" && typeof HTMLMediaElement.prototype.setSinkId === "function";
let desktopOutputSupported = false;
let audioHealthInterval = null;
let diagnosticsInterval = null;
const statsHistory = new Map();
const MAX_AVATAR_LENGTH = 6_000_000;
let audioMeterInterval = null;
let audioContext = null;
let roomAudioMixer = null;
const audioActivityHoldMs = 450;
// RMS thresholds for the "active audio" highlight. Screen audio tends to be quieter than mics.
const audioActivityThresholds = {
  mic: 0.02,
  screen: 0.015
};
const audioActiveThreshold = audioActivityThresholds.mic;
const audioActivityTimestamps = new Map();
const pendingTrackMetaChecks = new Map();
const pendingAudioMetaChecks = new Map();
const pendingAudioMeta = new Map();
const PENDING_AUDIO_META_TTL_MS = 6000;
const pendingRoleMeta = new Map();
const PENDING_ROLE_META_TTL_MS = 6000;
let adminEnabled = false;
let adminToken = localStorage.getItem("echo-admin-token") ?? "";
let adminRefreshTimer = null;
let soundboardSelectedIcon = SOUNDBOARD_ICONS[0] ?? "\u{1F50A}";
let soundboardLoadedRoomId = null;
let soundboardEditingId = null;
let soundboardUserVolume = Number(localStorage.getItem("echo-soundboard-volume") ?? "100");
if (!Number.isFinite(soundboardUserVolume)) soundboardUserVolume = 100;
soundboardUserVolume = Math.min(100, Math.max(0, soundboardUserVolume));
let soundboardClipVolume = Number(localStorage.getItem("echo-soundboard-clip-volume") ?? "100");
if (!Number.isFinite(soundboardClipVolume)) soundboardClipVolume = 100;
soundboardClipVolume = Math.min(200, Math.max(0, soundboardClipVolume));
let soundboardContext = null;
let soundboardMasterGain = null;
let soundboardCurrentSource = null;
const soundboardBufferCache = new Map();

const SCREEN_QUALITY_PRESETS = {
  low: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 15, max: 20 }
  },
  medium: {
    width: { ideal: 1600 },
    height: { ideal: 900 },
    frameRate: { ideal: 20, max: 24 }
  },
  high: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 }
  },
  native: null
};

const CAMERA_CAP = {
  width: 1920,
  height: 1080,
  frameRate: 30
};

function getScreenMaxBitrateBps() {
  // Congestion control will still adapt down. This just ensures we are not the limiting factor.
  switch (selectedScreenQuality) {
    case "low":
      return 4_000_000; // 4 Mbps
    case "medium":
      return 8_000_000; // 8 Mbps
    case "high":
      return 20_000_000; // 20 Mbps
    case "native":
    default:
      return 40_000_000; // 40 Mbps
  }
}

function getCameraMaxBitrateBps() {
  return 4_000_000; // 4 Mbps @ 1080p
}

if (!localAvatarData && isDesktopApp) {
  localAvatarData = localStorage.getItem(DESKTOP_AVATAR_KEY) ?? "";
}

if (localAvatarData) {
  const normalized = normalizeAvatarData(localAvatarData);
  if (!normalized) {
    localAvatarData = "";
    localStorage.removeItem("echo-avatar");
    if (isDesktopApp) {
      localStorage.removeItem(DESKTOP_AVATAR_KEY);
    }
  } else if (normalized !== localAvatarData) {
    localAvatarData = normalized;
    localStorage.setItem("echo-avatar", localAvatarData);
    if (isDesktopApp) {
      localStorage.setItem(DESKTOP_AVATAR_KEY, localAvatarData);
    }
  }
}

function normalizeAvatarData(dataUrl) {
  if (!dataUrl) return "";
  if (dataUrl.length > MAX_AVATAR_LENGTH) {
    setMessage("Avatar is too large. Please pick a smaller image or gif.", true);
    return "";
  }
  return dataUrl;
}

function renderRoomList() {
  if (!roomListEl) return;
  roomListEl.innerHTML = "";
  if (!Array.isArray(activeRooms) || activeRooms.length === 0) {
    roomListEl.classList.add("hidden");
    return;
  }
  roomListEl.classList.remove("hidden");
  const currentRoom = state.roomId || roomNameInput.value.trim();
  activeRooms.forEach((room) => {
    if (!room || !room.id) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "room-chip";
    const count = Number.isFinite(room.count) ? room.count : 0;
    button.textContent = `${room.id} (${count})`;
    if (room.id === currentRoom) {
      button.classList.add("is-active");
    }
    button.addEventListener("click", () => {
      if (room.id === currentRoom) return;
      switchRoom(room.id);
    });
    roomListEl.appendChild(button);
  });
}

function getAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}

function getRoomAudioMixer() {
  if (roomAudioMixer) return roomAudioMixer;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  let ctx;
  try {
    ctx = getAudioContext();
  } catch {
    try {
      ctx = new AudioCtx();
    } catch {
      return null;
    }
  }

  if (!ctx || typeof ctx.createMediaStreamDestination !== "function") return null;

  let destination;
  let master;
  try {
    destination = ctx.createMediaStreamDestination();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(destination);
  } catch {
    return null;
  }

  const outputEl = document.createElement("audio");
  outputEl.autoplay = true;
  outputEl.playsInline = true;
  outputEl.setAttribute("autoplay", "");
  outputEl.setAttribute("playsinline", "");
  outputEl.style.display = "none";
  outputEl.srcObject = destination.stream;
  document.body.appendChild(outputEl);

  roomAudioMixer = {
    ctx,
    destination,
    master,
    outputEl,
    nodes: new Map()
  };

  applyOutputDevice(outputEl);
  clientLog("info", "room_audio_mixer_ready", {
    hasSinkId: sinkIdSupported,
    desktopOutputSupported,
    isDesktopApp
  });

  return roomAudioMixer;
}

function primeRoomAudioMixer() {
  const mixer = getRoomAudioMixer();
  if (!mixer) return;
  try {
    if (mixer.ctx.state === "suspended") {
      mixer.ctx.resume().catch(() => {});
    }
  } catch {
    // ignore
  }
  if (mixer.outputEl) {
    safePlay(mixer.outputEl, { kind: "audio", role: "room" });
  }
}

function connectPeerAudioToMixer(peerId, roleKey, track) {
  const mixer = getRoomAudioMixer();
  if (!mixer || !track || track.kind !== "audio") return false;
  const role = roleKey === "screen" ? "screen" : "mic";
  const key = `${peerId}:${role}`;

  const prev = mixer.nodes.get(key);
  if (prev) {
    try {
      prev.source.disconnect();
    } catch {
      // ignore
    }
    try {
      prev.gain.disconnect();
    } catch {
      // ignore
    }
    mixer.nodes.delete(key);
  }

  let stream;
  let source;
  let gain;
  try {
    stream = new MediaStream([track]);
    source = mixer.ctx.createMediaStreamSource(stream);
    gain = mixer.ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(mixer.master);
  } catch {
    return false;
  }

  mixer.nodes.set(key, { stream, source, gain, trackId: track.id, peerId, role });
  primeRoomAudioMixer();

  const audioEls = state.peerAudioEls.get(peerId);
  if (audioEls) {
    if (role === "screen") {
      if (audioEls.screen) {
        audioEls.screen.srcObject = null;
      }
      audioEls.screenPlaybackGain = gain;
      audioEls.screenPlaybackTrackId = track.id;
    } else {
      if (audioEls.mic) {
        audioEls.mic.srcObject = null;
      }
      audioEls.micPlaybackGain = gain;
      audioEls.micPlaybackTrackId = track.id;
    }
    applyPeerAudioVolume(audioEls, role);
  }

  clientLog("info", "room_audio_mixer_attach", { peerId, role, trackId: track.id });
  return true;
}

function disconnectPeerAudioFromMixer(peerId, roleKey) {
  if (!roomAudioMixer) return;
  const role = roleKey === "screen" ? "screen" : "mic";
  const key = `${peerId}:${role}`;
  const prev = roomAudioMixer.nodes.get(key);
  if (!prev) return;
  try {
    prev.source.disconnect();
  } catch {
    // ignore
  }
  try {
    prev.gain.disconnect();
  } catch {
    // ignore
  }
  roomAudioMixer.nodes.delete(key);
  const audioEls = state.peerAudioEls.get(peerId);
  if (audioEls) {
    if (role === "screen") {
      audioEls.screenPlaybackGain = null;
      audioEls.screenPlaybackTrackId = null;
    } else {
      audioEls.micPlaybackGain = null;
      audioEls.micPlaybackTrackId = null;
    }
  }
  clientLog("info", "room_audio_mixer_detach", { peerId, role, trackId: prev.trackId });
}

function ensureAudioAnalyser(peerId, role, stream, trackId) {
  if (!stream) return;
  const audioEls = state.peerAudioEls.get(peerId);
  if (!audioEls) return;
  const key = role === "screen" ? "screen" : "mic";
  const streamKey = `${key}Stream`;
  const trackKey = `${key}TrackId`;
  const analyserKey = `${key}Analyser`;
  const sourceKey = `${key}Source`;
  const gainKey = `${key}Gain`;
  const dataKey = `${key}Data`;

  if (audioEls[streamKey] === stream || (trackId && audioEls[trackKey] === trackId)) {
    return;
  }

  if (audioEls[sourceKey]) {
    try {
      audioEls[sourceKey].disconnect();
    } catch {
      // ignore
    }
  }
  if (audioEls[gainKey]) {
    try {
      audioEls[gainKey].disconnect();
    } catch {
      // ignore
    }
  }

  let ctx;
  try {
    ctx = getAudioContext();
  } catch {
    return;
  }
  let source;
  let analyser;
  let gain;
  try {
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);
  } catch {
    return;
  }

  audioEls[streamKey] = stream;
  audioEls[trackKey] = trackId ?? null;
  audioEls[sourceKey] = source;
  audioEls[analyserKey] = analyser;
  audioEls[gainKey] = gain;
  audioEls[dataKey] = new Uint8Array(analyser.fftSize);
}

function clearAudioAnalyser(peerId, role) {
  const audioEls = state.peerAudioEls.get(peerId);
  if (!audioEls) return;
  const key = role === "screen" ? "screen" : "mic";
  const streamKey = `${key}Stream`;
  const trackKey = `${key}TrackId`;
  const analyserKey = `${key}Analyser`;
  const sourceKey = `${key}Source`;
  const gainKey = `${key}Gain`;
  const dataKey = `${key}Data`;
  if (audioEls[sourceKey]) {
    try {
      audioEls[sourceKey].disconnect();
    } catch {
      // ignore
    }
  }
  if (audioEls[gainKey]) {
    try {
      audioEls[gainKey].disconnect();
    } catch {
      // ignore
    }
  }
  audioEls[streamKey] = null;
  audioEls[trackKey] = null;
  audioEls[analyserKey] = null;
  audioEls[sourceKey] = null;
  audioEls[gainKey] = null;
  audioEls[dataKey] = null;
  const label = key === "mic" ? audioEls.micLabel : audioEls.screenLabel;
  if (label) {
    label.classList.remove("is-active");
    audioActivityTimestamps.delete(label);
  }
}

function setMicMuted(peerId, isMuted) {
  const audioEls = state.peerAudioEls.get(peerId);
  if (!audioEls?.micLabel) return;
  audioEls.micLabel.classList.toggle("is-muted", isMuted);
  if (isMuted) {
    audioEls.micLabel.classList.remove("is-active");
    audioActivityTimestamps.delete(audioEls.micLabel);
  }
}

function isAnalyserActive(analyser, data, threshold) {
  if (!analyser || !data) return false;
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const value = (data[i] - 128) / 128;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / data.length);
  const limit = Number.isFinite(threshold) ? threshold : audioActiveThreshold;
  return rms > limit;
}

function updateAudioActivity() {
  const now = Date.now();
  state.peerAudioEls.forEach((audioEls) => {
    const peerId = audioEls.peerId;
    const micActive = isAnalyserActive(audioEls.micAnalyser, audioEls.micData, audioActivityThresholds.mic);
    const screenActive = isAnalyserActive(audioEls.screenAnalyser, audioEls.screenData, audioActivityThresholds.screen);
    if (micActive && audioEls.micLabel) {
      audioActivityTimestamps.set(audioEls.micLabel, now);
    }
    if (screenActive && audioEls.screenLabel) {
      audioActivityTimestamps.set(audioEls.screenLabel, now);
    }
    if (peerId) {
      setPeerSpeaking(peerId, micActive);
    }
  });

  audioActivityTimestamps.forEach((ts, label) => {
    const stillActive = now - ts <= audioActivityHoldMs;
    label.classList.toggle("is-active", stillActive);
    if (!stillActive) {
      audioActivityTimestamps.delete(label);
    }
  });
}

function setPeerSpeaking(peerId, isActive) {
  const map = state.peerVideoEls.get(peerId);
  if (!map) return;
  map.forEach((entry) => {
    if (entry.role === TRACK_TYPES.CAMERA) {
      entry.tile.classList.toggle("is-speaking", isActive);
    }
  });
}

function startAudioMeters() {
  if (audioMeterInterval) return;
  audioMeterInterval = setInterval(updateAudioActivity, 200);
}

function stopAudioMeters() {
  if (audioMeterInterval) {
    clearInterval(audioMeterInterval);
    audioMeterInterval = null;
  }
}

function sortUserCards() {
  if (!userList) return;
  const cards = Array.from(userList.querySelectorAll(".user-card"));
  cards.sort((a, b) => {
    const aId = a.dataset.peerId ?? "";
    const bId = b.dataset.peerId ?? "";
    if (aId === state.peerId) return -1;
    if (bId === state.peerId) return 1;
    const aName = (state.peerProfiles.get(aId)?.name ?? "Guest").trim();
    const bName = (state.peerProfiles.get(bId)?.name ?? "Guest").trim();
    const aGuest = !aName || aName.toLowerCase() === "guest";
    const bGuest = !bName || bName.toLowerCase() === "guest";
    if (aGuest !== bGuest) return aGuest ? 1 : -1;
    return aName.localeCompare(bName);
  });
  cards.forEach((card) => userList.appendChild(card));
}
function getAvatarPayload() {
  if (!localAvatarData) return undefined;
  const normalized = normalizeAvatarData(localAvatarData);
  if (!normalized) {
    localAvatarData = "";
    localStorage.removeItem("echo-avatar");
    if (isDesktopApp) {
      localStorage.removeItem(DESKTOP_AVATAR_KEY);
    }
    persistDesktopPrefs({ avatar: "" });
    return undefined;
  }
  if (normalized !== localAvatarData) {
    localAvatarData = normalized;
    localStorage.setItem("echo-avatar", localAvatarData);
    if (isDesktopApp) {
      localStorage.setItem(DESKTOP_AVATAR_KEY, localAvatarData);
    }
    persistDesktopPrefs({ avatar: localAvatarData });
  }
  return normalized;
}

function isPhoneDevice() {
  return /Mobi|Android|iPhone|iPod|Windows Phone/i.test(navigator.userAgent);
}

function setupScreenShareAvailability() {
  if (!toggleScreenButton) return;
  let reason = "";
  if (isPhoneDevice()) {
    reason = "Screen sharing isn't supported on phones.";
  } else if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
    reason = "Screen sharing is not supported in this browser.";
  } else if (!window.isSecureContext) {
    reason = "Screen sharing requires HTTPS or localhost.";
  }
  if (reason) {
    toggleScreenButton.classList.add("is-disabled");
    toggleScreenButton.setAttribute("aria-disabled", "true");
    toggleScreenButton.dataset.disabledReason = reason;
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.style.color = isError ? "#fca5a5" : "#94a3b8";
}

function updateAvatarButtonState() {
  if (!avatarButton) return;
  avatarButton.textContent = localAvatarData ? "Change Avatar" : "Choose Avatar";
}

function setLocalAvatarData(dataUrl) {
  const normalized = normalizeAvatarData(dataUrl);
  if (!normalized && dataUrl) {
    localAvatarData = "";
    localStorage.removeItem("echo-avatar");
    if (isDesktopApp) {
      localStorage.removeItem(DESKTOP_AVATAR_KEY);
    }
    persistDesktopPrefs({ avatar: "" });
    updateAvatarButtonState();
    if (state.peerId) {
      updatePeerAvatar(state.peerId, "");
      updatePeerProfile(state.peerId, { avatar: "" });
      if (state.displayName) {
        send({
          type: "update",
          displayName: state.displayName,
          avatar: ""
        });
      }
    }
    return;
  }
  localAvatarData = normalized;
  if (localAvatarData) {
    localStorage.setItem("echo-avatar", localAvatarData);
    if (isDesktopApp) {
      localStorage.setItem(DESKTOP_AVATAR_KEY, localAvatarData);
    }
    persistDesktopPrefs({ avatar: localAvatarData });
  } else {
    localStorage.removeItem("echo-avatar");
    if (isDesktopApp) {
      localStorage.removeItem(DESKTOP_AVATAR_KEY);
    }
    persistDesktopPrefs({ avatar: "" });
  }
  updateAvatarButtonState();
  if (state.peerId) {
    updatePeerAvatar(state.peerId, localAvatarData);
    updatePeerProfile(state.peerId, { avatar: localAvatarData });
    if (state.displayName) {
      send({
        type: "update",
        displayName: state.displayName,
        avatar: localAvatarData
      });
    }
  }
}

function show(section) {
  section.classList.remove("hidden");
}

function hide(section) {
  section.classList.add("hidden");
}

function showLogin() {
  show(loginSection);
  hide(lobbySection);
  hide(callSection);
  if (openSettingsButton) openSettingsButton.classList.add("hidden");
  if (openAdminButton) openAdminButton.classList.add("hidden");
  if (settingsPanel) settingsPanel.classList.add("hidden");
  if (adminPanel) adminPanel.classList.add("hidden");
}

function showLobby() {
  hide(loginSection);
  show(lobbySection);
  hide(callSection);
  if (openSettingsButton) openSettingsButton.classList.add("hidden");
  updateAdminButton();
  if (settingsPanel) settingsPanel.classList.add("hidden");
  if (adminPanel) adminPanel.classList.add("hidden");
}

function showCall() {
  hide(loginSection);
  hide(lobbySection);
  show(callSection);
  if (openSettingsButton) openSettingsButton.classList.remove("hidden");
  updateAdminButton();
}

function updateAdminButton() {
  if (!openAdminButton) return;
  if (adminEnabled && state.token) {
    openAdminButton.classList.remove("hidden");
  } else {
    openAdminButton.classList.add("hidden");
  }
}

function setJoinFormEnabled(enabled) {
  displayNameInput.disabled = !enabled;
  roomNameInput.disabled = !enabled;
  if (joinButton) joinButton.disabled = !enabled;
}

let shareStatusTimeout = null;
function setShareHint(text, isError = false, ttlMs = 0) {
  if (!shareStatus) return;
  shareStatus.textContent = text;
  shareStatus.classList.toggle("is-error", Boolean(isError));
  if (shareStatusTimeout) {
    clearTimeout(shareStatusTimeout);
    shareStatusTimeout = null;
  }
  if (ttlMs && ttlMs > 0) {
    shareStatusTimeout = setTimeout(() => {
      shareStatus.textContent = "";
      shareStatus.classList.remove("is-error");
      shareStatusTimeout = null;
    }, ttlMs);
  }
}

let playbackUnlockNeeded = false;
let playbackUnlockListenerAttached = false;
function markPlaybackBlocked() {
  playbackUnlockNeeded = true;
  setShareHint("Media playback is blocked by the browser. Click/tap anywhere to enable.", true);
  if (playbackUnlockListenerAttached) return;
  playbackUnlockListenerAttached = true;
  document.addEventListener(
    "pointerdown",
    () => {
      if (!playbackUnlockNeeded) return;
      playbackUnlockNeeded = false;
      // Clear our hint, but don't wipe other messages the app might show elsewhere.
      if (shareStatus?.textContent?.startsWith("Media playback is blocked")) {
        setShareHint("", false);
      }
      resumeMediaPlayback();
    },
    true
  );
}

function resumeMediaPlayback() {
  // Try to resume any blocked media elements (common on Safari/iOS when a new peer joins later).
  const elements = Array.from(document.querySelectorAll("audio,video"));
  elements.forEach((el) => {
    if (!el || typeof el.play !== "function") return;
    if (!el.srcObject) return;
    try {
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // ignore
    }
  });
  try {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }
    if (soundboardContext && soundboardContext.state === "suspended") {
      soundboardContext.resume().catch(() => {});
    }
  } catch {
    // ignore
  }
}

function isPlaybackGestureBlocked(error, message) {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError") return true;
  const text = String(message ?? "").toLowerCase();
  return text.includes("user gesture") || text.includes("notallowederror");
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  }

  try {
    // Deprecated, but still works in many desktop browsers and helps on non-secure contexts.
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

function safePlay(element, context) {
  if (!element || typeof element.play !== "function") return;
  const maybePromise = element.play();
  if (maybePromise && typeof maybePromise.catch === "function") {
    maybePromise.catch((error) => {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      if (context) {
        clientLog("warn", "media_play_failed", { ...context, message });
      }
      if (isPlaybackGestureBlocked(error, message)) {
        markPlaybackBlocked();
      }
    });
  }
}

function desktopOutputBridge() {
  if (typeof window === "undefined") return null;
  const bridge = window.echoDesktop;
  if (bridge && typeof bridge.setOutputDevice === "function") {
    return bridge;
  }
  return null;
}

function outputDeviceSupported() {
  return sinkIdSupported || desktopOutputSupported;
}

function shouldInitiateOffer(peerId) {
  return state.offerInitiator.get(peerId) !== false;
}

async function tuneVideoSender(peerId, senderKey, sender, track) {
  if (!sender || typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function") return;
  if (!track || track.kind !== "video") return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const enc = params.encodings[0] ?? {};

    if (senderKey === "screen") {
      enc.maxBitrate = getScreenMaxBitrateBps();
      // Try to keep FPS reasonable by allowing resolution to degrade first if needed.
      if (typeof params.degradationPreference === "string") {
        params.degradationPreference = "maintain-framerate";
      }
      // Some browsers ignore this for screenshare; safe to set when supported.
      if (selectedScreenQuality !== "native") {
        enc.maxFramerate = SCREEN_QUALITY_PRESETS[selectedScreenQuality]?.frameRate?.max ?? 30;
      }
    } else if (senderKey === "camera") {
      enc.maxBitrate = getCameraMaxBitrateBps();
      enc.maxFramerate = CAMERA_CAP.frameRate;
      const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
      const w = Number(settings.width ?? 0);
      const h = Number(settings.height ?? 0);
      if (w > 0 && h > 0) {
        const scale = Math.max(w / CAMERA_CAP.width, h / CAMERA_CAP.height, 1);
        if (scale > 1) {
          enc.scaleResolutionDownBy = scale;
        } else if (enc.scaleResolutionDownBy) {
          enc.scaleResolutionDownBy = 1;
        }
      }
    } else {
      return;
    }

    params.encodings[0] = enc;
    await sender.setParameters(params);
  } catch (error) {
    // Some browsers expose read-only fields in getParameters(). Try a minimal update before giving up.
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const enc = params.encodings[0] ?? {};
      if (senderKey === "screen") {
        enc.maxBitrate = getScreenMaxBitrateBps();
      } else if (senderKey === "camera") {
        enc.maxBitrate = getCameraMaxBitrateBps();
        enc.maxFramerate = CAMERA_CAP.frameRate;
      } else {
        return;
      }
      params.encodings[0] = enc;
      await sender.setParameters(params);
    } catch (inner) {
      const message = inner instanceof Error ? inner.message : String(inner ?? "unknown");
      clientLog("warn", "sender_tune_failed", { peerId, senderKey, message });
    }
  }
}

function setupOutputDeviceAvailability() {
  if (!speakerSelect) return;
  if (!outputDeviceSupported()) {
    speakerSelect.disabled = true;
    speakerSelect.innerHTML = `<option value="">System default (unsupported)</option>`;
    speakerSelect.dataset.disabledReason = "Audio output selection isn't supported in this browser.";
  }
}

async function resolveOutputDeviceSupport() {
  desktopOutputSupported = false;
  const bridge = desktopOutputBridge();
  if (bridge && typeof bridge.outputSupported === "function") {
    try {
      desktopOutputSupported = await bridge.outputSupported();
    } catch {
      desktopOutputSupported = false;
    }
  }
}

function applyOutputDevice(element) {
  if (!outputDeviceSupported()) return;
  const sinkId = selectedSpeakerId && selectedSpeakerId.length > 0 ? selectedSpeakerId : "default";
  const bridge = desktopOutputBridge();
  if (sinkIdSupported && element && typeof element.setSinkId === "function") {
    const result = element.setSinkId(sinkId);
    if (result && typeof result.catch === "function") {
      result.catch(() => {
        setMessage("Audio output selection was blocked by the browser. Try Chrome/Edge on desktop.", true);
      });
    }
    return;
  }
  if (desktopOutputSupported && bridge) {
    bridge.setOutputDevice(sinkId).catch(() => {
      setMessage("Audio output selection failed in the desktop app.", true);
    });
  }
}

function applyOutputDeviceToAll() {
  if (roomAudioMixer?.outputEl) {
    applyOutputDevice(roomAudioMixer.outputEl);
  }
  document.querySelectorAll(".user-card audio").forEach((audio) => applyOutputDevice(audio));
  void applySoundboardOutputDevice();
}

async function verifyToken() {
  if (!state.token) return false;
  try {
    const res = await fetch("/api/me", {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!res.ok) throw new Error("Invalid token");
    return true;
  } catch {
    localStorage.removeItem("echo-token");
    state.token = null;
    return false;
  }
}

async function loadConfig() {
  if (!state.token) return;
  try {
    const res = await fetch("/api/config", {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data?.iceServers)) {
      state.iceServers = data.iceServers;
    }
    if (typeof data?.serverName === "string") {
      state.serverName = data.serverName;
      serverNameEl.textContent = data.serverName;
      document.title = data.serverName;
    }
    if (typeof data?.environment === "string") {
      updateEnvBadge(data.environment);
    }
    if (typeof data?.maxPeersPerRoom === "number") {
      state.maxPeersPerRoom = data.maxPeersPerRoom;
    }
    if (typeof data?.adminEnabled === "boolean") {
      adminEnabled = data.adminEnabled;
      updateAdminButton();
    }
  } catch {
    // Ignore config errors; fallback to defaults.
  }
}

function updateEnvBadge(environment) {
  if (!envBadge) return;
  const raw = String(environment ?? "").trim();
  if (!raw) {
    envBadge.classList.add("hidden");
    envBadge.textContent = "";
    envBadge.classList.remove("is-prod", "is-dev");
    return;
  }
  const label = raw.toUpperCase();
  envBadge.textContent = label;
  envBadge.classList.remove("hidden");
  envBadge.classList.toggle("is-prod", label === "PROD" || label === "PRODUCTION");
  envBadge.classList.toggle("is-dev", label === "DEV" || label === "DEVELOPMENT");
}

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function showAdminLogin(message) {
  if (adminLoginSection) adminLoginSection.classList.remove("hidden");
  if (adminContent) adminContent.classList.add("hidden");
  if (adminRefreshButton) adminRefreshButton.classList.add("hidden");
  if (adminLoginHint) adminLoginHint.textContent = message ?? "";
}

function showAdminContent() {
  if (adminLoginSection) adminLoginSection.classList.add("hidden");
  if (adminContent) adminContent.classList.remove("hidden");
  if (adminRefreshButton) adminRefreshButton.classList.remove("hidden");
  if (adminLoginHint) adminLoginHint.textContent = "";
}

function clearAdminToken() {
  adminToken = "";
  localStorage.removeItem("echo-admin-token");
}

async function adminLogin(password) {
  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  if (!res.ok) {
    throw new Error("Admin login failed");
  }
  const data = await res.json();
  if (!data?.token) {
    throw new Error("Missing admin token");
  }
  adminToken = data.token;
  localStorage.setItem("echo-admin-token", adminToken);
}

async function fetchAdminStatus() {
  if (!adminToken) return null;
  const res = await fetch("/api/admin/status", {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      clearAdminToken();
      showAdminLogin("Admin session expired. Please unlock again.");
    }
    return null;
  }
  return res.json();
}

async function fetchAdminLogs() {
  if (!adminToken) return null;
  const res = await fetch("/api/admin/logs?lines=200", {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  if (!res.ok) return null;
  return res.json();
}

function renderAdminRooms(rooms) {
  if (!adminRoomList) return;
  adminRoomList.innerHTML = "";
  if (!Array.isArray(rooms) || rooms.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No active rooms.";
    adminRoomList.appendChild(empty);
    return;
  }
  rooms.forEach((room) => {
    const card = document.createElement("div");
    card.className = "admin-room";
    const header = document.createElement("div");
    header.className = "admin-room-header";
    const title = document.createElement("div");
    title.className = "admin-room-title";
    const strong = document.createElement("strong");
    strong.textContent = room.id;
    const count = document.createElement("span");
    count.textContent = `${room.count} peer${room.count === 1 ? "" : "s"}`;
    title.appendChild(strong);
    title.appendChild(count);
    const kickRoom = document.createElement("button");
    kickRoom.type = "button";
    kickRoom.className = "ghost";
    kickRoom.textContent = "Kick Room";
    kickRoom.addEventListener("click", async () => {
      await adminKickRoom(room.id);
    });
    header.appendChild(title);
    header.appendChild(kickRoom);
    card.appendChild(header);

    if (Array.isArray(room.peers) && room.peers.length) {
      room.peers.forEach((peer) => {
        const peerRow = document.createElement("div");
        peerRow.className = "admin-peer";
        const info = document.createElement("div");
        info.className = "admin-peer-info";
        const name = document.createElement("strong");
        name.textContent = peer.name || "Guest";
        const id = document.createElement("span");
        id.textContent = peer.id;
        info.appendChild(name);
        info.appendChild(id);
        const kick = document.createElement("button");
        kick.type = "button";
        kick.className = "ghost";
        kick.textContent = "Kick";
        kick.addEventListener("click", async () => {
          await adminKickPeer(peer.id);
        });
        peerRow.appendChild(info);
        peerRow.appendChild(kick);
        card.appendChild(peerRow);
      });
    }

    adminRoomList.appendChild(card);
  });
}

async function refreshAdmin() {
  if (!adminToken) {
    showAdminLogin(adminEnabled ? "" : "Admin mode is not configured.");
    return;
  }
  const status = await fetchAdminStatus();
  if (!status || !status.ok) return;
  if (adminUptime) adminUptime.textContent = formatUptime(status.uptimeMs);
  if (adminRoomCount) adminRoomCount.textContent = String(status.totalRooms ?? 0);
  if (adminPeerCount) adminPeerCount.textContent = String(status.totalPeers ?? 0);
  renderAdminRooms(status.rooms);
  const logs = await fetchAdminLogs();
  if (logs?.ok && adminLogsOutput) {
    adminLogsOutput.textContent = Array.isArray(logs.lines) ? logs.lines.join("\n") : "";
  }
  showAdminContent();
}

async function adminSoftRestart() {
  if (!adminToken) return;
  const res = await fetch("/api/admin/restart", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  if (!res.ok) {
    setMessage("Admin restart failed.", true);
    return;
  }
  setMessage("Server restarting. Clients will need to reconnect.");
  await refreshAdmin();
}

async function adminKickPeer(peerId) {
  if (!adminToken || !peerId) return;
  await fetch("/api/admin/kick", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ peerId })
  });
  await refreshAdmin();
}

async function adminKickRoom(roomId) {
  if (!adminToken || !roomId) return;
  await fetch("/api/admin/kick", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ roomId })
  });
  await refreshAdmin();
}

function openAdminPanel() {
  if (!adminPanel) return;
  adminPanel.classList.remove("hidden");
  if (!adminEnabled) {
    showAdminLogin("Admin mode is not configured on this server.");
    return;
  }
  if (adminToken) {
    void refreshAdmin();
  } else {
    showAdminLogin("");
  }
  if (adminRefreshTimer) {
    clearInterval(adminRefreshTimer);
  }
  adminRefreshTimer = setInterval(() => {
    void refreshAdmin();
  }, 5000);
}

function closeAdminPanel() {
  if (!adminPanel) return;
  adminPanel.classList.add("hidden");
  if (adminRefreshTimer) {
    clearInterval(adminRefreshTimer);
    adminRefreshTimer = null;
  }
}

async function login(password) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });

  if (!res.ok) {
    throw new Error("Login failed");
  }

  const data = await res.json();
  if (!data?.token) throw new Error("Missing token");
  state.token = data.token;
  localStorage.setItem("echo-token", data.token);
}

function wsUrl() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const token = encodeURIComponent(state.token ?? "");
  return `${protocol}://${location.host}/ws?token=${token}`;
}

function send(message) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
  }
}

function clientLog(level, message, meta) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    send({ type: "client-log", level, message, meta });
    return;
  }
  if (level === "error") {
    console.error(message, meta ?? "");
  } else if (level === "warn") {
    console.warn(message, meta ?? "");
  } else {
    console.info(message, meta ?? "");
  }
}

function desktopPrefsBridge() {
  if (typeof window === "undefined") return null;
  const bridge = window.echoDesktop;
  if (!bridge) return null;
  return bridge;
}

async function hydrateDesktopPrefs() {
  if (!isDesktopApp) return;
  const bridge = desktopPrefsBridge();
  if (!bridge || typeof bridge.getPrefs !== "function") return;
  try {
    const prefs = await bridge.getPrefs();
    if (prefs && typeof prefs.password === "string" && prefs.password.length > 0) {
      savedPassword = prefs.password;
      localStorage.setItem("echo-password", savedPassword);
      localStorage.setItem("echo-remember", "true");
      rememberPassword = true;
    } else if (savedPassword) {
      // Persist existing password into desktop prefs.
      if (typeof bridge.setPrefs === "function") {
        await bridge.setPrefs({ password: savedPassword });
      }
    }
    if (prefs && typeof prefs.avatar === "string" && prefs.avatar.length > 0) {
      const normalized = normalizeAvatarData(prefs.avatar);
      if (normalized) {
        localAvatarData = normalized;
        localStorage.setItem("echo-avatar", normalized);
      }
    } else if (localAvatarData) {
      if (typeof bridge.setPrefs === "function") {
        await bridge.setPrefs({ avatar: localAvatarData });
      }
    }
  } catch {
    // ignore prefs hydration failures
  }
}

function persistDesktopPrefs(updates) {
  if (!isDesktopApp) return;
  const bridge = desktopPrefsBridge();
  if (!bridge || typeof bridge.setPrefs !== "function") return;
  bridge.setPrefs(updates).catch(() => {});
}

function normalizeStreamRole(role) {
  if (!role) return "mic";
  if (role === "audio") return "mic";
  return role;
}

function getLocalStreamForRole(role) {
  const key = normalizeStreamRole(role);
  if (!state.localStreams[key]) {
    state.localStreams[key] = new MediaStream();
  }
  return state.localStreams[key];
}

function ensureStreamHasTrack(stream, track) {
  if (!stream || !track) return;
  stream.getTracks().forEach((existing) => {
    if (existing.id !== track.id) {
      stream.removeTrack(existing);
    }
  });
  if (!stream.getTrackById(track.id)) {
    stream.addTrack(track);
  }
}

function getLocalStreamIdForMediaType(mediaType) {
  if (mediaType === TRACK_TYPES.MIC) return getLocalStreamForRole("mic").id;
  if (mediaType === TRACK_TYPES.SCREEN_AUDIO) return getLocalStreamForRole("screenAudio").id;
  if (mediaType === TRACK_TYPES.SCREEN) return getLocalStreamForRole("screen").id;
  if (mediaType === TRACK_TYPES.CAMERA) return getLocalStreamForRole("camera").id;
  return null;
}

function announceTrackMeta(track, mediaType) {
  if (!track) return;
  if (state.peerId) {
    const streamId = getLocalStreamIdForMediaType(mediaType);
    setPeerTrackMeta(state.peerId, track.id, mediaType, streamId);
  }
  const streamId = getLocalStreamIdForMediaType(mediaType);
  send({ type: "track-meta", trackId: track.id, mediaType, streamId });
}

function announceTrackEnded(track, mediaType) {
  if (!track) return;
  if (state.peerId) {
    state.peerTrackMeta.get(state.peerId)?.delete(track.id);
  }
  send({ type: "track-ended", trackId: track.id, mediaType });
}

function announceCurrentTrackMeta() {
  if (state.localAudioTrack) {
    announceTrackMeta(state.localAudioTrack, TRACK_TYPES.MIC);
  }
  if (state.localScreenAudioTrack) {
    announceTrackMeta(state.localScreenAudioTrack, TRACK_TYPES.SCREEN_AUDIO);
  }
  if (state.localScreenTrack) {
    announceTrackMeta(state.localScreenTrack, TRACK_TYPES.SCREEN);
  }
  if (state.localCameraTrack) {
    announceTrackMeta(state.localCameraTrack, TRACK_TYPES.CAMERA);
  }
}

function createPeerCard(peerId, name) {
  const card = document.createElement("div");
  card.className = "user-card";
  card.dataset.peerId = peerId;

  const avatarWrap = document.createElement("div");
  avatarWrap.className = "user-avatar";

  const avatarImg = document.createElement("img");
  avatarImg.alt = `${name} avatar`;
  avatarImg.src = "";

  const avatarVideo = document.createElement("video");
  avatarVideo.autoplay = true;
  avatarVideo.playsInline = true;
  avatarVideo.muted = true;
  avatarVideo.volume = 0;
  avatarVideo.setAttribute("autoplay", "");
  avatarVideo.setAttribute("playsinline", "");
  avatarVideo.setAttribute("muted", "");

  const avatarFallback = document.createElement("div");
  avatarFallback.className = "avatar-fallback";
  avatarFallback.textContent = getInitials(name);

  avatarWrap.append(avatarImg, avatarVideo, avatarFallback);

  const infoWrap = document.createElement("div");
  infoWrap.className = "user-info";

  const title = document.createElement("div");
  title.className = "user-name";
  title.textContent = name;

  const watchButton = document.createElement("button");
  watchButton.type = "button";
  watchButton.className = "ghost watch-toggle hidden";
  watchButton.textContent = "Stop Watching";
  watchButton.addEventListener("click", () => {
    if (state.hiddenScreenPeers.has(peerId)) {
      state.hiddenScreenPeers.delete(peerId);
    } else {
      state.hiddenScreenPeers.add(peerId);
    }
    applyPeerScreenVisibility(peerId);
  });

  const titleRow = document.createElement("div");
  titleRow.className = "user-title-row";
  titleRow.append(title, watchButton);

  const audioMic = document.createElement("audio");
  audioMic.autoplay = true;
  audioMic.dataset.role = "mic";
  applyOutputDevice(audioMic);

  const audioScreen = document.createElement("audio");
  audioScreen.autoplay = true;
  audioScreen.dataset.role = "screen";
  applyOutputDevice(audioScreen);

  const volumeWrap = document.createElement("div");
  volumeWrap.className = "peer-audio-controls";

  const micRow = document.createElement("div");
  micRow.className = "peer-audio-row";
  micRow.classList.add("is-collapsed");

  const micLabel = document.createElement("button");
  micLabel.type = "button";
  micLabel.className = "peer-audio-toggle";
  micLabel.textContent = "Mic";

  const micMute = document.createElement("button");
  micMute.type = "button";
  micMute.className = "peer-audio-toggle peer-audio-mute";
  micMute.textContent = "Mute";
  micMute.addEventListener("click", () => togglePeerAudioMute(peerId, "mic"));

  const micInput = document.createElement("input");
  micInput.type = "range";
  micInput.min = "0";
  micInput.max = "100";
  micInput.value = "100";
  micInput.dataset.role = "mic";
  micInput.addEventListener("input", () => {
    const audioEls = state.peerAudioEls.get(peerId);
    if (audioEls) {
      audioEls.micPrevVolume = micInput.value;
      applyPeerAudioVolume(audioEls, "mic");
    }
    if (state.roomAudioMuted && Number(micInput.value) > 0) {
      delete card.dataset.prevVolumeMic;
    }
  });

  micLabel.addEventListener("click", () => {
    micRow.classList.toggle("is-collapsed");
  });

  const micHeader = document.createElement("div");
  micHeader.className = "peer-audio-header";
  micHeader.append(micLabel, micMute);

  micRow.append(micHeader, micInput);

  const screenRow = document.createElement("div");
  screenRow.className = "peer-audio-row";
  screenRow.classList.add("is-collapsed");

  const screenLabel = document.createElement("button");
  screenLabel.type = "button";
  screenLabel.className = "peer-audio-toggle";
  screenLabel.textContent = "Screen Audio";

  const screenMute = document.createElement("button");
  screenMute.type = "button";
  screenMute.className = "peer-audio-toggle peer-audio-mute";
  screenMute.textContent = "Mute";
  screenMute.addEventListener("click", () => togglePeerAudioMute(peerId, "screen"));

  const screenInput = document.createElement("input");
  screenInput.type = "range";
  screenInput.min = "0";
  screenInput.max = "100";
  screenInput.value = "100";
  screenInput.dataset.role = "screen";
  screenInput.addEventListener("input", () => {
    const audioEls = state.peerAudioEls.get(peerId);
    if (audioEls) {
      audioEls.screenPrevVolume = screenInput.value;
      applyPeerAudioVolume(audioEls, "screen");
    }
    if (state.roomAudioMuted && Number(screenInput.value) > 0) {
      delete card.dataset.prevVolumeScreen;
    }
  });

  screenLabel.addEventListener("click", () => {
    screenRow.classList.toggle("is-collapsed");
  });

  const screenHeader = document.createElement("div");
  screenHeader.className = "peer-audio-header";
  screenHeader.append(screenLabel, screenMute);

  screenRow.append(screenHeader, screenInput);

  volumeWrap.append(micRow, screenRow);

  infoWrap.append(titleRow, volumeWrap);
  card.append(avatarWrap, infoWrap, audioMic, audioScreen);
  if (userList) {
    userList.appendChild(card);
  }

  state.peerAudioEls.set(peerId, {
    mic: audioMic,
    screen: audioScreen,
    micVolume: micInput,
    screenVolume: screenInput,
    micLabel,
    screenLabel,
    micMuteButton: micMute,
    screenMuteButton: screenMute,
    micMutedByUser: false,
    screenMutedByUser: false,
    micPrevVolume: null,
    screenPrevVolume: null,
    peerId,
    micAnalyser: null,
    screenAnalyser: null,
    micSource: null,
    screenSource: null,
    micGain: null,
    screenGain: null,
    micPlaybackGain: null,
    screenPlaybackGain: null,
    micStream: null,
    screenStream: null,
    micTrackId: null,
    screenTrackId: null,
    micPlaybackTrackId: null,
    screenPlaybackTrackId: null,
    micData: null,
    screenData: null
  });

  if (state.roomAudioMuted) {
    if (!card.dataset.prevVolumeMic) {
      card.dataset.prevVolumeMic = micInput.value ?? "100";
    }
    if (!card.dataset.prevVolumeScreen) {
      card.dataset.prevVolumeScreen = screenInput.value ?? "100";
    }
    micInput.value = "0";
    screenInput.value = "0";
  }
  applyPeerAudioVolume(state.peerAudioEls.get(peerId), "mic");
  applyPeerAudioVolume(state.peerAudioEls.get(peerId), "screen");

  state.peerAvatarEls.set(peerId, {
    wrapper: avatarWrap,
    img: avatarImg,
    video: avatarVideo,
    fallback: avatarFallback
  });
  state.peerWatchButtons.set(peerId, watchButton);

  avatarWrap.addEventListener("click", () => {
    togglePinnedCamera(peerId);
  });
  setMicMuted(peerId, true);
  updatePeerMuteButton(state.peerAudioEls.get(peerId), "mic");
  updatePeerMuteButton(state.peerAudioEls.get(peerId), "screen");
  updateScreenWatchButton(peerId);
  sortUserCards();

  return { card, audioMic, audioScreen, title };
}

function setRoomAudioMuted(muted) {
  state.roomAudioMuted = muted;
  updateRoomAudioButtons();
  updateSoundboardMasterGain();
  if (!userList) return;
  const cards = Array.from(userList.querySelectorAll(".user-card"));
  cards.forEach((card) => {
    const peerId = card.dataset.peerId ?? "";
    const audioEls = state.peerAudioEls.get(peerId);
    if (!audioEls) return;
    const { mic: micAudio, screen: screenAudio, micVolume: micInput, screenVolume: screenInput } = audioEls;
    if (!micAudio || !screenAudio || !micInput || !screenInput) return;
    if (muted) {
      if (!card.dataset.prevVolumeMic) {
        card.dataset.prevVolumeMic = micInput.value ?? "100";
      }
      if (!card.dataset.prevVolumeScreen) {
        card.dataset.prevVolumeScreen = screenInput.value ?? "100";
      }
      micInput.value = "0";
      screenInput.value = "0";
    } else {
      if (card.dataset.prevVolumeMic !== undefined) {
        const prev = card.dataset.prevVolumeMic || "100";
        micInput.value = prev;
        delete card.dataset.prevVolumeMic;
      }
      if (card.dataset.prevVolumeScreen !== undefined) {
        const prev = card.dataset.prevVolumeScreen || "100";
        screenInput.value = prev;
        delete card.dataset.prevVolumeScreen;
      }
    }
    applyPeerAudioVolume(audioEls, "mic");
    applyPeerAudioVolume(audioEls, "screen");
  });
}

function applyPeerAudioVolume(audioEls, role) {
  if (!audioEls) return;
  const isScreen = role === "screen";
  const audioEl = isScreen ? audioEls.screen : audioEls.mic;
  const playbackGain = isScreen ? audioEls.screenPlaybackGain : audioEls.micPlaybackGain;
  const input = isScreen ? audioEls.screenVolume : audioEls.micVolume;
  if (!input) return;
  const mutedByUser = isScreen ? audioEls.screenMutedByUser : audioEls.micMutedByUser;
  const raw = Number(input.value);
  const base = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw / 100)) : 1;
  if (state.roomAudioMuted || mutedByUser) {
    if (playbackGain) {
      playbackGain.gain.value = 0;
      return;
    }
    if (audioEl) {
      audioEl.volume = 0;
    }
    return;
  }
  if (playbackGain) {
    playbackGain.gain.value = base;
    return;
  }
  if (audioEl) {
    audioEl.volume = base;
  }
}

function updatePeerMuteButton(audioEls, role) {
  if (!audioEls) return;
  const isScreen = role === "screen";
  const button = isScreen ? audioEls.screenMuteButton : audioEls.micMuteButton;
  if (!button) return;
  const muted = isScreen ? audioEls.screenMutedByUser : audioEls.micMutedByUser;
  button.textContent = muted ? "Unmute" : "Mute";
}

function togglePeerAudioMute(peerId, role) {
  const audioEls = state.peerAudioEls.get(peerId);
  if (!audioEls) return;
  if (role === "screen") {
    audioEls.screenMutedByUser = !audioEls.screenMutedByUser;
  } else {
    audioEls.micMutedByUser = !audioEls.micMutedByUser;
  }
  updatePeerMuteButton(audioEls, role);
  applyPeerAudioVolume(audioEls, role);
}

function updatePeerVideoStatus(peerId) {
  const card = getPeerCard(peerId);
  if (!card) return;
  const videos = Array.from(card.querySelectorAll("video"));
  const hasVideo = videos.some((video) => !video.classList.contains("is-hidden"));
  card.classList.toggle("has-video", hasVideo);
}

function updatePeerAvatar(peerId, avatarData) {
  const avatarEls = state.peerAvatarEls.get(peerId);
  if (!avatarEls) return;
  if (avatarData) {
    avatarEls.img.src = avatarData;
    avatarEls.wrapper.classList.add("has-avatar");
  } else {
    avatarEls.img.src = "";
    avatarEls.wrapper.classList.remove("has-avatar");
  }
}

let chimeContext = null;

function getChimeContext() {
  if (chimeContext) return chimeContext;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  chimeContext = new AudioCtx();
  return chimeContext;
}

function playChime(type) {
  const ctx = getChimeContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.connect(ctx.destination);
  const tones = type === "leave" ? [660, 520] : [520, 740];
  tones.forEach((freq, index) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now + index * 0.08);
    osc.connect(gain);
    osc.start(now + index * 0.08);
    osc.stop(now + index * 0.08 + 0.12);
  });
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
  setTimeout(() => {
    try {
      gain.disconnect();
    } catch {
      // ignore
    }
  }, 400);
}

function updatePeerProfile(peerId, { name, avatar }) {
  const profile = state.peerProfiles.get(peerId) ?? {};
  if (typeof name === "string") profile.name = name;
  if (avatar !== undefined) profile.avatar = avatar;
  state.peerProfiles.set(peerId, profile);
  if (typeof name === "string") {
    updatePeerName(peerId, name);
  }
  if (avatar !== undefined) {
    updatePeerAvatar(peerId, avatar);
  }
  sortUserCards();
}

function getPeerDisplayName(peerId) {
  return state.peerProfiles.get(peerId)?.name ?? "Guest";
}

function isLikelyScreenTrack(track) {
  if (!track) return false;
  const settings = typeof track.getSettings === "function" ? track.getSettings() : null;
  if (settings && settings.displaySurface) {
    return true;
  }
  const label = (track.label || "").toLowerCase();
  return (
    label.includes("screen") ||
    label.includes("window") ||
    label.includes("display") ||
    label.includes("monitor") ||
    label.includes("tab") ||
    label.includes("browser") ||
    label.includes("application") ||
    label.includes("share")
  );
}

function isLikelyCameraTrack(track) {
  if (!track) return false;
  const label = (track.label || "").toLowerCase();
  return label.includes("camera") || label.includes("webcam");
}

function inferVideoRole(peerId, track) {
  if (!track) return TRACK_TYPES.CAMERA;
  const meta = getPeerTrackMeta(peerId, track.id);
  if (meta === TRACK_TYPES.SCREEN || meta === TRACK_TYPES.CAMERA) {
    return meta;
  }
  const screenHint = isLikelyScreenTrack(track);
  if (screenHint) return TRACK_TYPES.SCREEN;
  const cameraHint = isLikelyCameraTrack(track);
  if (cameraHint) return TRACK_TYPES.CAMERA;
  const hasCamera = hasCameraTrack(peerId);
  const hasScreen = hasScreenTrack(peerId);
  if (hasCamera && !hasScreen) return TRACK_TYPES.SCREEN;
  if (hasScreen && !hasCamera) return TRACK_TYPES.CAMERA;
  return TRACK_TYPES.CAMERA;
}

function rememberPendingRoleMeta(peerId, mediaType, trackId) {
  if (mediaType !== TRACK_TYPES.SCREEN && mediaType !== TRACK_TYPES.CAMERA) return;
  const entry = pendingRoleMeta.get(peerId) ?? {};
  entry[mediaType] = { trackId, ts: Date.now() };
  pendingRoleMeta.set(peerId, entry);
}

function consumePendingRoleMeta(peerId, mediaType) {
  const entry = pendingRoleMeta.get(peerId);
  if (!entry) return null;
  const record = entry[mediaType];
  if (!record) return null;
  if (Date.now() - record.ts > PENDING_ROLE_META_TTL_MS) {
    delete entry[mediaType];
    return null;
  }
  delete entry[mediaType];
  return record.trackId ?? null;
}

function resolveVideoEntryForMeta(peerId, mediaType) {
  const map = state.peerVideoEls.get(peerId);
  if (!map) return null;
  const entries = Array.from(map.values()).filter((entry) => entry.track);
  if (!entries.length) return null;
  const untyped = entries.filter((entry) => !getPeerTrackMeta(peerId, entry.track.id));
  if (untyped.length === 1) return untyped[0];
  if (mediaType === TRACK_TYPES.SCREEN) {
    const screenHints = untyped.filter((entry) => isLikelyScreenTrack(entry.track));
    if (screenHints.length === 1) return screenHints[0];
  } else if (mediaType === TRACK_TYPES.CAMERA) {
    const cameraHints = untyped.filter((entry) => isLikelyCameraTrack(entry.track));
    if (cameraHints.length === 1) return cameraHints[0];
  }
  return null;
}

function scheduleTrackMetaCheck(peerId, track) {
  if (!track) return;
  const key = `${peerId}:${track.id}`;
  if (pendingTrackMetaChecks.has(key)) return;
    const timer = setTimeout(() => {
      pendingTrackMetaChecks.delete(key);
      const meta = getPeerTrackMeta(peerId, track.id);
      if (!meta) {
        clientLog("warn", "video_track_meta_missing", {
          peerId,
          trackId: track.id,
          label: track.label || ""
        });
      }
    }, 1200);
    pendingTrackMetaChecks.set(key, timer);
  }

function clearTrackMetaCheck(peerId, trackId) {
  const key = `${peerId}:${trackId}`;
  const timer = pendingTrackMetaChecks.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingTrackMetaChecks.delete(key);
  }
}

function rememberPendingAudioMeta(peerId, mediaType, trackId) {
  if (mediaType !== TRACK_TYPES.MIC && mediaType !== TRACK_TYPES.SCREEN_AUDIO) return;
  const entry = pendingAudioMeta.get(peerId) ?? {};
  entry[mediaType] = { trackId, ts: Date.now() };
  pendingAudioMeta.set(peerId, entry);
}

function consumePendingAudioMeta(peerId, mediaType, trackId) {
  const entry = pendingAudioMeta.get(peerId);
  if (!entry) return null;
  const record = entry[mediaType];
  if (!record) return null;
  if (Date.now() - record.ts > PENDING_AUDIO_META_TTL_MS) {
    delete entry[mediaType];
    return null;
  }
  if (trackId && record.trackId && record.trackId !== trackId) {
    return null;
  }
  delete entry[mediaType];
  return record.trackId ?? null;
}

function scheduleAudioMetaCheck(peerId, track) {
  if (!track) return;
  const key = `${peerId}:${track.id}`;
  if (pendingAudioMetaChecks.has(key)) return;
  const timer = setTimeout(() => {
    pendingAudioMetaChecks.delete(key);
    const trackMap = state.peerAudioTracks.get(peerId);
    const entry = trackMap?.get(track.id);
    if (!entry || entry.type !== TRACK_TYPES.UNKNOWN) return;
    if (isLikelyScreenAudioTrack(track)) {
      entry.type = TRACK_TYPES.SCREEN_AUDIO;
    } else {
      entry.type = TRACK_TYPES.MIC;
    }
    entry.guessed = true;
    const resolvedType = entry.type === TRACK_TYPES.SCREEN_AUDIO ? TRACK_TYPES.SCREEN_AUDIO : TRACK_TYPES.MIC;
    attachRemoteAudioTrack(peerId, track, resolvedType);
    clientLog("warn", "audio_track_meta_missing", {
      peerId,
      trackId: track.id
    });
  }, 900);
  pendingAudioMetaChecks.set(key, timer);
}

function clearAudioMetaCheck(peerId, trackId) {
  const key = `${peerId}:${trackId}`;
  const timer = pendingAudioMetaChecks.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingAudioMetaChecks.delete(key);
  }
}

function resolveAudioEntryForMeta(peerId, mediaType, streamId) {
  const map = state.peerAudioTracks.get(peerId);
  if (!map) return null;
  const entries = Array.from(map.values());
  if (streamId) {
    const matchByStream = entries.find((entry) => entry.streamId === streamId);
    if (matchByStream) return matchByStream;
  }
  const unknown = entries.filter((entry) => entry.type === TRACK_TYPES.UNKNOWN);
  if (mediaType === TRACK_TYPES.SCREEN_AUDIO) {
    const hinted = unknown.filter((entry) => isLikelyScreenAudioTrack(entry.track));
    if (hinted.length === 1) return hinted[0];
  }
  if (mediaType === TRACK_TYPES.MIC) {
    const hinted = unknown.filter((entry) => isLikelyMicTrack(entry.track));
    if (hinted.length === 1) return hinted[0];
  }
  if (unknown.length === 1) return unknown[0];
  if (unknown.length > 1) {
    const sorted = [...unknown].sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
    if (mediaType === TRACK_TYPES.SCREEN_AUDIO) {
      return sorted[sorted.length - 1] ?? null;
    }
    if (mediaType === TRACK_TYPES.MIC) {
      return sorted[0] ?? null;
    }
  }
  const guessedOpposite = entries.filter(
    (entry) => entry.guessed && entry.type !== mediaType
  );
  if (guessedOpposite.length === 1) return guessedOpposite[0];
  return null;
}

function resolveAudioEntryByStreamId(peerId, streamId) {
  if (!streamId) return null;
  const map = state.peerAudioTracks.get(peerId);
  if (!map) return null;
  for (const entry of map.values()) {
    if (entry.streamId && entry.streamId === streamId) {
      return entry;
    }
  }
  return null;
}

function resolveVideoEntryByStreamId(peerId, streamId) {
  if (!streamId) return null;
  const map = state.peerVideoEls.get(peerId);
  if (!map) return null;
  for (const entry of map.values()) {
    if (entry.streamId && entry.streamId === streamId) {
      return entry;
    }
  }
  return null;
}

function inferAudioRole(peerId) {
  const map = state.peerAudioTracks.get(peerId);
  if (!map) return null;
  let micCount = 0;
  let screenCount = 0;
  map.forEach((entry) => {
    if (entry.type === TRACK_TYPES.MIC) micCount += 1;
    if (entry.type === TRACK_TYPES.SCREEN_AUDIO) screenCount += 1;
  });
  if (micCount > 0 && screenCount === 0) return TRACK_TYPES.SCREEN_AUDIO;
  if (screenCount > 0 && micCount === 0) return TRACK_TYPES.MIC;
  return null;
}

function isLikelyScreenAudioTrack(track) {
  if (!track) return false;
  const label = (track.label || "").toLowerCase();
  return (
    label.includes("system audio") ||
    label.includes("tab audio") ||
    label.includes("screen") ||
    label.includes("display") ||
    label.includes("window")
  );
}

function isLikelyMicTrack(track) {
  if (!track) return false;
  const label = (track.label || "").toLowerCase();
  return label.includes("mic") || label.includes("microphone");
}

function setUserCameraPreview(peerId, track) {
  const avatarEls = state.peerAvatarEls.get(peerId);
  if (!avatarEls) return;
  if (track) {
    const meta = getPeerTrackMeta(peerId, track.id);
    if (meta && meta !== TRACK_TYPES.CAMERA) {
      return;
    }
    if (!meta && !isLikelyCameraTrack(track)) {
      return;
    }
  }
  if (track) {
    avatarEls.wrapper.classList.add("has-video");
    avatarEls.video.srcObject = new MediaStream([track]);
    safePlay(avatarEls.video);
  } else {
    avatarEls.wrapper.classList.remove("has-video");
    avatarEls.video.srcObject = null;
  }
}

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function refreshCameraPreview(peerId) {
  const map = state.peerVideoEls.get(peerId);
  let cameraTrack = null;
  if (map) {
    for (const entry of map.values()) {
      if (entry.role !== TRACK_TYPES.CAMERA || !entry.track) continue;
      const meta = getPeerTrackMeta(peerId, entry.track.id);
      if (meta && meta !== TRACK_TYPES.CAMERA) {
        continue;
      }
      if (!meta && !isLikelyCameraTrack(entry.track)) {
        continue;
      }
      cameraTrack = entry.track;
      break;
    }
  }
  setUserCameraPreview(peerId, cameraTrack);
}

function ensurePeerVideoMap(peerId) {
  let map = state.peerVideoEls.get(peerId);
  if (!map) {
    map = new Map();
    state.peerVideoEls.set(peerId, map);
  }
  return map;
}

function createMediaTile(peerId, role) {
  const tile = document.createElement("div");
  tile.className = "media-tile";
  tile.dataset.peerId = peerId;
  tile.dataset.role = role;
  tile.tabIndex = 0;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.volume = 0;
  video.setAttribute("autoplay", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");

  const label = document.createElement("div");
  label.className = "tile-label";
  label.textContent = `${getPeerDisplayName(peerId)} ${role === TRACK_TYPES.SCREEN ? "Screen" : "Camera"}`;

  const exitButton = document.createElement("button");
  exitButton.type = "button";
  exitButton.className = "tile-focus-exit";
  exitButton.textContent = "Back To Grid";

  tile.append(video, label, exitButton);
  return { tile, video, label, exitButton };
}

function clearFocusedScreen() {
  focusedScreen = null;
  if (screenGrid) {
    screenGrid.classList.remove("has-focus");
  }
  state.peerVideoEls.forEach((map) => {
    map.forEach((entry) => {
      if (entry.role === TRACK_TYPES.SCREEN) {
        entry.tile.classList.remove("is-focused");
      }
    });
  });
}

function setFocusedScreen(peerId, trackId) {
  focusedScreen = { peerId, trackId };
  if (screenGrid) {
    screenGrid.classList.add("has-focus");
  }
  state.peerVideoEls.forEach((map, pid) => {
    map.forEach((entry) => {
      if (entry.role !== TRACK_TYPES.SCREEN) return;
      const matches = pid === peerId && entry.track?.id === trackId;
      entry.tile.classList.toggle("is-focused", matches);
    });
  });
}


function syncFocusedScreen() {
  if (!focusedScreen) return;
  const { peerId, trackId } = focusedScreen;
  const entry = state.peerVideoEls.get(peerId)?.get(trackId);
  if (!entry || entry.role !== TRACK_TYPES.SCREEN) {
    clearFocusedScreen();
    return;
  }
  setFocusedScreen(peerId, trackId);
}

function clearFocusedCamera() {
  focusedCamera = null;
  if (cameraGrid) {
    cameraGrid.classList.remove("has-focus");
  }
  state.peerVideoEls.forEach((map) => {
    map.forEach((entry) => {
      if (entry.role === TRACK_TYPES.CAMERA) {
        entry.tile.classList.remove("is-focused");
      }
    });
  });
}

function setFocusedCamera(peerId, trackId) {
  focusedCamera = { peerId, trackId };
  if (cameraGrid) {
    cameraGrid.classList.add("has-focus");
  }
  state.peerVideoEls.forEach((map, pid) => {
    map.forEach((entry) => {
      if (entry.role !== TRACK_TYPES.CAMERA) return;
      const matches = pid === peerId && entry.track?.id === trackId;
      entry.tile.classList.toggle("is-focused", matches);
    });
  });
}

function syncFocusedCamera() {
  if (!focusedCamera) return;
  const { peerId, trackId } = focusedCamera;
  const entry = state.peerVideoEls.get(peerId)?.get(trackId);
  if (!entry || entry.role !== TRACK_TYPES.CAMERA) {
    clearFocusedCamera();
    return;
  }
  setFocusedCamera(peerId, trackId);
}

function updateTileLabel(entry, peerId) {
  if (!entry?.label) return;
  const suffix = entry.role === TRACK_TYPES.SCREEN ? "Screen" : "Camera";
  entry.label.textContent = `${getPeerDisplayName(peerId)} ${suffix}`;
}

function updateCameraLobbyEmptyState() {
  if (!cameraLobbyEmpty || !cameraGrid) return;
  const hasTiles = Array.from(cameraGrid.querySelectorAll(".media-tile")).length > 0;
  cameraLobbyEmpty.classList.toggle("hidden", hasTiles);
}

function openCameraLobby() {
  if (!cameraLobbyPanel) return;
  cameraLobbyPanel.classList.remove("hidden");
  updateCameraLobbyEmptyState();
  syncFocusedCamera();
}

function closeCameraLobby() {
  if (!cameraLobbyPanel) return;
  cameraLobbyPanel.classList.add("hidden");
  clearFocusedCamera();
}

function setSoundboardHint(text, isError = false) {
  if (!soundboardHint) return;
  soundboardHint.textContent = text ?? "";
  soundboardHint.classList.toggle("is-error", Boolean(isError));
}

function updateSoundFileLabel() {
  if (!soundFileLabel || !soundFileInput) return;
  if (soundboardEditingId) {
    soundFileInput.disabled = true;
    soundFileLabel.textContent = "Audio locked";
    soundFileLabel.title = "Audio cannot be changed after upload.";
    return;
  }
  soundFileInput.disabled = false;
  const file = soundFileInput.files?.[0];
  soundFileLabel.textContent = file ? "Change audio" : "Select audio";
  soundFileLabel.title = file ? file.name : "";
}

function updateSoundboardEditControls() {
  const isEditing = Boolean(soundboardEditingId);
  if (soundUploadButton) {
    soundUploadButton.textContent = isEditing ? "Save" : "Upload";
  }
  if (soundCancelEditButton) {
    soundCancelEditButton.classList.toggle("hidden", !isEditing);
  }
  updateSoundFileLabel();
}

function exitSoundboardEditMode() {
  soundboardEditingId = null;
  if (soundNameInput) soundNameInput.value = "";
  if (soundFileInput) soundFileInput.value = "";
  updateSoundClipVolumeUi(soundboardClipVolume);
  updateSoundboardEditControls();
  renderSoundboard();
}

function enterSoundboardEditMode(sound) {
  if (!sound?.id) return;
  soundboardEditingId = sound.id;
  if (soundNameInput) {
    soundNameInput.value = String(sound.name ?? "").slice(0, 60);
  }
  soundboardSelectedIcon = sound.icon || "\u{1F50A}";
  updateSoundClipVolumeUi(sound.volume ?? 100);
  renderSoundboardIconPicker();
  updateSoundboardEditControls();
  setSoundboardHint(`Editing "${sound.name ?? "Sound"}". Update name/icon/volume and click Save.`);
  renderSoundboard();
}

function renderSoundboardIconPicker() {
  if (!soundboardIconGrid) return;
  soundboardIconGrid.innerHTML = "";
  SOUNDBOARD_ICONS.forEach((icon) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const iconEl = document.createElement("span");
    iconEl.className = "emoji";
    iconEl.textContent = icon;
    btn.appendChild(iconEl);
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
  const filter = (soundSearchInput?.value ?? "").trim().toLowerCase();
  const sounds = Array.from(state.soundboardSounds.values())
    .filter((sound) => {
      if (!sound) return false;
      if (soundboardLoadedRoomId && sound.roomId && sound.roomId !== soundboardLoadedRoomId) return false;
      if (!filter) return true;
      return String(sound.name ?? "").toLowerCase().includes(filter);
    })
    .sort((a, b) => Number(b.uploadedAt ?? 0) - Number(a.uploadedAt ?? 0));

  soundboardGrid.innerHTML = "";

  if (sounds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = filter ? "No sounds match your search." : "No sounds yet. Upload one below.";
    soundboardGrid.appendChild(empty);
    return;
  }

  sounds.forEach((sound) => {
    const tile = document.createElement("div");
    tile.className = "sound-tile";
    tile.dataset.soundId = sound.id;
    tile.tabIndex = 0;
    tile.setAttribute("role", "button");
    tile.setAttribute("aria-label", `Play ${sound.name || "sound"}`);
    if (sound.id === soundboardEditingId) {
      tile.classList.add("is-editing");
    }

    const main = document.createElement("div");
    main.className = "sound-tile-main";

    const iconEl = document.createElement("div");
    iconEl.className = "sound-icon";
    const iconSpan = document.createElement("span");
    iconSpan.className = "emoji";
    iconSpan.textContent = sound.icon || "\u{1F50A}";
    iconEl.appendChild(iconSpan);

    const nameEl = document.createElement("div");
    nameEl.className = "sound-name";
    nameEl.textContent = sound.name || "Sound";
    if (sound.uploadedBy?.name) {
      tile.title = `Uploaded by ${sound.uploadedBy.name}`;
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "sound-edit";
    editBtn.textContent = "\u270F\uFE0F";
    editBtn.title = "Edit";
    editBtn.setAttribute("aria-label", `Edit ${sound.name || "sound"}`);
    editBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      enterSoundboardEditMode(sound);
    });

    main.appendChild(iconEl);
    main.appendChild(nameEl);
    tile.appendChild(main);
    tile.appendChild(editBtn);

    const play = () => {
      if (!state.roomId || !state.ws) return;
      send({ type: "sound-play", soundId: sound.id });
    };

    tile.addEventListener("click", play);
    tile.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      play();
    });

    soundboardGrid.appendChild(tile);
  });
}

function openSoundboard() {
  if (!soundboardPanel) return;
  closeCameraLobby();
  soundboardEditingId = null;
  if (soundboardVolumePanel) {
    soundboardVolumePanel.classList.add("hidden");
  }
  updateSoundboardVolumeUi();
  updateSoundClipVolumeUi(soundboardClipVolume);
  renderSoundboardIconPicker();
  updateSoundboardEditControls();
  soundboardPanel.classList.remove("hidden");
  if (state.roomId && state.token) {
    void loadSoundboardList();
  }
  renderSoundboard();
}

function closeSoundboard() {
  if (!soundboardPanel) return;
  soundboardPanel.classList.add("hidden");
  soundboardEditingId = null;
  updateSoundboardEditControls();
  setSoundboardHint("");
  if (soundSearchInput) soundSearchInput.value = "";
}

function clearSoundboardState() {
  soundboardLoadedRoomId = null;
  soundboardEditingId = null;
  state.soundboardSounds.clear();
  if (soundboardGrid) soundboardGrid.innerHTML = "";
  if (soundNameInput) soundNameInput.value = "";
  if (soundFileInput) soundFileInput.value = "";
  updateSoundboardEditControls();
  stopSoundboardPlayback();
  setSoundboardHint("");
  closeSoundboard();
}

async function loadSoundboardList() {
  if (!state.token || !state.roomId) return;
  const roomId = state.roomId;
  soundboardLoadedRoomId = roomId;
  try {
    const res = await fetch(`/api/soundboard/list?roomId=${encodeURIComponent(roomId)}`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!res.ok) {
      if (!soundboardPanel?.classList.contains("hidden")) {
        setSoundboardHint("Unable to load soundboard.", true);
      }
      return;
    }
    const data = await res.json();
    if (roomId !== state.roomId) return;
    state.soundboardSounds.clear();
    for (const sound of data?.sounds ?? []) {
      if (sound && sound.id) {
        state.soundboardSounds.set(sound.id, sound);
      }
    }
    if (!soundboardPanel?.classList.contains("hidden")) {
      renderSoundboard();
    }
  } catch {
    if (!soundboardPanel?.classList.contains("hidden")) {
      setSoundboardHint("Unable to load soundboard.", true);
    }
  }
}

function getSoundboardAudio() {
  // Deprecated: kept for compatibility with older code paths.
  return null;
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
  const base = state.roomAudioMuted ? 0 : soundboardUserVolume / 100;
  soundboardMasterGain.gain.value = Math.max(0, base);
}

async function applySoundboardOutputDevice() {
  if (!soundboardContext) return;
  if (!outputDeviceSupported()) return;
  const sinkId = selectedSpeakerId && selectedSpeakerId.length > 0 ? selectedSpeakerId : "default";
  const ctx = soundboardContext;
  if (ctx && typeof ctx.setSinkId === "function") {
    try {
      await ctx.setSinkId(sinkId);
    } catch {
      // Ignore sink routing failures; the soundboard will use the system default output.
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
  // Browsers will often block WebSocket-triggered audio until a user gesture occurs.
  // Call this from a click/submit handler to "unlock" the soundboard for remote plays.
  const ctx = getSoundboardContext();
  if (!ctx) return;
  try {
    const p = ctx.resume();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // ignore
      });
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
  if (!ctx) return null;
  if (!state.token) return null;
  const token = encodeURIComponent(state.token ?? "");
  const res = await fetch(`/api/soundboard/file/${encodeURIComponent(soundId)}?token=${token}`);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const decoded = await ctx.decodeAudioData(buf.slice(0));
  soundboardBufferCache.set(soundId, decoded);
  return decoded;
}

async function playSoundboardSound(soundId) {
  if (!state.token) return;
  if (state.roomAudioMuted) return;

  const ctx = getSoundboardContext();
  if (!ctx || !soundboardMasterGain) return;

  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const sound = state.soundboardSounds.get(soundId);
    const clipVolume = Number(sound?.volume ?? 100);
    const clipGainValue = Math.min(4, Math.max(0, clipVolume / 100));

    const buffer = await fetchSoundboardBuffer(soundId);
    if (!buffer) {
      if (soundboardPanel?.classList.contains("hidden")) {
        setMessage("Unable to play soundboard audio.", true);
      } else {
        setSoundboardHint("Unable to play sound.", true);
      }
      return;
    }

    stopSoundboardPlayback();

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const clipGain = ctx.createGain();
    clipGain.gain.value = clipGainValue;
    source.connect(clipGain);
    clipGain.connect(soundboardMasterGain);

    source.onended = () => {
      if (soundboardCurrentSource === source) {
        soundboardCurrentSource = null;
      }
      try {
        clipGain.disconnect();
      } catch {
        // ignore
      }
    };

    soundboardCurrentSource = source;
    source.start(0);
  } catch {
    // Autoplay restrictions can block this if the user hasn't interacted yet.
    setMessage("Soundboard playback was blocked by the browser. Click the page and try again.", true);
  }
}

function upsertSoundboardSound(sound) {
  if (!sound || !sound.id) return;
  if (state.roomId && sound.roomId && sound.roomId !== state.roomId) return;
  state.soundboardSounds.set(sound.id, sound);
  if (!soundboardPanel?.classList.contains("hidden")) {
    renderSoundboard();
  }
}

async function uploadSoundboardSound() {
  if (soundboardEditingId) {
    await updateSoundboardSound();
    return;
  }
  if (!state.token || !state.roomId || !state.peerId) {
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
      roomId: state.roomId,
      peerId: state.peerId,
      name,
      icon,
      volume: String(volume)
    });
    const res = await fetch(`/api/soundboard/upload?${qs.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.token}`,
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
  if (!state.token || !state.roomId || !state.peerId || !soundboardEditingId) {
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
        Authorization: `Bearer ${state.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        roomId: state.roomId,
        peerId: state.peerId,
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
    }
    exitSoundboardEditMode();
    setSoundboardHint("Saved!");
  } catch {
    setSoundboardHint("Save failed.", true);
  }
}

function hasCameraTrack(peerId) {
  const map = state.peerVideoEls.get(peerId);
  if (!map) return false;
  for (const entry of map.values()) {
    if (entry.role === TRACK_TYPES.CAMERA) {
      return true;
    }
  }
  return false;
}

function hasScreenTrack(peerId) {
  const map = state.peerVideoEls.get(peerId);
  if (!map) return false;
  for (const entry of map.values()) {
    if (entry.role === TRACK_TYPES.SCREEN) {
      return true;
    }
  }
  return false;
}

function updateScreenWatchButton(peerId) {
  const button = state.peerWatchButtons.get(peerId);
  if (!button) return;
  const hasScreen = hasScreenTrack(peerId);
  if (!hasScreen) {
    button.classList.add("hidden");
    button.disabled = true;
    return;
  }
  button.disabled = false;
  button.classList.remove("hidden");
  const hidden = state.hiddenScreenPeers.has(peerId);
  button.textContent = hidden ? "Start Watching" : "Stop Watching";
}

function applyPeerScreenVisibility(peerId) {
  const hidden = state.hiddenScreenPeers.has(peerId);
  const map = state.peerVideoEls.get(peerId);
  if (map) {
    map.forEach((entry) => {
      if (entry.role !== TRACK_TYPES.SCREEN) return;
      entry.tile.classList.toggle("is-hidden", hidden);
    });
  }
  if (hidden && focusedScreen && focusedScreen.peerId === peerId) {
    clearFocusedScreen();
  }
  updateScreenWatchButton(peerId);
}

function togglePinnedCamera(peerId) {
  if (!hasCameraTrack(peerId)) {
    setMessage("No camera feed for this user.", true);
    return;
  }
  openCameraLobby();
  const map = state.peerVideoEls.get(peerId);
  if (map) {
    for (const entry of map.values()) {
      if (entry.role === TRACK_TYPES.CAMERA && entry.track) {
        setFocusedCamera(peerId, entry.track.id);
        return;
      }
    }
  }
}

const remoteVideoProbeKeys = new Set();

function scheduleRemoteVideoProbe(peerId, trackId) {
  const key = `${peerId}:${trackId}`;
  if (remoteVideoProbeKeys.has(key)) return;
  remoteVideoProbeKeys.add(key);
  setTimeout(async () => {
    const entry = state.peerVideoEls.get(peerId)?.get(trackId);
    if (!entry?.track || !entry.video) return;
    const track = entry.track;
    const video = entry.video;
    const context = {
      peerId,
      trackId,
      role: entry.role,
      streamId: entry.streamId ?? null,
      readyState: track.readyState,
      muted: Boolean(track.muted),
      enabled: Boolean(track.enabled),
      videoWidth: Number(video.videoWidth ?? 0),
      videoHeight: Number(video.videoHeight ?? 0),
      paused: Boolean(video.paused),
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0
    };

    clientLog("info", "remote_video_probe", context);

    // Try to collect a small stats sample so we can tell "no packets" vs "decode failure".
    const pc = state.peerConnections.get(peerId);
    if (!pc || typeof pc.getStats !== "function") return;
    try {
      const report = await pc.getStats(track);
      let inbound = null;
      let codec = null;
      report.forEach((stat) => {
        if (stat.type === "inbound-rtp" && stat.kind === "video") {
          inbound = stat;
        }
      });
      if (inbound && inbound.codecId) {
        codec = report.get(inbound.codecId) ?? null;
      }

      clientLog("info", "remote_video_stats", {
        peerId,
        trackId,
        bytesReceived: inbound?.bytesReceived ?? null,
        framesDecoded: inbound?.framesDecoded ?? null,
        framesDropped: inbound?.framesDropped ?? null,
        packetsLost: inbound?.packetsLost ?? null,
        jitter: inbound?.jitter ?? null,
        pliCount: inbound?.pliCount ?? null,
        nackCount: inbound?.nackCount ?? null,
        codec: codec
          ? {
              mimeType: codec.mimeType ?? null,
              clockRate: codec.clockRate ?? null,
              sdpFmtpLine: codec.sdpFmtpLine ?? null
            }
          : null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      clientLog("warn", "remote_video_stats_failed", { peerId, trackId, message });
    }
  }, 1500);
}

  function attachRemoteVideoTrack(peerId, track, streams) {
    const streamId = streams?.[0]?.id ?? null;
    let role = inferVideoRole(peerId, track);
    if (streamId) {
      const streamMeta = getPeerStreamMeta(peerId, streamId);
      if (streamMeta === TRACK_TYPES.SCREEN || streamMeta === TRACK_TYPES.CAMERA) {
        role = streamMeta;
      }
    }
    const meta = getPeerTrackMeta(peerId, track.id);
    if (!meta) {
      const pendingScreen = consumePendingRoleMeta(peerId, TRACK_TYPES.SCREEN);
      const pendingCamera = consumePendingRoleMeta(peerId, TRACK_TYPES.CAMERA);
      if (pendingScreen) {
        ensurePeerTrackMeta(peerId).set(track.id, TRACK_TYPES.SCREEN);
        role = TRACK_TYPES.SCREEN;
      } else if (pendingCamera) {
        ensurePeerTrackMeta(peerId).set(track.id, TRACK_TYPES.CAMERA);
        role = TRACK_TYPES.CAMERA;
      } else {
        scheduleTrackMetaCheck(peerId, track);
      }
    }
  const map = ensurePeerVideoMap(peerId);
  let entry = map.get(track.id);
  let isNew = false;
  if (!entry) {
    const { tile, video, label, exitButton } = createMediaTile(peerId, role);
    entry = {
      tile,
      video,
      label,
      exitButton,
      role,
      track,
      addedAt: Date.now(),
      streamId
    };
    map.set(track.id, entry);
    isNew = true;
  } else {
    if (!entry.streamId && streams?.[0]?.id) {
      entry.streamId = streams[0].id;
    }
  }

  const previousRole = entry.role;
  entry.role = role;
  entry.track = track;
  entry.tile.dataset.role = role;
  updateTileLabel(entry, peerId);

  if (role === TRACK_TYPES.SCREEN) {
    if (screenGrid && !screenGrid.contains(entry.tile)) {
      screenGrid.appendChild(entry.tile);
    }
    if (cameraGrid && entry.tile.parentElement === cameraGrid) {
      entry.tile.remove();
    }
    entry.tile.classList.remove("hidden");
    applyPeerScreenVisibility(peerId);
  } else {
    if (screenGrid && entry.tile.parentElement === screenGrid) {
      entry.tile.remove();
    }
    if (cameraGrid && !cameraGrid.contains(entry.tile)) {
      cameraGrid.appendChild(entry.tile);
    }
    entry.tile.classList.remove("hidden");
  }

  // Some browsers refuse to autoplay media elements that aren't attached to the DOM yet.
  entry.video.srcObject = new MediaStream([track]);
  safePlay(entry.video, { peerId, trackId: track.id, role, kind: "video" });
  scheduleRemoteVideoProbe(peerId, track.id);
  refreshCameraPreview(peerId);
  updateCameraLobbyEmptyState();

  if (entry.exitButton) {
    entry.exitButton.onclick = (event) => {
      event.stopPropagation();
      if (entry.role === TRACK_TYPES.SCREEN) {
        clearFocusedScreen();
      } else if (entry.role === TRACK_TYPES.CAMERA) {
        clearFocusedCamera();
      }
    };
  }

  entry.tile.onclick = () => {
    if (entry.role === TRACK_TYPES.SCREEN) {
      if (focusedScreen && focusedScreen.peerId === peerId && focusedScreen.trackId === track.id) {
        clearFocusedScreen();
        return;
      }
      setFocusedScreen(peerId, track.id);
      return;
    }
    if (entry.role === TRACK_TYPES.CAMERA) {
      if (focusedCamera && focusedCamera.peerId === peerId && focusedCamera.trackId === track.id) {
        clearFocusedCamera();
        return;
      }
      openCameraLobby();
      setFocusedCamera(peerId, track.id);
    }
  };

  if (isNew) {
    track.addEventListener("ended", () => {
      removeRemoteVideoTrack(peerId, track.id);
    });
  }

  syncFocusedScreen();
  syncFocusedCamera();
}

function removeRemoteVideoTrack(peerId, trackId) {
  const map = state.peerVideoEls.get(peerId);
  const entry = map?.get(trackId);
  if (!entry) return false;
  clearTrackMetaCheck(peerId, trackId);
  clearPeerStreamMeta(peerId, entry.streamId);
  entry.video.srcObject = null;
  entry.tile.remove();
  map?.delete(trackId);
  if (focusedScreen && focusedScreen.peerId === peerId && focusedScreen.trackId === trackId) {
    clearFocusedScreen();
  }
  if (focusedCamera && focusedCamera.peerId === peerId && focusedCamera.trackId === trackId) {
    clearFocusedCamera();
  }
  updateScreenWatchButton(peerId);
  refreshCameraPreview(peerId);
  updateCameraLobbyEmptyState();
  return true;
}

function removeRemoteVideoByRole(peerId, role) {
  const map = state.peerVideoEls.get(peerId);
  if (!map) return false;
  for (const [trackId, entry] of map.entries()) {
    if (entry.role === role) {
      return removeRemoteVideoTrack(peerId, trackId);
    }
  }
  return false;
}

function removePeerVideoTiles(peerId) {
  const map = state.peerVideoEls.get(peerId);
  if (map) {
    map.forEach((entry) => {
      if (entry.track?.id) {
        clearTrackMetaCheck(peerId, entry.track.id);
      }
      clearPeerStreamMeta(peerId, entry.streamId);
      entry.video.srcObject = null;
      entry.tile.remove();
    });
  }
  state.peerVideoEls.delete(peerId);
  refreshCameraPreview(peerId);
  updateCameraLobbyEmptyState();
  if (focusedScreen && focusedScreen.peerId === peerId) {
    clearFocusedScreen();
  }
  if (focusedCamera && focusedCamera.peerId === peerId) {
    clearFocusedCamera();
  }
}

function ensurePeerAudioStreams(peerId) {
  let streams = state.peerAudioStreams.get(peerId);
  if (!streams) {
    streams = { mic: new MediaStream(), screen: new MediaStream() };
    state.peerAudioStreams.set(peerId, streams);
  }
  return streams;
}

function ensurePeerTrackMeta(peerId) {
  let meta = state.peerTrackMeta.get(peerId);
  if (!meta) {
    meta = new Map();
    state.peerTrackMeta.set(peerId, meta);
  }
  return meta;
}

function ensurePeerStreamMeta(peerId) {
  let meta = state.peerStreamMeta.get(peerId);
  if (!meta) {
    meta = new Map();
    state.peerStreamMeta.set(peerId, meta);
  }
  return meta;
}

function getPeerTrackMeta(peerId, trackId) {
  return state.peerTrackMeta.get(peerId)?.get(trackId) ?? null;
}

function getPeerStreamMeta(peerId, streamId) {
  return state.peerStreamMeta.get(peerId)?.get(streamId) ?? null;
}

function setPeerStreamMeta(peerId, streamId, mediaType) {
  if (!streamId || !mediaType) return;
  const meta = ensurePeerStreamMeta(peerId);
  meta.set(streamId, mediaType);
}

function clearPeerStreamMeta(peerId, streamId) {
  if (!streamId) return;
  const meta = state.peerStreamMeta.get(peerId);
  if (meta) {
    meta.delete(streamId);
  }
}

function setPeerTrackMeta(peerId, trackId, mediaType, streamId) {
  const meta = ensurePeerTrackMeta(peerId);
  meta.set(trackId, mediaType);
  if (streamId) {
    setPeerStreamMeta(peerId, streamId, mediaType);
  }
  clearTrackMetaCheck(peerId, trackId);
  if (mediaType === TRACK_TYPES.MIC || mediaType === TRACK_TYPES.SCREEN_AUDIO) {
    clearAudioMetaCheck(peerId, trackId);
  }
  consumePendingRoleMeta(peerId, mediaType);
  const trackMap = state.peerAudioTracks.get(peerId);
  let entry = trackMap?.get(trackId);
  if (!entry && (mediaType === TRACK_TYPES.MIC || mediaType === TRACK_TYPES.SCREEN_AUDIO)) {
    const streamMatch = resolveAudioEntryByStreamId(peerId, streamId);
    if (streamMatch && streamMatch.track) {
      const streamMatchId = streamMatch.track.id;
      if (streamMatchId && streamMatchId !== trackId) {
        meta.set(streamMatchId, mediaType);
        meta.delete(trackId);
        clientLog("warn", "audio_meta_stream_map", {
          peerId,
          from: trackId,
          to: streamMatchId,
          mediaType
        });
      }
      entry = streamMatch;
    }
  }
  if (!entry && (mediaType === TRACK_TYPES.MIC || mediaType === TRACK_TYPES.SCREEN_AUDIO)) {
    rememberPendingAudioMeta(peerId, mediaType, trackId);
  }
  if (entry && entry.type !== mediaType) {
    entry.type = mediaType;
    entry.guessed = false;
    attachRemoteAudioTrack(peerId, entry.track, mediaType);
  }
  const videoMap = state.peerVideoEls.get(peerId);
  let videoEntry = videoMap?.get(trackId);
  if (!videoEntry && (mediaType === TRACK_TYPES.SCREEN || mediaType === TRACK_TYPES.CAMERA)) {
    const streamMatch = resolveVideoEntryByStreamId(peerId, streamId);
    if (streamMatch && streamMatch.track) {
      const streamMatchId = streamMatch.track.id;
      if (streamMatchId && streamMatchId !== trackId) {
        meta.set(streamMatchId, mediaType);
        meta.delete(trackId);
        clientLog("warn", "video_meta_stream_map", {
          peerId,
          from: trackId,
          to: streamMatchId,
          mediaType
        });
      }
      videoEntry = streamMatch;
    }
  }
  if (!videoEntry && (mediaType === TRACK_TYPES.SCREEN || mediaType === TRACK_TYPES.CAMERA)) {
    const fallback = resolveVideoEntryForMeta(peerId, mediaType);
    if (fallback && fallback.track) {
      const fallbackId = fallback.track.id;
      if (fallbackId && fallbackId !== trackId) {
        meta.set(fallbackId, mediaType);
        clientLog("warn", "track_meta_remap", {
          peerId,
          from: trackId,
          to: fallbackId,
          mediaType
        });
      }
      videoEntry = fallback;
    } else {
      rememberPendingRoleMeta(peerId, mediaType, trackId);
    }
  }
  if (videoEntry && (mediaType === TRACK_TYPES.SCREEN || mediaType === TRACK_TYPES.CAMERA)) {
    if (videoEntry.role !== mediaType) {
      videoEntry.role = mediaType;
    }
    if (videoEntry.track) {
      attachRemoteVideoTrack(peerId, videoEntry.track);
    }
  }
}

  function attachRemoteAudioTrack(peerId, track, mediaType) {
  const streams = ensurePeerAudioStreams(peerId);
  const targetKey = mediaType === TRACK_TYPES.SCREEN_AUDIO ? "screen" : "mic";
  const targetStream = streams[targetKey];
  const otherStream = targetKey === "screen" ? streams.mic : streams.screen;

  if (otherStream.getTrackById(track.id)) {
    otherStream.removeTrack(track);
  }
  if (!targetStream.getTrackById(track.id)) {
    targetStream.addTrack(track);
  }
  // Only keep a single active track per role to avoid mixing/swap bugs when browsers replace tracks.
  targetStream.getTracks().forEach((existing) => {
    if (existing && existing.id !== track.id) {
      targetStream.removeTrack(existing);
    }
  });

  const audioEls = state.peerAudioEls.get(peerId);
  if (audioEls) {
    const element = targetKey === "screen" ? audioEls.screen : audioEls.mic;
    const mixerOk = connectPeerAudioToMixer(peerId, targetKey, track);
    if (mixerOk) {
      element.srcObject = null;
    } else {
      element.srcObject = targetStream;
      applyOutputDevice(element);
      safePlay(element, { peerId, trackId: track.id, role: mediaType, kind: "audio" });
    }
    ensureAudioAnalyser(peerId, targetKey, targetStream, track.id);
    applyPeerAudioVolume(audioEls, targetKey);
  }
  if (mediaType === TRACK_TYPES.MIC) {
    setMicMuted(peerId, false);
  }
}

function registerRemoteAudioTrack(peerId, track, streams) {
  if (!track || track.readyState === "ended") {
    return;
  }
  const streamId = Array.isArray(streams) && streams[0] ? streams[0].id : null;
  let mediaType = getPeerTrackMeta(peerId, track.id);
  if (!mediaType && streamId) {
    const streamMeta = getPeerStreamMeta(peerId, streamId);
    if (streamMeta === TRACK_TYPES.MIC || streamMeta === TRACK_TYPES.SCREEN_AUDIO) {
      mediaType = streamMeta;
    }
  }
  if (!mediaType) {
    const pendingScreen = consumePendingAudioMeta(peerId, TRACK_TYPES.SCREEN_AUDIO, track.id);
    const pendingMic = consumePendingAudioMeta(peerId, TRACK_TYPES.MIC, track.id);
    if (pendingScreen) {
      mediaType = TRACK_TYPES.SCREEN_AUDIO;
    } else if (pendingMic) {
      mediaType = TRACK_TYPES.MIC;
    }
  }
  let guessed = false;
  if (!mediaType) {
    if (isLikelyScreenAudioTrack(track)) {
      mediaType = TRACK_TYPES.SCREEN_AUDIO;
      guessed = true;
    } else if (isLikelyMicTrack(track)) {
      mediaType = TRACK_TYPES.MIC;
      guessed = true;
    }
  }
  if (!mediaType) {
    const inferred = inferAudioRole(peerId);
    if (inferred) {
      mediaType = inferred;
      guessed = true;
    }
  }
  const trackMap = state.peerAudioTracks.get(peerId) ?? new Map();
  const entryType = mediaType ?? TRACK_TYPES.UNKNOWN;
  trackMap.set(track.id, { track, type: entryType, guessed, streamId, addedAt: Date.now() });
  state.peerAudioTracks.set(peerId, trackMap);
  if (entryType === TRACK_TYPES.MIC || entryType === TRACK_TYPES.SCREEN_AUDIO) {
    attachRemoteAudioTrack(peerId, track, entryType);
  } else {
    scheduleAudioMetaCheck(peerId, track);
  }
  track.addEventListener("ended", () => {
    removeRemoteAudioTrack(peerId, track.id);
  });
}

function startAudioHealthCheck() {
  if (audioHealthInterval) return;
  audioHealthInterval = setInterval(() => {
    state.peerConnections.forEach((pc, peerId) => {
      try {
        const receivers = typeof pc.getReceivers === "function" ? pc.getReceivers() : [];
        receivers.forEach((receiver) => {
          const track = receiver.track;
          if (!track || track.kind !== "audio") return;
          const trackMap = state.peerAudioTracks.get(peerId);
          if (!trackMap || !trackMap.has(track.id)) {
            registerRemoteAudioTrack(peerId, track);
          }
        });
      } catch {
        // ignore health check errors
      }

      const streams = state.peerAudioStreams.get(peerId);
      const audioEls = state.peerAudioEls.get(peerId);
      if (streams && audioEls) {
        if (roomAudioMixer) {
          const micTrack = streams.mic.getAudioTracks()[0];
          if (micTrack && audioEls.micPlaybackTrackId !== micTrack.id) {
            connectPeerAudioToMixer(peerId, "mic", micTrack);
          }
          const screenTrack = streams.screen.getAudioTracks()[0];
          if (screenTrack && audioEls.screenPlaybackTrackId !== screenTrack.id) {
            connectPeerAudioToMixer(peerId, "screen", screenTrack);
          }
        } else {
          if (streams.mic.getTracks().length > 0 && !audioEls.mic.srcObject) {
            audioEls.mic.srcObject = streams.mic;
            applyOutputDevice(audioEls.mic);
            safePlay(audioEls.mic);
            applyPeerAudioVolume(audioEls, "mic");
          }
          if (streams.screen.getTracks().length > 0 && !audioEls.screen.srcObject) {
            audioEls.screen.srcObject = streams.screen;
            applyOutputDevice(audioEls.screen);
            safePlay(audioEls.screen);
            applyPeerAudioVolume(audioEls, "screen");
          }
        }
      }
    });
  }, 4000);
}

function formatKbps(value) {
  if (!Number.isFinite(value)) return "0 kbps";
  return `${Math.max(0, Math.round(value))} kbps`;
}

function formatFps(value) {
  if (!Number.isFinite(value)) return "0 fps";
  return `${Math.max(0, Math.round(value))} fps`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toFixed(1)}%`;
}

function getPeerName(peerId) {
  return state.peerProfiles.get(peerId)?.name ?? peerId.slice(0, 6);
}

function getRoleForTrack(peerId, trackIdentifier) {
  const map = state.peerVideoEls.get(peerId);
  if (!map) return null;
  for (const entry of map.values()) {
    if (entry.track?.id === trackIdentifier) return entry.role;
  }
  return null;
}

function calcRate(key, bytes, frames, timestampMs) {
  const prev = statsHistory.get(key);
  statsHistory.set(key, { bytes, frames, timestampMs });
  if (!prev) return { kbps: 0, fps: 0 };
  const deltaMs = timestampMs - prev.timestampMs;
  if (deltaMs <= 0) return { kbps: 0, fps: 0 };
  const kbps = ((bytes - prev.bytes) * 8) / (deltaMs / 1000) / 1000;
  const fps = frames != null && prev.frames != null ? (frames - prev.frames) / (deltaMs / 1000) : 0;
  return { kbps, fps };
}

async function buildDiagnostics() {
  if (!diagnosticsPanel || diagnosticsPanel.classList.contains("is-collapsed") || !diagnosticsBody) return;
  const peerBlocks = [];
  const totals = {
    txScreenKbps: 0,
    txCameraKbps: 0,
    txMicKbps: 0,
    txScreenAudioKbps: 0,
    rxScreenKbps: 0,
    rxCameraKbps: 0,
    rxMicKbps: 0,
    rxScreenAudioKbps: 0
  };

  for (const [peerId, pc] of state.peerConnections.entries()) {
    try {
      const report = await pc.getStats();
      let rttMs = null;
      let availableOutKbps = null;
      let availableInKbps = null;
      report.forEach((stat) => {
        if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) {
          if (typeof stat.currentRoundTripTime === "number") {
            rttMs = stat.currentRoundTripTime * 1000;
          }
          if (typeof stat.availableOutgoingBitrate === "number") {
            availableOutKbps = stat.availableOutgoingBitrate / 1000;
          }
          if (typeof stat.availableIncomingBitrate === "number") {
            availableInKbps = stat.availableIncomingBitrate / 1000;
          }
        }
      });

      const rows = [];
      report.forEach((stat) => {
        if (stat.type === "inbound-rtp" && (stat.kind === "video" || stat.mediaType === "video")) {
          const trackStat = report.get(stat.trackId);
          const trackIdentifier = stat.trackIdentifier || trackStat?.trackIdentifier || stat.trackId;
          const role = getRoleForTrack(peerId, trackIdentifier) ?? (stat.contentType === "screenshare" ? "screen" : null);
          const bytes = stat.bytesReceived ?? 0;
          const frames = stat.framesDecoded ?? trackStat?.framesDecoded ?? 0;
          const { kbps, fps } = calcRate(`in:${peerId}:${trackIdentifier}`, bytes, frames, stat.timestamp);
          const packetsLost = stat.packetsLost ?? 0;
          const packetsReceived = stat.packetsReceived ?? 0;
          const lossPct =
            packetsLost + packetsReceived > 0 ? (packetsLost / (packetsLost + packetsReceived)) * 100 : 0;
          const width = trackStat?.frameWidth ?? stat.frameWidth;
          const height = trackStat?.frameHeight ?? stat.frameHeight;
          if (role === TRACK_TYPES.SCREEN) totals.rxScreenKbps += kbps;
          if (role === TRACK_TYPES.CAMERA) totals.rxCameraKbps += kbps;
          rows.push({
            label: `RX ${role ? role : "video"}`,
            kbps,
            fps,
            lossPct,
            res: width && height ? `${width}x${height}` : null,
            extra: null
          });
        }
        if (stat.type === "inbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio")) {
          const trackIdentifier = stat.trackIdentifier || stat.trackId;
          const bytes = stat.bytesReceived ?? 0;
          const { kbps } = calcRate(`ina:${peerId}:${trackIdentifier}`, bytes, null, stat.timestamp);
          const packetsLost = stat.packetsLost ?? 0;
          const packetsReceived = stat.packetsReceived ?? 0;
          const lossPct =
            packetsLost + packetsReceived > 0 ? (packetsLost / (packetsLost + packetsReceived)) * 100 : 0;
          const audioEntry = state.peerAudioTracks.get(peerId)?.get(trackIdentifier);
          const audioRole = audioEntry?.type === TRACK_TYPES.SCREEN_AUDIO ? TRACK_TYPES.SCREEN_AUDIO : TRACK_TYPES.MIC;
          if (audioRole === TRACK_TYPES.SCREEN_AUDIO) totals.rxScreenAudioKbps += kbps;
          if (audioRole === TRACK_TYPES.MIC) totals.rxMicKbps += kbps;
          rows.push({
            label: `RX ${audioRole === TRACK_TYPES.SCREEN_AUDIO ? "screenAudio" : "mic"}`,
            kbps,
            fps: null,
            lossPct,
            res: null,
            extra: null
          });
        }
        if (stat.type === "outbound-rtp" && (stat.kind === "video" || stat.mediaType === "video")) {
          const trackStat = report.get(stat.trackId);
          const trackIdentifier = stat.trackIdentifier || trackStat?.trackIdentifier || stat.trackId;
          let role = "video";
          if (state.localScreenTrack && trackIdentifier === state.localScreenTrack.id) {
            role = "screen";
          } else if (state.localCameraTrack && trackIdentifier === state.localCameraTrack.id) {
            role = "camera";
          } else if (stat.contentType === "screenshare") {
            role = "screen";
          }
          const bytes = stat.bytesSent ?? 0;
          const frames = stat.framesEncoded ?? trackStat?.framesEncoded ?? 0;
          const { kbps, fps } = calcRate(`out:${peerId}:${trackIdentifier}`, bytes, frames, stat.timestamp);
          const width = trackStat?.frameWidth ?? stat.frameWidth;
          const height = trackStat?.frameHeight ?? stat.frameHeight;
          const ql = typeof stat.qualityLimitationReason === "string" ? stat.qualityLimitationReason : null;
          if (role === "screen") totals.txScreenKbps += kbps;
          if (role === "camera") totals.txCameraKbps += kbps;
          rows.push({
            label: role === "screen" ? "TX screen" : role === "camera" ? "TX camera" : "TX video",
            kbps,
            fps,
            lossPct: null,
            res: width && height ? `${width}x${height}` : null,
            extra: ql ? `ql ${ql}` : null
          });
        }
        if (stat.type === "outbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio")) {
          const trackIdentifier = stat.trackIdentifier || stat.trackId;
          const bytes = stat.bytesSent ?? 0;
          const { kbps } = calcRate(`outa:${peerId}:${trackIdentifier}`, bytes, null, stat.timestamp);
          const localRole =
            state.localScreenAudioTrack && trackIdentifier === state.localScreenAudioTrack.id
              ? TRACK_TYPES.SCREEN_AUDIO
              : TRACK_TYPES.MIC;
          if (localRole === TRACK_TYPES.SCREEN_AUDIO) totals.txScreenAudioKbps += kbps;
          if (localRole === TRACK_TYPES.MIC) totals.txMicKbps += kbps;
          rows.push({
            label: `TX ${localRole === TRACK_TYPES.SCREEN_AUDIO ? "screenAudio" : "mic"}`,
            kbps,
            fps: null,
            lossPct: null,
            res: null,
            extra: null
          });
        }
      });

      if (rows.length === 0) {
        rows.push({ label: "No stats", kbps: 0, fps: null, lossPct: null, res: null, extra: null });
      }

      const chips = rows
        .map((row) => {
          const parts = [
            row.label,
            formatKbps(row.kbps),
            row.fps !== null ? formatFps(row.fps) : null,
            row.res ? row.res : null,
            row.lossPct !== null ? `loss ${formatPercent(row.lossPct)}` : null,
            row.extra ? row.extra : null
          ].filter(Boolean);
          return `<div class="diag-row">${parts.map((part) => `<span class="diag-chip">${part}</span>`).join("")}</div>`;
        })
        .join("");

      const netParts = [];
      if (availableOutKbps != null) netParts.push(`avail out ${formatKbps(availableOutKbps)}`);
      if (availableInKbps != null) netParts.push(`avail in ${formatKbps(availableInKbps)}`);
      const netRow =
        netParts.length > 0
          ? `<div class="diag-row">${netParts.map((part) => `<span class="diag-chip">${part}</span>`).join("")}</div>`
          : "";

      peerBlocks.push(
        `<div class="diag-peer"><div class="diag-title">${getPeerName(peerId)}${rttMs ? ` - RTT ${Math.round(
          rttMs
        )} ms` : ""}</div>${netRow}${chips}</div>`
      );
    } catch {
      // ignore stats errors
    }
  }

  // Always show local capture + bitrate info so you can sanity-check even when there are no peers yet.
  const localParts = [];
  try {
    if (state.localScreenTrack && typeof state.localScreenTrack.getSettings === "function") {
      const s = state.localScreenTrack.getSettings();
      const res = s.width && s.height ? `${s.width}x${s.height}` : "unknown";
      const fps = s.frameRate ? `${Math.round(s.frameRate)} fps` : "fps ?";
      localParts.push(`screen ${res}`, fps, `quality ${selectedScreenQuality}`);
    } else {
      localParts.push("screen off");
    }
  } catch {
    localParts.push("screen ?");
  }
  try {
    if (state.localCameraTrack && typeof state.localCameraTrack.getSettings === "function") {
      const c = state.localCameraTrack.getSettings();
      const res = c.width && c.height ? `${c.width}x${c.height}` : "unknown";
      const fps = c.frameRate ? `${Math.round(c.frameRate)} fps` : "fps ?";
      localParts.push(`camera ${res}`, fps, "cap 1080p");
    } else {
      localParts.push("camera off");
    }
  } catch {
    localParts.push("camera ?");
  }
  localParts.push(state.localAudioTrack ? "mic on" : "mic off");
  localParts.push(state.localScreenAudioTrack ? "screen audio on" : "screen audio off");
  localParts.push(`screen max ${formatKbps(getScreenMaxBitrateBps() / 1000)}`);
  localParts.push(`camera max ${formatKbps(getCameraMaxBitrateBps() / 1000)}`);

  if (totals.txScreenKbps > 0) localParts.push(`tx screen ${formatKbps(totals.txScreenKbps)}`);
  if (totals.txCameraKbps > 0) localParts.push(`tx camera ${formatKbps(totals.txCameraKbps)}`);
  if (totals.txMicKbps > 0) localParts.push(`tx mic ${formatKbps(totals.txMicKbps)}`);
  if (totals.txScreenAudioKbps > 0) localParts.push(`tx screenAudio ${formatKbps(totals.txScreenAudioKbps)}`);
  if (totals.rxScreenKbps > 0) localParts.push(`rx screen ${formatKbps(totals.rxScreenKbps)}`);
  if (totals.rxCameraKbps > 0) localParts.push(`rx camera ${formatKbps(totals.rxCameraKbps)}`);
  if (totals.rxMicKbps > 0) localParts.push(`rx mic ${formatKbps(totals.rxMicKbps)}`);
  if (totals.rxScreenAudioKbps > 0) localParts.push(`rx screenAudio ${formatKbps(totals.rxScreenAudioKbps)}`);

  if (localParts.length > 0) {
    peerBlocks.unshift(
      `<div class="diag-peer"><div class="diag-title">You</div><div class="diag-row">${localParts
        .map((part) => `<span class="diag-chip">${part}</span>`)
        .join("")}</div></div>`
    );
  }

  diagnosticsBody.innerHTML =
    peerBlocks.length > 0 ? peerBlocks.join("") : "<div class=\"diag-peer\">No active peers.</div>";
}

function startDiagnostics() {
  if (diagnosticsInterval) return;
  diagnosticsInterval = setInterval(buildDiagnostics, 2000);
  buildDiagnostics();
}

function stopDiagnostics() {
  if (diagnosticsInterval) {
    clearInterval(diagnosticsInterval);
    diagnosticsInterval = null;
  }
}

function removeRemoteAudioTrack(peerId, trackId) {
  const trackMap = state.peerAudioTracks.get(peerId);
  const entry = trackMap?.get(trackId);
  if (!entry) return false;
  clearAudioMetaCheck(peerId, trackId);
  clearPeerStreamMeta(peerId, entry.streamId);
  const streams = state.peerAudioStreams.get(peerId);
  const audioEls = state.peerAudioEls.get(peerId);
  if (streams) {
    if (streams.mic.getTrackById(entry.track.id)) {
      streams.mic.removeTrack(entry.track);
    }
    if (streams.screen.getTrackById(entry.track.id)) {
      streams.screen.removeTrack(entry.track);
    }
    if (audioEls) {
      if (streams.mic.getTracks().length === 0) {
        disconnectPeerAudioFromMixer(peerId, "mic");
        audioEls.mic.srcObject = null;
        clearAudioAnalyser(peerId, "mic");
        setPeerSpeaking(peerId, false);
        setMicMuted(peerId, true);
      }
      if (streams.screen.getTracks().length === 0) {
        disconnectPeerAudioFromMixer(peerId, "screen");
        audioEls.screen.srcObject = null;
        clearAudioAnalyser(peerId, "screen");
      }
    }
  }
  trackMap?.delete(trackId);
  const meta = state.peerTrackMeta.get(peerId);
  meta?.delete(trackId);
  return true;
}

function removeRemoteAudioByRole(peerId, mediaType) {
  const trackMap = state.peerAudioTracks.get(peerId);
  if (!trackMap) return false;
  for (const [trackId, entry] of trackMap.entries()) {
    if (entry.type === mediaType) {
      return removeRemoteAudioTrack(peerId, trackId);
    }
  }
  return false;
}

function getPeerCard(peerId) {
  return userList?.querySelector(`[data-peer-id="${peerId}"]`);
}

function removePeerCard(peerId) {
  const card = getPeerCard(peerId);
  if (card) card.remove();
}

function attachLocalControls(card) {
  if (!card || !toggleCameraButton || !toggleScreenButton) return;
  const infoWrap = card.querySelector(".user-info");
  if (!infoWrap) return;
  let selfControls = infoWrap.querySelector(".self-controls");
  if (!selfControls) {
    selfControls = document.createElement("div");
    selfControls.className = "self-controls";
    infoWrap.insertBefore(selfControls, infoWrap.children[1] ?? null);
  }
  if (toggleAllButton) {
    toggleAllButton.classList.add("self-all");
  }
  const buttons = [toggleAllButton, toggleMicButton, toggleCameraButton, toggleScreenButton].filter(Boolean);
  buttons.forEach((button) => {
    if (button && button.parentElement !== selfControls) {
      selfControls.appendChild(button);
    }
  });
  updateToggleButtons();
}

function ensurePeerCard(peerId, name, avatar) {
  const existing = getPeerCard(peerId);
  if (existing) {
    updatePeerProfile(peerId, { name, avatar });
    if (peerId === state.peerId) {
      attachLocalControls(existing);
    }
    return existing;
  }
  const { card } = createPeerCard(peerId, name);
  updatePeerProfile(peerId, { name, avatar });
  if (peerId === state.peerId) {
    attachLocalControls(card);
  }
  return card;
}

function updatePeerName(peerId, name) {
  const card = getPeerCard(peerId);
  if (!card) return;
  const title = card.querySelector(".user-name");
  if (title) title.textContent = name;
  const avatarEls = state.peerAvatarEls.get(peerId);
  if (avatarEls?.fallback) {
    avatarEls.fallback.textContent = getInitials(name);
  }
  const map = state.peerVideoEls.get(peerId);
  if (map) {
    map.forEach((entry) => updateTileLabel(entry, peerId));
  }
}

function attachLocalTrack(peerId, track, key) {
  const pc = state.peerConnections.get(peerId);
  if (!pc) return;

  const senders = state.peerSenders.get(peerId) ?? {};
  const senderKey = key ?? track.kind;
  const forceReadd = senderKey === "screen" || senderKey === "screenAudio" || senderKey === "camera";
  const streamRole = normalizeStreamRole(senderKey);
  const stream = getLocalStreamForRole(streamRole);
  ensureStreamHasTrack(stream, track);

  if (senders[senderKey] && forceReadd) {
    try {
      pc.removeTrack(senders[senderKey]);
    } catch {
      try {
        senders[senderKey].replaceTrack(null);
      } catch {
        // ignore
      }
    }
    delete senders[senderKey];
  }

  if (senders[senderKey]) {
    senders[senderKey].replaceTrack(track);
  } else {
    senders[senderKey] = pc.addTrack(track, stream);
  }

  // Apply bitrate/scale tuning for video senders to improve consistency across browsers.
  void tuneVideoSender(peerId, senderKey, senders[senderKey], track);

  state.peerSenders.set(peerId, senders);
  // If we explicitly marked this peer as the offer initiator (false) during join,
  // don't flip it to true just because we attached tracks. Flipping early causes
  // offer glare where the "old" peer's offer wins, and the "new" peer's mic can
  // be missing from the initial SDP (common on Safari).
  if (state.offerInitiator.get(peerId) !== false) {
    state.offerInitiator.set(peerId, true);
  }
}

function removeLocalTrack(peerId, key) {
  const pc = state.peerConnections.get(peerId);
  if (!pc) return;
  const senders = state.peerSenders.get(peerId);
  if (!senders || !senders[key]) return;
  const streamRole = normalizeStreamRole(key);
  const stream = getLocalStreamForRole(streamRole);
  let currentTrack = null;
  if (streamRole === "mic") currentTrack = state.localAudioTrack;
  if (streamRole === "screenAudio") currentTrack = state.localScreenAudioTrack;
  if (streamRole === "screen") currentTrack = state.localScreenTrack;
  if (streamRole === "camera") currentTrack = state.localCameraTrack;
  if (currentTrack && stream.getTrackById(currentTrack.id)) {
    stream.removeTrack(currentTrack);
  }
  try {
    pc.removeTrack(senders[key]);
  } catch {
    try {
      senders[key].replaceTrack(null);
    } catch {
      // ignore
    }
  }
  delete senders[key];
  state.peerSenders.set(peerId, senders);
  state.offerInitiator.set(peerId, true);
}

function updateLocalPreview() {
  if (state.localScreenTrack) {
    const stream = new MediaStream([state.localScreenTrack]);
    localScreenVideo.srcObject = stream;
    safePlay(localScreenVideo);
  } else {
    localScreenVideo.srcObject = null;
  }

  if (state.localCameraTrack) {
    const stream = new MediaStream([state.localCameraTrack]);
    localCameraVideo.srcObject = stream;
    safePlay(localCameraVideo);
  } else {
    localCameraVideo.srcObject = null;
  }

  localMicStatus.textContent = state.localAudioTrack ? "Mic: on" : "Mic: off";
  localCameraStatus.textContent = state.localCameraTrack ? "Camera: on" : "Camera: off";
  const screenAudioActive = Boolean(state.localScreenAudioTrack);
  const screenAudioLabel = screenAudioActive ? " (audio)" : "";
  localScreenStatus.textContent = state.localScreenTrack
    ? `Screen: on${screenAudioLabel}`
    : "Screen: off";
  updateToggleButtons();
  updateAllButton();
}

function updateAllButton() {
  if (!toggleAllButton) return;
  const allActive = Boolean(state.localAudioTrack && state.localCameraTrack && state.localScreenTrack);
  toggleAllButton.textContent = allActive ? "Disable All" : "Enable All";
}

function updateRoomAudioButtons() {
  const label = state.roomAudioMuted ? "Unmute All" : "Mute All";
  if (toggleRoomAudioButton) {
    toggleRoomAudioButton.textContent = label;
  }
  if (toggleRoomAudioLobbyButton) {
    toggleRoomAudioLobbyButton.textContent = label;
  }
}

function setIconButton(button, iconName, label, isOn) {
  if (!button) return;
  button.innerHTML = ICONS[iconName] ?? "";
  button.classList.add("icon-button");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  if (typeof isOn === "boolean") {
    button.classList.toggle("is-on", isOn);
    button.classList.toggle("is-off", !isOn);
  } else {
    button.classList.remove("is-on", "is-off");
  }
}

function updateToggleButtons() {
  setIconButton(
    toggleMicButton,
    "mic",
    state.localAudioTrack ? "Disable Mic" : "Enable Mic",
    Boolean(state.localAudioTrack)
  );
  setIconButton(
    toggleMicLobbyButton,
    "mic",
    state.localAudioTrack ? "Disable Mic" : "Enable Mic",
    Boolean(state.localAudioTrack)
  );
  setIconButton(
    toggleCameraButton,
    "camera",
    state.localCameraTrack ? "Disable Camera" : "Enable Camera",
    Boolean(state.localCameraTrack)
  );
  setIconButton(
    toggleCameraLobbyButton,
    "camera",
    state.localCameraTrack ? "Disable Camera" : "Enable Camera",
    Boolean(state.localCameraTrack)
  );
  setIconButton(
    toggleScreenButton,
    "screen",
    state.localScreenTrack ? "Stop Sharing" : "Share Screen",
    Boolean(state.localScreenTrack)
  );
}

async function enableMic() {
  if (state.localAudioTrack) return;
  const constraints =
    selectedMicId && selectedMicId.length > 0
      ? { audio: { deviceId: { exact: selectedMicId } } }
      : { audio: true };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getAudioTracks()[0];
  state.localAudioTrack = track;
  track.onended = () => disableMic();
  updateLocalPreview();
  announceTrackMeta(track, TRACK_TYPES.MIC);
  if (state.peerId) {
    ensureAudioAnalyser(state.peerId, "mic", new MediaStream([track]), track.id);
    setMicMuted(state.peerId, false);
  }
  for (const peerId of state.peerConnections.keys()) {
    attachLocalTrack(peerId, track, "audio");
    // Some browsers (notably Safari) can miss negotiationneeded for late-added audio tracks.
    // Force a renegotiation so remote peers receive the mic without requiring a camera toggle.
    createOffer(peerId).catch(() => {});
  }
}

function disableMic() {
  if (!state.localAudioTrack) return;
  const micTrack = state.localAudioTrack;
  announceTrackEnded(micTrack, TRACK_TYPES.MIC);
  micTrack.stop();
  state.localAudioTrack = null;
  if (state.peerId) {
    clearAudioAnalyser(state.peerId, "mic");
    setMicMuted(state.peerId, true);
  }
  for (const peerId of state.peerConnections.keys()) {
    removeLocalTrack(peerId, "audio");
    if (!shouldInitiateOffer(peerId)) {
      createOffer(peerId).catch(() => {});
    }
  }
  updateLocalPreview();
}

async function loadAudioDevices() {
  if (!micSelect || !navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  micSelect.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "System default";
  micSelect.appendChild(defaultOption);

  audioInputs.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    micSelect.appendChild(option);
  });

  if (selectedMicId && audioInputs.some((device) => device.deviceId === selectedMicId)) {
    micSelect.value = selectedMicId;
  } else {
    selectedMicId = "";
    micSelect.value = "";
  }
}

async function loadCameraDevices() {
  if (!cameraSelect || !navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const videoInputs = devices.filter((device) => device.kind === "videoinput");
  cameraSelect.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "System default";
  cameraSelect.appendChild(defaultOption);

  videoInputs.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Camera ${index + 1}`;
    cameraSelect.appendChild(option);
  });

  if (selectedCameraId && videoInputs.some((device) => device.deviceId === selectedCameraId)) {
    cameraSelect.value = selectedCameraId;
  } else {
    selectedCameraId = "";
    cameraSelect.value = "";
  }
}

async function loadOutputDevices() {
  if (!speakerSelect || !navigator.mediaDevices?.enumerateDevices) return;
  if (!outputDeviceSupported()) return;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  speakerSelect.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "System default";
  speakerSelect.appendChild(defaultOption);

  outputs.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Speaker ${index + 1}`;
    speakerSelect.appendChild(option);
  });

  if (selectedSpeakerId && outputs.some((device) => device.deviceId === selectedSpeakerId)) {
    speakerSelect.value = selectedSpeakerId;
  } else {
    selectedSpeakerId = "";
    speakerSelect.value = "";
  }
}

if (micSelect) {
  micSelect.addEventListener("change", async () => {
    selectedMicId = micSelect.value;
    localStorage.setItem("echo-mic-id", selectedMicId);
    if (state.localAudioTrack) {
      disableMic();
      try {
        await enableMic();
      } catch {
        setMessage("Mic permission denied.", true);
      }
    }
  });
}

if (cameraSelect) {
  cameraSelect.addEventListener("change", async () => {
    selectedCameraId = cameraSelect.value;
    localStorage.setItem("echo-camera-id", selectedCameraId);
    if (state.localCameraTrack) {
      disableCamera();
      try {
        await enableCamera();
      } catch {
        setMessage("Camera permission denied.", true);
      }
    }
  });
}

if (speakerSelect) {
  speakerSelect.addEventListener("change", () => {
    selectedSpeakerId = speakerSelect.value;
    localStorage.setItem("echo-speaker-id", selectedSpeakerId);
    applyOutputDeviceToAll();
    if (!outputDeviceSupported()) {
      setMessage("Audio output selection isn't supported in this browser.", true);
    }
  });
}

if (screenQualitySelect) {
  if (!(selectedScreenQuality in SCREEN_QUALITY_PRESETS)) {
    selectedScreenQuality = "native";
  }
  screenQualitySelect.value = selectedScreenQuality;
  screenQualitySelect.addEventListener("change", () => {
    const next = screenQualitySelect.value;
    if (next in SCREEN_QUALITY_PRESETS) {
      selectedScreenQuality = next;
      localStorage.setItem("echo-screen-quality", selectedScreenQuality);
    }
  });
}

if (avatarInput) {
  avatarInput.addEventListener("change", () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setLocalAvatarData(reader.result);
        avatarInput.value = "";
      }
    };
    reader.readAsDataURL(file);
  });
}

if (avatarButton && avatarInput) {
  avatarButton.addEventListener("click", () => {
    avatarInput.click();
  });
}

async function enableScreen() {
  if (state.localScreenTrack) return;
  const preset = SCREEN_QUALITY_PRESETS[selectedScreenQuality] ?? SCREEN_QUALITY_PRESETS.high;
  const videoConstraints = selectedScreenQuality === "native" ? true : preset;
  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: videoConstraints,
    audio: audioConstraints
  });
  const track = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0] ?? null;
  try {
    // Hint to the encoder that this is detail/text-heavy content.
    track.contentHint = "detail";
  } catch {
    // ignore
  }
  state.localScreenTrack = track;
  state.localScreenAudioTrack = audioTrack;
  track.onended = () => disableScreen();
  try {
    clientLog("info", "local_track_settings", {
      mediaType: TRACK_TYPES.SCREEN,
      quality: selectedScreenQuality,
      settings: track.getSettings?.() ?? null
    });
  } catch {
    // ignore
  }
  if (audioTrack) {
    audioTrack.onended = () => {
      announceTrackEnded(audioTrack, TRACK_TYPES.SCREEN_AUDIO);
      state.localScreenAudioTrack = null;
      if (state.peerId) {
        clearAudioAnalyser(state.peerId, "screen");
      }
      for (const peerId of state.peerConnections.keys()) {
        removeLocalTrack(peerId, "screenAudio");
        if (!shouldInitiateOffer(peerId)) {
          createOffer(peerId).catch(() => {});
        }
      }
      updateLocalPreview();
    };
  }
  if (audioTrack) {
    announceTrackMeta(audioTrack, TRACK_TYPES.SCREEN_AUDIO);
    if (state.peerId) {
      ensureAudioAnalyser(state.peerId, "screen", new MediaStream([audioTrack]), audioTrack.id);
    }
  } else {
    setMessage(
      "Screen audio was not included. In the share dialog, enable the tab/system audio checkbox.",
      true
    );
  }
  announceTrackMeta(track, TRACK_TYPES.SCREEN);
  if (state.peerId) {
    attachRemoteVideoTrack(state.peerId, track);
  }
  updateLocalPreview();
  for (const peerId of state.peerConnections.keys()) {
    attachLocalTrack(peerId, track, "screen");
    if (audioTrack) {
      attachLocalTrack(peerId, audioTrack, "screenAudio");
    }
    // For peers where we are not the default offerer (common when they joined after us),
    // negotiationneeded is suppressed to reduce glare. Force renegotiation so screen tracks propagate.
    if (!shouldInitiateOffer(peerId)) {
      createOffer(peerId).catch(() => {});
    }
  }
}

function disableScreen() {
  if (!state.localScreenTrack) return;
  const screenTrack = state.localScreenTrack;
  announceTrackEnded(screenTrack, TRACK_TYPES.SCREEN);
  if (state.peerId) {
    removeRemoteVideoTrack(state.peerId, screenTrack.id);
  }
  screenTrack.stop();
  state.localScreenTrack = null;
  if (state.localScreenAudioTrack) {
    announceTrackEnded(state.localScreenAudioTrack, TRACK_TYPES.SCREEN_AUDIO);
    state.localScreenAudioTrack.stop();
    state.localScreenAudioTrack = null;
    if (state.peerId) {
      clearAudioAnalyser(state.peerId, "screen");
    }
  }
  for (const peerId of state.peerConnections.keys()) {
    removeLocalTrack(peerId, "screen");
    removeLocalTrack(peerId, "screenAudio");
    if (!shouldInitiateOffer(peerId)) {
      createOffer(peerId).catch(() => {});
    }
  }
  updateLocalPreview();
}

async function applyCameraCapConstraints(track) {
  if (!track || typeof track.getCapabilities !== "function" || typeof track.applyConstraints !== "function") {
    return;
  }
  const caps = track.getCapabilities();
  const constraints = {};
  if (caps.width && Number.isFinite(caps.width.max)) {
    constraints.width = { ideal: Math.min(caps.width.max, CAMERA_CAP.width), max: CAMERA_CAP.width };
  } else {
    constraints.width = { ideal: CAMERA_CAP.width, max: CAMERA_CAP.width };
  }
  if (caps.height && Number.isFinite(caps.height.max)) {
    constraints.height = { ideal: Math.min(caps.height.max, CAMERA_CAP.height), max: CAMERA_CAP.height };
  } else {
    constraints.height = { ideal: CAMERA_CAP.height, max: CAMERA_CAP.height };
  }
  if (caps.frameRate && Number.isFinite(caps.frameRate.max)) {
    constraints.frameRate = { ideal: Math.min(caps.frameRate.max, CAMERA_CAP.frameRate), max: CAMERA_CAP.frameRate };
  } else {
    constraints.frameRate = { ideal: CAMERA_CAP.frameRate, max: CAMERA_CAP.frameRate };
  }
  try {
    await track.applyConstraints(constraints);
  } catch (error) {
    // If the device can't satisfy the cap, we keep the original track rather than failing camera entirely.
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    clientLog("warn", "camera_constraints_failed", { message });
  }
}

async function enableCamera() {
  if (state.localCameraTrack) return;
  const video = {
    width: { ideal: CAMERA_CAP.width, max: CAMERA_CAP.width },
    height: { ideal: CAMERA_CAP.height, max: CAMERA_CAP.height },
    frameRate: { ideal: CAMERA_CAP.frameRate, max: CAMERA_CAP.frameRate }
  };
  if (selectedCameraId && selectedCameraId.length > 0) {
    video.deviceId = { exact: selectedCameraId };
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch {
    // Fallback if the device can't honor the strict cap.
    const fallbackVideo = selectedCameraId && selectedCameraId.length > 0 ? { deviceId: { exact: selectedCameraId } } : true;
    stream = await navigator.mediaDevices.getUserMedia({ video: fallbackVideo, audio: false });
  }
  const track = stream.getVideoTracks()[0];
  try {
    track.contentHint = "motion";
  } catch {
    // ignore
  }
  await applyCameraCapConstraints(track);
  state.localCameraTrack = track;
  track.onended = () => disableCamera();
  announceTrackMeta(track, TRACK_TYPES.CAMERA);
  try {
    clientLog("info", "local_track_settings", { mediaType: TRACK_TYPES.CAMERA, settings: track.getSettings?.() ?? null });
  } catch {
    // ignore
  }
  if (state.peerId) {
    attachRemoteVideoTrack(state.peerId, track);
  }
  updateLocalPreview();
  for (const peerId of state.peerConnections.keys()) {
    attachLocalTrack(peerId, track, "camera");
    if (!shouldInitiateOffer(peerId)) {
      createOffer(peerId).catch(() => {});
    }
  }
}

function disableCamera() {
  if (!state.localCameraTrack) return;
  const cameraTrack = state.localCameraTrack;
  announceTrackEnded(cameraTrack, TRACK_TYPES.CAMERA);
  if (state.peerId) {
    removeRemoteVideoTrack(state.peerId, cameraTrack.id);
  }
  cameraTrack.stop();
  state.localCameraTrack = null;
  for (const peerId of state.peerConnections.keys()) {
    removeLocalTrack(peerId, "camera");
    if (!shouldInitiateOffer(peerId)) {
      createOffer(peerId).catch(() => {});
    }
  }
  updateLocalPreview();
}

async function enableAllMedia() {
  if (!state.localAudioTrack) {
    try {
      await enableMic();
    } catch {
      setMessage("Mic permission denied.", true);
    }
  }

  if (!state.localCameraTrack) {
    try {
      await enableCamera();
    } catch {
      setMessage("Camera permission denied.", true);
    }
  }

  const screenDisabled = toggleScreenButton?.classList.contains("is-disabled");
  if (!state.localScreenTrack && !screenDisabled) {
    try {
      await enableScreen();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error ?? "Unknown error");
      setMessage(`Screen share failed: ${reason}`, true);
    }
  } else if (screenDisabled && !state.localScreenTrack) {
    const reason = toggleScreenButton?.dataset.disabledReason ?? "Screen sharing isn't supported on this device.";
    setMessage(reason, true);
  }
}

function disableAllMedia() {
  disableMic();
  disableCamera();
  disableScreen();
}

function createPeerConnection(peerId) {
  const iceServers = Array.isArray(state.iceServers) ? state.iceServers : DEFAULT_ICE;
  const pc = new RTCPeerConnection({ iceServers });
  state.peerConnections.set(peerId, pc);
  if (!state.offerInitiator.has(peerId)) {
    state.offerInitiator.set(peerId, true);
  }

  pc.onnegotiationneeded = async () => {
    if (!shouldInitiateOffer(peerId)) {
      return;
    }
    await createOffer(peerId);
  };

  pc.onsignalingstatechange = () => {
    if (pc.signalingState === "stable" && state.pendingNegotiation.get(peerId)) {
      state.pendingNegotiation.set(peerId, false);
      createOffer(peerId).catch(() => {});
    }
  };

  pc.oniceconnectionstatechange = () => {
    const stateLabel = pc.iceConnectionState;
    if (stateLabel === "failed") {
      requestIceRestart(peerId, pc, "ice_failed");
    } else if (stateLabel === "disconnected") {
      scheduleIceRestart(peerId, pc);
    }
    clientLog("info", "ice_state", { peerId, state: stateLabel });
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: "signal", to: peerId, data: { type: "candidate", candidate: event.candidate } });
    }
  };

  pc.ontrack = (event) => {
    const profile = state.peerProfiles.get(peerId);
    const name = profile?.name ?? "Guest";
    const avatar = profile?.avatar;
    clientLog("info", "track_received", {
      peerId,
      kind: event.track.kind,
      trackId: event.track.id,
      label: event.track.label || "",
      streams: (event.streams || []).map((stream) => stream.id)
    });
    if (event.track.kind === "video") {
      ensurePeerCard(peerId, name, avatar);
      attachRemoteVideoTrack(peerId, event.track, event.streams);
    } else {
      ensurePeerCard(peerId, name, avatar);
      registerRemoteAudioTrack(peerId, event.track, event.streams);
    }
  };

  pc.onconnectionstatechange = () => {
    const stateLabel = pc.connectionState;
    if (stateLabel === "failed") {
      requestIceRestart(peerId, pc, "connection_failed");
    }
    clientLog("info", "connection_state", { peerId, state: stateLabel });
  };

  if (state.localAudioTrack) {
    attachLocalTrack(peerId, state.localAudioTrack, "audio");
  }

  if (state.localScreenTrack) {
    attachLocalTrack(peerId, state.localScreenTrack, "screen");
  }
  if (state.localScreenAudioTrack) {
    attachLocalTrack(peerId, state.localScreenAudioTrack, "screenAudio");
  }

  if (state.localCameraTrack) {
    attachLocalTrack(peerId, state.localCameraTrack, "camera");
  }
  if (!state.pendingCandidates.has(peerId)) {
    state.pendingCandidates.set(peerId, []);
  }
  if (!state.pendingNegotiation.has(peerId)) {
    state.pendingNegotiation.set(peerId, false);
  }
  return pc;
}

async function handleDescription(peerId, description) {
  const pc = state.peerConnections.get(peerId) ?? createPeerConnection(peerId);
  const polite = state.peerId ? state.peerId.localeCompare(peerId) < 0 : true;
  const makingOffer = state.makingOffer.get(peerId);
  const isSettingRemoteAnswerPending = state.isSettingRemoteAnswerPending.get(peerId);
  const readyForOffer = !makingOffer && (pc.signalingState === "stable" || isSettingRemoteAnswerPending);
  const offerCollision = description.type === "offer" && !readyForOffer;
  const ignoreOffer = !polite && offerCollision;
  if (offerCollision) {
    clientLog("warn", "offer_collision", {
      peerId,
      polite,
      signalingState: pc.signalingState,
      makingOffer: Boolean(makingOffer),
      settingRemoteAnswerPending: Boolean(isSettingRemoteAnswerPending)
    });
  }
  state.ignoreOffer.set(peerId, ignoreOffer);
  if (ignoreOffer) {
    clientLog("warn", "offer_ignored", { peerId, polite, signalingState: pc.signalingState });
    return;
  }

  // Perfect negotiation: on offer glare, the polite peer rolls back its local offer before applying the remote one.
  if (offerCollision && description.type === "offer" && polite && pc.signalingState !== "stable") {
    const before = pc.signalingState;
    try {
      await pc.setLocalDescription({ type: "rollback" });
      clientLog("warn", "offer_rollback", { peerId, before });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      clientLog("warn", "offer_rollback_failed", { peerId, before, message });
    }
  }

  state.isSettingRemoteAnswerPending.set(peerId, description.type === "answer");
  try {
    await pc.setRemoteDescription(description);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    clientLog("error", "set_remote_description_failed", {
      peerId,
      type: description.type,
      signalingState: pc.signalingState,
      message
    });
    state.isSettingRemoteAnswerPending.set(peerId, false);
    return;
  }
  state.isSettingRemoteAnswerPending.set(peerId, false);
  if (description.type === "offer" || description.type === "answer") {
    state.offerInitiator.set(peerId, true);
  }

  if (description.type === "offer") {
    await pc.setLocalDescription();
    send({ type: "signal", to: peerId, data: pc.localDescription });
  }

  flushPendingCandidates(peerId, pc);
}

async function handleCandidate(peerId, data) {
  const pc = state.peerConnections.get(peerId);
  if (!pc) return;
  try {
    if (!pc.remoteDescription) {
      const queue = state.pendingCandidates.get(peerId) ?? [];
      queue.push(data.candidate);
      state.pendingCandidates.set(peerId, queue);
      return;
    }
    await pc.addIceCandidate(data.candidate);
  } catch {
    // Ignore ICE errors for transient disconnects
  }
}

function requestIceRestart(peerId, pc, reason) {
  const now = Date.now();
  const last = state.peerIceRestartAt.get(peerId) ?? 0;
  if (now - last < 10000) return;
  state.peerIceRestartAt.set(peerId, now);
  state.pendingIceRestart.add(peerId);
  clientLog("warn", "ice_restart", {
    peerId,
    reason,
    iceState: pc.iceConnectionState,
    connectionState: pc.connectionState
  });
  createOffer(peerId).catch(() => {});
}

function scheduleIceRestart(peerId, pc) {
  setTimeout(() => {
    if (pc.iceConnectionState === "disconnected" && pc.connectionState !== "closed") {
      requestIceRestart(peerId, pc, "ice_disconnected");
    }
  }, 2500);
}

async function createOffer(peerId) {
  const pc = state.peerConnections.get(peerId) ?? createPeerConnection(peerId);
  if (state.makingOffer.get(peerId)) {
    state.pendingNegotiation.set(peerId, true);
    return;
  }
  if (pc.signalingState !== "stable") {
    state.pendingNegotiation.set(peerId, true);
    return;
  }
  state.makingOffer.set(peerId, true);
  try {
    const wantsRestart = state.pendingIceRestart.has(peerId);
    const offer = await pc.createOffer(wantsRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    if (wantsRestart) {
      state.pendingIceRestart.delete(peerId);
    }
    send({ type: "signal", to: peerId, data: pc.localDescription });
  } finally {
    state.makingOffer.set(peerId, false);
    if (state.pendingNegotiation.get(peerId) && pc.signalingState === "stable") {
      state.pendingNegotiation.set(peerId, false);
      setTimeout(() => {
        createOffer(peerId).catch(() => {});
      }, 0);
    }
  }
}

function flushPendingCandidates(peerId, pc) {
  const queue = state.pendingCandidates.get(peerId);
  if (!queue || !queue.length || !pc.remoteDescription) return;
  queue.forEach((candidate) => {
    pc.addIceCandidate(candidate).catch(() => {});
  });
  state.pendingCandidates.set(peerId, []);
}

function removePeer(peerId) {
  const pc = state.peerConnections.get(peerId);
  if (pc) pc.close();
  state.peerConnections.delete(peerId);
  state.peerSenders.delete(peerId);
  state.pendingNegotiation.delete(peerId);
  state.offerInitiator.delete(peerId);
  removePeerVideoTiles(peerId);
  // Clean up any WebAudio graph nodes to avoid leaks/duplicate audio after reconnects.
  disconnectPeerAudioFromMixer(peerId, "mic");
  disconnectPeerAudioFromMixer(peerId, "screen");
  clearAudioAnalyser(peerId, "mic");
  clearAudioAnalyser(peerId, "screen");
  state.peerAudioEls.delete(peerId);
  state.peerAudioStreams.delete(peerId);
  state.peerTrackMeta.delete(peerId);
  state.peerStreamMeta.delete(peerId);
  state.peerAudioTracks.delete(peerId);
  state.peerAvatarEls.delete(peerId);
  state.peerProfiles.delete(peerId);
  state.peerWatchButtons.delete(peerId);
  state.hiddenScreenPeers.delete(peerId);
  pendingRoleMeta.delete(peerId);
  pendingAudioMeta.delete(peerId);
  removePeerCard(peerId);
  statsHistory.forEach((_value, key) => {
    if (key.startsWith(`${peerId}:`)) {
      statsHistory.delete(key);
    }
  });
}

function cleanupRoom() {
  for (const peerId of state.peerConnections.keys()) {
    removePeer(peerId);
  }
  if (roomAudioMixer) {
    roomAudioMixer.nodes.forEach((node) => {
      try {
        node.source.disconnect();
      } catch {
        // ignore
      }
      try {
        node.gain.disconnect();
      } catch {
        // ignore
      }
    });
    roomAudioMixer.nodes.clear();
  }
  state.roomId = null;
  state.peerId = null;
  state.hiddenScreenPeers.clear();
  state.peerWatchButtons.clear();
  state.peerAvatarEls.clear();
  state.peerProfiles.clear();
  state.peerAudioEls.clear();
  state.peerAudioStreams.clear();
  state.peerTrackMeta.clear();
  state.peerStreamMeta.clear();
  state.peerAudioTracks.clear();
  pendingRoleMeta.clear();
  pendingAudioMeta.clear();
  if (userList) userList.innerHTML = "";
  if (screenGrid) screenGrid.innerHTML = "";
  if (cameraGrid) cameraGrid.innerHTML = "";
  clearFocusedScreen();
  clearFocusedCamera();
  updateCameraLobbyEmptyState();
  if (cameraLobbyPanel) {
    cameraLobbyPanel.classList.add("hidden");
  }
  clearSoundboardState();
  setStatus("Offline");
  if (audioHealthInterval) {
    clearInterval(audioHealthInterval);
    audioHealthInterval = null;
  }
  stopAudioMeters();
  if (diagnosticsInterval) {
    clearInterval(diagnosticsInterval);
    diagnosticsInterval = null;
  }
  renderRoomList();
}

function waitForWebSocketClose(ws, timeoutMs = 800) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        finish();
      },
      { once: true }
    );
  });
}

async function ensureWebSocketClosed(timeoutMs = 800) {
  const ws = state.ws;
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  try {
    ws.close();
  } catch {
    // ignore
  }
  await waitForWebSocketClose(ws, timeoutMs);
}

function connectWebSocket() {
  if (!state.token) {
    setMessage("Missing token. Please log in again.", true);
    return;
  }

  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  setStatus("Connecting...");
  setMessage("Connecting...", false);
  const connectTimeout = setTimeout(() => {
    if (state.ws !== ws) return;
    if (ws.readyState !== WebSocket.OPEN) {
      setMessage("Unable to connect. If this is a remote join, accept the certificate warning and retry.", true);
      setJoinFormEnabled(true);
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }, 8000);

  ws.onopen = () => {
    if (state.ws !== ws) return;
    clearTimeout(connectTimeout);
    setStatus("Connected");
    send({
      type: "join",
      roomId: state.roomId,
      displayName: state.displayName,
      avatar: getAvatarPayload()
    });
  };

  ws.onmessage = async (event) => {
    if (state.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

      if (msg.type === "joined") {
        state.peerId = msg.peerId;
        setStatus(`Room: ${msg.roomId}`);
        showCall();
        renderRoomList();
        void loadSoundboardList();
        startAudioHealthCheck();
        startAudioMeters();
        ensurePeerCard(msg.peerId, state.displayName ?? "Me", localAvatarData || undefined);
        try {
          // Enable mic before creating offers so the initial SDP includes an audio m-line.
          await enableMic();
        } catch {
          setMessage("Mic permission denied.", true);
        }
      for (const peer of msg.peers ?? []) {
        ensurePeerCard(peer.id, peer.name, peer.avatar);
        state.offerInitiator.set(peer.id, true);
        createPeerConnection(peer.id);
        await createOffer(peer.id);
      }
      announceCurrentTrackMeta();
        return;
    }

    if (msg.type === "peer-joined") {
      ensurePeerCard(msg.id, msg.name, msg.avatar);
      state.offerInitiator.set(msg.id, false);
      createPeerConnection(msg.id);
      announceCurrentTrackMeta();
      if (msg.id && msg.id !== state.peerId) {
        playChime("join");
      }
      return;
    }

    if (msg.type === "peer-left") {
      removePeer(msg.id);
      if (msg.id && msg.id !== state.peerId) {
        playChime("leave");
      }
      return;
    }

    if (msg.type === "peer-updated") {
      updatePeerProfile(msg.id, { name: msg.name, avatar: msg.avatar });
      return;
    }

    if (msg.type === "rooms") {
      if (Array.isArray(msg.rooms)) {
        activeRooms = msg.rooms;
        renderRoomList();
      }
      return;
    }

    if (msg.type === "sound-added") {
      if (msg.sound) {
        upsertSoundboardSound(msg.sound);
      }
      return;
    }

    if (msg.type === "sound-updated") {
      if (msg.sound) {
        upsertSoundboardSound(msg.sound);
      }
      return;
    }

    if (msg.type === "sound-play") {
      if (msg.soundId) {
        void playSoundboardSound(msg.soundId);
      }
      return;
    }

    if (msg.type === "track-meta") {
      if (msg.peerId && msg.trackId && msg.mediaType) {
        setPeerTrackMeta(msg.peerId, msg.trackId, msg.mediaType, msg.streamId);
        if (msg.mediaType === TRACK_TYPES.MIC) {
          setMicMuted(msg.peerId, false);
        }
      }
      return;
    }

    if (msg.type === "track-ended") {
      if (msg.peerId && msg.trackId) {
        const removedVideo = removeRemoteVideoTrack(msg.peerId, msg.trackId);
        const removedAudio = removeRemoteAudioTrack(msg.peerId, msg.trackId);
        if (msg.mediaType) {
          if (!removedVideo && (msg.mediaType === TRACK_TYPES.SCREEN || msg.mediaType === TRACK_TYPES.CAMERA)) {
            removeRemoteVideoByRole(msg.peerId, msg.mediaType);
          }
          if (!removedAudio && (msg.mediaType === TRACK_TYPES.MIC || msg.mediaType === TRACK_TYPES.SCREEN_AUDIO)) {
            removeRemoteAudioByRole(msg.peerId, msg.mediaType);
          }
          if (msg.mediaType === TRACK_TYPES.MIC) {
            setMicMuted(msg.peerId, true);
          }
        }
      }
      return;
    }

    if (msg.type === "signal") {
      if (msg.data?.type === "offer" || msg.data?.type === "answer") {
        await handleDescription(msg.from, msg.data);
      } else if (msg.data?.type === "candidate") {
        await handleCandidate(msg.from, msg.data);
      }
      return;
    }

    if (msg.type === "error") {
      if (msg.message === "Invalid message") {
        return;
      }
      setMessage(msg.message ?? "An error occurred.", true);
      state.ws?.close();
    }
  };

  ws.onerror = () => {
    if (state.ws !== ws) return;
    clearTimeout(connectTimeout);
    setMessage("Connection error. Please refresh and try again.", true);
    setJoinFormEnabled(true);
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    clearTimeout(connectTimeout);
    setStatus("Disconnected");
    cleanupRoom();
    setJoinFormEnabled(true);
    showLobby();
    state.ws = null;
  };
}

async function joinRoom(displayName, roomName) {
  state.displayName = displayName;
  state.roomId = roomName;
  localStorage.setItem("echo-display-name", displayName);
  localStorage.setItem("echo-room-name", roomName);
  setMessage("");
  setJoinFormEnabled(false);
  renderRoomList();
  await ensureWebSocketClosed(800);
  connectWebSocket();
}

function leaveRoom() {
  send({ type: "leave" });
  state.ws?.close();
  disableMic();
  disableScreen();
  cleanupRoom();
  setJoinFormEnabled(true);
  showLobby();
}

async function switchRoom(nextRoomId) {
  const target = String(nextRoomId || "").trim();
  if (!target) return;
  if (target === state.roomId) return;
  const displayName = state.displayName ?? displayNameInput.value.trim();
  if (!displayName) {
    roomNameInput.value = target;
    showLobby();
    return;
  }
  leaveRoom();
  roomNameInput.value = target;
  await joinRoom(displayName, target);
}

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("");
    try {
      await login(passwordInput.value);
      const shouldRemember = isDesktopApp ? true : Boolean(rememberPasswordInput?.checked);
      if (shouldRemember) {
        localStorage.setItem("echo-password", passwordInput.value);
        if (isDesktopApp) {
          localStorage.setItem(DESKTOP_PASSWORD_KEY, passwordInput.value);
        }
        localStorage.setItem("echo-remember", "true");
        savedPassword = passwordInput.value;
        rememberPassword = true;
        persistDesktopPrefs({ password: passwordInput.value });
      } else {
        localStorage.removeItem("echo-password");
        if (isDesktopApp) {
          localStorage.removeItem(DESKTOP_PASSWORD_KEY);
        }
        localStorage.setItem("echo-remember", "false");
        savedPassword = "";
        rememberPassword = false;
        persistDesktopPrefs({ password: "" });
      }
    await loadConfig();
    showLobby();
  } catch {
    setMessage("Login failed. Check the password.", true);
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  primeRoomAudioMixer();
  primeSoundboardAudio();
  resumeMediaPlayback();
  if (!state.token) {
    setMessage("Missing token. Please unlock again.", true);
    return;
  }
  const displayName = displayNameInput.value.trim();
  const roomName = (roomNameInput?.value ?? "main").trim() || "main";
  if (!displayName) {
    setMessage("Display name is required.", true);
    return;
  }
  await joinRoom(displayName, roomName);
});

copyLinkButton.addEventListener("click", async () => {
  const roomName = state.roomId || roomNameInput.value.trim() || "main";
  const url = `${location.origin}/?room=${encodeURIComponent(roomName)}`;
  const ok = await copyTextToClipboard(url);
  if (ok) {
    setShareHint("Copied room link to clipboard.", false, 1500);
    return;
  }
  setShareHint("Unable to copy link. Your browser may block clipboard access.", true, 2500);
});

if (toggleAllButton) {
  toggleAllButton.addEventListener("click", async () => {
    const allActive = Boolean(state.localAudioTrack && state.localCameraTrack && state.localScreenTrack);
    if (allActive) {
      disableAllMedia();
      return;
    }
    await enableAllMedia();
  });
}


if (diagnosticsToggle) {
  diagnosticsToggle.addEventListener("click", () => {
    if (!diagnosticsPanel) return;
    diagnosticsPanel.classList.toggle("is-collapsed");
    if (diagnosticsPanel.classList.contains("is-collapsed")) {
      stopDiagnostics();
    } else {
      startDiagnostics();
    }
  });
}

if (diagnosticsClose) {
  diagnosticsClose.addEventListener("click", () => {
    if (!diagnosticsPanel) return;
    diagnosticsPanel.classList.add("is-collapsed");
    stopDiagnostics();
  });
}

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
    localStorage.setItem("echo-soundboard-volume", String(soundboardUserVolume));
    updateSoundboardVolumeUi();
  });
}

if (soundClipVolumeInput) {
  soundClipVolumeInput.addEventListener("input", () => {
    const value = Number(soundClipVolumeInput.value);
    const normalized = Number.isFinite(value) ? Math.min(200, Math.max(0, value)) : 100;
    if (!soundboardEditingId) {
      soundboardClipVolume = normalized;
      localStorage.setItem("echo-soundboard-clip-volume", String(soundboardClipVolume));
    }
    updateSoundClipVolumeUi(normalized);
  });
}

if (soundSearchInput) {
  soundSearchInput.addEventListener("input", () => {
    renderSoundboard();
  });
}

if (soundFileInput) {
  soundFileInput.addEventListener("change", () => {
    updateSoundFileLabel();
    const file = soundFileInput.files?.[0];
    if (!file) return;
    const hasName = Boolean((soundNameInput?.value ?? "").trim());
    if (!hasName && file.name) {
      const suggestion = file.name.replace(/\.[^/.]+$/, "").slice(0, 60);
      if (soundNameInput) soundNameInput.value = suggestion;
    }
  });
}

if (soundUploadButton) {
  soundUploadButton.addEventListener("click", () => {
    void uploadSoundboardSound();
  });
}

if (soundCancelEditButton) {
  soundCancelEditButton.addEventListener("click", () => {
    exitSoundboardEditMode();
    setSoundboardHint("");
  });
}

if (soundNameInput) {
  soundNameInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void uploadSoundboardSound();
  });
}

if (toggleRoomAudioButton) {
  toggleRoomAudioButton.addEventListener("click", () => {
    setRoomAudioMuted(!state.roomAudioMuted);
  });
}

if (toggleRoomAudioLobbyButton) {
  toggleRoomAudioLobbyButton.addEventListener("click", () => {
    setRoomAudioMuted(!state.roomAudioMuted);
  });
}

if (toggleMicLobbyButton) {
  toggleMicLobbyButton.addEventListener("click", async () => {
    if (state.localAudioTrack) {
      disableMic();
    } else {
      try {
        await enableMic();
      } catch {
        setMessage("Mic permission denied.", true);
      }
    }
  });
}

if (toggleCameraLobbyButton) {
  toggleCameraLobbyButton.addEventListener("click", async () => {
    if (state.localCameraTrack) {
      disableCamera();
    } else {
      try {
        await enableCamera();
      } catch {
        setMessage("Camera permission denied.", true);
      }
    }
  });
}

if (openSettingsButton && settingsPanel) {
  openSettingsButton.addEventListener("click", () => {
    settingsPanel.classList.remove("hidden");
  });
}

if (closeSettingsButton && settingsPanel) {
  closeSettingsButton.addEventListener("click", () => {
    settingsPanel.classList.add("hidden");
  });
}

if (settingsPanel) {
  settingsPanel.addEventListener("click", (event) => {
    if (event.target === settingsPanel) {
      settingsPanel.classList.add("hidden");
    }
  });
}

if (openAdminButton) {
  openAdminButton.addEventListener("click", () => {
    openAdminPanel();
  });
}

if (adminCloseButton) {
  adminCloseButton.addEventListener("click", () => {
    closeAdminPanel();
  });
}

if (adminPanel) {
  adminPanel.addEventListener("click", (event) => {
    if (event.target === adminPanel) {
      closeAdminPanel();
    }
  });
}

if (adminLoginButton && adminPasswordInput) {
  adminLoginButton.addEventListener("click", async () => {
    const password = adminPasswordInput.value.trim();
    if (!password) {
      showAdminLogin("Enter the admin password.");
      return;
    }
    try {
      await adminLogin(password);
      await refreshAdmin();
    } catch {
      showAdminLogin("Admin login failed.");
    }
  });
}

if (adminPasswordInput) {
  adminPasswordInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (adminLoginButton) {
      adminLoginButton.click();
    }
  });
}

if (adminRefreshButton) {
  adminRefreshButton.addEventListener("click", () => {
    void refreshAdmin();
  });
}

if (adminRefreshLogsButton) {
  adminRefreshLogsButton.addEventListener("click", () => {
    void refreshAdmin();
  });
}

if (adminRestartButton) {
  adminRestartButton.addEventListener("click", async () => {
    if (!confirm("Restart the server and disconnect everyone?")) return;
    await adminSoftRestart();
  });
}

if (adminLogoutButton) {
  adminLogoutButton.addEventListener("click", () => {
    clearAdminToken();
    showAdminLogin("Signed out.");
  });
}

if (restartAppButton) {
  if (isDesktopApp) {
    restartAppButton.classList.remove("hidden");
    restartAppButton.addEventListener("click", async () => {
      const bridge = window.echoDesktop;
      if (bridge && typeof bridge.restart === "function") {
        await bridge.restart();
      } else {
        location.reload();
      }
    });
  } else {
    restartAppButton.classList.add("hidden");
  }
}

toggleMicButton.addEventListener("click", async () => {
  if (state.localAudioTrack) {
    disableMic();
  } else {
    try {
      await enableMic();
    } catch {
      setMessage("Mic permission denied.", true);
    }
  }
});

toggleCameraButton.addEventListener("click", async () => {
  if (state.localCameraTrack) {
    disableCamera();
  } else {
    try {
      await enableCamera();
    } catch {
      setMessage("Camera permission denied.", true);
    }
  }
});

toggleScreenButton.addEventListener("click", async () => {
  if (toggleScreenButton.classList.contains("is-disabled")) {
    const reason = toggleScreenButton.dataset.disabledReason || "Screen sharing isn't supported on this device.";
    setMessage(reason, true);
    alert(reason);
    return;
  }
  if (state.localScreenTrack) {
    disableScreen();
  } else {
    try {
      await enableScreen();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error ?? "Unknown error");
      setMessage(`Screen share failed: ${reason}`, true);
    }
  }
});

leaveRoomButton.addEventListener("click", () => {
  leaveRoom();
});

if (createRoomButton) {
  createRoomButton.addEventListener("click", async () => {
    if (!state.token) {
      setMessage("Please unlock first.", true);
      return;
    }
    const suggestion = roomNameInput.value.trim() || "new-room";
    const nextRoom = window.prompt("Create new room", suggestion);
    if (!nextRoom) return;
    const trimmed = nextRoom.trim();
    if (!trimmed) return;
    await switchRoom(trimmed);
  });
}

(async () => {
  await resolveOutputDeviceSupport();
  await loadAudioDevices();
  await loadCameraDevices();
  await loadOutputDevices();
  await hydrateDesktopPrefs();
  navigator.mediaDevices?.addEventListener("devicechange", loadAudioDevices);
  navigator.mediaDevices?.addEventListener("devicechange", loadCameraDevices);
  navigator.mediaDevices?.addEventListener("devicechange", loadOutputDevices);
  setupOutputDeviceAvailability();
  setupScreenShareAvailability();
  if (screenQualitySelect && selectedScreenQuality in SCREEN_QUALITY_PRESETS) {
    screenQualitySelect.value = selectedScreenQuality;
  }
  updateRoomAudioButtons();
  updateAllButton();
  const urlParams = new URLSearchParams(location.search);
  const roomParam = urlParams.get("room");
  roomNameInput.value = roomParam ? roomParam : "main";
  const savedName = localStorage.getItem("echo-display-name");
  if (savedName) {
    displayNameInput.value = savedName;
  }
  // Always default to "main" unless a ?room= link is provided.

  const ok = await verifyToken();
  if (rememberPasswordInput) {
    rememberPasswordInput.checked = rememberPassword;
    if (isDesktopApp) {
      rememberPasswordInput.checked = true;
    }
  }
  updateAvatarButtonState();
  if (rememberPassword && savedPassword) {
    passwordInput.value = savedPassword;
  }

  if (ok) {
    await loadConfig();
    showLobby();
  } else if (rememberPassword && savedPassword) {
    try {
      await login(savedPassword);
      await loadConfig();
      showLobby();
    } catch {
      showLogin();
      setMessage("Saved password failed. Please unlock again.", true);
    }
  } else {
    showLogin();
  }
})();
