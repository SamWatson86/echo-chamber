const test = require("node:test");
const assert = require("node:assert/strict");
const {
  JAM_PROTOCOL_VERSION,
  buildJamAudioSocketQuery,
  createLatestRequestGate,
  createJamSessionState,
  effectiveJamGain,
  effectiveJamRelayGain,
  evaluateJamContract,
  parseJamAudioControlMessage,
  planAudioFrame,
  shouldApplyBannerResponse,
  shouldMuteLocalRelay,
  shouldOpenAudioAfterRejoin,
  shouldResetListeningForServerState,
} = require("./jam-session-state.js");

test("only the newest concurrent Jam state request may update the viewer", () => {
  const gate = createLatestRequestGate();
  const older = gate.begin();
  const newer = gate.begin();

  assert.equal(gate.isCurrent(older), false);
  assert.equal(gate.isCurrent(newer), true);
});

test("the Spotify source host relay follows takeover and monitor state", () => {
  assert.equal(shouldMuteLocalRelay(true, true, false, false), true);
  assert.equal(shouldMuteLocalRelay(true, true, true, false), true);
  assert.equal(shouldMuteLocalRelay(true, true, true, true), false);
  assert.equal(shouldMuteLocalRelay(true, false), false);
  assert.equal(shouldMuteLocalRelay(false, true), false);
});

test("source-PC monitor policy preserves independent Jam volume and global mute", () => {
  assert.equal(effectiveJamRelayGain(50, false, { is_source_host: false }), 0.5);
  assert.equal(effectiveJamRelayGain(50, false, {
    is_source_host: true,
    takeover_active: false,
    monitor_enabled: true,
  }), 0);
  assert.equal(effectiveJamRelayGain(50, false, {
    is_source_host: true,
    takeover_active: true,
    monitor_enabled: false,
  }), 0);
  assert.equal(effectiveJamRelayGain(50, false, {
    is_source_host: true,
    takeover_active: true,
    monitor_enabled: true,
  }), 0.5);
  assert.equal(effectiveJamRelayGain(50, true, {
    is_source_host: true,
    takeover_active: true,
    monitor_enabled: true,
  }), 0);
});

test("Jam audio socket query contains protocol and generation only", () => {
  const query = buildJamAudioSocketQuery(3, 41);
  const params = new URLSearchParams(query);

  assert.deepEqual(Array.from(params.keys()), ["jam_protocol_version", "generation"]);
  assert.equal(params.get("jam_protocol_version"), "3");
  assert.equal(params.get("generation"), "41");
  assert.equal(query.includes("token"), false);
  assert.equal(query.includes("identity"), false);
  assert.throws(() => buildJamAudioSocketQuery(3, null), /Invalid Jam generation/);
});

test("Jam audio is connected only after the explicit ready control frame", () => {
  assert.deepEqual(parseJamAudioControlMessage('{"type":"ready"}'), { type: "ready" });
  assert.deepEqual(parseJamAudioControlMessage('{"type":"error","message":"expired"}'), {
    type: "error",
    message: "expired",
  });
  assert.equal(parseJamAudioControlMessage("not-json").type, "invalid");
  assert.equal(parseJamAudioControlMessage(new ArrayBuffer(8)).type, "binary");
});

test("global room mute wins when the Jam gain is first created", () => {
  assert.equal(effectiveJamGain(50, false), 0.5);
  assert.equal(effectiveJamGain(50, true), 0);
  assert.equal(effectiveJamGain(250, false), 1);
});

test("rejoin may open audio only for unchanged intent, generation, and binding token", () => {
  const listening = { desiredListening: true, serverJoined: true, pendingLeave: false };
  assert.equal(shouldOpenAudioAfterRejoin(listening, 7, 7, true), true);
  assert.equal(shouldOpenAudioAfterRejoin({ ...listening, pendingLeave: true }, 7, 7, true), false);
  assert.equal(shouldOpenAudioAfterRejoin(listening, 7, 8, true), false);
  assert.equal(shouldOpenAudioAfterRejoin(listening, 7, 7, false), false);
  assert.equal(shouldOpenAudioAfterRejoin(listening, null, null, true), false);
});

