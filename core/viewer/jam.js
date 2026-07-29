/* =========================================================
   JAM SESSION — Communal Spotify listening for Echo Chamber
   Loaded AFTER app.js. Shares global scope with app.js.
   ========================================================= */

// === Globals ===
var _jamState = null;
var _jamPollTimer = null;
var _jamVolume = 50;
var _spotifyAuthState = null;
var _spotifyVerifier = null;
var _spotifyPollTimer = null;
var _jamInited = false;       // lazy init -- don't poll until panel opened once
var _bannerPollTimer = null;  // lightweight poll for now-playing banner (runs even if panel not open)

// WebSocket audio streaming
var _jamAudioWs = null;        // WebSocket connection
var _jamAudioCtx = null;       // AudioContext for playback
var _jamGainNode = null;       // GainNode for volume control
var _jamNextPlayTime = 0;      // next scheduled buffer start time
var _jamReconnectTimer = null;
var _jamRejoinPromise = null;
var JAM_PROTOCOL_VERSION = 3;
var _jamContract = null;
var _jamListeningGeneration = null;
var _jamIsSourceHost = null;
var _jamSourceLocalControl = null;
var _jamSourceLocalControlPromise = null;
var _jamSourceLocalControlPending = false;
var _jamSourceLocalControlLegacy = false;
var _jamSourceLocalControlsBound = false;
var _jamSourceLocalPollTimer = null;
var _jamRelayMuteNoticeShown = false;
var _jamStateRequestGate = (window.EchoJamSessionState && window.EchoJamSessionState.createLatestRequestGate)
  ? window.EchoJamSessionState.createLatestRequestGate()
  : (function() {
      var latestRequest = 0;
      return {
        begin: function() { latestRequest += 1; return latestRequest; },
        isCurrent: function(request) { return request === latestRequest; }
      };
    })();
var _jamSessionState = (window.EchoJamSessionState && window.EchoJamSessionState.createJamSessionState)
  ? window.EchoJamSessionState.createJamSessionState({ reconnectBaseMs: 500, reconnectMaxMs: 8000 })
  : null;

function jamActorHeaders(participantToken) {
  return {
    "Authorization": "Bearer " + adminToken,
    "X-Echo-Participant-Token": participantToken === undefined ? currentAccessToken : participantToken,
    "Content-Type": "application/json"
  };
}

function normalizeJamSourceLocalControl(value) {
  var input = value && typeof value === "object" ? value : {};
  return {
    is_source_host: input.is_source_host === true,
    takeover_enabled: input.takeover_enabled === true,
    monitor_enabled: input.monitor_enabled === true,
    takeover_active: input.takeover_active === true,
    agent_running: input.agent_running === true,
    target_device_name: typeof input.target_device_name === "string" ? input.target_device_name.trim() : "",
    last_error: typeof input.last_error === "string" ? input.last_error.trim() : ""
  };
}

function jamSourceLocalErrorMessage(error) {
  if (error && typeof error.message === "string" && error.message.trim()) return error.message.trim();
  var message = String(error || "Unknown native control error").trim();
  return message || "Unknown native control error";
}

function renderJamSourceLocalControl() {
  var state = _jamSourceLocalControl;
  var isSourceHost = !!state && state.is_source_host === true;
  var status = "Checking this PC…";
  var tone = "";

  if (isSourceHost) {
    var device = state.target_device_name || "Spotify on this PC";
    if (_jamSourceLocalControlPending) {
      status = "Saving this PC's Jam settings…";
    } else if (_jamSourceLocalControlLegacy) {
      status = "Echo update required for local Spotify controls";
      tone = "warning";
    } else if (state.last_error) {
      status = state.last_error;
      tone = "warning";
    } else if (state.takeover_active && !state.takeover_enabled) {
      status = "Stopping the Jam and returning Spotify to this PC...";
      tone = "warning";
    } else if (!state.takeover_enabled) {
      status = "Spotify control is off";
      tone = "warning";
    } else if (state.takeover_active) {
      status = "Echo is using " + device + (state.monitor_enabled ? " · local Jam monitor is enabled" : " · local Jam monitor is off");
      tone = "ready";
    } else if (!state.agent_running) {
      status = "Spotify control is starting…";
    } else {
      status = "Ready to use " + device + " when the Jam starts";
      tone = "ready";
    }
  }

  document.querySelectorAll("[data-jam-source-local-card]").forEach(function(card) {
    card.hidden = !isSourceHost;
    card.classList.toggle("hidden", !isSourceHost);
  });
  document.querySelectorAll("[data-jam-source-local-status]").forEach(function(el) {
    el.textContent = status;
    el.className = "jam-source-local-status" + (tone ? " " + tone : "");
  });
  document.querySelectorAll("[data-jam-source-takeover-toggle]").forEach(function(input) {
    input.checked = isSourceHost && state.takeover_enabled === true;
    input.disabled = !isSourceHost || _jamSourceLocalControlPending || _jamSourceLocalControlLegacy;
  });
  document.querySelectorAll("[data-jam-source-monitor-toggle]").forEach(function(input) {
    input.checked = isSourceHost && state.monitor_enabled === true;
    input.disabled = !isSourceHost || _jamSourceLocalControlPending || _jamSourceLocalControlLegacy;
  });
  document.querySelectorAll("[data-jam-source-local-error]").forEach(function(el) {
    var error = isSourceHost && state.last_error ? state.last_error : "";
    el.textContent = error;
    el.classList.toggle("hidden", !error);
  });
}

function currentJamRelayGain() {
  var roomMuted = typeof roomAudioMuted !== "undefined" && roomAudioMuted;
  var localControl = _jamSourceLocalControl || {
    is_source_host: _jamIsSourceHost === true,
    takeover_active: false,
    monitor_enabled: false
  };
  if (window.EchoJamSessionState &&
      typeof window.EchoJamSessionState.effectiveJamRelayGain === "function") {
    return window.EchoJamSessionState.effectiveJamRelayGain(_jamVolume, roomMuted, localControl);
  }
  if (localControl.is_source_host === true &&
      !(localControl.takeover_active === true && localControl.monitor_enabled === true)) {
    return 0;
  }
  return roomMuted ? 0 : (_jamVolume / 100);
}

function applyJamRelayGain() {
  if (_jamGainNode) _jamGainNode.gain.value = currentJamRelayGain();
}

function installJamRelayAudioRoutingHook() {
  if (typeof setRoomAudioMutedState !== "function" || setRoomAudioMutedState._jamSourceRelayAware) return;
  var originalSetRoomAudioMutedState = setRoomAudioMutedState;
  setRoomAudioMutedState = function(next) {
    var result = originalSetRoomAudioMutedState(next);
    // audio-routing.js owns the room-wide mute toggle. Re-apply the local
    // source monitor policy synchronously after it updates the shared gain.
    applyJamRelayGain();
    return result;
  };
  setRoomAudioMutedState._jamSourceRelayAware = true;
}

async function refreshJamSourceLocalControl(allowDuringMutation) {
  if (_jamSourceLocalControlPending && allowDuringMutation !== true) return _jamSourceLocalControl;
  if (_jamSourceLocalControlPromise) return _jamSourceLocalControlPromise;
  if (typeof tauriInvoke !== "function" || typeof hasTauriIPC !== "function" || !hasTauriIPC()) {
    _jamSourceLocalControl = normalizeJamSourceLocalControl(null);
    _jamIsSourceHost = false;
    _jamSourceLocalControlLegacy = false;
    renderJamSourceLocalControl();
    applyJamRelayGain();
    return _jamSourceLocalControl;
  }

  _jamSourceLocalControlPromise = tauriInvoke("get_jam_source_local_control")
    .then(function(value) {
      _jamSourceLocalControl = normalizeJamSourceLocalControl(value);
      _jamIsSourceHost = _jamSourceLocalControl.is_source_host;
      _jamSourceLocalControlLegacy = false;
      return _jamSourceLocalControl;
    })
    .catch(async function(error) {
      // A mixed desktop/viewer rollout must retain the old doubled-audio
      // protection even though the new switches cannot be used yet.
      var isSourceHost = false;
      try {
        isSourceHost = await tauriInvoke("is_jam_source_host") === true;
      } catch (_) {}
      _jamSourceLocalControl = normalizeJamSourceLocalControl({
        is_source_host: isSourceHost,
        last_error: isSourceHost ? "Update Echo to enable the source-PC Spotify controls." : ""
      });
      _jamIsSourceHost = isSourceHost;
      _jamSourceLocalControlLegacy = true;
      debugLog("[jam] could not read native source-PC controls: " + jamSourceLocalErrorMessage(error));
      return _jamSourceLocalControl;
    })
    .finally(function() {
      _jamSourceLocalControlPromise = null;
      renderJamSourceLocalControl();
      applyJamRelayGain();
    });
  return _jamSourceLocalControlPromise;
}

async function setJamSourceLocalControl(setting, enabled) {
  if (!_jamSourceLocalControl || !_jamSourceLocalControl.is_source_host || _jamSourceLocalControlPending) return;
  if (_jamSourceLocalControlPromise) await _jamSourceLocalControlPromise;
  var command = setting === "takeover"
    ? "set_jam_source_takeover_enabled"
    : "set_jam_source_monitor_enabled";
  var field = setting === "takeover" ? "takeover_enabled" : "monitor_enabled";
  var previous = _jamSourceLocalControl[field] === true;
  _jamSourceLocalControlPending = true;
  _jamSourceLocalControl[field] = enabled === true;
  _jamSourceLocalControl.last_error = "";
  renderJamSourceLocalControl();
  applyJamRelayGain();

  try {
    await tauriInvoke(command, { enabled: enabled === true });
    await refreshJamSourceLocalControl(true);
  } catch (error) {
    _jamSourceLocalControl[field] = previous;
    _jamSourceLocalControl.last_error = jamSourceLocalErrorMessage(error);
    debugLog("[jam] source-PC setting failed: " + _jamSourceLocalControl.last_error);
  } finally {
    _jamSourceLocalControlPending = false;
    renderJamSourceLocalControl();
    applyJamRelayGain();
  }
}

function bindJamSourceLocalControls() {
  if (_jamSourceLocalControlsBound) return;
  _jamSourceLocalControlsBound = true;
  document.querySelectorAll("[data-jam-source-takeover-toggle]").forEach(function(input) {
    input.addEventListener("change", function() {
      setJamSourceLocalControl("takeover", input.checked);
    });
  });
  document.querySelectorAll("[data-jam-source-monitor-toggle]").forEach(function(input) {
    input.addEventListener("change", function() {
      setJamSourceLocalControl("monitor", input.checked);
    });
  });
}

function initJamSourceLocalControlUi() {
  installJamRelayAudioRoutingHook();
  bindJamSourceLocalControls();
  var initialControl = refreshJamSourceLocalControl();
  // This PC can be taken over while the viewer is sitting at the login portal.
  // Keep the local-only status truthful without depending on Echo room polling.
  Promise.resolve(initialControl).then(function(state) {
    if (state && state.is_source_host && !_jamSourceLocalPollTimer) {
      _jamSourceLocalPollTimer = setInterval(refreshJamSourceLocalControl, 2000);
    }
  });
}

async function detectJamSourceHost() {
  var state = await refreshJamSourceLocalControl();
  return !!state && state.is_source_host === true;
}

function muteSourceHostRelayIfNeeded(listenerJoined) {
  var shouldMute = window.EchoJamSessionState &&
    typeof window.EchoJamSessionState.shouldMuteLocalRelay === "function"
    ? window.EchoJamSessionState.shouldMuteLocalRelay(
        _jamIsSourceHost,
        listenerJoined,
        !!_jamSourceLocalControl && _jamSourceLocalControl.takeover_active,
        !!_jamSourceLocalControl && _jamSourceLocalControl.monitor_enabled
      )
    : _jamIsSourceHost === true && listenerJoined !== false;
  applyJamRelayGain();
  if (!shouldMute) {
    _jamRelayMuteNoticeShown = false;
    return;
  }
  if (_jamRelayMuteNoticeShown) return;
  _jamRelayMuteNoticeShown = true;
  showJamToast(_jamSourceLocalControl && _jamSourceLocalControl.takeover_active
    ? "Local Jam audio is off — enable Hear Jam on this PC to listen here"
    : "Local Jam relay muted — Spotify is already playing on this PC");
}

function evaluateJamServerContract(state) {
  if (window.EchoJamSessionState && typeof window.EchoJamSessionState.evaluateJamContract === "function") {
    return window.EchoJamSessionState.evaluateJamContract(state);
  }

  // Fail closed when the state helper is missing or stale. A mixed viewer bundle
  // must never attempt a Jam against an API contract it cannot validate.
  return {
    expectedProtocol: JAM_PROTOCOL_VERSION,
    actualProtocol: null,
    compatible: false,
    compatibilityMessage: "Jam viewer assets are incomplete — reopen Echo after the server update",
    active: false,
    spotifyConnected: false,
    spotifyIsPlaying: false,
    playbackStopSupported: false,
    sourceEnabled: false,
    sourceAvailabilityKnown: false,
    sourceStatus: "unknown",
    sourceReady: false,
    sourceControlReady: false,
    sourceTone: "error",
    sourceMessage: "Host source status is unavailable",
    sourceError: "",
    sourceLastFrameMs: null,
    sourcePeak: null,
    canStart: false,
    canJoin: false,
    canControl: false,
    canStopPlayback: false,
    canConfigure: false,
  };
}

function unavailableJamContract(message) {
  var contract = evaluateJamServerContract(null);
  if (window.EchoJamSessionState && typeof window.EchoJamSessionState.evaluateJamContract === "function") {
    contract.compatibilityMessage = message;
  }
  return contract;
}

function ensureJamSourceStatusElement() {
  var el = document.getElementById("jam-source-status");
  if (el) return el;
  var row = document.querySelector(".jam-spotify-row");
  if (!row || !row.parentNode) return null;
  el = document.createElement("div");
  el.id = "jam-source-status";
  el.className = "jam-source-status waiting";
  el.setAttribute("role", "status");
  el.style.cssText = "margin:6px 0 10px;font-size:12px;color:var(--muted,#94a3b8);";
  row.parentNode.insertBefore(el, row.nextSibling);
  return el;
}

function renderJamContractStatus() {
  var contract = _jamContract || evaluateJamServerContract(null);
  var el = ensureJamSourceStatusElement();
  if (!el) return;

  var message = contract.compatible ? contract.sourceMessage : contract.compatibilityMessage;
  var tone = contract.compatible ? contract.sourceTone : "error";
  el.textContent = message;
  el.className = "jam-source-status " + tone;
  el.style.color = tone === "error"
    ? "var(--danger,#f87171)"
    : tone === "ready"
      ? "var(--success,#4ade80)"
      : tone === "warning"
        ? "var(--warning,#fbbf24)"
        : "var(--muted,#94a3b8)";

  var details = [];
  if (contract.sourceLastFrameMs !== null) details.push("last frame ms=" + contract.sourceLastFrameMs);
  if (contract.sourcePeak !== null) details.push("peak=" + contract.sourcePeak.toFixed(6));
  el.title = details.join(" · ");
}

