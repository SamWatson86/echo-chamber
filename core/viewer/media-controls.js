/* =========================================================
   MEDIA CONTROLS — Device management, mic/cam/screen toggles, camera lobby
   ========================================================= */

function setSelectOptions(select, items, placeholder) {
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.appendChild(empty);
  const kindLabels = { audioinput: "Microphone", videoinput: "Camera", audiooutput: "Speaker" };
  items.forEach((item, i) => {
    const option = document.createElement("option");
    option.value = item.deviceId;
    option.textContent = item.label || `${kindLabels[item.kind] || item.kind} ${i + 1}`;
    select.appendChild(option);
  });
}

async function ensureDevicePermissions() {
  let gotAudio = false;
  let gotVideo = false;

  // Request audio and video separately so one failing doesn't block the other.
  // macOS WKWebView (Tauri on Mac) can reject combined requests if either
  // device type is unavailable or permission is denied.
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioStream.getTracks().forEach((t) => t.stop());
    gotAudio = true;
  } catch (err) {
    debugLog("[devices] audio permission denied or unavailable: " + err.message);
  }

  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
    videoStream.getTracks().forEach((t) => t.stop());
    gotVideo = true;
  } catch (err) {
    debugLog("[devices] video permission denied or unavailable: " + err.message);
  }

  if (!gotAudio && !gotVideo) {
    setDeviceStatus("Device permissions denied or no devices found.", true);
    return false;
  }
  if (!gotAudio) {
    setDeviceStatus("Microphone unavailable — check permissions or connection.");
  } else if (!gotVideo) {
    setDeviceStatus("Camera unavailable — audio devices loaded.");
  }
  return true;
}

async function refreshDevices() {
  if (!window.isSecureContext) {
    setDeviceStatus("Device access requires HTTPS or localhost.", true);
    return;
  }
  if (!navigator.mediaDevices?.enumerateDevices) {
    setDeviceStatus("Device enumeration not supported.", true);
    return;
  }
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    setDeviceStatus("Unable to enumerate devices. Check browser permissions.", true);
    return;
  }
  const mics = devices.filter((d) => d.kind === "audioinput");
  const cams = devices.filter((d) => d.kind === "videoinput");
  const speakers = devices.filter((d) => d.kind === "audiooutput");

  // Detect macOS permission-denied scenario: devices exist but all have empty labels
  const allLabelsEmpty = devices.length > 0 && devices.every((d) => !d.label);
  if (allLabelsEmpty) {
    debugLog("[devices] enumerateDevices returned " + devices.length + " devices but all labels are empty (permissions not granted)");
  }

  setSelectOptions(micSelect, mics, "Default mic");
  setSelectOptions(camSelect, cams, "Default camera");
  setSelectOptions(speakerSelect, speakers, "Default output");
  // Restore saved device selections from localStorage if not already set
  if (!selectedMicId) {
    selectedMicId = echoGet("echo-device-mic") || "";
  }
  if (!selectedCamId) {
    selectedCamId = echoGet("echo-device-cam") || "";
  }
  if (!selectedSpeakerId) {
    selectedSpeakerId = echoGet("echo-device-speaker") || "";
  }
  // Apply selections — only if the saved device still exists in the dropdown
  if (selectedMicId) {
    const opt = Array.from(micSelect.options).find(o => o.value === selectedMicId);
    if (opt) micSelect.value = selectedMicId;
    else selectedMicId = "";
  }
  if (selectedCamId) {
    const opt = Array.from(camSelect.options).find(o => o.value === selectedCamId);
    if (opt) camSelect.value = selectedCamId;
    else selectedCamId = "";
  }
  if (selectedSpeakerId) {
    const opt = Array.from(speakerSelect.options).find(o => o.value === selectedSpeakerId);
    if (opt) speakerSelect.value = selectedSpeakerId;
    else selectedSpeakerId = "";
  }
  if (allLabelsEmpty) {
    setDeviceStatus("Devices detected but permissions not granted. On Mac: System Settings → Privacy & Security → Microphone/Camera, then restart the app.", true);
  } else if (!mics.length && !cams.length) {
    setDeviceStatus("No audio or video devices found. Check permissions.");
  } else if (!mics.length) {
    setDeviceStatus("No microphones found — check permissions or connection.");
  } else if (!cams.length) {
    // Camera-less is common (e.g. desktops without webcam) — not an error
    setDeviceStatus("");
  } else {
    setDeviceStatus("");
  }
}

