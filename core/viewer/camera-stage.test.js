const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeClassList {
  constructor(initial = "") {
    this.values = new Set(String(initial).split(/\s+/).filter(Boolean));
  }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const next = force == null ? !this.values.has(value) : !!force;
    if (next) this.values.add(value); else this.values.delete(value);
    return next;
  }
}

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) {
    this.values.set(name, String(value));
    if (name === "object-fit") this.objectFit = String(value);
  }
  getPropertyValue(name) { return this.values.get(name) || ""; }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.dataset = {};
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.videoWidth = 0;
    this.videoHeight = 0;
  }
  set className(value) { this._className = value; this.classList = new FakeClassList(value); }
  get className() { return this._className || ""; }
  setConnected(value) {
    this.isConnected = !!value;
    this.children.forEach((child) => child.setConnected?.(value));
  }
  appendChild(child) {
    child.parentElement = this;
    child.setConnected?.(this.isConnected);
    this.children.push(child);
    return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  insertBefore(child, reference) {
    child.parentElement = this;
    child.setConnected?.(this.isConnected);
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }
  replaceWith(replacement) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children[index] = replacement;
    replacement.parentElement = parent;
    replacement.setConnected?.(parent.isConnected);
    this.parentElement = null;
    this.setConnected(false);
  }
  remove() {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
    }
    this.parentElement = null;
    this.setConnected(false);
  }
  querySelector(selector) {
    if (selector === "video") return this.children.find((child) => child.tagName === "VIDEO") || null;
    if (selector === "h3") return this.children.find((child) => child.tagName === "H3") || null;
    if (selector === ".tile-overlay") return this.children.find((child) => child.classList.contains("tile-overlay")) || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === ".tile.is-focused") {
      return this.children.filter((child) => child.classList.contains("tile") && child.classList.contains("is-focused"));
    }
    return [];
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }
  dispatch(type, event = {}) {
    (this.listeners.get(type) || []).forEach((listener) => listener(event));
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  pause() { this.paused = true; }
}

function makeTrack(sid) {
  return {
    sid,
    attachCalls: 0,
    detachCalls: [],
    attach() { this.attachCalls += 1; },
    detach(element) { this.detachCalls.push(element); },
  };
}

function loadCameraStageHarness() {
  const screenGridEl = new FakeElement("div");
  screenGridEl.isConnected = true;
  const cameraStageTileByIdentity = new Map();
  const stagedCameraIdentities = new Set();
  const screenTileByIdentity = new Map();
  const screenTileBySid = new Map();
  const screenTrackMeta = new Map();
  let fullscreenVideo = null;
  let cameraLobbyPopulateCalls = 0;
  const cameraLobbyPanel = new FakeElement("div");
  const localParticipant = { identity: "sam-1", name: "Sam", trackPublications: new Map() };
  const remoteParticipants = new Map();
  const context = {
    window: { _pausedVideos: new Set(), _echoRecalcGrid() {} },
    document: { createElement(tagName) { return new FakeElement(tagName); } },
    MutationObserver: class { observe() {} disconnect() {} },
    screenGridEl,
    cameraStageTileByIdentity,
    stagedCameraIdentities,
    screenTileByIdentity,
    screenTileBySid,
    screenTrackMeta,
    screenRecoveryAttempts: new Map(),
    screenResubscribeIntent: new Map(),
    hiddenScreens: new Set(),
    watchedScreens: new Set(),
    participantState: new Map(),
    cameraVideoBySid: new Map(),
    audioElBySid: new Map(),
    ENABLE_SCREEN_WATCHDOG: false,
    screenWatchdogTimer: null,
    cameraLobbyPanel,
    participantCards: new Map(),
    cameraClearTimers: new Map(),
    cameraClearGenerationByIdentity: new Map(),
    cameraRecoveryAttempts: new Map(),
    room: { localParticipant, remoteParticipants },
    performance: { now() { return 5000; } },
    getLiveKitClient() {
      return {
        Track: {
          Source: {
            Camera: "camera",
            ScreenShare: "screen_share",
            ScreenShareAudio: "screen_share_audio",
          },
          Kind: { Video: "video", Audio: "audio" },
        },
        VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
      };
    },
    isScreenIdentity(identity) { return String(identity || "").endsWith("$screen"); },
    getParentIdentity(identity) { return String(identity || "").replace(/\$screen$/, ""); },
    getParticipantPublications(participant) { return participant.publications || []; },
    createAttachedVideoElement(track) {
      track.attachCalls += 1;
      const video = new FakeElement("video");
      video._lkTrack = track;
      video.play = async () => {};
      return video;
    },
    configureVideoElement(element) { element.configured = true; element.muted = true; },
    ensureVideoPlays(track, element) { element.playEnsures = (element.playEnsures || 0) + 1; },
    startBasicVideoMonitor(element) { element.monitorStarts = (element.monitorStarts || 0) + 1; },
    enterVideoFullscreen(video) { fullscreenVideo = video; },
    debugLog() {},
    markResubscribeIntent(trackSid) {
      context.screenResubscribeIntent.set(trackSid, context.performance.now());
    },
    populateCameraLobby() { cameraLobbyPopulateCalls += 1; },
    setParticipantCameraStageAvailable() {},
    updateAvatarVideo(cardRef, track) {
      if (track) return;
      cardRef.cameraRoom = null;
      cardRef.cameraParticipant = null;
      cardRef.cameraPublication = null;
      cardRef.cameraTrack = null;
      const video = cardRef.avatar?.querySelector("video");
      if (video) video.remove();
    },
    cleanupVideoDiagnostics() {},
    clearInterval() {},
    clearTimeout() {},
    setInterval() { return 1; },
    setTimeout() { return 1; },
    console,
  };
  context.global = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "participants-grid.js"), "utf8"),
    context,
    { filename: "participants-grid.js" }
  );
  return {
    context,
    screenGridEl,
    cameraStageTileByIdentity,
    stagedCameraIdentities,
    screenTileByIdentity,
    screenTileBySid,
    screenTrackMeta,
    localParticipant,
    cameraLobbyPanel,
    get fullscreenVideo() { return fullscreenVideo; },
    get cameraLobbyPopulateCalls() { return cameraLobbyPopulateCalls; },
  };
}

