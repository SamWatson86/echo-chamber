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
      try {
        await recovery.reconnect({
          room: recovery.room,
          micWasEnabled: recovery.micWasEnabled,
        });
      } catch (error) {
        failed = true;
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
      return queueNextAttempt(recovery);
    }

    function beginRecovery(candidateRoom, reconnect, micWasEnabled) {
      if (!isEligibleCurrentRoom(candidateRoom) || typeof reconnect !== "function") return false;

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
      if (activeRecovery?.room === candidateRoom || activeReconnectWatch?.room === candidateRoom) {
        return false;
      }
      if (activeReconnectWatch) clearReconnectWatch(activeReconnectWatch);

      const watch = {
        room: candidateRoom,
        reconnect: detail.reconnect,
        micWasEnabled: typeof detail.micWasEnabled === "boolean" ? detail.micWasEnabled : null,
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
      if (activeRecovery?.room === candidateRoom) {
        cancelled = clearActiveRecovery(activeRecovery) || cancelled;
      }
      return cancelled;
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

      if (activeRecovery) {
        if (activeRecovery.room === candidateRoom) return false;
        clearActiveRecovery(activeRecovery);
      }
      if (activeReconnectWatch?.room === candidateRoom) clearReconnectWatch(activeReconnectWatch);
      return beginRecovery(candidateRoom, detail.reconnect, detail.micWasEnabled);
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
      handleDisconnected,
      handleReconnecting,
      isEnabled: () => enabled,
      resume,
      snapshot,
    };
  }

  return {
    commitConnectedAccessToken,
    createAndroidFirefoxRoomDisconnectRecovery,
    createRoomSwitchState,
    disconnectAndroidFirefoxRecoverySource,
    resolvePostConnectMicrophoneBehavior,
  };
});
