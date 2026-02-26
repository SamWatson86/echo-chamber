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
// Audio routing, gain nodes, track subscription, media reconciliation — all in audio-routing.js

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

// Device management, media toggles, camera lobby → media-controls.js

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

// Media toggles (toggleMic, toggleCam, toggleScreen, etc.) → media-controls.js

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

// Start Who's Online polling on page load (only while not connected)
startOnlineUsersPolling();
