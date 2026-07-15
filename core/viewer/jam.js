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
  var searchSection = document.getElementById("jam-search-section");
  var queueSection = document.getElementById("jam-queue-section");

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
  if (searchInput) searchInput.disabled = !contract.canControl;
  document.querySelectorAll(".jam-result-add").forEach(function(button) {
    button.disabled = !contract.canControl;
  });
  if (!contract.canControl) {
    if (searchSection) searchSection.style.display = "none";
    if (queueSection) queueSection.style.display = "none";
  }

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

function openJamPanel() {
  var panel = document.getElementById("jam-panel");
  if (panel) {
    panel.classList.remove("hidden");
    initJam();
  }
}

function closeJamPanel() {
  var panel = document.getElementById("jam-panel");
  if (panel) panel.classList.add("hidden");
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

var _searchTimer = null;

function onSearchInput(e) {
  clearTimeout(_searchTimer);
  var val = e.target.value;
  _searchTimer = setTimeout(function() { searchSpotify(val); }, 300);
}

async function searchSpotify(query) {
  if (!query || query.length < 2) {
    renderSearchResults([]);
    return;
  }
  if (!jamActionAllowed("control")) {
    renderSearchResults([]);
    return;
  }
  try {
    var resp = await fetch(apiUrl("/api/jam/search"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query: query })
    });
    if (!resp.ok) {
      debugLog("[jam] search failed: " + resp.status);
      return;
    }
    var data = await resp.json();
    renderSearchResults(Array.isArray(data) ? data : (data.tracks || []));
  } catch (e) {
    debugLog("[jam] search error: " + e);
  }
}

function renderSearchResults(tracks) {
  var container = document.getElementById("jam-results");
  if (!container) return;
  container.innerHTML = "";
  tracks.forEach(function(t) {
    var item = document.createElement("div");
    item.className = "jam-result-item";
    // Format duration
    var mins = Math.floor(t.duration_ms / 60000);
    var secs = Math.floor((t.duration_ms % 60000) / 1000);
    item.innerHTML =
      '<img class="jam-result-art" src="' + escapeHtml(t.album_art_url || "") + '" alt="">' +
      '<div class="jam-result-info">' +
        '<div class="jam-result-name">' + escapeHtml(t.name) + '</div>' +
        '<div class="jam-result-artist">' + escapeHtml(t.artist) + ' \u00b7 ' + mins + ':' + String(secs).padStart(2, '0') + '</div>' +
      '</div>' +
      '<button class="jam-result-add" title="Add to queue">+</button>';
    var addBtn = item.querySelector(".jam-result-add");
    addBtn.onclick = function() { addToQueue(t); };
    addBtn.disabled = !_jamContract || !_jamContract.canControl;
    container.appendChild(item);
  });
}

// ──────────────────────────────────────────
// Queue
// ──────────────────────────────────────────

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
    connectBtn.style.display = _jamState.spotify_connected ? "none" : "";
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

  // Search + queue sections visible only when spotify connected
  var searchSection = document.getElementById("jam-search-section");
  var queueSection = document.getElementById("jam-queue-section");
  if (searchSection) searchSection.style.display = (_jamState.spotify_connected && contract.canControl) ? "" : "none";
  if (queueSection) queueSection.style.display = (_jamState.spotify_connected && contract.canControl) ? "" : "none";

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
    return;
  }
  var progress = np.duration_ms > 0 ? Math.min(100, (np.progress_ms / np.duration_ms) * 100) : 0;
  container.innerHTML =
    '<img class="jam-now-playing-art" src="' + escapeHtml(np.album_art_url || "") + '" alt="">' +
    '<div class="jam-now-playing-info">' +
      '<div class="jam-now-playing-name">' + escapeHtml(np.name) + '</div>' +
      '<div class="jam-now-playing-artist">' + escapeHtml(np.artist) + '</div>' +
    '</div>' +
    '<div class="jam-progress"><div class="jam-progress-bar" style="width:' + progress.toFixed(1) + '%"></div></div>';

  // Click now-playing card to join jam if not already listening
  if (!_jamAudioWs && _jamState && _jamState.active) {
    container.style.cursor = "pointer";
    container.title = "Click to join the Jam";
    container.onclick = function() { joinJam(); };
  } else {
    container.style.cursor = "";
    container.title = "";
    container.onclick = null;
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
  queue.forEach(function(t) {
    var item = document.createElement("div");
    item.className = "jam-queue-item";
    item.innerHTML =
      '<img class="jam-result-art" src="' + escapeHtml(t.album_art_url || "") + '" alt="">' +
      '<div class="jam-result-info">' +
        '<div class="jam-result-name">' + escapeHtml(t.name) + '</div>' +
        '<div class="jam-result-artist">' + escapeHtml(t.artist) + ' \u00b7 Added by ' + escapeHtml(t.added_by) + '</div>' +
      '</div>';
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
  if (existing) existing.remove();
  var toast = document.createElement("div");
  toast.className = "jam-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function() { toast.classList.add("jam-toast-visible"); }, 10);
  setTimeout(function() {
    toast.classList.remove("jam-toast-visible");
    setTimeout(function() { toast.remove(); }, 400);
  }, 4000);
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

  var searchInput = document.getElementById("jam-search-input");
  if (searchInput) searchInput.oninput = onSearchInput;

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
  closeJamPanel();
}

// ──────────────────────────────────────────
// Now Playing Banner (room-top bar)
// ──────────────────────────────────────────

function updateNowPlayingBanner(state) {
  var banner = document.getElementById("jam-banner");
  if (!banner) return;

  if ((_jamContract && !_jamContract.compatible) || !state || !state.active || !state.now_playing || !state.now_playing.name || !state.now_playing.is_playing) {
    banner.classList.add("hidden");
    return;
  }

  var np = state.now_playing;
  banner.innerHTML =
    '<img class="jam-banner-art" src="' + escapeHtml(np.album_art_url || "") + '" alt="">' +
    '<div class="jam-banner-info">' +
      '<div class="jam-banner-title">' + escapeHtml(np.name) + '</div>' +
      '<div class="jam-banner-artist">' + escapeHtml(np.artist) + '</div>' +
    '</div>' +
    '<span class="jam-banner-live">JAM</span>';
  banner.classList.remove("hidden");

  // Click banner to open jam panel and auto-join
  if (!banner._jamClickBound) {
    banner.style.cursor = "pointer";
    banner.addEventListener("click", function() {
      openJamPanel();
      // Auto-join if not already listening
      if (_jamState && _jamState.active && !_jamAudioWs) joinJam();
    });
    banner._jamClickBound = true;
  }
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