function loadCameraRecoveryHarness() {
  const harness = loadCameraStageHarness();
  const scheduled = [];
  let avatarUpdates = 0;
  harness.context.setTimeout = (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  };
  harness.context.updateAvatarVideo = () => { avatarUpdates += 1; };
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "participants-fullscreen.js"), "utf8"),
    harness.context,
    { filename: "participants-fullscreen.js" }
  );
  return {
    ...harness,
    scheduled,
    get avatarUpdates() { return avatarUpdates; },
  };
}

function loadScreenGenerationHarness(loadAudioRouting = false) {
  const harness = loadCameraStageHarness();
  const scheduled = [];
  harness.context.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "participants-fullscreen.js"), "utf8"),
    harness.context,
    { filename: "participants-fullscreen.js" }
  );
  // These lifecycle tests exercise generation ownership, not canvas sampling.
  harness.context.attachVideoDiagnostics = () => {};
  harness.context.cleanupVideoDiagnostics = () => {};
  if (loadAudioRouting) {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "audio-routing.js"), "utf8"),
      harness.context,
      { filename: "audio-routing.js" }
    );
  }
  return { ...harness, scheduled };
}

test("camera and screen for one identity coexist without sharing tile state", () => {
  const harness = loadCameraStageHarness();
  const screenTile = new FakeElement("div");
  screenTile.className = "tile";
  screenTile.dataset.identity = "sam-1";
  screenTile.dataset.mediaKind = "screen";
  harness.screenGridEl.appendChild(screenTile);
  harness.screenTileByIdentity.set("sam-1", screenTile);
  const track = makeTrack("camera-1");
  harness.stagedCameraIdentities.add("sam-1");

  const cameraTile = harness.context.upsertCameraStageTile("sam-1", "Sam", track, { trackSid: "camera-1" });

  assert.equal(harness.screenGridEl.children.length, 2);
  assert.equal(harness.screenTileByIdentity.get("sam-1"), screenTile);
  assert.equal(harness.cameraStageTileByIdentity.get("sam-1"), cameraTile);
  assert.equal(cameraTile.dataset.mediaKind, "camera");
  assert.equal(cameraTile.querySelector("video").muted, true);
});

test("same camera track is idempotent and replacement keeps the tile stable", () => {
  const harness = loadCameraStageHarness();
  harness.stagedCameraIdentities.add("sam-1");
  const firstTrack = makeTrack("camera-1");
  const firstTile = harness.context.upsertCameraStageTile("sam-1", "Sam", firstTrack, { trackSid: "camera-1" });
  const firstVideo = firstTile.querySelector("video");

  const duplicate = harness.context.upsertCameraStageTile("sam-1", "Samuel", firstTrack, { trackSid: "camera-1" });
  assert.equal(duplicate, firstTile);
  assert.equal(duplicate.querySelector("video"), firstVideo);
  assert.equal(harness.screenGridEl.children.length, 1);

  const replacementTrack = makeTrack("camera-2");
  const replacement = harness.context.upsertCameraStageTile("sam-1", "Samuel", replacementTrack, { trackSid: "camera-2" });
  assert.equal(replacement, firstTile);
  assert.notEqual(replacement.querySelector("video"), firstVideo);
  assert.equal(replacement.dataset.cameraTrackSid, "camera-2");
  assert.deepEqual(firstTrack.detachCalls, [firstVideo]);
  assert.equal(harness.screenGridEl.children.length, 1);
});

test("transient camera removal preserves intent while authoritative clear removes it", () => {
  const harness = loadCameraStageHarness();
  const track = makeTrack("camera-1");
  harness.stagedCameraIdentities.add("sam-1");
  harness.context.upsertCameraStageTile("sam-1", "Sam", track, { trackSid: "camera-1" });

  harness.context.removeCameraStageTile("sam-1", { clearIntent: false });
  assert.equal(harness.cameraStageTileByIdentity.has("sam-1"), false);
  assert.equal(harness.stagedCameraIdentities.has("sam-1"), true);

  harness.context.upsertCameraStageTile("sam-1", "Sam", makeTrack("camera-2"), { trackSid: "camera-2" });
  harness.context.removeCameraStageTile("sam-1", { clearIntent: true });
  assert.equal(harness.cameraStageTileByIdentity.has("sam-1"), false);
  assert.equal(harness.stagedCameraIdentities.has("sam-1"), false);

  harness.stagedCameraIdentities.add("sam-1");
  harness.context.upsertCameraStageTile("sam-1", "Sam", makeTrack("camera-3"), { trackSid: "camera-3" });
  harness.context.clearCameraStageTiles();
  assert.equal(harness.cameraStageTileByIdentity.size, 0);
  assert.equal(harness.stagedCameraIdentities.size, 0);
});

