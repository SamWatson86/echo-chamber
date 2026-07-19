/* =========================================================
   PARTICIPANTS-AVATAR — Icons, participant cards, avatars
   ========================================================= */

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
  if (name === "settings") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h10.2a3 3 0 1 0 0-2H4v2zm0 6h3.2a3 3 0 1 0 0-2H4v2zm0 6h10.2a3 3 0 1 0 0-2H4v2zm13-14a1 1 0 1 1 0 2 1 1 0 0 1 0-2zM10 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm7 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
      </svg>`;
  }
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 5h18v14H3zM5 7v10h14V7H5zm2 12h10v2H7z"/>
    </svg>`;
}

// SOUNDBOARD_ICONS and icon init are in soundboard.js

// ── Participant card ──

var participantControlIdSequence = 0;
var activeParticipantSettings = null;

function closeParticipantSettings(restoreFocus) {
  if (!activeParticipantSettings) return;
  var current = activeParticipantSettings;
  activeParticipantSettings = null;
  current.popup.classList.remove("is-open");
  current.button.setAttribute("aria-expanded", "false");
  if (restoreFocus && current.button.isConnected) current.button.focus();
}

function toggleParticipantSettings(button, popup) {
  var opening = !popup.classList.contains("is-open");
  if (activeParticipantSettings && activeParticipantSettings.popup !== popup) {
    closeParticipantSettings(false);
  }
  popup.classList.toggle("is-open", opening);
  button.setAttribute("aria-expanded", opening ? "true" : "false");
  activeParticipantSettings = opening ? { button: button, popup: popup } : null;
}

if (typeof document.addEventListener === "function") {
  document.addEventListener("click", function(event) {
    if (!activeParticipantSettings) return;
    if (activeParticipantSettings.button.contains(event.target) ||
        activeParticipantSettings.popup.contains(event.target)) return;
    closeParticipantSettings(false);
  });

  document.addEventListener("keydown", function(event) {
    if (event.key !== "Escape" || !activeParticipantSettings) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeParticipantSettings(true);
  });
}

function getRemoteParticipantsForScreenIdentity(identity) {
  var matches = [];
  if (!identity || !room || !room.remoteParticipants) return matches;
  var seen = new Set();

  function addCandidate(candidateIdentity) {
    if (!candidateIdentity || seen.has(candidateIdentity)) return;
    var participant = null;
    if (room.remoteParticipants.get) {
      participant = room.remoteParticipants.get(candidateIdentity);
    }
    if (!participant) {
      room.remoteParticipants.forEach(function(p) {
        if (!participant && p.identity === candidateIdentity) participant = p;
      });
    }
    if (participant && !seen.has(participant.identity)) {
      seen.add(participant.identity);
      matches.push(participant);
    }
  }

  addCandidate(identity);
  addCandidate(identity + "$screen");
  return matches;
}

function startWatchingScreenIdentity(identity, reason) {
  if (!identity) return;

  hiddenScreens.delete(identity);
  watchedScreens.add(identity);

  var cardRef = participantCards.get(identity);
  if (cardRef && cardRef.watchToggleBtn) {
    cardRef.watchToggleBtn.style.display = "";
    cardRef.watchToggleBtn.textContent = "Stop Watching";
    if (cardRef.ovWatchClone) {
      cardRef.ovWatchClone.style.display = "";
      cardRef.ovWatchClone.textContent = "Stop Watching";
    }
  }

  var tile = screenTileByIdentity.get(identity);
  if (tile) tile.style.display = "";

  var pState = participantState.get(identity);
  if (pState && pState.screenAudioEls) {
    pState.screenAudioEls.forEach(function(el) {
      el.muted = false;
      var gn = pState.screenGainNodes?.get(el);
      if (gn) gn.gain.gain.value = pState.screenVolume || 1;
    });
  }

  function formatPubState(pub, remote) {
    patchScreenCompanionSource(pub, pub?.track, remote);
    var src = pub ? (pub.source || (pub.track ? pub.track.source : null) || "?") : "?";
    var kind = pub?.kind || pub?.track?.kind || "?";
    var mst = pub?.track?.mediaStreamTrack || null;
    var recv = "?";
    try {
      var subPc = room?.engine?.pcManager?.subscriber?.pc;
      if (mst && subPc?.getReceivers) {
        recv = subPc.getReceivers().some(function(r) {
          return r && r.track === mst;
        }) ? "true" : "false";
      }
    } catch (_) {}
    return remote.identity + ":" + src + ":" + kind +
      ":sub=" + (pub?.isSubscribed ?? "?") +
      ":track=" + (!!pub?.track) +
      ":recv=" + recv +
      ":mst=" + (mst ? (mst.readyState + "/" + (mst.muted ? "muted" : "live")) : "none");
  }

  function formatTileState() {
    var tile = screenTileByIdentity.get(identity);
    if (!tile) return "tile=none";
    var video = tile.querySelector("video");
    if (!video) {
      return "tile=present:no-video" +
        ":display=" + (tile.style.display || "auto") +
        ":client=" + tile.clientWidth + "x" + tile.clientHeight;
    }
    return "tile=present" +
      ":display=" + (tile.style.display || "auto") +
      ":client=" + tile.clientWidth + "x" + tile.clientHeight +
      ":video=" + video.videoWidth + "x" + video.videoHeight +
      ":paused=" + video.paused +
      ":rs=" + video.readyState;
  }

  function runStage(stageLabel) {
    var remotes = getRemoteParticipantsForScreenIdentity(identity);
    if (remotes.length === 0) {
      debugLog("[opt-in] " + stageLabel + ": no remote screen participant yet for " + identity);
      reportWatchDebug("identity=" + identity + " stage=" + stageLabel + " remotes=none hidden=" + hiddenScreens.has(identity) + " watched=" + watchedScreens.has(identity));
      return;
    }
    var summaries = [];
    remotes.forEach(function(remote) {
      var pubs = getParticipantPublications(remote);
      summaries.push(
        pubs.length > 0
          ? pubs.map(function(pub) { return formatPubState(pub, remote); }).join(",")
          : (remote.identity + ":no-pubs")
      );
      debugLog("[opt-in] " + stageLabel + ": resubscribe/reconcile " + remote.identity + " -> " + identity);
      if (typeof resubscribeParticipantTracks === "function") {
        resubscribeParticipantTracks(remote);
      } else {
        pubs.forEach(function(pub) {
          if (pub?.setSubscribed) pub.setSubscribed(true);
          hookPublication(pub, remote);
        });
      }
      if (typeof reconcileParticipantMedia === "function") {
        reconcileParticipantMedia(remote);
      }
    });
    reportWatchDebug(
      "identity=" + identity +
      " stage=" + stageLabel +
      " hidden=" + hiddenScreens.has(identity) +
      " watched=" + watchedScreens.has(identity) +
      " " + formatTileState() +
      " remotes=" + summaries.join(";")
    );
  }

  debugLog("[opt-in] start watching " + identity + " reason=" + (reason || "manual"));
  runStage("immediate");
  setTimeout(function() { runStage("fallback@500ms"); }, 500);
  setTimeout(function() { runStage("fallback@1500ms"); }, 1500);
  scheduleReconcileWaves("opt-in-watch");
}

