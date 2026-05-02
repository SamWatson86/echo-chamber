/* =========================================================
   PARTICIPANTS-FULLSCREEN — Fullscreen, watchdog, diagnostics,
   video quality, screen/camera recovery
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

// ── Screen track registration & watchdog ──

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
      if (isBlack && blackFor > 3000 && track) {
        if (!meta.lastSwap || now - meta.lastSwap > 10000) {
          meta.lastSwap = now;
          replaceScreenVideoElement(tile, track, publication);
        }
        if (blackFor > 6000 && (!meta.lastResub || now - meta.lastResub > 12000)) {
          meta.lastResub = now;
          meta.blackAttempts = (meta.blackAttempts || 0) + 1;
          if (publication?.setSubscribed) {
            markResubscribeIntent(trackSid);
            publication.setSubscribed(false);
            setTimeout(() => publication.setSubscribed(true), 500);
          }
        }
      }
      if (now - (meta.lastKeyframe || 0) > 10000) {
        meta.lastKeyframe = now;
        requestVideoKeyFrame(publication, track);
      }
      // Give new tracks time to settle before trying aggressive recovery.
      if (!isBlack && sinceFirstFrame > 0 && sinceFirstFrame < 5000 && age < 5000) return;
      const stalled = age > 3000;
      if (!stalled) return;
      const minFixInterval = meta.lastFix ? (isBlack ? 8000 : 15000) : (isBlack ? 4000 : 6000);
      if (now - (meta.lastFix || 0) < minFixInterval) return;

      meta.lastFix = now;
      meta.retryCount = (meta.retryCount || 0) + 1;

      // Back off after 5 failed recovery attempts — stop hammering the stream
      if (meta.retryCount > 5) return;

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
        video._isBlack = false;
      }

      // Reset retry counter periodically but do NOT cycle subscription.
      // Subscription toggling from the watchdog causes cascading resubscription
      // storms that starve the encoder to 0fps.
      if (meta.retryCount >= 5) {
        meta.retryCount = 0;
      }
      // Avoid forcing remote users to re-share (re-prompts).
    });
  }, 3000);
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
    tile.dataset.identity = participant.identity;
    screenTileByIdentity.set(participant.identity, tile);
    if (publication.trackSid) {
      registerScreenTrack(publication.trackSid, publication, tile, participant.identity);
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

// ── Screen video recovery ──

function replaceScreenVideoElement(tile, track, publication) {
  if (!tile || !track) return;
  const overlay = tile.querySelector(".tile-overlay");
  const oldVideo = tile.querySelector("video");
  if (oldVideo && overlay) {
    cleanupVideoDiagnostics(overlay);
  }
  const newEl = createAttachedVideoElement(track);
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
  // Just ensure subscription is active — NEVER toggle off/on here.
  // Subscription cycling from multiple code paths creates cascading
  // resubscription storms that starve the encoder to 0fps.
  publication.setSubscribed(true);
}

function getTrackSid(publication, track, fallback) {
  return publication?.trackSid || track?.sid || fallback || null;
}

// ── Video diagnostics ──

function createVideoFrameRateTracker(nowFn) {
  const getNow = typeof nowFn === "function" ? nowFn : () => performance.now();
  let callbackFrames = 0;
  let lastCallbackFrames = 0;
  let latestPresentedFrames = null;
  let lastPresentedFrames = null;
  let lastSampleTs = getNow();

  function noteFrame(metadata) {
    callbackFrames += 1;
    const presented = Number(metadata?.presentedFrames);
    if (Number.isFinite(presented)) {
      if (lastPresentedFrames === null) {
        lastPresentedFrames = presented;
      }
      latestPresentedFrames = presented;
    }
  }

  function sample(sampleTs) {
    const now = typeof sampleTs === "number" ? sampleTs : getNow();
    const elapsed = (now - lastSampleTs) / 1000;
    let frameDelta = callbackFrames - lastCallbackFrames;

    if (latestPresentedFrames !== null && lastPresentedFrames !== null) {
      frameDelta = latestPresentedFrames - lastPresentedFrames;
      lastPresentedFrames = latestPresentedFrames;
    }

    lastCallbackFrames = callbackFrames;
    lastSampleTs = now;

    if (!Number.isFinite(frameDelta) || frameDelta < 0) {
      frameDelta = 0;
    }
    return elapsed > 0 ? frameDelta / elapsed : 0;
  }

  function presentedFrames() {
    return latestPresentedFrames;
  }

  return { noteFrame, sample, presentedFrames };
}

function getVideoPresentationSnapshot(element) {
  return element?._echoPresentationStats || null;
}

function attachVideoDiagnostics(track, element, overlay) {
  if (!element || !overlay) return;
  const mediaTrack = track?.mediaStreamTrack;
  const frameRate = createVideoFrameRateTracker(() => performance.now());
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
    const fps = frameRate.sample(now);
    const w = element.videoWidth || 0;
    const h = element.videoHeight || 0;
    const ready = element.readyState;
    const muted = mediaTrack?.muted ? "muted" : "live";
    const isBlack = detectBlack();
    element._echoPresentationStats = {
      fps,
      width: w,
      height: h,
      readyState: ready,
      muted: mediaTrack?.muted === true,
      black: isBlack,
      firstFrameTs: element._firstFrameTs || 0,
      lastFrameTs: element._lastFrameTs || 0,
      presentedFrames: frameRate.presentedFrames(),
      updatedAt: Date.now(),
    };
    overlay.textContent = `${w}x${h} | fps ${fps.toFixed(1)} | ${muted} | rs ${ready}${isBlack ? " | black" : ""}`;
  };

  if (typeof element.requestVideoFrameCallback === "function") {
    const onFrame = (_now, metadata) => {
      frameRate.noteFrame(metadata);
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

if (typeof module === "object" && module.exports) {
  module.exports = {
    createVideoFrameRateTracker,
    getVideoPresentationSnapshot,
  };
}

function cleanupVideoDiagnostics(overlay) {
  if (!overlay) return;
  const timer = Number(overlay.dataset.timer || 0);
  if (timer) clearInterval(timer);
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
    const stalled = performance.now() - lastFrame > 3000;
    const isBlack = video._isBlack === true;
    const noSize = video.videoWidth === 0 || video.videoHeight === 0;
    if (!stalled && !isBlack && !noSize) return;
    cameraRecoveryAttempts.set(key, attempt + 1);
    // Do NOT cycle subscription — just ensure it stays on and reattach.
    // Subscription toggling causes SDP renegotiation that starves the encoder.
    if (publication?.setSubscribed) {
      publication.setSubscribed(true);
    }
    if (publication?.track) {
      updateAvatarVideo(cardRef, publication.track);
      const next = cardRef.avatar.querySelector("video");
      if (next) {
        ensureVideoPlays(publication.track, next);
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
