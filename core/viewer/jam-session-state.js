(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EchoJamSessionState = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const JAM_PROTOCOL_VERSION = 3;

  function normalizeSourceStatus(value) {
    const status = String(value || "unknown").trim().toLowerCase();
    return status || "unknown";
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function planAudioFrame(nextPlayTime, currentTime, duration, maxLeadSeconds) {
    const now = Number(currentTime);
    const frameDuration = Number(duration);
    const next = Number(nextPlayTime);
    const maxLead = Number.isFinite(maxLeadSeconds) ? maxLeadSeconds : 0.5;
    if (!Number.isFinite(now) || !Number.isFinite(frameDuration) || frameDuration <= 0) {
      return { drop: true, startTime: null, nextPlayTime: Number.isFinite(next) ? next : 0 };
    }

    const startTime = !Number.isFinite(next) || next < now ? now + 0.02 : next;
    if (startTime - now > maxLead) {
      // Keep already-scheduled audio intact and discard newly arrived backlog.
      // Resetting to `now` here would overlap buffers Web Audio already accepted.
      return { drop: true, startTime: null, nextPlayTime: startTime };
    }
    return {
      drop: false,
      startTime,
      nextPlayTime: startTime + frameDuration,
    };
  }

  function shouldResetListeningForServerState(serverState, listeningGeneration) {
    const input = serverState && typeof serverState === "object" ? serverState : {};
    if (input.active !== true) return true;
    const expected = Number(listeningGeneration);
    const actual = Number(input.generation);
    return Number.isFinite(expected) && Number.isFinite(actual) && expected !== actual;
  }

  function createLatestRequestGate() {
    let latestRequest = 0;
    return {
      begin() {
        latestRequest += 1;
        return latestRequest;
      },
      isCurrent(request) {
        return request === latestRequest;
      },
    };
  }

  function shouldMuteLocalRelay(isSourceHost, listenerJoined, takeoverActive, monitorEnabled) {
    if (isSourceHost !== true || listenerJoined === false) return false;
    // The legacy source-host path remains muted to prevent a doubled local
    // Spotify + Echo relay. Native takeover may explicitly opt into the relay
    // as the source PC's monitor without changing the user's Jam volume.
    return takeoverActive !== true || monitorEnabled !== true;
  }

  function effectiveJamGain(volumePercent, roomAudioMuted) {
    if (roomAudioMuted === true) return 0;
    const volume = Number(volumePercent);
    if (!Number.isFinite(volume)) return 0;
    return Math.max(0, Math.min(100, volume)) / 100;
  }

  function effectiveJamRelayGain(volumePercent, roomAudioMuted, localControl) {
    const local = localControl && typeof localControl === "object" ? localControl : {};
    if (shouldMuteLocalRelay(
      local.is_source_host === true,
      true,
      local.takeover_active === true,
      local.monitor_enabled === true
    )) {
      return 0;
    }
    return effectiveJamGain(volumePercent, roomAudioMuted);
  }

  function buildJamAudioSocketQuery(protocolVersion, generation) {
    const protocol = Number(protocolVersion);
    if (generation === null || generation === undefined || generation === "") {
      throw new Error("Invalid Jam generation");
    }
    const currentGeneration = Number(generation);
    if (!Number.isInteger(protocol) || protocol <= 0) {
      throw new Error("Invalid Jam protocol version");
    }
    if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0) {
      throw new Error("Invalid Jam generation");
    }
    return `jam_protocol_version=${encodeURIComponent(protocol)}&generation=${encodeURIComponent(currentGeneration)}`;
  }

  function parseJamAudioControlMessage(message) {
    if (typeof message !== "string") return { type: "binary" };
    let payload;
    try {
      payload = JSON.parse(message);
    } catch (error) {
      return { type: "invalid", message: "Invalid Jam audio control message" };
    }
    if (!payload || typeof payload !== "object") {
      return { type: "invalid", message: "Invalid Jam audio control message" };
    }
    if (payload.type === "ready") return { type: "ready" };
    if (payload.type === "error") {
      return {
        type: "error",
        message: typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : "Jam audio authentication failed",
      };
    }
    return { type: "invalid", message: "Unexpected Jam audio control message" };
  }

  function shouldOpenAudioAfterRejoin(listenerState, expectedGeneration, currentGeneration, tokenUnchanged) {
    const listener = listenerState && typeof listenerState === "object" ? listenerState : {};
    const expected = expectedGeneration === null || expectedGeneration === undefined || expectedGeneration === ""
      ? Number.NaN
      : Number(expectedGeneration);
    const current = currentGeneration === null || currentGeneration === undefined || currentGeneration === ""
      ? Number.NaN
      : Number(currentGeneration);
    return listener.desiredListening === true &&
      listener.serverJoined === true &&
      listener.pendingLeave !== true &&
      Number.isSafeInteger(expected) &&
      Number.isSafeInteger(current) &&
      expected === current &&
      tokenUnchanged === true;
  }

  function shouldApplyBannerResponse(fullPollingActive, requestIsCurrent) {
    return fullPollingActive !== true && requestIsCurrent === true;
  }

  function evaluateJamContract(serverState) {
    const input = serverState && typeof serverState === "object" ? serverState : {};
    const rawProtocol = input.jam_protocol_version;
    const actualProtocol = rawProtocol === null || rawProtocol === undefined || rawProtocol === ""
      ? Number.NaN
      : Number(rawProtocol);
    const compatible = Number.isFinite(actualProtocol) && actualProtocol === JAM_PROTOCOL_VERSION;
    const sourceStatus = normalizeSourceStatus(input.source_status);
    const sourceEnabled = input.source_enabled === true;
    const sourceAvailabilityKnown = input.source_availability_known === true;
    const sourceUnavailable = ["disabled", "offline", "unconfigured", "error", "failed"].includes(sourceStatus);
    const sourceReady = sourceAvailabilityKnown && sourceEnabled &&
      sourceStatus !== "negotiating" && sourceStatus !== "stalled" && !sourceUnavailable &&
      (input.source_ready === true || ["ready", "live", "silent"].includes(sourceStatus));
    // A stalled source is still the configured, generation-current source. Keep
    // queue/skip available so users can recover Spotify playback, while joining
    // and opening new audio sockets remain fail-closed until PCM is healthy.
    const sourceControlReady = sourceAvailabilityKnown && sourceEnabled &&
      sourceStatus !== "negotiating" && !sourceUnavailable &&
      (input.source_ready === true || ["ready", "live", "silent", "stalled"].includes(sourceStatus));
    const active = input.active === true;
    const spotifyConnected = input.spotify_connected === true;
    const spotifyIsPlaying = input.spotify_is_playing === true;
    const playbackStopSupported = input.playback_stop_supported === true;
    const sourceError = typeof input.source_error === "string" ? input.source_error.trim() : "";

    let sourceTone = "waiting";
    let sourceMessage = "Host source status is unavailable";
    if (sourceStatus === "disabled") {
      sourceTone = "warning";
      sourceMessage = "Echo Jam is disabled on the Spotify PC";
    } else if (sourceStatus === "negotiating") {
      sourceMessage = "Echo is preparing Spotify control on the source PC…";
    } else if (!sourceAvailabilityKnown) {
      sourceMessage = "Checking Spotify control on the source PC…";
    } else if (!sourceEnabled) {
      sourceTone = "warning";
      sourceMessage = "Echo Jam is disabled on the Spotify PC";
    } else if (sourceStatus === "ready" || (sourceReady && sourceStatus === "unknown")) {
      sourceTone = "ready";
      sourceMessage = "Host source is online";
    } else if (sourceStatus === "live") {
      sourceTone = "ready";
      sourceMessage = "Host source audio is live";
    } else if (sourceStatus === "silent") {
      sourceTone = "warning";
      sourceMessage = "Host source is connected — Spotify is silent or paused";
    } else if (sourceStatus === "configured") {
      sourceMessage = "Host source is configured — waiting for capture";
    } else if (sourceStatus === "starting") {
      sourceMessage = "Host source is starting…";
    } else if (sourceStatus === "offline") {
      sourceTone = "error";
      sourceMessage = sourceError || "Host source is offline";
    } else if (sourceStatus === "unconfigured") {
      sourceTone = "error";
      sourceMessage = sourceError || "Host source is not configured";
    } else if (sourceStatus === "stalled") {
      sourceTone = "error";
      sourceMessage = sourceError || "Spotify is playing but Echo audio has stalled";
    } else if (sourceStatus === "error" || sourceStatus === "failed") {
      sourceTone = "error";
      sourceMessage = sourceError || "Host source failed";
    } else if (sourceError) {
      sourceTone = "error";
      sourceMessage = sourceError;
    }

    const compatibilityMessage = compatible
      ? ""
      : Number.isFinite(actualProtocol)
        ? `Jam viewer/server mismatch (viewer v${JAM_PROTOCOL_VERSION}, server v${actualProtocol}) — reopen Echo after the server update`
        : `Jam viewer/server mismatch (viewer v${JAM_PROTOCOL_VERSION}, server did not report a protocol) — reopen Echo after the server update`;

    return {
      expectedProtocol: JAM_PROTOCOL_VERSION,
      actualProtocol: Number.isFinite(actualProtocol) ? actualProtocol : null,
      compatible,
      compatibilityMessage,
      active,
      spotifyConnected,
      spotifyIsPlaying,
      playbackStopSupported,
      sourceEnabled,
      sourceAvailabilityKnown,
      sourceStatus,
      sourceReady,
      sourceControlReady,
      sourceTone,
      sourceMessage,
      sourceError,
      sourceLastFrameMs: numberOrNull(input.source_last_frame_ms),
      sourcePeak: numberOrNull(input.source_peak),
      canStart: compatible && !active && spotifyConnected && sourceReady,
      // New listeners fail closed on stalled PCM. Queue/skip intentionally stay
      // available against the current source so they can recover Spotify playback.
      canJoin: compatible && active && sourceReady,
      canControl: compatible && active && sourceControlReady,
      // Stopping Spotify playback does not depend on capture health. Keep the
      // action available during source stalls/errors while music is still
      // reported as playing on the configured Spotify device.
      canStopPlayback: compatible && active && spotifyConnected &&
        playbackStopSupported && spotifyIsPlaying,
      canConfigure: compatible,
    };
  }

  function createJamSessionState(options) {
    const opts = options || {};
    const reconnectBaseMs = Number.isFinite(opts.reconnectBaseMs) ? opts.reconnectBaseMs : 500;
    const reconnectMaxMs = Number.isFinite(opts.reconnectMaxMs) ? opts.reconnectMaxMs : 8000;

    const state = {
      desiredListening: false,
      serverJoined: false,
      streamConnected: false,
      streamConnecting: false,
      reconnectAttempt: 0,
      pendingLeave: false,
      lastError: null,
    };

    function nextDelay() {
      const step = Math.min(state.reconnectAttempt, 6);
      return Math.min(reconnectBaseMs * Math.pow(2, step), reconnectMaxMs);
    }

    function requestJoin() {
      state.desiredListening = true;
      state.streamConnecting = true;
      state.pendingLeave = false;
      state.lastError = null;
      return snapshot();
    }

    function joinAccepted() {
      state.serverJoined = true;
      state.streamConnecting = true;
      state.lastError = null;
      return snapshot();
    }

    function joinRejected(errorMessage) {
      state.desiredListening = false;
      state.serverJoined = false;
      state.streamConnected = false;
      state.streamConnecting = false;
      state.reconnectAttempt = 0;
      state.pendingLeave = false;
      state.lastError = errorMessage || "join-failed";
      return snapshot();
    }

    function streamOpen() {
      // Ignore late stream-open callbacks that arrive after user requested leave.
      if (state.pendingLeave || !state.desiredListening) {
        state.streamConnected = false;
        state.streamConnecting = false;
        return snapshot();
      }

      state.streamConnected = true;
      state.streamConnecting = false;
      state.reconnectAttempt = 0;
      state.lastError = null;
      return snapshot();
    }

    function streamClosedTransient(errorMessage) {
      state.streamConnected = false;
      state.streamConnecting = false;
      state.lastError = errorMessage || null;

      if (!state.desiredListening || !state.serverJoined || state.pendingLeave) {
        state.reconnectAttempt = 0;
        return { shouldReconnect: false, delayMs: 0, snapshot: snapshot() };
      }

      const delayMs = nextDelay();
      state.reconnectAttempt += 1;
      return { shouldReconnect: true, delayMs, snapshot: snapshot() };
    }

    function reconnectAttemptStarted() {
      if (!state.desiredListening || !state.serverJoined || state.pendingLeave) {
        return { shouldConnect: false, snapshot: snapshot() };
      }
      state.streamConnecting = true;
      return { shouldConnect: true, snapshot: snapshot() };
    }

    function requestLeave() {
      state.pendingLeave = true;
      state.desiredListening = false;
      state.streamConnecting = false;
      return snapshot();
    }

    function leaveSucceeded() {
      state.pendingLeave = false;
      state.serverJoined = false;
      state.streamConnected = false;
      state.streamConnecting = false;
      state.reconnectAttempt = 0;
      state.lastError = null;
      return snapshot();
    }

    function leaveFailed(errorMessage) {
      state.pendingLeave = false;
      // Server likely still considers us joined; preserve serverJoined=true and
      // restore desiredListening intent so reconnect policy can recover stream.
      state.serverJoined = true;
      state.desiredListening = true;
      state.lastError = errorMessage || "leave-failed";
      return snapshot();
    }

    function ui() {
      const connecting = state.streamConnecting && !state.streamConnected;
      return {
        joinVisible: !state.streamConnected && !connecting,
        leaveVisible: state.streamConnected || connecting || state.pendingLeave,
        status: state.streamConnected
          ? "connected"
          : connecting
            ? "connecting"
            : state.lastError
              ? "error"
              : "idle",
      };
    }

    function snapshot() {
      return {
        desiredListening: state.desiredListening,
        serverJoined: state.serverJoined,
        streamConnected: state.streamConnected,
        streamConnecting: state.streamConnecting,
        reconnectAttempt: state.reconnectAttempt,
        pendingLeave: state.pendingLeave,
        lastError: state.lastError,
      };
    }

    return {
      requestJoin,
      joinAccepted,
      joinRejected,
      streamOpen,
      streamClosedTransient,
      reconnectAttemptStarted,
      requestLeave,
      leaveSucceeded,
      leaveFailed,
      ui,
      snapshot,
    };
  }

  return {
    JAM_PROTOCOL_VERSION,
    buildJamAudioSocketQuery,
    evaluateJamContract,
    effectiveJamGain,
    effectiveJamRelayGain,
    parseJamAudioControlMessage,
    planAudioFrame,
    shouldApplyBannerResponse,
    shouldResetListeningForServerState,
    shouldOpenAudioAfterRejoin,
    createLatestRequestGate,
    shouldMuteLocalRelay,
    createJamSessionState,
  };
});
