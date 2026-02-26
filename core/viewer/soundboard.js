/* =========================================================
   SOUNDBOARD — Sound playback, management, drag-drop, and UI
   ========================================================= */

// ── Soundboard state vars that depend on echoGet ──
let soundboardUserVolume = Number(echoGet("echo-core-soundboard-volume") ?? "100");
if (!Number.isFinite(soundboardUserVolume)) soundboardUserVolume = 100;
soundboardUserVolume = Math.min(100, Math.max(0, soundboardUserVolume));
let soundboardClipVolume = Number(echoGet("echo-core-soundboard-clip-volume") ?? "100");
if (!Number.isFinite(soundboardClipVolume)) soundboardClipVolume = 100;
soundboardClipVolume = Math.min(200, Math.max(0, soundboardClipVolume));
let soundboardFavorites = (() => {
  try { return JSON.parse(echoGet("echo-soundboard-favorites")) || []; } catch { return []; }
})();
let soundboardCustomOrder = (() => {
  try { return JSON.parse(echoGet("echo-soundboard-order")) || []; } catch { return []; }
})();

// ── Icon constants ──
const SOUNDBOARD_ICONS = [
  "\u{1F973}",
  "\u{1F389}",
  "\u{1F38A}",
  "\u{1F44F}",
  "\u{1F64C}",
  "\u{1F929}",
  "\u{1F60E}",
  "\u{1F60D}",
  "\u{1F618}",
  "\u{1F61C}",
  "\u{1F917}",
  "\u{1F642}",
  "\u{1F610}",
  "\u{1F928}",
  "\u{1F914}",
  "\u{1F9D0}",
  "\u{1F92A}",
  "\u{1F92B}",
  "\u{1F602}",
  "\u{1F923}",
  "\u{1F62D}",
  "\u{1F92F}",
  "\u{1F631}",
  "\u{1F621}",
  "\u{1F92C}",
  "\u{1F4A9}",
  "\u{1F4A5}",
  "\u{1F525}",
  "\u2728",
  "\u26A1",
  "\u{1F387}",
  "\u{1F386}",
  "\u{1F4A8}",
  "\u{1F31F}",
  "\u{1F308}",
  "\u2600\uFE0F",
  "\u26C5",
  "\u{1F9E8}",
  "\u{1F6A8}",
  "\u{1F4E3}",
  "\u{1F4E2}",
  "\u{1F514}",
  "\u{1F515}",
  "\u{1F50A}",
  "\u{1F3B5}",
  "\u{1F3B6}",
  "\u{1F3BA}",
  "\u{1F3B8}",
  "\u{1F941}",
  "\u{1F3BB}",
  "\u{1F3A4}",
  "\u{1F3A7}",
  "\u{1F4FB}",
  "\u{1F399}\uFE0F",
  "\u{1F3AC}",
  "\u{1F3AE}",
  "\u{1F3B2}",
  "\u{1F3AF}",
  "\u{1F37F}",
  "\u{1F95E}",
  "\u{1F355}",
  "\u{1F354}",
  "\u{1F35F}",
  "\u{1F953}",
  "\u{1F96A}",
  "\u{1F32E}",
  "\u{1F36A}",
  "\u{1F369}",
  "\u{1F36D}",
  "\u{1F36F}",
  "\u{1F37A}",
  "\u{1F942}",
  "\u{1F379}",
  "\u{1F4B8}",
  "\u{1F4B0}",
  "\u{1F4AF}",
  "\u{1F4A1}",
  "\u{1F9E0}",
  "\u{1F52A}",
  "\u{1F9EF}",
  "\u{1F9F8}",
  "\u{1F4CD}",
  "\u{1F680}",
  "\u{1F6F8}",
  "\u{1F9A0}",
  "\u{1F984}",
  "\u{1F4A7}",
  "\u{1F525}",
  "\u{1F30A}",
  "\u{1F31D}",
  "\u{1F31A}",
  "\u{1F4AB}",
  "\u{1F4A2}",
  "\u{1F6A5}",
  "\u{1F6B2}",
  "\u{1F3C6}",
  "\u{1F3C0}",
  "\u{26BD}",
  "\u{1F3C8}",
  "\u{1F3BE}",
  "\u{1F3D2}",
  "\u{1F9B5}",
  "\u{1F3C1}",
  "\u{1F3AF}",
  "\u{1F3A8}",
  "\u{1F3A5}",
  "\u{1F50C}",
  "\u{1F4AC}",
  "\u{1F4F1}",
  "\u{1F4BB}",
  "\u{1F5A5}",
  "\u{1F5A8}",
  "\u{1F4E1}",
  "\u{1F4F7}",
  "\u{1F4F9}",
  "\u{1F58A}",
  "\u{1F4DD}",
  "\u{1F3AE}",
  "\u{1F48E}",
  "\u{1F451}",
  "\u{1F48D}"
];