test("showing and hiding camera never changes subscription or creates camera audio controls", () => {
  const harness = loadCameraStageHarness();
  const track = makeTrack("camera-1");
  let subscriptionChanges = 0;
  harness.localParticipant.publications = [{
    source: "camera",
    kind: "video",
    track,
    trackSid: "camera-1",
    setSubscribed() { subscriptionChanges += 1; },
  }];

  assert.equal(harness.context.setCameraOnStage("sam-1", true), true);
  const tile = harness.cameraStageTileByIdentity.get("sam-1");
  assert.equal(subscriptionChanges, 0);
  assert.equal(tile.children.some((child) => child.classList.contains("tile-volume-wrap")), false);
  assert.equal(tile.children.some((child) => child.tagName === "AUDIO"), false);

  assert.equal(harness.context.setCameraOnStage("sam-1", false), false);
  assert.equal(subscriptionChanges, 0);
  assert.equal(harness.cameraStageTileByIdentity.has("sam-1"), false);
});

test("camera tile supplies camera-specific fullscreen, focus, contain, and aspect behavior", () => {
  const harness = loadCameraStageHarness();
  const track = makeTrack("camera-1");
  harness.stagedCameraIdentities.add("sam-1");
  const tile = harness.context.upsertCameraStageTile("sam-1", "Sam", track, { trackSid: "camera-1" });
  const video = tile.querySelector("video");
  const fullscreen = tile.children.find((child) => child.classList.contains("tile-fullscreen-btn"));

  assert.equal(video.style.objectFit, "contain");
  video.videoWidth = 1080;
  video.videoHeight = 1920;
  video.dispatch("loadedmetadata");
  assert.equal(tile.dataset.aspectRatio, "0.56");
  assert.equal(tile.classList.contains("portrait"), true);

  tile.dispatch("click");
  assert.equal(tile.classList.contains("is-focused"), true);
  fullscreen.dispatch("click", { stopPropagation() {} });
  assert.equal(harness.fullscreenVideo, video);
  assert.equal(fullscreen.getAttribute("aria-label"), "Open camera fullscreen");
});

test("camera generations reject old Rooms and replaced same-identity participants", () => {
  const harness = loadCameraStageHarness();
  const currentTrack = makeTrack("camera-current");
  const currentPublication = { source: "camera", kind: "video", track: currentTrack };
  const currentParticipant = { identity: "alex-2", publications: [currentPublication] };
  harness.context.room.remoteParticipants.set("alex-2", currentParticipant);

  assert.equal(harness.context.isCurrentCameraTrackGeneration(
    "alex-2", currentParticipant, currentPublication, currentTrack, harness.context.room
  ), true);

  const oldTrack = makeTrack("camera-old");
  const oldPublication = { source: "camera", kind: "video", track: oldTrack };
  const oldParticipant = { identity: "alex-2", publications: [oldPublication] };
  const oldRoom = {
    localParticipant: { identity: "other-local" },
    remoteParticipants: new Map([["alex-2", oldParticipant]]),
  };
  assert.equal(harness.context.isCurrentCameraTrackGeneration(
    "alex-2", oldParticipant, oldPublication, oldTrack, oldRoom
  ), false);
  assert.equal(harness.context.isCurrentCameraTrackGeneration(
    "alex-2", oldParticipant, oldPublication, oldTrack, harness.context.room
  ), false);
});

test("screen events reject old Rooms and replaced same-identity participants", () => {
  const harness = loadCameraStageHarness();
  const oldScreenTrack = { sid: "screen-old", kind: "video", source: "screen_share" };
  const oldScreenPublication = { source: "screen_share", kind: "video", track: oldScreenTrack };
  const oldParticipant = { identity: "alex-2", publications: [oldScreenPublication] };
  const replacementParticipant = { identity: "alex-2", publications: [] };
  const oldRoom = {
    localParticipant: harness.localParticipant,
    remoteParticipants: new Map([["alex-2", oldParticipant]]),
  };
  harness.context.room.remoteParticipants.set("alex-2", replacementParticipant);

  assert.equal(harness.context.shouldIgnoreRoomMediaEvent(
    oldRoom,
    harness.context.room,
    false
  ), true);
  assert.equal(harness.context.isCurrentRoomParticipantGeneration(
    "alex-2",
    oldParticipant,
    harness.context.room
  ), false);
  assert.equal(harness.context.isCurrentRoomParticipantGeneration(
    "alex-2",
    replacementParticipant,
    harness.context.room
  ), true);

  harness.context.room._echoRecoveryDisconnect = true;
  assert.equal(harness.context.shouldIgnoreRoomMediaEvent(
    harness.context.room,
    harness.context.room,
    true
  ), true);
});

test("disconnect grace cleanup rejects old Rooms and replacement participants", () => {
  const harness = loadCameraStageHarness();
  const disconnectedParticipant = { identity: "alex-2", publications: [] };
  harness.context.room.remoteParticipants.set("alex-2", disconnectedParticipant);

  assert.equal(harness.context.isCurrentCameraDisconnectGeneration(
    "alex-2",
    disconnectedParticipant,
    harness.context.room
  ), true);

  harness.context.room.remoteParticipants.delete("alex-2");
  assert.equal(harness.context.isCurrentCameraDisconnectGeneration(
    "alex-2",
    disconnectedParticipant,
    harness.context.room
  ), true);

  harness.context.room.remoteParticipants.set("alex-2", { identity: "alex-2", publications: [] });
  assert.equal(harness.context.isCurrentCameraDisconnectGeneration(
    "alex-2",
    disconnectedParticipant,
    harness.context.room
  ), false);

  const oldRoom = harness.context.room;
  harness.context.room = {
    localParticipant: harness.localParticipant,
    remoteParticipants: new Map(),
  };
  assert.equal(harness.context.isCurrentCameraDisconnectGeneration(
    "alex-2",
    disconnectedParticipant,
    oldRoom
  ), false);
});

