const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadAudioRoutingHarness() {
  const audioBucketEl = {
    children: [],
    appendChild(element) {
      element.isConnected = true;
      this.children.push(element);
      return element;
    },
  };
  const audioElBySid = new Map();
  const participantState = new Map();
  const participantCards = new Map();
  const localParticipant = { identity: "phone-1", trackPublications: new Map() };
  const room = {
    localParticipant,
    remoteParticipants: new Map(),
    startAudioCalls: 0,
    startAudio() { this.startAudioCalls += 1; },
  };
  const handled = new Set();
  const createdScreenTiles = [];
  function createClassList(initial) {
    const values = new Set(initial || []);
    return {
      contains(value) { return values.has(value); },
      add(value) { values.add(value); },
      remove(value) { values.delete(value); },
      toggle(value, force) {
        if (force === undefined ? !values.has(value) : force) values.add(value);
        else values.delete(value);
      },
    };
  }
  const context = {
    window: {},
    room,
    roomAudioMuted: false,
    selectedSpeakerId: "",
    micEnabled: true,
    audioBucketEl,
    audioElBySid,
    participantState,
    participantCards,
    cameraVideoBySid: new Map(),
    screenTileByIdentity: new Map(),
    screenTileBySid: new Map(),
    screenTrackMeta: new Map(),
    screenRecoveryAttempts: new Map(),
    screenResubscribeIntent: new Map(),
    hiddenScreens: new Set(),
    watchedScreens: new Set(),
    reconcileTimers: new Set(),
    reconcilePending: false,
    audioMonitorTimer: null,
    lastActiveSpeakerEvent: 0,
    activeSpeakerIds: new Set(),
    performance: { now() { return 5000; } },
    setTimeout() { return 1; },
    setInterval() { return 1; },
    clearTimeout() {},
    clearInterval() {},
    console,
    getLiveKitClient() {
      return {
        Track: {
          Source: {
            Camera: "camera",
            Microphone: "microphone",
            ScreenShare: "screen_share",
            ScreenShareAudio: "screen_share_audio",
          },
          Kind: { Video: "video", Audio: "audio" },
        },
      };
    },
    getTrackSource(publication, track) {
      return publication?.source || track?.source || null;
    },
    getParticipantPublications(participant) {
      return Array.from(participant?.trackPublications?.values() || []);
    },
    getTrackSid(publication, track, fallback) {
      return publication.trackSid || track.sid || fallback;
    },
    ensureParticipantCard() { return {}; },
    isCurrentCameraTrackGeneration() { return true; },
    wasRecentlyHandled(key) { return handled.has(key); },
    markHandled(key) { handled.add(key); },
    isUnwatchedScreenShare() { return false; },
    configureAudioElement(element) { element.configured = true; },
    ensureAudioPlays(element) { element.playAttempts = (element.playAttempts || 0) + 1; },
    applySpeakerToMedia() { return Promise.resolve(); },
    requestVideoKeyFrame() {},
    clearScreenTracksForIdentity() {},
    createAttachedVideoElement(track) {
      return {
        _lkTrack: track,
        isConnected: true,
        paused: false,
        readyState: 4,
        style: {},
      };
    },
    configureVideoElement() {},
    ensureVideoPlays() {},
    kickStartScreenVideo() {},
    addScreenTile(label, video, trackSid) {
      const tile = {
        isConnected: true,
        dataset: { trackSid },
        style: {},
        classList: createClassList(),
        _volWrap: { classList: createClassList(["hidden"]), setAttribute(name, value) { this[name] = value; } },
        _volButton: { setAttribute(name, value) { this[name] = value; } },
        _volSlider: { value: "1" },
        _volStatus: { textContent: "No stream audio" },
        querySelector(selector) { return selector === "video" ? video : null; },
      };
      createdScreenTiles.push(tile);
      return tile;
    },
    stampScreenTileGeneration() {},
    ensureVideoSubscribed() {},
    registerScreenTrack() {},
    scheduleScreenRecovery() {},
    startInboundScreenStatsMonitor() {},
    setParticipantScreenWatchAvailable() {},
    forceVideoLayer() {},
    updateCameraLobbySpeakingIndicators() {},
    debugLog() {},
  };
  context.global = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "audio-routing.js"), "utf8"),
    context,
    { filename: "audio-routing.js" }
  );
  return { context, audioBucketEl, audioElBySid, participantState, room, createdScreenTiles };
}