function jamActionAllowed(action) {
  var contract = _jamContract || evaluateJamServerContract(null);
  if (!contract.compatible) {
    showJamError(contract.compatibilityMessage);
    return false;
  }
  if (action === "configure") return contract.canConfigure !== false;
  if (action === "start") {
    if (!contract.canStart) {
      showJamError(contract.spotifyConnected ? contract.sourceMessage : "Connect Spotify before starting a Jam");
      return false;
    }
    return true;
  }
  if (action === "join") {
    if (!contract.canJoin) {
      showJamError(contract.active ? contract.sourceMessage : "No active Jam is available to join");
      return false;
    }
    return true;
  }
  if (action === "stopPlayback") {
    if (!contract.canStopPlayback) {
      var message = !contract.playbackStopSupported
        ? "Stop Music is unavailable — reopen Echo after the server update"
        : !contract.active
          ? "No active Jam is running"
          : !contract.spotifyConnected
            ? "Spotify is not connected"
            : "Stop Music is unavailable";
      showJamError(message);
      return false;
    }
    return true;
  }
  if (action === "end") {
    if (!contract.active) {
      showJamError("No active Jam is running");
      return false;
    }
    return true;
  }
  return contract.canControl;
}

function applyJamContractToControls() {
  var contract = _jamContract || evaluateJamServerContract(null);
  var connectBtn = document.getElementById("jam-connect-spotify");
  var startBtn = document.getElementById("jam-start-btn");
  var stopBtn = document.getElementById("jam-stop-music-btn");
  var endBtn = document.getElementById("jam-end-btn");
  var skipBtn = document.getElementById("jam-skip-btn");
  var searchInput = document.getElementById("jam-search-input");
  var importBtn = document.getElementById("jam-import-spotify");
  var playlistAddBtn = document.getElementById("jam-playlist-add-all");

  if (connectBtn) connectBtn.disabled = !contract.compatible;
  if (startBtn) {
    startBtn.disabled = !contract.canStart;
    startBtn.title = contract.canStart
      ? "Start Jam"
      : !contract.compatible
        ? contract.compatibilityMessage
        : !contract.spotifyConnected
          ? "Connect Spotify first"
          : contract.sourceMessage;
  }
  if (stopBtn) {
    stopBtn.disabled = !contract.canStopPlayback;
    stopBtn.title = contract.canStopPlayback
      ? "Stops Spotify playback for everyone; the Jam stays open"
      : !contract.playbackStopSupported
        ? "Stop Music is unavailable until the server update is complete"
        : !contract.active
          ? "No active Jam is running"
          : !contract.spotifyConnected
            ? "Spotify is not connected"
            : "Stop Music is unavailable";
  }
  if (endBtn) {
    endBtn.disabled = !contract.compatible || !contract.active;
    endBtn.title = contract.compatible
      ? "Ends the Jam for everyone and clears its queue"
      : contract.compatibilityMessage;
  }
  if (skipBtn) skipBtn.disabled = !contract.canControl || !contract.active;
  if (searchInput) searchInput.disabled = !contract.compatible || !contract.spotifyConnected;
  if (importBtn) importBtn.disabled = _jamImportPending || !contract.compatible || !contract.spotifyConnected;
  if (playlistAddBtn) playlistAddBtn.disabled = _jamPlaylistQueuePending || !contract.canControl;
  document.querySelectorAll(".jam-result-add").forEach(function(button) {
    button.disabled = !contract.canControl;
  });

  syncJamButtonsFromState();
}

function stopJamForCompatibilityFailure() {
  if (!_jamContract || _jamContract.compatible) return;
  resetLocalJamListening();
}

function resetLocalJamListening() {
  clearJamReconnectTimer();
  if (_jamSessionState && _jamSessionState.leaveSucceeded) {
    _jamSessionState.leaveSucceeded();
  }
  _jamListeningGeneration = null;
  stopJamAudioStream();
}

function reconcileJamListeningWithServer(nextState) {
  if (!_jamSessionState || !_jamSessionState.snapshot) return;
  var listener = _jamSessionState.snapshot();
  var hasListeningState = listener.desiredListening || listener.serverJoined ||
    listener.streamConnected || listener.streamConnecting || listener.pendingLeave;
  if (!hasListeningState) return;

  var shouldReset = window.EchoJamSessionState &&
    typeof window.EchoJamSessionState.shouldResetListeningForServerState === "function"
    ? window.EchoJamSessionState.shouldResetListeningForServerState(nextState, _jamListeningGeneration)
    : !nextState || nextState.active !== true ||
      (_jamListeningGeneration !== null && Number(nextState.generation) !== _jamListeningGeneration);
  if (shouldReset) {
    resetLocalJamListening();
  }
}

function syncJamButtonsFromState() {
  if (!_jamSessionState || !_jamSessionState.ui) return;
  var ui = _jamSessionState.ui();
  var contract = _jamContract || evaluateJamServerContract(null);
  var joinBtn = document.getElementById("jam-join-btn");
  var leaveBtn = document.getElementById("jam-leave-btn");
  if (joinBtn) {
    joinBtn.style.display = contract.active && ui.joinVisible ? "" : "none";
    joinBtn.disabled = !contract.canJoin;
    joinBtn.title = contract.compatible ? contract.sourceMessage : contract.compatibilityMessage;
  }
  if (leaveBtn) {
    leaveBtn.style.display = contract.active && ui.leaveVisible ? "" : "none";
    leaveBtn.disabled = !contract.compatible;
  }
}

function clearJamReconnectTimer() {
  if (_jamReconnectTimer) {
    clearTimeout(_jamReconnectTimer);
    _jamReconnectTimer = null;
  }
}

function scheduleJamReconnect(delayMs) {
  clearJamReconnectTimer();
  _jamReconnectTimer = setTimeout(async function() {
    _jamReconnectTimer = null;
    if (!_jamSessionState || !_jamSessionState.reconnectAttemptStarted || _jamRejoinPromise) return;
    var step = _jamSessionState.reconnectAttemptStarted();
    if (!step.shouldConnect) {
      syncJamButtonsFromState();
      return;
    }
    syncJamButtonsFromState();

    var rejoinPromise = restoreJamMembershipForReconnect();
    _jamRejoinPromise = rejoinPromise;
    try {
      if (await rejoinPromise) {
        if (_jamContract && _jamContract.canJoin) {
          startJamAudioStream();
        } else if (_jamSessionState && _jamSessionState.streamClosedTransient) {
          var notReady = _jamSessionState.streamClosedTransient("jam-contract-not-ready");
          syncJamButtonsFromState();
          if (notReady.shouldReconnect && (!_jamContract || _jamContract.compatible)) {
            scheduleJamReconnect(notReady.delayMs);
          }
        }
      } else if (_jamSessionState && _jamSessionState.streamClosedTransient) {
        var superseded = _jamSessionState.streamClosedTransient("membership-refresh-superseded");
        syncJamButtonsFromState();
        if (superseded.shouldReconnect && (!_jamContract || _jamContract.compatible)) {
          scheduleJamReconnect(superseded.delayMs);
        }
      }
    } catch (e) {
      debugLog("[jam] listener membership refresh failed: " + (e && e.message ? e.message : "request failed"));
      if (_jamSessionState && _jamSessionState.streamClosedTransient) {
        var failure = _jamSessionState.streamClosedTransient("membership-refresh-failed");
        syncJamButtonsFromState();
        if (failure.shouldReconnect && (!_jamContract || _jamContract.compatible)) {
          scheduleJamReconnect(failure.delayMs);
        }
      }
    } finally {
      if (_jamRejoinPromise === rejoinPromise) _jamRejoinPromise = null;
    }
  }, Math.max(0, delayMs || 0));
}

async function restoreJamMembershipForReconnect() {
  var generation = _jamListeningGeneration;
  var participantToken = currentAccessToken;
  var identity = room && room.localParticipant ? room.localParticipant.identity : "";
  var before = _jamSessionState && _jamSessionState.snapshot ? _jamSessionState.snapshot() : null;
  if (!before || !before.desiredListening || !before.serverJoined || before.pendingLeave) return false;

  var resp = await fetch(apiUrl("/api/jam/join"), {
    method: "POST",
    headers: jamActorHeaders(participantToken),
    body: JSON.stringify({ identity: identity, generation: generation })
  });
  if (!resp.ok) throw new Error("join-status-" + resp.status);

  var after = _jamSessionState && _jamSessionState.snapshot ? _jamSessionState.snapshot() : null;
  var shouldOpen = window.EchoJamSessionState &&
    typeof window.EchoJamSessionState.shouldOpenAudioAfterRejoin === "function"
    ? window.EchoJamSessionState.shouldOpenAudioAfterRejoin(
        after,
        generation,
        _jamListeningGeneration,
        participantToken === currentAccessToken
      )
    : !!after && after.desiredListening && after.serverJoined && !after.pendingLeave &&
      Number(generation) === Number(_jamListeningGeneration) && participantToken === currentAccessToken;
  if (shouldOpen && _jamSessionState.joinAccepted) {
    _jamSessionState.joinAccepted();
    syncJamButtonsFromState();
  }
  return shouldOpen;
}

function startPendingJamAudioIfNeeded() {
  if (_jamAudioWs || _jamReconnectTimer || _jamRejoinPromise || !_jamContract || !_jamContract.canJoin) return;
  if (!_jamSessionState || !_jamSessionState.snapshot) return;
  var listener = _jamSessionState.snapshot();
  // Only the first accepted join may open directly. Every transport reconnect
  // must refresh server membership immediately before opening its socket.
  if (listener.reconnectAttempt > 0) return;
  if (!listener.desiredListening || !listener.serverJoined || !listener.streamConnecting || listener.pendingLeave) return;
  startJamAudioStream();
}

// === HTML Escape ===
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ──────────────────────────────────────────
// Panel Open / Close
// ──────────────────────────────────────────

function openJamPanel(opener) {
  var panel = document.getElementById("jam-panel");
  if (panel) {
    var handledByClubhouse = window.EchoClubhouseUtility &&
      window.EchoClubhouseUtility.open("jam", opener || document.activeElement);
    if (!handledByClubhouse) panel.classList.remove("hidden");
    initJam();
  }
}

function closeJamPanel(options) {
  var panel = document.getElementById("jam-panel");
  if (!panel) return;
  var handledByClubhouse = window.EchoClubhouseUtility &&
    window.EchoClubhouseUtility.close("jam", options);
  if (!handledByClubhouse) panel.classList.add("hidden");
}

// ──────────────────────────────────────────
// Spotify OAuth PKCE
// ──────────────────────────────────────────

function generateRandomString(length) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  var arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, function(b) { return chars[b % chars.length]; }).join("");
}

async function generateCodeChallenge(verifier) {
  var encoder = new TextEncoder();
  var data = encoder.encode(verifier);
  var digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function connectSpotify() {
  try {
    if (!jamActionAllowed("configure")) return;
    showJamStatus("Connecting to Spotify...");

    // Generate PKCE state + verifier
    _spotifyAuthState = generateRandomString(32);
    _spotifyVerifier = generateRandomString(128);
    var challenge = await generateCodeChallenge(_spotifyVerifier);

    // Tell server to prepare for this auth flow
    var initResp = await fetch(apiUrl("/api/jam/spotify-init"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ state: _spotifyAuthState, verifier: _spotifyVerifier, challenge: challenge })
    });

    if (!initResp.ok) {
      var errText = await initResp.text();
      showJamError("Spotify init failed: " + errText);
      return;
    }

    var initData = await initResp.json();
    var authUrl = initData.auth_url;

    if (!authUrl) {
      showJamError("No auth URL returned from server");
      return;
    }

    // Open Spotify auth in external browser
    if (typeof tauriInvoke === "function" && hasTauriIPC()) {
      try {
        await tauriInvoke("open_external_url", { url: authUrl });
      } catch (e) {
        window.open(authUrl, "_blank");
      }
    } else {
      window.open(authUrl, "_blank");
    }

    showJamStatus("Waiting for Spotify login...");

    // Poll for the auth code callback
    if (_spotifyPollTimer) clearInterval(_spotifyPollTimer);
    var pollCount = 0;
    var maxPolls = 90; // 3 minutes at 2s intervals
    _spotifyPollTimer = setInterval(async function() {
      pollCount++;
      if (pollCount > maxPolls) {
        clearInterval(_spotifyPollTimer);
        _spotifyPollTimer = null;
        showJamError("Spotify login timed out");
        return;
      }
      try {
        var codeResp = await fetch(apiUrl("/api/jam/spotify-code?state=" + encodeURIComponent(_spotifyAuthState)), {
          headers: { "Authorization": "Bearer " + adminToken }
        });
        if (!codeResp.ok) return; // not ready yet

        var codeData = await codeResp.json();
        if (!codeData.code) return;

        // Got the code! Exchange for token
        clearInterval(_spotifyPollTimer);
        _spotifyPollTimer = null;

        var tokenResp = await fetch(apiUrl("/api/jam/spotify-token"), {
          method: "POST",
          headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
          body: JSON.stringify({ code: codeData.code, verifier: _spotifyVerifier })
        });

        if (tokenResp.ok) {
          showJamStatus("Spotify connected!");
          setTimeout(function() { showJamStatus(""); }, 3000);
          fetchJamState();
        } else {
          var tokenErr = await tokenResp.text();
          showJamError("Token exchange failed: " + tokenErr);
        }
      } catch (e) {
        debugLog("[jam] spotify poll error: " + e);
      }
    }, 2000);

  } catch (e) {
    showJamError("Spotify connect error: " + e.message);
    debugLog("[jam] connectSpotify error: " + e);
  }
}

// ──────────────────────────────────────────
// Jam Controls
// ──────────────────────────────────────────

async function startJam() {
  try {
    if (!jamActionAllowed("start")) return;
    await detectJamSourceHost();
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    debugLog("[jam] startJam requested");
    var resp = await fetch(apiUrl("/api/jam/start"), {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({ identity: identity })
    });

    if (!resp.ok) {
      var errText = await resp.text();
      showJamError("Start failed: " + errText);
      return;
    }

    var startData = await resp.json().catch(function() { return {}; });
    muteSourceHostRelayIfNeeded(startData.listener_joined);

    // The server auto-joins the starter unless it explicitly says otherwise.
    // Mirror that transition before opening audio so host reconnect/backoff works.
    if (startData.listener_joined !== false && _jamSessionState) {
      var startGeneration = Number(startData.generation);
      _jamListeningGeneration = Number.isFinite(startGeneration) ? startGeneration : null;
      if (_jamSessionState.requestJoin) _jamSessionState.requestJoin();
      if (_jamSessionState.joinAccepted) _jamSessionState.joinAccepted();
      syncJamButtonsFromState();
    }

    // Broadcast jam-started via LiveKit data channel
    try {
      var hostName = room && room.localParticipant ? (room.localParticipant.name || room.localParticipant.identity) : "Host";
      var msg = JSON.stringify({ type: "jam-started", host: hostName });
      room.localParticipant.publishData(new TextEncoder().encode(msg), { reliable: true });
    } catch (e) {
      debugLog("[jam] data broadcast error: " + e);
    }

    // Host is auto-joined as listener — start audio stream
    // The start endpoint does not return the full v3 state contract. Refresh it
    // before opening audio so the connection never uses stale inactive state.
    // If this refresh fails, a later successful poll resumes the pending stream.
    await fetchJamState();
    startPendingJamAudioIfNeeded();
  } catch (e) {
    showJamError("Start jam error: " + e.message);
    debugLog("[jam] startJam error: " + e);
  }
}