test("rejoin detects a stale same-identity camera attachment without a pending disconnect", () => {
  const harness = loadCameraStageHarness();
  const oldParticipant = { identity: "alex-2", publications: [] };
  const replacementParticipant = { identity: "alex-2", publications: [] };
  harness.context.room.remoteParticipants.set("alex-2", replacementParticipant);
  const cardRef = {
    cameraRoom: harness.context.room,
    cameraParticipant: oldParticipant,
    cameraPublication: {},
    cameraTrack: makeTrack("camera-old"),
  };

  assert.equal(harness.context.hasCameraStageGenerationMismatch(
    "alex-2",
    replacementParticipant,
    harness.context.room,
    cardRef,
    null
  ), true);

  cardRef.cameraParticipant = replacementParticipant;
  assert.equal(harness.context.hasCameraStageGenerationMismatch(
    "alex-2",
    replacementParticipant,
    harness.context.room,
    cardRef,
    null
  ), false);
});

test("active Camera Lobby refills only for the committed current Room", () => {
  const harness = loadCameraStageHarness();
  const committedRoom = harness.context.room;

  assert.equal(harness.context.refreshActiveCameraLobbyForRoom(committedRoom), true);
  assert.equal(harness.cameraLobbyPopulateCalls, 1);

  harness.context.room = {
    localParticipant: harness.localParticipant,
    remoteParticipants: new Map(),
  };
  assert.equal(harness.context.refreshActiveCameraLobbyForRoom(committedRoom), false);
  assert.equal(harness.cameraLobbyPopulateCalls, 1);

  const currentRoom = harness.context.room;
  harness.cameraLobbyPanel.classList.add("hidden");
  assert.equal(harness.context.refreshActiveCameraLobbyForRoom(currentRoom), false);
  assert.equal(harness.cameraLobbyPopulateCalls, 1);
});

test("delayed camera cleanup is fenced to its exact Room, participant, and publication generation", () => {
  const harness = loadCameraStageHarness();
  const unsubscribedTrack = makeTrack("camera-old");
  const publication = { source: "camera", kind: "video", track: null };
  const participant = { identity: "alex-2", publications: [publication] };
  harness.context.room.remoteParticipants.set("alex-2", participant);
  const generation = {
    identity: "alex-2",
    room: harness.context.room,
    participant,
    publication,
    track: unsubscribedTrack,
  };

  assert.equal(harness.context.isCurrentCameraUnsubscribeGeneration(generation), true);

  publication.track = makeTrack("camera-replacement");
  assert.equal(harness.context.isCurrentCameraUnsubscribeGeneration(generation), false);
  publication.track = null;

  const replacementPublication = { source: "camera", kind: "video", track: makeTrack("camera-new-pub") };
  participant.publications.push(replacementPublication);
  assert.equal(harness.context.isCurrentCameraUnsubscribeGeneration(generation), false);
  participant.publications.pop();

  const replacementParticipant = { identity: "alex-2", publications: [] };
  harness.context.room.remoteParticipants.set("alex-2", replacementParticipant);
  assert.equal(harness.context.isCurrentCameraUnsubscribeGeneration(generation), false);
  harness.context.room.remoteParticipants.set("alex-2", participant);

  const currentRoom = harness.context.room;
  harness.context.room = {
    localParticipant: currentRoom.localParticipant,
    remoteParticipants: new Map([["alex-2", participant]]),
  };
  assert.equal(harness.context.isCurrentCameraUnsubscribeGeneration(generation), false);
});

test("an old local camera publication cannot clear a live replacement publication", () => {
  const harness = loadCameraStageHarness();
  const oldPublication = { source: "camera", kind: "video", track: makeTrack("camera-old") };
  const replacementPublication = { source: "camera", kind: "video", track: makeTrack("camera-new") };
  harness.localParticipant.publications = [oldPublication, replacementPublication];

  assert.equal(harness.context.hasLiveCameraPublicationOtherThan(
    harness.localParticipant,
    oldPublication
  ), true);

  replacementPublication.track = null;
  assert.equal(harness.context.hasLiveCameraPublicationOtherThan(
    harness.localParticipant,
    oldPublication
  ), false);

  const pendingReplacement = harness.context.getRemainingCameraPublicationState(
    harness.localParticipant,
    oldPublication
  );
  assert.equal(pendingReplacement.publication, replacementPublication);
  assert.equal(pendingReplacement.track, null);
});

