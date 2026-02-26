/* State variables and DOM refs are in state.js — loaded before this file */
/* Participant cards, video elements, tiles, avatars, and diagnostics are in participants.js */

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

let switchingRoom = false;
let connectSequence = 0;

var _lastRoomSwitchTime = 0;
async function switchRoom(roomId) {
  if (!room) return;
  if (roomId === currentRoomName) return;

  var now = Date.now();
  var fromRoom = currentRoomName;

  if (roomSwitchState && roomSwitchState.requestSwitch) {
    var decision = roomSwitchState.requestSwitch(roomId, now);
    if (!decision.ok) {
      if (decision.reason === "in-flight") {
        debugLog(`Switch to ${roomId} ignored — already switching`);
      } else if (decision.reason === "cooldown") {
        debugLog(`Switch to ${roomId} ignored — cooldown`);
      }
      return;
    }
    fromRoom = decision.fromRoom || currentRoomName;
    currentRoomName = roomSwitchState.snapshot().activeRoomName;
  } else {
    if (switchingRoom) {
      debugLog(`Switch to ${roomId} ignored — already switching`);
      return;
    }
    // Cooldown: prevent rapid switching (500ms minimum — safe with pre-warmed connections)
    if (now - _lastRoomSwitchTime < 500) {
      debugLog(`Switch to ${roomId} ignored — cooldown`);
      return;
    }
    _lastRoomSwitchTime = now;
    currentRoomName = roomId;
  }

  switchingRoom = true;
  _isRoomSwitch = true;
  // Remember mic state before switch so we can restore it
  var wasMicEnabled = micEnabled;
  debugLog(`Switching from ${fromRoom} to ${roomId} (mic was ${wasMicEnabled ? "on" : "off"})`);

  try {
    const controlUrl = controlUrlInput.value.trim();
    const sfuUrl = sfuUrlInput.value.trim();
    const name = nameInput.value.trim() || "Viewer";
    const identity = buildIdentity(name);
    if (identityInput) {
      identityInput.value = identity;
    }
    await connectToRoom({ controlUrl, sfuUrl, roomId, identity, name, reuseAdmin: true });
    if (roomSwitchState && roomSwitchState.markConnected) {
      roomSwitchState.markConnected(roomId);
      currentRoomName = roomSwitchState.snapshot().activeRoomName;
    }
  } catch (err) {
    if (roomSwitchState && roomSwitchState.markFailed) {
      roomSwitchState.markFailed();
      currentRoomName = roomSwitchState.snapshot().activeRoomName;
    }
    _isRoomSwitch = false;
    throw err;
  } finally {
    switchingRoom = false;
  }
}

// SOUNDBOARD_ICONS and icon init are in soundboard.js
// Participant cards, video elements, tiles, avatars, diagnostics — all in participants.js