async function stopJamPlayback() {
  var stopBtn = document.getElementById("jam-stop-music-btn");
  try {
    if (!jamActionAllowed("stopPlayback")) return;
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.textContent = "Stopping...";
    }
    var stopResp = await fetch(apiUrl("/api/jam/playback/stop"), {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({ generation: _jamState && _jamState.generation })
    });
    if (!stopResp.ok) {
      var stopError = (await stopResp.text()).trim();
      showJamError("Stop Music failed" + (stopError
        ? ": " + stopError
        : " (status " + stopResp.status + ")"));
      return;
    }

    if (_jamState) {
      _jamState.spotify_is_playing = false;
      if (_jamState.now_playing) _jamState.now_playing.is_playing = false;
      _jamContract = evaluateJamServerContract(_jamState);
      renderJamPanel();
      updateNowPlayingBanner(_jamState);
    }
    showJamToast("Music stopped. The Jam is still open.");

    // Prompt other viewers to refresh immediately without resetting their
    // listener intent or closing the generation-scoped audio socket.
    try {
      var msg = JSON.stringify({ type: "jam-playback-stopped" });
      room.localParticipant.publishData(new TextEncoder().encode(msg), { reliable: true });
    } catch (e) {
      debugLog("[jam] data broadcast error: " + e);
    }

    await fetchJamState();
  } catch (e) {
    showJamError("Stop Music failed: " + e.message);
    debugLog("[jam] stopJamPlayback error: " + e);
  } finally {
    if (stopBtn) stopBtn.textContent = "Stop Music";
    applyJamContractToControls();
  }
}

async function endJam() {
  try {
    if (!jamActionAllowed("end")) return;
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    var response = await fetch(apiUrl("/api/jam/stop"), {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({
        identity: identity,
        generation: _jamState && _jamState.generation
      })
    });
    if (!response.ok) {
      if (response.status === 403) {
        showJamError("Only the participant who started this Jam can end it");
      } else {
        var detail = (await response.text()).trim();
        showJamError("End Jam failed" + (detail
          ? ": " + detail
          : " (status " + response.status + ")"));
      }
      return;
    }

    if (_jamSessionState && _jamSessionState.leaveSucceeded) {
      _jamSessionState.leaveSucceeded();
      syncJamButtonsFromState();
    }
    _jamListeningGeneration = null;
    stopJamAudioStream();
    try {
      var message = JSON.stringify({ type: "jam-stopped" });
      room.localParticipant.publishData(new TextEncoder().encode(message), { reliable: true });
    } catch (error) {
      debugLog("[jam] data broadcast error: " + error);
    }
    showJamToast("Jam ended.");
    await fetchJamState();
  } catch (error) {
    showJamError("End Jam failed: " + error.message);
    debugLog("[jam] endJam error: " + error);
  }
}

async function skipTrack() {
  try {
    if (!jamActionAllowed("control")) return;
    var resp = await fetch(apiUrl("/api/jam/skip"), {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({ generation: _jamState && _jamState.generation })
    });
    if (!resp.ok) {
      showJamError("Skip failed (status " + resp.status + ")");
      return;
    }
    fetchJamState();
  } catch (e) {
    showJamError("Skip failed: " + e.message);
    debugLog("[jam] skipTrack error: " + e);
  }
}

// ──────────────────────────────────────────
// Search
// ──────────────────────────────────────────

var JAM_CATALOG_PAGE_SIZE = 10;
var JAM_LIBRARY_PAGE_SIZE = 20;
var JAM_PLAYLIST_PAGE_SIZE = 20;
var JAM_HISTORY_PAGE_SIZE = 20;
var _searchTimer = null;
var _jamActiveView = "search";
var _jamSearchKind = "track";
var _jamSearchQuery = "";
var _jamSearchOffset = 0;
var _jamSearchTotal = 0;
var _jamSearchNextOffset = null;
var _jamSearchItems = [];
var _jamSearchController = null;
var _jamSearchRequestSeq = 0;
var _jamLibraryOffset = 0;
var _jamLibraryTotal = 0;
var _jamLibraryNextOffset = null;
var _jamLibraryItems = [];
var _jamLibraryLoaded = false;
var _jamLibraryController = null;
var _jamLibraryRequestSeq = 0;
var _jamHistoryOffset = 0;
var _jamHistoryTotal = 0;
var _jamHistoryNextOffset = null;
var _jamHistoryLoaded = false;
var _jamHistoryController = null;
var _jamHistoryRequestSeq = 0;
var _jamPlaylist = null;
var _jamPlaylistItems = [];
var _jamPlaylistNextOffset = null;
var _jamPlaylistTotal = 0;
var _jamPlaylistController = null;
var _jamPlaylistRequestSeq = 0;
var _jamPlaylistLoading = false;
var _jamPlaylistQueuePending = false;
var _jamPlaylistReturnView = "search";
var _jamPlaylistOpener = null;
var _jamFavoritePending = Object.create(null);
var _jamImportPending = false;

function jamSafeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function jamSafeInteger(value, fallback) {
  var parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : (fallback || 0);
}

function jamSafeOptionalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  var parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function jamSafeArtworkUrl(value) {
  var candidate = jamSafeString(value);
  if (!candidate) return "";
  try {
    var parsed = new URL(candidate, window.location.href);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch (_) {
    return "";
  }
}

function jamNormalizeContributor(value) {
  if (typeof value === "string") {
    var text = value.trim();
    return text ? { actor_id: text, display_name: text } : null;
  }
  if (!value || typeof value !== "object") return null;
  var actorId = jamSafeString(value.actor_id || value.id || value.identity || value.display_name || value.name);
  var displayName = jamSafeString(value.display_name || value.name || value.identity || value.actor_id || value.id);
  if (!actorId && !displayName) return null;
  return {
    actor_id: actorId || displayName,
    display_name: displayName || actorId,
    added_at_ms: jamSafeInteger(value.added_at_ms, 0),
    source: jamSafeString(value.source),
    count: jamSafeInteger(value.count, 0)
  };
}

function jamNormalizeContributors(value) {
  var source = Array.isArray(value) ? value : [];
  var seen = Object.create(null);
  var result = [];
  source.forEach(function(entry) {
    var contributor = jamNormalizeContributor(entry);
    if (!contributor) return;
    var key = contributor.actor_id.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    result.push(contributor);
  });
  return result;
}

function jamSpotifyIdentity(raw, expectedKind) {
  var input = raw && typeof raw === "object" ? raw : {};
  var kind = jamSafeString(input.kind || expectedKind).toLowerCase();
  if (kind !== "track" && kind !== "playlist") return null;
  if (expectedKind && kind !== expectedKind) return null;

  var id = jamSafeString(input.spotify_id || input.id || input.spotify_track_id || input.spotify_playlist_id);
  var candidates = [input.spotify_uri, input.uri];
  for (var i = 0; !id && i < candidates.length; i++) {
    var uri = jamSafeString(candidates[i]);
    var uriMatch = /^spotify:(track|playlist):([A-Za-z0-9]{22})$/.exec(uri);
    if (uriMatch && uriMatch[1] === kind) id = uriMatch[2];
  }
  if (!id) {
    var url = jamSafeString(input.spotify_url || input.url || input.external_url);
    try {
      var parsed = new URL(url);
      var parts = parsed.pathname.split("/").filter(Boolean);
      if (parsed.protocol === "https:" && parsed.hostname === "open.spotify.com" &&
          parts.length === 2 && parts[0] === kind) {
        id = parts[1];
      }
    } catch (_) {
      id = "";
    }
  }
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
  return {
    kind: kind,
    spotify_id: id,
    uri: "spotify:" + kind + ":" + id,
    url: "https://open.spotify.com/" + kind + "/" + id
  };
}

function normalizeSpotifyCatalogItem(raw, expectedKind) {
  if (!raw || typeof raw !== "object") return null;
  var identity = jamSpotifyIdentity(raw, expectedKind);
  if (!identity) return null;
  var attributions = jamNormalizeContributors(raw.attributions || raw.favorited_by || raw.contributors);
  var contributorCount = jamSafeInteger(
    raw.favorite_contributor_count !== undefined ? raw.favorite_contributor_count : raw.contributor_count,
    attributions.length
  );
  if (contributorCount < attributions.length) contributorCount = attributions.length;
  var artwork = raw.artwork_url || raw.album_art_url;
  if (!artwork && Array.isArray(raw.images) && raw.images[0]) artwork = raw.images[0].url;
  var owner = raw.owner;
  if (owner && typeof owner === "object") owner = owner.display_name || owner.name || owner.id;
  var item = {
    kind: identity.kind,
    spotify_id: identity.spotify_id,
    uri: identity.uri,
    url: identity.url,
    spotify_uri: identity.uri,
    name: jamSafeString(raw.name) || (identity.kind === "playlist" ? "Untitled playlist" : "Unknown track"),
    artist: jamSafeString(raw.artist || raw.artist_name),
    owner: jamSafeString(owner),
    description: jamSafeString(raw.description),
    artwork_url: jamSafeArtworkUrl(artwork),
    album_art_url: jamSafeArtworkUrl(artwork),
    duration_ms: jamSafeInteger(raw.duration_ms, 0),
    item_count: jamSafeOptionalInteger(raw.item_count !== undefined ? raw.item_count : (raw.track_count !== undefined ? raw.track_count : raw.total_tracks)),
    snapshot_id: jamSafeString(raw.snapshot_id),
    attributions: attributions,
    contributor_count: contributorCount,
    favorite_contributor_count: contributorCount,
    favorited_by_me: raw.favorited_by_me === true
  };
  return item;
}

function jamNormalizeCatalogItems(items, expectedKind) {
  var result = [];
  (Array.isArray(items) ? items : []).forEach(function(raw) {
    var item = normalizeSpotifyCatalogItem(raw, expectedKind);
    if (item) result.push(item);
  });
  return result;
}

function jamItemKey(item) {
  return item.kind + ":" + item.spotify_id;
}

function jamDuration(durationMs) {
  var seconds = Math.floor(jamSafeInteger(durationMs, 0) / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function jamSetViewStatus(id, message, tone) {
  var element = document.getElementById(id);
  if (!element) return;
  element.textContent = message || "";
  element.className = "jam-view-status" + (tone ? " " + tone : "");
}

async function jamApiErrorMessage(response, action) {
  var payload = {};
  try { payload = await response.clone().json(); } catch (_) { payload = {}; }
  var serverMessage = jamSafeString(payload.message || (payload.error && payload.error.message)).slice(0, 240);
  if (response.status === 401) return "Your Echo session expired. Sign in again.";
  if (response.status === 403) {
    if (action === "import Spotify favorites") return "Spotify access needs refreshing. Use Refresh Spotify Access, then import again.";
    if (payload.error === "playlist_items_forbidden" && serverMessage) return serverMessage;
    return serverMessage || "You don't have permission to " + action + ".";
  }
  if (response.status === 429) {
    var retryAfter = jamSafeString(
      (response.headers && response.headers.get("Retry-After")) || payload.retry_after || payload.retry_after_seconds
    );
    return (serverMessage ? serverMessage + " " : "Spotify is rate limiting requests. ") + "Try again" + (retryAfter ? " in " + retryAfter + " seconds" : " shortly") + ".";
  }
  if (serverMessage) return serverMessage;
  return "Could not " + action + " (status " + response.status + ").";
}

function jamSetBusy(containerId, busy) {
  var element = document.getElementById(containerId);
  if (element) element.setAttribute("aria-busy", busy ? "true" : "false");
}

function jamSetPager(prefix, offset, limit, total, nextOffset, noun, busy) {
  var previous = document.getElementById(prefix + "-prev");
  var next = document.getElementById(prefix + "-next");
  var summary = document.getElementById(prefix + "-page");
  var page = total ? Math.floor(offset / limit) + 1 : 0;
  var pages = total ? Math.max(1, Math.ceil(total / limit)) : 0;
  if (previous) previous.disabled = !!busy || offset <= 0;
  if (next) next.disabled = !!busy || nextOffset === null || nextOffset === undefined;
  if (summary) summary.textContent = total + " " + noun + (total === 1 ? "" : "s") + (total ? " \u00b7 " + page + " of " + pages : "");
}

function jamCreateArtwork(item, className) {
  if (!item.artwork_url) {
    var placeholder = document.createElement("span");
    placeholder.className = (className || "jam-result-art") + " jam-art-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    return placeholder;
  }
  var image = document.createElement("img");
  image.className = className || "jam-result-art";
  image.src = item.artwork_url;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}

function jamCreateSpotifyLink(item, label, className) {
  var link = document.createElement("a");
  link.className = className || "jam-spotify-link";
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  link.title = "Open in Spotify";
  link.onclick = function(event) { openSpotifyItem(item, event); };
  return link;
}

async function openSpotifyItem(raw, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  var item = normalizeSpotifyCatalogItem(raw, raw && raw.kind);
  if (!item) {
    showJamError("That Spotify link is invalid.");
    return false;
  }
  var nativeAvailable = typeof tauriInvoke === "function" &&
    typeof hasTauriIPC === "function" && hasTauriIPC();
  if (nativeAvailable) {
    try {
      await tauriInvoke("open_spotify_uri", { uri: item.uri, url: item.url });
      return true;
    } catch (_) {
      try {
        await tauriInvoke("open_external_url", { url: item.url });
        return true;
      } catch (fallbackError) {
        debugLog("[jam] native Spotify open failed: " + fallbackError);
      }
    }
  }
  var opened = window.open(item.url, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
  return !!opened;
}

function jamTabKeydown(event, selector, activate) {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(event.key) === -1) return;
  var tabs = Array.prototype.slice.call(document.querySelectorAll(selector));
  var index = tabs.indexOf(event.currentTarget);
  if (index < 0 || !tabs.length) return;
  event.preventDefault();
  if (event.key === "Home") index = 0;
  else if (event.key === "End") index = tabs.length - 1;
  else index = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[index].focus();
  activate(tabs[index]);
}

function setJamView(view, focusTab) {
  if (["library", "search", "queue", "history"].indexOf(view) === -1) return;
  _jamActiveView = view;
  var detail = document.getElementById("jam-playlist-detail");
  if (detail) detail.hidden = true;
  document.querySelectorAll(".jam-browser-tab").forEach(function(tab) {
    var active = tab.getAttribute("data-jam-view") === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    if (active && focusTab) tab.focus();
  });
  ["library", "search", "queue", "history"].forEach(function(name) {
    var panel = document.getElementById("jam-" + name + "-section");
    if (panel) panel.hidden = name !== view;
  });
  if (view === "library") loadJamLibrary(0);
  if (view === "history") loadJamHistory(0);
}

function setJamSearchKind(kind, focusTab) {
  if (kind !== "track" && kind !== "playlist") return;
  clearTimeout(_searchTimer);
  _searchTimer = null;
  _jamSearchKind = kind;
  document.querySelectorAll(".jam-search-kind-tab").forEach(function(tab) {
    var active = tab.getAttribute("data-jam-search-kind") === kind;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    if (active && focusTab) tab.focus();
  });
  var input = document.getElementById("jam-search-input");
  if (input) input.placeholder = kind === "track" ? "Search for a song..." : "Search for a playlist...";
  if (_jamSearchController) _jamSearchController.abort();
  _jamSearchRequestSeq += 1;
  _jamSearchOffset = 0;
  _jamSearchTotal = 0;
  _jamSearchNextOffset = null;
  renderSearchResults([]);
  if (input && input.value.trim().length >= 2) searchSpotify(input.value, 0);
}

function onSearchInput(e) {
  clearTimeout(_searchTimer);
  if (_jamSearchController) _jamSearchController.abort();
  _jamSearchRequestSeq += 1;
  var value = e.target.value;
  if (value.trim().length < 2) {
    _jamSearchQuery = value.trim();
    _jamSearchOffset = 0;
    _jamSearchTotal = 0;
    _jamSearchNextOffset = null;
    renderSearchResults([]);
    jamSetViewStatus("jam-search-status", value.trim() ? "Type at least 2 characters." : "");
    return;
  }
  jamSetViewStatus("jam-search-status", "Waiting for you to finish typing...");
  _searchTimer = setTimeout(function() { searchSpotify(value, 0); }, 300);
}

async function searchSpotify(query, offset) {
  var normalizedQuery = jamSafeString(query);
  if (normalizedQuery.length < 2) {
    renderSearchResults([]);
    return;
  }
  if (_jamSearchController) _jamSearchController.abort();
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  _jamSearchController = controller;
  var requestId = ++_jamSearchRequestSeq;
  var requestedOffset = jamSafeInteger(offset, 0);
  _jamSearchQuery = normalizedQuery;
  jamSetBusy("jam-results", true);
  jamSetViewStatus("jam-search-status", "Searching Spotify...");
  jamSetPager("jam-search", requestedOffset, JAM_CATALOG_PAGE_SIZE, _jamSearchTotal, null, "result", true);
  try {
    var options = {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({
        kind: _jamSearchKind,
        query: normalizedQuery,
        offset: requestedOffset,
        limit: JAM_CATALOG_PAGE_SIZE
      })
    };
    if (controller) options.signal = controller.signal;
    var resp = await fetch(apiUrl("/api/jam/catalog/search"), options);
    if (requestId !== _jamSearchRequestSeq) return;
    if (!resp.ok) {
      _jamSearchItems = [];
      _jamSearchOffset = requestedOffset;
      _jamSearchTotal = 0;
      _jamSearchNextOffset = null;
      renderSearchResults([]);
      jamSetViewStatus("jam-search-status", await jamApiErrorMessage(resp, "search Spotify"), "error");
      return;
    }
    var data = await resp.json();
    if (requestId !== _jamSearchRequestSeq) return;
    var rawItems = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : (data.tracks || data.playlists || []));
    _jamSearchItems = jamNormalizeCatalogItems(rawItems, _jamSearchKind);
    _jamSearchOffset = jamSafeInteger(data.offset, requestedOffset);
    _jamSearchTotal = jamSafeInteger(data.total, _jamSearchItems.length);
    var suppliedNext = data && data.next_offset;
    _jamSearchNextOffset = suppliedNext === null || suppliedNext === undefined
      ? (_jamSearchOffset + _jamSearchItems.length < _jamSearchTotal ? _jamSearchOffset + JAM_CATALOG_PAGE_SIZE : null)
      : jamSafeInteger(suppliedNext, 0);
    renderSearchResults(_jamSearchItems);
    jamSetViewStatus(
      "jam-search-status",
      _jamSearchItems.length ? "Spotify " + (_jamSearchKind === "track" ? "songs" : "playlists") + " found." : "No Spotify " + (_jamSearchKind === "track" ? "songs" : "playlists") + " matched that search."
    );
  } catch (error) {
    if (requestId !== _jamSearchRequestSeq || (error && error.name === "AbortError")) return;
    _jamSearchItems = [];
    _jamSearchOffset = requestedOffset;
    _jamSearchTotal = 0;
    _jamSearchNextOffset = null;
    renderSearchResults([]);
    jamSetViewStatus("jam-search-status", "Spotify search is unavailable right now.", "error");
    debugLog("[jam] catalog search error: " + error);
  } finally {
    if (requestId === _jamSearchRequestSeq) {
      jamSetBusy("jam-results", false);
      jamSetPager("jam-search", _jamSearchOffset, JAM_CATALOG_PAGE_SIZE, _jamSearchTotal, _jamSearchNextOffset, "result", false);
    }
  }
}

function jamFavoriteSummary(item) {
  var names = item.attributions.map(function(entry) { return entry.display_name; }).filter(Boolean);
  if (names.length) return "Saved to Echo by " + names.join(", ");
  var count = jamSafeInteger(item.favorite_contributor_count, 0);
  return count ? "Saved to Echo by " + count + (count === 1 ? " person" : " people") : "";
}

function jamCreateCatalogCard(item, context) {
  var card = document.createElement("div");
  card.className = "jam-result-item jam-catalog-item jam-catalog-" + item.kind;
  card.setAttribute("role", "listitem");
  card.setAttribute("data-jam-item-key", jamItemKey(item));
  card.appendChild(jamCreateArtwork(item, "jam-result-art"));

  var info = document.createElement("div");
  info.className = "jam-result-info";
  info.appendChild(jamCreateSpotifyLink(item, item.name, "jam-result-name jam-spotify-link"));
  var meta = document.createElement("div");
  meta.className = "jam-result-artist";
  if (item.kind === "track") {
    meta.textContent = (item.artist || "Unknown artist") + (item.duration_ms ? " \u00b7 " + jamDuration(item.duration_ms) : "");
  } else {
    var playlistMeta = [];
    if (item.owner) playlistMeta.push("By " + item.owner);
    if (item.item_count || item.item_count === 0) playlistMeta.push(item.item_count + (item.item_count === 1 ? " song" : " songs"));
    meta.textContent = playlistMeta.join(" \u00b7 ");
  }
  info.appendChild(meta);
  var favoriteSummary = jamFavoriteSummary(item);
  if (favoriteSummary) {
    var attribution = document.createElement("div");
    attribution.className = "jam-favorite-summary";
    attribution.setAttribute("data-jam-favorite-key", jamItemKey(item));
    attribution.textContent = "\u2605 " + favoriteSummary;
    info.appendChild(attribution);
  }
  if (item.kind === "playlist" && item.description && context === "detail-summary") {
    var description = document.createElement("div");
    description.className = "jam-playlist-description";
    description.textContent = item.description;
    info.appendChild(description);
  }
  card.appendChild(info);

  var actions = document.createElement("div");
  actions.className = "jam-card-actions";
  var favorite = document.createElement("button");
  favorite.type = "button";
  favorite.className = "jam-favorite-btn";
  favorite.setAttribute("data-jam-favorite-key", jamItemKey(item));
  favorite.setAttribute("aria-pressed", item.favorited_by_me ? "true" : "false");
  favorite.setAttribute("aria-label", (item.favorited_by_me ? "Remove from Echo Favorites: " : "Add to Echo Favorites: ") + item.name);
  favorite.textContent = item.favorited_by_me ? "\u2605" : "\u2606";
  favorite.title = item.favorited_by_me ? "Remove from Echo Favorites" : "Add to Echo Favorites";
  favorite.disabled = !!_jamFavoritePending[jamItemKey(item)];
  favorite.onclick = function() { toggleJamFavorite(item); };
  actions.appendChild(favorite);

  if (item.kind === "track" && context === "search") {
    var add = document.createElement("button");
    add.type = "button";
    add.className = "jam-result-add";
    add.textContent = "+";
    add.title = "Add to queue";
    add.setAttribute("aria-label", "Add " + item.name + " by " + (item.artist || "unknown artist") + " to queue");
    add.disabled = !_jamContract || !_jamContract.canControl;
    add.onclick = function() { addToQueue(item); };
    actions.appendChild(add);
  } else if (item.kind === "playlist" && context !== "detail-summary") {
    var inspect = document.createElement("button");
    inspect.type = "button";
    inspect.className = "jam-secondary-btn jam-inspect-btn";
    inspect.textContent = "Open";
    inspect.setAttribute("aria-label", "View " + item.name + " playlist songs");
    inspect.onclick = function(event) { openJamPlaylistDetail(item, event.currentTarget); };
    actions.appendChild(inspect);
  }
  card.appendChild(actions);
  return card;
}

function renderSearchResults(items) {
  var container = document.getElementById("jam-results");
  if (!container) return;
  container.innerHTML = "";
  _jamSearchItems = jamNormalizeCatalogItems(items, _jamSearchKind);
  _jamSearchItems.forEach(function(item) {
    container.appendChild(jamCreateCatalogCard(item, "search"));
  });
  jamSetPager("jam-search", _jamSearchOffset, JAM_CATALOG_PAGE_SIZE, _jamSearchTotal, _jamSearchNextOffset, "result", false);
}

function jamUpdateContributorOptions(contributors, items) {
  var select = document.getElementById("jam-library-contributor");
  if (!select) return;
  var selected = select.value;
  var all = jamNormalizeContributors(contributors);
  if (!all.length) {
    var combined = [];
    (items || []).forEach(function(item) { combined = combined.concat(item.attributions || []); });
    all = jamNormalizeContributors(combined);
  }
  select.innerHTML = "";
  var everyone = document.createElement("option");
  everyone.value = "";
  everyone.textContent = "Everyone";
  select.appendChild(everyone);
  all.sort(function(a, b) { return a.display_name.localeCompare(b.display_name); }).forEach(function(contributor) {
    var option = document.createElement("option");
    option.value = contributor.actor_id;
    option.textContent = contributor.display_name + (contributor.count ? " (" + contributor.count + ")" : "");
    select.appendChild(option);
  });
  if (Array.prototype.some.call(select.options, function(option) { return option.value === selected; })) select.value = selected;
}

async function loadJamLibrary(offset) {
  if (_jamLibraryController) _jamLibraryController.abort();
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  _jamLibraryController = controller;
  var requestId = ++_jamLibraryRequestSeq;
  var requestedOffset = jamSafeInteger(offset, 0);
  var kind = document.getElementById("jam-library-kind");
  var contributor = document.getElementById("jam-library-contributor");
  var sort = document.getElementById("jam-library-sort");
  var direction = document.getElementById("jam-library-direction");
  var query = "?kind=" + encodeURIComponent(kind ? kind.value : "all") +
    (contributor && contributor.value ? "&actor_id=" + encodeURIComponent(contributor.value) : "") +
    "&sort=" + encodeURIComponent(sort ? sort.value : "added_at") +
    "&direction=" + encodeURIComponent(direction ? direction.value : "desc") +
    "&offset=" + requestedOffset + "&limit=" + JAM_LIBRARY_PAGE_SIZE;
  jamSetBusy("jam-library-list", true);
  jamSetViewStatus("jam-library-status", "Loading Echo Favorites...");
  jamSetPager("jam-library", requestedOffset, JAM_LIBRARY_PAGE_SIZE, _jamLibraryTotal, null, "favorite", true);
  try {
    var options = { headers: jamActorHeaders() };
    if (controller) options.signal = controller.signal;
    var response = await fetch(apiUrl("/api/jam/favorites" + query), options);
    if (requestId !== _jamLibraryRequestSeq) return;
    if (!response.ok) {
      jamSetViewStatus("jam-library-status", await jamApiErrorMessage(response, "load favorites"), "error");
      return;
    }
    var data = await response.json();
    if (requestId !== _jamLibraryRequestSeq) return;
    var unique = Object.create(null);
    _jamLibraryItems = jamNormalizeCatalogItems(data.items || []).filter(function(item) {
      var key = jamItemKey(item);
      if (unique[key]) return false;
      unique[key] = true;
      return true;
    });
    _jamLibraryOffset = jamSafeInteger(data.offset, requestedOffset);
    _jamLibraryTotal = jamSafeInteger(data.total, _jamLibraryItems.length);
    var suppliedNext = data.next_offset;
    _jamLibraryNextOffset = suppliedNext === null || suppliedNext === undefined
      ? (_jamLibraryOffset + _jamLibraryItems.length < _jamLibraryTotal ? _jamLibraryOffset + JAM_LIBRARY_PAGE_SIZE : null)
      : jamSafeInteger(suppliedNext, 0);
    _jamLibraryLoaded = true;
    jamUpdateContributorOptions(data.contributors || (data.counts && data.counts.contributors), _jamLibraryItems);
    renderJamLibrary();
    jamSetViewStatus("jam-library-status", _jamLibraryItems.length ? "Echo Favorites loaded." : "No Echo Favorites match these filters.");
  } catch (error) {
    if (requestId !== _jamLibraryRequestSeq || (error && error.name === "AbortError")) return;
    jamSetViewStatus("jam-library-status", "Echo Favorites are unavailable right now.", "error");
    debugLog("[jam] favorites load error: " + error);
  } finally {
    if (requestId === _jamLibraryRequestSeq) {
      jamSetBusy("jam-library-list", false);
      jamSetPager("jam-library", _jamLibraryOffset, JAM_LIBRARY_PAGE_SIZE, _jamLibraryTotal, _jamLibraryNextOffset, "favorite", false);
    }
  }
}

function renderJamLibrary() {
  var container = document.getElementById("jam-library-list");
  if (!container) return;
  container.innerHTML = "";
  _jamLibraryItems.forEach(function(item) { container.appendChild(jamCreateCatalogCard(item, "library")); });
}

function jamApplyFavoriteState(item, favorited, normalizedResponse) {
  var responseItem = normalizedResponse || item;
  var previousCount = jamSafeInteger(item.favorite_contributor_count, 0);
  item.favorited_by_me = favorited;
  item.attributions = normalizedResponse ? normalizedResponse.attributions : (favorited ? item.attributions : []);
  item.favorite_contributor_count = normalizedResponse
    ? normalizedResponse.favorite_contributor_count
    : Math.max(0, previousCount + (favorited ? 1 : -1));
  item.contributor_count = item.favorite_contributor_count;
  [_jamSearchItems, _jamLibraryItems, _jamPlaylistItems].forEach(function(collection) {
    collection.forEach(function(candidate) {
      if (jamItemKey(candidate) !== jamItemKey(item)) return;
      candidate.favorited_by_me = item.favorited_by_me;
      candidate.attributions = item.attributions;
      candidate.favorite_contributor_count = item.favorite_contributor_count;
      candidate.contributor_count = item.contributor_count;
    });
  });
  if (_jamPlaylist && jamItemKey(_jamPlaylist) === jamItemKey(item)) {
    _jamPlaylist.favorited_by_me = item.favorited_by_me;
    _jamPlaylist.attributions = item.attributions;
    _jamPlaylist.favorite_contributor_count = item.favorite_contributor_count;
  }
  document.querySelectorAll("[data-jam-favorite-key]").forEach(function(element) {
    if (element.getAttribute("data-jam-favorite-key") !== jamItemKey(item)) return;
    if (element.tagName === "BUTTON") {
      element.setAttribute("aria-pressed", favorited ? "true" : "false");
      element.setAttribute("aria-label", (favorited ? "Remove from Echo Favorites: " : "Add to Echo Favorites: ") + item.name);
      element.textContent = favorited ? "\u2605" : "\u2606";
      element.title = favorited ? "Remove from Echo Favorites" : "Add to Echo Favorites";
    } else {
      var summary = jamFavoriteSummary(item);
      element.textContent = summary ? "\u2605 " + summary : "";
    }
  });
  var detailFavorite = document.getElementById("jam-playlist-favorite");
  if (_jamPlaylist && jamItemKey(_jamPlaylist) === jamItemKey(item) && detailFavorite) {
    detailFavorite.setAttribute("aria-pressed", favorited ? "true" : "false");
    detailFavorite.textContent = favorited ? "Remove from Echo Favorites" : "Save to Echo";
  }
}

async function toggleJamFavorite(rawItem) {
  var item = normalizeSpotifyCatalogItem(rawItem, rawItem && rawItem.kind);
  if (!item) return;
  var key = jamItemKey(item);
  if (_jamFavoritePending[key]) return;
  _jamFavoritePending[key] = true;
  document.querySelectorAll("[data-jam-favorite-key]").forEach(function(element) {
    if (element.getAttribute("data-jam-favorite-key") === key && element.tagName === "BUTTON") element.disabled = true;
  });
  var favorited = !rawItem.favorited_by_me;
  try {
    var response = await fetch(apiUrl("/api/jam/favorites/" + encodeURIComponent(item.kind) + "/" + encodeURIComponent(item.spotify_id)), {
      method: favorited ? "PUT" : "DELETE",
      headers: jamActorHeaders()
    });
    if (!response.ok) {
      showJamError(await jamApiErrorMessage(response, favorited ? "add to Echo Favorites" : "remove from Echo Favorites"));
      return;
    }
    var data = await response.json().catch(function() { return {}; });
    var normalized = data.item ? normalizeSpotifyCatalogItem(data.item, item.kind) : null;
    jamApplyFavoriteState(rawItem, favorited, normalized);
    _jamLibraryLoaded = false;
    if (_jamActiveView === "library") loadJamLibrary(_jamLibraryOffset);
  } catch (error) {
    showJamError("Could not update Echo Favorites.");
    debugLog("[jam] favorite update error: " + error);
  } finally {
    delete _jamFavoritePending[key];
    document.querySelectorAll("[data-jam-favorite-key]").forEach(function(element) {
      if (element.getAttribute("data-jam-favorite-key") === key && element.tagName === "BUTTON") element.disabled = false;
    });
  }
}

async function importSpotifyFavorites() {
  if (_jamImportPending) return;
  _jamImportPending = true;
  applyJamContractToControls();
  jamSetViewStatus("jam-library-status", "Importing your Spotify saved songs and playlists...");
  try {
    var response = await fetch(apiUrl("/api/jam/favorites/import-spotify"), {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({})
    });
    if (!response.ok) {
      jamSetViewStatus("jam-library-status", await jamApiErrorMessage(response, "import Spotify favorites"), "error");
      return;
    }
    var data = await response.json();
    var tracks = jamSafeInteger(data.tracks_seen !== undefined ? data.tracks_seen : (data.tracks || data.track_count || data.tracks_imported), 0);
    var playlists = jamSafeInteger(data.playlists_seen !== undefined ? data.playlists_seen : (data.playlists || data.playlist_count || data.playlists_imported), 0);
    var skipped = jamSafeInteger(data.skipped, 0);
    var created = jamSafeOptionalInteger(data.items_created);
    var attributionsAdded = jamSafeOptionalInteger(data.attributions_added);
    var importMessage = "Scanned " + tracks + " songs and " + playlists + " playlists";
    if (created !== null) importMessage += "; created " + created + " new favorites";
    if (attributionsAdded !== null) importMessage += "; added " + attributionsAdded + " attributions";
    if (skipped) importMessage += "; skipped " + skipped;
    var truncated = data.partial === true || data.truncated === true;
    if (truncated) importMessage += "; import stopped at Spotify's safety limit";
    _jamLibraryLoaded = false;
    await loadJamLibrary(0);
    jamSetViewStatus("jam-library-status", importMessage + ".", truncated ? "warning" : "success");
  } catch (error) {
    jamSetViewStatus("jam-library-status", "Spotify import failed. Try again.", "error");
    debugLog("[jam] Spotify import error: " + error);
  } finally {
    _jamImportPending = false;
    applyJamContractToControls();
  }
}

// ──────────────────────────────────────────
// Queue
// ──────────────────────────────────────────

function renderJamPlaylistSummary() {
  var container = document.getElementById("jam-playlist-summary");
  var favorite = document.getElementById("jam-playlist-favorite");
  var addAll = document.getElementById("jam-playlist-add-all");
  if (!container || !_jamPlaylist) return;
  container.innerHTML = "";
  var header = document.createElement("div");
  header.className = "jam-playlist-header";
  header.appendChild(jamCreateArtwork(_jamPlaylist, "jam-playlist-art"));
  var info = document.createElement("div");
  info.className = "jam-playlist-header-info";
  var title = document.createElement("h3");
  title.id = "jam-playlist-detail-title";
  title.appendChild(jamCreateSpotifyLink(_jamPlaylist, _jamPlaylist.name, "jam-spotify-link"));
  info.appendChild(title);
  var meta = document.createElement("div");
  meta.className = "jam-result-artist";
  var parts = [];
  if (_jamPlaylist.owner) parts.push("By " + _jamPlaylist.owner);
  var knownCount = _jamPlaylistTotal !== null && _jamPlaylistTotal !== undefined
    ? _jamPlaylistTotal
    : _jamPlaylist.item_count;
  if (knownCount !== null && knownCount !== undefined) parts.push(knownCount + (knownCount === 1 ? " song" : " songs"));
  meta.textContent = parts.join(" \u00b7 ");
  info.appendChild(meta);
  if (_jamPlaylist.description) {
    var description = document.createElement("p");
    description.className = "jam-playlist-description";
    description.textContent = _jamPlaylist.description;
    info.appendChild(description);
  }
  header.appendChild(info);
  container.appendChild(header);
  if (favorite) {
    favorite.setAttribute("aria-pressed", _jamPlaylist.favorited_by_me ? "true" : "false");
    favorite.textContent = _jamPlaylist.favorited_by_me ? "Remove from Echo Favorites" : "Save to Echo";
    favorite.disabled = !!_jamFavoritePending[jamItemKey(_jamPlaylist)];
  }
  if (addAll) {
    var countKnown = knownCount !== null && knownCount !== undefined;
    var overLimit = countKnown && knownCount > 50;
    addAll.disabled = _jamPlaylistQueuePending || _jamPlaylistLoading || overLimit || !_jamContract || !_jamContract.canControl;
    addAll.title = overLimit ? "Echo can add at most 50 playlist songs at once" : "Add this playlist as one queue batch";
  }
}

function openJamPlaylistDetail(rawPlaylist, opener) {
  var playlist = normalizeSpotifyCatalogItem(rawPlaylist, "playlist");
  if (!playlist) {
    showJamError("That playlist is unavailable.");
    return;
  }
  if (_jamPlaylistController) _jamPlaylistController.abort();
  _jamPlaylistRequestSeq += 1;
  _jamPlaylistLoading = false;
  _jamPlaylist = playlist;
  _jamPlaylistItems = [];
  _jamPlaylistTotal = playlist.item_count;
  _jamPlaylistNextOffset = 0;
  _jamPlaylistReturnView = _jamActiveView;
  _jamPlaylistOpener = opener || document.activeElement;
  ["library", "search", "queue", "history"].forEach(function(name) {
    var panel = document.getElementById("jam-" + name + "-section");
    if (panel) panel.hidden = true;
  });
  var detail = document.getElementById("jam-playlist-detail");
  if (detail) detail.hidden = false;
  renderJamPlaylistSummary();
  renderJamPlaylistItems();
  jamSetViewStatus("jam-playlist-status", "Loading playlist songs...");
  fetchJamPlaylistItems(0, false);
  var back = document.getElementById("jam-playlist-back");
  if (back) back.focus();
}

function closeJamPlaylistDetail() {
  if (_jamPlaylistController) _jamPlaylistController.abort();
  _jamPlaylistRequestSeq += 1;
  _jamPlaylistLoading = false;
  var opener = _jamPlaylistOpener;
  setJamView(_jamPlaylistReturnView || "search", false);
  _jamPlaylistOpener = null;
  if (opener && document.contains(opener) && typeof opener.focus === "function") opener.focus();
}

function jamSkippedCount(value) {
  return Array.isArray(value) ? value.length : jamSafeInteger(value, 0);
}

async function fetchJamPlaylistItems(offset, append) {
  if (!_jamPlaylist || _jamPlaylistLoading) return;
  if (_jamPlaylistController) _jamPlaylistController.abort();
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  _jamPlaylistController = controller;
  var requestId = ++_jamPlaylistRequestSeq;
  var requestedOffset = jamSafeInteger(offset, 0);
  _jamPlaylistLoading = true;
  renderJamPlaylistSummary();
  jamSetBusy("jam-playlist-items", true);
  var loadMore = document.getElementById("jam-playlist-load-more");
  if (loadMore) loadMore.disabled = true;
  try {
    var options = { headers: jamActorHeaders() };
    if (controller) options.signal = controller.signal;
    var response = await fetch(apiUrl("/api/jam/playlists/" + encodeURIComponent(_jamPlaylist.spotify_id) + "/items?offset=" + requestedOffset + "&limit=" + JAM_PLAYLIST_PAGE_SIZE), options);
    if (requestId !== _jamPlaylistRequestSeq) return;
    if (!response.ok) {
      jamSetViewStatus("jam-playlist-status", await jamApiErrorMessage(response, "load playlist songs"), "error");
      return;
    }
    var data = await response.json();
    if (requestId !== _jamPlaylistRequestSeq) return;
    if (data.playlist) {
      var returnedPlaylist = normalizeSpotifyCatalogItem(data.playlist, "playlist");
      if (returnedPlaylist) _jamPlaylist = returnedPlaylist;
    }
    var pageItems = jamNormalizeCatalogItems(data.items || [], "track");
    _jamPlaylistItems = append ? _jamPlaylistItems.concat(pageItems) : pageItems;
    _jamPlaylistTotal = jamSafeInteger(data.total, _jamPlaylist.item_count || _jamPlaylistItems.length);
    _jamPlaylist.item_count = _jamPlaylistTotal;
    var suppliedNext = data.next_offset;
    _jamPlaylistNextOffset = suppliedNext === null || suppliedNext === undefined
      ? (requestedOffset + pageItems.length < _jamPlaylistTotal ? requestedOffset + pageItems.length : null)
      : jamSafeInteger(suppliedNext, 0);
    renderJamPlaylistSummary();
    renderJamPlaylistItems();
    var skipped = jamSkippedCount(data.skipped);
    jamSetViewStatus(
      "jam-playlist-status",
      "Loaded " + _jamPlaylistItems.length + " of " + _jamPlaylistTotal + " songs" + (skipped ? "; " + skipped + " unavailable skipped" : "") + ".",
      skipped ? "warning" : ""
    );
  } catch (error) {
    if (requestId !== _jamPlaylistRequestSeq || (error && error.name === "AbortError")) return;
    jamSetViewStatus("jam-playlist-status", "Playlist songs are unavailable right now.", "error");
    debugLog("[jam] playlist items error: " + error);
  } finally {
    if (requestId === _jamPlaylistRequestSeq) {
      _jamPlaylistLoading = false;
      renderJamPlaylistSummary();
      jamSetBusy("jam-playlist-items", false);
      if (loadMore) {
        loadMore.disabled = false;
        loadMore.hidden = _jamPlaylistNextOffset === null;
      }
    }
  }
}

function renderJamPlaylistItems() {
  var container = document.getElementById("jam-playlist-items");
  if (!container) return;
  container.innerHTML = "";
  _jamPlaylistItems.forEach(function(item) { container.appendChild(jamCreateCatalogCard(item, "playlist-detail")); });
  var loadMore = document.getElementById("jam-playlist-load-more");
  if (loadMore) loadMore.hidden = _jamPlaylistNextOffset === null;
}

function jamRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return "jam-playlist-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

async function addPlaylistToQueue() {
  if (!_jamPlaylist || _jamPlaylistQueuePending || !jamActionAllowed("control")) return;
  if (_jamPlaylistLoading) {
    jamSetViewStatus("jam-playlist-status", "Wait for the playlist details to finish loading.");
    return;
  }
  var trackCount = _jamPlaylistTotal !== null && _jamPlaylistTotal !== undefined
    ? _jamPlaylistTotal
    : (_jamPlaylist.item_count || 0);
  if (trackCount > 50) {
    jamSetViewStatus("jam-playlist-status", "This playlist has " + trackCount + " songs. Echo can add at most 50 at once.", "error");
    return;
  }
  var confirmed = false;
  if (trackCount > 25) {
    confirmed = window.confirm("Add all " + trackCount + " songs from " + _jamPlaylist.name + " to the queue?");
    if (!confirmed) {
      jamSetViewStatus("jam-playlist-status", "Playlist was not added.");
      return;
    }
  }
  _jamPlaylistQueuePending = true;
  renderJamPlaylistSummary();
  jamSetViewStatus("jam-playlist-status", "Adding playlist to the queue...");
  try {
    var requestId = jamRequestId();
    var response = await fetch(apiUrl("/api/jam/queue/playlist"), {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({
        generation: _jamState && _jamState.generation,
        playlist_id: _jamPlaylist.spotify_id,
        request_id: requestId,
        confirmed: confirmed
      })
    });
    if (!response.ok) {
      var rejection = {};
      try { rejection = await response.clone().json(); } catch (_) { rejection = {}; }
      if ((rejection.confirmation_required === true || rejection.error === "confirmation_required") && !confirmed) {
        var serverCount = jamSafeOptionalInteger(rejection.playable_count !== undefined
          ? rejection.playable_count
          : (rejection.track_count || rejection.item_count));
        if (serverCount !== null && serverCount > 50) {
          jamSetViewStatus("jam-playlist-status", "This playlist has " + serverCount + " songs. Echo can add at most 50 at once.", "error");
          return;
        }
        confirmed = window.confirm("Add all " + (serverCount !== null ? serverCount + " " : "available ") + "songs from " + _jamPlaylist.name + " to the queue?");
        if (!confirmed) {
          jamSetViewStatus("jam-playlist-status", "Playlist was not added.");
          return;
        }
        response = await fetch(apiUrl("/api/jam/queue/playlist"), {
          method: "POST",
          headers: jamActorHeaders(),
          body: JSON.stringify({
            generation: _jamState && _jamState.generation,
            playlist_id: _jamPlaylist.spotify_id,
            request_id: requestId,
            confirmed: true
          })
        });
      }
    }
    if (!response.ok) {
      jamSetViewStatus("jam-playlist-status", await jamApiErrorMessage(response, "add playlist to the queue"), "error");
      return;
    }
    var data = await response.json();
    var queued = jamSafeInteger(data.queued_count, 0);
    var skipped = jamSkippedCount(data.skipped);
    var partial = data.partial === true || data.complete === false || data.ok === false || skipped > 0;
    var failureObject = data.failure && typeof data.failure === "object" ? data.failure : null;
    var failure = jamSafeString(failureObject ? failureObject.message : data.failure);
    var failureRetryAfter = failureObject && failureObject.retry_after !== null && failureObject.retry_after !== undefined
      ? String(failureObject.retry_after).trim()
      : "";
    var retryMessage = failureRetryAfter ? " Try again in " + failureRetryAfter + " seconds." : "";
    jamSetViewStatus(
      "jam-playlist-status",
      "Added " + queued + (queued === 1 ? " song" : " songs") + " to the queue" + (skipped ? "; skipped " + skipped : "") + "." + (partial ? " The playlist was partially added." : "") + (failure ? " " + failure : "") + retryMessage,
      partial ? "warning" : "success"
    );
    showJamToast("Added " + queued + (queued === 1 ? " song" : " songs") + " from " + _jamPlaylist.name);
    fetchJamState();
  } catch (error) {
    jamSetViewStatus("jam-playlist-status", "Could not add that playlist to the queue.", "error");
    debugLog("[jam] playlist queue error: " + error);
  } finally {
    _jamPlaylistQueuePending = false;
    renderJamPlaylistSummary();
  }
}

function jamDateValue(value) {
  if (value === null || value === undefined || value === "") return null;
  var date;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    var numeric = Number(value);
    if (numeric < 100000000000) numeric *= 1000;
    date = new Date(numeric);
  } else {
    date = new Date(value);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

function jamHistoryEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  var trackSource = raw.track && typeof raw.track === "object" ? Object.assign({}, raw.track) : {
    kind: "track",
    spotify_id: raw.spotify_id || raw.track_id || raw.track_spotify_id,
    spotify_uri: raw.spotify_uri || raw.track_uri,
    spotify_url: raw.spotify_url || raw.track_url,
    name: raw.name || raw.track_name,
    artist: raw.artist || raw.track_artist,
    artwork_url: raw.artwork_url || raw.album_art_url,
    duration_ms: raw.duration_ms
  };
  trackSource.kind = "track";
  var track = normalizeSpotifyCatalogItem(trackSource, "track");
  var playlistSource = raw.playlist && typeof raw.playlist === "object" ? Object.assign({}, raw.playlist) : null;
  if (!playlistSource && (raw.playlist_id || raw.playlist_spotify_id)) {
    playlistSource = {
      kind: "playlist",
      spotify_id: raw.playlist_id || raw.playlist_spotify_id,
      spotify_uri: raw.playlist_uri,
      spotify_url: raw.playlist_url,
      name: raw.playlist_name || "Playlist"
    };
  }
  if (playlistSource) playlistSource.kind = "playlist";
  var playlist = playlistSource ? normalizeSpotifyCatalogItem(playlistSource, "playlist") : null;
  var contributor = jamNormalizeContributor(raw.added_by_name || raw.added_by || raw.added_by_actor_id);
  return {
    track: track,
    track_name: track ? track.name : jamSafeString(raw.track_name || raw.name) || "Unknown track",
    artist: track ? track.artist : jamSafeString(raw.artist || raw.track_artist),
    playlist: playlist,
    added_by: contributor ? contributor.display_name : "Unknown",
    played_at: jamDateValue(raw.played_at_ms !== undefined ? raw.played_at_ms : raw.played_at),
    added_at: jamDateValue(raw.added_at_ms !== undefined ? raw.added_at_ms : raw.added_at)
  };
}

function jamAppendHistoryTime(parent, label, date) {
  var row = document.createElement("div");
  row.className = "jam-history-meta-row";
  row.appendChild(document.createTextNode(label + " "));
  if (date) {
    var time = document.createElement("time");
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleString();
    row.appendChild(time);
  } else {
    row.appendChild(document.createTextNode("Unknown"));
  }
  parent.appendChild(row);
}

function renderJamHistory(items) {
  var list = document.getElementById("jam-history-list");
  if (!list) return;
  list.innerHTML = "";
  (items || []).forEach(function(raw) {
    var entry = jamHistoryEntry(raw);
    if (!entry) return;
    var row = document.createElement("li");
    row.className = "jam-history-item";
    row.appendChild(jamCreateArtwork(entry.track || { artwork_url: "" }, "jam-result-art"));
    var content = document.createElement("div");
    content.className = "jam-history-content";
    if (entry.track) content.appendChild(jamCreateSpotifyLink(entry.track, entry.track_name, "jam-result-name jam-spotify-link"));
    else {
      var name = document.createElement("span");
      name.className = "jam-result-name";
      name.textContent = entry.track_name;
      content.appendChild(name);
    }
    var artist = document.createElement("div");
    artist.className = "jam-result-artist";
    artist.textContent = entry.artist || "Unknown artist";
    content.appendChild(artist);
    jamAppendHistoryTime(content, "Played", entry.played_at);
    jamAppendHistoryTime(content, "Added", entry.added_at);
    var addedBy = document.createElement("div");
    addedBy.className = "jam-history-meta-row";
    addedBy.textContent = "Added by " + entry.added_by;
    content.appendChild(addedBy);
    if (entry.playlist) {
      var provenance = document.createElement("div");
      provenance.className = "jam-history-meta-row jam-history-playlist";
      provenance.appendChild(document.createTextNode("From "));
      provenance.appendChild(jamCreateSpotifyLink(entry.playlist, entry.playlist.name, "jam-spotify-link"));
      content.appendChild(provenance);
    }
    row.appendChild(content);
    list.appendChild(row);
  });
}

async function loadJamHistory(offset) {
  if (_jamHistoryController) _jamHistoryController.abort();
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  _jamHistoryController = controller;
  var requestId = ++_jamHistoryRequestSeq;
  var requestedOffset = jamSafeInteger(offset, 0);
  var sort = document.getElementById("jam-history-sort");
  var direction = document.getElementById("jam-history-direction");
  var query = "?sort=" + encodeURIComponent(sort ? sort.value : "played_at") +
    "&direction=" + encodeURIComponent(direction ? direction.value : "desc") +
    "&offset=" + requestedOffset + "&limit=" + JAM_HISTORY_PAGE_SIZE;
  jamSetBusy("jam-history-list", true);
  jamSetViewStatus("jam-history-status", "Loading play history...");
  jamSetPager("jam-history", requestedOffset, JAM_HISTORY_PAGE_SIZE, _jamHistoryTotal, null, "play", true);
  try {
    var options = { headers: jamActorHeaders() };
    if (controller) options.signal = controller.signal;
    var response = await fetch(apiUrl("/api/jam/history" + query), options);
    if (requestId !== _jamHistoryRequestSeq) return;
    if (!response.ok) {
      jamSetViewStatus("jam-history-status", await jamApiErrorMessage(response, "load play history"), "error");
      return;
    }
    var data = await response.json();
    if (requestId !== _jamHistoryRequestSeq) return;
    var items = Array.isArray(data) ? data : (data.items || []);
    _jamHistoryOffset = jamSafeInteger(data.offset, requestedOffset);
    _jamHistoryTotal = jamSafeInteger(data.total, items.length);
    var suppliedNext = data.next_offset;
    _jamHistoryNextOffset = suppliedNext === null || suppliedNext === undefined
      ? (_jamHistoryOffset + items.length < _jamHistoryTotal ? _jamHistoryOffset + JAM_HISTORY_PAGE_SIZE : null)
      : jamSafeInteger(suppliedNext, 0);
    _jamHistoryLoaded = true;
    renderJamHistory(items);
    jamSetViewStatus("jam-history-status", items.length ? "Play history loaded." : "Nothing has played yet.");
  } catch (error) {
    if (requestId !== _jamHistoryRequestSeq || (error && error.name === "AbortError")) return;
    jamSetViewStatus("jam-history-status", "Play history is unavailable right now.", "error");
    debugLog("[jam] history load error: " + error);
  } finally {
    if (requestId === _jamHistoryRequestSeq) {
      jamSetBusy("jam-history-list", false);
      jamSetPager("jam-history", _jamHistoryOffset, JAM_HISTORY_PAGE_SIZE, _jamHistoryTotal, _jamHistoryNextOffset, "play", false);
    }
  }
}

async function addToQueue(track) {
  try {
    if (!jamActionAllowed("control")) return;
    var resp = await fetch(apiUrl("/api/jam/queue"), {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({
        spotify_uri: track.spotify_uri,
        name: track.name,
        artist: track.artist,
        album_art_url: track.album_art_url,
        duration_ms: track.duration_ms,
        generation: _jamState && _jamState.generation
      })
    });
    if (!resp.ok) {
      var errText = await resp.text().catch(function() { return ""; });
      showJamError("Add to queue failed" + (errText ? ": " + errText : " (status " + resp.status + ")"));
      return;
    }
    fetchJamState();
  } catch (e) {
    showJamError("Add to queue failed: " + e.message);
    debugLog("[jam] addToQueue error: " + e);
  }
}

// ──────────────────────────────────────────
// Join / Leave
// ──────────────────────────────────────────

async function joinJam() {
  try {
    if (!jamActionAllowed("join")) return;
    await detectJamSourceHost();
    if (_jamSessionState && _jamSessionState.requestJoin) {
      _jamSessionState.requestJoin();
      syncJamButtonsFromState();
    }
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    var resp = await fetch(apiUrl("/api/jam/join"), {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({ identity: identity, generation: _jamState && _jamState.generation })
    });
    if (!resp.ok) {
      if (_jamSessionState && _jamSessionState.joinRejected) {
        _jamSessionState.joinRejected("join-status-" + resp.status);
        syncJamButtonsFromState();
      }
      showJamError("Join failed (status " + resp.status + ")");
      debugLog("[jam] joinJam server error: " + resp.status);
      return;
    }
    if (_jamSessionState && _jamSessionState.joinAccepted) {
      var joinedGeneration = Number(_jamState && _jamState.generation);
      _jamListeningGeneration = Number.isFinite(joinedGeneration) ? joinedGeneration : null;
      _jamSessionState.joinAccepted();
      syncJamButtonsFromState();
    }
    // Keep legacy source hosts from hearing a doubled relay. Native takeover
    // may explicitly enable this synced relay as the source PC's monitor.
    muteSourceHostRelayIfNeeded(true);
    // Start receiving audio via WebSocket
    startJamAudioStream();
    fetchJamState();
  } catch (e) {
    if (_jamSessionState && _jamSessionState.joinRejected) {
      _jamSessionState.joinRejected(e && e.message ? e.message : "join-error");
      syncJamButtonsFromState();
    }
    showJamError("Join failed: " + e.message);
    debugLog("[jam] joinJam error: " + e);
  }
}

async function leaveJam() {
  try {
    if (_jamSessionState && _jamSessionState.requestLeave) {
      _jamSessionState.requestLeave();
      syncJamButtonsFromState();
    }
    clearJamReconnectTimer();
    // Serialize an in-flight idempotent rejoin ahead of leave. Otherwise a slow
    // rejoin response could recreate server membership after leave succeeded.
    if (_jamRejoinPromise) await _jamRejoinPromise.catch(function() {});
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    var resp = await fetch(apiUrl("/api/jam/leave"), {
      method: "POST",
      headers: jamActorHeaders(),
      body: JSON.stringify({
        identity: identity,
        generation: _jamListeningGeneration === null
          ? (_jamState && _jamState.generation)
          : _jamListeningGeneration
      })
    });
    if (!resp.ok) {
      if (_jamSessionState && _jamSessionState.leaveFailed) {
        _jamSessionState.leaveFailed("leave-status-" + resp.status);
        syncJamButtonsFromState();
      }
      debugLog("[jam] leaveJam server error: " + resp.status);
      if (!_jamAudioWs) scheduleJamReconnect(0);
      return;
    }
    if (_jamSessionState && _jamSessionState.leaveSucceeded) {
      _jamSessionState.leaveSucceeded();
      syncJamButtonsFromState();
    }
    _jamListeningGeneration = null;
    clearJamReconnectTimer();
    // Intentionally stop stream after leave API success so a transient server-side
    // leave failure does not silently drop local jam audio while still joined.
    stopJamAudioStream();
    fetchJamState();
  } catch (e) {
    if (_jamSessionState && _jamSessionState.leaveFailed) {
      _jamSessionState.leaveFailed(e && e.message ? e.message : "leave-error");
      syncJamButtonsFromState();
    }
    if (!_jamAudioWs) scheduleJamReconnect(0);
    showJamError("Leave failed: " + e.message);
    debugLog("[jam] leaveJam error: " + e);
  }
}

// ──────────────────────────────────────────
// State Polling
// ──────────────────────────────────────────

async function fetchJamState() {
  // Native source state is local to this PC and intentionally independent of
  // room/login state. Refresh it alongside each server Jam poll.
  refreshJamSourceLocalControl();
  var requestId = _jamStateRequestGate.begin();
  try {
    var resp = await fetch(apiUrl("/api/jam/state"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!_jamStateRequestGate.isCurrent(requestId)) return;
    if (!resp.ok) {
      _jamState = null;
      _jamContract = unavailableJamContract("Jam status is unavailable — controls are paused");
      renderJamContractStatus();
      applyJamContractToControls();
      return;
    }
    var nextState = await resp.json();
    if (!_jamStateRequestGate.isCurrent(requestId)) return;
    reconcileJamListeningWithServer(nextState);
    _jamState = nextState;
    _jamContract = evaluateJamServerContract(_jamState);
    renderJamContractStatus();
    applyJamContractToControls();
    stopJamForCompatibilityFailure();
    renderJamPanel();
    updateNowPlayingBanner(_jamState);
    startPendingJamAudioIfNeeded();
  } catch (e) {
    if (!_jamStateRequestGate.isCurrent(requestId)) return;
    _jamState = null;
    _jamContract = unavailableJamContract("Jam status is unavailable — controls are paused");
    renderJamContractStatus();
    applyJamContractToControls();
    debugLog("[jam] state poll error: " + e);
  }
}

function renderJamPanel() {
  if (!_jamState) return;
  var contract = _jamContract || evaluateJamServerContract(_jamState);
  var identity = room && room.localParticipant ? room.localParticipant.identity : "";

  // Spotify status
  var statusEl = document.getElementById("jam-spotify-status");
  if (statusEl) {
    statusEl.textContent = _jamState.spotify_connected ? "Spotify Connected" : "Not Connected";
    statusEl.className = "jam-spotify-status " + (_jamState.spotify_connected ? "connected" : "");
  }

  // Connect button visibility
  var connectBtn = document.getElementById("jam-connect-spotify");
  if (connectBtn) {
    connectBtn.style.display = "";
    connectBtn.textContent = _jamState.spotify_connected ? "Refresh Spotify Access" : "Connect Spotify";
    connectBtn.title = _jamState.spotify_connected
      ? "Reauthorize Spotify to refresh playlist and library permissions"
      : "Connect Spotify";
    connectBtn.disabled = !contract.compatible;
  }

  // Host controls visibility (show if spotify is connected)
  var hostControls = document.getElementById("jam-host-controls");
  if (hostControls) {
    hostControls.style.display = _jamState.spotify_connected ? "" : "none";
  }

  // Strip -XXXX reconnect suffixes for identity comparison
  var idBase = typeof getIdentityBase === "function" ? getIdentityBase : function(id) { return id; };
  var myBase = idBase(identity);

  var startBtn = document.getElementById("jam-start-btn");
  var stopBtn = document.getElementById("jam-stop-music-btn");
  var endBtn = document.getElementById("jam-end-btn");
  var skipBtn = document.getElementById("jam-skip-btn");
  if (startBtn) {
    startBtn.style.display = _jamState.active ? "none" : "";
    startBtn.disabled = !contract.canStart;
  }
  if (stopBtn) {
    stopBtn.style.display = _jamState.active && contract.playbackStopSupported ? "" : "none";
    stopBtn.disabled = !contract.canStopPlayback;
  }
  if (endBtn) {
    var isExactHost = !!identity && _jamState.host_identity === identity;
    endBtn.style.display = _jamState.active && isExactHost ? "" : "none";
    endBtn.disabled = !contract.compatible;
  }
  if (skipBtn) {
    skipBtn.style.display = _jamState.active ? "" : "none";
    skipBtn.disabled = !contract.canControl;
  }

  // Now Playing
  renderNowPlaying(_jamState.now_playing);

  // Queue
  renderQueue(_jamState.queue || []);

  var isListening = false;
  if (_jamState.listeners && myBase) {
    for (var li = 0; li < _jamState.listeners.length; li++) {
      if (idBase(_jamState.listeners[li]) === myBase) { isListening = true; break; }
    }
  }
  var joinBtn = document.getElementById("jam-join-btn");
  var leaveBtn = document.getElementById("jam-leave-btn");
  var listenCount = document.getElementById("jam-listener-count");
  if (listenCount) listenCount.textContent = (_jamState.listener_count || 0) + " listening";

  if (_jamSessionState && _jamSessionState.snapshot) {
    // Rendering should be presentation-only: do not mutate state-machine transitions
    // from polling snapshots. Join/leave transitions are driven in explicit API
    // response callbacks (joinJam/leaveJam) and stream lifecycle handlers.
    syncJamButtonsFromState();
  } else {
    if (joinBtn) {
      joinBtn.style.display = (!isListening && _jamState.active) ? "" : "none";
      joinBtn.disabled = !contract.canJoin;
    }
    if (leaveBtn) leaveBtn.style.display = (isListening && _jamState.active) ? "" : "none";
  }

  // Jam actions visible only when jam is active
  var actionsSection = document.getElementById("jam-actions-section");
  if (actionsSection) actionsSection.style.display = (_jamState.active && contract.compatible) ? "" : "none";

  renderJamContractStatus();
  applyJamContractToControls();
}

function renderNowPlaying(np) {
  var container = document.getElementById("jam-now-playing");
  if (!container) return;
  if (!np || !np.name || !np.is_playing) {
    container.innerHTML = '<div class="jam-now-playing-empty">No music playing</div>';
    container.removeAttribute("role");
    container.removeAttribute("tabindex");
    container.removeAttribute("aria-label");
    container.style.cursor = "";
    container.title = "";
    container.onclick = null;
    container.onkeydown = null;
    return;
  }
  var progress = np.duration_ms > 0 ? Math.min(100, (np.progress_ms / np.duration_ms) * 100) : 0;
  var track = normalizeSpotifyCatalogItem(Object.assign({}, np, { kind: "track" }), "track");
  container.innerHTML = "";
  container.appendChild(jamCreateArtwork({ artwork_url: jamSafeArtworkUrl(np.album_art_url || np.artwork_url) }, "jam-now-playing-art"));
  var info = document.createElement("div");
  info.className = "jam-now-playing-info";
  var title = track
    ? jamCreateSpotifyLink(track, jamSafeString(np.name), "jam-now-playing-name jam-spotify-link")
    : document.createElement("div");
  if (!track) {
    title.className = "jam-now-playing-name";
    title.textContent = jamSafeString(np.name);
  }
  info.appendChild(title);
  var artist = document.createElement("div");
  artist.className = "jam-now-playing-artist";
  artist.textContent = jamSafeString(np.artist);
  info.appendChild(artist);
  container.appendChild(info);
  var progressTrack = document.createElement("div");
  progressTrack.className = "jam-progress";
  var progressBar = document.createElement("div");
  progressBar.className = "jam-progress-bar";
  progressBar.style.width = progress.toFixed(1) + "%";
  progressTrack.appendChild(progressBar);
  container.appendChild(progressTrack);
  var nowPlayingName = container.querySelector(".jam-now-playing-name");
  var nowPlayingArtist = container.querySelector(".jam-now-playing-artist");
  if (nowPlayingName) nowPlayingName.title = np.name || "";
  if (nowPlayingArtist) nowPlayingArtist.title = np.artist || "";

  // Click now-playing card to join jam if not already listening
  if (!_jamAudioWs && _jamState && _jamState.active && !track) {
    container.style.cursor = "pointer";
    container.title = "Join the Jam";
    container.setAttribute("role", "button");
    container.setAttribute("tabindex", "0");
    container.setAttribute("aria-label", "Join Jam — " + np.name + " by " + np.artist + " is playing");
    container.onclick = function() { joinJam(); };
    container.onkeydown = function(event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      joinJam();
    };
  } else {
    container.style.cursor = "";
    container.title = "";
    container.removeAttribute("role");
    container.removeAttribute("tabindex");
    container.removeAttribute("aria-label");
    container.onclick = null;
    container.onkeydown = null;
  }
}

function renderQueue(queue) {
  var container = document.getElementById("jam-queue-list");
  if (!container) return;
  if (!queue.length) {
    container.innerHTML = '<div class="jam-queue-empty">Queue is empty</div>';
    return;
  }
  container.innerHTML = "";
  queue.forEach(function(track) {
    var normalizedTrack = normalizeSpotifyCatalogItem(Object.assign({}, track, { kind: "track" }), "track");
    var item = document.createElement("div");
    item.className = "jam-queue-item";
    item.setAttribute("role", "listitem");
    item.appendChild(jamCreateArtwork({ artwork_url: jamSafeArtworkUrl(track.album_art_url || track.artwork_url) }, "jam-result-art"));
    var info = document.createElement("div");
    info.className = "jam-result-info";
    var trackName = jamSafeString(track.name) || "Unknown track";
    var name = normalizedTrack
      ? jamCreateSpotifyLink(normalizedTrack, trackName, "jam-result-name jam-spotify-link")
      : document.createElement("div");
    if (!normalizedTrack) {
      name.className = "jam-result-name";
      name.textContent = trackName;
    }
    info.appendChild(name);
    var artist = document.createElement("div");
    artist.className = "jam-result-artist";
    var addedBy = jamSafeString(track.added_by_name || track.added_by || track.added_by_actor_id);
    artist.textContent = (jamSafeString(track.artist) || "Unknown artist") + (addedBy ? " \u00b7 Added by " + addedBy : "");
    info.appendChild(artist);
    var playlistRaw = track.playlist && typeof track.playlist === "object"
      ? Object.assign({}, track.playlist, { kind: "playlist" })
      : null;
    var playlist = playlistRaw ? normalizeSpotifyCatalogItem(playlistRaw, "playlist") : null;
    if (playlist) {
      var provenance = document.createElement("div");
      provenance.className = "jam-queue-provenance";
      provenance.appendChild(document.createTextNode("From "));
      provenance.appendChild(jamCreateSpotifyLink(playlist, playlist.name, "jam-spotify-link"));
      info.appendChild(provenance);
    }
    item.appendChild(info);
    name.title = name.textContent;
    artist.title = artist.textContent;
    container.appendChild(item);
  });
}

// ──────────────────────────────────────────
// WebSocket Audio Streaming
// ──────────────────────────────────────────

function startJamAudioStream() {
  if (_jamAudioWs) return; // already connected
  if (!_jamContract || !_jamContract.canJoin) {
    debugLog("[jam] blocked audio WebSocket: Jam protocol/source state is not ready");
    return;
  }

  try {
    // Build WebSocket URL from current API base (wss for https, ws for http)
    var base = apiUrl("/api/jam/audio");
    var wsUrl;
    if (base.indexOf("https://") === 0) {
      wsUrl = "wss://" + base.substring(8);
    } else if (base.indexOf("http://") === 0) {
      wsUrl = "ws://" + base.substring(7);
    } else {
      var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = proto + "//" + window.location.host + base;
    }

    // Keep credentials and identity out of URLs, browser history, proxy access
    // logs, and debug output. Authentication is the first WebSocket text frame.
    if (!window.EchoJamSessionState ||
        typeof window.EchoJamSessionState.buildJamAudioSocketQuery !== "function" ||
        typeof window.EchoJamSessionState.parseJamAudioControlMessage !== "function") {
      throw new Error("Jam audio protocol helper is unavailable");
    }
    var socketQuery = window.EchoJamSessionState.buildJamAudioSocketQuery(
      JAM_PROTOCOL_VERSION,
      _jamListeningGeneration
    );
    var socketUrl = new URL(wsUrl);
    socketUrl.search = socketQuery;
    wsUrl = socketUrl.toString();
    var participantToken = currentAccessToken;
    if (!participantToken) throw new Error("Jam participant token is unavailable");

    debugLog(
      "[jam] opening audio WebSocket protocol=" + JAM_PROTOCOL_VERSION +
      " generation=" + _jamListeningGeneration
    );

    // Create AudioContext for playback (48 kHz stereo)
    if (!_jamAudioCtx) {
      _jamAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      _jamGainNode = _jamAudioCtx.createGain();
      _jamGainNode.gain.value = currentJamRelayGain();

      var speakerSelect = document.getElementById("speaker-select");
      if (speakerSelect && speakerSelect.value && typeof _jamAudioCtx.setSinkId === "function") {
        _jamAudioCtx.setSinkId(speakerSelect.value).catch(function() {});
      }

      _jamGainNode.connect(_jamAudioCtx.destination);
    }

    if (_jamAudioCtx.state === "suspended") {
      _jamAudioCtx.resume();
    }

    _jamNextPlayTime = 0;

    var ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    _jamAudioWs = ws;
    var terminalHandled = false;
    var protocolReady = false;
    var readyTimer = null;

    function handleTerminal(reason) {
      if (terminalHandled) return;
      terminalHandled = true;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      if (_jamAudioWs === ws) _jamAudioWs = null;
      if (_jamSessionState && _jamSessionState.streamClosedTransient) {
        var closeState = _jamSessionState.streamClosedTransient(reason);
        syncJamButtonsFromState();
        if (closeState.shouldReconnect && (!_jamContract || _jamContract.compatible)) {
          scheduleJamReconnect(closeState.delayMs);
        }
      }
    }

    ws.onopen = function() {
      if (_jamAudioWs !== ws) return;
      try {
        if (participantToken !== currentAccessToken) {
          handleTerminal("ws-participant-token-superseded");
          try { ws.close(); } catch (closeError) {}
          return;
        }
        ws.send(JSON.stringify({ type: "auth", token: currentAccessToken }));
        debugLog("[jam] audio WebSocket open; authentication sent");
        readyTimer = setTimeout(function() {
          if (protocolReady || _jamAudioWs !== ws) return;
          debugLog("[jam] audio WebSocket ready handshake timed out");
          handleTerminal("ws-ready-timeout");
          try { ws.close(); } catch (closeError) {}
        }, 7000);
      } catch (e) {
        handleTerminal("ws-auth-send-failed");
        try { ws.close(); } catch (closeError) {}
      }
    };

    ws.onmessage = function(e) {
      if (_jamAudioWs !== ws || !_jamAudioCtx) return;
      if (typeof e.data === "string") {
        var control = window.EchoJamSessionState.parseJamAudioControlMessage(e.data);
        if (control.type === "ready") {
          if (protocolReady) return;
          protocolReady = true;
          if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
          }
          debugLog("[jam] audio WebSocket authenticated and ready");
          if (_jamSessionState && _jamSessionState.streamOpen) {
            _jamSessionState.streamOpen();
            syncJamButtonsFromState();
          }
          clearJamReconnectTimer();
          return;
        }
        debugLog("[jam] audio WebSocket rejected its control handshake");
        handleTerminal("ws-auth-rejected");
        try { ws.close(); } catch (closeError) {}
        return;
      }
      if (!(e.data instanceof ArrayBuffer)) return;
      if (!protocolReady) {
        debugLog("[jam] audio WebSocket sent PCM before ready; closing");
        handleTerminal("ws-pcm-before-ready");
        try { ws.close(); } catch (closeError) {}
        return;
      }

      var f32 = new Float32Array(e.data);
      var samplesPerChannel = f32.length / 2;
      if (samplesPerChannel <= 0) return;

      var buffer = _jamAudioCtx.createBuffer(2, samplesPerChannel, 48000);
      var left = buffer.getChannelData(0);
      var right = buffer.getChannelData(1);
      for (var i = 0; i < samplesPerChannel; i++) {
        left[i] = f32[i * 2];
        right[i] = f32[i * 2 + 1];
      }

      var now = _jamAudioCtx.currentTime;
      var schedule = window.EchoJamSessionState && typeof window.EchoJamSessionState.planAudioFrame === "function"
        ? window.EchoJamSessionState.planAudioFrame(_jamNextPlayTime, now, buffer.duration, 0.5)
        : {
            drop: _jamNextPlayTime - now > 0.5,
            startTime: _jamNextPlayTime < now ? now + 0.02 : _jamNextPlayTime,
            nextPlayTime: null,
          };
      if (schedule.drop) return;

      var source = _jamAudioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(_jamGainNode);
      source.start(schedule.startTime);
      _jamNextPlayTime = Number.isFinite(schedule.nextPlayTime)
        ? schedule.nextPlayTime
        : schedule.startTime + buffer.duration;
    };

    ws.onclose = function() {
      debugLog("[jam] audio WebSocket closed");
      handleTerminal("ws-close");
    };

    ws.onerror = function(e) {
      debugLog("[jam] audio WebSocket error: " + (e.message || e.type || "unknown"));
      handleTerminal(e.message || e.type || "ws-error");
      try { ws.close(); } catch (closeError) {}
      if (typeof showToast === "function") showToast("Jam audio dropped — retrying");
    };
  } catch (ex) {
    debugLog("[jam] startJamAudioStream exception: " + ex.message);
    if (_jamSessionState && _jamSessionState.streamClosedTransient) {
      var failureState = _jamSessionState.streamClosedTransient(ex.message || "stream-start-failed");
      syncJamButtonsFromState();
      if (failureState.shouldReconnect && (!_jamContract || _jamContract.compatible)) {
        scheduleJamReconnect(failureState.delayMs);
      }
    }
  }
}

function stopJamAudioStream() {
  clearJamReconnectTimer();
  if (_jamAudioWs) {
    _jamAudioWs.close();
    _jamAudioWs = null;
  }
  if (_jamAudioCtx) {
    _jamAudioCtx.close().catch(function() {});
    _jamAudioCtx = null;
    _jamGainNode = null;
  }
  _jamNextPlayTime = 0;
}

// ──────────────────────────────────────────
// Volume
// ──────────────────────────────────────────

function onJamVolumeChange(e) {
  _jamVolume = parseInt(e.target.value, 10);
  var label = document.getElementById("jam-volume-value");
  if (label) label.textContent = _jamVolume + "%";
  // Preserve both global Mute All and the source-PC monitor policy while the
  // user adjusts their independent Jam volume.
  applyJamRelayGain();
}

// ──────────────────────────────────────────
// Toast Notifications
// ──────────────────────────────────────────

function showJamToast(message) {
  var existing = document.querySelector(".jam-toast");
  if (existing) {
    releaseJamToastTheme(existing);
    existing.remove();
  }
  var toast = document.createElement("div");
  toast.className = "jam-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  if (window.EchoTheme && typeof window.EchoTheme.bindModule === "function") {
    toast._echoThemeUnbind = window.EchoTheme.bindModule("jam", toast);
  }
  setTimeout(function() { toast.classList.add("jam-toast-visible"); }, 10);
  setTimeout(function() {
    toast.classList.remove("jam-toast-visible");
    setTimeout(function() {
      toast.remove();
      releaseJamToastTheme(toast);
    }, 400);
  }, 4000);
}

function releaseJamToastTheme(toast) {
  if (toast && typeof toast._echoThemeUnbind === "function") {
    toast._echoThemeUnbind();
    toast._echoThemeUnbind = null;
  }
}

function showJamError(msg) {
  var el = document.getElementById("jam-status");
  if (el) { el.textContent = msg; el.className = "jam-status error"; }
  setTimeout(function() { if (el) el.textContent = ""; }, 5000);
}

function showJamStatus(msg) {
  var el = document.getElementById("jam-status");
  if (el) { el.textContent = msg; el.className = "jam-status"; }
}

// ──────────────────────────────────────────
// Jam notification chime (Web Audio API)
// ──────────────────────────────────────────

function playJamStartChime() {
  try {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    var ctx = new AudioCtx();
    var now = ctx.currentTime;
    // Fun ascending arpeggio — musical "something exciting is starting"
    var notes = [
      [523.25, 0],      // C5
      [659.25, 0.1],    // E5
      [783.99, 0.2],    // G5
      [1046.5, 0.3]     // C6
    ];
    notes.forEach(function(pair) {
      var freq = pair[0], offset = pair[1];
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.35);
    });
    // Close context after chime finishes
    setTimeout(function() { ctx.close(); }, 1000);
  } catch (e) {
    // silent — chime is non-critical
  }
}