test("camera recovery timer cannot reattach after Room replacement", () => {
  const harness = loadCameraRecoveryHarness();
  const track = makeTrack("camera-old-room");
  track.mediaStreamTrack = { readyState: "live" };
  let subscriptionChanges = 0;
  const publication = {
    source: "camera",
    kind: "video",
    track,
    isSubscribed: true,
    setSubscribed() { subscriptionChanges += 1; },
  };
  const participant = { identity: "alex-2", publications: [publication] };
  const avatar = new FakeElement("div");
  avatar.isConnected = true;
  avatar.appendChild(new FakeElement("video"));
  const cardRef = { avatar };
  harness.context.room.remoteParticipants.set("alex-2", participant);
  harness.context.participantCards.set("alex-2", cardRef);

  harness.context.scheduleCameraRecovery("alex-2", cardRef, publication);
  assert.equal(harness.scheduled.length, 1);
  harness.context.room = {
    localParticipant: harness.localParticipant,
    remoteParticipants: new Map([["alex-2", participant]]),
  };
  harness.scheduled.shift()();

  assert.equal(subscriptionChanges, 0);
  assert.equal(harness.avatarUpdates, 0);
});

test("camera recovery timer cannot reattach after same-identity participant replacement", () => {
  const harness = loadCameraRecoveryHarness();
  const track = makeTrack("camera-old-participant");
  track.mediaStreamTrack = { readyState: "live" };
  let subscriptionChanges = 0;
  const publication = {
    source: "camera",
    kind: "video",
    track,
    isSubscribed: true,
    setSubscribed() { subscriptionChanges += 1; },
  };
  const oldParticipant = { identity: "alex-2", publications: [publication] };
  const replacementParticipant = { identity: "alex-2", publications: [] };
  const avatar = new FakeElement("div");
  avatar.isConnected = true;
  avatar.appendChild(new FakeElement("video"));
  const cardRef = { avatar };
  harness.context.room.remoteParticipants.set("alex-2", oldParticipant);
  harness.context.participantCards.set("alex-2", cardRef);

  harness.context.scheduleCameraRecovery("alex-2", cardRef, publication);
  assert.equal(harness.scheduled.length, 1);
  harness.context.room.remoteParticipants.set("alex-2", replacementParticipant);
  harness.scheduled.shift()();

  assert.equal(subscriptionChanges, 0);
  assert.equal(harness.avatarUpdates, 0);
});

test("camera recovery still repairs the exact current generation", () => {
  const harness = loadCameraRecoveryHarness();
  const track = makeTrack("camera-current");
  track.mediaStreamTrack = { readyState: "live" };
  let subscriptionChanges = 0;
  const publication = {
    source: "camera",
    kind: "video",
    track,
    isSubscribed: true,
    setSubscribed() { subscriptionChanges += 1; },
  };
  const participant = { identity: "alex-2", publications: [publication] };
  const avatar = new FakeElement("div");
  avatar.isConnected = true;
  avatar.appendChild(new FakeElement("video"));
  const cardRef = { avatar };
  harness.context.room.remoteParticipants.set("alex-2", participant);
  harness.context.participantCards.set("alex-2", cardRef);

  harness.context.scheduleCameraRecovery("alex-2", cardRef, publication);
  harness.scheduled.shift()();

  assert.equal(subscriptionChanges, 1);
  assert.equal(harness.avatarUpdates, 1);
});

test("remote camera replacement publication preserves Stage intent until its track subscribes", () => {
  const harness = loadCameraStageHarness();
  const oldTrack = makeTrack("camera-old");
  const oldPublication = {
    source: "camera",
    kind: "video",
    track: oldTrack,
    trackSid: "camera-old",
  };
  const replacementPublication = {
    source: "camera",
    kind: "video",
    track: null,
    trackSid: "camera-new",
  };
  const participant = {
    identity: "alex-2",
    name: "Alex",
    publications: [oldPublication, replacementPublication],
  };
  harness.context.room.remoteParticipants.set(participant.identity, participant);
  harness.stagedCameraIdentities.add(participant.identity);
  const avatar = new FakeElement("div");
  avatar.setConnected(true);
  const oldAvatarVideo = new FakeElement("video");
  oldAvatarVideo._lkTrack = oldTrack;
  avatar.appendChild(oldAvatarVideo);
  const cardRef = {
    avatar,
    cameraRoom: harness.context.room,
    cameraParticipant: participant,
    cameraPublication: oldPublication,
    cameraTrack: oldTrack,
  };
  harness.context.participantCards.set(participant.identity, cardRef);
  harness.context.cameraVideoBySid.set(oldPublication.trackSid, oldAvatarVideo);
  harness.context.participantState.set(participant.identity, {
    cameraTrackSid: oldPublication.trackSid,
  });
  const oldTile = harness.context.upsertCameraStageTile(
    participant.identity,
    participant.name,
    oldTrack,
    oldPublication
  );

  const remaining = harness.context.getRemainingCameraPublicationState(
    participant,
    oldPublication
  );
  assert.equal(remaining.publication, replacementPublication);
  assert.equal(remaining.track, null);

  harness.context.removeCameraVisualGeneration(participant.identity, oldPublication, {
    clearIntent: false,
  });
  assert.equal(oldTile.isConnected, false);
  assert.equal(harness.cameraStageTileByIdentity.has(participant.identity), false);
  assert.equal(harness.stagedCameraIdentities.has(participant.identity), true);
  assert.equal(harness.context.cameraVideoBySid.has(oldPublication.trackSid), false);

  // Deliberately reuse both the track object and SID. Exact publication stamps,
  // rather than track equality, must protect the replacement generation.
  const replacementTrack = oldTrack;
  replacementPublication.trackSid = oldPublication.trackSid;
  replacementPublication.track = replacementTrack;
  const replacementTile = harness.context.reconcileCameraStageTrack(
    participant.identity,
    participant.name,
    replacementTrack,
    replacementPublication
  );
  assert.ok(replacementTile);
  assert.equal(replacementTile._cameraStagePublication, replacementPublication);
  const replacementAvatarVideo = new FakeElement("video");
  replacementAvatarVideo._lkTrack = replacementTrack;
  replacementAvatarVideo._echoCameraPublication = replacementPublication;
  avatar.appendChild(replacementAvatarVideo);
  cardRef.cameraPublication = replacementPublication;
  cardRef.cameraTrack = replacementTrack;
  harness.context.cameraVideoBySid.set(replacementPublication.trackSid, replacementAvatarVideo);
  harness.context.participantState.get(participant.identity).cameraTrackSid = replacementPublication.trackSid;

  // A duplicate late cleanup for the old publication cannot touch the new tile.
  harness.context.removeCameraVisualGeneration(participant.identity, oldPublication, {
    clearIntent: false,
  });
  assert.equal(harness.cameraStageTileByIdentity.get(participant.identity), replacementTile);
  assert.equal(harness.stagedCameraIdentities.has(participant.identity), true);
  assert.equal(
    harness.context.cameraVideoBySid.get(replacementPublication.trackSid),
    replacementAvatarVideo
  );
  assert.equal(
    harness.context.participantState.get(participant.identity).cameraTrackSid,
    replacementPublication.trackSid
  );
});

