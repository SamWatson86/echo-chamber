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
  const localParticipant = { identity: "phone-1" };
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
      return publication.source || track.source || null;
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
        _volWrap: { classList: createClassList(["hidden"]) },
        _volSlider: { value: "1" },
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

test("removing the last screen audio track hides its Stage volume control", () => {
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
  assert.equal(tile._volWrap.classList.hidden, true);
});
