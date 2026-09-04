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
// Desktop sharing stays conservative, while game capture can opt into the
// high-motion publish profile. Only warn here on obvious real degradation.
const QUALITY_WARN_FPS_THRESHOLD = 18;
const QUALITY_WARN_DURATION_MS = 5000;
const SOURCE_VISIBILITY_POLL_MS = 3000;
const SOURCE_VISIBILITY_TOAST_COOLDOWN_MS = 10000;

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
var _nativeCaptureStopUnlisten = null; // Tauri stop-event unlisten function
var _sourceVisibilityInterval = null;
var _sourceVisibilityLastWarning = null;
var _sourceVisibilityLastToastAt = 0;

// NOTE: The following state variables are declared in state.js (loaded earlier):
//   _latestScreenStats, _cameraReducedForScreenShare, _bwLimitedCount,
//   _bweLowTicks, _bweKickAttempted, _highPausedTicks, _latestOutboundBwe,
//   _bitrateCaps, _currentAppliedCap, _bitrateCapCleanupTimer,
//   BITRATE_CAP_TTL, BITRATE_DEFAULT_HIGH, BITRATE_DEFAULT_MED, BITRATE_DEFAULT_LOW

// Activity is room-local and bound to the sender object AND screen publication.
// A delayed message from a stopped share must never describe its replacement.
var streamActivityByParticipant = new WeakMap();
var sentStreamActivityByParticipant = new WeakMap();

function normalizeStreamActivity(source) {
  if (!source || typeof source !== "object") return null;
  var type = source.source_type;
  if (!["game", "window", "monitor", "browser"].includes(type)) return null;
  var title = typeof source.source_title === "string"
    ? source.source_title.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 160)
    : "";
  // Whole-desktop capture cannot truthfully identify a particular game. Browser
  // track labels may contain tab/document details, so use the surface category.
  if (type === "monitor") title = "";
  if (type === "browser" && !["browser", "window", "monitor"].includes(title)) title = "";
  return { source_type: type, source_title: title };
}

function streamActivityLabel(source) {
  var activity = normalizeStreamActivity(source);
  if (!activity) return "Sharing screen";
  if (activity.source_type === "monitor" || activity.source_title === "monitor") return "Sharing desktop";
  if (activity.source_type === "browser") {
    return activity.source_title === "browser" ? "Sharing browser tab" :
      (activity.source_title === "window" ? "Sharing window" : "Sharing screen");
  }
  if (activity.source_title) return (activity.source_type === "game" ? "Playing " : "Sharing ") + activity.source_title;
  return activity.source_type === "game" ? "Sharing game" : "Sharing window";
}

function streamActivityParticipant(identity, roomRef) {
  if (!identity || !roomRef) return null;
  if (roomRef.localParticipant?.identity === identity) return roomRef.localParticipant;
  return roomRef.remoteParticipants?.get(identity) || null;
}

function streamActivityPublication(identity, roomRef) {
  var owners = [streamActivityParticipant(identity, roomRef),
    roomRef?.remoteParticipants?.get(identity + "$screen")];
  for (var owner of owners) {
    if (!owner) continue;
    for (var publication of getParticipantPublications(owner)) {
      var kind = publication.kind || publication.track?.kind;
      if (kind !== "video" || publication.isMuted) continue;
      if (publication.source !== "screen_share" && owner.identity !== identity + "$screen") continue;
      var sid = publication.trackSid || publication.track?.sid;
      if (sid) return { sid: sid, owner: owner, publication: publication };
    }
  }
  return null;
}

function participantStreamActivityLabel(identity) {
  var roomRef = typeof room !== "undefined" ? room : null;
  var participant = streamActivityParticipant(identity, roomRef);
  var current = streamActivityPublication(identity, roomRef);
  if (!participant || !current) return "Sharing screen";
  if (participant === roomRef.localParticipant) return streamActivityLabel(window._echoCaptureSourceReport);
  var activities = streamActivityByParticipant.get(participant);
  return streamActivityLabel(activities?.get(current.sid));
}

function receiveStreamActivity(message, participant, roomRef) {
  if (!participant || roomRef !== room ||
      streamActivityParticipant(participant.identity, roomRef) !== participant ||
      participant.identity.endsWith("$screen") || message.version !== 1 ||
      typeof message.trackSid !== "string" || !message.trackSid || message.trackSid.length > 128) return false;
  var activity = normalizeStreamActivity(message.source);
  if (message.source !== null && !activity) return false;
  var activities = streamActivityByParticipant.get(participant) || new Map();
  if (activity) activities.set(message.trackSid, activity);
  else activities.delete(message.trackSid);
  // Bound even messages received before their track-published event.
  while (activities.size > 4) activities.delete(activities.keys().next().value);
  streamActivityByParticipant.set(participant, activities);
  participantCards.get(participant.identity)?.syncStreamDescription?.();
  return true;
}

function broadcastStreamActivity(destinationIdentity) {
  var roomRef = typeof room !== "undefined" ? room : null;
  var local = roomRef?.localParticipant;
  if (!local?.publishData) return;
  var current = streamActivityPublication(local.identity, roomRef);
  var previous = sentStreamActivityByParticipant.get(local);
  var source = normalizeStreamActivity(window._echoCaptureSourceReport);
  var trackSid = current?.sid || previous?.trackSid;
  if (!trackSid) return;
  if (!current) source = null;
  var message = { type: "stream-activity", version: 1, trackSid: trackSid, source: source };
  var key = JSON.stringify(message);
  if (!destinationIdentity && previous?.key === key) return;
  var options = { reliable: true };
  if (destinationIdentity) options.destinationIdentities = [destinationIdentity];
  // Publish in call order. Failure leaves the old key so reconciliation retries.
  var pending = { trackSid: trackSid, key: key };
  sentStreamActivityByParticipant.set(local, pending);
  try {
    Promise.resolve(local.publishData(new TextEncoder().encode(key), options)).catch(function() {
      if (sentStreamActivityByParticipant.get(local) === pending) sentStreamActivityByParticipant.delete(local);
    });
  } catch (_) {
    if (sentStreamActivityByParticipant.get(local) === pending) sentStreamActivityByParticipant.delete(local);
  }
  participantCards.get(local.identity)?.syncStreamDescription?.();
}

function requestStreamActivities() {
  var local = typeof room !== "undefined" ? room?.localParticipant : null;
  if (!local?.publishData) return;
  try {
    Promise.resolve(local.publishData(new TextEncoder().encode(JSON.stringify({
      type: "stream-activity-query", version: 1,
    })), { reliable: true })).catch(function() {});
  } catch (_) {}
}
