/* =========================================================
   CHIMES — Join/leave/switch audio cues and custom chimes
   ========================================================= */

// ---- Room chime sounds (Web Audio API) ----
let chimeAudioCtx = null;
const chimeBufferCache = new Map(); // "identityBase-enter" or "identityBase-exit" -> { buffer, ts }
const CHIME_CACHE_TTL_MS = 60000; // Re-fetch chimes after 60 seconds so updates are picked up
function getChimeCtx() {
  if (!chimeAudioCtx) chimeAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return chimeAudioCtx;
}

function playJoinChime(volume) {
  try {
    var vol = (volume != null ? volume : 1);
    if (roomAudioMuted) vol = 0;
    if (vol <= 0) return;
    const ctx = getChimeCtx();
    const now = ctx.currentTime;
    // Cheerful ascending two-note chime
    [[523.25, 0], [659.25, 0.12]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18 * vol, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.4);
    });
  } catch {}
}

function playLeaveChime(volume) {
  try {
    var vol = (volume != null ? volume : 1);
    if (roomAudioMuted) vol = 0;
    if (vol <= 0) return;
    const ctx = getChimeCtx();
    const now = ctx.currentTime;
    // Comedic descending "womp womp"
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(380, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.3);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.55);
    gain.gain.setValueAtTime(0.2 * vol, now);
    gain.gain.setValueAtTime(0.05 * vol, now + 0.25);
    gain.gain.setValueAtTime(0.18 * vol, now + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.75);
  } catch {}
}

function playSwitchChime(volume) {
  try {
    var vol = (volume != null ? volume : 1);
    if (roomAudioMuted) vol = 0;
    if (vol <= 0) return;
    const ctx = getChimeCtx();
    const now = ctx.currentTime;
    // Sci-fi teleport swoosh: quick rising sweep then a soft landing ping
    const swoosh = ctx.createOscillator();
    const swooshGain = ctx.createGain();
    swoosh.type = "sawtooth";
    swoosh.frequency.setValueAtTime(200, now);
    swoosh.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
    swoosh.frequency.exponentialRampToValueAtTime(800, now + 0.2);
    swooshGain.gain.setValueAtTime(0.08 * vol, now);
    swooshGain.gain.linearRampToValueAtTime(0.12 * vol, now + 0.08);
    swooshGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    swoosh.connect(swooshGain).connect(ctx.destination);
    swoosh.start(now);
    swoosh.stop(now + 0.25);
    // Landing ping
    const ping = ctx.createOscillator();
    const pingGain = ctx.createGain();
    ping.type = "sine";
    ping.frequency.value = 880;
    pingGain.gain.setValueAtTime(0.15 * vol, now + 0.18);
    pingGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    ping.connect(pingGain).connect(ctx.destination);
    ping.start(now + 0.18);
    ping.stop(now + 0.55);
  } catch {}
}

function playScreenShareChime(volume) {
  try {
    var vol = (volume != null ? volume : 1);
    if (roomAudioMuted) vol = 0;
    if (vol <= 0) return;
    const ctx = getChimeCtx();
    const now = ctx.currentTime;
    // Digital broadcast alert: three-note ascending sparkle with a shimmer tail
    // Notes: G5 (783.99) → B5 (987.77) → D6 (1174.66) — a bright G major triad arpeggio
    var notes = [783.99, 987.77, 1174.66];
    notes.forEach(function(freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      var onset = i * 0.08; // 80ms between notes — quick arpeggio
      gain.gain.setValueAtTime(0.001, now + onset);
      gain.gain.linearRampToValueAtTime(0.16 * vol, now + onset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + onset + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + onset);
      osc.stop(now + onset + 0.4);
    });
    // Shimmer tail: quiet high-frequency sine that fades out slowly
    var shimmer = ctx.createOscillator();
    var shimmerGain = ctx.createGain();
    shimmer.type = "sine";
    shimmer.frequency.value = 2349.32; // D7 — one octave above the last note
    shimmerGain.gain.setValueAtTime(0.001, now + 0.2);
    shimmerGain.gain.linearRampToValueAtTime(0.06 * vol, now + 0.25);
    shimmerGain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    shimmer.connect(shimmerGain).connect(ctx.destination);
    shimmer.start(now + 0.2);
    shimmer.stop(now + 0.75);
  } catch {}
}

