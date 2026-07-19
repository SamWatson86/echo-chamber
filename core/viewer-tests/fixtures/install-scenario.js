(function installEchoLayoutScenarioFixture() {
  "use strict";

  function nextFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(resolve);
      });
    });
  }

  function resetRoom() {
    const priorMedia = window.__echoLayoutFixtureMedia;
    if (priorMedia) {
      priorMedia.tracks.forEach(function (track) { track.stop(); });
    }
    window.__echoLayoutFixtureMedia = { canvases: [], tracks: [] };

    if (typeof CHANGELOG_LATEST !== "undefined") {
      localStorage.setItem("echo-changelog-seen", CHANGELOG_LATEST);
    }
    document.querySelectorAll(".whats-new-overlay, .updates-overlay").forEach(function (overlay) {
      overlay.remove();
    });
    document.getElementById("connect-panel").classList.add("hidden");
    document.querySelector(".app > header").classList.add("portal-hidden");
    document.querySelector(".room-panel").classList.remove("hidden");
    document.querySelector(".room-layout").classList.remove("chat-open");
    document.getElementById("chat-panel").classList.add("hidden");
    document.getElementById("user-list").replaceChildren();
    document.getElementById("screen-grid").replaceChildren();
    document.getElementById("camera-lobby-grid").replaceChildren();
    document.getElementById("camera-lobby").classList.add("hidden");

    if (typeof participantCards !== "undefined") participantCards.clear();
    if (typeof participantState !== "undefined") participantState.clear();
    if (typeof screenTileBySid !== "undefined") screenTileBySid.clear();
  }

  function createVideoTrackStub(label, aspectRatio) {
    const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;
    const canvas = document.createElement("canvas");
    if (aspect >= 1) {
      canvas.height = 360;
      canvas.width = Math.round(canvas.height * aspect);
    } else {
      canvas.width = 360;
      canvas.height = Math.round(canvas.width / aspect);
    }
    const context = canvas.getContext("2d");
    context.fillStyle = "#132238";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#38bdf8";
    context.fillRect(0, 0, Math.max(8, canvas.width / 5), canvas.height);

    const stream = canvas.captureStream(1);
    const mediaStreamTrack = stream.getVideoTracks()[0];
    if (!mediaStreamTrack) throw new Error("unable to create fixture video track");

    const track = {
      sid: label,
      mediaStreamTrack: mediaStreamTrack,
      requestKeyFrame: function () {},
    };
    window.__echoLayoutFixtureMedia.canvases.push(canvas);
    window.__echoLayoutFixtureMedia.tracks.push(mediaStreamTrack);
    return { track: track, width: canvas.width, height: canvas.height };
  }

  function exposeFixtureDimensions(video, media) {
    Object.defineProperties(video, {
      videoWidth: { configurable: true, get: function () { return media.width; } },
      videoHeight: { configurable: true, get: function () { return media.height; } },
    });
  }

  const unbrokenDisplayName = "W".repeat(60);

  function makeParticipant(index, longNames, unbrokenNames) {
    if (unbrokenNames) {
      return {
        identity: `layout-fixture-${index}`,
        name: unbrokenDisplayName,
      };
    }
    const suffix = longNames
      ? " — The Fellowship Member With An Intentionally Long Display Name"
      : "";
    return {
      identity: `layout-fixture-${index}`,
      name: `Friend ${index}${suffix}`,
    };
  }

  function addParticipants(count, cameraCount, longNames, unbrokenNames, localCamera) {
    if (typeof ensureParticipantCard !== "function") {
      throw new Error("production ensureParticipantCard renderer is unavailable");
    }
    if (typeof updateAvatarVideo !== "function") {
      throw new Error("production updateAvatarVideo renderer is unavailable");
    }

    let attachedCameras = 0;
    for (let index = 1; index <= count; index += 1) {
      const isLocal = index === 1;
      const cardRef = ensureParticipantCard(
        makeParticipant(index, longNames, unbrokenNames),
        isLocal,
      );
      const shouldAttachCamera = isLocal ? !!localCamera : attachedCameras < cameraCount;
      if (!cardRef || !shouldAttachCamera) continue;

      const media = createVideoTrackStub(`fixture-camera-${index}`, 16 / 9);
      updateAvatarVideo(cardRef, media.track);
      const video = cardRef.avatar.querySelector("video");
      if (!video) throw new Error("production camera renderer did not create a video element");
      exposeFixtureDimensions(video, media);
      video.classList.add("layout-fixture-camera");
      video.setAttribute("aria-label", `${cardRef.card.dataset.identity} camera fixture`);
      if (!isLocal) attachedCameras += 1;
    }
  }

  function addScreenShares(count, aspectRatios) {
    if (typeof addScreenTile !== "function" || typeof createLockedVideoElement !== "function") {
      throw new Error("production screen renderer is unavailable");
    }

    for (let index = 0; index < count; index += 1) {
      const aspectRatio = aspectRatios[index] || 16 / 9;
      const media = createVideoTrackStub(`fixture-screen-${index + 1}`, aspectRatio);
      const video = createLockedVideoElement(media.track);
      exposeFixtureDimensions(video, media);
      video.classList.add("layout-fixture-screen");
      video.setAttribute("aria-label", `screen share ${index + 1}`);
      addScreenTile(`Shared by Friend ${index + 2}`, video, media.track.sid);
    }
  }

  function populateChat(open) {
    const panel = document.getElementById("chat-panel");
    const roomLayout = document.querySelector(".room-layout");
    panel.classList.toggle("hidden", !open);
    roomLayout.classList.toggle("chat-open", open);
    if (!open) return;

    const messages = document.getElementById("chat-messages");
    messages.replaceChildren();
    for (let index = 1; index <= 8; index += 1) {
      const message = document.createElement("div");
      message.className = "chat-message";
      message.textContent = `Friend ${index}: responsive fixture message ${index}`;
      messages.appendChild(message);
    }
    document.getElementById("chat-input").value = "Draft text must survive a resize";
  }

  async function install(options) {
    const scenario = Object.assign({
      participants: 4,
      cameras: 2,
      screenShares: 1,
      shareAspects: [16 / 9],
      chatOpen: false,
      longNames: false,
      localCamera: false,
      unbrokenNames: false,
    }, options || {});

    resetRoom();
    addParticipants(
      scenario.participants,
      scenario.cameras,
      scenario.longNames,
      scenario.unbrokenNames,
      scenario.localCamera,
    );
    addScreenShares(scenario.screenShares, scenario.shareAspects);
    populateChat(scenario.chatOpen);
    await nextFrame();

    return {
      cameraCards: document.querySelectorAll(".user-card.has-camera").length,
      participantCards: document.querySelectorAll(".user-card").length,
      screenTiles: document.querySelectorAll("#screen-grid > .tile").length,
      chatOpen: document.querySelector(".room-layout").classList.contains("chat-open"),
    };
  }

  async function installCameraLobby(options) {
    const scenario = Object.assign({ count: 1 }, options || {});
    const count = Math.max(0, Math.floor(Number(scenario.count) || 0));
    resetRoom();

    const LK = getLiveKitClient();
    const participants = [];
    for (let index = 0; index < count; index += 1) {
      const media = createVideoTrackStub(`fixture-lobby-camera-${index + 1}`, 16 / 9);
      const publication = {
        kind: LK.Track.Kind.Video,
        source: LK.Track.Source.Camera,
        track: media.track,
        trackSid: media.track.sid,
      };
      participants.push({
        identity: `lobby-fixture-${index + 1}`,
        name: `Lobby Friend ${index + 1}`,
        trackPublications: new Map([[publication.trackSid, publication]]),
      });
    }

    room = {
      localParticipant: participants[0] || {
        identity: "lobby-fixture-empty",
        name: "Lobby Friend",
        trackPublications: new Map(),
      },
      remoteParticipants: new Map(
        participants.slice(1).map(function (participant) {
          return [participant.identity, participant];
        })
      ),
    };

    openCameraLobby();
    if (typeof window._echoRecalcCameraLobby === "function") {
      window._echoRecalcCameraLobby();
    }
    await nextFrame();
    await nextFrame();

    return {
      count: document.querySelectorAll("#camera-lobby-grid > .camera-lobby-tile").length,
      panelVisible: !document.getElementById("camera-lobby").classList.contains("hidden"),
    };
  }

  function captureCameraLobbySnapshot() {
    const tiles = Array.from(document.querySelectorAll("#camera-lobby-grid > .camera-lobby-tile"));
    const videos = tiles.map(function (tile) { return tile.querySelector("video"); });
    if (tiles.length === 0 || videos.some(function (video) { return !video; })) {
      throw new Error("camera lobby snapshot requires rendered camera tiles");
    }

    window.__echoCameraLobbySnapshot = {
      tiles: tiles,
      videos: videos,
      streams: videos.map(function (video) { return video.srcObject; }),
      tracks: videos.map(function (video) {
        return video.srcObject && video.srcObject.getVideoTracks()[0];
      }),
    };
    return inspectCameraLobbySnapshot();
  }

  function inspectCameraLobbySnapshot() {
    const saved = window.__echoCameraLobbySnapshot;
    if (!saved) throw new Error("captureCameraLobbySnapshot must be called first");
    const tiles = Array.from(document.querySelectorAll("#camera-lobby-grid > .camera-lobby-tile"));
    const videos = tiles.map(function (tile) { return tile.querySelector("video"); });

    return {
      count: tiles.length,
      streams: saved.streams.every(function (stream, index) {
        return stream === (videos[index] && videos[index].srcObject);
      }),
      tiles: saved.tiles.every(function (tile, index) {
        return tile === tiles[index] && tile.isConnected;
      }),
      trackStates: saved.tracks.map(function (track) { return track && track.readyState; }),
      tracks: saved.tracks.every(function (track, index) {
        return track === (
          videos[index] &&
          videos[index].srcObject &&
          videos[index].srcObject.getVideoTracks()[0]
        );
      }),
      videos: saved.videos.every(function (video, index) {
        return video === videos[index] && video.isConnected;
      }),
    };
  }

  function captureIdentitySnapshot() {
    const participantCard = document.querySelector(".user-card.has-camera");
    const cameraVideo = participantCard && participantCard.querySelector("video");
    const screenTile = document.querySelector("#screen-grid > .tile");
    const screenVideo = screenTile && screenTile.querySelector("video");
    const chatInput = document.getElementById("chat-input");
    const participantIdentity = participantCard && participantCard.dataset.identity;

    if (!participantCard || !cameraVideo || !screenTile || !screenVideo || !chatInput) {
      throw new Error("identity fixture requires a camera, screen share, and Chat input");
    }

    const cameraTrack = cameraVideo.srcObject && cameraVideo.srcObject.getVideoTracks()[0];
    const screenTrack = screenVideo.srcObject && screenVideo.srcObject.getVideoTracks()[0];
    if (!cameraTrack || !screenTrack) {
      throw new Error("production media renderers did not preserve fixture tracks");
    }

    window.__echoLayoutIdentitySnapshot = {
      cameraStream: cameraVideo.srcObject,
      cameraSdkTrack: cameraVideo._lkTrack,
      cameraTrack: cameraTrack,
      cameraVideo: cameraVideo,
      chatInput: chatInput,
      chatPanel: document.getElementById("chat-panel"),
      participantCard: participantCard,
      participantState: participantState.get(participantIdentity),
      screenStream: screenVideo.srcObject,
      screenSdkTrack: screenVideo._lkTrack,
      screenTile: screenTile,
      screenTrack: screenTrack,
      screenVideo: screenVideo,
    };

    return inspectIdentitySnapshot();
  }

  function inspectIdentitySnapshot() {
    const saved = window.__echoLayoutIdentitySnapshot;
    if (!saved) throw new Error("captureIdentitySnapshot must be called first");
    const currentCard = document.querySelector(".user-card.has-camera");
    const currentCameraVideo = currentCard && currentCard.querySelector("video");
    const currentTile = document.querySelector("#screen-grid > .tile");
    const currentScreenVideo = currentTile && currentTile.querySelector("video");
    const participantIdentity = currentCard && currentCard.dataset.identity;

    return {
      cameraStream: saved.cameraStream === (currentCameraVideo && currentCameraVideo.srcObject),
      cameraSdkTrack: saved.cameraSdkTrack === (currentCameraVideo && currentCameraVideo._lkTrack),
      cameraTrack: saved.cameraTrack === (
        currentCameraVideo &&
        currentCameraVideo.srcObject &&
        currentCameraVideo.srcObject.getVideoTracks()[0]
      ),
      cameraTrackState: saved.cameraTrack.readyState,
      cameraVideo: saved.cameraVideo === currentCameraVideo && saved.cameraVideo.isConnected,
      chatFocused: document.activeElement === saved.chatInput,
      chatInput: saved.chatInput === document.getElementById("chat-input") && saved.chatInput.isConnected,
      chatPanel: saved.chatPanel === document.getElementById("chat-panel") && saved.chatPanel.isConnected,
      chatOpen: document.querySelector(".room-layout").classList.contains("chat-open"),
      draft: saved.chatInput.value,
      participantCard: saved.participantCard === currentCard && saved.participantCard.isConnected,
      participantMarker: saved.participantState && saved.participantState.__layoutFixtureMarker,
      participantState: saved.participantState === participantState.get(participantIdentity),
      selectionEnd: saved.chatInput.selectionEnd,
      selectionStart: saved.chatInput.selectionStart,
      screenStream: saved.screenStream === (currentScreenVideo && currentScreenVideo.srcObject),
      screenSdkTrack: saved.screenSdkTrack === (currentScreenVideo && currentScreenVideo._lkTrack),
      screenTile: saved.screenTile === currentTile && saved.screenTile.isConnected,
      screenTrack: saved.screenTrack === (
        currentScreenVideo &&
        currentScreenVideo.srcObject &&
        currentScreenVideo.srcObject.getVideoTracks()[0]
      ),
      screenTrackState: saved.screenTrack.readyState,
      screenVideo: saved.screenVideo === currentScreenVideo && saved.screenVideo.isConnected,
      shareFocused: saved.screenTile.classList.contains("is-focused"),
    };
  }

  function setParticipantMicrophoneState(identity, options) {
    const state = participantState.get(identity);
    if (!state) throw new Error("participant state is unavailable for " + identity);
    const next = Object.assign({ published: false, muted: true }, options || {});
    state.micPublished = !!next.published;
    state.micPublisherMuted = !!next.muted;
    state.micMuted = !!next.muted;
    updateActiveSpeakerUi();
  }

  window.EchoLayoutTestScenario = Object.freeze({
    captureCameraLobbySnapshot: captureCameraLobbySnapshot,
    captureIdentitySnapshot: captureIdentitySnapshot,
    inspectCameraLobbySnapshot: inspectCameraLobbySnapshot,
    inspectIdentitySnapshot: inspectIdentitySnapshot,
    install: install,
    installCameraLobby: installCameraLobby,
    setParticipantMicrophoneState: setParticipantMicrophoneState,
    unbrokenDisplayName: unbrokenDisplayName,
  });
})();
