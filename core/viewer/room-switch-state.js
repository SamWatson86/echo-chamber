(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EchoRoomSwitchState = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function createRoomSwitchState(options) {
    const opts = options || {};
    const initialRoomName = opts.initialRoomName || "main";
    const cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : 500;

    const state = {
      connectedRoomName: initialRoomName,
      activeRoomName: initialRoomName,
      pendingRoomName: null,
      isSwitching: false,
      lastSwitchRequestedAt: 0,
      cooldownMs,
    };

    function canRequestSwitch(targetRoomName, nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      if (!targetRoomName) {
        return { ok: false, reason: "invalid-target" };
      }
      if (targetRoomName === state.activeRoomName) {
        return { ok: false, reason: "same-room" };
      }
      if (state.isSwitching) {
        return { ok: false, reason: "in-flight" };
      }
      if (now - state.lastSwitchRequestedAt < state.cooldownMs) {
        return { ok: false, reason: "cooldown" };
      }
      return { ok: true };
    }

    function requestSwitch(targetRoomName, nowMs) {
      const check = canRequestSwitch(targetRoomName, nowMs);
      if (!check.ok) {
        return check;
      }
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      const fromRoom = state.activeRoomName;
      state.pendingRoomName = targetRoomName;
      state.activeRoomName = targetRoomName; // optimistic UI
      state.isSwitching = true;
      state.lastSwitchRequestedAt = now;
      return { ok: true, fromRoom, toRoom: targetRoomName };
    }

    function markConnected(connectedRoomName) {
      // Ignore stale "connected" callbacks that can arrive out-of-order while a
      // switch is in-flight (e.g. old room emits connected after new room switch
      // already started). Only the pending target is allowed to commit the switch.
      if (
        state.isSwitching &&
        connectedRoomName &&
        state.pendingRoomName &&
        connectedRoomName !== state.pendingRoomName
      ) {
        return state.activeRoomName;
      }

      // Once a room is force-committed, late callbacks from superseded rooms should
      // not roll us backward. Accept explicit callbacks only when they match the
      // current settled room (or when a switch is still pending above).
      if (
        !state.isSwitching &&
        !state.pendingRoomName &&
        connectedRoomName &&
        connectedRoomName !== state.activeRoomName
      ) {
        return state.activeRoomName;
      }

      const nextRoom = connectedRoomName || state.pendingRoomName || state.activeRoomName;
      state.connectedRoomName = nextRoom;
      state.activeRoomName = nextRoom;
      state.pendingRoomName = null;
      state.isSwitching = false;
      return nextRoom;
    }

    function markFailed() {
      state.pendingRoomName = null;
      state.activeRoomName = state.connectedRoomName;
      state.isSwitching = false;
      return state.activeRoomName;
    }

    function forceConnected(roomName) {
      if (!roomName) return state.connectedRoomName;
      state.connectedRoomName = roomName;
      state.activeRoomName = roomName;
      state.pendingRoomName = null;
      state.isSwitching = false;
      return roomName;
    }

    function heartbeatRoomName() {
      // Important invariant: heartbeat should represent actual connected room,
      // not optimistic target while a switch is still in-flight.
      return state.connectedRoomName || state.activeRoomName;
    }

    function snapshot() {
      return {
        connectedRoomName: state.connectedRoomName,
        activeRoomName: state.activeRoomName,
        pendingRoomName: state.pendingRoomName,
        isSwitching: state.isSwitching,
        lastSwitchRequestedAt: state.lastSwitchRequestedAt,
        cooldownMs: state.cooldownMs,
      };
    }

    return {
      canRequestSwitch,
      requestSwitch,
      markConnected,
      markFailed,
      forceConnected,
      heartbeatRoomName,
      snapshot,
    };
  }

  function commitConnectedAccessToken(tokenCache, roomId, accessToken) {
    if (!accessToken) {
      throw new Error("Cannot commit an empty room access token");
    }
    if (tokenCache && typeof tokenCache.delete === "function") {
      tokenCache.delete(roomId);
    }
    return accessToken;
  }

  function resolvePostConnectMicrophoneBehavior(options) {
    const opts = options || {};
    const restoreMic = opts.reuseAdmin === true && opts.micWasEnabled === true;
    return {
      restoreMic,
      preserveMutedMic: opts.reuseAdmin === true &&
        opts.preserveMicIntent === true &&
        !restoreMic,
    };
  }

  const ANDROID_FIREFOX_CANDIDATE_RELEASE_ERROR_CODE =
    "ANDROID_FIREFOX_REJECTED_CANDIDATE_RELEASE_UNPROVEN";

  function createAndroidFirefoxCandidateReleaseError(message, cause) {
    const error = new Error(message);
    error.name = "AndroidFirefoxCandidateReleaseError";
    error.code = ANDROID_FIREFOX_CANDIDATE_RELEASE_ERROR_CODE;
    error.terminal = true;
    error.retryable = false;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function isAndroidFirefoxCandidateReleaseError(error) {
    return !!error &&
      error.name === "AndroidFirefoxCandidateReleaseError" &&
      error.code === ANDROID_FIREFOX_CANDIDATE_RELEASE_ERROR_CODE &&
      error.terminal === true &&
      error.retryable === false;
  }

  async function disconnectAndroidFirefoxRecoverySource(sourceRoom, options) {
    if (!sourceRoom || typeof sourceRoom.disconnect !== "function") {
      throw new Error("Android Firefox recovery source Room is unavailable");
    }

    const opts = options || {};
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0
      ? opts.timeoutMs
      : 1500;
    const schedule = typeof opts.schedule === "function" ? opts.schedule : setTimeout;
    const cancelSchedule = typeof opts.cancelSchedule === "function" ? opts.cancelSchedule : clearTimeout;

    sourceRoom._echoRecoveryDisconnect = true;
    sourceRoom._echoExpectedDisconnect = true;
    if (sourceRoom._echoRecoveryDisconnectComplete === true ||
        sourceRoom._echoRecoveryDisconnectReleased === true) {
      return false;
    }

    let disconnectPromise = sourceRoom._echoRecoveryDisconnectPromise;
    if (!disconnectPromise) {
      disconnectPromise = (async function() {
        let timeoutId = null;
        const disconnectOutcome = (async function() {
          await sourceRoom.disconnect(true);
          sourceRoom._echoRecoveryDisconnectComplete = true;
          return { completed: true };
        })()
          .then(undefined, function(error) {
            // Convert a late rejection into data so a teardown that rejects
            // after the deadline cannot become an unhandled Promise.
            return { completed: false, rejected: true, error: error };
          });
        const deadline = new Promise(function(resolve) {
          timeoutId = schedule(function() {
            resolve({ completed: false, timedOut: true });
          }, timeoutMs);
        });

        let outcome;
        try {
          outcome = await Promise.race([disconnectOutcome, deadline]);
        } finally {
          if (timeoutId != null) cancelSchedule(timeoutId);
        }
        if (outcome?.rejected === true) throw outcome.error;
        if (outcome?.timedOut) {
          // LiveKit can send CLIENT_REQUEST_LEAVE and then remain pending while
          // closing a wedged Android Firefox engine. Release the serialized
          // handoff after a short deadline; the old Room stays marked so its
          // late events cannot mutate the replacement session.
          sourceRoom._echoRecoveryDisconnectReleased = true;
          sourceRoom._echoRecoveryDisconnectTimedOut = true;
        }
        return true;
      })();
      sourceRoom._echoRecoveryDisconnectPromise = disconnectPromise;
    }

    try {
      return await disconnectPromise;
    } catch (error) {
      // A failed sendLeave/engine close must not poison every bounded retry.
      // Keep concurrent callers on one promise, then let the next attempt
      // create a fresh teardown promise for the same source Room.
      if (sourceRoom._echoRecoveryDisconnectPromise === disconnectPromise) {
        sourceRoom._echoRecoveryDisconnectPromise = null;
      }
      throw error;
    }
  }

  function verifyAndroidFirefoxRelayCandidateRoom(candidateRoom) {
    let publisherPolicy = null;
    let subscriberPolicy = null;
    try {
      publisherPolicy = candidateRoom?.engine?.pcManager?.publisher?.pc
        ?.getConfiguration?.()?.iceTransportPolicy || null;
    } catch (_error) {}
    try {
      subscriberPolicy = candidateRoom?.engine?.pcManager?.subscriber?.pc
        ?.getConfiguration?.()?.iceTransportPolicy || null;
    } catch (_error) {}
    return {
      publisherPolicy,
      subscriberPolicy,
      verified: publisherPolicy === "relay" && subscriberPolicy === "relay",
    };
  }

  async function disconnectAndroidFirefoxRejectedRelayCandidate(candidateRoom, options) {
    if (!candidateRoom) {
      throw createAndroidFirefoxCandidateReleaseError(
        "Android Firefox rejected relay candidate Room is unavailable"
      );
    }
    candidateRoom._echoAndroidFirefoxStaleCandidate = true;
    candidateRoom._echoExpectedDisconnect = true;
    let released;
    try {
      released = await disconnectAndroidFirefoxRecoverySource(candidateRoom, options);
    } catch (cause) {
      throw createAndroidFirefoxCandidateReleaseError(
        "Android Firefox rejected relay candidate disconnect failed",
        cause
      );
    }
    if (candidateRoom._echoRecoveryDisconnectComplete !== true) {
      const timedOut = candidateRoom._echoRecoveryDisconnectTimedOut === true;
      throw createAndroidFirefoxCandidateReleaseError(
        timedOut
          ? "Android Firefox rejected relay candidate disconnect timed out"
          : "Android Firefox rejected relay candidate disconnect completion is unproven"
      );
    }
    return released;
  }

  function createAndroidFirefoxRoomDisconnectRecovery(options) {
    const opts = options || {};
    const retryDelaysMs = Array.isArray(opts.retryDelaysMs)
      ? opts.retryDelaysMs.filter((delay) => Number.isFinite(delay) && delay >= 0)
      : [500, 2000, 5000];
    const stalledReconnectTimeoutMs = Number.isFinite(opts.stalledReconnectTimeoutMs) &&
      opts.stalledReconnectTimeoutMs >= 0
      ? opts.stalledReconnectTimeoutMs
      : 15000;
    const schedule = typeof opts.schedule === "function" ? opts.schedule : setTimeout;
    const cancelSchedule = typeof opts.cancelSchedule === "function" ? opts.cancelSchedule : clearTimeout;
    const getCurrentRoom = typeof opts.getCurrentRoom === "function" ? opts.getCurrentRoom : () => null;
    const isSwitching = typeof opts.isSwitching === "function" ? opts.isSwitching : () => false;
    const isHidden = typeof opts.isHidden === "function" ? opts.isHidden : () => false;
    const isOnline = typeof opts.isOnline === "function" ? opts.isOnline : () => true;
    const enabled = typeof opts.isTargetBrowser === "function" &&
      opts.isTargetBrowser(opts.navigatorObject || null, opts.isNativeShell === true) === true;

    let nextGeneration = 0;
    let activeRecovery = null;
    let activeReconnectWatch = null;

    function disconnectReasonName(reason, disconnectReasons) {
      if (typeof reason === "string") return reason.toUpperCase();
      if (typeof reason === "number" && disconnectReasons && typeof disconnectReasons[reason] === "string") {
        return disconnectReasons[reason].toUpperCase();
      }
      return reason == null ? "UNKNOWN_REASON" : "UNRECOGNIZED_REASON";
    }

    function isTerminalDisconnectReason(reason, disconnectReasons) {
      const name = disconnectReasonName(reason, disconnectReasons);
      return name === "CLIENT_INITIATED" ||
        name === "DUPLICATE_IDENTITY" ||
        name === "SERVER_SHUTDOWN" ||
        name === "PARTICIPANT_REMOVED" ||
        name === "ROOM_DELETED" ||
        name === "JOIN_FAILURE" ||
        name === "ROOM_CLOSED" ||
        name === "USER_UNAVAILABLE" ||
        name === "USER_REJECTED" ||
        name === "SIP_TRUNK_FAILURE";
    }

    function clearActiveRecovery(expectedRecovery) {
      if (!activeRecovery || (expectedRecovery && activeRecovery !== expectedRecovery)) return false;
      if (activeRecovery.timerId != null) {
        cancelSchedule(activeRecovery.timerId);
      }
      activeRecovery = null;
      return true;
    }

    function clearReconnectWatch(expectedWatch) {
      if (!activeReconnectWatch || (expectedWatch && activeReconnectWatch !== expectedWatch)) return false;
      if (activeReconnectWatch.timerId != null) {
        cancelSchedule(activeReconnectWatch.timerId);
      }
      activeReconnectWatch = null;
      return true;
    }

    function isEligibleCurrentRoom(candidateRoom) {
      return enabled &&
        !!candidateRoom &&
        candidateRoom === getCurrentRoom() &&
        (candidateRoom._echoExpectedDisconnect !== true ||
          candidateRoom._echoRecoveryDisconnect === true) &&
        isSwitching() !== true;
    }

    function isCurrentRecovery(recovery) {
      return !!recovery &&
        activeRecovery === recovery &&
        isEligibleCurrentRoom(recovery.room);
    }

    function isCurrentReconnectWatch(watch) {
      return !!watch &&
        activeReconnectWatch === watch &&
        isEligibleCurrentRoom(watch.room);
    }

    function queueNextAttempt(recovery) {
      if (!isCurrentRecovery(recovery)) {
        clearActiveRecovery(recovery);
        return false;
      }
      if (recovery.nextAttemptIndex >= retryDelaysMs.length) {
        recovery.exhausted = true;
        recovery.waiting = false;
        if (typeof opts.onExhausted === "function") {
          opts.onExhausted({ room: recovery.room, attempts: recovery.nextAttemptIndex });
        }
        return false;
      }
      if (isHidden() === true || isOnline() !== true) {
        recovery.waiting = true;
        return false;
      }

      recovery.waiting = false;
      const generation = recovery.generation;
      const delayMs = retryDelaysMs[recovery.nextAttemptIndex];
      recovery.timerId = schedule(function () {
        recovery.timerId = null;
        return runAttempt(recovery, generation);
      }, delayMs);
      return true;
    }

    async function runAttempt(recovery, generation) {
      if (!isCurrentRecovery(recovery) || recovery.generation !== generation) {
        clearActiveRecovery(recovery);
        return false;
      }
      if (isHidden() === true || isOnline() !== true) {
        recovery.waiting = true;
        return false;
      }
      if (recovery.eligibilityValidated !== true && typeof recovery.isStillEligible === "function") {
        let stillEligible = false;
        try {
          stillEligible = recovery.isStillEligible({ room: recovery.room }) === true;
        } catch (_error) {
          stillEligible = false;
        }
        if (!stillEligible) {
          clearActiveRecovery(recovery);
          return false;
        }
        let validationCommitted = false;
        try {
          validationCommitted = recovery.onEligibilityValidated({ room: recovery.room }) === true;
        } catch (_error) {
          validationCommitted = false;
        }
        if (!validationCommitted) {
          clearActiveRecovery(recovery);
          return false;
        }
        recovery.eligibilityValidated = true;
        if (recovery.kind === "connected-media" &&
            typeof opts.onConnectedMediaStall === "function") {
          opts.onConnectedMediaStall({
            room: recovery.room,
            trackSid: recovery.trackSid || null,
          });
        }
      }

      const attemptIndex = recovery.nextAttemptIndex;
      recovery.nextAttemptIndex += 1;
      recovery.inFlight = true;
      if (typeof opts.onAttempt === "function") {
        opts.onAttempt({
          room: recovery.room,
          attempt: attemptIndex + 1,
          maxAttempts: retryDelaysMs.length,
        });
      }

      let failed = false;
      let failureError = null;
      try {
        await recovery.reconnect({
          room: recovery.room,
          micWasEnabled: recovery.micWasEnabled,
        });
      } catch (error) {
        failed = true;
        failureError = error;
        if (typeof opts.onAttemptFailed === "function") {
          opts.onAttemptFailed({ room: recovery.room, attempt: attemptIndex + 1, error });
        }
      }

      if (activeRecovery !== recovery || recovery.generation !== generation) return false;
      recovery.inFlight = false;
      if (!failed && getCurrentRoom() !== recovery.room) {
        clearActiveRecovery(recovery);
        return true;
      }
      if (!isCurrentRecovery(recovery)) {
        clearActiveRecovery(recovery);
        return false;
      }
      if (isAndroidFirefoxCandidateReleaseError(failureError)) {
        // A fresh Room must never start while the prior rejected candidate may
        // still own the same identity. Public Room.disconnect(true) is the
        // only supported proof of release, so stop this recovery generation
        // instead of creating overlapping candidates after a rejection or
        // deadline-only release.
        recovery.exhausted = true;
        recovery.waiting = false;
        if (typeof opts.onExhausted === "function") {
          opts.onExhausted({
            room: recovery.room,
            attempts: recovery.nextAttemptIndex,
            error: failureError,
            terminal: true,
          });
        }
        return false;
      }
      return queueNextAttempt(recovery);
    }

    function beginRecovery(candidateRoom, reconnect, micWasEnabled, recoveryOptions) {
      if (!isEligibleCurrentRoom(candidateRoom) || typeof reconnect !== "function") return false;
      const recoveryOpts = recoveryOptions || {};

      if (activeRecovery) {
        if (activeRecovery.room === candidateRoom) return false;
        clearActiveRecovery(activeRecovery);
      }
      if (activeReconnectWatch?.room === candidateRoom) {
        clearReconnectWatch(activeReconnectWatch);
      }

      const recovery = {
        room: candidateRoom,
        reconnect,
        micWasEnabled: typeof micWasEnabled === "boolean" ? micWasEnabled : null,
        generation: ++nextGeneration,
        nextAttemptIndex: 0,
        timerId: null,
        inFlight: false,
        waiting: false,
        exhausted: false,
        isStillEligible: typeof recoveryOpts.isStillEligible === "function"
          ? recoveryOpts.isStillEligible
          : null,
        onEligibilityValidated: typeof recoveryOpts.onEligibilityValidated === "function"
          ? recoveryOpts.onEligibilityValidated
          : null,
        kind: recoveryOpts.kind || null,
        trackSid: recoveryOpts.trackSid || null,
        eligibilityValidated: false,
      };
      activeRecovery = recovery;
      queueNextAttempt(recovery);
      return true;
    }

    function activateReconnectWatch(watch, generation) {
      if (!isCurrentReconnectWatch(watch) || watch.generation !== generation) {
        clearReconnectWatch(watch);
        return false;
      }
      watch.stale = true;
      if (isHidden() === true || isOnline() !== true) {
        watch.waiting = true;
        return false;
      }

      const candidateRoom = watch.room;
      const reconnect = watch.reconnect;
      const micWasEnabled = watch.micWasEnabled;
      clearReconnectWatch(watch);
      if (typeof opts.onStalledReconnect === "function") {
        opts.onStalledReconnect({ room: candidateRoom, timeoutMs: stalledReconnectTimeoutMs });
      }
      return beginRecovery(candidateRoom, reconnect, micWasEnabled);
    }

    function handleReconnecting(event) {
      const detail = event || {};
      const candidateRoom = detail.room;
      if (!isEligibleCurrentRoom(candidateRoom) || typeof detail.reconnect !== "function") {
        if (activeReconnectWatch?.room === candidateRoom) {
          clearReconnectWatch(activeReconnectWatch);
        }
        return false;
      }
      let micWasEnabled = typeof detail.micWasEnabled === "boolean" ? detail.micWasEnabled : null;
      if (activeRecovery?.room === candidateRoom) {
        const pendingRecovery = activeRecovery;
        const maySupersedeConnectedMedia = pendingRecovery.kind === "connected-media" &&
          pendingRecovery.eligibilityValidated !== true &&
          pendingRecovery.inFlight !== true;
        if (!maySupersedeConnectedMedia) return false;

        // Signaling loss is now the authoritative failure. Cancel the still-
        // uncommitted media timer and let the normal reconnect watchdog own the
        // Room, while retaining the microphone intent captured by the first
        // recovery signal.
        if (typeof pendingRecovery.micWasEnabled === "boolean") {
          micWasEnabled = pendingRecovery.micWasEnabled;
        }
        clearActiveRecovery(pendingRecovery);
      }
      if (activeReconnectWatch?.room === candidateRoom) {
        return false;
      }
      if (activeReconnectWatch) clearReconnectWatch(activeReconnectWatch);

      const watch = {
        room: candidateRoom,
        reconnect: detail.reconnect,
        micWasEnabled,
        generation: ++nextGeneration,
        timerId: null,
        stale: false,
        waiting: false,
      };
      activeReconnectWatch = watch;
      const generation = watch.generation;
      watch.timerId = schedule(function () {
        watch.timerId = null;
        return activateReconnectWatch(watch, generation);
      }, stalledReconnectTimeoutMs);
      return true;
    }

    function handleConnected(event) {
      const candidateRoom = event?.room;
      if (!enabled || !candidateRoom || candidateRoom !== getCurrentRoom()) return false;

      let cancelled = false;
      if (activeReconnectWatch?.room === candidateRoom) {
        cancelled = clearReconnectWatch(activeReconnectWatch) || cancelled;
      }
      // A connected-state event proves an SDK reconnect recovered, but it does
      // not prove that an already-connected Room resumed media. Let the latter
      // reach its exact just-in-time media predicate instead of cancelling it
      // on a redundant connection event.
      if (activeRecovery?.room === candidateRoom &&
          typeof activeRecovery.isStillEligible !== "function") {
        cancelled = clearActiveRecovery(activeRecovery) || cancelled;
      }
      return cancelled;
    }

    function handleConnectedMediaStall(event) {
      const detail = event || {};
      const candidateRoom = detail.room;
      if (!isEligibleCurrentRoom(candidateRoom) || typeof detail.reconnect !== "function") {
        return false;
      }
      // A relay-forced replacement is the final bounded fallback for this Room
      // generation. If it also stalls, leave the session stable for diagnosis
      // instead of cycling Rooms indefinitely.
      if (detail.alreadyUsingRelay === true) return false;
      if (typeof detail.isStillStalled !== "function") return false;
      if (typeof detail.onValidated !== "function") return false;
      if (activeRecovery?.room === candidateRoom) return false;
      if (activeReconnectWatch?.room === candidateRoom) return false;

      const accepted = beginRecovery(
        candidateRoom,
        detail.reconnect,
        detail.micWasEnabled,
        {
          isStillEligible: detail.isStillStalled,
          onEligibilityValidated: detail.onValidated,
          kind: "connected-media",
          trackSid: detail.trackSid || null,
        }
      );
      return accepted;
    }

    function handleDisconnected(event) {
      const detail = event || {};
      const candidateRoom = detail.room;
      if (!enabled || !candidateRoom || candidateRoom !== getCurrentRoom()) return false;

      // A stale-reconnect recovery deliberately disconnects its source Room
      // before opening the same identity again. Its CLIENT_INITIATED event is
      // teardown confirmation, not a request to cancel the serialized recovery.
      if (candidateRoom._echoRecoveryDisconnect === true) return false;

      if (candidateRoom._echoExpectedDisconnect === true ||
          isSwitching() === true ||
          isTerminalDisconnectReason(detail.reason, detail.disconnectReasons)) {
        if (activeRecovery?.room === candidateRoom) clearActiveRecovery(activeRecovery);
        if (activeReconnectWatch?.room === candidateRoom) clearReconnectWatch(activeReconnectWatch);
        return false;
      }
      if (typeof detail.reconnect !== "function") return false;

      let micWasEnabled = typeof detail.micWasEnabled === "boolean" ? detail.micWasEnabled : null;
      if (activeRecovery) {
        if (activeRecovery.room === candidateRoom) {
          const pendingRecovery = activeRecovery;
          const maySupersedeConnectedMedia = pendingRecovery.kind === "connected-media" &&
            pendingRecovery.eligibilityValidated !== true &&
            pendingRecovery.inFlight !== true;
          if (!maySupersedeConnectedMedia) return false;
          if (typeof pendingRecovery.micWasEnabled === "boolean") {
            micWasEnabled = pendingRecovery.micWasEnabled;
          }
          clearActiveRecovery(pendingRecovery);
        } else {
          clearActiveRecovery(activeRecovery);
        }
      }
      if (activeReconnectWatch?.room === candidateRoom) clearReconnectWatch(activeReconnectWatch);
      return beginRecovery(candidateRoom, detail.reconnect, micWasEnabled);
    }

    function resume() {
      const watch = activeReconnectWatch;
      if (watch?.stale && watch.timerId == null) {
        return activateReconnectWatch(watch, watch.generation);
      }
      const recovery = activeRecovery;
      if (!recovery || recovery.exhausted || recovery.inFlight || recovery.timerId != null) return false;
      return queueNextAttempt(recovery);
    }

    function cancel(candidateRoom) {
      let cancelled = false;
      if (!candidateRoom || activeReconnectWatch?.room === candidateRoom) {
        cancelled = clearReconnectWatch(activeReconnectWatch) || cancelled;
      }
      if (!candidateRoom || activeRecovery?.room === candidateRoom) {
        cancelled = clearActiveRecovery(activeRecovery) || cancelled;
      }
      return cancelled;
    }

    function snapshot() {
      if (!activeRecovery) {
        if (!activeReconnectWatch) return { enabled, active: false };
        return {
          enabled,
          active: false,
          watching: true,
          scheduled: activeReconnectWatch.timerId != null,
          waiting: activeReconnectWatch.waiting,
          stale: activeReconnectWatch.stale,
        };
      }
      return {
        enabled,
        active: true,
        attemptCount: activeRecovery.nextAttemptIndex,
        scheduled: activeRecovery.timerId != null,
        inFlight: activeRecovery.inFlight,
        waiting: activeRecovery.waiting,
        exhausted: activeRecovery.exhausted,
      };
    }

    return {
      cancel,
      handleConnected,
      handleConnectedMediaStall,
      handleDisconnected,
      handleReconnecting,
      isEnabled: () => enabled,
      resume,
      snapshot,
    };
  }

  return {
    commitConnectedAccessToken,
    createAndroidFirefoxCandidateReleaseError,
    createAndroidFirefoxRoomDisconnectRecovery,
    createRoomSwitchState,
    disconnectAndroidFirefoxRejectedRelayCandidate,
    disconnectAndroidFirefoxRecoverySource,
    isAndroidFirefoxCandidateReleaseError,
    resolvePostConnectMicrophoneBehavior,
    verifyAndroidFirefoxRelayCandidateRoom,
  };
});