function createParticipantAudioState(overrides) {
  return Object.assign({
    micAudioEls: new Set(),
    screenAudioEls: new Set(),
    micGainNodes: new Map(),
    screenGainNodes: new Map(),
    micVolume: 1,
    screenVolume: 1,
    micUserMuted: false,
    screenUserMuted: false,
    micAnalyser: null,
    screenAnalyser: null,
  }, overrides);
}

function installParticipantAudioLifecycle(harness) {
  const { context, room } = harness;
  const handlers = new Map();
  const timers = [];
  Object.assign(context, {
    LK: { RoomEvent: { ParticipantConnected: "joined", ParticipantDisconnected: "left" } },
    newRoom: room,
    _pendingDisconnects: new Map(),
    _isReconnecting: false,
    _isRoomSwitch: false,
    cameraStageTileByIdentity: new Map(),
    ignoreStaleRoomEvent() { return context.room !== room; },
    normalizeScreenMediaIdentity(identity) { return identity?.replace(/\$screen$/, ""); },
    isNativePresenterIdentity() { return false; },
    clearScreenParticipantGeneration() { return { removed: false }; },
    hasParticipantScreenPublication() { return false; },
    hasCameraStageGenerationMismatch() { return false; },
    cancelCameraClearTimer() {},
    updateAvatarVideo() {},
    removeCameraStageTile() {},
    setParticipantCameraStageAvailable() {},
    playChimeForParticipant() {},
    scheduleReconcileWaves() {},
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
  });
  room.on = (event, callback) => handlers.set(event, callback);
  // Exercise the shipped generation predicates and room event callbacks,
  // without opening a signaling connection or running unrelated call setup.
  const grid = fs.readFileSync(path.join(__dirname, "participants-grid.js"), "utf8");
  vm.runInContext(grid.slice(grid.indexOf("function getCameraStageParticipant("),
    grid.indexOf("function hasCameraStageGenerationMismatch(")), context);
  const connect = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");
  for (const event of ["ParticipantConnected", "ParticipantDisconnected"]) {
    const start = connect.indexOf("  newRoom.on(LK.RoomEvent." + event + ",");
    assert.ok(start >= 0);
    const end = connect.indexOf("\n  });", start);
    vm.runInContext(connect.slice(start, end + "\n  });".length), context);
  }
  return { handlers, timers };
}

function attachLifecycleAudio(harness, participant, sid, source = "microphone") {
  const state = harness.participantState.get(participant.identity);
  const screen = source === "screen_share_audio";
  const element = {
    _echoRoom: harness.room, _echoParticipant: participant,
    _echoMediaIdentity: participant.identity, _echoTrackSid: sid, _echoMediaSource: source,
    srcObject: {}, isConnected: true, volume: 0,
    pause() { this.paused = true; },
    remove() { this.isConnected = false; },
    _lkTrack: { detach(target) { element.detached = target === element; } },
  };
  const nodes = {
    source: { disconnect() { this.disconnected = true; } },
    gain: { gain: { value: 2.8 }, disconnect() { this.disconnected = true; } },
  };
  state[screen ? "screenAudioEls" : "micAudioEls"].add(element);
  state[screen ? "screenGainNodes" : "micGainNodes"].set(element, nodes);
  state[screen ? "screenAudioSid" : "micSid"] = sid;
  harness.audioElBySid.set(sid, element);
  return { element, nodes };
}

