/* =========================================================
   PARTICIPANTS-FULLSCREEN — Fullscreen, watchdog, diagnostics,
   video quality, screen/camera recovery
   ========================================================= */

var activeVideoFullscreenSession = null;
var androidFirefoxScreenRecoveryBySid = new Map();

function getRegisteredScreenPublicationContext(publication) {
  if (!publication || typeof screenTrackMeta !== "object") return null;
  var trackSid = publication.trackSid || publication.track?.sid || null;
  var meta = trackSid ? screenTrackMeta.get(trackSid) : null;
  if (!meta && screenTrackMeta?.forEach) {
    screenTrackMeta.forEach(function(candidate) {
      if (!meta && candidate?.publication === publication) meta = candidate;
    });
  }
  return meta || null;
}

function shouldSubscribeRegisteredScreenPublication(publication, participant, expectedRoom) {
  if (typeof isPhoneScreenVideoBudgetEnabled !== "function" ||
      !isPhoneScreenVideoBudgetEnabled() ||
      typeof shouldSubscribeParticipantPublication !== "function") return true;
  var meta = getRegisteredScreenPublicationContext(publication);
  return shouldSubscribeParticipantPublication(
    publication,
    participant || meta?.participant || null,
    expectedRoom || meta?.room || room
  );
}

function isCurrentScreenRecoveryGeneration(options) {
  if (!options || !options.trackSid || !options.meta || !options.publication || !options.tile) return false;
  if (!options.tile.isConnected) return false;
  if (options.tile.dataset?.trackSid !== options.trackSid) return false;
  if (options.meta.publication !== options.publication || options.meta.tile !== options.tile) return false;
  if (options.getCurrentMeta(options.trackSid) !== options.meta) return false;
  if (options.getCurrentTile(options.trackSid) !== options.tile) return false;
  if (options.isHidden && options.isHidden(options.meta.identity)) return false;
  return true;
}

function attemptAndroidFirefoxScreenSubscriptionReset(options) {
  if (!options || options.enabled !== true) return false;
  var meta = options.meta;
  var publication = options.publication;
  var trackSid = options.trackSid;
  var tile = options.tile;
  if (!isCurrentScreenRecoveryGeneration(options)) return false;
  if (!shouldSubscribeRegisteredScreenPublication(publication, meta.participant, meta.room)) return false;
  if (!options.recoveryStateBySid) return false;
  var recoveryState = options.recoveryStateBySid.get(trackSid);
  if (recoveryState?.subscriptionResetAttempted === true) return false;
  if (publication.isSubscribed !== true || typeof publication.setSubscribed !== "function") return false;
  var mediaTrack = publication.track?.mediaStreamTrack;
  if (!mediaTrack || mediaTrack.readyState !== "live" || mediaTrack.muted !== true) return false;
  if (!(options.frameAgeMs > 3000) || !(options.firstLineRecoveryAt > 0)) return false;

  // Mark before touching the subscription. TrackUnsubscribed can arrive
  // synchronously. SID-scoped state survives same-SID metadata replacement,
  // so this recovery cannot turn into a reset loop.
  var resetAtMs = Number.isFinite(options.nowMs)
    ? options.nowMs
    : (typeof performance === "object" && typeof performance.now === "function"
        ? performance.now()
        : Date.now());
  options.recoveryStateBySid.set(trackSid, {
    subscriptionResetAttempted: true,
    subscriptionResetAt: resetAtMs,
  });
  if (typeof options.markResubscribeIntent === "function") {
    options.markResubscribeIntent(trackSid);
  }
  if (typeof options.log === "function") {
    options.log("[android-firefox-recovery] resetting stalled screen subscription sid=" + trackSid);
  }
  var originalTrack = publication.track;
  publication.setSubscribed(false);

  options.schedule(function() {
    var currentOptions = Object.assign({}, options, {
      meta: meta,
      publication: publication,
      tile: tile,
    });
    if (!isCurrentScreenRecoveryGeneration(currentOptions)) return;
    if (!shouldSubscribeRegisteredScreenPublication(publication, meta.participant, meta.room)) return;
    publication.setSubscribed(true);
    if (typeof options.requestKeyFrame === "function") {
      options.requestKeyFrame(publication, publication.track || originalTrack);
    }
    if (typeof options.log === "function") {
      options.log("[android-firefox-recovery] restored screen subscription sid=" + trackSid);
    }
  }, options.resetDelayMs == null ? 500 : options.resetDelayMs);
  return true;
}