test("banner response cannot overwrite state after full polling starts", () => {
  assert.equal(shouldApplyBannerResponse(false, true), true);
  assert.equal(shouldApplyBannerResponse(true, true), false);
  assert.equal(shouldApplyBannerResponse(false, false), false);
});

test("Jam protocol v3 rejects missing and mismatched server contracts", () => {
  assert.equal(JAM_PROTOCOL_VERSION, 3);

  const missing = evaluateJamContract({ source_status: "ready" });
  assert.equal(missing.compatible, false);
  assert.equal(missing.canStart, false);
  assert.match(missing.compatibilityMessage, /did not report a protocol/);

  const mismatched = evaluateJamContract({ jam_protocol_version: 1, source_status: "ready" });
  assert.equal(mismatched.compatible, false);
  assert.equal(mismatched.actualProtocol, 1);
  assert.match(mismatched.compatibilityMessage, /viewer v3, server v1/);
});

test("playlist selection requires an explicit server capability", () => {
  const base = {
    jam_protocol_version: 3,
    active: true,
    source_enabled: true,
    source_availability_known: true,
    source_status: "live",
  };
  assert.equal(evaluateJamContract(base).playlistSelectionSupported, false);
  assert.equal(evaluateJamContract({
    ...base,
    playlist_selection_supported: true,
  }).playlistSelectionSupported, true);
});

test("ready, live, and silent sources are capture-ready for a new Jam", () => {
  for (const source_status of ["ready", "live", "silent"]) {
    const contract = evaluateJamContract({
      jam_protocol_version: 3,
      source_enabled: true,
      source_availability_known: true,
      spotify_connected: true,
      active: false,
      source_status,
    });
    assert.equal(contract.compatible, true, source_status);
    assert.equal(contract.sourceReady, true, source_status);
    assert.equal(contract.canStart, true, source_status);
    assert.equal(contract.canControl, false, source_status);
  }

  assert.equal(evaluateJamContract({
    jam_protocol_version: 3,
    source_enabled: true,
    source_availability_known: true,
    source_status: "ready",
  }).sourceMessage, "Host source is online");
  assert.equal(evaluateJamContract({
    jam_protocol_version: 3,
    source_enabled: true,
    source_availability_known: true,
    source_status: "live",
  }).sourceMessage, "Host source audio is live");
});

test("Start Jam fails closed until source availability is known and enabled", () => {
  const base = {
    jam_protocol_version: 3,
    spotify_connected: true,
    active: false,
    source_status: "ready",
  };

  const missing = evaluateJamContract(base);
  assert.equal(missing.sourceAvailabilityKnown, false);
  assert.equal(missing.sourceEnabled, false);
  assert.equal(missing.canStart, false);
  assert.match(missing.sourceMessage, /Checking Spotify control/);

  const unknown = evaluateJamContract({ ...base, source_enabled: true });
  assert.equal(unknown.canStart, false);

  const disabled = evaluateJamContract({
    ...base,
    source_availability_known: true,
    source_enabled: false,
    source_status: "disabled",
  });
  assert.equal(disabled.canStart, false);
  assert.equal(disabled.sourceTone, "warning");
  assert.match(disabled.sourceMessage, /disabled on the Spotify PC/);

  const negotiating = evaluateJamContract({
    ...base,
    source_availability_known: true,
    source_enabled: true,
    source_status: "negotiating",
  });
  assert.equal(negotiating.canStart, false);
  assert.match(negotiating.sourceMessage, /preparing Spotify control/);
});