test("participant disconnect retires boosted voice before the card grace period or rejoin", () => {
  const h = loadAudioRoutingHarness();
  const lifecycle = installParticipantAudioLifecycle(h);
  const old = { identity: "jeff", trackPublications: new Map() };
  const state = createParticipantAudioState({ micVolume: 2.8 });
  let analyserCleanup = 0;
  state.micAnalyser = { cleanup() { analyserCleanup += 1; } };
  h.participantState.set(old.identity, state);
  const audio = attachLifecycleAudio(h, old, "old-mic");
  // LiveKit removes the participant from its registry before disconnect events;
  // TrackUnsubscribed is therefore rejected by the live-generation guard.
  lifecycle.handlers.get("left")(old);
  assert.equal(lifecycle.timers.find(timer => timer.delay === 8000) != null, true);
  assert.equal(h.participantState.get(old.identity), state, "the card still has its grace period");
  assert.equal(state.micAudioEls.size, 0);
  assert.equal(state.micGainNodes.size, 0);
  assert.equal(h.audioElBySid.size, 0);
  assert.equal(audio.nodes.gain.disconnected, true);
  assert.equal(audio.nodes.source.disconnected, true);
  assert.equal(audio.element.detached, true);
  assert.equal(audio.element.paused, true);
  assert.equal(audio.element.srcObject, null);
  assert.equal(audio.element.isConnected, false);
  assert.equal(state.micSid, null);
  assert.equal(analyserCleanup, 1);
});

test("rejoin cleans old voice and shared audio even when replacement audio reuses their SIDs", () => {
  const h = loadAudioRoutingHarness();
  const lifecycle = installParticipantAudioLifecycle(h);
  const old = { identity: "jeff", trackPublications: new Map() };
  const replacement = { ...old };
  const state = createParticipantAudioState({ micVolume: 0 });
  h.participantState.set(old.identity, state);
  const stale = [attachLifecycleAudio(h, old, "mic"), attachLifecycleAudio(h, old, "screen", "screen_share_audio")];
  const current = [attachLifecycleAudio(h, replacement, "mic"), attachLifecycleAudio(h, replacement, "screen", "screen_share_audio")];
  h.room.remoteParticipants.set(old.identity, replacement);
  lifecycle.handlers.get("joined")(replacement);
  assert.equal(state.micAudioEls.size, 1);
  assert.equal(state.screenAudioEls.size, 1);
  for (let i = 0; i < stale.length; i++) {
    assert.equal(stale[i].nodes.gain.disconnected, true);
    assert.equal(stale[i].element.isConnected, false);
    assert.equal(current[i].element.isConnected, true);
    assert.equal(h.audioElBySid.get(current[i].element._echoTrackSid), current[i].element);
  }
  // Late old-generation events must not remove or mute the new participant.
  lifecycle.handlers.get("left")(old);
  lifecycle.handlers.get("joined")(old);
  assert.equal(state.micAudioEls.has(current[0].element), true);
  for (const volume of [0, 0.25, 1, 3]) {
    state.micVolume = volume;
    h.context.applyParticipantAudioVolumes(state);
    assert.equal(current[0].nodes.gain.gain.value, volume);
  }
});

test("old-room disconnect callbacks leave current voice playback alone", () => {
  const h = loadAudioRoutingHarness();
  const lifecycle = installParticipantAudioLifecycle(h);
  const participant = { identity: "jeff", trackPublications: new Map() };
  const state = createParticipantAudioState();
  h.participantState.set(participant.identity, state);
  const audio = attachLifecycleAudio(h, participant, "mic");
  h.context.room = { remoteParticipants: new Map([[participant.identity, participant]]) };
  lifecycle.handlers.get("left")(participant);
  assert.equal(state.micAudioEls.size, 1);
  assert.equal(audio.element.isConnected, true);
  assert.equal(lifecycle.timers.length, 0);
});

function localPreviewHarness() {
  const harness = loadAudioRoutingHarness();
  const local = harness.room.localParticipant;
  const state = createParticipantAudioState();
  harness.participantState.set(local.identity, state);
  const tile = harness.context.addScreenTile("Your screen", {}, "local-video");
  harness.context.screenTileByIdentity.set(local.identity, tile);
  const publication = {
    trackSid: "local-audio", source: "screen_share_audio", kind: "audio", isMuted: false,
    track: { kind: "audio", mediaStreamTrack: { readyState: "live", enabled: true, muted: false },
      attach() { assert.fail("own stream audio must never attach for playback"); } },
  };
  local.trackPublications.set(publication.trackSid, publication);
  return { ...harness, local, state, tile, publication,
    sync() { harness.context.syncScreenAudioVolumeControl(local.identity); } };
}