function runFullReconcile(reason) {
  if (!room) return;
  if (room.remoteParticipants?.forEach) {
    room.remoteParticipants.forEach((participant) => reconcileParticipantMedia(participant));
  }
  reconcileLocalPublishIndicators(reason || "full-reconcile");
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

function reconcileLocalPublishIndicators(reason) {
  if (!publishStateReconcile || !room || !room.localParticipant) return;
  const LK = getLiveKitClient();
  const pubs = getParticipantPublications(room.localParticipant);
  const cameraPublished = pubs.some((pub) =>
    pub &&
    pub.source === LK?.Track?.Source?.Camera &&
    pub.kind === LK?.Track?.Kind?.Video &&
    !!pub.track
  );
  const screenPublished = pubs.some((pub) =>
    pub &&
    pub.source === LK?.Track?.Source?.ScreenShare &&
    pub.kind === LK?.Track?.Kind?.Video &&
    !!pub.track
  );

  const out = publishStateReconcile(
    { camEnabled, screenEnabled },
    { cameraPublished, screenPublished }
  );

  if (out.anyDrift) {
    camEnabled = out.next.camEnabled;
    screenEnabled = out.next.screenEnabled;
    renderPublishButtons();
    debugLog(`[publish-reconcile] ${reason || "unknown"} camera=${camEnabled} screen=${screenEnabled}`);
  }
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

// Soundboard functions are in soundboard.js

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

// Soundboard server operations are in soundboard.js

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
          var ssState = participantState.get(participant.identity);
          var ssVol = (ssState && ssState.chimeVolume != null) ? ssState.chimeVolume : 0.5;
          playScreenShareChime(ssVol);
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
        if (!room) return; // Guard against disconnect during timeout (#68)
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
      if (!room || !room.localParticipant) return; // Guard against disconnect during timeout (#68)
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
              var swState = participantState.get(key);
              var swVol = (swState && swState.chimeVolume != null) ? swState.chimeVolume : 0.5;
              playSwitchChime(swVol);
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
      reconcileLocalPublishIndicators("local-track-published");
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
      reconcileLocalPublishIndicators("local-track-unpublished");
    });
  }

  // Fetch ICE server config (STUN + TURN credentials) from control plane
  var iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  try {
    var iceResp = await fetch(controlUrl + "/v1/ice-servers", {
      headers: { Authorization: "Bearer " + adminToken },
    });
    if (iceResp.ok) {
      var iceData = await iceResp.json();
      if (iceData.iceServers) iceServers = iceData.iceServers;
      debugLog("[ice] fetched " + iceServers.length + " ICE servers from control plane");
    } else {
      debugLog("[ice] /v1/ice-servers returned " + iceResp.status + ", using STUN-only fallback");
    }
  } catch (e) {
    debugLog("[ice] failed to fetch ICE config, using STUN-only fallback");
  }

  await newRoom.connect(sfuUrl, accessToken, {
    autoSubscribe: true,
    rtcConfig: { iceServers: iceServers },
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
  if (roomSwitchState && roomSwitchState.forceConnected) {
    roomSwitchState.forceConnected(roomId);
    currentRoomName = roomSwitchState.snapshot().activeRoomName;
  } else {
    currentRoomName = roomId;
  }
  setPublishButtonsEnabled(true);
  // Show dashboard button for all connected users
  var dashBtn = document.getElementById("open-admin-dash");
  if (dashBtn) dashBtn.classList.remove("hidden");
  reconcileLocalPublishIndicators("post-connect");
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
    // Skip on mobile — binary fetches trigger Samsung download interceptor
    if (!reuseAdmin && !_isMobileDevice) {
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

    // Remove old listeners before adding new ones (prevents accumulation on reconnect)
    if (window._enableAllMedia) {
      const oldHandler = window._enableAllMedia;
      ['click', 'touchstart', 'keydown', 'mousedown'].forEach(event => {
        document.removeEventListener(event, oldHandler, { capture: true });
      });
    }

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
  // Invalidate any in-flight connect/switch attempts (#67)
  connectSequence++;
  sendLeaveNotification();
  stopHeartbeat();
  stopRoomStatusPolling();
  // Clear update-check polling timer (#37)
  if (_updateCheckTimer) { clearInterval(_updateCheckTimer); _updateCheckTimer = null; }
  // Clean up canvas pipeline before disconnecting
  if (window._canvasFrameWorker) {
    try { window._canvasFrameWorker.postMessage("stop"); window._canvasFrameWorker.terminate(); } catch {}
    window._canvasFrameWorker = null;
  }
  if (window._canvasRafId) { cancelAnimationFrame(window._canvasRafId); window._canvasRafId = null; }
  if (window._canvasOffVideo) { window._canvasOffVideo.pause(); window._canvasOffVideo.srcObject = null; window._canvasOffVideo = null; }
  if (window._canvasPipeEl) { window._canvasPipeEl.remove(); window._canvasPipeEl = null; }
  // Stop native WASAPI audio capture if active (#28)
  if (typeof stopNativeAudioCapture === "function") await stopNativeAudioCapture();
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
  // Hide dashboard button and close panel on disconnect
  var dashBtn = document.getElementById("open-admin-dash");
  if (dashBtn) dashBtn.classList.add("hidden");
  if (_adminDashOpen) toggleAdminDash();
  micEnabled = false;
  camEnabled = false;
  screenEnabled = false;
  renderPublishButtons();
  setDeviceStatus("");
  setStatus("Disconnected");
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
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Please describe your feedback.";
    return;
  }
  var token = adminToken;
  if (!token) {
    if (bugReportStatusEl) bugReportStatusEl.textContent = "Not connected.";
    return;
  }
  var feedbackType = "bug";
  var checkedRadio = document.querySelector('input[name="feedback-type"]:checked');
  if (checkedRadio) feedbackType = checkedRadio.value;
  var payload = {
    description: desc,
    feedback_type: feedbackType,
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
      if (bugReportStatusEl) bugReportStatusEl.textContent = "Feedback sent! Thank you.";
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
  if (tabId === "admin-dash-deploys") fetchAdminDeploys();
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
    var heatDays = Object.keys(_admHeatmapUsers).sort().slice(-30);
    var heatMax = 1;
    heatDays.forEach(function(dk) {
      if (!heatmap[dk]) return;
      Object.keys(heatmap[dk]).forEach(function(h) { if (heatmap[dk][h] > heatMax) heatMax = heatmap[dk][h]; });
    });

    html += '<div class="adm-section"><div class="adm-section-title">Activity Heatmap (30d)</div>';
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
      var dt = new Date(r.timestamp * 1000);
      var dateStr = dt.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      html += '<div class="adm-bug"><div class="adm-bug-header"><strong>' + escAdm(r.name || r.identity) + '</strong><span class="adm-time">' + dateStr + '</span></div><div class="adm-bug-desc">' + escAdm(r.description) + '</div></div>';
    });
    el.innerHTML = html;
  } catch (e) {}
}