if (!soundboardSelectedIcon) {
  soundboardSelectedIcon = SOUNDBOARD_ICONS[0] ?? "\u{1F50A}";
}

// ── UI helpers ──

function setSoundboardHint(text, isError = false) {
  if (!soundboardHint) return;
  soundboardHint.textContent = text ?? "";
  soundboardHint.classList.toggle("is-error", Boolean(isError));
}

function updateSoundboardEditControls() {
  if (!soundUploadButton || !soundCancelEditButton) return;
  const isEditing = Boolean(soundboardEditingId);
  soundUploadButton.textContent = isEditing ? "Save" : "Upload";
  soundCancelEditButton.classList.toggle("hidden", !isEditing);
  if (soundFileInput) {
    soundFileInput.disabled = isEditing;
  }
  if (soundFileLabel) {
    if (isEditing) {
      soundFileLabel.textContent = "Audio locked";
      soundFileLabel.title = "Audio cannot be changed after upload.";
    } else {
      const file = soundFileInput?.files?.[0];
      soundFileLabel.textContent = file ? "Change audio" : "Select audio";
      soundFileLabel.title = file?.name || "";
    }
  }
}

function updateSoundboardVolumeUi() {
  const vol = String(soundboardUserVolume);
  const pct = `${Math.round(soundboardUserVolume)}%`;
  if (soundboardVolumeInput) soundboardVolumeInput.value = vol;
  if (soundboardVolumeInputEdit) soundboardVolumeInputEdit.value = vol;
  if (soundboardVolumeValue) soundboardVolumeValue.textContent = pct;
  if (soundboardVolumeValueEdit) soundboardVolumeValueEdit.textContent = pct;
  updateSoundboardMasterGain();
}

function updateSoundClipVolumeUi(value) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric) ? Math.min(200, Math.max(0, numeric)) : 100;
  if (soundClipVolumeInput) {
    soundClipVolumeInput.value = String(normalized);
  }
  if (soundClipVolumeValue) {
    soundClipVolumeValue.textContent = `${Math.round(normalized)}%`;
  }
}

function updateSoundboardMasterGain() {
  if (!soundboardMasterGain) return;
  const base = roomAudioMuted ? 0 : soundboardUserVolume / 100;
  soundboardMasterGain.gain.value = Math.max(0, base);
}

async function applySoundboardOutputDevice() {
  if (!soundboardContext) return;
  const sinkId = selectedSpeakerId && selectedSpeakerId.length > 0 ? selectedSpeakerId : "default";
  if (typeof soundboardContext.setSinkId === "function") {
    try {
      await soundboardContext.setSinkId(sinkId);
    } catch {
      // ignore
    }
  }
}

// ── Audio playback ──

