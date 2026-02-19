(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EchoJamSessionState = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function createJamSessionState(options) {
    const opts = options || {};
    const reconnectBaseMs = Number.isFinite(opts.reconnectBaseMs) ? opts.reconnectBaseMs : 500;
    const reconnectMaxMs = Number.isFinite(opts.reconnectMaxMs) ? opts.reconnectMaxMs : 8000;

    const state = {
      desiredListening: false,
      serverJoined: false,
      streamConnected: false,
      streamConnecting: false,
      reconnectAttempt: 0,
      pendingLeave: false,
      lastError: null,
    };

    function nextDelay() {
      const step = Math.min(state.reconnectAttempt, 6);
      return Math.min(reconnectBaseMs * Math.pow(2, step), reconnectMaxMs);
    }

    function requestJoin() {
      state.desiredListening = true;
      state.streamConnecting = true;
      state.pendingLeave = false;
      state.lastError = null;
      return snapshot();
    }

    function joinAccepted() {
      state.serverJoined = true;
      state.streamConnecting = true;
      state.lastError = null;
      return snapshot();
    }

    function joinRejected(errorMessage) {
      state.desiredListening = false;
      state.serverJoined = false;
      state.streamConnected = false;
      state.streamConnecting = false;
      state.reconnectAttempt = 0;
      state.pendingLeave = false;
      state.lastError = errorMessage || "join-failed";
      return snapshot();
    }

    function streamOpen() {
      // Ignore late stream-open callbacks that arrive after user requested leave.
      if (state.pendingLeave || !state.desiredListening) {
        state.streamConnected = false;
        state.streamConnecting = false;
        return snapshot();
      }

      state.streamConnected = true;
      state.streamConnecting = false;
      state.reconnectAttempt = 0;
      state.lastError = null;
      return snapshot();
    }

    function streamClosedTransient(errorMessage) {
      state.streamConnected = false;
      state.streamConnecting = false;
      state.lastError = errorMessage || null;

      if (!state.desiredListening || !state.serverJoined || state.pendingLeave) {
        state.reconnectAttempt = 0;
        return { shouldReconnect: false, delayMs: 0, snapshot: snapshot() };
      }

      const delayMs = nextDelay();
      state.reconnectAttempt += 1;
      return { shouldReconnect: true, delayMs, snapshot: snapshot() };
    }

    function reconnectAttemptStarted() {
      if (!state.desiredListening || !state.serverJoined || state.pendingLeave) {
        return { shouldConnect: false, snapshot: snapshot() };
      }
      state.streamConnecting = true;
      return { shouldConnect: true, snapshot: snapshot() };
    }

    function requestLeave() {
      state.pendingLeave = true;
      state.desiredListening = false;
      state.streamConnecting = false;
      return snapshot();
    }

    function leaveSucceeded() {
      state.pendingLeave = false;
      state.serverJoined = false;
      state.streamConnected = false;
      state.streamConnecting = false;
      state.reconnectAttempt = 0;
      state.lastError = null;
      return snapshot();
    }

    function leaveFailed(errorMessage) {
      state.pendingLeave = false;
      // Server likely still considers us joined; preserve serverJoined=true and
      // restore desiredListening intent so reconnect policy can recover stream.
      state.serverJoined = true;
      state.desiredListening = true;
      state.lastError = errorMessage || "leave-failed";
      return snapshot();
    }

    function ui() {
      const connecting = state.streamConnecting && !state.streamConnected;
      return {
        joinVisible: !state.streamConnected && !connecting,
        leaveVisible: state.streamConnected || connecting || state.pendingLeave,
        status: state.streamConnected
          ? "connected"
          : connecting
            ? "connecting"
            : state.lastError
              ? "error"
              : "idle",
      };
    }

    function snapshot() {
      return {
        desiredListening: state.desiredListening,
        serverJoined: state.serverJoined,
        streamConnected: state.streamConnected,
        streamConnecting: state.streamConnecting,
        reconnectAttempt: state.reconnectAttempt,
        pendingLeave: state.pendingLeave,
        lastError: state.lastError,
      };
    }

    return {
      requestJoin,
      joinAccepted,
      joinRejected,
      streamOpen,
      streamClosedTransient,
      reconnectAttemptStarted,
      requestLeave,
      leaveSucceeded,
      leaveFailed,
      ui,
      snapshot,
    };
  }

  return {
    createJamSessionState,
  };
});
