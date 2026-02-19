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

  return {
    createRoomSwitchState,
  };
});