test("own preview reports outgoing screen audio without self-playback or a volume slider", () => {
  const h = localPreviewHarness();
  h.sync();
  assert.equal(h.tile._volStatus.textContent, "Audio shared");
  assert.equal(h.tile._volSlider.disabled, true);
  assert.equal(h.tile._volWrap.classList.contains("hidden"), false);
  assert.equal(h.tile._volButton["aria-label"], "Your stream audio");
  assert.equal(h.tile._volWrap["aria-label"], "Your stream audio");
  assert.equal(h.state.screenAudioEls.size, 0);
  assert.equal(h.audioBucketEl.children.length, 0);
  assert.equal(h.room.startAudioCalls, 0);
  // Local publication truth does not depend on receiver/card audio state.
  h.participantState.delete(h.local.identity);
  h.sync();
  assert.equal(h.tile._volStatus.textContent, "Audio shared");
});

test("own audio status distinguishes muted, ended, absent, and microphone-only publications", () => {
  const h = localPreviewHarness();
  for (const target of [h.publication, h.publication.track]) {
    target.isMuted = true;
    h.sync();
    assert.equal(h.tile._volStatus.textContent, "Audio muted");
    target.isMuted = false;
  }
  h.publication.track.mediaStreamTrack.enabled = false;
  h.sync();
  assert.equal(h.tile._volStatus.textContent, "Audio muted");
  h.publication.track.mediaStreamTrack.enabled = true;
  h.sync();
  assert.equal(h.tile._volStatus.textContent, "Audio shared");
  h.publication.track.mediaStreamTrack.readyState = "ended";
  h.sync();
  assert.equal(h.tile._volStatus.textContent, "No audio shared");
  h.local.trackPublications.clear();
  h.local.trackPublications.set("microphone", { ...h.publication, source: "microphone",
    track: { kind: "audio", mediaStreamTrack: { readyState: "live" } } });
  h.sync();
  assert.equal(h.tile._volStatus.textContent, "No audio shared");
  h.local.trackPublications.set("pending-audio", { source: "screen_share_audio", kind: "audio" });
  h.sync();
  assert.equal(h.tile._volStatus.textContent, "No audio shared");
});

test("own preview reads only the current room's publisher, never retained or remote audio", () => {
  const h = localPreviewHarness();
  h.sync();
  h.context.room = { localParticipant: { identity: h.local.identity, trackPublications: new Map() },
    remoteParticipants: new Map([["remote", { trackPublications: h.local.trackPublications }]]) };
  h.state.screenAudioEls.add({ isConnected: true });
  h.context.window._nativeAudioActive = true;
  h.sync();
  assert.equal(h.tile._volStatus.textContent, "No audio shared");
  assert.equal(h.tile._volSlider.disabled, true);
});

