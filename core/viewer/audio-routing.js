/* =========================================================
   AUDIO ROUTING — Gain nodes, track subscription, and media reconciliation
   ========================================================= */

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