async function fetchChimeBuffer(identityBase, kind) {
  const cacheKey = identityBase + "-" + kind;
  const cached = chimeBufferCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CHIME_CACHE_TTL_MS) return cached.buffer;
  try {
    // Add cache-buster to bypass browser cache — chimes may be updated at any time
    const res = await fetch(apiUrl("/api/chime/" + encodeURIComponent(identityBase) + "/" + kind + "?v=" + Date.now()), {
      headers: { 'Accept': 'application/octet-stream' }
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const ctx = getChimeCtx();
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    chimeBufferCache.set(cacheKey, { buffer: decoded, ts: Date.now() });
    return decoded;
  } catch {
    return null;
  }
}

function playCustomChime(buffer, volume) {
  try {
    var vol = (volume != null ? volume : 1);
    if (roomAudioMuted) vol = 0;
    if (vol <= 0) return;
    const ctx = getChimeCtx();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.5 * vol;
    source.connect(gain).connect(ctx.destination);
    source.start(0);
  } catch {}
}

async function playChimeForIdentities(identities, kind) {
  // Look up chime volume from first identity
  var volId = identities.length > 0 ? getIdentityBase(identities[0]) : null;
  var volState = volId ? participantState.get(volId) : null;
  var vol = (volState && volState.chimeVolume != null) ? volState.chimeVolume : 0.5;
  for (const id of identities) {
    var chimeKey = getChimeKey(id);
    const buffer = await fetchChimeBuffer(chimeKey, kind);
    if (buffer) {
      playCustomChime(buffer, vol);
      return;
    }
  }
  if (kind === "enter") playJoinChime(vol);
  else playLeaveChime(vol);
}

// Get the chime lookup key for a participant — deviceId if known, else identityBase (fallback)
function getChimeKey(identity) {
  var identityBase = getIdentityBase(identity);
  // Check if we know this participant's device ID
  var deviceId = deviceIdByIdentity.get(identityBase);
  return deviceId || identityBase;
}

// Pre-fetch chime buffers for all participants in the current room so playback is instant
// Skip on mobile — burst of audio fetches triggers Samsung download interceptor
function prefetchChimeBuffersForRoom() {
  if (_isMobileDevice) return;
  if (!room || !room.remoteParticipants) return;
  room.remoteParticipants.forEach(function(participant) {
    var chimeKey = getChimeKey(participant.identity);
    // Fetch both enter and exit chimes into cache
    fetchChimeBuffer(chimeKey, "enter").catch(function() {});
    fetchChimeBuffer(chimeKey, "exit").catch(function() {});
  });
}

// Play chime for a single participant — instant if pre-fetched, async fetch otherwise
// On mobile, skip custom chime fetch entirely — Samsung intercepts audio/mpeg downloads
async function playChimeForParticipant(identity, kind) {
  if (_isMobileDevice) {
    var identityBase = getIdentityBase(identity);
    var pState = participantState.get(identityBase);
    var vol = (pState && pState.chimeVolume != null) ? pState.chimeVolume : 0.5;
    if (kind === "enter") playJoinChime(vol); else playLeaveChime(vol);
    return;
  }
  var chimeKey = getChimeKey(identity);
  // Look up this participant's chime volume preference
  var identityBase = getIdentityBase(identity);
  var pState = participantState.get(identityBase);
  var vol = (pState && pState.chimeVolume != null) ? pState.chimeVolume : 0.5;
  var buffer = await fetchChimeBuffer(chimeKey, kind);
  if (buffer) {
    playCustomChime(buffer, vol);
  } else if (kind === "enter") {
    playJoinChime(vol);
  } else {
    playLeaveChime(vol);
  }
}
