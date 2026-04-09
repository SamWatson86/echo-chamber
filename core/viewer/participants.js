/* =========================================================
   PARTICIPANTS — Coordinator: identity helpers, video element
   helpers, participant track management, media reconciliation.

   Split modules (loaded before this file):
     participants-grid.js      — tile creation/removal, clearMedia
     participants-avatar.js    — icons, participant cards, avatars
     participants-fullscreen.js — fullscreen, watchdog, diagnostics, quality, recovery
   ========================================================= */

/**
 * Check if an identity is a $screen companion.
 */
function isScreenIdentity(identity) {
  return identity && identity.endsWith('$screen');
}

/**
 * Get the real (parent) identity from a $screen identity.
 */
function getParentIdentity(identity) {
  if (isScreenIdentity(identity)) {
    return identity.slice(0, -7); // remove "$screen"
  }
  return identity;
}

// _viewerVersion is now in state.js (loaded first, can find its own script tag)

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
  // Resolve $screen companion identity to the parent identity.
  // hiddenScreens stores PARENT identities (set in connect.js TrackPublished
  // handler after stripping "$screen" suffix). But this function is called
  // with the RAW participant from the LiveKit event, which for companion
  // publishers is "sam-7475$screen". Without this resolution the identities
  // never match and every screen share leaks past the opt-in gate, creating
  // tiles the viewer didn't ask for. Discovered 2026-04-09 during
  // 4-publisher stress test — all streams appeared in the grid immediately
  // even though opt-in is supposed to hide them until "Start Watching."
  var identity = participant.identity;
  if (identity.endsWith('$screen')) {
    identity = identity.slice(0, -'$screen'.length);
  }
  // Local user always watches their own screen
  if (room && room.localParticipant &&
      identity === room.localParticipant.identity) return false;
  // If identity is in hiddenScreens, it's unwatched
  return hiddenScreens.has(identity);
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

// ── Video element helpers ──

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
      element._isBlack = avg < 8;
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

// ── Participant tracks ──

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

// ── Media reconciliation ──

function reconcileParticipantMedia(participant) {
  const LK = getLiveKitClient();
  if (!participant || !participant.tracks) return;
  const cardRef = ensureParticipantCard(participant);
  const pubs = getParticipantPublications(participant);
  pubs.forEach((pub) => {
    if (!pub) return;
    // $screen companions publish as Camera for SFU optimization — patch to ScreenShare
    patchScreenCompanionSource(pub, pub?.track, participant);
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