test("authoritative remote camera off clears Stage visuals and intent without a replacement publication", () => {
  const harness = loadCameraStageHarness();
  const track = makeTrack("camera-last");
  const publication = {
    source: "camera",
    kind: "video",
    track,
    trackSid: "camera-last",
  };
  const participant = {
    identity: "alex-2",
    name: "Alex",
    publications: [publication],
  };
  harness.context.room.remoteParticipants.set(participant.identity, participant);
  harness.stagedCameraIdentities.add(participant.identity);
  harness.context.upsertCameraStageTile(
    participant.identity,
    participant.name,
    track,
    publication
  );
  participant.publications = [];

  const remaining = harness.context.getRemainingCameraPublicationState(participant, publication);
  assert.equal(remaining.publication, null);
  harness.context.removeCameraVisualGeneration(participant.identity, publication, {
    clearIntent: true,
  });

  assert.equal(harness.cameraStageTileByIdentity.has(participant.identity), false);
  assert.equal(harness.stagedCameraIdentities.has(participant.identity), false);
});

test("same-identity participant replacement removes only old screen video and audio generations", () => {
  const harness = loadScreenGenerationHarness(true);
  const identity = "alex-2";
  const oldParticipant = { identity, publications: [] };
  const replacementParticipant = { identity, publications: [] };
  harness.context.room.remoteParticipants.set(identity, replacementParticipant);
  harness.context.hiddenScreens.add(identity);
  harness.context.watchedScreens.add(identity);

  const oldTrack = makeTrack("screen-old");
  oldTrack.kind = "video";
  oldTrack.source = "screen_share";
  const oldPublication = {
    source: "screen_share",
    kind: "video",
    track: oldTrack,
    trackSid: oldTrack.sid,
  };
  oldParticipant.publications = [oldPublication];
  const oldVideo = harness.context.createAttachedVideoElement(oldTrack);
  const oldTile = harness.context.addScreenTile("Alex (Screen)", oldVideo, oldTrack.sid);
  oldTile.dataset.identity = identity;
  harness.context.stampScreenTileGeneration(
    oldTile,
    oldPublication,
    identity,
    oldParticipant,
    oldTrack,
    harness.context.room
  );
  harness.context.registerScreenTrack(
    oldTrack.sid,
    oldPublication,
    oldTile,
    identity,
    oldParticipant,
    oldTrack,
    harness.context.room
  );

  const replacementTrack = makeTrack("screen-new");
  replacementTrack.kind = "video";
  replacementTrack.source = "screen_share";
  const replacementPublication = {
    source: "screen_share",
    kind: "video",
    track: replacementTrack,
    trackSid: replacementTrack.sid,
  };
  replacementParticipant.publications = [replacementPublication];
  const replacementVideo = harness.context.createAttachedVideoElement(replacementTrack);
  const replacementTile = harness.context.addScreenTile(
    "Alex (Screen)",
    replacementVideo,
    replacementTrack.sid
  );
  replacementTile.dataset.identity = identity;
  harness.context.stampScreenTileGeneration(
    replacementTile,
    replacementPublication,
    identity,
    replacementParticipant,
    replacementTrack,
    harness.context.room
  );
  harness.context.registerScreenTrack(
    replacementTrack.sid,
    replacementPublication,
    replacementTile,
    identity,
    replacementParticipant,
    replacementTrack,
    harness.context.room
  );
  harness.screenTileByIdentity.set(identity, replacementTile);

  let analyserCleanup = 0;
  const state = {
    screenAudioEls: new Set(),
    screenGainNodes: new Map(),
    screenAnalyser: { cleanup() { analyserCleanup += 1; } },
    screenAudioSid: "screen-audio-shared",
  };
  harness.context.participantState.set(identity, state);
  const oldAudioTrack = makeTrack("screen-audio-shared");
  const oldAudio = new FakeElement("audio");
  oldAudio._lkTrack = oldAudioTrack;
  oldAudio._echoRoom = harness.context.room;
  oldAudio._echoParticipant = oldParticipant;
  oldAudio._echoMediaSource = "screen_share_audio";
  oldAudio._echoMediaIdentity = identity;
  oldAudio._echoTrackSid = oldAudioTrack.sid;
  const replacementAudioTrack = makeTrack("screen-audio-shared");
  const replacementAudio = new FakeElement("audio");
  replacementAudio._lkTrack = replacementAudioTrack;
  replacementAudio._echoRoom = harness.context.room;
  replacementAudio._echoParticipant = replacementParticipant;
  replacementAudio._echoMediaSource = "screen_share_audio";
  replacementAudio._echoMediaIdentity = identity;
  replacementAudio._echoTrackSid = replacementAudioTrack.sid;
  state.screenAudioEls.add(oldAudio);
  state.screenAudioEls.add(replacementAudio);
  harness.context.audioElBySid.set(oldAudioTrack.sid, oldAudio);
  // The replacement reuses the SID and overwrites the global lookup before
  // ParticipantConnected performs old-generation cleanup.
  harness.context.audioElBySid.set(replacementAudioTrack.sid, replacementAudio);

  const videoResult = harness.context.clearScreenParticipantGeneration(
    replacementParticipant,
    harness.context.room,
    "replaced"
  );
  const audioResult = harness.context.clearScreenAudioParticipantGeneration(
    replacementParticipant,
    harness.context.room,
    "replaced"
  );

  assert.equal(videoResult.removed, true);
  assert.equal(audioResult.removed, 1);
  assert.equal(oldTile.isConnected, false);
  assert.deepEqual(oldTrack.detachCalls, [oldVideo]);
  assert.equal(harness.screenTileBySid.has(oldTrack.sid), false);
  assert.equal(harness.screenTrackMeta.has(oldTrack.sid), false);
  assert.equal(harness.screenTileBySid.get(replacementTrack.sid), replacementTile);
  assert.equal(harness.screenTrackMeta.get(replacementTrack.sid).participant, replacementParticipant);
  assert.equal(harness.screenTileByIdentity.get(identity), replacementTile);
  assert.equal(harness.context.hiddenScreens.has(identity), true);
  assert.equal(harness.context.watchedScreens.has(identity), true);
  assert.deepEqual(oldAudioTrack.detachCalls, [oldAudio]);
  assert.equal(state.screenAudioEls.has(oldAudio), false);
  assert.equal(harness.context.audioElBySid.get(replacementAudioTrack.sid), replacementAudio);
  assert.equal(state.screenAudioEls.has(replacementAudio), true);
  assert.equal(state.screenAudioSid, replacementAudioTrack.sid);
  assert.equal(analyserCleanup, 0);
  assert.equal(harness.context.isCurrentRoomParticipantGeneration(
    identity,
    oldParticipant,
    harness.context.room
  ), false);
});

