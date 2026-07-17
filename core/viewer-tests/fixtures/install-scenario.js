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

  function makeParticipant(index, longNames) {
    const suffix = longNames
      ? " — The Fellowship Member With An Intentionally Long Display Name"
      : "";
    return {
      identity: `layout-fixture-${index}`,
      name: `Friend ${index}${suffix}`,
    };
  }

  function addParticipants(count, cameraCount, longNames) {
    if (typeof ensureParticipantCard !== "function") {
      throw new Error("production ensureParticipantCard renderer is unavailable");
    }
    if (typeof updateAvatarVideo !== "function") {
      throw new Error("production updateAvatarVideo renderer is unavailable");
    }

    let attachedCameras = 0;
    for (let index = 1; index <= count; index += 1) {
      const isLocal = index === 1;
      const cardRef = ensureParticipantCard(makeParticipant(index, longNames), isLocal);
      if (!cardRef || isLocal || attachedCameras >= cameraCount) continue;

      const media = createVideoTrackStub(`fixture-camera-${index}`, 16 / 9);
      updateAvatarVideo(cardRef, media.track);
      const video = cardRef.avatar.querySelector("video");
      if (!video) throw new Error("production camera renderer did not create a video element");
      exposeFixtureDimensions(video, media);
      video.classList.add("layout-fixture-camera");
      video.setAttribute("aria-label", `${cardRef.card.dataset.identity} camera fixture`);
      attachedCameras += 1;
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
    }, options || {});

    resetRoom();
    addParticipants(scenario.participants, scenario.cameras, scenario.longNames);
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

  window.EchoLayoutTestScenario = Object.freeze({ install: install });
})();