async function applySpeakerToMedia() {
  const audioEls = audioBucketEl.querySelectorAll("audio");
  if (selectedSpeakerId) {
    audioEls.forEach((el) => {
      if (typeof el.setSinkId === "function") {
        el.setSinkId(selectedSpeakerId).catch(() => {});
      }
    });
  }
  // Route participant volume-boost AudioContext to selected speaker
  if (_participantAudioCtx && typeof _participantAudioCtx.setSinkId === "function") {
    var sinkId = selectedSpeakerId && selectedSpeakerId.length > 0 ? selectedSpeakerId : "default";
    try { await _participantAudioCtx.setSinkId(sinkId); } catch {}
  }
  if (soundboardContext) {
    await applySoundboardOutputDevice();
  }
}

function resumeAnalyser(analyserObj) {
  try {
    const ctx = analyserObj?.analyser?.context;
    if (ctx && typeof ctx.resume === "function" && ctx.state !== "running") {
      ctx.resume().catch(() => {});
    }
  } catch {}
}

async function switchMic(deviceId) {
  selectedMicId = deviceId || "";
  echoSet("echo-device-mic", selectedMicId);
  if (!room || !micEnabled) return;
  // Tear down existing noise cancellation before switching
  disableNoiseCancellation();
  await room.localParticipant.setMicrophoneEnabled(true, { deviceId: selectedMicId || undefined });
  // Re-apply noise cancellation to new mic track
  if (noiseCancelEnabled) {
    try { await enableNoiseCancellation(); } catch (e) {
      debugLog("[noise-cancel] Could not re-apply after mic switch: " + (e.message || e));
    }
  }
}

async function switchCam(deviceId) {
  selectedCamId = deviceId || "";
  echoSet("echo-device-cam", selectedCamId);
  if (!room || !camEnabled) return;
  await room.localParticipant.setCameraEnabled(true, { deviceId: selectedCamId || undefined });
}

async function switchSpeaker(deviceId) {
  selectedSpeakerId = deviceId || "";
  echoSet("echo-device-speaker", selectedSpeakerId);
  await applySpeakerToMedia();
}

// Camera Lobby Management
let enlargedCameraTile = null;

function openCameraLobby() {
  if (!cameraLobbyPanel) return;
  cameraLobbyPanel.classList.remove("hidden");
  populateCameraLobby();
  debugLog('Camera Lobby opened');
}

function closeCameraLobby() {
  if (!cameraLobbyPanel) return;
  cameraLobbyPanel.classList.add("hidden");
  enlargedCameraTile = null;
  debugLog('Camera Lobby closed');
}

function populateCameraLobby() {
  if (!cameraLobbyGrid || !room) return;

  cameraLobbyGrid.innerHTML = '';

  const allParticipants = [room.localParticipant, ...Array.from(room.remoteParticipants.values())];
  let count = 0;

  allParticipants.forEach(participant => {
    const tile = createCameraTile(participant);
    if (tile) {
      cameraLobbyGrid.appendChild(tile);
      count++;
    }
  });

  cameraLobbyGrid.dataset.count = Math.min(count, 6);
}

function createCameraTile(participant) {
  if (!participant) return null;

  const tile = document.createElement('div');
  tile.className = 'camera-lobby-tile';
  tile.dataset.identity = participant.identity;

  // Get camera track if available
  const LK = getLiveKitClient();
  const cameraPublication = Array.from(participant.trackPublications.values()).find(
    pub => pub.source === LK.Track.Source.Camera && pub.kind === LK.Track.Kind.Video
  );

  const cameraTrack = cameraPublication?.track;

  // Only create tile if participant has an active camera
  if (!cameraTrack || !cameraTrack.mediaStreamTrack) {
    return null;
  }

  // Create video element for camera
  const video = createLockedVideoElement(cameraTrack);
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'contain';
  configureVideoElement(video, true);
  startBasicVideoMonitor(video);
  tile.appendChild(video);

  // Add name label
  const nameLabel = document.createElement('div');
  nameLabel.className = 'name-label';
  nameLabel.textContent = participant.name || participant.identity;
  if (participant === room.localParticipant) {
    nameLabel.textContent += ' (You)';
  }
  tile.appendChild(nameLabel);

  // Add click to enlarge functionality
  tile.addEventListener('click', () => toggleEnlargeTile(tile));

  return tile;
}

function toggleEnlargeTile(tile) {
  if (!tile) return;

  if (enlargedCameraTile === tile) {
    // Un-enlarge
    tile.classList.remove('enlarged');
    enlargedCameraTile = null;
  } else {
    // Enlarge this tile, un-enlarge any other
    if (enlargedCameraTile) {
      enlargedCameraTile.classList.remove('enlarged');
    }
    tile.classList.add('enlarged');
    enlargedCameraTile = tile;
  }
}

function updateCameraLobbySpeakingIndicators() {
  if (!cameraLobbyGrid || cameraLobbyPanel.classList.contains('hidden')) return;

  const tiles = cameraLobbyGrid.querySelectorAll('.camera-lobby-tile');
  tiles.forEach(tile => {
    const identity = tile.dataset.identity;
    if (!identity) return;

    const state = participantState.get(identity);
    const isSpeaking = state?.micActive || false;

    if (isSpeaking) {
      tile.classList.add('speaking');
    } else {
      tile.classList.remove('speaking');
    }
  });
}