test("publication events, mute events, and reconnect reconciliation refresh own audio status", () => {
  const h = localPreviewHarness();
  const context = h.context;
  const handlers = new Map();
  const LK = context.getLiveKitClient();
  LK.RoomEvent = Object.fromEntries(["LocalTrackPublished", "LocalTrackUnpublished", "TrackMuted", "TrackUnmuted"].map(name => [name, name]));
  Object.assign(context, {
    LK, newRoom: h.room, name: "You", document: { addEventListener() {} },
    connectBtn: { addEventListener() {} }, disconnectBtn: { addEventListener() {} },
    disconnectTopBtn: { addEventListener() {} },
    publishStateReconcile: null, _micToggling: true, _camToggling: true,
    ignoreStaleRoomEvent() { return context.room !== h.room; },
    isCurrentRoomParticipantGeneration(identity, participant, expectedRoom) {
      return context.room === expectedRoom && expectedRoom.localParticipant === participant;
    },
    updatePublisherMicrophoneState() {},
  });
  h.room.on = (event, handler) => handlers.set(event, handler);
  const source = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");
  vm.runInContext(source, context, { filename: "connect.js" });
  // Register the production handlers without opening a network connection.
  for (const [start, end] of [
    ['  if (LK.RoomEvent?.TrackMuted)', '  if (LK.RoomEvent?.ActiveSpeakers)'],
    ['  if (LK.RoomEvent?.LocalTrackPublished)', '  // Fetch ICE server config'],
  ]) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    vm.runInContext(source.slice(from, to), context, { filename: "connect-events.js" });
  }
  handlers.get("LocalTrackPublished")(h.publication);
  assert.equal(h.tile._volStatus.textContent, "Audio shared");
  h.publication.isMuted = true;
  handlers.get("TrackMuted")(h.publication, h.local);
  assert.equal(h.tile._volStatus.textContent, "Audio muted");
  h.publication.isMuted = false;
  handlers.get("TrackUnmuted")(h.publication, h.local);
  assert.equal(h.tile._volStatus.textContent, "Audio shared");
  h.local.trackPublications.clear();
  handlers.get("LocalTrackUnpublished")(h.publication);
  assert.equal(h.tile._volStatus.textContent, "No audio shared");
  // Audio already published when the local video preview is first created.
  h.local.trackPublications.set(h.publication.trackSid, h.publication);
  handlers.get("LocalTrackPublished")({ source: "screen_share", trackSid: "new-video",
    track: { kind: "video", attach() { return {}; } } });
  const tile = context.screenTileByIdentity.get(h.local.identity);
  assert.equal(tile._volStatus.textContent, "Audio shared");
  h.publication.track.mediaStreamTrack.readyState = "ended";
  context.reconcileLocalPublishIndicators("reconnected");
  assert.equal(tile._volStatus.textContent, "No audio shared");
  // A late old publication event must preserve a live replacement's status.
  const replacement = { ...h.publication, trackSid: "replacement-audio",
    track: { kind: "audio", mediaStreamTrack: { readyState: "live" } } };
  h.local.trackPublications.clear();
  h.local.trackPublications.set(replacement.trackSid, replacement);
  handlers.get("LocalTrackUnpublished")(h.publication);
  assert.equal(tile._volStatus.textContent, "Audio shared");
  context.room = { localParticipant: { identity: h.local.identity, trackPublications: new Map() } };
  context.reconcileLocalPublishIndicators("post-connect");
  for (const event of Object.values(LK.RoomEvent)) {
    handlers.get(event)(h.publication, h.local);
    assert.equal(tile._volStatus.textContent, "No audio shared");
  }
  assert.equal(h.audioBucketEl.children.length, 0);
});

test("first remote microphone attachment stamps and indexes the exact audio SID", () => {
  const harness = loadAudioRoutingHarness();
  const participant = { identity: "desktop-1", name: "Desktop" };
  const state = createParticipantAudioState();
  harness.participantState.set(participant.identity, state);

  const unmuteListeners = [];
  const element = { isConnected: false, srcObject: {}, volume: 0 };
  const track = {
    sid: "audio-track-fallback",
    kind: "audio",
    source: "microphone",
    mediaStreamTrack: {
      enabled: true,
      muted: false,
      addEventListener(type, listener) {
        if (type === "unmute") unmuteListeners.push(listener);
      },
    },
    attachCalls: 0,
    attach() {
      this.attachCalls += 1;
      return element;
    },
  };
  const publication = {
    trackSid: "microphone-publication-sid",
    source: "microphone",
    kind: "audio",
    isMuted: false,
    isSubscribed: true,
    setSubscribedCalls: [],
    setSubscribed(value) { this.setSubscribedCalls.push(value); },
  };

  assert.doesNotThrow(() => {
    harness.context.handleTrackSubscribed(track, publication, participant);
  });

  assert.equal(track.attachCalls, 1);
  assert.equal(element._echoTrackSid, publication.trackSid);
  assert.equal(harness.audioElBySid.get(publication.trackSid), element);
  assert.deepEqual(harness.audioBucketEl.children, [element]);
  assert.equal(state.micAudioEls.has(element), true);
  assert.equal(state.screenAudioEls.size, 0);
  assert.equal(element.configured, true);
  assert.equal(element.playAttempts, 1);
  assert.equal(harness.room.startAudioCalls, 1);
  assert.deepEqual(publication.setSubscribedCalls, [true]);
  assert.equal(unmuteListeners.length, 1);
});