test("abrupt screen companion disconnect cleans media stored under its parent identity", () => {
  const harness = loadScreenGenerationHarness(true);
  const parentIdentity = "alex-2";
  const companion = { identity: parentIdentity + "$screen", publications: [] };
  harness.context.room.remoteParticipants.set(companion.identity, companion);
  const track = makeTrack("screen-companion");
  track.kind = "video";
  track.source = "screen_share";
  const publication = {
    source: "screen_share",
    kind: "video",
    track,
    trackSid: track.sid,
  };
  companion.publications = [publication];
  const video = harness.context.createAttachedVideoElement(track);
  const tile = harness.context.addScreenTile("Alex (Screen)", video, track.sid);
  tile.dataset.identity = parentIdentity;
  harness.context.stampScreenTileGeneration(
    tile,
    publication,
    parentIdentity,
    companion,
    track,
    harness.context.room
  );
  harness.context.registerScreenTrack(
    track.sid,
    publication,
    tile,
    parentIdentity,
    companion,
    track,
    harness.context.room
  );
  harness.screenTileByIdentity.set(parentIdentity, tile);

  const audioTrack = makeTrack("screen-companion-audio");
  const audio = new FakeElement("audio");
  audio._lkTrack = audioTrack;
  audio._echoRoom = harness.context.room;
  audio._echoParticipant = companion;
  audio._echoMediaSource = "screen_share_audio";
  audio._echoMediaIdentity = parentIdentity;
  audio._echoTrackSid = audioTrack.sid;
  const state = {
    screenAudioEls: new Set([audio]),
    screenGainNodes: new Map(),
    screenAnalyser: null,
    screenAudioSid: audioTrack.sid,
  };
  harness.context.participantState.set(parentIdentity, state);
  harness.context.audioElBySid.set(audioTrack.sid, audio);

  const videoResult = harness.context.clearScreenParticipantGeneration(
    companion,
    harness.context.room,
    "exact"
  );
  const audioResult = harness.context.clearScreenAudioParticipantGeneration(
    companion,
    harness.context.room,
    "exact"
  );

  assert.equal(videoResult.mediaIdentity, parentIdentity);
  assert.equal(videoResult.removed, true);
  assert.equal(audioResult.mediaIdentity, parentIdentity);
  assert.equal(audioResult.removed, 1);
  assert.equal(harness.screenTileByIdentity.has(parentIdentity), false);
  assert.equal(harness.screenTileBySid.has(track.sid), false);
  assert.equal(harness.screenTrackMeta.has(track.sid), false);
  assert.equal(harness.context.audioElBySid.has(audioTrack.sid), false);
  assert.equal(state.screenAudioEls.size, 0);
});

