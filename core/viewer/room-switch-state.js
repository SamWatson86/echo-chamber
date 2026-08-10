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

  function createAndroidFirefoxRoomDisconnectRecovery(options) {
    const opts = options || {};
    const retryDelaysMs = Array.isArray(opts.retryDelaysMs)
      ? opts.retryDelaysMs.filter((delay) => Number.isFinite(delay) && delay >= 0)
      : [500, 2000, 5000];
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

    function isCurrentRecovery(recovery) {
      return enabled &&
        !!recovery &&
        activeRecovery === recovery &&
        recovery.room === getCurrentRoom() &&
        recovery.room?._echoExpectedDisconnect !== true &&
        isSwitching() !== true;
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
        await recovery.reconnect();
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

    function handleDisconnected(event) {
      const detail = event || {};
      const candidateRoom = detail.room;
      if (!enabled || !candidateRoom || candidateRoom !== getCurrentRoom()) return false;

      if (candidateRoom._echoExpectedDisconnect === true ||
          isSwitching() === true ||
          isTerminalDisconnectReason(detail.reason, detail.disconnectReasons)) {
        if (activeRecovery?.room === candidateRoom) clearActiveRecovery(activeRecovery);
        return false;
      }
      if (typeof detail.reconnect !== "function") return false;

      if (activeRecovery) {
        if (activeRecovery.room === candidateRoom) return false;
        clearActiveRecovery(activeRecovery);
      }

      const recovery = {
        room: candidateRoom,
        reconnect: detail.reconnect,
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

    function resume() {
      const recovery = activeRecovery;
      if (!recovery || recovery.exhausted || recovery.inFlight || recovery.timerId != null) return false;
      return queueNextAttempt(recovery);
    }

    function cancel(candidateRoom) {
      if (candidateRoom && activeRecovery?.room !== candidateRoom) return false;
      return clearActiveRecovery(activeRecovery);
    }

    function snapshot() {
      if (!activeRecovery) return { enabled, active: false };
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
      handleDisconnected,
      isEnabled: () => enabled,
      resume,
      snapshot,
    };
  }

  return {
    commitConnectedAccessToken,
    createAndroidFirefoxRoomDisconnectRecovery,
    createRoomSwitchState,
    resolvePostConnectMicrophoneBehavior,
  };
});
