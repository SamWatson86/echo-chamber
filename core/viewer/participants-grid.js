/* =========================================================
   PARTICIPANTS-GRID — Screen tile grid: create, remove, focus
   ========================================================= */

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

  // Poster overlay: hide uninitialized GPU garbage (green/black flash) until first real frame.
  // Uses a dark cover that fades out once the video has decoded data.
  var poster = document.createElement("div");
  poster.className = "tile-poster";
  tile.appendChild(poster);
  var removePoster = function() {
    poster.classList.add("fade-out");
    setTimeout(function() { poster.remove(); }, 400);
  };
  // loadeddata fires when the first frame is available for rendering
  element.addEventListener("loadeddata", removePoster, { once: true });
  // Safety fallback: remove after 5s even if event never fires
  setTimeout(function() {
    if (poster.parentNode) removePoster();
  }, 5000);

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

  // Volume slider — shown on hover when tile has audio
  var volWrap = document.createElement("div");
  volWrap.className = "tile-volume-wrap hidden";
  var volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.className = "tile-volume-slider";
  volSlider.min = "0";
  volSlider.max = "3";
  volSlider.step = "0.01";
  volSlider.value = "1";
  volSlider.title = "Screen volume";
  volSlider.addEventListener("click", function(e) { e.stopPropagation(); });
  volSlider.addEventListener("pointerdown", function(e) { e.stopPropagation(); });
  volSlider.addEventListener("input", function(e) {
    e.stopPropagation();
    var identity = tile.dataset.identity;
    if (!identity) return;
    var state = participantState.get(identity);
    if (!state) return;
    state.screenVolume = Number(volSlider.value);
    applyParticipantAudioVolumes(state);
    saveParticipantVolume(identity, state.micVolume, state.screenVolume, state.chimeVolume);
    // Sync the participant card slider
    var cardRef = participantCards.get(identity);
    if (cardRef?.screenSlider) {
      cardRef.screenSlider.value = state.screenVolume;
      if (cardRef.screenPct) cardRef.screenPct.textContent = Math.round(state.screenVolume * 100) + "%";
    }
    if (cardRef?.popScreenSlider) {
      cardRef.popScreenSlider.value = state.screenVolume;
      if (cardRef.popScreenPct) cardRef.popScreenPct.textContent = Math.round(state.screenVolume * 100) + "%";
    }
  });
  volWrap.appendChild(volSlider);
  tile.appendChild(volWrap);
  tile._volWrap = volWrap;
  tile._volSlider = volSlider;

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
        tile.classList.toggle("portrait", ratio < 1.0);
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