function isAndroidFirefoxConnectedMediaStallCurrent(options) {
  if (!options || options.enabled !== true) return false;
  var roomConnected = options.roomConnected === true;
  if (typeof options.isRoomConnected === "function") {
    try {
      roomConnected = options.isRoomConnected() === true;
    } catch (_error) {
      roomConnected = false;
    }
  }
  if (!roomConnected) return false;
  if (!isCurrentScreenRecoveryGeneration(options)) return false;
  if (options.publication.isSubscribed !== true) return false;

  var frameAgeMs = options.frameAgeMs;
  if (typeof options.getFrameAgeMs === "function") {
    try {
      frameAgeMs = options.getFrameAgeMs();
    } catch (_error) {
      return false;
    }
  }
  if (!(frameAgeMs > 3000)) return false;

  var mediaTrack = options.publication.track?.mediaStreamTrack;
  return !!mediaTrack && mediaTrack.readyState === "live" && mediaTrack.muted === true;
}

function attemptAndroidFirefoxConnectedMediaRelayRecovery(options) {
  if (!isAndroidFirefoxConnectedMediaStallCurrent(options)) return false;
  if (!options.recoveryStateBySid || typeof options.recover !== "function") return false;

  var recoveryState = options.recoveryStateBySid.get(options.trackSid);
  if (!recoveryState || recoveryState.subscriptionResetAttempted !== true ||
      recoveryState.relayRecoveryAttempted === true) {
    return false;
  }
  var resetAtMs = recoveryState.subscriptionResetAt;
  var nowMs = Number.isFinite(options.nowMs)
    ? options.nowMs
    : (typeof performance === "object" && typeof performance.now === "function"
        ? performance.now()
        : Date.now());
  var graceMs = Number.isFinite(options.resetGraceMs) && options.resetGraceMs >= 0
    ? options.resetGraceMs
    : 6000;
  if (!Number.isFinite(resetAtMs) || nowMs - resetAtMs < graceMs) return false;

  var accepted = options.recover({
    trackSid: options.trackSid,
    identity: options.meta.identity || "",
    isStillStalled: function() {
      return isAndroidFirefoxConnectedMediaStallCurrent(options);
    },
    onValidated: function() {
      if (!isAndroidFirefoxConnectedMediaStallCurrent(options)) return false;
      var currentRecoveryState = options.recoveryStateBySid.get(options.trackSid);
      if (!currentRecoveryState || currentRecoveryState.subscriptionResetAttempted !== true ||
          currentRecoveryState.relayRecoveryAttempted === true) {
        return false;
      }
      var validatedAtMs;
      if (typeof options.getNowMs === "function") {
        try {
          validatedAtMs = options.getNowMs();
        } catch (_error) {
          return false;
        }
      }
      if (!Number.isFinite(validatedAtMs)) validatedAtMs = nowMs;
      options.recoveryStateBySid.set(options.trackSid, Object.assign({}, currentRecoveryState, {
        relayRecoveryAttempted: true,
        relayRecoveryAt: validatedAtMs,
      }));
      if (typeof options.log === "function") {
        options.log("[android-firefox-recovery] escalating connected media stall to relay Room sid=" +
          options.trackSid);
      }
      return true;
    },
  }) === true;
  if (!accepted) return false;
  return true;
}

function resolveVideoFullscreenHost(videoEl) {
  if (!videoEl || !videoEl.isConnected) return null;
  if (typeof videoEl.closest === "function") {
    var stableHost = videoEl.closest(".tile, .user-avatar");
    if (stableHost) return stableHost;
  }
  return videoEl.parentElement || null;
}

function captureFullscreenResponsiveState() {
  var shell = typeof window !== "undefined" ? window.EchoUiShell : null;
  return shell && typeof shell.captureResponsiveState === "function"
    ? shell.captureResponsiveState()
    : null;
}

function restoreFullscreenResponsiveState(snapshot) {
  if (!snapshot || typeof window === "undefined") return;
  var shell = window.EchoUiShell;
  if (!shell || typeof shell.restoreResponsiveState !== "function") return;
  var requestFrame = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : function(callback) { return window.setTimeout(callback, 0); };
  requestFrame(function() {
    requestFrame(function() {
      shell.restoreResponsiveState(snapshot);
    });
  });
}

function capturePhoneFullscreenMediaGeneration(host, videoEl, currentRoom) {
  if (!host || !videoEl) return null;
  var track = videoEl._lkTrack || host._screenTrack || videoEl._echoCameraTrack || null;
  if (!track) return null;
  var isScreen = !!(host._screenTrack || host._screenPublication);
  return {
    room: isScreen ? (host._screenRoom || currentRoom) : (videoEl._echoCameraRoom || currentRoom),
    host: host,
    element: videoEl,
    track: track,
    publication: isScreen
      ? (host._screenPublication || null)
      : (videoEl._echoCameraPublication || null),
    playGeneration: videoEl._playGeneration || 0,
    isScreen: isScreen,
  };
}