function getSoundboardContext() {
  if (soundboardContext && soundboardMasterGain) return soundboardContext;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  soundboardContext = new AudioCtx();
  soundboardMasterGain = soundboardContext.createGain();
  soundboardMasterGain.connect(soundboardContext.destination);
  updateSoundboardMasterGain();
  void applySoundboardOutputDevice();
  return soundboardContext;
}

function stopSoundboardPlayback() {
  if (!soundboardCurrentSource) return;
  try {
    soundboardCurrentSource.stop();
  } catch {
    // ignore
  }
  soundboardCurrentSource = null;
}

function primeSoundboardAudio() {
  const ctx = getSoundboardContext();
  if (!ctx) return;
  try {
    const p = ctx.resume();
    if (p && typeof p.catch === "function") {
      p.catch(() => {});
    }
  } catch {
    // ignore
  }
}

async function fetchSoundboardBuffer(soundId) {
  if (soundboardBufferCache.has(soundId)) {
    return soundboardBufferCache.get(soundId);
  }
  const ctx = getSoundboardContext();
  if (!ctx || !currentAccessToken) return null;
  const res = await fetch(apiUrl(`/api/soundboard/file/${encodeURIComponent(soundId)}`), {
    headers: {
      Authorization: `Bearer ${currentAccessToken}`,
      Accept: 'application/octet-stream'
    }
  });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const decoded = await ctx.decodeAudioData(buf.slice(0));
  soundboardBufferCache.set(soundId, decoded);
  return decoded;
}

async function playSoundboardSound(soundId) {
  const ctx = getSoundboardContext();
  if (!ctx || !soundboardMasterGain) return;
  const sound = soundboardSounds.get(soundId);
  if (!sound) return;
  const buffer = await fetchSoundboardBuffer(soundId);
  if (!buffer) {
    setSoundboardHint("Unable to play sound.", true);
    return;
  }
  stopSoundboardPlayback();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const clipGain = ctx.createGain();
  const clipVolume = Number.isFinite(sound.volume) ? sound.volume : 100;
  clipGain.gain.value = Math.max(0, clipVolume / 100);
  source.connect(clipGain);
  clipGain.connect(soundboardMasterGain);
  source.onended = () => {
    if (soundboardCurrentSource === source) {
      soundboardCurrentSource = null;
    }
  };
  soundboardCurrentSource = source;
  try {
    source.start(0);
  } catch {
    // ignore
  }
}

// ── Data management ──

function upsertSoundboardSound(sound) {
  if (!sound || !sound.id) return;
  soundboardSounds.set(sound.id, sound);
  // Re-render whichever view is visible
  if (soundboardCompactPanel && !soundboardCompactPanel.classList.contains("hidden")) {
    renderSoundboardCompact();
  }
  if (soundboardPanel && !soundboardPanel.classList.contains("hidden")) {
    renderSoundboard();
  }
}

function renderSoundboardIconPicker() {
  if (!soundboardIconGrid) return;
  soundboardIconGrid.innerHTML = "";
  SOUNDBOARD_ICONS.forEach((icon) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = icon;
    if (icon === soundboardSelectedIcon) {
      btn.classList.add("is-selected");
    }
    btn.addEventListener("click", () => {
      soundboardSelectedIcon = icon;
      renderSoundboardIconPicker();
    });
    soundboardIconGrid.appendChild(btn);
  });
}

function toggleSoundboardFavorite(soundId) {
  const idx = soundboardFavorites.indexOf(soundId);
  if (idx >= 0) {
    soundboardFavorites.splice(idx, 1);
    debugLog("[soundboard] Unfavorited: " + soundId);
  } else {
    soundboardFavorites.push(soundId);
    debugLog("[soundboard] Favorited: " + soundId);
  }
  echoSet("echo-soundboard-favorites", JSON.stringify(soundboardFavorites));
  renderAllSoundboardViews();
}

function saveSoundboardOrder(orderedIds) {
  soundboardCustomOrder = orderedIds;
  echoSet("echo-soundboard-order", JSON.stringify(soundboardCustomOrder));
}

