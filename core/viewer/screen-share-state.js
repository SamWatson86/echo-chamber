/* =========================================================
   SCREEN SHARE — Shared state variables and constants
   Loaded FIRST, before all other screen-share-*.js modules.
   ========================================================= */

// ── Stream quality warning state ──
var _qualityWarnUnlisten = null;    // Tauri event unlisten function
var _qualityWarnLowSince = 0;       // timestamp when FPS first dropped below threshold
var _qualityWarnShowing = false;     // whether banner is currently visible
var _qualityWarnDismissed = false;   // dismissed for this session
var _qualityWarnBannerEl = null;     // DOM element
// Capture is intentionally capped at 30fps in capture_pipeline.rs.
// Under multi-publisher GPU contention, capture floats 22-28fps which is
// fine — only warn when it drops below 18fps (real degradation).
const QUALITY_WARN_FPS_THRESHOLD = 18;
const QUALITY_WARN_DURATION_MS = 5000;

// ── Screen share track refs (so we can unpublish on stop) ──
let _screenShareVideoTrack = null;
let _screenShareAudioTrack = null;
let _screenShareStatsInterval = null;

// ── Inbound stats tracking ──
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

// ── Native audio state ──
var _nativeAudioCtx = null;        // AudioContext for worklet
var _nativeAudioWorklet = null;     // AudioWorkletNode
var _nativeAudioDest = null;        // MediaStreamDestination
var _nativeAudioTrack = null;       // Published LiveKit track
var _nativeAudioUnlisten = null;    // Tauri event unlisten function
var _nativeAudioActive = false;

// NOTE: The following state variables are declared in state.js (loaded earlier):
//   _latestScreenStats, _cameraReducedForScreenShare, _bwLimitedCount,
//   _bweLowTicks, _bweKickAttempted, _highPausedTicks, _latestOutboundBwe,
//   _bitrateCaps, _currentAppliedCap, _bitrateCapCleanupTimer,
//   BITRATE_CAP_TTL, BITRATE_DEFAULT_HIGH, BITRATE_DEFAULT_MED, BITRATE_DEFAULT_LOW