test("offline and failed sources block start and preserve their diagnostic", () => {
  const offline = evaluateJamContract({
    jam_protocol_version: 3,
    source_enabled: true,
    source_availability_known: true,
    spotify_connected: true,
    source_status: "offline",
    source_error: "Configured source disconnected",
  });
  assert.equal(offline.canStart, false);
  assert.equal(offline.sourceTone, "error");
  assert.equal(offline.sourceMessage, "Configured source disconnected");

  const failed = evaluateJamContract({
    jam_protocol_version: 3,
    source_enabled: true,
    source_availability_known: true,
    spotify_connected: true,
    source_status: "error",
    source_error: "Spotify capture helper exited",
  });
  assert.equal(failed.canStart, false);
  assert.equal(failed.sourceMessage, "Spotify capture helper exited");
});

test("a stalled source keeps queue and skip recovery controls but blocks new listeners", () => {
  const stalled = evaluateJamContract({
    jam_protocol_version: 3,
    source_enabled: true,
    source_availability_known: true,
    spotify_connected: true,
    active: true,
    source_status: "stalled",
    source_ready: true,
  });
  assert.equal(stalled.sourceReady, false);
  assert.equal(stalled.canStart, false);
  assert.equal(stalled.canJoin, false);
  assert.equal(stalled.canControl, true);
  assert.equal(stalled.sourceTone, "error");
  assert.equal(stalled.sourceMessage, "Spotify is playing but Echo audio has stalled");

  const stalledWithDiagnostic = evaluateJamContract({
    jam_protocol_version: 3,
    source_enabled: true,
    source_availability_known: true,
    source_status: "stalled",
    source_error: "Host capture stopped delivering frames",
  });
  assert.equal(stalledWithDiagnostic.sourceMessage, "Host capture stopped delivering frames");
});

test("an active degraded Jam fails closed while its source recovers", () => {
  const contract = evaluateJamContract({
    jam_protocol_version: 3,
    source_enabled: true,
    source_availability_known: true,
    spotify_connected: true,
    active: true,
    source_status: "offline",
  });
  assert.equal(contract.sourceReady, false);
  assert.equal(contract.canStart, false);
  assert.equal(contract.canJoin, false);
  assert.equal(contract.canControl, false);
});

test("Stop Music remains available when capture fails but Spotify is playing", () => {
  for (const source_status of ["offline", "error", "failed", "stalled"]) {
    const contract = evaluateJamContract({
      jam_protocol_version: 3,
      spotify_connected: true,
      spotify_is_playing: true,
      playback_stop_supported: true,
      active: true,
      source_status,
    });
    assert.equal(contract.canStopPlayback, true, source_status);
  }
});

test("skip reconciliation pauses queue controls without hiding emergency Jam controls", () => {
  const base = {
    jam_protocol_version: 3,
    spotify_connected: true,
    playback_stop_supported: true,
    active: true,
    source_enabled: true,
    source_availability_known: true,
    source_status: "live",
  };

  const pending = evaluateJamContract({
    ...base,
    skip_reconciliation_pending: true,
  });
  assert.equal(pending.skipReconciliationPending, true);
  assert.equal(pending.canControl, false);
  assert.equal(pending.canStopPlayback, true);

  const resolved = evaluateJamContract({
    ...base,
    skip_reconciliation_pending: false,
  });
  assert.equal(resolved.skipReconciliationPending, false);
  assert.equal(resolved.canControl, true);
  assert.equal(resolved.canStopPlayback, true);
});

test("Stop Music is capability and generation-state gated, not observation gated", () => {
  const base = {
    jam_protocol_version: 3,
    spotify_connected: true,
    spotify_is_playing: true,
    playback_stop_supported: true,
    active: true,
    source_status: "live",
  };

  assert.equal(evaluateJamContract(base).canStopPlayback, true);
  assert.equal(evaluateJamContract({ ...base, active: false }).canStopPlayback, false);
  assert.equal(evaluateJamContract({ ...base, spotify_connected: false }).canStopPlayback, false);
  assert.equal(evaluateJamContract({ ...base, spotify_is_playing: false }).canStopPlayback, true);
  assert.equal(evaluateJamContract({ ...base, playback_stop_supported: false }).canStopPlayback, false);
  assert.equal(evaluateJamContract({ ...base, jam_protocol_version: 1 }).canStopPlayback, false);
});