test("detached screen generations stop recursive video-layer and resubscribe timers", () => {
  const harness = loadScreenGenerationHarness();
  const identity = "alex-2";
  const participant = { identity, publications: [] };
  harness.context.room.remoteParticipants.set(identity, participant);
  const track = makeTrack("screen-timer");
  track.kind = "video";
  track.source = "screen_share";
  let qualityChanges = 0;
  const subscriptionChanges = [];
  const publication = {
    source: "screen_share",
    kind: "video",
    track,
    trackSid: track.sid,
    setVideoQuality() { qualityChanges += 1; },
    setSubscribed(value) { subscriptionChanges.push(value); },
  };
  participant.publications = [publication];
  const video = harness.context.createAttachedVideoElement(track);
  const tile = harness.context.addScreenTile("Alex (Screen)", video, track.sid);
  tile.dataset.identity = identity;
  harness.context.stampScreenTileGeneration(
    tile,
    publication,
    identity,
    participant,
    track,
    harness.context.room
  );
  harness.context.registerScreenTrack(
    track.sid,
    publication,
    tile,
    identity,
    participant,
    track,
    harness.context.room
  );
  harness.screenTileByIdentity.set(identity, tile);

  harness.scheduled.length = 0;
  harness.context.forceVideoLayer(publication, video);
  const videoLayerTimer = harness.scheduled.find((entry) => entry.delay === 800);
  assert.ok(videoLayerTimer);

  video._isBlack = true;
  video._lastFrameTs = 0;
  harness.context.scheduleScreenRecovery(track.sid, publication, video);
  const recoveryTimer = harness.scheduled.find((entry) => entry.delay === 700);
  assert.ok(recoveryTimer);
  recoveryTimer.callback();
  assert.deepEqual(subscriptionChanges, [false]);
  const restoreTimer = harness.scheduled.find((entry) => entry.delay === 300);
  assert.ok(restoreTimer);

  harness.context.removeRegisteredScreenGeneration(
    track.sid,
    harness.screenTrackMeta.get(track.sid)
  );
  const scheduledBeforeStaleCallbacks = harness.scheduled.length;
  videoLayerTimer.callback();
  restoreTimer.callback();

  assert.equal(harness.scheduled.length, scheduledBeforeStaleCallbacks);
  assert.equal(qualityChanges, 0);
  assert.deepEqual(subscriptionChanges, [false]);
});

test("fullscreen exit label remains media-specific", () => {
  const fullscreen = require("./participants-fullscreen.js");
  const cameraHost = { dataset: { mediaKind: "camera" } };
  const screenHost = { dataset: { mediaKind: "screen" } };

  assert.equal(
    fullscreen.getVideoFullscreenControlLabel(cameraHost, "Open camera fullscreen", true),
    "Exit camera fullscreen"
  );
  assert.equal(
    fullscreen.getVideoFullscreenControlLabel(screenHost, "Open shared screen fullscreen", true),
    "Exit shared screen fullscreen"
  );
  assert.equal(
    fullscreen.getVideoFullscreenControlLabel(screenHost, "Open shared screen fullscreen", false),
    "Open shared screen fullscreen"
  );
});

test("viewer wiring exposes direct local/remote controls and separates transient from authoritative cleanup", () => {
  const stateSource = fs.readFileSync(path.join(__dirname, "state.js"), "utf8");
  const avatarSource = fs.readFileSync(path.join(__dirname, "participants-avatar.js"), "utf8");
  const audioSource = fs.readFileSync(path.join(__dirname, "audio-routing.js"), "utf8");
  const connectSource = fs.readFileSync(path.join(__dirname, "connect.js"), "utf8");

  assert.match(stateSource, /const cameraStageTileByIdentity = new Map\(\)/);
  assert.match(stateSource, /const stagedCameraIdentities = new Set\(\)/);
  assert.match(avatarSource, /camOverlay\.append\(overlayName, cameraStageToggleButton/);
  assert.match(avatarSource, /controls\.append\(cameraStageToggleButton\)/);
  assert.match(avatarSource, /settingsFooter\.append\(settingsWatchButton, settingsCameraStageButton\)/);
  assert.match(audioSource, /removeCameraStageTile\(identity, \{ clearIntent: false \}\)/);
  assert.match(audioSource, /cameraClearGenerationByIdentity\.get\(identity\) !== generation/);
  assert.match(connectSource, /getRemainingCameraPublicationState\(\s*localParticipant,\s*publication\s*\)/);
  assert.match(connectSource, /handleTrackSubscribed\(track, publication, participant\)/);
  assert.doesNotMatch(connectSource, /handleTrackSubscribed\(track, publication, _effectiveParticipant\)/);
  assert.match(connectSource, /hasCameraStageGenerationMismatch\(/);
  assert.match(connectSource, /isCurrentCameraDisconnectGeneration\(key, participant, newRoom\)/);
  assert.match(connectSource, /ignored stale participant name change/);
  assert.match(connectSource, /function ignoreStaleRoomEvent\(eventName\)/);
  assert.doesNotMatch(connectSource, /ignoreAndroidFirefoxStaleRoomEvent/);
  assert.match(connectSource, /refreshActiveCameraLobbyForRoom\(newRoom\)/);
  assert.match(fs.readFileSync(path.join(__dirname, "participants-grid.js"), "utf8"), /clearCameraLobbyMedia\(\)/);
  assert.match(connectSource, /removeCameraVisualGeneration\(identity, publication, \{ clearIntent: true \}\)/);
  assert.match(connectSource, /removeCameraStageTile\(key, \{ clearIntent: true \}\)/);
});
