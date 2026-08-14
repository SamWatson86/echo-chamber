/* =========================================================
   PARTICIPANTS-GRID — Screen tile grid: create, remove, focus
   ========================================================= */

// ── Screen tile management ──

function addTile(label, element) {
  const tile = document.createElement("div");
  tile.className = "tile";
  const title = document.createElement("h3");
  title.textContent = label;
  title.title = label;
  tile.appendChild(title);
  tile.appendChild(element);
  screenGridEl.appendChild(tile);
  return tile;
}

function addScreenTile(label, element, trackSid) {
  configureVideoElement(element, true);
  element.classList.add("screen-video-surface");
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
  tile.dataset.mediaKind = "screen";
  tile.style.setProperty("--screen-source-aspect-ratio", (16 / 9).toFixed(6));

  // Poster overlay: hide uninitialized GPU garbage (green/black flash) until first real frame.
  // Uses a dark cover that fades out once the video has decoded data.
  var poster = document.createElement("div");
  poster.className = "tile-poster";
  tile.appendChild(poster);
  var removePoster = function() {
    poster.classList.add("fade-out");
    setTimeout(function() { poster.remove(); }, 400);
  };
  // loadeddata fires when the first frame is available for rendering
  element.addEventListener("loadeddata", removePoster, { once: true });
  // Safety fallback: remove after 5s even if event never fires
  setTimeout(function() {
    if (poster.parentNode) removePoster();
  }, 5000);

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
  fsBtn.setAttribute("aria-label", "Open shared screen fullscreen");
  fsBtn.innerHTML = "&#x26F6;"; // ⛶ fullscreen icon
  fsBtn.addEventListener("click", function(e) {
    e.stopPropagation(); // don't trigger tile focus toggle
    var video = tile.querySelector("video");
    if (video) enterVideoFullscreen(video);
  });
  tile.appendChild(fsBtn);

  // Volume slider — shown on hover when tile has audio
  var volWrap = document.createElement("div");
  volWrap.className = "tile-volume-wrap hidden";
  var volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.className = "tile-volume-slider";
  volSlider.min = "0";
  volSlider.max = "3";
  volSlider.step = "0.01";
  volSlider.value = "1";
  volSlider.title = "Screen volume";
  volSlider.addEventListener("click", function(e) { e.stopPropagation(); });
  volSlider.addEventListener("pointerdown", function(e) { e.stopPropagation(); });
  volSlider.addEventListener("input", function(e) {
    e.stopPropagation();
    var identity = tile.dataset.identity;
    if (!identity) return;
    var state = participantState.get(identity);
    if (!state) return;
    state.screenVolume = Number(volSlider.value);
    applyParticipantAudioVolumes(state);
    saveParticipantVolume(identity, state.micVolume, state.screenVolume, state.chimeVolume);
    // Sync the participant card slider
    var cardRef = participantCards.get(identity);
    if (cardRef?.screenSlider) {
      cardRef.screenSlider.value = state.screenVolume;
      if (cardRef.screenPct) cardRef.screenPct.textContent = Math.round(state.screenVolume * 100) + "%";
    }
    if (cardRef?.popScreenSlider) {
      cardRef.popScreenSlider.value = state.screenVolume;
      if (cardRef.popScreenPct) cardRef.popScreenPct.textContent = Math.round(state.screenVolume * 100) + "%";
    }
  });
  volWrap.appendChild(volSlider);
  tile.appendChild(volWrap);
  tile._volWrap = volWrap;
  tile._volSlider = volSlider;

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
        const publishedRatio = ratio.toFixed(6);
        const aspectChanged = tile.style.getPropertyValue("--screen-source-aspect-ratio") !== publishedRatio;
        tile.classList.toggle("ultrawide", ratio > 2.0);
        tile.classList.toggle("superwide", ratio > 2.8);
        tile.classList.toggle("portrait", ratio < 1.0);
        tile.dataset.aspectRatio = ratio.toFixed(2);
        tile.style.setProperty("--screen-source-aspect-ratio", publishedRatio);
        if (aspectChanged && typeof window._echoRecalcGrid === "function") {
          window._echoRecalcGrid();
        }
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

function getCameraStageParticipant(identity, roomRef) {
  var targetRoom = roomRef || room;
  if (!identity || !targetRoom) return null;
  if (targetRoom.localParticipant?.identity === identity) return targetRoom.localParticipant;
  var participant = targetRoom.remoteParticipants?.get?.(identity) || null;
  if (!participant && targetRoom.remoteParticipants?.forEach) {
    targetRoom.remoteParticipants.forEach(function(candidate) {
      if (!participant && candidate?.identity === identity) participant = candidate;
    });
  }
  return participant;
}

function shouldIgnoreRoomMediaEvent(eventRoom, currentRoom, controlledRecoveryEnabled) {
  return !eventRoom || eventRoom !== currentRoom ||
    (controlledRecoveryEnabled === true && eventRoom._echoRecoveryDisconnect === true);
}

function isCurrentRoomParticipantGeneration(identity, participant, expectedRoom) {
  if (!identity || !participant || !expectedRoom || room !== expectedRoom) return false;
  return getCameraStageParticipant(identity, expectedRoom) === participant;
}

function isCurrentCameraParticipantGeneration(identity, participant, expectedRoom) {
  return isCurrentRoomParticipantGeneration(identity, participant, expectedRoom);
}

function isCurrentCameraDisconnectGeneration(identity, participant, expectedRoom) {
  if (!identity || !participant || !expectedRoom || room !== expectedRoom) return false;
  var currentParticipant = getCameraStageParticipant(identity, expectedRoom);
  return !currentParticipant || currentParticipant === participant;
}

function hasCameraStageGenerationMismatch(identity, participant, expectedRoom, cardRef, tile) {
  if (!isCurrentCameraParticipantGeneration(identity, participant, expectedRoom)) return false;
  var cardHasCameraGeneration = !!(cardRef && (
    cardRef.cameraRoom ||
    cardRef.cameraParticipant ||
    cardRef.cameraPublication ||
    cardRef.cameraTrack
  ));
  var cardMismatch = cardHasCameraGeneration && (
    cardRef.cameraRoom !== expectedRoom ||
    cardRef.cameraParticipant !== participant
  );
  var tileMismatch = !!tile && (
    tile._cameraStageRoom !== expectedRoom ||
    tile._cameraStageParticipant !== participant
  );
  return cardMismatch || tileMismatch;
}

function isCurrentCameraTrackGeneration(identity, participant, publication, track, expectedRoom) {
  if (!publication || !track || !isCurrentCameraParticipantGeneration(identity, participant, expectedRoom)) {
    return false;
  }
  var publications = getParticipantPublications(participant);
  if (!publications.includes(publication) || publication.track !== track) return false;
  var LK = getLiveKitClient();
  var source = publication.source || track.source;
  var kind = publication.kind || track.kind;
  if (source && source !== LK?.Track?.Source?.Camera) return false;
  return !kind || kind === LK?.Track?.Kind?.Video || kind === "video";
}

function isCurrentCameraUnsubscribeGeneration(generation) {
  if (!generation || !isCurrentCameraParticipantGeneration(
    generation.identity,
    generation.participant,
    generation.room
  )) return false;
  var publications = getParticipantPublications(generation.participant);
  if (!publications.includes(generation.publication)) return false;
  if (generation.publication.track && generation.publication.track !== generation.track) return false;
  var LK = getLiveKitClient();
  return !publications.some(function(publication) {
    var source = publication?.source || publication?.track?.source;
    return source === LK?.Track?.Source?.Camera && !!publication.track;
  });
}

function cancelCameraClearTimer(identity) {
  if (!identity) return;
  var timer = cameraClearTimers.get(identity);
  if (timer) clearTimeout(timer);
  cameraClearTimers.delete(identity);
  cameraClearGenerationByIdentity.delete(identity);
}

function getCameraStagePublication(participant) {
  if (!participant) return null;
  var LK = getLiveKitClient();
  if (!LK) return null;
  return getParticipantPublications(participant).find(function(publication) {
    var source = publication?.source || publication?.track?.source;
    var kind = publication?.kind || publication?.track?.kind;
    return source === LK.Track.Source.Camera &&
      kind === LK.Track.Kind.Video &&
      !!publication.track;
  }) || null;
}

function hasLiveCameraPublicationOtherThan(participant, excludedPublication) {
  if (!participant) return false;
  var LK = getLiveKitClient();
  if (!LK) return false;
  return getParticipantPublications(participant).some(function(publication) {
    if (!publication || publication === excludedPublication || !publication.track) return false;
    var source = publication.source || publication.track.source;
    var kind = publication.kind || publication.track.kind;
    return source === LK.Track.Source.Camera &&
      (!kind || kind === LK.Track.Kind.Video || kind === "video");
  });
}

function getRemainingCameraPublicationState(participant, excludedPublication) {
  var LK = getLiveKitClient();
  if (!participant || !LK) return { publication: null, track: null };
  var candidates = getParticipantPublications(participant).filter(function(publication) {
    if (!publication || publication === excludedPublication) return false;
    var source = publication.source || publication.track?.source;
    var kind = publication.kind || publication.track?.kind;
    return source === LK.Track.Source.Camera &&
      (!kind || kind === LK.Track.Kind.Video || kind === "video");
  });
  var publication = candidates.find(function(candidate) { return !!candidate.track; }) ||
    candidates[0] || null;
  return {
    publication: publication,
    track: publication?.track || null,
  };
}

function removeCameraVisualGeneration(identity, publication, options) {
  if (!identity || !publication) return { removedCard: false, removedTile: false };
  var opts = options || {};
  var tile = cameraStageTileByIdentity.get(identity);
  var cardRef = participantCards.get(identity);
  var removedTile = !!tile && tile._cameraStagePublication === publication;
  var removedCard = !!cardRef && cardRef.cameraPublication === publication;
  var removedCardVideo = removedCard ? cardRef.avatar?.querySelector("video") : null;
  var oldTrackSid = publication.trackSid || publication.track?.sid || "";

  if (removedTile) removeCameraStageTile(identity, { clearIntent: false });
  if (removedCard) updateAvatarVideo(cardRef, null);
  var mappedCameraVideo = oldTrackSid ? cameraVideoBySid.get(oldTrackSid) : null;
  var ownsMappedCameraVideo = !!mappedCameraVideo && (
    mappedCameraVideo === removedCardVideo ||
    mappedCameraVideo._echoCameraPublication === publication ||
    (!mappedCameraVideo._echoCameraPublication && !!publication.track &&
      mappedCameraVideo._lkTrack === publication.track)
  );
  if (oldTrackSid && ownsMappedCameraVideo) cameraVideoBySid.delete(oldTrackSid);
  var state = participantState.get(identity);
  if (state?.cameraTrackSid && (!oldTrackSid ||
      (state.cameraTrackSid === oldTrackSid && (removedCard || ownsMappedCameraVideo)))) {
    state.cameraTrackSid = null;
  }

  if (opts.clearIntent) {
    // With no remaining camera publication, this is an authoritative camera-off
    // transition. Clear any legacy untagged visual and the viewer's Stage intent.
    var remainingTile = cameraStageTileByIdentity.get(identity);
    if (remainingTile && (!remainingTile._cameraStagePublication ||
        remainingTile._cameraStagePublication === publication)) {
      removeCameraStageTile(identity, { clearIntent: false });
    }
    if (cardRef && !cardRef.cameraPublication && cardRef.avatar?.querySelector("video")) {
      updateAvatarVideo(cardRef, null);
    }
    stagedCameraIdentities.delete(identity);
    if (cardRef?.syncCameraStageControls) cardRef.syncCameraStageControls();
  }

  return { removedCard: removedCard, removedTile: removedTile };
}

function cleanupCameraStageVideo(video) {
  if (!video) return;
  video._playGeneration = (video._playGeneration || 0) + 1;
  if (video._monitorTimer) {
    clearInterval(video._monitorTimer);
    video._monitorTimer = null;
  }
  if (video._objectFitGuard) {
    video._objectFitGuard.disconnect();
    video._objectFitGuard = null;
  }
  if (video._cameraStageAspectHandler) {
    video.removeEventListener("loadedmetadata", video._cameraStageAspectHandler);
    video.removeEventListener("resize", video._cameraStageAspectHandler);
    video._cameraStageAspectHandler = null;
  }
  if (window._pausedVideos) window._pausedVideos.delete(video);
  try {
    if (video._lkTrack?.detach) video._lkTrack.detach(video);
  } catch (_) {}
  try { video.pause(); } catch (_) {}
  try { video.srcObject = null; } catch (_) {}
}

function prepareCameraStageVideo(tile, element) {
  if (!tile || !element) return;
  configureVideoElement(element, true);
  element.classList.add("camera-stage-video-surface");
  element.style.setProperty("display", "block");
  element.style.setProperty("width", "100%");
  element.style.setProperty("height", "100%");
  element.style.setProperty("min-width", "0");
  element.style.setProperty("min-height", "0");
  element.style.setProperty("object-fit", "contain", "important");
  element.style.setProperty("background", "transparent");
  element.style.setProperty("border-radius", "0");
  if (!element._objectFitGuard) {
    element._objectFitGuard = new MutationObserver(function() {
      if (element.style.objectFit !== "contain") {
        element.style.setProperty("object-fit", "contain", "important");
      }
    });
    element._objectFitGuard.observe(element, { attributes: true, attributeFilter: ["style"] });
  }

  var tagAspect = function() {
    var width = element.videoWidth;
    var height = element.videoHeight;
    if (!width || !height) return;
    var ratio = width / height;
    var publishedRatio = ratio.toFixed(6);
    var aspectChanged = tile.style.getPropertyValue("--screen-source-aspect-ratio") !== publishedRatio;
    tile.dataset.aspectRatio = ratio.toFixed(2);
    tile.style.setProperty("--screen-source-aspect-ratio", publishedRatio);
    tile.classList.toggle("portrait", ratio < 1);
    if (aspectChanged && typeof window._echoRecalcGrid === "function") window._echoRecalcGrid();
  };
  element._cameraStageAspectHandler = tagAspect;
  element.addEventListener("loadedmetadata", tagAspect);
  element.addEventListener("resize", tagAspect);
  tagAspect();
  ensureVideoPlays(element._lkTrack, element);
}

function createCameraStageTile(identity, label, track, publication) {
  var element = createAttachedVideoElement(track);
  if (!element) return null;
  var tile = addTile(label + " (Camera)", element);
  tile.dataset.identity = identity;
  tile.dataset.mediaKind = "camera";
  tile.dataset.cameraTrackSid = publication?.trackSid || track?.sid || "";
  tile.style.setProperty("--screen-source-aspect-ratio", (16 / 9).toFixed(6));
  prepareCameraStageVideo(tile, element);

  tile.addEventListener("click", function() {
    if (screenGridEl.classList.contains("is-focused") && tile.classList.contains("is-focused")) {
      screenGridEl.classList.remove("is-focused");
      tile.classList.remove("is-focused");
      return;
    }
    screenGridEl.classList.add("is-focused");
    screenGridEl.querySelectorAll(".tile.is-focused").forEach(function(candidate) {
      candidate.classList.remove("is-focused");
    });
    tile.classList.add("is-focused");
  });

  var fullscreenButton = document.createElement("button");
  fullscreenButton.className = "tile-fullscreen-btn";
  fullscreenButton.title = "Fullscreen camera";
  fullscreenButton.setAttribute("aria-label", "Open camera fullscreen");
  fullscreenButton.innerHTML = "&#x26F6;";
  fullscreenButton.addEventListener("click", function(event) {
    event.stopPropagation();
    var video = tile.querySelector("video");
    if (video) enterVideoFullscreen(video);
  });
  tile.appendChild(fullscreenButton);
  return tile;
}

function stampCameraStageTileGeneration(tile, identity, publication, track) {
  if (!tile) return;
  tile._cameraStageRoom = room;
  tile._cameraStageParticipant = getCameraStageParticipant(identity, room);
  tile._cameraStagePublication = publication;
  tile._cameraStageTrack = track;
}

function removeCameraStageTile(identity, options) {
  if (!identity) return;
  var opts = options || {};
  var tile = cameraStageTileByIdentity.get(identity);
  if (tile) {
    cleanupCameraStageVideo(tile.querySelector("video"));
    if (tile.classList.contains("is-focused")) {
      tile.classList.remove("is-focused");
      screenGridEl.classList.remove("is-focused");
    }
    tile.remove();
    cameraStageTileByIdentity.delete(identity);
  }
  if (opts.clearIntent) stagedCameraIdentities.delete(identity);
  var cardRef = participantCards.get(identity);
  if (cardRef?.syncCameraStageControls) cardRef.syncCameraStageControls();
}

function upsertCameraStageTile(identity, label, track, publication) {
  if (!identity || !track || !stagedCameraIdentities.has(identity)) return null;
  var existing = cameraStageTileByIdentity.get(identity);
  if (existing && !existing.isConnected) {
    cleanupCameraStageVideo(existing.querySelector("video"));
    cameraStageTileByIdentity.delete(identity);
    existing = null;
  }
  if (existing) {
    var existingVideo = existing.querySelector("video");
    if (existingVideo?._lkTrack === track) {
      stampCameraStageTileGeneration(existing, identity, publication, track);
      var existingTitle = existing.querySelector("h3");
      if (existingTitle) {
        existingTitle.textContent = label + " (Camera)";
        existingTitle.title = existingTitle.textContent;
      }
      ensureVideoPlays(track, existingVideo);
      return existing;
    }
    // Keep the Stage tile stable across camera publication replacement. Only
    // its secondary media attachment changes; focus and grid identity survive.
    var replacement = createAttachedVideoElement(track);
    if (!replacement) return existing;
    cleanupCameraStageVideo(existingVideo);
    if (existingVideo?.parentElement) existingVideo.replaceWith(replacement);
    else existing.insertBefore(replacement, existing.firstChild || null);
    prepareCameraStageVideo(existing, replacement);
    existing.dataset.cameraTrackSid = publication?.trackSid || track?.sid || "";
    stampCameraStageTileGeneration(existing, identity, publication, track);
    var replacementTitle = existing.querySelector("h3");
    if (replacementTitle) {
      replacementTitle.textContent = label + " (Camera)";
      replacementTitle.title = replacementTitle.textContent;
    }
    debugLog("[camera-stage] replaced track for " + identity + " sid=" + (existing.dataset.cameraTrackSid || "?"));
    return existing;
  }

  var tile = createCameraStageTile(identity, label, track, publication);
  if (!tile) return null;
  stampCameraStageTileGeneration(tile, identity, publication, track);
  cameraStageTileByIdentity.set(identity, tile);
  debugLog("[camera-stage] showing " + identity + " sid=" + (tile.dataset.cameraTrackSid || "?"));
  return tile;
}

function setCameraOnStage(identity, visible) {
  if (!identity) return false;
  if (!visible) {
    removeCameraStageTile(identity, { clearIntent: true });
    return false;
  }
  var participant = getCameraStageParticipant(identity);
  var publication = getCameraStagePublication(participant);
  if (!participant || !publication?.track || !isCurrentCameraTrackGeneration(
    identity,
    participant,
    publication,
    publication.track,
    room
  )) return false;
  stagedCameraIdentities.add(identity);
  var tile = upsertCameraStageTile(
    identity,
    participant.name || participant.identity || "Guest",
    publication.track,
    publication
  );
  if (!tile) stagedCameraIdentities.delete(identity);
  var cardRef = participantCards.get(identity);
  if (cardRef?.syncCameraStageControls) cardRef.syncCameraStageControls();
  return !!tile;
}

function toggleCameraOnStage(identity) {
  return setCameraOnStage(identity, !stagedCameraIdentities.has(identity));
}

function reconcileCameraStageTrack(identity, label, track, publication) {
  if (!identity || !track) return null;
  var currentParticipant = getCameraStageParticipant(identity, room);
  if (!isCurrentCameraTrackGeneration(
    identity,
    currentParticipant,
    publication,
    track,
    room
  )) return null;
  if (typeof setParticipantCameraStageAvailable === "function") {
    setParticipantCameraStageAvailable(identity, true);
  }
  if (!stagedCameraIdentities.has(identity)) return null;
  return upsertCameraStageTile(identity, label || identity || "Guest", track, publication);
}

function updateCameraStageTileLabel(identity, label) {
  var tile = cameraStageTileByIdentity.get(identity);
  var title = tile?.querySelector("h3");
  if (!title) return;
  title.textContent = (label || identity || "Guest") + " (Camera)";
  title.title = title.textContent;
}

function clearCameraStageTiles() {
  var identities = Array.from(cameraStageTileByIdentity.keys());
  stagedCameraIdentities.clear();
  identities.forEach(function(identity) {
    removeCameraStageTile(identity, { clearIntent: false });
  });
}

function refreshActiveCameraLobbyForRoom(expectedRoom) {
  if (!expectedRoom || room !== expectedRoom ||
      !cameraLobbyPanel || cameraLobbyPanel.classList.contains("hidden") ||
      typeof populateCameraLobby !== "function") {
    return false;
  }
  populateCameraLobby();
  return true;
}

function normalizeScreenMediaIdentity(identity) {
  if (!identity) return "";
  return typeof isScreenIdentity === "function" && isScreenIdentity(identity)
    ? getParentIdentity(identity)
    : identity;
}

function cleanupScreenVideoElement(video) {
  if (!video) return;
  video._playGeneration = (video._playGeneration || 0) + 1;
  if (video._monitorTimer) {
    clearInterval(video._monitorTimer);
    video._monitorTimer = null;
  }
  if (video._objectFitGuard) {
    video._objectFitGuard.disconnect();
    video._objectFitGuard = null;
  }
  if (window._pausedVideos) window._pausedVideos.delete(video);
  try {
    if (video._lkTrack?.detach) video._lkTrack.detach(video);
  } catch (_) {}
  try { video.pause(); } catch (_) {}
  try { video.srcObject = null; } catch (_) {}
}

function removeScreenTile(trackSid) {
  if (!trackSid) return;
  const tile = screenTileBySid.get(trackSid);
  if (tile) {
    const overlay = tile.querySelector(".tile-overlay");
    cleanupVideoDiagnostics(overlay);
    cleanupScreenVideoElement(tile.querySelector("video"));
    if (tile.classList.contains("is-focused")) {
      screenGridEl.classList.remove("is-focused");
    }
    tile.remove();
    screenTileBySid.delete(trackSid);
  }
}

function clearMedia() {
  if (typeof stopAllNativePresenter === "function") {
    stopAllNativePresenter("media cleared").catch(function(e) {
      debugLog("[native-presenter] clearMedia stop failed: " + (e && e.message ? e.message : e));
    });
  }
  if (typeof clearCameraLobbyMedia === "function") {
    clearCameraLobbyMedia();
  }
  clearCameraStageTiles();
  screenGridEl.innerHTML = "";
  screenTileBySid.clear();
  screenTileByIdentity.clear();
  screenTrackMeta.clear();
  androidFirefoxScreenRecoveryBySid.clear();
  screenRecoveryAttempts.clear();
  screenResubscribeIntent.clear();
  stopInboundScreenStatsMonitor();
  cameraRecoveryAttempts.clear();
  cameraVideoBySid.clear();
  lastTrackHandled.clear();
  cameraClearTimers.forEach((timer) => clearTimeout(timer));
  cameraClearTimers.clear();
  cameraClearGenerationByIdentity.clear();
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