// --- Media Toggles ---

async function toggleMic() {
  if (!room) return;
  const desired = !micEnabled;
  micBtn.disabled = true;
  try {
    await room.localParticipant.setMicrophoneEnabled(desired, {
      deviceId: selectedMicId || undefined,
    });
    micEnabled = desired;

    // Apply or remove noise cancellation
    if (desired && noiseCancelEnabled) {
      try { await enableNoiseCancellation(); } catch (e) {
        debugLog("[noise-cancel] Could not enable on mic toggle: " + (e.message || e));
      }
    } else if (!desired) {
      disableNoiseCancellation();
    }

    renderPublishButtons();
    if (room?.localParticipant) {
      const cardRef = ensureParticipantCard(room.localParticipant, true);
      if (cardRef.controls) {
        cardRef.controls.querySelectorAll(".icon-button")[0]?.classList.toggle("is-on", micEnabled);
      }
    }
    updateActiveSpeakerUi();
  } catch (err) {
    debugLog("[mic] toggle error: " + (err.message || err) + " (name=" + err.name + ")");
    // Provide actionable error messages for common Mac issues
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      setStatus("Mic permission denied — grant access in System Settings > Privacy > Microphone", true);
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      setStatus("No microphone found — check your audio input device", true);
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      setStatus("Mic is in use by another app or unavailable", true);
    } else {
      setStatus(err.message || "Mic failed", true);
    }
  } finally {
    micBtn.disabled = false;
  }
}


async function toggleCam() {
  if (!room) return;
  const desired = !camEnabled;
  camBtn.disabled = true;
  try {
    await room.localParticipant.setCameraEnabled(desired, {
      deviceId: selectedCamId || undefined,
    });
    camEnabled = desired;
    renderPublishButtons();
    if (room?.localParticipant) {
      const cardRef = ensureParticipantCard(room.localParticipant, true);
      if (!camEnabled) {
        updateAvatarVideo(cardRef, null);
      } else {
        const pubs = getParticipantPublications(room.localParticipant);
        const camPub = pubs.find((p) => p?.source === getLiveKitClient()?.Track?.Source?.Camera && p.track);
        if (camPub?.track) {
          updateAvatarVideo(cardRef, camPub.track);
          const video = cardRef.avatar?.querySelector("video");
          if (video) ensureVideoPlays(camPub.track, video);
        }
      }
      if (cardRef.controls) {
        cardRef.controls.querySelectorAll(".icon-button")[1]?.classList.toggle("is-on", camEnabled);
      }
    }
  } catch (err) {
    debugLog("[cam] toggle error: " + (err.message || err) + " (name=" + err.name + ")");
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      setStatus("Camera permission denied — grant access in System Settings > Privacy > Camera", true);
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      setStatus("No camera found", true);
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      setStatus("Camera is in use by another app or unavailable", true);
    } else {
      setStatus(err.message || "Camera failed", true);
    }
  } finally {
    camBtn.disabled = false;
  }
}

async function toggleScreen() {
  if (!room) return;
  const desired = !screenEnabled;
  screenBtn.disabled = true;
  try {
    if (desired) {
      await startScreenShareManual();
    } else {
      await stopScreenShareManual();
    }
    screenEnabled = desired;
    renderPublishButtons();
    if (room?.localParticipant) {
      const cardRef = ensureParticipantCard(room.localParticipant, true);
      if (cardRef.controls) {
        cardRef.controls.querySelectorAll(".icon-button")[2]?.classList.toggle("is-on", screenEnabled);
      }
    }
  } catch (err) {
    setStatus(err.message || "Screen share failed", true);
  } finally {
    screenBtn.disabled = false;
  }
}

async function restartScreenShare() {
  if (!room || !screenEnabled || screenRestarting) return;
  screenRestarting = true;
  try {
    await stopScreenShareManual();
    screenEnabled = false;
    renderPublishButtons();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await startScreenShareManual();
    screenEnabled = true;
    renderPublishButtons();
  } catch (err) {
    setStatus(err.message || "Screen restart failed", true);
  } finally {
    screenRestarting = false;
  }
}

async function enableAllMedia() {
  if (!room) return;
  await toggleMicOn();
  await toggleCamOn();
  await toggleScreenOn();
}

async function toggleMicOn() {
  if (micEnabled) return;
  await toggleMic();
}

async function toggleCamOn() {
  if (camEnabled) return;
  await toggleCam();
}

async function toggleScreenOn() {
  if (screenEnabled) return;
  await toggleScreen();
}