test("an active healthy Jam permits join and control actions", () => {
  const contract = evaluateJamContract({
    jam_protocol_version: 3,
    source_enabled: true,
    source_availability_known: true,
    spotify_connected: true,
    active: true,
    source_status: "live",
  });
  assert.equal(contract.sourceReady, true);
  assert.equal(contract.canStart, false);
  assert.equal(contract.canJoin, true);
  assert.equal(contract.canControl, true);
});

test("explicit source_ready can confirm a source before its status label catches up", () => {
  const contract = evaluateJamContract({
    jam_protocol_version: 3,
    source_enabled: true,
    source_availability_known: true,
    spotify_connected: true,
    source_status: "starting",
    source_ready: true,
  });
  assert.equal(contract.sourceReady, true);
  assert.equal(contract.canStart, true);
});

test("join success then stream open => connected UI", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  assert.deepEqual(s.ui(), {
    joinVisible: false,
    leaveVisible: true,
    status: "connected",
  });
});

test("join accepted but stream closes => reconnect requested with backoff", () => {
  const s = createJamSessionState({ reconnectBaseMs: 500, reconnectMaxMs: 8000 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  const first = s.streamClosedTransient("ws-close");
  assert.equal(first.shouldReconnect, true);
  assert.equal(first.delayMs, 500);

  const second = s.streamClosedTransient("ws-close");
  assert.equal(second.shouldReconnect, true);
  assert.equal(second.delayMs, 1000);
});

test("stream close when user does not want listening => no reconnect", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();
  s.requestLeave();

  const close = s.streamClosedTransient("ws-close");
  assert.equal(close.shouldReconnect, false);
});

test("leave failed restores listening intent for recovery", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  s.requestLeave();
  s.leaveFailed("network");

  const snap = s.snapshot();
  assert.equal(snap.desiredListening, true);
  assert.equal(snap.serverJoined, true);
  assert.equal(s.ui().joinVisible, false); // reconnecting/leave path remains active
});

test("join rejected clears listening state", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinRejected("401");

  const snap = s.snapshot();
  assert.equal(snap.desiredListening, false);
  assert.equal(snap.serverJoined, false);
  assert.equal(snap.streamConnected, false);
  assert.equal(s.ui().joinVisible, true);
});