// ──────────────────────────────────────────
// Data Channel Handler (jam messages)
// ──────────────────────────────────────────

function handleJamDataMessage(payload) {
  if (!payload || !payload.type) return;
  if (payload.type === "jam-started") {
    playJamStartChime();
    startBannerPolling();
    fetchJamState();
  } else if (payload.type === "jam-playback-stopped") {
    if (_jamState) {
      _jamState.spotify_is_playing = false;
      if (_jamState.now_playing) _jamState.now_playing.is_playing = false;
      _jamContract = evaluateJamServerContract(_jamState);
      renderJamPanel();
      updateNowPlayingBanner(_jamState);
    }
    fetchJamState();
  } else if (payload.type === "jam-stopped") {
    resetLocalJamListening();
    syncJamButtonsFromState();
    stopBannerPolling();
    updateNowPlayingBanner(null);
    fetchJamState();
  }
}

// ──────────────────────────────────────────
// Init
// ──────────────────────────────────────────

function bindJamCatalogControls() {
  document.querySelectorAll(".jam-browser-tab").forEach(function(tab) {
    tab.onclick = function() { setJamView(tab.getAttribute("data-jam-view"), false); };
    tab.onkeydown = function(event) {
      jamTabKeydown(event, ".jam-browser-tab", function(nextTab) {
        setJamView(nextTab.getAttribute("data-jam-view"), false);
      });
    };
  });
  document.querySelectorAll(".jam-search-kind-tab").forEach(function(tab) {
    tab.onclick = function() { setJamSearchKind(tab.getAttribute("data-jam-search-kind"), false); };
    tab.onkeydown = function(event) {
      jamTabKeydown(event, ".jam-search-kind-tab", function(nextTab) {
        setJamSearchKind(nextTab.getAttribute("data-jam-search-kind"), false);
      });
    };
  });

  var searchInput = document.getElementById("jam-search-input");
  if (searchInput) searchInput.oninput = onSearchInput;
  var searchPrevious = document.getElementById("jam-search-prev");
  if (searchPrevious) searchPrevious.onclick = function() {
    searchSpotify(_jamSearchQuery, Math.max(0, _jamSearchOffset - JAM_CATALOG_PAGE_SIZE));
  };
  var searchNext = document.getElementById("jam-search-next");
  if (searchNext) searchNext.onclick = function() {
    if (_jamSearchNextOffset !== null) searchSpotify(_jamSearchQuery, _jamSearchNextOffset);
  };

  ["jam-library-kind", "jam-library-contributor", "jam-library-sort", "jam-library-direction"].forEach(function(id) {
    var control = document.getElementById(id);
    if (control) control.onchange = function() { loadJamLibrary(0); };
  });
  var libraryPrevious = document.getElementById("jam-library-prev");
  if (libraryPrevious) libraryPrevious.onclick = function() {
    loadJamLibrary(Math.max(0, _jamLibraryOffset - JAM_LIBRARY_PAGE_SIZE));
  };
  var libraryNext = document.getElementById("jam-library-next");
  if (libraryNext) libraryNext.onclick = function() {
    if (_jamLibraryNextOffset !== null) loadJamLibrary(_jamLibraryNextOffset);
  };
  var importButton = document.getElementById("jam-import-spotify");
  if (importButton) importButton.onclick = importSpotifyFavorites;

  var playlistBack = document.getElementById("jam-playlist-back");
  if (playlistBack) playlistBack.onclick = closeJamPlaylistDetail;
  var playlistFavorite = document.getElementById("jam-playlist-favorite");
  if (playlistFavorite) playlistFavorite.onclick = function() {
    if (_jamPlaylist) toggleJamFavorite(_jamPlaylist);
  };
  var playlistAddAll = document.getElementById("jam-playlist-add-all");
  if (playlistAddAll) playlistAddAll.onclick = addPlaylistToQueue;
  var playlistLoadMore = document.getElementById("jam-playlist-load-more");
  if (playlistLoadMore) playlistLoadMore.onclick = function() {
    if (_jamPlaylistNextOffset !== null) fetchJamPlaylistItems(_jamPlaylistNextOffset, true);
  };

  ["jam-history-sort", "jam-history-direction"].forEach(function(id) {
    var control = document.getElementById(id);
    if (control) control.onchange = function() { loadJamHistory(0); };
  });
  var historyPrevious = document.getElementById("jam-history-prev");
  if (historyPrevious) historyPrevious.onclick = function() {
    loadJamHistory(Math.max(0, _jamHistoryOffset - JAM_HISTORY_PAGE_SIZE));
  };
  var historyNext = document.getElementById("jam-history-next");
  if (historyNext) historyNext.onclick = function() {
    if (_jamHistoryNextOffset !== null) loadJamHistory(_jamHistoryNextOffset);
  };
}