function isCurrentPhoneFullscreenMediaGeneration(generation, currentRoom) {
  if (!generation || currentRoom !== generation.room ||
      !generation.host?.isConnected || !generation.element?.isConnected) return false;
  if (generation.element._lkTrack !== generation.track ||
      (generation.element._playGeneration || 0) !== generation.playGeneration) return false;
  if (generation.track?.mediaStreamTrack?.readyState === "ended") return false;
  if (generation.publication?.track && generation.publication.track !== generation.track) return false;
  if (typeof generation.host.querySelector === "function" &&
      generation.host.querySelector("video") !== generation.element) return false;
  if (generation.isScreen) {
    return generation.host._screenTrack === generation.track &&
      generation.host._screenPublication === generation.publication &&
      generation.host._screenRoom === generation.room;
  }
  if (generation.element._echoCameraTrack &&
      generation.element._echoCameraTrack !== generation.track) return false;
  if (generation.element._echoCameraPublication &&
      generation.element._echoCameraPublication !== generation.publication) return false;
  if (generation.element._echoCameraRoom &&
      generation.element._echoCameraRoom !== generation.room) return false;
  return true;
}

function capturePhoneFullscreenFrameMarker(element) {
  var snapshot = getVideoPresentationSnapshot(element);
  return Object.freeze({
    currentTime: Number(element?.currentTime) || 0,
    lastFrameTs: Number(element?._lastFrameTs) || 0,
    presentedFrames: Number.isFinite(Number(snapshot?.presentedFrames))
      ? Number(snapshot.presentedFrames)
      : null,
  });
}

function didPhoneFullscreenFrameAdvance(element, marker) {
  if (!element || !marker) return false;
  var snapshot = getVideoPresentationSnapshot(element);
  var presentedFrames = Number(snapshot?.presentedFrames);
  if (marker.presentedFrames !== null && Number.isFinite(presentedFrames) &&
      presentedFrames > marker.presentedFrames) return true;
  if ((Number(element._lastFrameTs) || 0) > marker.lastFrameTs) return true;
  return (Number(element.currentTime) || 0) > marker.currentTime + 0.001;
}

function createPhoneFullscreenRecoveryContext(generation, options) {
  if (!generation) return null;
  var input = options || {};
  var getCurrentRoom = typeof input.getCurrentRoom === "function"
    ? input.getCurrentRoom
    : function() { return room; };
  var marker = capturePhoneFullscreenFrameMarker(generation.element);
  var recovered = false;
  return {
    isCurrent: function() {
      return isCurrentPhoneFullscreenMediaGeneration(generation, getCurrentRoom());
    },
    measure: function() {
      var shell = input.shell || (typeof window !== "undefined" ? window.EchoUiShell : null);
      if (shell && typeof shell.measureNow === "function") shell.measureNow();
      var recalc = input.recalculateGrid ||
        (typeof window !== "undefined" ? window._echoRecalcGrid : null);
      if (typeof recalc === "function") recalc();
    },
    hasAdvanced: function() {
      return didPhoneFullscreenFrameAdvance(generation.element, marker);
    },
    isPaused: function() {
      return generation.element.paused === true;
    },
    recover: function() {
      if (recovered || !isCurrentPhoneFullscreenMediaGeneration(generation, getCurrentRoom())) {
        return false;
      }
      recovered = true;
      try {
        var playResult = generation.element.play();
        if (playResult && typeof playResult.catch === "function") playResult.catch(function() {});
      } catch (_playError) {}
      var requestKeyFrame = input.requestKeyFrame || requestVideoKeyFrame;
      requestKeyFrame(generation.publication, generation.track);
      return true;
    },
  };
}

function schedulePhoneFullscreenExitStabilization(generation) {
  var phonePresentation = typeof window !== "undefined" ? window.EchoPhonePresentation : null;
  if (!generation || !phonePresentation ||
      typeof phonePresentation.isPhone !== "function" || !phonePresentation.isPhone() ||
      typeof phonePresentation.stabilizeFullscreenExit !== "function") return false;
  var context = createPhoneFullscreenRecoveryContext(generation);
  return !!context && phonePresentation.stabilizeFullscreenExit(context) === true;
}

// Fullscreen the existing stable media host. Keeping the live video inside its
// Stage tile lets subscription reconciliation, diagnostics, and the watchdog
// continue to find the same node throughout the transition.
function getVideoFullscreenMediaName(host, priorControlLabel) {
  return host?.dataset?.mediaKind === "camera" || /camera/i.test(priorControlLabel || "")
    ? "camera"
    : "shared screen";
}