test("reconnect backoff is capped at reconnectMaxMs", () => {
  const s = createJamSessionState({ reconnectBaseMs: 200, reconnectMaxMs: 700 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  assert.equal(s.streamClosedTransient("ws-close").delayMs, 200);
  assert.equal(s.streamClosedTransient("ws-close").delayMs, 400);
  assert.equal(s.streamClosedTransient("ws-close").delayMs, 700);
  assert.equal(s.streamClosedTransient("ws-close").delayMs, 700);
});

test("reconnectAttemptStarted is blocked after leave request", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();
  s.requestLeave();

  const out = s.reconnectAttemptStarted();
  assert.equal(out.shouldConnect, false);
  assert.equal(s.snapshot().pendingLeave, true);
  assert.equal(s.ui().leaveVisible, true);
});

test("transient close after leave success never schedules reconnect", () => {
  const s = createJamSessionState({ reconnectBaseMs: 100, reconnectMaxMs: 400 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();
  s.requestLeave();
  s.leaveSucceeded();

  const close = s.streamClosedTransient("late-close");
  assert.equal(close.shouldReconnect, false);
  assert.equal(close.delayMs, 0);
  assert.equal(s.snapshot().reconnectAttempt, 0);
});

test("connect attempt is blocked after join rejection race", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.joinRejected("server-denied");

  const reconnect = s.reconnectAttemptStarted();
  assert.equal(reconnect.shouldConnect, false);
  assert.equal(s.ui().status, "error");
});

test("late transient disconnect after leave failure restarts deterministic reconnect ladder", () => {
  const s = createJamSessionState({ reconnectBaseMs: 100, reconnectMaxMs: 800 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  s.requestLeave();
  s.leaveFailed("timeout");

  const first = s.streamClosedTransient("late-close");
  const second = s.streamClosedTransient("late-close");

  assert.equal(first.shouldReconnect, true);
  assert.equal(first.delayMs, 100);
  assert.equal(second.shouldReconnect, true);
  assert.equal(second.delayMs, 200);
  assert.equal(s.snapshot().reconnectAttempt, 2);
});

test("reconnect attempt remains blocked until leave failure clears pendingLeave", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  s.requestLeave();
  assert.equal(s.reconnectAttemptStarted().shouldConnect, false);

  // Transport closes while leave is pending; reconnect still blocked.
  s.streamClosedTransient("socket-close");
  assert.equal(s.reconnectAttemptStarted().shouldConnect, false);

  // Once leave failure clears pendingLeave, reconnect is permitted again.
  s.leaveFailed("api-timeout");
  assert.equal(s.reconnectAttemptStarted().shouldConnect, true);
  assert.equal(s.snapshot().pendingLeave, false);
});

test("disconnect during reconnecting state continues deterministic backoff", () => {
  const s = createJamSessionState({ reconnectBaseMs: 150, reconnectMaxMs: 600 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  const first = s.streamClosedTransient("socket-close");
  assert.equal(first.delayMs, 150);
  assert.equal(s.reconnectAttemptStarted().shouldConnect, true);
  assert.equal(s.ui().status, "connecting");

  // While connect attempt is in-flight, another close should still advance backoff ladder.
  const second = s.streamClosedTransient("socket-close");
  assert.equal(second.shouldReconnect, true);
  assert.equal(second.delayMs, 300);
});

test("late disconnect after successful reconnect resets backoff to base", () => {
  const s = createJamSessionState({ reconnectBaseMs: 120, reconnectMaxMs: 480 });
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  // Build reconnect pressure.
  s.streamClosedTransient("drop-1"); // 120
  s.streamClosedTransient("drop-2"); // 240
  s.reconnectAttemptStarted();

  // Reconnect succeeds; backoff should reset.
  s.streamOpen();
  assert.equal(s.snapshot().reconnectAttempt, 0);

  // Next transient close should start from base again.
  const next = s.streamClosedTransient("drop-3");
  assert.equal(next.shouldReconnect, true);
  assert.equal(next.delayMs, 120);
});

test("late stream-open callback is ignored once leave is pending", () => {
  const s = createJamSessionState();
  s.requestJoin();
  s.joinAccepted();
  s.streamOpen();

  s.requestLeave();

  // Transport callback arrives out-of-order after leave intent.
  s.streamOpen();

  assert.equal(s.snapshot().streamConnected, false);
  assert.equal(s.snapshot().pendingLeave, true);
  assert.equal(s.ui().status, "idle");
});

test("audio scheduler drops backlog instead of overlapping accepted buffers", () => {
  const normal = planAudioFrame(10.1, 10, 0.02, 0.5);
  assert.deepEqual(normal, {
    drop: false,
    startTime: 10.1,
    nextPlayTime: 10.12,
  });

  const late = planAudioFrame(9, 10, 0.02, 0.5);
  assert.equal(late.drop, false);
  assert.equal(late.startTime, 10.02);
  assert.equal(late.nextPlayTime, 10.04);

  const backlog = planAudioFrame(10.75, 10, 0.02, 0.5);
  assert.equal(backlog.drop, true);
  assert.equal(backlog.startTime, null);
  assert.equal(backlog.nextPlayTime, 10.75);
});

test("listener intent is reset on auto-end or a different Jam generation", () => {
  assert.equal(shouldResetListeningForServerState({ active: false, generation: 7 }, 7), true);
  assert.equal(shouldResetListeningForServerState({ active: true, generation: 7 }, 7), false);
  assert.equal(shouldResetListeningForServerState({ active: true, generation: 8 }, 7), true);
});