function initJam() {
  if (_jamInited) return;
  _jamInited = true;
  // Full polling owns Jam state once the panel initializes. Cancel the
  // lightweight banner loop before issuing the first ordered full-state fetch.
  stopBannerPolling();
  refreshJamSourceLocalControl();
  _jamContract = unavailableJamContract("Checking Jam server and host source…");

  // Wire up event listeners
  var closeBtn = document.getElementById("close-jam");
  if (closeBtn) closeBtn.onclick = closeJamPanel;

  var connectBtn = document.getElementById("jam-connect-spotify");
  if (connectBtn) connectBtn.onclick = connectSpotify;

  var startBtn = document.getElementById("jam-start-btn");
  if (startBtn) startBtn.onclick = startJam;

  var stopBtn = document.getElementById("jam-stop-music-btn");
  if (stopBtn) stopBtn.onclick = stopJamPlayback;

  var endBtn = document.getElementById("jam-end-btn");
  if (endBtn) endBtn.onclick = endJam;

  var skipBtn = document.getElementById("jam-skip-btn");
  if (skipBtn) skipBtn.onclick = skipTrack;

  var joinBtn = document.getElementById("jam-join-btn");
  if (joinBtn) joinBtn.onclick = joinJam;

  var leaveBtn = document.getElementById("jam-leave-btn");
  if (leaveBtn) leaveBtn.onclick = leaveJam;

  bindJamCatalogControls();
  setJamView(_jamActiveView, false);
  setJamSearchKind(_jamSearchKind, false);

  var volumeInput = document.getElementById("jam-volume-slider");
  if (volumeInput) volumeInput.oninput = onJamVolumeChange;

  renderJamContractStatus();
  applyJamContractToControls();

  // Start polling
  fetchJamState();
  _jamPollTimer = setInterval(fetchJamState, 5000);
}

