(function(root) {
  "use strict";

  var POLL_MS = 3000;
  var STALL_MS = 8000;
  var SINK_GRACE_MS = 6000;
  var SUBSCRIPTION_DELAY_MS = 500;
  var REARM_PROGRESS_FRAMES = 2;
  var stateBySid = new Map();
  var diagnostics = {
    fallbackActivations: 0,
    fallbackProgressSamples: 0,
    fallbackSamples: 0,
    sinkAttempts: 0,
    subscriptionAttempts: 0,
    unavailableSamples: 0,
  };

  function logRecovery(message) {
    if (typeof debugLog !== "function") return;
    try { debugLog("[android-firefox-presentation-recovery] " + message); }
    catch (_error) {}
  }

  function finiteFrameCounter(value) {
    if (value === null || value === undefined) return null;
    var number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function readPresentedFrameSample(video) {
    var stats = video && video._echoPresentationStats;
    var presentedFrames = finiteFrameCounter(stats && stats.presentedFrames);
    if (presentedFrames !== null) {
      return { frames: presentedFrames, source: "presented-frames" };
    }
    if (!video || typeof video.getVideoPlaybackQuality !== "function") return null;
    try {
      var quality = video.getVideoPlaybackQuality();
      var totalVideoFrames = finiteFrameCounter(quality && quality.totalVideoFrames);
      return totalVideoFrames === null
        ? null
        : { frames: totalVideoFrames, source: "playback-quality" };
    } catch (_error) {
      return null;
    }
  }

  function currentTarget(rootObject) {
    var win = rootObject || root;
    var loader = win.EchoAndroidFirefoxPresentationRecoveryLoader;
    return !!loader && loader.isExactTarget({
      isNativeShell: win.__ECHO_NATIVE__ === true,
      userAgent: win.navigator && win.navigator.userAgent,
    });
  }

  function exactGeneration(trackSid, expected) {
    if (!trackSid || !expected) return null;
    var meta = typeof screenTrackMeta === "object" ? screenTrackMeta.get(trackSid) : null;
    var tile = typeof screenTileBySid === "object" ? screenTileBySid.get(trackSid) : null;
    if (!meta || !tile || meta !== expected.meta || tile !== expected.tile) return null;
    if (meta.publication !== expected.publication || !tile.isConnected) return null;
    if (tile.dataset && tile.dataset.trackSid !== trackSid) return null;
    if (typeof room !== "object" || !room || room !== expected.room) return null;
    if (String(room.state || "").toLowerCase() !== "connected") return null;
    if (room.localParticipant && meta.identity === room.localParticipant.identity) return null;
    if (typeof hiddenScreens === "object" && hiddenScreens.has(meta.identity)) return null;
    if (typeof shouldSubscribeParticipantPublication === "function" &&
        !shouldSubscribeParticipantPublication(meta.publication, meta.participant, expected.room)) {
      return null;
    }
    return { meta: meta, publication: meta.publication, tile: tile };
  }

  function currentGeneration(trackSid, expected) {
    var exact = exactGeneration(trackSid, expected);
    if (!exact) return null;
    var meta = exact.meta;
    var tile = exact.tile;
    var publication = exact.publication;
    var track = publication && publication.track;
    var mediaTrack = track && track.mediaStreamTrack;
    var video = tile.querySelector && tile.querySelector("video");
    if (!video || video._lkTrack !== track || publication.isSubscribed !== true) return null;
    if (!mediaTrack || mediaTrack.readyState !== "live") return null;
    if (String(room.state || "").toLowerCase() !== "connected") return null;
    if (root.document && root.document.visibilityState === "hidden") return null;
    return { meta: meta, publication: publication, tile: tile, track: track, video: video };
  }

  function reattachSink(trackSid, generation) {
    var current = currentGeneration(trackSid, generation);
    if (!current || typeof current.track.detach !== "function" ||
        typeof current.track.attach !== "function") return false;
    // Keep the production tile, video element, diagnostics callback, object-fit
    // guard, fullscreen host, and Tools/focus handlers completely stable.
    try { current.track.detach(current.video); } catch (_error) { return false; }
    try {
      current.track.attach(current.video);
      current.video._lkTrack = current.track;
    } catch (_error) {
      try { current.track.attach(current.video); } catch (_ignored) {}
      return false;
    }
    if (typeof configureVideoElement === "function") configureVideoElement(current.video, true);
    if (typeof ensureVideoPlays === "function") ensureVideoPlays(current.track, current.video);
    if (typeof ensureVideoSubscribed === "function") ensureVideoSubscribed(current.publication, current.video);
    if (typeof requestVideoKeyFrame === "function") requestVideoKeyFrame(current.publication, current.track);
    return current.tile.querySelector("video") === current.video && current.video._lkTrack === current.track;
  }

  function resetSubscription(trackSid, generation) {
    var current = currentGeneration(trackSid, generation);
    if (!current || typeof current.publication.setSubscribed !== "function") return false;
    if (typeof markResubscribeIntent === "function") markResubscribeIntent(trackSid);
    current.publication.setSubscribed(false);
    root.setTimeout(function() {
      var latest = exactGeneration(trackSid, generation);
      if (!latest) return;
      latest.publication.setSubscribed(true);
      if (typeof requestVideoKeyFrame === "function") {
        requestVideoKeyFrame(latest.publication, latest.publication.track || current.track);
      }
    }, SUBSCRIPTION_DELAY_MS);
    return true;
  }

  function recordPresentationProgress(state, now) {
    state.sawPresentedFrame = true;
    state.lastProgressAt = now;
    if (state.sinkAttempted !== true && state.subscriptionAttempted !== true) {
      state.progressTicks = 0;
      return;
    }
    state.progressTicks = (state.progressTicks || 0) + 1;
    if (state.progressTicks < REARM_PROGRESS_FRAMES) return;
    state.sinkAttempted = false;
    state.subscriptionAttempted = false;
    state.progressTicks = 0;
  }

  function stateOwnsGeneration(state, generation, current) {
    return !!state && state.room === generation.room && state.meta === generation.meta &&
      state.publication === generation.publication && state.tile === generation.tile &&
      state.track === current.track && state.video === current.video;
  }

  function createGenerationState(generation, current, trackSid) {
    return {
      lastProgressAt: 0,
      meta: generation.meta,
      progressTicks: 0,
      publication: generation.publication,
      room: generation.room,
      tile: generation.tile,
      track: current.track,
      trackSid: trackSid,
      video: current.video,
    };
  }

  function observePresentedFrame(video, now, state) {
    var sample = readPresentedFrameSample(video);
    if (!sample) {
      diagnostics.unavailableSamples += 1;
      return false;
    }
    var frames = sample.frames;
    if (sample.source === "playback-quality") diagnostics.fallbackSamples += 1;
    if (state.presentationCounterSource !== sample.source) {
      state.presentationCounterSource = sample.source;
      state.lastPresentedFrames = frames;
      if (sample.source === "playback-quality") {
        diagnostics.fallbackActivations += 1;
        logRecovery("using playback-quality frame fallback sid=" + (state.trackSid || "unknown"));
      }
      if (state.sawPresentedFrame === true) {
        // The two counters are not comparable. Rebase and give the new source
        // one polling interval instead of misclassifying the source change as
        // an immediate stall.
        state.lastProgressAt = now;
        return true;
      }
      if (frames < 1) return false;
      if (sample.source === "playback-quality") diagnostics.fallbackProgressSamples += 1;
      recordPresentationProgress(state, now);
      return true;
    }
    if (state.video && state.video !== video) {
      state.video = video;
      state.lastPresentedFrames = frames;
      if (frames < 1) return false;
      if (sample.source === "playback-quality") diagnostics.fallbackProgressSamples += 1;
      recordPresentationProgress(state, now);
      return true;
    }
    state.video = video;
    if (!Number.isFinite(state.lastPresentedFrames)) {
      state.lastPresentedFrames = frames;
      if (frames < 1) return false;
      recordPresentationProgress(state, now);
      return true;
    }
    if (frames === state.lastPresentedFrames) return false;
    if (frames < state.lastPresentedFrames) {
      state.lastPresentedFrames = frames;
      if (frames < 1) {
        // Firefox may reset VideoPlaybackQuality when its decoder/sink is
        // rebound. Zero is not proof of a frame, but it is a new baseline.
        if (state.sawPresentedFrame === true) state.lastProgressAt = now;
        return true;
      }
      if (sample.source === "playback-quality") diagnostics.fallbackProgressSamples += 1;
      recordPresentationProgress(state, now);
      return true;
    }
    state.lastPresentedFrames = frames;
    if (sample.source === "playback-quality") diagnostics.fallbackProgressSamples += 1;
    recordPresentationProgress(state, now);
    return true;
  }

  function inspect(now) {
    if (!currentTarget(root) || typeof screenTrackMeta !== "object") return 0;
    var actions = 0;
    screenTrackMeta.forEach(function(meta, trackSid) {
      var tile = typeof screenTileBySid === "object" ? screenTileBySid.get(trackSid) : null;
      var publication = meta && meta.publication;
      var generation = { meta: meta, publication: publication, room: room, tile: tile };
      var observed = {
        track: publication && publication.track,
        video: tile && tile.querySelector && tile.querySelector("video"),
      };
      var state = stateBySid.get(trackSid);
      if (state && !stateOwnsGeneration(state, generation, observed)) state = null;
      var current = currentGeneration(trackSid, generation);
      if (!current) {
        if (state) stateBySid.set(trackSid, state);
        else stateBySid.delete(trackSid);
        return;
      }
      if (!state) {
        state = createGenerationState(generation, current, trackSid);
      }
      stateBySid.set(trackSid, state);
      var presentationReady = current.video.paused !== true && current.video.readyState >= 2 &&
        current.video.videoWidth > 0 && current.video.videoHeight > 0;
      if (state.sinkAttempted !== true && !presentationReady) return;
      if (observePresentedFrame(current.video, now, state)) return;
      // A live track that never produced one genuinely presented frame belongs
      // to #238's existing media-start recovery, not this presentation ladder.
      if (state.sawPresentedFrame !== true) return;
      if (!(state.lastProgressAt > 0) || now - state.lastProgressAt < STALL_MS) return;
      state.progressTicks = 0;
      if (!state.sinkAttempted) {
        diagnostics.sinkAttempts += 1;
        logRecovery("reattaching stalled presentation sink sid=" + trackSid);
        var reattached = reattachSink(trackSid, generation);
        // Consume the first-line attempt even when the browser rejects it so a
        // failed same-node reattach cannot block the one bounded SID reset.
        state.sinkAttempted = true;
        state.sinkAttemptedAt = now;
        if (reattached) actions += 1;
        return;
      }
      if (!state.subscriptionAttempted && !state.subscriptionEverAttempted &&
          now - state.sinkAttemptedAt >= SINK_GRACE_MS) {
        if (resetSubscription(trackSid, generation)) {
          diagnostics.subscriptionAttempts += 1;
          logRecovery("resetting stalled presentation subscription sid=" + trackSid);
          state.subscriptionAttempted = true;
          state.subscriptionEverAttempted = true;
          state.subscriptionAttemptedAt = now;
          actions += 1;
        }
      }
    });
    stateBySid.forEach(function(_state, trackSid) {
      if (!screenTrackMeta.has(trackSid)) stateBySid.delete(trackSid);
    });
    return actions;
  }

  function start() {
    if (!currentTarget(root) || root.__echoAndroidFirefoxPresentationRecoveryTimer) return false;
    root.__echoAndroidFirefoxPresentationRecoveryTimer = root.setInterval(function() {
      try { inspect(typeof performance === "object" ? performance.now() : Date.now()); }
      catch (error) {
        if (typeof debugLog === "function") {
          debugLog("[android-firefox-presentation-recovery] " + (error && error.message || error));
        }
      }
    }, POLL_MS);
    return true;
  }

  var api = { currentGeneration: currentGeneration, currentTarget: currentTarget,
    createGenerationState: createGenerationState, exactGeneration: exactGeneration, inspect: inspect,
    diagnostics: diagnostics, observePresentedFrame: observePresentedFrame,
    readPresentedFrameSample: readPresentedFrameSample, reattachSink: reattachSink,
    resetSubscription: resetSubscription, start: start, stateBySid: stateBySid,
    stateOwnsGeneration: stateOwnsGeneration };
  root.EchoAndroidFirefoxPresentationRecovery = api;
  if (typeof module === "object" && module.exports) module.exports = api;
  start();
})(typeof window === "object" ? window : globalThis);
