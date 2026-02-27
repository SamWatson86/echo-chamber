/* =========================================================
   PARTICIPANTS — Cards, video elements, tiles, and avatars
   ========================================================= */

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
  // Local user always watches their own screen
  if (room && room.localParticipant &&
      participant.identity === room.localParticipant.identity) return false;
  // If identity is in hiddenScreens, it's unwatched
  return hiddenScreens.has(participant.identity);
}

// ── Screen tile management ──

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

// ── Screen video recovery ──

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

// ── Video quality ──

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

// ── Video diagnostics ──

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

// ── Icon SVG helper ──

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

// SOUNDBOARD_ICONS and icon init are in soundboard.js

// ── Participant card ──

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
  let chimeSlider = null;
  let chimePct = null;
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
    var chimeRow = document.createElement("div");
    chimeRow.className = "audio-row";
    const chimeLabel = document.createElement("span");
    chimeLabel.textContent = "Chime";
    chimeSlider = document.createElement("input");
    chimeSlider.type = "range";
    chimeSlider.min = "0";
    chimeSlider.max = "1";
    chimeSlider.step = "0.01";
    chimeSlider.value = "0.5";
    chimePct = document.createElement("span");
    chimePct.className = "vol-pct";
    chimePct.textContent = "50%";
    chimeRow.append(chimeLabel, chimeSlider, chimePct);
    audioControls.append(micRow, screenRow, chimeRow);
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
    chimeVolume: 0.5,  // default 50% — halves built-in chime loudness
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
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
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
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
    });
  }
  if (chimeSlider) {
    chimeSlider.addEventListener("input", () => {
      state.chimeVolume = Number(chimeSlider.value);
      if (chimePct) chimePct.textContent = Math.round(state.chimeVolume * 100) + "%";
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
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
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
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
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
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
      if (savedVol.chime != null && chimeSlider) {
        state.chimeVolume = savedVol.chime;
        chimeSlider.value = savedVol.chime;
        if (chimePct) chimePct.textContent = Math.round(savedVol.chime * 100) + "%";
      }
      applyParticipantAudioVolumes(state);
      debugLog("[vol-prefs] restored " + key + " mic=" + (savedVol.mic || 1) + " screen=" + (savedVol.screen || 1) + " chime=" + (savedVol.chime != null ? savedVol.chime : 0.5));
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
    chimeSlider,
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

// ── Avatar ──

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

// ── Camera recovery ──

function scheduleCameraRecovery(identity, cardRef, publication) {
  if (!identity || !cardRef || !publication) return;
  const key = `${identity}-camera`;
  const attempt = cameraRecoveryAttempts.get(key) || 0;
  if (attempt >= 2) return;
  setTimeout(() => {
    // Guard: don't recover if the track has ended or been unsubscribed
    if (!publication?.isSubscribed || publication?.track?.mediaStreamTrack?.readyState === "ended") {
      debugLog(`camera recovery skipped ${identity} (track ended or unsubscribed)`);
      return;
    }
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

// ── Media reconciliation ──

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