/* ── Deploy History Tab ────────────────────────────────────────── */

async function fetchAdminDeploys() {
  var deploysDiv = document.getElementById("admin-dash-deploys");
  if (!deploysDiv) return;
  try {
    var resp = await fetch(apiUrl("/admin/api/deploys"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!resp.ok) {
      deploysDiv.innerHTML = '<div class="adm-empty">Failed to load (' + resp.status + ')</div>';
      return;
    }
    var data = await resp.json();
    renderAdminDeploys(data.commits || [], deploysDiv);
  } catch (e) {
    deploysDiv.innerHTML = '<div class="adm-empty">Error: ' + e.message + '</div>';
  }
}

function renderAdminDeploys(commits, container) {
  if (commits.length === 0) {
    container.innerHTML = '<div class="adm-empty">No deploy history yet</div>';
    return;
  }
  var html = '<div class="adm-deploy-list">';
  commits.forEach(function(c) {
    var statusClass = "adm-deploy-historical";
    var statusLabel = "historical";
    if (c.deploy_status === "success") { statusClass = "adm-deploy-success"; statusLabel = "deployed"; }
    else if (c.deploy_status === "failed") { statusClass = "adm-deploy-failed"; statusLabel = "failed"; }
    else if (c.deploy_status === "rollback") { statusClass = "adm-deploy-rollback"; statusLabel = "rolled back"; }
    else if (c.deploy_status === "pending") { statusClass = "adm-deploy-pending"; statusLabel = "pending"; }

    html += '<div class="adm-deploy-row">';
    html += '<div class="adm-deploy-status"><span class="adm-deploy-badge ' + statusClass + '">' + escAdm(statusLabel) + '</span></div>';
    html += '<div class="adm-deploy-info">';
    if (c.pr_number) {
      html += '<div class="adm-deploy-msg"><a href="https://github.com/SamWatson86/echo-chamber/pull/' + c.pr_number + '" target="_blank" class="adm-deploy-link">' + escAdm(c.message || "(no message)") + '</a></div>';
    } else {
      html += '<div class="adm-deploy-msg">' + escAdm(c.message || "(no message)") + '</div>';
    }
    html += '<div class="adm-deploy-meta">';
    html += '<span class="adm-deploy-sha">' + escAdm(c.short_sha || c.sha || "") + '</span>';
    html += '<span class="adm-deploy-author">' + escAdm(c.author || "unknown") + '</span>';
    html += '<span class="adm-deploy-time">' + formatDeployTime(c.timestamp || c.deploy_timestamp || "") + '</span>';
    if (c.deploy_duration) {
      html += '<span class="adm-deploy-dur">' + c.deploy_duration + 's</span>';
    }
    if (c.deploy_error) {
      html += '<div class="adm-deploy-err">' + escAdm(c.deploy_error) + '</div>';
    }
    if (c.body) {
      var bodyId = 'deploy-body-' + escAdm(c.short_sha || c.sha || "");
      html += '<span class="adm-deploy-toggle" onclick="var el=document.getElementById(\'' + bodyId + '\');el.classList.toggle(\'hidden\');this.textContent=el.classList.contains(\'hidden\')?\'\u25B6 Details\':\'\u25BC Details\'">&#9654; Details</span>';
      html += '<pre class="adm-deploy-body hidden" id="' + bodyId + '">' + escAdm(c.body) + '</pre>';
    }
    html += '</div></div></div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

function formatDeployTime(isoStr) {
  if (!isoStr) return "";
  try {
    var d = new Date(isoStr);
    var now = new Date();
    var diffMs = now - d;
    var diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return diffMin + "m ago";
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h ago";
    var diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return diffDay + "d ago";
    return d.toLocaleDateString();
  } catch (e) { return isoStr; }
}