// Cleanup on disconnect (called from app.js if wired up)
function cleanupJam() {
  // Invalidate any in-flight banner/full-state response before clearing local
  // state so a late response cannot resurrect Jam UI after disconnect.
  _jamStateRequestGate.begin();
  if (_jamPollTimer) {
    clearInterval(_jamPollTimer);
    _jamPollTimer = null;
  }
  if (_spotifyPollTimer) {
    clearInterval(_spotifyPollTimer);
    _spotifyPollTimer = null;
  }
  clearTimeout(_searchTimer);
  _searchTimer = null;
  [_jamSearchController, _jamLibraryController, _jamPlaylistController, _jamHistoryController].forEach(function(controller) {
    if (controller) controller.abort();
  });
  _jamSearchController = null;
  _jamLibraryController = null;
  _jamPlaylistController = null;
  _jamHistoryController = null;
  _jamSearchRequestSeq += 1;
  _jamLibraryRequestSeq += 1;
  _jamPlaylistRequestSeq += 1;
  _jamHistoryRequestSeq += 1;
  _jamPlaylistLoading = false;
  _jamPlaylistQueuePending = false;
  _jamImportPending = false;
  _jamLibraryLoaded = false;
  _jamHistoryLoaded = false;
  stopBannerPolling();
  updateNowPlayingBanner(null);
  _jamState = null;
  _jamContract = null;
  _jamListeningGeneration = null;
  _jamInited = false;
  clearJamReconnectTimer();
  if (_jamSessionState && _jamSessionState.leaveSucceeded) {
    _jamSessionState.leaveSucceeded();
    syncJamButtonsFromState();
  }
  stopJamAudioStream();
  closeJamPanel({ restoreFocus: false });
}

