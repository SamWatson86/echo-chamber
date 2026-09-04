(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  if (root.EchoPhonePresentation && root.EchoPhonePresentation.__echoPhonePresentationApi) {
    return;
  }

  var api = factory();
  root.EchoPhonePresentation = api;

  if (!root.document) return;

  var environment = {
    navigator: root.navigator,
    isNativeShell: root.__ECHO_NATIVE__ === true,
  };
  if (api.isPhoneBrowser(environment)) {
    root.document.documentElement.dataset.echoPhone = "true";
  }

  function installPhonePresentation() {
    environment.isNativeShell = root.__ECHO_NATIVE__ === true;
    if (!api.isPhoneBrowser(environment)) {
      delete root.document.documentElement.dataset.echoPhone;
      return;
    }
    api.install({ window: root, document: root.document });
  }

  if (root.document.readyState === "loading") {
    root.document.addEventListener("DOMContentLoaded", installPhonePresentation, { once: true });
  } else {
    installPhonePresentation();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var PHONE_SHEET_STORAGE_KEY = "echo-phone-sheet-snap";
  var PHONE_SHEET_SNAPS = Object.freeze(["peek", "half", "full"]);
  var PHONE_SHEET_PEEK_PX = 72;
  var PHONE_SHEET_HALF_RATIO = 0.34;
  var PHONE_STAGE_MIN_PX = 96;
  var installedController = null;

  function isPhoneBrowser(options) {
    var input = options || {};
    if (input.isNativeShell === true) return false;
    var navigatorObject = input.navigator || {};
    if (navigatorObject.userAgentData &&
        typeof navigatorObject.userAgentData.mobile === "boolean") {
      return navigatorObject.userAgentData.mobile;
    }
    var userAgent = String(navigatorObject.userAgent || input.userAgent || "");
    if (/\b(?:iPhone|iPod)\b/i.test(userAgent)) return true;
    if (/\bWindows Phone\b/i.test(userAgent)) return true;
    return /\bAndroid\b/i.test(userAgent) && /\bMobile\b/i.test(userAgent);
  }

  function normalizeSnap(value) {
    return PHONE_SHEET_SNAPS.includes(value) ? value : "half";
  }

  function resolveSheetHeights(workspaceHeight) {
    var height = Math.max(0, Math.round(Number(workspaceHeight) || 0));
    var full = Math.max(0, height - PHONE_STAGE_MIN_PX);
    var peek = Math.min(PHONE_SHEET_PEEK_PX, full);
    var half = Math.round(height * PHONE_SHEET_HALF_RATIO);
    half = Math.max(peek, Math.min(full, half));
    return Object.freeze({ peek: peek, half: half, full: full });
  }

  function nearestSnap(height, heights) {
    var target = Number(height) || 0;
    var resolved = heights || resolveSheetHeights(0);
    return PHONE_SHEET_SNAPS.reduce(function (best, snap) {
      return Math.abs(target - resolved[snap]) < Math.abs(target - resolved[best])
        ? snap
        : best;
    }, "peek");
  }

  function adjacentSnap(snap, direction) {
    var index = PHONE_SHEET_SNAPS.indexOf(normalizeSnap(snap));
    var nextIndex = Math.max(0, Math.min(PHONE_SHEET_SNAPS.length - 1, index + direction));
    return PHONE_SHEET_SNAPS[nextIndex];
  }

  function safeReadSnap(storage) {
    try {
      return normalizeSnap(storage && storage.getItem(PHONE_SHEET_STORAGE_KEY));
    } catch (_error) {
      return "half";
    }
  }

  function safeWriteSnap(storage, snap) {
    try {
      if (storage && typeof storage.setItem === "function") {
        storage.setItem(PHONE_SHEET_STORAGE_KEY, normalizeSnap(snap));
      }
    } catch (_error) {
      // Session storage can be blocked in privacy-restricted browsers.
    }
  }

  function isPortraitViewport(win) {
    try {
      if (typeof win.matchMedia === "function") {
        return win.matchMedia("(orientation: portrait)").matches;
      }
    } catch (_error) {}
    return (Number(win.innerHeight) || 0) >= (Number(win.innerWidth) || 0);
  }

  function viewportSignature(win) {
    var viewport = win.visualViewport;
    if (!viewport) {
      return [Number(win.innerWidth) || 0, Number(win.innerHeight) || 0, 0, 0, 1].join(":");
    }
    return [
      Number(viewport.width) || 0,
      Number(viewport.height) || 0,
      Number(viewport.offsetLeft) || 0,
      Number(viewport.offsetTop) || 0,
      Number(viewport.scale) || 1,
    ].join(":");
  }

  function createFullscreenExitStabilizer(options) {
    var input = options || {};
    var win = input.window;
    var doc = input.document;
    var requestFrame = input.requestFrame || (typeof win.requestAnimationFrame === "function"
      ? win.requestAnimationFrame.bind(win)
      : function (callback) { return win.setTimeout(callback, 16); });
    var setTimer = input.setTimer || win.setTimeout.bind(win);
    var clearTimer = input.clearTimer || win.clearTimeout.bind(win);
    var now = input.now || function () {
      return win.performance && typeof win.performance.now === "function"
        ? win.performance.now()
        : Date.now();
    };
    var sequence = 0;

    return function stabilizeFullscreenExit(context) {
      if (!context || typeof context.isCurrent !== "function") return false;
      var ownSequence = ++sequence;
      var startedAt = now();
      var previousSignature = null;
      var stableFrames = 0;
      var settled = false;
      var capTimer = null;

      function current() {
        return ownSequence === sequence && context.isCurrent() === true;
      }

      function finishSettle() {
        if (settled) return;
        settled = true;
        if (capTimer != null) clearTimer(capTimer);
        if (!current() || doc.fullscreenElement) return;
        if (typeof context.measure === "function") context.measure();
        setTimer(function () {
          if (!current() || doc.fullscreenElement) return;
          var advanced = typeof context.hasAdvanced === "function" && context.hasAdvanced() === true;
          var paused = typeof context.isPaused === "function" && context.isPaused() === true;
          if (!advanced || paused) {
            if (typeof context.recover === "function") context.recover();
          }
        }, 750);
      }

      function inspectFrame() {
        if (settled || !current()) {
          if (capTimer != null) clearTimer(capTimer);
          return;
        }
        if (doc.fullscreenElement) {
          if (now() - startedAt >= 500) finishSettle();
          else requestFrame(inspectFrame);
          return;
        }
        var signature = viewportSignature(win);
        stableFrames = signature === previousSignature ? stableFrames + 1 : 1;
        previousSignature = signature;
        if (stableFrames >= 2 || now() - startedAt >= 500) finishSettle();
        else requestFrame(inspectFrame);
      }

      capTimer = setTimer(finishSettle, 500);
      requestFrame(inspectFrame);
      return true;
    };
  }

  function optionIsEnabled(value) {
    try {
      return typeof value === "function" ? value() === true : value === true;
    } catch (_error) {
      return false;
    }
  }

  function mediaValue(value) {
    return String(value == null ? "" : value).toLowerCase().replace(/[^a-z]/g, "");
  }

  function roomSid(room) {
    return room && (room.sid || room.roomSid) ? String(room.sid || room.roomSid) : null;
  }

  function publicationSid(publication) {
    if (!publication) return null;
    var sid = publication.trackSid || publication.sid || (publication.track && publication.track.sid);
    return sid ? String(sid) : null;
  }

  function participantIdentity(participant) {
    return participant && participant.identity ? String(participant.identity) : "";
  }

  function screenIdentity(participant) {
    var identity = participantIdentity(participant);
    return identity.endsWith("$screen") ? identity.slice(0, -7) : identity;
  }

  function isRemoteScreenVideo(publication, participant, room) {
    if (!publication || !participant || !room) return false;
    if (participant === room.localParticipant) return false;
    var rawIdentity = participantIdentity(participant);
    var localIdentity = participantIdentity(room.localParticipant);
    if (rawIdentity && localIdentity && (rawIdentity === localIdentity || screenIdentity(participant) === localIdentity)) {
      return false;
    }
    var source = mediaValue(publication.source || (publication.track && publication.track.source));
    var kind = mediaValue(publication.kind || (publication.track && publication.track.kind));
    return source === "screenshare" && kind === "video";
  }

  function createPhoneScreenVideoBudget(options) {
    var input = options || {};
    var currentRoom = null;
    var currentRoomSid = null;
    var generation = 0;
    var selected = null;
    var selectionMode = "auto";
    var publications = new Map();

    function isEnabled() {
      return optionIsEnabled(input.isEnabled);
    }

    function isCurrentRoom(candidate) {
      if (!candidate || candidate !== currentRoom) return false;
      var candidateSid = roomSid(candidate);
      if (currentRoomSid && candidateSid !== currentRoomSid) return false;
      if (!currentRoomSid && candidateSid) currentRoomSid = candidateSid;
      return true;
    }

    function isCurrentParticipant(participant, candidateRoom) {
      if (!participant || !isCurrentRoom(candidateRoom)) return false;
      var identity = participantIdentity(participant);
      var remotes = candidateRoom.remoteParticipants;
      if (!remotes || !identity) return true;
      var found = null;
      if (typeof remotes.get === "function") found = remotes.get(identity) || null;
      if (!found && typeof remotes.forEach === "function") {
        remotes.forEach(function (candidate) {
          if (!found && participantIdentity(candidate) === identity) found = candidate;
        });
      }
      return found === participant;
    }

    function chooseFallback() {
      if (selectionMode === "hidden") {
        selected = null;
        return;
      }
      if (selected && publications.has(selected)) return;
      selected = publications.size ? publications.keys().next().value : null;
      selectionMode = "auto";
    }

    function beginRoom(nextRoom) {
      if (!isEnabled() || !nextRoom) return false;
      var nextSid = roomSid(nextRoom);
      if (nextRoom === currentRoom && (!currentRoomSid || !nextSid || currentRoomSid === nextSid)) {
        if (!currentRoomSid && nextSid) currentRoomSid = nextSid;
        return false;
      }
      generation += 1;
      currentRoom = nextRoom;
      currentRoomSid = nextSid;
      selected = null;
      selectionMode = "auto";
      publications.clear();
      return true;
    }

    function clearRoom(candidateRoom) {
      if (!isCurrentRoom(candidateRoom)) return false;
      generation += 1;
      currentRoom = null;
      currentRoomSid = null;
      selected = null;
      selectionMode = "auto";
      publications.clear();
      return true;
    }

    function observe(publication, participant, candidateRoom) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom) ||
          !isRemoteScreenVideo(publication, participant, candidateRoom) ||
          !isCurrentParticipant(participant, candidateRoom)) return false;
      var identity = screenIdentity(participant);
      var sid = publicationSid(publication);
      if (!identity || !sid) return false;
      var previous = publications.get(identity) || null;
      if (previous && previous.publication === publication && previous.participant === participant &&
          previous.sid === sid && previous.generation === generation) return false;
      publications.set(identity, {
        identity: identity,
        participant: participant,
        publication: publication,
        sid: sid,
        generation: generation,
      });
      if (selectionMode === "auto" && !selected) selected = identity;
      chooseFallback();
      return true;
    }

    function forget(publication, participant, candidateRoom) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom)) return false;
      var identity = screenIdentity(participant);
      var entry = publications.get(identity);
      if (!entry || entry.generation !== generation || entry.participant !== participant ||
          entry.publication !== publication || entry.sid !== publicationSid(publication)) return false;
      publications.delete(identity);
      chooseFallback();
      return true;
    }

    function forgetParticipant(participant, candidateRoom) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom)) return false;
      var removed = false;
      publications.forEach(function (entry, identity) {
        if (entry.generation === generation && entry.participant === participant) {
          publications.delete(identity);
          removed = true;
        }
      });
      if (!removed) return false;
      chooseFallback();
      return true;
    }

    function selectIdentity(identity, candidateRoom) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom)) return false;
      var normalized = String(identity || "");
      if (normalized.endsWith("$screen")) normalized = normalized.slice(0, -7);
      if (!publications.has(normalized)) return false;
      selected = normalized;
      selectionMode = "selected";
      return true;
    }

    function hide(candidateRoom) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom)) return false;
      selected = null;
      selectionMode = "hidden";
      return true;
    }

    function selectedIdentity(candidateRoom) {
      return isEnabled() && isCurrentRoom(candidateRoom) ? selected : null;
    }

    function isSelected(publication, participant, candidateRoom) {
      if (!isEnabled()) return true;
      if (!isCurrentRoom(candidateRoom) || !selected) return false;
      var identity = screenIdentity(participant);
      var entry = publications.get(identity);
      return !!entry && identity === selected && entry.generation === generation &&
        entry.participant === participant && entry.publication === publication &&
        entry.sid === publicationSid(publication) && isCurrentParticipant(participant, candidateRoom);
    }

    function entries(candidateRoom) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom)) return Object.freeze([]);
      return Object.freeze(Array.from(publications.values()));
    }

    function reconcile(observations, candidateRoom) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom)) return false;
      var list = Array.isArray(observations) ? observations : [];
      var seen = new Set();
      list.forEach(function (item) {
        if (!item) return;
        observe(item.publication, item.participant, candidateRoom);
        var identity = screenIdentity(item.participant);
        var entry = publications.get(identity);
        if (entry && entry.publication === item.publication && entry.participant === item.participant) {
          seen.add(entry.identity + "\n" + entry.sid);
        }
      });
      publications.forEach(function (entry, identity) {
        if (!seen.has(entry.identity + "\n" + entry.sid)) publications.delete(identity);
      });
      chooseFallback();
      return true;
    }

    return Object.freeze({
      beginRoom: beginRoom,
      clearRoom: clearRoom,
      entries: entries,
      forget: forget,
      forgetParticipant: forgetParticipant,
      hide: hide,
      isSelected: isSelected,
      observe: observe,
      reconcile: reconcile,
      selectIdentity: selectIdentity,
      selectedIdentity: selectedIdentity,
    });
  }

  function createPhoneWakeLockManager(options) {
    var input = options || {};
    var navigatorObject = input.navigator || {};
    var doc = input.document || {};
    var win = input.window || {};
    var currentRoom = null;
    var generation = 0;
    var sentinel = null;
    var sentinelRoom = null;
    var requestFlight = null;
    var listening = false;
    var pageHidden = false;

    function isEnabled() {
      return optionIsEnabled(input.isEnabled);
    }

    function log(message, error) {
      try {
        if (typeof input.log === "function") input.log(message, error);
      } catch (_error) {}
    }

    function isVisible() {
      if (pageHidden) return false;
      if (doc.visibilityState) return doc.visibilityState === "visible";
      return doc.hidden !== true;
    }

    function isCurrentRoom(candidate, expectedGeneration) {
      if (!candidate || candidate !== currentRoom) return false;
      if (expectedGeneration != null && expectedGeneration !== generation) return false;
      return true;
    }

    function releaseSentinel(expectedSentinel) {
      var target = expectedSentinel || sentinel;
      if (!target) return Promise.resolve(false);
      if (sentinel === target) {
        sentinel = null;
        sentinelRoom = null;
      }
      return Promise.resolve().then(function () {
        return typeof target.release === "function" ? target.release() : undefined;
      }).then(function () {
        return true;
      }, function (error) {
        log("[phone-wake-lock] release failed", error);
        return false;
      });
    }

    function bindSentinelRelease(target, targetRoom) {
      if (!target || typeof target.addEventListener !== "function") return;
      target.addEventListener("release", function () {
        if (sentinel === target && sentinelRoom === targetRoom) {
          sentinel = null;
          sentinelRoom = null;
        }
      }, { once: true });
    }

    function requestFor(candidateRoom, expectedGeneration) {
      if (!isEnabled() || !isVisible() || !isCurrentRoom(candidateRoom, expectedGeneration) ||
          !navigatorObject.wakeLock || typeof navigatorObject.wakeLock.request !== "function") {
        return Promise.resolve(false);
      }
      if (sentinel && sentinelRoom === candidateRoom && sentinel.released !== true) {
        return Promise.resolve(true);
      }
      if (requestFlight) {
        if (requestFlight.room === candidateRoom && requestFlight.generation === expectedGeneration) {
          return requestFlight.promise;
        }
        return requestFlight.promise.then(function () {
          return requestFor(candidateRoom, expectedGeneration);
        });
      }
      var flight = { room: candidateRoom, generation: expectedGeneration, promise: null };
      flight.promise = Promise.resolve().then(function () {
        return navigatorObject.wakeLock.request("screen");
      }).then(function (nextSentinel) {
        if (!nextSentinel) return false;
        if (!isEnabled() || !isVisible() || !isCurrentRoom(candidateRoom, expectedGeneration)) {
          return releaseSentinel(nextSentinel).then(function () { return false; });
        }
        if (sentinel && sentinel !== nextSentinel) releaseSentinel(sentinel);
        sentinel = nextSentinel;
        sentinelRoom = candidateRoom;
        bindSentinelRelease(nextSentinel, candidateRoom);
        return true;
      }, function (error) {
        log("[phone-wake-lock] request failed", error);
        return false;
      }).finally(function () {
        if (requestFlight === flight) requestFlight = null;
      });
      requestFlight = flight;
      return flight.promise;
    }

    function onVisibilityChange() {
      var candidateRoom = currentRoom;
      var expectedGeneration = generation;
      if (!candidateRoom) return;
      if (isVisible()) requestFor(candidateRoom, expectedGeneration);
      else releaseSentinel(sentinel);
    }

    function onPageShow() {
      pageHidden = false;
      if (currentRoom && isVisible()) requestFor(currentRoom, generation);
    }

    function onPageHide() {
      pageHidden = true;
      releaseSentinel(sentinel);
    }

    function addListeners() {
      if (listening) return;
      listening = true;
      if (typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onVisibilityChange);
      if (typeof win.addEventListener === "function") {
        win.addEventListener("pageshow", onPageShow);
        win.addEventListener("pagehide", onPageHide);
      }
    }

    function removeListeners() {
      if (!listening) return;
      listening = false;
      if (typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", onVisibilityChange);
      if (typeof win.removeEventListener === "function") {
        win.removeEventListener("pageshow", onPageShow);
        win.removeEventListener("pagehide", onPageHide);
      }
    }

    function setRoom(nextRoom) {
      if (!isEnabled() || !nextRoom) return Promise.resolve(false);
      if (isCurrentRoom(nextRoom)) {
        addListeners();
        return isVisible() ? requestFor(nextRoom, generation) : Promise.resolve(false);
      }
      var previousSentinel = sentinel;
      var transferableSentinel = isVisible() && sentinel && sentinel.released !== true
        ? sentinel
        : null;
      generation += 1;
      currentRoom = nextRoom;
      // A never-settling request from the old Room must not serialize the new
      // Room. Its own generation guard will release any late grant.
      requestFlight = null;
      addListeners();
      var ownGeneration = generation;
      if (transferableSentinel) {
        sentinelRoom = nextRoom;
        bindSentinelRelease(transferableSentinel, nextRoom);
        return Promise.resolve(true);
      }
      return releaseSentinel(previousSentinel).then(function () {
        return isVisible() ? requestFor(nextRoom, ownGeneration) : false;
      });
    }

    function clearRoom(candidateRoom) {
      if (!isCurrentRoom(candidateRoom)) return Promise.resolve(false);
      var previousSentinel = sentinel;
      generation += 1;
      currentRoom = null;
      requestFlight = null;
      removeListeners();
      pageHidden = false;
      return releaseSentinel(previousSentinel);
    }

    return Object.freeze({
      clearRoom: clearRoom,
      setRoom: setRoom,
    });
  }

  function createPhoneAudioPlaybackRecovery(options) {
    var input = options || {};
    var currentRoom = null;
    var currentRoomSid = null;
    var generation = 0;
    var blocked = false;
    var queuedAudio = new Set();
    var fallbackPending = new Set();
    var recoveryFlight = null;
    var lastPromptSignature = null;

    function isEnabled() {
      return optionIsEnabled(input.isEnabled);
    }

    function log(message, error) {
      try {
        if (typeof input.log === "function") input.log(message, error);
      } catch (_error) {}
    }

    function actualRoom() {
      try {
        return typeof input.getCurrentRoom === "function" ? input.getCurrentRoom() : currentRoom;
      } catch (_error) {
        return null;
      }
    }

    function isCurrentRoom(candidate, expectedGeneration) {
      if (!candidate || candidate !== currentRoom || actualRoom() !== candidate) return false;
      if (expectedGeneration != null && expectedGeneration !== generation) return false;
      var candidateSid = roomSid(candidate);
      if (currentRoomSid && candidateSid !== currentRoomSid) return false;
      if (!currentRoomSid && candidateSid) currentRoomSid = candidateSid;
      return true;
    }

    function pendingElements() {
      try {
        var pending = typeof input.getPendingElements === "function" ? input.getPendingElements() : null;
        if (pending && typeof pending.add === "function" && typeof pending.delete === "function") return pending;
      } catch (_error) {}
      return fallbackPending;
    }

    function audioElements(candidateRoom) {
      var value;
      try {
        value = typeof input.getAudioElements === "function" ? input.getAudioElements(candidateRoom) : [];
      } catch (error) {
        log("[phone-audio] could not enumerate audio elements", error);
        return [];
      }
      if (value && typeof value.values === "function" && !Array.isArray(value)) value = value.values();
      try {
        return Array.from(value || []).filter(function (element) {
          return !!element && element.isConnected !== false;
        });
      } catch (_error) {
        return [];
      }
    }

    function syncPrompt() {
      if (!isEnabled()) return;
      var pending = pendingElements();
      var state = Object.freeze({
        visible: blocked || Number(pending.size || 0) > 0,
        label: blocked ? "Restore audio" : "Enable Videos",
        blocked: blocked,
      });
      var signature = [state.visible, state.label, state.blocked].join(":");
      if (signature === lastPromptSignature) return;
      lastPromptSignature = signature;
      try {
        if (typeof input.onPromptChange === "function") input.onPromptChange(state);
      } catch (error) {
        log("[phone-audio] prompt update failed", error);
      }
    }

    function removeQueuedAudio() {
      var pending = pendingElements();
      queuedAudio.forEach(function (element) { pending.delete(element); });
      queuedAudio.clear();
    }

    function prunePendingElements(removeAll) {
      var pending = pendingElements();
      Array.from(pending).forEach(function (element) {
        if (removeAll || !element || element.isConnected === false) {
          pending.delete(element);
          queuedAudio.delete(element);
        }
      });
    }

    function queueCurrentAudio(candidateRoom) {
      if (!isCurrentRoom(candidateRoom)) return false;
      var pending = pendingElements();
      audioElements(candidateRoom).forEach(function (element) {
        queuedAudio.add(element);
        pending.add(element);
      });
      blocked = true;
      syncPrompt();
      return true;
    }

    function confirmRecovery(candidateRoom, expectedGeneration) {
      if (!isCurrentRoom(candidateRoom, expectedGeneration) || candidateRoom.canPlaybackAudio !== true) {
        return false;
      }
      removeQueuedAudio();
      blocked = false;
      syncPrompt();
      return true;
    }

    function setRoom(nextRoom) {
      if (!isEnabled() || !nextRoom) return false;
      var nextSid = roomSid(nextRoom);
      if (isCurrentRoom(nextRoom)) return false;
      removeQueuedAudio();
      prunePendingElements(false);
      generation += 1;
      currentRoom = nextRoom;
      currentRoomSid = nextSid;
      recoveryFlight = null;
      blocked = false;
      lastPromptSignature = null;
      syncPrompt();
      return true;
    }

    function clearRoom(candidateRoom) {
      if (!isCurrentRoom(candidateRoom)) return false;
      removeQueuedAudio();
      prunePendingElements(true);
      generation += 1;
      currentRoom = null;
      currentRoomSid = null;
      recoveryFlight = null;
      blocked = false;
      lastPromptSignature = null;
      syncPrompt();
      return true;
    }

    function handlePlaybackStatus(candidateRoom, canPlay) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom)) return false;
      if (canPlay === false) return queueCurrentAudio(candidateRoom);
      if (canPlay === true) return confirmRecovery(candidateRoom, generation);
      return false;
    }

    function noteStartAudioFailure(candidateRoom, error) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom)) return false;
      log("[phone-audio] startAudio failed", error);
      return queueCurrentAudio(candidateRoom);
    }

    function recover(candidateRoom) {
      if (!isEnabled() || !isCurrentRoom(candidateRoom)) {
        return Promise.resolve(false);
      }
      var ownGeneration = generation;
      if (recoveryFlight) {
        if (recoveryFlight.room === candidateRoom && recoveryFlight.generation === ownGeneration) {
          return recoveryFlight.promise;
        }
        recoveryFlight = null;
      }
      var flight = { room: candidateRoom, generation: ownGeneration, promise: null };
      recoveryFlight = flight;
      prunePendingElements(false);
      var pending = pendingElements();
      // LiveKit's startAudio() owns audio playback. Retry only the legacy
      // pending non-audio media here so the phone gesture still resumes video
      // without racing a second play() against every audio element.
      var playbackAttempts = Array.from(pending).filter(function (element) {
        return !queuedAudio.has(element);
      }).map(function (element) {
        var playback;
        try {
          playback = element && typeof element.play === "function"
            ? element.play()
            : Promise.reject(new Error("pending media element has no play method"));
        } catch (error) {
          playback = Promise.reject(error);
        }
        return Promise.resolve(playback).then(function () {
          if (isCurrentRoom(candidateRoom, ownGeneration)) {
            pendingElements().delete(element);
            queuedAudio.delete(element);
          }
          return true;
        }, function (error) {
          log("[phone-audio] pending media play failed", error);
          if (!element || element.isConnected === false) pendingElements().delete(element);
          return false;
        });
      });
      var startAudio;
      try {
        startAudio = typeof candidateRoom.startAudio === "function"
          ? candidateRoom.startAudio()
          : Promise.reject(new Error("room.startAudio is unavailable"));
      } catch (error) {
        startAudio = Promise.reject(error);
      }
      var startAttempt = Promise.resolve(startAudio).then(function () {
        return { ok: true, error: null };
      }, function (error) {
        return { ok: false, error: error };
      });
      flight.promise = Promise.all([Promise.all(playbackAttempts), startAttempt]).then(function (results) {
        if (!isCurrentRoom(candidateRoom, ownGeneration)) return false;
        var startResult = results[1];
        if (startResult.ok && confirmRecovery(candidateRoom, ownGeneration)) return true;
        if (startResult.ok) queueCurrentAudio(candidateRoom);
        else noteStartAudioFailure(candidateRoom, startResult.error);
        syncPrompt();
        return false;
      }).finally(function () {
        if (recoveryFlight === flight) recoveryFlight = null;
      });
      return flight.promise;
    }

    function isBlocked(candidateRoom) {
      return isEnabled() && isCurrentRoom(candidateRoom) && blocked;
    }

    return Object.freeze({
      clearRoom: clearRoom,
      handlePlaybackStatus: handlePlaybackStatus,
      isBlocked: isBlocked,
      noteStartAudioFailure: noteStartAudioFailure,
      recover: recover,
      setRoom: setRoom,
    });
  }

  function createSheetToolbar(doc) {
    var toolbar = doc.createElement("div");
    toolbar.className = "phone-sheet-toolbar";
    toolbar.hidden = true;

    var handle = doc.createElement("div");
    handle.className = "phone-sheet-handle";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-label", "Resize People and Tools panel");

    var grip = doc.createElement("span");
    grip.className = "phone-sheet-grip";
    grip.setAttribute("aria-hidden", "true");
    var label = doc.createElement("span");
    label.className = "phone-sheet-label";
    label.textContent = "People & Tools";
    handle.append(grip, label);

    var minimize = doc.createElement("button");
    minimize.type = "button";
    minimize.className = "phone-sheet-minimize";
    minimize.textContent = "−";
    minimize.title = "Make People and Tools smaller";
    minimize.setAttribute("aria-label", "Make People and Tools smaller");

    var expand = doc.createElement("button");
    expand.type = "button";
    expand.className = "phone-sheet-expand";
    expand.textContent = "+";
    expand.title = "Make People and Tools larger";
    expand.setAttribute("aria-label", "Make People and Tools larger");

    toolbar.append(handle, minimize, expand);
    return { toolbar: toolbar, handle: handle, minimize: minimize, expand: expand };
  }

  function createPhonePresentationController(options) {
    var input = options || {};
    var win = input.window;
    var doc = input.document;
    var rootElement = doc && doc.documentElement;
    var workspace = doc && doc.querySelector('[data-ui-region="workspace"]');
    var utilityHost = doc && doc.getElementById("utility-host");
    var peoplePanel = doc && doc.getElementById("room-sidebar");
    if (!win || !doc || !rootElement || !workspace || !utilityHost || !peoplePanel) {
      throw new Error("Echo phone presentation requires the connected shell DOM");
    }

    var requestFrame = typeof win.requestAnimationFrame === "function"
      ? win.requestAnimationFrame.bind(win)
      : function (callback) { return win.setTimeout(callback, 0); };
    var cancelFrame = typeof win.cancelAnimationFrame === "function"
      ? win.cancelAnimationFrame.bind(win)
      : function (handle) { win.clearTimeout(handle); };
    var controls = createSheetToolbar(doc);
    var contentNodes = Array.from(peoplePanel.children);
    peoplePanel.insertBefore(controls.toolbar, peoplePanel.firstChild || null);
    var snap = safeReadSnap(win.sessionStorage);
    var scheduledFrame = null;
    var started = false;
    var drag = null;
    var latestHeights = resolveSheetHeights(0);
    var workspaceResizeObserver = null;
    var stabilizeFullscreenExit = createFullscreenExitStabilizer({ window: win, document: doc });

    function workspaceHeight() {
      var clientHeight = Number(workspace.clientHeight) || 0;
      if (clientHeight > 0) return clientHeight;
      var rect = typeof workspace.getBoundingClientRect === "function"
        ? workspace.getBoundingClientRect()
        : null;
      return Number(rect && rect.height) || 0;
    }

    function isSheetActive() {
      return rootElement.dataset.uiShell === "v2" && isPortraitViewport(win);
    }

    function syncPeekAccessibility() {
      var hideContent = isSheetActive() && snap === "peek";
      contentNodes.forEach(function (node) {
        node.inert = hideContent;
        if (hideContent) node.setAttribute("aria-hidden", "true");
        else node.removeAttribute("aria-hidden");
      });
    }

    function syncControls() {
      var index = PHONE_SHEET_SNAPS.indexOf(snap);
      controls.handle.setAttribute("aria-valuemin", "0");
      controls.handle.setAttribute("aria-valuemax", String(PHONE_SHEET_SNAPS.length - 1));
      controls.handle.setAttribute("aria-valuenow", String(index));
      controls.handle.setAttribute("aria-valuetext", snap);
      controls.minimize.disabled = index === 0;
      controls.expand.disabled = index === PHONE_SHEET_SNAPS.length - 1;
      syncPeekAccessibility();
    }

    function measureNow() {
      var portrait = isPortraitViewport(win);
      rootElement.dataset.echoPhoneOrientation = portrait ? "portrait" : "landscape";
      controls.toolbar.hidden = !(portrait && rootElement.dataset.uiShell === "v2");
      if (!isSheetActive()) {
        utilityHost.style.removeProperty("--echo-phone-sheet-height");
        syncPeekAccessibility();
        return null;
      }
      var measuredWorkspaceHeight = workspaceHeight();
      rootElement.dataset.echoPhoneSheetSnap = snap;
      if (measuredWorkspaceHeight <= 0) {
        utilityHost.style.removeProperty("--echo-phone-sheet-height");
        syncControls();
        return Object.freeze({ snap: snap, height: null, heights: latestHeights });
      }
      latestHeights = resolveSheetHeights(measuredWorkspaceHeight);
      utilityHost.style.setProperty("--echo-phone-sheet-height", latestHeights[snap] + "px");
      syncControls();
      return Object.freeze({ snap: snap, height: latestHeights[snap], heights: latestHeights });
    }

    function scheduleMeasure() {
      if (scheduledFrame != null) return;
      scheduledFrame = requestFrame(function () {
        scheduledFrame = null;
        measureNow();
      });
    }

    function setSnap(nextSnap, persist) {
      snap = normalizeSnap(nextSnap);
      if (persist !== false) safeWriteSnap(win.sessionStorage, snap);
      measureNow();
      return snap;
    }

    function onHandleKeydown(event) {
      var next = null;
      if (event.key === "ArrowUp") next = adjacentSnap(snap, 1);
      else if (event.key === "ArrowDown") next = adjacentSnap(snap, -1);
      else if (event.key === "Home") next = "peek";
      else if (event.key === "End") next = "full";
      if (!next) return;
      event.preventDefault();
      setSnap(next);
    }

    function onPointerDown(event) {
      if (!isSheetActive() || (event.button != null && event.button !== 0)) return;
      latestHeights = resolveSheetHeights(workspaceHeight());
      drag = {
        pointerId: event.pointerId,
        startY: Number(event.clientY) || 0,
        startHeight: latestHeights[snap],
        currentHeight: latestHeights[snap],
      };
      rootElement.setAttribute("data-echo-phone-sheet-dragging", "");
      if (typeof controls.handle.setPointerCapture === "function") {
        try { controls.handle.setPointerCapture(event.pointerId); } catch (_error) {}
      }
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId || !isSheetActive()) return;
      var desired = drag.startHeight + drag.startY - (Number(event.clientY) || 0);
      drag.currentHeight = Math.max(latestHeights.peek, Math.min(latestHeights.full, desired));
      utilityHost.style.setProperty("--echo-phone-sheet-height", Math.round(drag.currentHeight) + "px");
      event.preventDefault();
    }

    function finishPointer(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      var finalHeight = drag.currentHeight;
      drag = null;
      rootElement.removeAttribute("data-echo-phone-sheet-dragging");
      setSnap(nearestSnap(finalHeight, latestHeights));
      event.preventDefault();
    }

    function start() {
      if (started) return measureNow();
      started = true;
      rootElement.dataset.echoPhone = "true";
      controls.handle.addEventListener("keydown", onHandleKeydown);
      controls.handle.addEventListener("pointerdown", onPointerDown);
      controls.handle.addEventListener("pointermove", onPointerMove);
      controls.handle.addEventListener("pointerup", finishPointer);
      controls.handle.addEventListener("pointercancel", finishPointer);
      controls.minimize.addEventListener("click", function () { setSnap(adjacentSnap(snap, -1)); });
      controls.expand.addEventListener("click", function () { setSnap(adjacentSnap(snap, 1)); });
      win.addEventListener("resize", scheduleMeasure, { passive: true });
      win.addEventListener("orientationchange", scheduleMeasure, { passive: true });
      win.addEventListener("echo:ui-shell-change", scheduleMeasure);
      if (win.visualViewport && typeof win.visualViewport.addEventListener === "function") {
        win.visualViewport.addEventListener("resize", scheduleMeasure, { passive: true });
      }
      if (typeof win.ResizeObserver === "function") {
        workspaceResizeObserver = new win.ResizeObserver(scheduleMeasure);
        workspaceResizeObserver.observe(workspace);
      }
      return measureNow();
    }

    function stop() {
      if (!started) return;
      started = false;
      win.removeEventListener("resize", scheduleMeasure);
      win.removeEventListener("orientationchange", scheduleMeasure);
      win.removeEventListener("echo:ui-shell-change", scheduleMeasure);
      if (win.visualViewport && typeof win.visualViewport.removeEventListener === "function") {
        win.visualViewport.removeEventListener("resize", scheduleMeasure);
      }
      if (workspaceResizeObserver) workspaceResizeObserver.disconnect();
      workspaceResizeObserver = null;
      if (scheduledFrame != null) cancelFrame(scheduledFrame);
      scheduledFrame = null;
      controls.toolbar.remove();
      utilityHost.style.removeProperty("--echo-phone-sheet-height");
      delete rootElement.dataset.echoPhoneOrientation;
      delete rootElement.dataset.echoPhoneSheetSnap;
      rootElement.removeAttribute("data-echo-phone-sheet-dragging");
      contentNodes.forEach(function (node) {
        node.inert = false;
        node.removeAttribute("aria-hidden");
      });
    }

    return Object.freeze({
      isPhone: function () { return true; },
      measureNow: measureNow,
      setSnap: setSnap,
      snap: function () { return snap; },
      stabilizeFullscreenExit: stabilizeFullscreenExit,
      start: start,
      stop: stop,
    });
  }

  function install(options) {
    if (installedController) return installedController;
    var input = options || {};
    if (!isPhoneBrowser({
      navigator: input.window && input.window.navigator,
      isNativeShell: input.window && input.window.__ECHO_NATIVE__ === true,
    })) return null;
    installedController = createPhonePresentationController(input);
    installedController.start();
    return installedController;
  }

  function isPhone() {
    return !!installedController;
  }

  function stabilizeFullscreenExit(context) {
    if (!installedController) return false;
    return installedController.stabilizeFullscreenExit(context);
  }

  return Object.freeze({
    __echoPhonePresentationApi: true,
    PHONE_SHEET_SNAPS: PHONE_SHEET_SNAPS,
    adjacentSnap: adjacentSnap,
    createFullscreenExitStabilizer: createFullscreenExitStabilizer,
    createPhoneAudioPlaybackRecovery: createPhoneAudioPlaybackRecovery,
    createPhonePresentationController: createPhonePresentationController,
    createPhoneScreenVideoBudget: createPhoneScreenVideoBudget,
    createPhoneWakeLockManager: createPhoneWakeLockManager,
    install: install,
    isPhone: isPhone,
    isPhoneBrowser: isPhoneBrowser,
    nearestSnap: nearestSnap,
    normalizeSnap: normalizeSnap,
    resolveSheetHeights: resolveSheetHeights,
    stabilizeFullscreenExit: stabilizeFullscreenExit,
  });
});