function sortSoundboardSounds(sounds) {
  const favSet = new Set(soundboardFavorites);
  const favs = [];
  const rest = [];
  sounds.forEach((s) => (favSet.has(s.id) ? favs : rest).push(s));
  // Sort each group by custom order if available
  const orderMap = new Map();
  soundboardCustomOrder.forEach((id, i) => orderMap.set(id, i));
  const bySavedOrder = (a, b) => {
    const ai = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
    const bi = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;
    return ai - bi;
  };
  favs.sort(bySavedOrder);
  rest.sort(bySavedOrder);
  return [...favs, ...rest];
}

function getSoundboardSoundsFiltered(query) {
  return Array.from(soundboardSounds.values()).filter((sound) => {
    if (soundboardLoadedRoomId && sound.roomId && sound.roomId !== soundboardLoadedRoomId) return false;
    if (!query) return true;
    const name = (sound.name || "").toLowerCase();
    return name.includes(query);
  });
}

// ── Drag & drop ──

function attachSoundboardDragDrop(el, sound, gridEl, selectorClass, rerenderFn) {
  const favSet = new Set(soundboardFavorites);
  el.addEventListener("dragstart", (e) => {
    soundboardDragId = sound.id;
    el.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", sound.id);
  });
  el.addEventListener("dragend", () => {
    soundboardDragId = null;
    el.classList.remove("is-dragging");
    gridEl.querySelectorAll("." + selectorClass + ".drag-over").forEach((x) => x.classList.remove("drag-over"));
  });
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (soundboardDragId && soundboardDragId !== sound.id) {
      el.classList.add("drag-over");
    }
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("drag-over");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (!soundboardDragId || soundboardDragId === sound.id) return;
    // Unrestricted reorder — any sound can be dragged to any position
    const children = Array.from(gridEl.querySelectorAll("[data-sound-id]"));
    const ids = children.map((t) => t.dataset.soundId);
    const fromIdx = ids.indexOf(soundboardDragId);
    const toIdx = ids.indexOf(sound.id);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, soundboardDragId);
    debugLog("[soundboard] Reordered sounds");
    saveSoundboardOrder(ids);
    rerenderFn();
  });
}

// ── Rendering ──

function renderSoundboardCompact() {
  if (!soundboardCompactGrid) return;
  const sounds = getSoundboardSoundsFiltered("");
  soundboardCompactGrid.innerHTML = "";
  if (sounds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.style.gridColumn = "1 / -1";
    empty.style.fontSize = "11px";
    empty.textContent = "No sounds yet.";
    soundboardCompactGrid.appendChild(empty);
    return;
  }
  const sorted = sortSoundboardSounds(sounds);
  const favSet = new Set(soundboardFavorites);

  sorted.forEach((sound) => {
    const btn = document.createElement("div");
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.className = "sound-icon-btn";
    btn.dataset.soundId = sound.id;
    btn.draggable = true;
    btn.setAttribute("draggable", "true");
    btn.dataset.soundName = sound.name || "Sound";
    btn.textContent = sound.icon || "\u{1F50A}";
    btn.addEventListener("mouseenter", function() { showSoundTooltip(btn, btn.dataset.soundName); });
    btn.addEventListener("mouseleave", hideSoundTooltip);
    if (favSet.has(sound.id)) {
      btn.classList.add("is-favorite");
    }
    btn.addEventListener("click", () => {
      if (!room) return;
      primeSoundboardAudio();
      playSoundboardSound(sound.id).catch(() => {});
      sendSoundboardMessage({ type: "sound-play", soundId: sound.id, senderName: room?.localParticipant?.name || "", soundName: sound.name || "" });
    });
    attachSoundboardDragDrop(btn, sound, soundboardCompactGrid, "sound-icon-btn", renderAllSoundboardViews);
    soundboardCompactGrid.appendChild(btn);
  });
}