// ──────────────────────────────────────────
// Now Playing Banner (room-top bar)
// ──────────────────────────────────────────

function updateNowPlayingBanner(state) {
  var banner = document.getElementById("jam-banner");
  if (!banner) return;

  if ((_jamContract && !_jamContract.compatible) || !state || !state.active || !state.now_playing || !state.now_playing.name || !state.now_playing.is_playing) {
    banner.classList.add("hidden");
    banner.removeAttribute("role");
    banner.removeAttribute("tabindex");
    banner.removeAttribute("aria-label");
    banner.style.cursor = "";
    return;
  }

  var np = state.now_playing;
  var track = normalizeSpotifyCatalogItem(Object.assign({}, np, { kind: "track" }), "track");
  banner.innerHTML = "";
  banner.appendChild(jamCreateArtwork({ artwork_url: jamSafeArtworkUrl(np.album_art_url || np.artwork_url) }, "jam-banner-art"));
  var info = document.createElement("div");
  info.className = "jam-banner-info";
  var title = track
    ? jamCreateSpotifyLink(track, jamSafeString(np.name), "jam-banner-title jam-spotify-link")
    : document.createElement("div");
  if (!track) {
    title.className = "jam-banner-title";
    title.textContent = jamSafeString(np.name);
  }
  info.appendChild(title);
  var artist = document.createElement("div");
  artist.className = "jam-banner-artist";
  artist.textContent = jamSafeString(np.artist);
  info.appendChild(artist);
  banner.appendChild(info);
  var live = document.createElement("button");
  live.type = "button";
  live.className = "jam-banner-live jam-banner-open";
  live.textContent = "JAM";
  live.setAttribute("aria-label", "Open Jam and listen");
  live.onclick = function(event) {
    event.stopPropagation();
    openJamPanel(live);
    if (_jamState && _jamState.active && !_jamAudioWs) joinJam();
  };
  banner.appendChild(live);
  banner.classList.remove("hidden");
  banner.setAttribute("role", "group");
  banner.removeAttribute("tabindex");
  banner.setAttribute("aria-label", "Now playing " + np.name + " by " + np.artist);
  banner.style.cursor = "";
}

// Lightweight poll for banner — runs independently of the Jam panel
async function fetchBannerState() {
  // A queued interval callback can still run after clearInterval(). Do not let
  // that stale banner request supersede an in-flight full-state request.
  if (_jamPollTimer) return;
  var requestId = _jamStateRequestGate.begin();
  try {
    var resp = await fetch(apiUrl("/api/jam/state"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    var requestMayApply = window.EchoJamSessionState &&
      typeof window.EchoJamSessionState.shouldApplyBannerResponse === "function"
      ? window.EchoJamSessionState.shouldApplyBannerResponse(
          !!_jamPollTimer,
          _jamStateRequestGate.isCurrent(requestId)
        )
      : !_jamPollTimer && _jamStateRequestGate.isCurrent(requestId);
    if (!requestMayApply) return;
    if (!resp.ok) return;
    var state = await resp.json();
    requestMayApply = window.EchoJamSessionState &&
      typeof window.EchoJamSessionState.shouldApplyBannerResponse === "function"
      ? window.EchoJamSessionState.shouldApplyBannerResponse(
          !!_jamPollTimer,
          _jamStateRequestGate.isCurrent(requestId)
        )
      : !_jamPollTimer && _jamStateRequestGate.isCurrent(requestId);
    if (!requestMayApply) return;
    _jamContract = evaluateJamServerContract(state);
    if (!_jamContract.compatible) stopJamForCompatibilityFailure();
    _jamState = state;
    updateNowPlayingBanner(state);
    // If jam ended, stop polling
    if (!state.active) stopBannerPolling();
  } catch (e) {
    // silent — banner is non-critical
  }
}

function startBannerPolling() {
  if (_bannerPollTimer) return;  // already running
  if (_jamPollTimer) return;     // full poll already running, it updates the banner
  fetchBannerState();
  _bannerPollTimer = setInterval(fetchBannerState, 5000);
}

function stopBannerPolling() {
  if (_bannerPollTimer) {
    clearInterval(_bannerPollTimer);
    _bannerPollTimer = null;
  }
}

// Source-PC settings must be available on the login portal before Echo
// Connect, so this boot path deliberately does not depend on initJam().
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initJamSourceLocalControlUi, { once: true });
} else {
  initJamSourceLocalControlUi();
}