test("screen audio subscribed before video exposes the later Stage volume control", () => {
  const harness = loadAudioRoutingHarness();
  const participant = { identity: "desktop-1", name: "Desktop" };
  const state = createParticipantAudioState({ screenVolume: 0.42 });
  harness.participantState.set(participant.identity, state);
  harness.room.remoteParticipants.set(participant.identity, participant);

  const audioElement = {
    isConnected: false,
    srcObject: {},
    volume: 0,
  };
  const audioTrack = {
    sid: "screen-audio-track",
    kind: "audio",
    source: "screen_share_audio",
    mediaStreamTrack: {
      enabled: true,
      muted: false,
      addEventListener() {},
    },
    attach() { return audioElement; },
  };
  const audioPublication = {
    trackSid: "screen-audio-publication",
    source: "screen_share_audio",
    kind: "audio",
    isSubscribed: true,
    setSubscribed() {},
  };

  harness.context.handleTrackSubscribed(audioTrack, audioPublication, participant);
  assert.equal(harness.createdScreenTiles.length, 0);
  assert.equal(audioElement.volume, 0.42);

  const videoTrack = {
    sid: "screen-video-track",
    kind: "video",
    source: "screen_share",
    mediaStreamTrack: null,
  };
  const videoPublication = {
    trackSid: "screen-video-publication",
    source: "screen_share",
    kind: "video",
    isSubscribed: true,
    setSubscribed() {},
  };

  harness.context.handleTrackSubscribed(videoTrack, videoPublication, participant);

  assert.equal(harness.createdScreenTiles.length, 1);
  const tile = harness.createdScreenTiles[0];
  assert.equal(tile._volWrap.classList.contains("hidden"), false);
  assert.equal(tile._volSlider.value, 0.42);
  assert.equal(harness.context.screenTileByIdentity.get(participant.identity), tile);
  assert.equal(state.screenAudioEls.has(audioElement), true);
});

test("removing the last screen audio track disables its discoverable Stage volume control", () => {
  const harness = loadAudioRoutingHarness();
  const participant = {
    identity: "desktop-1",
    name: "Desktop",
    trackPublications: new Map(),
  };
  const state = createParticipantAudioState({ screenVolume: 0.42 });
  const audioElement = {
    isConnected: true,
    remove() { this.isConnected = false; },
  };
  const tile = {
    isConnected: true,
    _volWrap: {
      classList: {
        hidden: false,
        toggle(name, force) {
          if (name === "hidden") this.hidden = force;
        },
      },
    },
    _volSlider: { value: 0.42 },
    _volStatus: { textContent: "42%" },
  };
  const track = {
    sid: "screen-audio-publication",
    kind: "audio",
    source: "screen_share_audio",
  };
  const publication = {
    trackSid: "screen-audio-publication",
    source: "screen_share_audio",
  };

  state.screenAudioEls.add(audioElement);
  harness.participantState.set(participant.identity, state);
  harness.context.screenTileByIdentity.set(participant.identity, tile);
  harness.audioElBySid.set(publication.trackSid, audioElement);
  harness.context.normalizeScreenMediaIdentity = (identity) => identity;
  harness.context.setTimeout = (callback) => {
    callback();
    return 1;
  };

  harness.context.handleTrackUnsubscribed(track, publication, participant);

  assert.equal(state.screenAudioEls.size, 0);
  assert.equal(harness.audioElBySid.has(publication.trackSid), false);
  assert.equal(tile._volWrap.classList.hidden, false);
  assert.equal(tile._volSlider.disabled, true);
  assert.equal(tile._volStatus.textContent, "No stream audio");
});