function renderSoundboard() {
  if (!soundboardGrid) return;
  const query = (soundSearchInput?.value ?? "").trim().toLowerCase();
  const sounds = getSoundboardSoundsFiltered(query);
  soundboardGrid.innerHTML = "";
  if (sounds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No sounds yet. Upload one below.";
    soundboardGrid.appendChild(empty);
    return;
  }
  const sorted = sortSoundboardSounds(sounds);
  const favSet = new Set(soundboardFavorites);

  sorted.forEach((sound) => {
    const tile = document.createElement("div");
    tile.className = "sound-tile";
    tile.dataset.soundId = sound.id;
    tile.draggable = true;
    tile.setAttribute("draggable", "true");
    if (sound.id === soundboardEditingId) {
      tile.classList.add("is-editing");
    }
    if (favSet.has(sound.id)) {
      tile.classList.add("is-favorite");
    }

    // --- Favorite button ---
    const favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "sound-fav" + (favSet.has(sound.id) ? " is-active" : "");
    favBtn.title = favSet.has(sound.id) ? "Remove from favorites" : "Add to favorites";
    favBtn.draggable = false;
    favBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
    favBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSoundboardFavorite(sound.id);
    });
    favBtn.addEventListener("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });

    const main = document.createElement("div");
    main.className = "sound-tile-main";
    main.draggable = false;
    const iconEl = document.createElement("div");
    iconEl.className = "sound-icon";
    iconEl.draggable = false;
    iconEl.textContent = sound.icon || "\u{1F50A}";
    const nameEl = document.createElement("div");
    nameEl.className = "sound-name";
    nameEl.draggable = false;
    nameEl.textContent = sound.name || "Sound";
    main.append(iconEl, nameEl);
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "sound-edit";
    editBtn.draggable = false;
    editBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
      </svg>`;
    editBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      enterSoundboardEditMode(sound);
    });
    editBtn.addEventListener("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });
    tile.append(favBtn, main, editBtn);
    tile.addEventListener("click", () => {
      if (!room) return;
      primeSoundboardAudio();
      playSoundboardSound(sound.id).catch(() => {});
      sendSoundboardMessage({ type: "sound-play", soundId: sound.id, senderName: room?.localParticipant?.name || "", soundName: sound.name || "" });
    });

    // --- Drag and drop (unrestricted) ---
    attachSoundboardDragDrop(tile, sound, soundboardGrid, "sound-tile", renderAllSoundboardViews);

    soundboardGrid.appendChild(tile);
  });
}

function renderAllSoundboardViews() {
  renderSoundboardCompact();
  renderSoundboard();
}

// ── Edit mode ──

function enterSoundboardEditMode(sound) {
  if (!sound) return;
  soundboardEditingId = sound.id;
  if (soundNameInput) soundNameInput.value = sound.name || "";
  soundboardSelectedIcon = sound.icon || "\u{1F50A}";
  renderSoundboardIconPicker();
  updateSoundClipVolumeUi(sound.volume ?? 100);
  updateSoundboardEditControls();
  const iconsSection = document.getElementById("soundboard-icons-section");
  if (iconsSection) iconsSection.classList.remove("hidden");
  setSoundboardHint(`Editing "${sound.name ?? "Sound"}". Update name/icon/volume and click Save.`);
  renderSoundboard();
}

function exitSoundboardEditMode() {
  soundboardEditingId = null;
  if (soundNameInput) soundNameInput.value = "";
  if (soundFileInput) soundFileInput.value = "";
  soundboardSelectedIcon = SOUNDBOARD_ICONS[0] ?? "\u{1F50A}";
  updateSoundClipVolumeUi(soundboardClipVolume);
  updateSoundboardEditControls();
  const iconsSection = document.getElementById("soundboard-icons-section");
  if (iconsSection) iconsSection.classList.add("hidden");
  renderSoundboard();
}

// ── Panel toggle ──

function openSoundboard() {
  if (!soundboardCompactPanel) return;
  soundboardEditingId = null;
  // Reset compact volume panel
  if (soundboardVolumePanelCompact) {
    soundboardVolumePanelCompact.classList.add("hidden");
    soundboardVolumePanelCompact.setAttribute("aria-hidden", "true");
  }
  updateSoundboardVolumeUi();
  // Make sure edit mode is hidden, show compact
  if (soundboardPanel) soundboardPanel.classList.add("hidden");
  // Position compact panel directly below the Soundboard button
  const btn = openSoundboardButton;
  if (btn) {
    const rect = btn.getBoundingClientRect();
    soundboardCompactPanel.style.top = (rect.bottom + 6) + "px";
    soundboardCompactPanel.style.right = (window.innerWidth - rect.right) + "px";
  }
  soundboardCompactPanel.classList.remove("hidden");
  if (currentRoomName) {
    void loadSoundboardList();
  }
  renderSoundboardCompact();
  primeSoundboardAudio();
}

function closeSoundboard() {
  // Close both compact and edit views
  if (soundboardCompactPanel) soundboardCompactPanel.classList.add("hidden");
  if (soundboardPanel) {
    soundboardPanel.classList.add("hidden");
    soundboardEditingId = null;
    updateSoundboardEditControls();
    setSoundboardHint("");
  }
}

function openSoundboardEdit() {
  if (!soundboardPanel) return;
  // Hide compact, show edit
  if (soundboardCompactPanel) soundboardCompactPanel.classList.add("hidden");
  soundboardEditingId = null;
  if (soundboardVolumePanel) {
    soundboardVolumePanel.classList.add("hidden");
    soundboardVolumePanel.setAttribute("aria-hidden", "true");
  }
  updateSoundboardVolumeUi();
  updateSoundClipVolumeUi(soundboardClipVolume);
  soundboardSelectedIcon = soundboardSelectedIcon || SOUNDBOARD_ICONS[0] || "\u{1F50A}";
  renderSoundboardIconPicker();
  updateSoundboardEditControls();
  soundboardPanel.classList.remove("hidden");
  renderSoundboard();
}

function closeSoundboardEdit() {
  // Hide edit, return to compact
  if (soundboardPanel) {
    soundboardPanel.classList.add("hidden");
    soundboardEditingId = null;
    updateSoundboardEditControls();
    setSoundboardHint("");
  }
  if (soundboardCompactPanel) {
    soundboardCompactPanel.classList.remove("hidden");
    renderSoundboardCompact();
  }
}

// ── Server operations ──

function clearSoundboardState() {
  soundboardLoadedRoomId = null;
  soundboardEditingId = null;
  soundboardSounds.clear();
  soundboardBufferCache.clear();
  if (soundboardGrid) soundboardGrid.innerHTML = "";
  if (soundboardCompactGrid) soundboardCompactGrid.innerHTML = "";
  updateSoundboardEditControls();
  stopSoundboardPlayback();
  setSoundboardHint("");
  closeSoundboard();
}

async function loadSoundboardList() {
  if (!currentAccessToken) return;
  const roomId = currentRoomName;
  soundboardLoadedRoomId = roomId;
  try {
    const res = await fetch(apiUrl(`/api/soundboard/list?roomId=${encodeURIComponent(roomId)}`), {
      headers: {
        Authorization: `Bearer ${currentAccessToken}`
      }
    });
    if (!res.ok) {
      if (soundboardPanel && !soundboardPanel.classList.contains("hidden")) {
        setSoundboardHint("Unable to load soundboard.", true);
      }
      return;
    }
    const data = await res.json().catch(() => ({}));
    soundboardSounds.clear();
    (data?.sounds || []).forEach((sound) => {
      if (sound?.id) soundboardSounds.set(sound.id, sound);
    });
    if (soundboardCompactPanel && !soundboardCompactPanel.classList.contains("hidden")) {
      renderSoundboardCompact();
    }
    if (soundboardPanel && !soundboardPanel.classList.contains("hidden")) {
      renderSoundboard();
    }
  } catch {
    if (soundboardPanel && !soundboardPanel.classList.contains("hidden")) {
      setSoundboardHint("Unable to load soundboard.", true);
    }
  }
}

async function uploadSoundboardSound() {
  if (soundboardEditingId) {
    await updateSoundboardSound();
    return;
  }
  if (!currentAccessToken) {
    setSoundboardHint("Join a room first.", true);
    return;
  }
  const file = soundFileInput?.files?.[0];
  if (!file) {
    setSoundboardHint("Select an audio file first.", true);
    return;
  }
  const rawName = (soundNameInput?.value ?? "").trim();
  const defaultName = file.name ? file.name.replace(/\.[^/.]+$/, "") : "";
  const name = (rawName || defaultName || "Sound").slice(0, 60);
  const icon = soundboardSelectedIcon || "\u{1F50A}";
  const volumeRaw = Number(soundClipVolumeInput?.value ?? soundboardClipVolume);
  const volume = Number.isFinite(volumeRaw) ? Math.min(200, Math.max(0, Math.round(volumeRaw))) : 100;

  setSoundboardHint("Uploading...");

  try {
    const qs = new URLSearchParams({
      roomId: currentRoomName,
      name,
      icon,
      volume: String(volume)
    });
    const res = await fetch(apiUrl(`/api/soundboard/upload?${qs.toString()}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentAccessToken}`,
        "Content-Type": file.type && file.type.length > 0 ? file.type : "application/octet-stream"
      },
      body: file
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      setSoundboardHint(data?.error || "Upload failed.", true);
      return;
    }
    if (data?.sound) {
      upsertSoundboardSound(data.sound);
      sendSoundboardMessage({ type: "sound-added", sound: data.sound });
    }
    if (soundNameInput) soundNameInput.value = "";
    if (soundFileInput) soundFileInput.value = "";
    updateSoundboardEditControls();
    const iconsSection = document.getElementById("soundboard-icons-section");
    if (iconsSection) iconsSection.classList.add("hidden");
    setSoundboardHint("Uploaded!");
  } catch {
    setSoundboardHint("Upload failed.", true);
  }
}

async function updateSoundboardSound() {
  if (!currentAccessToken || !soundboardEditingId) {
    setSoundboardHint("Join a room first.", true);
    return;
  }
  const rawName = (soundNameInput?.value ?? "").trim();
  const name = (rawName || "Sound").slice(0, 60);
  const icon = soundboardSelectedIcon || "\u{1F50A}";
  const soundId = soundboardEditingId;
  const volumeRaw = Number(soundClipVolumeInput?.value ?? 100);
  const volume = Number.isFinite(volumeRaw) ? Math.min(200, Math.max(0, Math.round(volumeRaw))) : 100;

  setSoundboardHint("Saving...");
  try {
    const res = await fetch(apiUrl("/api/soundboard/update"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        roomId: currentRoomName,
        soundId,
        name,
        icon,
        volume
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      setSoundboardHint(data?.error || "Save failed.", true);
      return;
    }
    if (data?.sound) {
      upsertSoundboardSound(data.sound);
      sendSoundboardMessage({ type: "sound-updated", sound: data.sound });
    }
    exitSoundboardEditMode();
    setSoundboardHint("Saved!");
  } catch {
    setSoundboardHint("Save failed.", true);
  }
}

function sendSoundboardMessage(message) {
  if (!room || !message) return;
  const payload = JSON.stringify(message);
  const encoder = new TextEncoder();
  try {
    room.localParticipant.publishData(encoder.encode(payload), { reliable: true });
  } catch {
    // ignore
  }
}

// ── Event listeners ──

if (openSoundboardButton) {
  openSoundboardButton.addEventListener("click", () => {
    openSoundboard();
  });
}

if (closeSoundboardButton) {
  closeSoundboardButton.addEventListener("click", () => {
    closeSoundboard();
  });
}

if (openSoundboardEditButton) {
  openSoundboardEditButton.addEventListener("click", () => {
    openSoundboardEdit();
  });
}

if (backToSoundboardButton) {
  backToSoundboardButton.addEventListener("click", () => {
    closeSoundboardEdit();
  });
}

// Compact view volume toggle
if (toggleSoundboardVolumeCompactButton && soundboardVolumePanelCompact) {
  toggleSoundboardVolumeCompactButton.addEventListener("click", () => {
    soundboardVolumePanelCompact.classList.toggle("hidden");
    const isOpen = !soundboardVolumePanelCompact.classList.contains("hidden");
    toggleSoundboardVolumeCompactButton.setAttribute("aria-expanded", String(isOpen));
    soundboardVolumePanelCompact.setAttribute("aria-hidden", String(!isOpen));
  });
}

// Edit view volume toggle
if (toggleSoundboardVolumeButton && soundboardVolumePanel) {
  toggleSoundboardVolumeButton.addEventListener("click", () => {
    soundboardVolumePanel.classList.toggle("hidden");
    const isOpen = !soundboardVolumePanel.classList.contains("hidden");
    toggleSoundboardVolumeButton.setAttribute("aria-expanded", String(isOpen));
    soundboardVolumePanel.setAttribute("aria-hidden", String(!isOpen));
  });
}

// Volume input handler — works for both compact and edit sliders
function handleSoundboardVolumeChange(inputEl) {
  const value = Number(inputEl.value);
  soundboardUserVolume = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
  echoSet("echo-core-soundboard-volume", String(soundboardUserVolume));
  updateSoundboardVolumeUi();
}

if (soundboardVolumeInput) {
  soundboardVolumeInput.addEventListener("input", () => {
    handleSoundboardVolumeChange(soundboardVolumeInput);
    // Sync the edit slider if it exists
    if (soundboardVolumeInputEdit) soundboardVolumeInputEdit.value = soundboardVolumeInput.value;
  });
}

if (soundboardVolumeInputEdit) {
  soundboardVolumeInputEdit.addEventListener("input", () => {
    handleSoundboardVolumeChange(soundboardVolumeInputEdit);
    // Sync the compact slider if it exists
    if (soundboardVolumeInput) soundboardVolumeInput.value = soundboardVolumeInputEdit.value;
  });
}

if (soundSearchInput) {
  soundSearchInput.addEventListener("input", () => {
    renderSoundboard();
  });
}

if (soundClipVolumeInput) {
  soundClipVolumeInput.addEventListener("input", () => {
    const value = Number(soundClipVolumeInput.value);
    const normalized = Number.isFinite(value) ? Math.min(200, Math.max(0, value)) : 100;
    updateSoundClipVolumeUi(normalized);
    if (!soundboardEditingId) {
      soundboardClipVolume = normalized;
      echoSet("echo-core-soundboard-clip-volume", String(soundboardClipVolume));
    }
    renderSoundboard();
  });
}

if (soundFileInput) {
  soundFileInput.addEventListener("change", () => {
    updateSoundboardEditControls();
    // Show icon picker when a file is selected for upload
    const iconsSection = document.getElementById("soundboard-icons-section");
    if (iconsSection && soundFileInput.files && soundFileInput.files.length > 0) {
      iconsSection.classList.remove("hidden");
    }
  });
}

if (soundUploadButton) {
  soundUploadButton.addEventListener("click", () => {
    primeSoundboardAudio();
    void uploadSoundboardSound();
  });
}

if (soundCancelEditButton) {
  soundCancelEditButton.addEventListener("click", () => {
    exitSoundboardEditMode();
    setSoundboardHint("");
  });
}