function getParticipantMicrophonePublicationState(participant) {
  var LK = getLiveKitClient();
  var micSource = LK?.Track?.Source?.Microphone;
  var publications = getParticipantPublications(participant);
  var publication = publications.find(function(pub) {
    if (!pub) return false;
    var source = pub.source || pub.track?.source;
    var kind = pub.kind || pub.track?.kind;
    return source === micSource && (!kind || kind === LK?.Track?.Kind?.Audio || kind === "audio");
  });

  return {
    published: !!publication,
    muted: publication ? !!publication.isMuted : true,
  };
}

function ensureParticipantCard(participant, isLocal = false) {
  const key = participant.identity;
  // Hide ghost subscriber from UI
  if (key.startsWith("__echo_ghost_")) return null;
  // Hide internal companion identities from participant list.
  if (isScreenIdentity(key) || isNativePresenterIdentity(key)) return null;
  if (participantCards.has(key)) {
    debugLog(`participant card already exists for ${key}`);
    return participantCards.get(key);
  }
  debugLog(`creating NEW participant card for ${key}, isLocal=${isLocal}`);
  var participantControlId = ++participantControlIdSequence;
  var participantDisplayName = participant.name || "Guest";
  const card = document.createElement("div");
  card.className = "user-card " + (isLocal ? "is-local" : "is-remote");
  card.dataset.identity = key;

  const title = document.createElement("div");
  title.className = "user-name";
  title.textContent = participant.name || "Guest";
  title.title = title.textContent;
  card.append(title);

  const publisherMicState = document.createElement("div");
  publisherMicState.className = "participant-mic-state";
  publisherMicState.hidden = true;
  publisherMicState.setAttribute("role", "status");
  publisherMicState.setAttribute("aria-label", "Microphone off for " + participantDisplayName);
  const publisherMicStateIcon = document.createElement("span");
  publisherMicStateIcon.className = "participant-mic-state-icon";
  publisherMicStateIcon.innerHTML = iconSvg("mic");
  const publisherMicStateLabel = document.createElement("span");
  publisherMicStateLabel.className = "participant-mic-state-label";
  publisherMicStateLabel.textContent = "Mic off";
  publisherMicState.append(publisherMicStateIcon, publisherMicStateLabel);
  card.append(publisherMicState);

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
  let popChimeSlider = null;
  let popChimePct = null;
  let participantSettingsButton = null;
  let participantSettingsPopup = null;
  let settingsMicMute = null;
  let settingsScreenMute = null;
  let settingsMicSlider = null;
  let settingsMicPct = null;
  let settingsScreenSlider = null;
  let settingsScreenPct = null;
  let settingsChimeSlider = null;
  let settingsChimePct = null;
  let settingsWatchButton = null;
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
    micIndicator.setAttribute("aria-label", "Microphone audio settings for " + (participant.name || "Guest"));
    micMuteButton = document.createElement("button");
    micMuteButton.type = "button";
    micMuteButton.className = "mute-button";
    micMuteButton.textContent = "Mute";
    micMuteButton.setAttribute("aria-label", "Mute microphone audio from " + participantDisplayName);
    screenIndicator = document.createElement("button");
    screenIndicator.type = "button";
    screenIndicator.className = "icon-button indicator-only";
    screenIndicator.innerHTML = iconSvg("screen");
    screenIndicator.setAttribute("aria-label", "Screen audio settings for " + (participant.name || "Guest"));
    screenMuteButton = document.createElement("button");
    screenMuteButton.type = "button";
    screenMuteButton.className = "mute-button";
    screenMuteButton.textContent = "Mute";
    screenMuteButton.setAttribute("aria-label", "Mute screen audio from " + participantDisplayName);
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
      function getWatchSource(pub, remoteParticipant) {
        patchScreenCompanionSource(pub, pub?.track, remoteParticipant);
        return pub ? (pub.source || (pub.track ? pub.track.source : null)) : null;
      }

      if (hiddenScreens.has(identity)) {
        // === START WATCHING: subscribe to screen share tracks ===
        startWatchingScreenIdentity(identity, "manual-click");
        return;
        hiddenScreens.delete(identity);
        watchedScreens.add(identity);
        watchToggleBtn.textContent = "Stop Watching";
        if (ovWatchClone) ovWatchClone.textContent = "Stop Watching";
        debugLog("[opt-in] user opted in to watch " + identity);

        // Find the remote participant and subscribe to their screen share tracks
        var remotes = getRemoteParticipantsForScreenIdentity(identity);
        if (remotes.length > 0) {
          remotes.forEach(function(remote) {
            var pubs = getParticipantPublications(remote);
            pubs.forEach(function(pub) {
              var src = getWatchSource(pub, remote);
              if (src === LK_wt.Track.Source.ScreenShare || src === LK_wt.Track.Source.ScreenShareAudio) {
                // Subscribe to the track on the SFU
                if (pub.setSubscribed) pub.setSubscribed(true);
                // Ensure publication is hooked (event listeners registered)
                hookPublication(pub, remote);
                // If the track is already available (SDK cached it), process immediately
                if (pub.track && pub.isSubscribed) {
                  debugLog("[opt-in] track already available for " + src + " " + remote.identity + " → " + identity + " — processing immediately");
                  handleTrackSubscribed(pub.track, pub, remote);
                } else {
                  debugLog("[opt-in] subscribed to " + src + " for " + remote.identity + " → " + identity + " — waiting for track (subscribed=" + (pub.isSubscribed ?? "?") + " hasTrack=" + !!pub.track + ")");
                }
              }
            });
          });
          // Fallback at 500ms: check if tracks arrived and process them
          setTimeout(function() {
            var remoteFbs = getRemoteParticipantsForScreenIdentity(identity);
            if (remoteFbs.length === 0) return;
            remoteFbs.forEach(function(remoteFb) {
              var fbPubs = getParticipantPublications(remoteFb);
              fbPubs.forEach(function(pub) {
                var src = getWatchSource(pub, remoteFb);
                if (src === LK_wt.Track.Source.ScreenShare) {
                  if (pub.track && pub.isSubscribed && !screenTileByIdentity.has(identity)) {
                    debugLog("[opt-in] fallback@500ms: processing screen track for " + remoteFb.identity + " → " + identity);
                    handleTrackSubscribed(pub.track, pub, remoteFb);
                  }
                  if (!pub.isSubscribed && pub.setSubscribed) {
                    debugLog("[opt-in] fallback@500ms: re-subscribing screen for " + remoteFb.identity + " → " + identity);
                    pub.setSubscribed(true);
                  }
                }
                if (src === LK_wt.Track.Source.ScreenShareAudio) {
                  var fbState = participantState.get(identity);
                  if (pub.track && pub.isSubscribed && fbState && fbState.screenAudioEls.size === 0) {
                    debugLog("[opt-in] fallback@500ms: processing screen audio for " + remoteFb.identity + " → " + identity);
                    handleTrackSubscribed(pub.track, pub, remoteFb);
                  }
                  if (!pub.isSubscribed && pub.setSubscribed) {
                    debugLog("[opt-in] fallback@500ms: re-subscribing screen audio for " + remoteFb.identity + " → " + identity);
                    pub.setSubscribed(true);
                  }
                }
              });
            });
          }, 500);
          // Fallback at 1500ms: full reconcile to catch anything still missing
          setTimeout(function() {
            var remoteFb2s = getRemoteParticipantsForScreenIdentity(identity);
            remoteFb2s.forEach(function(remoteFb2) {
              debugLog("[opt-in] fallback@1500ms: full reconcile for " + remoteFb2.identity + " → " + identity);
              reconcileParticipantMedia(remoteFb2);
            });
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
        var remotes = getRemoteParticipantsForScreenIdentity(identity);
        remotes.forEach(function(remote) {
          var pubs = getParticipantPublications(remote);
          pubs.forEach(function(pub) {
            var src = getWatchSource(pub, remote);
            if (src === LK_wt.Track.Source.ScreenShare || src === LK_wt.Track.Source.ScreenShareAudio) {
              if (pub.setSubscribed) pub.setSubscribed(false);
            }
          });
        });
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
    micSlider.setAttribute("aria-label", "Microphone volume for " + participantDisplayName);
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
    screenSlider.setAttribute("aria-label", "Screen volume for " + participantDisplayName);
    screenPct = document.createElement("span");
    screenPct.className = "vol-pct";
    screenPct.textContent = "100%";
    screenRow.append(screenLabel, screenSlider, screenPct);
    var chimeRow = document.createElement("div");
    chimeRow.className = "audio-row chime-volume-row";
    chimeRow.id = "chime-volume-" + participantControlId;
    const chimeLabel = document.createElement("span");
    chimeLabel.textContent = "Chime";
    chimeSlider = document.createElement("input");
    chimeSlider.type = "range";
    chimeSlider.min = "0";
    chimeSlider.max = "1";
    chimeSlider.step = "0.01";
    chimeSlider.value = "0.5";
    chimeSlider.setAttribute("aria-label", "Chime volume for " + participantDisplayName);
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
    overlayName.title = overlayName.textContent;

    var overlayControls = document.createElement("div");
    overlayControls.className = "cam-overlay-controls";

    // Overlay mic icon — click toggles volume popup
    ovMicBtn = document.createElement("button");
    ovMicBtn.type = "button";
    ovMicBtn.className = "icon-button indicator-only";
    ovMicBtn.innerHTML = iconSvg("mic");
    ovMicBtn.setAttribute("aria-label", "Microphone volume for " + overlayName.textContent);
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
    ovMicMute.setAttribute("aria-label", "Mute microphone audio from " + participantDisplayName);
    ovMicMute.addEventListener("click", function(e) {
      e.stopPropagation();
      micMuteButton.click();
    });

    // Overlay screen icon — click toggles volume popup
    ovScreenBtn = document.createElement("button");
    ovScreenBtn.type = "button";
    ovScreenBtn.className = "icon-button indicator-only";
    ovScreenBtn.innerHTML = iconSvg("screen");
    ovScreenBtn.setAttribute("aria-label", "Screen volume for " + overlayName.textContent);
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
    ovScreenMute.setAttribute("aria-label", "Mute screen audio from " + participantDisplayName);
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
    popMicSlider.setAttribute("aria-label", "Microphone volume for " + participantDisplayName);
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
    popScreenSlider.setAttribute("aria-label", "Screen volume for " + participantDisplayName);
    popScreenPct = document.createElement("span");
    popScreenPct.className = "vol-pct";
    popScreenPct.textContent = screenPct.textContent;
    if (Number(screenSlider.value) > 1) popScreenPct.classList.add("boosted");
    popScreenRow.append(popScreenLabel, popScreenSlider, popScreenPct);

    var popChimeRow = document.createElement("div");
    popChimeRow.className = "audio-row clubhouse-popup-chime";
    var popChimeLabel = document.createElement("span");
    popChimeLabel.textContent = "Chime";
    popChimeSlider = document.createElement("input");
    popChimeSlider.type = "range";
    popChimeSlider.min = "0";
    popChimeSlider.max = "1";
    popChimeSlider.step = "0.01";
    popChimeSlider.value = chimeSlider.value;
    popChimeSlider.setAttribute("aria-label", "Chime volume for " + participantDisplayName);
    popChimePct = document.createElement("span");
    popChimePct.className = "vol-pct";
    popChimePct.textContent = chimePct.textContent;
    popChimeRow.append(popChimeLabel, popChimeSlider, popChimePct);

    volPopup.append(popMicRow, popScreenRow, popChimeRow);
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

    participantSettingsButton = document.createElement("button");
    participantSettingsButton.type = "button";
    participantSettingsButton.className = "participant-settings-toggle shell-v2-only";
    participantSettingsButton.innerHTML = iconSvg("settings");
    participantSettingsButton.setAttribute("aria-label", "Audio settings for " + participantDisplayName);
    participantSettingsButton.setAttribute("aria-haspopup", "dialog");
    participantSettingsButton.setAttribute("aria-expanded", "false");
    participantSettingsButton.title = "Audio settings for " + participantDisplayName;

    participantSettingsPopup = document.createElement("div");
    participantSettingsPopup.id = "participant-settings-" + participantControlId;
    participantSettingsPopup.className = "participant-settings-popover shell-v2-only";
    participantSettingsPopup.setAttribute("role", "dialog");
    participantSettingsPopup.setAttribute("aria-label", "Audio settings for " + participantDisplayName);
    participantSettingsButton.setAttribute("aria-controls", participantSettingsPopup.id);

    var settingsHeading = document.createElement("div");
    settingsHeading.className = "participant-settings-heading";
    var settingsHeadingCopy = document.createElement("div");
    var settingsHeadingTitle = document.createElement("strong");
    settingsHeadingTitle.textContent = participantDisplayName;
    var settingsHeadingHint = document.createElement("span");
    settingsHeadingHint.textContent = "Adjust what you hear";
    settingsHeadingCopy.append(settingsHeadingTitle, settingsHeadingHint);
    var settingsClose = document.createElement("button");
    settingsClose.type = "button";
    settingsClose.className = "participant-settings-close";
    settingsClose.textContent = "\u00d7";
    settingsClose.setAttribute("aria-label", "Close audio settings for " + participantDisplayName);
    settingsClose.addEventListener("click", function(event) {
      event.stopPropagation();
      closeParticipantSettings(true);
    });
    settingsHeading.append(settingsHeadingCopy, settingsClose);

    function createParticipantSettingsSection(labelText, sliderLabel, min, max, step, value, includeMute) {
      var section = document.createElement("div");
      section.className = "participant-settings-section";
      var sectionHeader = document.createElement("div");
      sectionHeader.className = "participant-settings-section-header";
      var label = document.createElement("span");
      label.textContent = labelText;
      var mute = null;
      if (includeMute) {
        mute = document.createElement("button");
        mute.type = "button";
        mute.className = "participant-settings-mute";
        mute.textContent = "Mute";
        mute.setAttribute("aria-label", "Mute " + sliderLabel.toLowerCase() + " from " + participantDisplayName);
        sectionHeader.append(label, mute);
      } else {
        sectionHeader.append(label);
      }
      var sliderRow = document.createElement("div");
      sliderRow.className = "participant-settings-slider-row";
      var slider = document.createElement("input");
      slider.type = "range";
      slider.min = min;
      slider.max = max;
      slider.step = step;
      slider.value = value;
      slider.setAttribute("aria-label", sliderLabel + " for " + participantDisplayName);
      var pct = document.createElement("span");
      pct.className = "vol-pct";
      pct.textContent = Math.round(Number(value) * 100) + "%";
      sliderRow.append(slider, pct);
      section.append(sectionHeader, sliderRow);
      return { section: section, slider: slider, pct: pct, mute: mute };
    }

    var settingsMic = createParticipantSettingsSection(
      "Voice", "Microphone volume", "0", "3", "0.01", micSlider.value, true
    );
    settingsMicSlider = settingsMic.slider;
    settingsMicPct = settingsMic.pct;
    settingsMicMute = settingsMic.mute;
    settingsMicMute.setAttribute("aria-label", "Mute microphone audio from " + participantDisplayName);
    var settingsScreen = createParticipantSettingsSection(
      "Shared audio", "Screen volume", "0", "3", "0.01", screenSlider.value, true
    );
    settingsScreenSlider = settingsScreen.slider;
    settingsScreenPct = settingsScreen.pct;
    settingsScreenMute = settingsScreen.mute;
    settingsScreenMute.setAttribute("aria-label", "Mute screen audio from " + participantDisplayName);
    var settingsChime = createParticipantSettingsSection(
      "Join chime", "Chime volume", "0", "1", "0.01", chimeSlider.value, false
    );
    settingsChimeSlider = settingsChime.slider;
    settingsChimePct = settingsChime.pct;

    settingsWatchButton = document.createElement("button");
    settingsWatchButton.type = "button";
    settingsWatchButton.className = "participant-settings-watch hidden";
    settingsWatchButton.textContent = watchToggleBtn.textContent;
    settingsWatchButton.addEventListener("click", function(event) {
      event.stopPropagation();
      watchToggleBtn.click();
    });
    function syncSettingsWatchButton() {
      settingsWatchButton.textContent = watchToggleBtn.textContent;
      settingsWatchButton.classList.toggle("hidden", watchToggleBtn.style.display === "none");
    }
    if (typeof MutationObserver !== "undefined") {
      new MutationObserver(syncSettingsWatchButton).observe(watchToggleBtn, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    }
    syncSettingsWatchButton();

    var settingsFooter = document.createElement("div");
    settingsFooter.className = "participant-settings-footer";
    settingsFooter.append(settingsWatchButton);
    if (isAdminMode()) {
      var settingsServerMute = document.createElement("button");
      settingsServerMute.type = "button";
      settingsServerMute.textContent = "Server mute";
      settingsServerMute.addEventListener("click", function() {
        adminMuteParticipant(participant.identity);
      });
      var settingsKick = document.createElement("button");
      settingsKick.type = "button";
      settingsKick.className = "danger";
      settingsKick.textContent = "Remove";
      settingsKick.addEventListener("click", function() {
        adminKickParticipant(participant.identity);
      });
      settingsFooter.append(settingsServerMute, settingsKick);
    }

    participantSettingsPopup.append(
      settingsHeading,
      settingsMic.section,
      settingsScreen.section,
      settingsChime.section,
      settingsFooter
    );
    participantSettingsButton.addEventListener("click", function(event) {
      event.stopPropagation();
      toggleParticipantSettings(participantSettingsButton, participantSettingsPopup);
    });
  }
  header.append(avatar, meta);
  card.append(header);
  if (participantSettingsButton && participantSettingsPopup) {
    card.append(participantSettingsButton, participantSettingsPopup);
  }

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
    micControl.setAttribute("aria-label", "Toggle microphone");
    micControl.addEventListener("click", () => toggleMic().catch(() => {}));
    const camControl = document.createElement("button");
    camControl.type = "button";
    camControl.className = "icon-button";
    camControl.innerHTML = iconSvg("camera");
    camControl.setAttribute("aria-label", "Toggle camera");
    camControl.addEventListener("click", () => toggleCam().catch(() => {}));
    const screenControl = document.createElement("button");
    screenControl.type = "button";
    screenControl.className = "icon-button";
    screenControl.innerHTML = iconSvg("screen");
    screenControl.setAttribute("aria-label", "Toggle screen share");
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

  const initialMicState = getParticipantMicrophonePublicationState(participant);
  const state = {
    cameraTrackSid: null,
    screenTrackSid: null,
    micSid: null,
    screenAudioSid: null,
    micMuted: initialMicState.muted,
    micPublished: initialMicState.published,
    micPublisherMuted: initialMicState.muted,
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
    micMuteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      state.micUserMuted = !state.micUserMuted;
      micMuteButton.textContent = state.micUserMuted ? "Unmute" : "Mute";
      micMuteButton.setAttribute("aria-label", (state.micUserMuted ? "Unmute" : "Mute") + " microphone audio from " + participantDisplayName);
      micMuteButton.classList.toggle("is-muted", state.micUserMuted);
      // Sync overlay mute button
      if (ovMicMute) {
        ovMicMute.textContent = state.micUserMuted ? "Unmute" : "Mute";
        ovMicMute.setAttribute("aria-label", (state.micUserMuted ? "Unmute" : "Mute") + " microphone audio from " + participantDisplayName);
        ovMicMute.classList.toggle("is-muted", state.micUserMuted);
      }
      if (settingsMicMute) {
        settingsMicMute.textContent = state.micUserMuted ? "Unmute" : "Mute";
        settingsMicMute.setAttribute("aria-label", (state.micUserMuted ? "Unmute" : "Mute") + " microphone audio from " + participantDisplayName);
        settingsMicMute.classList.toggle("is-muted", state.micUserMuted);
      }
      applyParticipantAudioVolumes(state);
      updateActiveSpeakerUi();
    });
  }
  if (screenMuteButton) {
    screenMuteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      state.screenUserMuted = !state.screenUserMuted;
      screenMuteButton.textContent = state.screenUserMuted ? "Unmute" : "Mute";
      screenMuteButton.setAttribute("aria-label", (state.screenUserMuted ? "Unmute" : "Mute") + " screen audio from " + participantDisplayName);
      screenMuteButton.classList.toggle("is-muted", state.screenUserMuted);
      // Sync overlay mute button
      if (ovScreenMute) {
        ovScreenMute.textContent = state.screenUserMuted ? "Unmute" : "Mute";
        ovScreenMute.setAttribute("aria-label", (state.screenUserMuted ? "Unmute" : "Mute") + " screen audio from " + participantDisplayName);
        ovScreenMute.classList.toggle("is-muted", state.screenUserMuted);
      }
      if (settingsScreenMute) {
        settingsScreenMute.textContent = state.screenUserMuted ? "Unmute" : "Mute";
        settingsScreenMute.setAttribute("aria-label", (state.screenUserMuted ? "Unmute" : "Mute") + " screen audio from " + participantDisplayName);
        settingsScreenMute.classList.toggle("is-muted", state.screenUserMuted);
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
      if (settingsMicSlider) settingsMicSlider.value = state.micVolume;
      if (settingsMicPct) { settingsMicPct.textContent = Math.round(state.micVolume * 100) + "%"; settingsMicPct.classList.toggle("boosted", state.micVolume > 1); }
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
      if (settingsScreenSlider) settingsScreenSlider.value = state.screenVolume;
      if (settingsScreenPct) { settingsScreenPct.textContent = Math.round(state.screenVolume * 100) + "%"; settingsScreenPct.classList.toggle("boosted", state.screenVolume > 1); }
      applyParticipantAudioVolumes(state);
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
    });
  }
  if (chimeSlider) {
    chimeSlider.addEventListener("input", () => {
      state.chimeVolume = Number(chimeSlider.value);
      if (chimePct) chimePct.textContent = Math.round(state.chimeVolume * 100) + "%";
      if (popChimeSlider) popChimeSlider.value = state.chimeVolume;
      if (popChimePct) popChimePct.textContent = Math.round(state.chimeVolume * 100) + "%";
      if (settingsChimeSlider) settingsChimeSlider.value = state.chimeVolume;
      if (settingsChimePct) settingsChimePct.textContent = Math.round(state.chimeVolume * 100) + "%";
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
    });
  }
  if (settingsMicMute) {
    settingsMicMute.addEventListener("click", function(event) {
      event.stopPropagation();
      micMuteButton.click();
    });
  }
  if (settingsScreenMute) {
    settingsScreenMute.addEventListener("click", function(event) {
      event.stopPropagation();
      screenMuteButton.click();
    });
  }
  if (settingsMicSlider) {
    settingsMicSlider.addEventListener("input", function() {
      var val = Number(settingsMicSlider.value);
      state.micVolume = val;
      if (micSlider) micSlider.value = val;
      if (popMicSlider) popMicSlider.value = val;
      var pctText = Math.round(val * 100) + "%";
      if (settingsMicPct) { settingsMicPct.textContent = pctText; settingsMicPct.classList.toggle("boosted", val > 1); }
      if (micPct) { micPct.textContent = pctText; micPct.classList.toggle("boosted", val > 1); }
      if (popMicPct) { popMicPct.textContent = pctText; popMicPct.classList.toggle("boosted", val > 1); }
      applyParticipantAudioVolumes(state);
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
    });
  }
  if (settingsScreenSlider) {
    settingsScreenSlider.addEventListener("input", function() {
      var val = Number(settingsScreenSlider.value);
      state.screenVolume = val;
      if (screenSlider) screenSlider.value = val;
      if (popScreenSlider) popScreenSlider.value = val;
      var pctText = Math.round(val * 100) + "%";
      if (settingsScreenPct) { settingsScreenPct.textContent = pctText; settingsScreenPct.classList.toggle("boosted", val > 1); }
      if (screenPct) { screenPct.textContent = pctText; screenPct.classList.toggle("boosted", val > 1); }
      if (popScreenPct) { popScreenPct.textContent = pctText; popScreenPct.classList.toggle("boosted", val > 1); }
      applyParticipantAudioVolumes(state);
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
    });
  }
  if (settingsChimeSlider) {
    settingsChimeSlider.addEventListener("input", function() {
      var val = Number(settingsChimeSlider.value);
      state.chimeVolume = val;
      if (chimeSlider) chimeSlider.value = val;
      if (popChimeSlider) popChimeSlider.value = val;
      var pctText = Math.round(val * 100) + "%";
      if (settingsChimePct) settingsChimePct.textContent = pctText;
      if (chimePct) chimePct.textContent = pctText;
      if (popChimePct) popChimePct.textContent = pctText;
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
      if (settingsMicSlider) settingsMicSlider.value = val;
      if (settingsMicPct) { settingsMicPct.textContent = pctText; settingsMicPct.classList.toggle("boosted", val > 1); }
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
      if (settingsScreenSlider) settingsScreenSlider.value = val;
      if (settingsScreenPct) { settingsScreenPct.textContent = pctText; settingsScreenPct.classList.toggle("boosted", val > 1); }
      applyParticipantAudioVolumes(state);
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
    });
  }
  if (popChimeSlider) {
    popChimeSlider.addEventListener("input", function() {
      var val = Number(popChimeSlider.value);
      state.chimeVolume = val;
      if (chimeSlider) chimeSlider.value = val;
      var pctText = Math.round(val * 100) + "%";
      if (popChimePct) popChimePct.textContent = pctText;
      if (chimePct) chimePct.textContent = pctText;
      if (settingsChimeSlider) settingsChimeSlider.value = val;
      if (settingsChimePct) settingsChimePct.textContent = pctText;
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
        if (settingsMicSlider) settingsMicSlider.value = savedVol.mic;
        if (settingsMicPct) { settingsMicPct.textContent = Math.round(savedVol.mic * 100) + "%"; settingsMicPct.classList.toggle("boosted", savedVol.mic > 1); }
      }
      if (savedVol.screen != null && screenSlider) {
        state.screenVolume = savedVol.screen;
        screenSlider.value = savedVol.screen;
        if (screenPct) screenPct.textContent = Math.round(savedVol.screen * 100) + "%";
        if (screenPct) screenPct.classList.toggle("boosted", savedVol.screen > 1);
        // Sync popup slider
        if (popScreenSlider) popScreenSlider.value = savedVol.screen;
        if (popScreenPct) { popScreenPct.textContent = Math.round(savedVol.screen * 100) + "%"; popScreenPct.classList.toggle("boosted", savedVol.screen > 1); }
        if (settingsScreenSlider) settingsScreenSlider.value = savedVol.screen;
        if (settingsScreenPct) { settingsScreenPct.textContent = Math.round(savedVol.screen * 100) + "%"; settingsScreenPct.classList.toggle("boosted", savedVol.screen > 1); }
      }
      if (savedVol.chime != null && chimeSlider) {
        state.chimeVolume = savedVol.chime;
        chimeSlider.value = savedVol.chime;
        if (chimePct) chimePct.textContent = Math.round(savedVol.chime * 100) + "%";
        if (popChimeSlider) popChimeSlider.value = savedVol.chime;
        if (popChimePct) popChimePct.textContent = Math.round(savedVol.chime * 100) + "%";
        if (settingsChimeSlider) settingsChimeSlider.value = savedVol.chime;
        if (settingsChimePct) settingsChimePct.textContent = Math.round(savedVol.chime * 100) + "%";
      }
      applyParticipantAudioVolumes(state);
      debugLog("[vol-prefs] restored " + key + " mic=" + (savedVol.mic || 1) + " screen=" + (savedVol.screen || 1) + " chime=" + (savedVol.chime != null ? savedVol.chime : 0.5));
    }
  }

  function setParticipantDisplayName(nextName) {
    participantDisplayName = nextName || "Guest";
    title.textContent = participantDisplayName;
    title.title = participantDisplayName;

    if (overlayName) {
      overlayName.textContent = participantDisplayName;
      overlayName.title = participantDisplayName;
    }
    if (micIndicator) micIndicator.setAttribute("aria-label", "Microphone audio settings for " + participantDisplayName);
    if (screenIndicator) screenIndicator.setAttribute("aria-label", "Screen audio settings for " + participantDisplayName);
    if (micSlider) micSlider.setAttribute("aria-label", "Microphone volume for " + participantDisplayName);
    if (screenSlider) screenSlider.setAttribute("aria-label", "Screen volume for " + participantDisplayName);
    if (chimeSlider) chimeSlider.setAttribute("aria-label", "Chime volume for " + participantDisplayName);
    if (ovMicBtn) ovMicBtn.setAttribute("aria-label", "Microphone volume for " + participantDisplayName);
    if (ovScreenBtn) ovScreenBtn.setAttribute("aria-label", "Screen volume for " + participantDisplayName);
    if (popMicSlider) popMicSlider.setAttribute("aria-label", "Microphone volume for " + participantDisplayName);
    if (popScreenSlider) popScreenSlider.setAttribute("aria-label", "Screen volume for " + participantDisplayName);
    if (popChimeSlider) popChimeSlider.setAttribute("aria-label", "Chime volume for " + participantDisplayName);

    var micAction = state.micUserMuted ? "Unmute" : "Mute";
    var screenAction = state.screenUserMuted ? "Unmute" : "Mute";
    [micMuteButton, ovMicMute, settingsMicMute].forEach(function(button) {
      if (button) button.setAttribute("aria-label", micAction + " microphone audio from " + participantDisplayName);
    });
    [screenMuteButton, ovScreenMute, settingsScreenMute].forEach(function(button) {
      if (button) button.setAttribute("aria-label", screenAction + " screen audio from " + participantDisplayName);
    });

    if (participantSettingsButton) {
      participantSettingsButton.setAttribute("aria-label", "Audio settings for " + participantDisplayName);
      participantSettingsButton.title = "Audio settings for " + participantDisplayName;
    }
    if (participantSettingsPopup) participantSettingsPopup.setAttribute("aria-label", "Audio settings for " + participantDisplayName);
    if (settingsHeadingTitle) settingsHeadingTitle.textContent = participantDisplayName;
    if (settingsClose) settingsClose.setAttribute("aria-label", "Close audio settings for " + participantDisplayName);
    if (settingsMicSlider) settingsMicSlider.setAttribute("aria-label", "Microphone volume for " + participantDisplayName);
    if (settingsScreenSlider) settingsScreenSlider.setAttribute("aria-label", "Screen volume for " + participantDisplayName);
    if (settingsChimeSlider) settingsChimeSlider.setAttribute("aria-label", "Chime volume for " + participantDisplayName);
    if (publisherMicState) {
      publisherMicState.setAttribute(
        "aria-label",
        (publisherMicStateLabel?.textContent || "Mic off") + " for " + participantDisplayName
      );
    }
  }

  participantCards.set(key, {
    card,
    avatar,
    isLocal,
    controls,
    micStatusEl,
    publisherMicStateEl: publisherMicState,
    publisherMicStateLabel,
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
    popScreenPct,
    popChimeSlider,
    popChimePct,
    participantSettingsButton,
    participantSettingsPopup,
    settingsMicMute,
    settingsScreenMute,
    settingsMicSlider,
    settingsScreenSlider,
    settingsChimeSlider,
    settingsWatchButton,
    setParticipantDisplayName
  });
  participantState.set(key, state);
  debugLog(`participant card created and added to DOM for ${key}, card.isConnected=${card.isConnected}, avatar exists=${!!avatar}`);
  // Show avatar image if one exists for this user
  updateAvatarDisplay(key);
  return participantCards.get(key);
}

// ── Avatar ──

function updateAvatarVideo(cardRef, track) {
  if (!cardRef || !cardRef.avatar) {
    debugLog("ERROR: updateAvatarVideo called with invalid cardRef or avatar! cardRef=" + !!cardRef + ", avatar=" + !!cardRef?.avatar);
    return;
  }
  var avatar = cardRef.avatar;
  var card = cardRef.card;
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
    // Camera-on participants always use the same prominent camera-first card.
    if (card) card.classList.add("has-camera");
    if (cardRef.isLocal) avatar.title = "Click to view camera fullscreen";
  } else {
    avatar.textContent = getInitials(card?.querySelector(".user-name")?.textContent || "");
    if (fileInput) avatar.appendChild(fileInput);
    // Show avatar image if one exists (replaces initials)
    var identity = card?.dataset?.identity;
    if (identity) updateAvatarDisplay(identity);
    // Camera-off participants return to the compact avatar card.
    if (card) card.classList.remove("has-camera");
    if (cardRef.isLocal) avatar.title = "Click to upload avatar";
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

function getServerAvatarCandidateUrls(identity, cardRef) {
  if (typeof apiUrl !== "function") return [];
  const identityBase = getIdentityBase(identity);
  const candidates = [];
  const seen = new Set();

  function addCandidate(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(apiUrl("/api/avatar/" + encodeURIComponent(trimmed)));
  }

  const deviceId = deviceIdByIdentity?.get?.(identityBase);
  addCandidate(deviceId);
  addCandidate(identityBase);

  const label = cardRef?.card?.querySelector(".user-name")?.textContent || "";
  if (typeof slugifyIdentity === "function") addCandidate(slugifyIdentity(label));

  return candidates;
}

function showAvatarImage(cardRef, urls) {
  const avatar = cardRef.avatar;
  if (!avatar || !urls || urls.length === 0) return;
  const requestId = (avatar._avatarRequestId || 0) + 1;
  avatar._avatarRequestId = requestId;

  let img = avatar.querySelector("img.avatar-img");
  if (!img) {
    img = document.createElement("img");
    img.className = "avatar-img";
    img.alt = "Avatar";
    avatar.appendChild(img);
  }

  function commitLoadedAvatar(url) {
    if (avatar._avatarRequestId !== requestId) return;
    img.src = url;
    const textNodes = Array.from(avatar.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
    textNodes.forEach(n => n.remove());
  }

  function failAllCandidates() {
    if (avatar._avatarRequestId !== requestId) return;
    if (!img.src && typeof img.remove === "function") img.remove();
  }

  function tryCandidate(index) {
    if (avatar._avatarRequestId !== requestId) return;
    if (index >= urls.length) {
      failAllCandidates();
      return;
    }
    const loader = new Image();
    loader.onload = function() {
      commitLoadedAvatar(urls[index]);
    };
    loader.onerror = function() {
      tryCandidate(index + 1);
    };
    loader.src = urls[index];
  }

  tryCandidate(0);
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
    showAvatarImage(cardRef, [avatarUrl]);
    return;
  }

  const serverUrls = getServerAvatarCandidateUrls(identity, cardRef);
  if (serverUrls.length > 0) {
    showAvatarImage(cardRef, serverUrls);
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
