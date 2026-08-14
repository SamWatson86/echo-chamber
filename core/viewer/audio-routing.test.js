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
  return { context, audioBucketEl, audioElBySid, participantState, room };
}

test("first remote microphone attachment stamps and indexes the exact audio SID", () => {
  const harness = loadAudioRoutingHarness();
  const participant = { identity: "desktop-1", name: "Desktop" };
  const state = {
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
  };
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