function getVideoFullscreenControlLabel(host, priorControlLabel, isFullscreen) {
  if (!isFullscreen) return priorControlLabel || "Open shared screen fullscreen";
  return "Exit " + getVideoFullscreenMediaName(host, priorControlLabel) + " fullscreen";
}

function enterVideoFullscreen(videoEl) {
  if (document.fullscreenElement) {
    return document.exitFullscreen();
  }
  if (activeVideoFullscreenSession) return activeVideoFullscreenSession.promise;

  var host = resolveVideoFullscreenHost(videoEl);
  if (!host || typeof host.requestFullscreen !== "function") {
    return Promise.resolve(false);
  }

  var hint = document.createElement("div");
  hint.className = "fullscreen-hint";
  hint.textContent = "Click the video, use Exit fullscreen, or press ESC to exit";
  host.appendChild(hint);

  var isolatedMarker = null;
  if (document.documentElement.dataset.echoIsolatedPreview === "true") {
    isolatedMarker = document.createElement("div");
    isolatedMarker.className = "fullscreen-isolated-preview";
    isolatedMarker.textContent = "Isolated preview · Not Live Echo";
    host.appendChild(isolatedMarker);
  }

  var fullscreenControl = host.querySelector(".tile-fullscreen-btn");
  var priorControlLabel = fullscreenControl && fullscreenControl.getAttribute("aria-label");
  var priorControlTitle = fullscreenControl && fullscreenControl.title;
  var responsiveSnapshot = captureFullscreenResponsiveState();
  var phoneFullscreenGeneration = capturePhoneFullscreenMediaGeneration(host, videoEl, room);
  var entered = false;
  var cleaned = false;

  function setControlPresentation(isFullscreen) {
    if (!fullscreenControl) return;
    fullscreenControl.setAttribute(
      "aria-label",
      getVideoFullscreenControlLabel(host, priorControlLabel, isFullscreen)
    );
    fullscreenControl.title = isFullscreen ? "Exit fullscreen" : (priorControlTitle || "Fullscreen");
  }

  function onHostClick(event) {
    if (document.fullscreenElement !== host) return;
    var interactive = event.target && typeof event.target.closest === "function"
      ? event.target.closest("button, input, select, textarea, a[href]")
      : null;
    if (interactive) return;
    event.preventDefault();
    event.stopPropagation();
    document.exitFullscreen();
  }

  function cleanup(restoreResponsiveState) {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    host.removeEventListener("click", onHostClick, true);
    host.classList.remove("fullscreen-video-wrapper");
    hint.remove();
    if (isolatedMarker) isolatedMarker.remove();
    setControlPresentation(false);
    activeVideoFullscreenSession = null;
    if (restoreResponsiveState &&
        !schedulePhoneFullscreenExitStabilization(phoneFullscreenGeneration)) {
      restoreFullscreenResponsiveState(responsiveSnapshot);
    }
    if (fullscreenControl && fullscreenControl.isConnected) {
      try { fullscreenControl.focus({ preventScroll: true }); } catch (_focusError) {}
    }
  }

  function onFullscreenChange() {
    if (document.fullscreenElement === host) {
      entered = true;
      setControlPresentation(true);
      return;
    }
    if (entered && !document.fullscreenElement) cleanup(true);
  }

  host.classList.add("fullscreen-video-wrapper");
  host.addEventListener("click", onHostClick, true);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  setTimeout(function() {
    if (hint.isConnected) hint.classList.add("fade-out");
  }, 2400);

  var request = Promise.resolve().then(function() {
    return host.requestFullscreen();
  }).then(function() {
    // Some embedded browser hosts can resolve the request while immediately
    // declining the top-layer transition. Do not leave fullscreen-only classes
    // and controls behind when no fullscreen element was established.
    if (document.fullscreenElement !== host) {
      cleanup(false);
      return false;
    }
    entered = true;
    setControlPresentation(true);
    return true;
  }).catch(function() {
    cleanup(false);
    return false;
  });
  activeVideoFullscreenSession = { host: host, promise: request };
  return request;
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

function stampScreenTileGeneration(tile, publication, identity, participant, track, expectedRoom) {
  if (!tile) return;
  var screenRoom = expectedRoom || room;
  var screenParticipant = participant || getCameraStageParticipant(identity, screenRoom);
  var screenTrack = track || publication?.track || null;
  tile._screenRoom = screenRoom;
  tile._screenParticipant = screenParticipant;
  tile._screenPublication = publication;
  tile._screenTrack = screenTrack;
}

function registerScreenTrack(trackSid, publication, tile, identity, participant, track, expectedRoom) {
  if (!trackSid || !tile) return;
  var screenRoom = expectedRoom || room;
  var screenParticipant = participant || getCameraStageParticipant(identity, screenRoom);
  var screenTrack = track || publication?.track || null;
  var meta = {
    trackSid,
    publication,
    tile,
    lastFix: 0,
    lastKeyframe: 0,
    retryCount: 0,
    identity: identity || "",
    room: screenRoom,
    participant: screenParticipant,
    track: screenTrack,
    createdAt: performance.now()
  };
  screenTrackMeta.set(trackSid, meta);
  stampScreenTileGeneration(
    tile,
    publication,
    identity,
    screenParticipant,
    screenTrack,
    screenRoom
  );
  if (typeof maybeStartNativePresenterForScreenTrack === "function") {
    maybeStartNativePresenterForScreenTrack({ trackSid, publication, tile, identity }).catch(function(e) {
      debugLog("[native-presenter] register start failed: " + (e && e.message ? e.message : e));
    });
  }
  if (typeof scheduleNativePresenterProbeRetries === "function") {
    scheduleNativePresenterProbeRetries({ trackSid, publication, tile, identity });
  }
  if (ENABLE_SCREEN_WATCHDOG) startScreenWatchdog();
}

function unregisterScreenTrack(trackSid) {
  if (!trackSid) return;
  androidFirefoxScreenRecoveryBySid.delete(trackSid);
  if (typeof stopNativePresenterForTrack === "function") {
    stopNativePresenterForTrack(trackSid).catch(function(e) {
      debugLog("[native-presenter] unregister stop failed: " + (e && e.message ? e.message : e));
    });
  }
  screenTrackMeta.delete(trackSid);
  if (screenTrackMeta.size === 0 && screenWatchdogTimer) {
    clearInterval(screenWatchdogTimer);
    screenWatchdogTimer = null;
  }
}

function hasParticipantScreenPublication(participant) {
  if (!participant) return false;
  var LK = getLiveKitClient();
  var companion = typeof isScreenIdentity === "function" && isScreenIdentity(participant.identity);
  return getParticipantPublications(participant).some(function(publication) {
    var source = publication?.source || publication?.track?.source;
    var kind = publication?.kind || publication?.track?.kind;
    var video = !kind || kind === LK?.Track?.Kind?.Video || kind === "video";
    return video && (source === LK?.Track?.Source?.ScreenShare ||
      (companion && source === LK?.Track?.Source?.Camera));
  });
}

function hasRegisteredScreenGenerationForIdentity(identity) {
  if (!identity) return false;
  var found = false;
  screenTrackMeta.forEach(function(meta) {
    if (!found && meta?.identity === identity && meta.tile?.isConnected) found = true;
  });
  return found;
}

function removeRegisteredScreenGeneration(trackSid, meta) {
  if (!trackSid || !meta || screenTrackMeta.get(trackSid) !== meta) return false;
  var tile = meta.tile;
  if (screenTileBySid.get(trackSid) === tile) {
    removeScreenTile(trackSid);
  } else if (tile && tile._screenPublication === meta.publication) {
    cleanupScreenVideoElement(tile.querySelector("video"));
    tile.remove();
  }
  if (screenTrackMeta.get(trackSid) === meta) unregisterScreenTrack(trackSid);
  if (screenTileByIdentity.get(meta.identity) === tile) screenTileByIdentity.delete(meta.identity);
  screenRecoveryAttempts.delete(trackSid);
  screenResubscribeIntent.delete(trackSid);
  var state = participantState.get(meta.identity);
  if (state?.screenTrackSid === trackSid) state.screenTrackSid = null;
  return true;
}

function clearScreenParticipantGeneration(participant, expectedRoom, mode) {
  var mediaIdentity = normalizeScreenMediaIdentity(participant?.identity);
  var result = { mediaIdentity: mediaIdentity, removed: false, trackSids: [] };
  if (!participant || !expectedRoom || room !== expectedRoom) return result;
  var removeReplacement = mode === "replaced";
  var matches = [];
  screenTrackMeta.forEach(function(meta, trackSid) {
    if (!meta || meta.room !== expectedRoom) return;
    if (meta.participant?.identity !== participant.identity) return;
    if (removeReplacement ? meta.participant === participant : meta.participant !== participant) return;
    matches.push([trackSid, meta]);
  });
  matches.forEach(function(entry) {
    if (removeRegisteredScreenGeneration(entry[0], entry[1])) {
      result.removed = true;
      result.trackSids.push(entry[0]);
    }
  });

  // A SID-less tile still carries the same generation stamp.
  var tile = screenTileByIdentity.get(mediaIdentity);
  var tileMatches = tile && tile._screenRoom === expectedRoom &&
    tile._screenParticipant?.identity === participant.identity &&
    (removeReplacement ? tile._screenParticipant !== participant : tile._screenParticipant === participant);
  if (tileMatches) {
    cleanupScreenVideoElement(tile.querySelector("video"));
    tile.remove();
    if (screenTileByIdentity.get(mediaIdentity) === tile) screenTileByIdentity.delete(mediaIdentity);
    result.removed = true;
  }
  return result;
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
      const stalled = age > 3000;

      // Firefox on Android can negotiate successfully, decode a handful of
      // frames, then leave every remote MediaStreamTrack live-but-muted. Give
      // the normal keyframe/reattach recovery one full watchdog pass first,
      // then perform one exact-SID subscription reset. No other browser or the
      // native desktop shell can enter this path.
      var androidFirefoxRecoveryEnabled = typeof isAndroidFirefoxBrowser === "function" &&
        isAndroidFirefoxBrowser(
          typeof navigator === "object" ? navigator : null,
          typeof window === "object" && window.__ECHO_NATIVE__ === true
        );
      var localScreenIdentity = room?.localParticipant?.identity || null;
      var isRemoteScreen = !!meta.identity && meta.identity !== localScreenIdentity;
      if (androidFirefoxRecoveryEnabled && isRemoteScreen && stalled &&
          meta.lastFix > 0 && now - meta.lastFix >= 2500) {
        var resetScheduled = attemptAndroidFirefoxScreenSubscriptionReset({
          enabled: true,
          trackSid: trackSid,
          meta: meta,
          publication: publication,
          tile: tile,
          frameAgeMs: age,
          firstLineRecoveryAt: meta.lastFix,
          nowMs: now,
          recoveryStateBySid: androidFirefoxScreenRecoveryBySid,
          getCurrentMeta: function(sid) { return screenTrackMeta.get(sid); },
          getCurrentTile: function(sid) { return screenTileBySid.get(sid); },
          isHidden: function(identity) { return hiddenScreens.has(identity); },
          markResubscribeIntent: markResubscribeIntent,
          requestKeyFrame: requestVideoKeyFrame,
          schedule: setTimeout,
          log: debugLog,
        });
        if (resetScheduled) return;

        var connectedMediaRecoveryRoom = room;
        var relayRecoveryAccepted = attemptAndroidFirefoxConnectedMediaRelayRecovery({
          enabled: true,
          roomConnected: String(connectedMediaRecoveryRoom?.state || "").toLowerCase() === "connected",
          isRoomConnected: function() {
            return room === connectedMediaRecoveryRoom &&
              String(connectedMediaRecoveryRoom?.state || "").toLowerCase() === "connected";
          },
          trackSid: trackSid,
          meta: meta,
          publication: publication,
          tile: tile,
          frameAgeMs: age,
          getFrameAgeMs: function() {
            var currentMeta = screenTrackMeta.get(trackSid);
            var currentTile = screenTileBySid.get(trackSid);
            var currentVideo = currentTile?.querySelector("video");
            if (!currentMeta || !currentTile || !currentVideo ||
                currentVideo._lkTrack !== currentMeta.publication?.track) {
              return null;
            }
            return performance.now() - (currentVideo._lastFrameTs || 0);
          },
          nowMs: now,
          getNowMs: function() { return performance.now(); },
          resetGraceMs: 6000,
          recoveryStateBySid: androidFirefoxScreenRecoveryBySid,
          getCurrentMeta: function(sid) { return screenTrackMeta.get(sid); },
          getCurrentTile: function(sid) { return screenTileBySid.get(sid); },
          isHidden: function(identity) { return hiddenScreens.has(identity); },
          recover: function(detail) {
            if (typeof requestAndroidFirefoxConnectedMediaRelayRecovery !== "function") return false;
            return requestAndroidFirefoxConnectedMediaRelayRecovery(detail);
          },
          log: debugLog,
        });
        if (relayRecoveryAccepted) return;
      }
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
            setTimeout(() => {
              if (shouldSubscribeRegisteredScreenPublication(publication, meta.participant, meta.room)) {
                publication.setSubscribed(true);
              }
            }, 500);
          }
        }
      }
      if (now - (meta.lastKeyframe || 0) > 10000) {
        meta.lastKeyframe = now;
        requestVideoKeyFrame(publication, track);
      }
      // Give new tracks time to settle before trying aggressive recovery.
      if (!isBlack && sinceFirstFrame > 0 && sinceFirstFrame < 5000 && age < 5000) return;
      if (!stalled) return;
      const minFixInterval = meta.lastFix ? (isBlack ? 8000 : 15000) : (isBlack ? 4000 : 6000);
      if (now - (meta.lastFix || 0) < minFixInterval) return;

      meta.lastFix = now;
      meta.retryCount = (meta.retryCount || 0) + 1;

      // Back off after 5 failed recovery attempts — stop hammering the stream
      if (meta.retryCount > 5) return;

      if (track) {
        if (publication?.setSubscribed &&
            shouldSubscribeRegisteredScreenPublication(publication, meta.participant, meta.room)) {
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
    stampScreenTileGeneration(tile, publication, participant.identity, participant, track, room);
    screenTileByIdentity.set(participant.identity, tile);
    if (publication.trackSid) {
      registerScreenTrack(
        publication.trackSid,
        publication,
        tile,
        participant.identity,
        participant,
        track,
        room
      );
    }
    requestVideoKeyFrame(publication, track);
    forceVideoLayer(publication, element);
  } else if (source === LK.Track.Source.Camera) {
    const cardRef = ensureParticipantCard(participant);
    ensureCameraVideo(cardRef, track, publication);
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
    cleanupScreenVideoElement(oldVideo);
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
    if (publication?.setSubscribed &&
        shouldSubscribeRegisteredScreenPublication(publication, ksMeta?.participant, ksMeta?.room)) {
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
  const recoveryGeneration = {
    room: room,
    trackSid: trackSid,
    meta: srMeta,
    tile: srMeta?.tile || null,
    publication: publication,
    track: publication.track,
    element: element,
    playGeneration: element._playGeneration || 0,
  };
  setTimeout(() => {
    if (!isCurrentRegisteredScreenElementGeneration(recoveryGeneration, true)) return;
    const isBlack = element._isBlack === true;
    const lastFrame = element._lastFrameTs || 0;
    const stalled = performance.now() - lastFrame > 1200;
    if (!isBlack || !stalled) return;
    screenRecoveryAttempts.set(trackSid, attempt + 1);
    if (publication.setSubscribed) {
      markResubscribeIntent(trackSid);
      publication.setSubscribed(false);
      setTimeout(() => {
        if (!isCurrentRegisteredScreenElementGeneration(recoveryGeneration, false)) return;
        if (!shouldSubscribeRegisteredScreenPublication(
          publication,
          recoveryGeneration.meta?.participant,
          recoveryGeneration.room
        )) return;
        publication.setSubscribed(true);
      }, 300);
    }
    requestVideoKeyFrame(publication, publication.track);
    element._isBlack = false;
  }, 700);
}

function isCurrentRegisteredScreenElementGeneration(generation, requireAttachedElement) {
  if (!generation || room !== generation.room || !generation.meta || !generation.tile) return false;
  if (screenTrackMeta.get(generation.trackSid) !== generation.meta ||
      screenTileBySid.get(generation.trackSid) !== generation.tile) return false;
  if (!generation.tile.isConnected ||
      generation.meta.publication !== generation.publication ||
      generation.meta.tile !== generation.tile ||
      generation.tile._screenPublication !== generation.publication ||
      generation.tile._screenTrack !== generation.track) return false;
  if (generation.publication.track && generation.publication.track !== generation.track) return false;
  if (!generation.element ||
      (generation.element._playGeneration || 0) !== generation.playGeneration ||
      generation.element._lkTrack !== generation.track) return false;
  if (requireAttachedElement) {
    return generation.element.isConnected &&
      generation.tile.querySelector("video") === generation.element;
  }
  return true;
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

function captureVideoLayerGeneration(publication, element) {
  return {
    room: room,
    publication: publication,
    track: publication?.track || null,
    element: element,
    playGeneration: element?._playGeneration || 0,
  };
}

function isCurrentVideoLayerGeneration(generation) {
  return !!generation && room === generation.room &&
    !!generation.publication && generation.publication.track === generation.track &&
    !!generation.element && generation.element.isConnected &&
    generation.element._lkTrack === generation.track &&
    (generation.element._playGeneration || 0) === generation.playGeneration;
}

function forceVideoLayer(publication, element, expectedGeneration) {
  if (!publication || !element) return;
  const generation = expectedGeneration || captureVideoLayerGeneration(publication, element);
  if (!isCurrentVideoLayerGeneration(generation)) return;
  if (element && element.videoWidth === 0 && element.videoHeight === 0) {
    setTimeout(() => forceVideoLayer(publication, element, generation), 800);
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
          if (isCurrentVideoLayerGeneration(generation) &&
              element.videoWidth > 0 && targetQuality != null) {
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
    if (!shouldSubscribeRegisteredScreenPublication(
      publication,
      evsMeta?.participant,
      evsMeta?.room
    )) return;
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
    attemptAndroidFirefoxScreenSubscriptionReset,
    attemptAndroidFirefoxConnectedMediaRelayRecovery,
    createVideoFrameRateTracker,
    capturePhoneFullscreenFrameMarker,
    capturePhoneFullscreenMediaGeneration,
    createPhoneFullscreenRecoveryContext,
    didPhoneFullscreenFrameAdvance,
    getVideoFullscreenControlLabel,
    getVideoFullscreenMediaName,
    getVideoPresentationSnapshot,
    isAndroidFirefoxConnectedMediaStallCurrent,
    isCurrentScreenRecoveryGeneration,
    isCurrentPhoneFullscreenMediaGeneration,
    isCurrentVideoLayerGeneration,
  };
}

function cleanupVideoDiagnostics(overlay) {
  if (!overlay) return;
  const timer = Number(overlay.dataset.timer || 0);
  if (timer) clearInterval(timer);
}

// ── Camera recovery ──

function stampCameraAvatarVideoGeneration(video, participant, publication, track, expectedRoom) {
  if (!video) return;
  video._echoCameraRoom = expectedRoom || room;
  video._echoCameraParticipant = participant || null;
  video._echoCameraPublication = publication || null;
  video._echoCameraTrack = track || null;
}

function scheduleCameraRecovery(identity, cardRef, publication) {
  if (!identity || !cardRef || !publication) return;
  const key = `${identity}-camera`;
  const attempt = cameraRecoveryAttempts.get(key) || 0;
  if (attempt >= 2) return;
  const expectedRoom = room;
  const expectedParticipant = getCameraStageParticipant(identity, expectedRoom);
  const expectedTrack = publication.track;
  setTimeout(() => {
    // This timer may outlive a Room, participant, or camera publication. Never
    // let an old generation reattach over a newer same-identity camera.
    if (participantCards.get(identity) !== cardRef || !isCurrentCameraTrackGeneration(
      identity,
      expectedParticipant,
      publication,
      expectedTrack,
      expectedRoom
    )) {
      debugLog(`camera recovery skipped ${identity} (stale generation)`);
      return;
    }
    // Guard: don't recover if the track has ended or been unsubscribed
    if (!publication?.isSubscribed || expectedTrack?.mediaStreamTrack?.readyState === "ended") {
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
    if (expectedTrack) {
      updateAvatarVideo(cardRef, expectedTrack);
      const next = cardRef.avatar.querySelector("video");
      if (next) {
        stampCameraAvatarVideoGeneration(
          next,
          expectedParticipant,
          publication,
          expectedTrack,
          expectedRoom
        );
        ensureVideoPlays(expectedTrack, next);
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
  const currentParticipant = getCameraStageParticipant(cardIdentity, room);
  if (!isCurrentCameraTrackGeneration(
    cardIdentity,
    currentParticipant,
    publication,
    track,
    room
  )) {
    debugLog(`[camera-stage] ignored stale camera generation for ${cardIdentity}`);
    return;
  }
  cancelCameraClearTimer(cardIdentity);
  cardRef.cameraRoom = room;
  cardRef.cameraParticipant = currentParticipant;
  cardRef.cameraPublication = publication;
  cardRef.cameraTrack = track;
  const cameraLabel = cardRef.card?.querySelector(".user-name")?.textContent || cardIdentity;
  reconcileCameraStageTrack(cardIdentity, cameraLabel, track, publication);
  debugLog(`ensureCameraVideo called for track ${track.sid || 'unknown'}, participant=${cardIdentity}, cardRef.avatar=${!!cardRef.avatar}`);
  const existing = cardRef.avatar.querySelector("video");
  if (existing && existing._lkTrack === track) {
    stampCameraAvatarVideoGeneration(existing, currentParticipant, publication, track, room);
    ensureVideoPlays(track, existing);
    ensureVideoSubscribed(publication, existing);
    const age = performance.now() - (existing._attachedAt || 0);
    if (age > 1500 && (existing.videoWidth === 0 || existing.videoHeight === 0)) {
      updateAvatarVideo(cardRef, track);
      const next = cardRef.avatar.querySelector("video");
      if (next) {
        stampCameraAvatarVideoGeneration(next, currentParticipant, publication, track, room);
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
    stampCameraAvatarVideoGeneration(video, currentParticipant, publication, track, room);
    ensureVideoPlays(track, video);
    ensureVideoSubscribed(publication, video);
    requestVideoKeyFrame(publication, track);
    scheduleCameraRecovery(cardRef.card?.dataset?.identity || "", cardRef, publication);
  }
}
