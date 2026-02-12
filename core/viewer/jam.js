/* =========================================================
   JAM SESSION — Communal Spotify listening for Echo Chamber
   Loaded AFTER app.js. Shares global scope with app.js.
   ========================================================= */

// === Globals ===
var _jamPanel = null;
var _jamState = null;
var _jamPollTimer = null;
var _jamAudioEl = null;       // <audio> element for received jam audio
var _jamVolume = 100;
var _spotifyAuthState = null;
var _spotifyVerifier = null;
var _spotifyPollTimer = null;
var _jamInited = false;       // lazy init -- don't poll until panel opened once

// === HTML Escape (app.js doesn't have one) ===
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ──────────────────────────────────────────
// Panel Open / Close
// ──────────────────────────────────────────

function openJamPanel() {
  var panel = document.getElementById("jam-panel");
  if (panel) {
    panel.classList.remove("hidden");
    initJam();
  }
}

function closeJamPanel() {
  var panel = document.getElementById("jam-panel");
  if (panel) panel.classList.add("hidden");
}

// ──────────────────────────────────────────
// Spotify OAuth PKCE
// ──────────────────────────────────────────

function generateRandomString(length) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  var arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, function(b) { return chars[b % chars.length]; }).join("");
}

async function generateCodeChallenge(verifier) {
  var encoder = new TextEncoder();
  var data = encoder.encode(verifier);
  var digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function connectSpotify() {
  try {
    showJamStatus("Connecting to Spotify...");

    // Generate PKCE state + verifier
    _spotifyAuthState = generateRandomString(32);
    _spotifyVerifier = generateRandomString(128);
    var challenge = await generateCodeChallenge(_spotifyVerifier);

    // Tell server to prepare for this auth flow
    var initResp = await fetch(apiUrl("/api/jam/spotify-init"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ state: _spotifyAuthState, verifier: _spotifyVerifier, challenge: challenge })
    });

    if (!initResp.ok) {
      var errText = await initResp.text();
      showJamError("Spotify init failed: " + errText);
      return;
    }

    var initData = await initResp.json();
    var authUrl = initData.auth_url;

    if (!authUrl) {
      showJamError("No auth URL returned from server");
      return;
    }

    // Open Spotify auth in external browser
    if (typeof tauriInvoke === "function" && hasTauriIPC()) {
      try {
        await tauriInvoke("open_url", { url: authUrl });
      } catch (e) {
        window.open(authUrl, "_blank");
      }
    } else {
      window.open(authUrl, "_blank");
    }

    showJamStatus("Waiting for Spotify login...");

    // Poll for the auth code callback
    if (_spotifyPollTimer) clearInterval(_spotifyPollTimer);
    var pollCount = 0;
    var maxPolls = 90; // 3 minutes at 2s intervals
    _spotifyPollTimer = setInterval(async function() {
      pollCount++;
      if (pollCount > maxPolls) {
        clearInterval(_spotifyPollTimer);
        _spotifyPollTimer = null;
        showJamError("Spotify login timed out");
        return;
      }
      try {
        var codeResp = await fetch(apiUrl("/api/jam/spotify-code?state=" + encodeURIComponent(_spotifyAuthState)), {
          headers: { "Authorization": "Bearer " + adminToken }
        });
        if (!codeResp.ok) return; // not ready yet

        var codeData = await codeResp.json();
        if (!codeData.code) return;

        // Got the code! Exchange for token
        clearInterval(_spotifyPollTimer);
        _spotifyPollTimer = null;

        var tokenResp = await fetch(apiUrl("/api/jam/spotify-token"), {
          method: "POST",
          headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
          body: JSON.stringify({ code: codeData.code, verifier: _spotifyVerifier })
        });

        if (tokenResp.ok) {
          showJamStatus("Spotify connected!");
          setTimeout(function() { showJamStatus(""); }, 3000);
          fetchJamState();
        } else {
          var tokenErr = await tokenResp.text();
          showJamError("Token exchange failed: " + tokenErr);
        }
      } catch (e) {
        debugLog("[jam] spotify poll error: " + e);
      }
    }, 2000);

  } catch (e) {
    showJamError("Spotify connect error: " + e.message);
    debugLog("[jam] connectSpotify error: " + e);
  }
}

// ──────────────────────────────────────────
// Jam Controls (Host)
// ──────────────────────────────────────────

async function startJam() {
  try {
    // Find Spotify process for WASAPI capture
    if (typeof hasTauriIPC === "function" && hasTauriIPC()) {
      try {
        var windows = await tauriInvoke("list_capturable_windows");
        var spotify = null;
        if (windows && windows.length) {
          for (var i = 0; i < windows.length; i++) {
            if (windows[i].name && windows[i].name.toLowerCase().indexOf("spotify") !== -1) {
              spotify = windows[i];
              break;
            }
          }
        }
        if (!spotify) {
          showJamError("Open Spotify first!");
          return;
        }
        // Start WASAPI capture with jam-audio track name
        var LK = getLiveKitClient();
        await startNativeAudioCapture(spotify.pid, {
          source: LK.Track.Source.ScreenShareAudio,
          name: "jam-audio"
        });
      } catch (e) {
        debugLog("[jam] WASAPI capture start failed: " + e);
        showJamError("Could not capture Spotify audio: " + e.message);
        return;
      }
    }

    // Tell server to start the jam
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    var resp = await fetch(apiUrl("/api/jam/start"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ identity: identity })
    });

    if (!resp.ok) {
      var errText = await resp.text();
      showJamError("Start failed: " + errText);
      return;
    }

    // Broadcast jam-started via LiveKit data channel
    try {
      var hostName = room && room.localParticipant ? (room.localParticipant.name || room.localParticipant.identity) : "Host";
      var msg = JSON.stringify({ type: "jam-started", host: hostName });
      room.localParticipant.publishData(new TextEncoder().encode(msg), { reliable: true });
    } catch (e) {
      debugLog("[jam] data broadcast error: " + e);
    }

    fetchJamState();
  } catch (e) {
    showJamError("Start jam error: " + e.message);
    debugLog("[jam] startJam error: " + e);
  }
}

async function stopJam() {
  try {
    // Stop WASAPI capture if it's jam audio
    if (typeof _nativeAudioActive !== "undefined" && _nativeAudioActive &&
        typeof _nativeAudioTrackName !== "undefined" && _nativeAudioTrackName === "jam-audio") {
      await stopNativeAudioCapture();
    }

    await fetch(apiUrl("/api/jam/stop"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken }
    });

    // Broadcast jam-stopped
    try {
      var msg = JSON.stringify({ type: "jam-stopped" });
      room.localParticipant.publishData(new TextEncoder().encode(msg), { reliable: true });
    } catch (e) {
      debugLog("[jam] data broadcast error: " + e);
    }

    fetchJamState();
  } catch (e) {
    showJamError("Stop jam error: " + e.message);
    debugLog("[jam] stopJam error: " + e);
  }
}

async function skipTrack() {
  try {
    await fetch(apiUrl("/api/jam/skip"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken }
    });
    fetchJamState();
  } catch (e) {
    showJamError("Skip failed: " + e.message);
    debugLog("[jam] skipTrack error: " + e);
  }
}

// ──────────────────────────────────────────
// Search
// ──────────────────────────────────────────

var _searchTimer = null;

function onSearchInput(e) {
  clearTimeout(_searchTimer);
  var val = e.target.value;
  _searchTimer = setTimeout(function() { searchSpotify(val); }, 300);
}

async function searchSpotify(query) {
  if (!query || query.length < 2) {
    renderSearchResults([]);
    return;
  }
  try {
    var resp = await fetch(apiUrl("/api/jam/search"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query: query })
    });
    if (!resp.ok) {
      debugLog("[jam] search failed: " + resp.status);
      return;
    }
    var data = await resp.json();
    renderSearchResults(data.tracks || []);
  } catch (e) {
    debugLog("[jam] search error: " + e);
  }
}

function renderSearchResults(tracks) {
  var container = document.getElementById("jam-results");
  if (!container) return;
  container.innerHTML = "";
  tracks.forEach(function(t) {
    var item = document.createElement("div");
    item.className = "jam-result-item";
    // Format duration
    var mins = Math.floor(t.duration_ms / 60000);
    var secs = Math.floor((t.duration_ms % 60000) / 1000);
    item.innerHTML =
      '<img class="jam-result-art" src="' + escapeHtml(t.album_art_url || "") + '" alt="">' +
      '<div class="jam-result-info">' +
        '<div class="jam-result-name">' + escapeHtml(t.name) + '</div>' +
        '<div class="jam-result-artist">' + escapeHtml(t.artist) + ' \u00b7 ' + mins + ':' + String(secs).padStart(2, '0') + '</div>' +
      '</div>' +
      '<button class="jam-result-add" title="Add to queue">+</button>';
    item.querySelector(".jam-result-add").onclick = function() { addToQueue(t); };
    container.appendChild(item);
  });
}

// ──────────────────────────────────────────
// Queue
// ──────────────────────────────────────────

async function addToQueue(track) {
  try {
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    var name = room && room.localParticipant ? (room.localParticipant.name || identity) : "";
    await fetch(apiUrl("/api/jam/queue"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        spotify_uri: track.spotify_uri,
        name: track.name,
        artist: track.artist,
        album_art_url: track.album_art_url,
        duration_ms: track.duration_ms,
        added_by: name
      })
    });
    fetchJamState();
  } catch (e) {
    showJamError("Add to queue failed: " + e.message);
    debugLog("[jam] addToQueue error: " + e);
  }
}

// ──────────────────────────────────────────
// Join / Leave
// ──────────────────────────────────────────

async function joinJam() {
  try {
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    await fetch(apiUrl("/api/jam/join"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ identity: identity })
    });
    // Unmute jam audio
    if (_jamAudioEl) {
      _jamAudioEl.muted = false;
      _jamAudioEl.volume = _jamVolume / 100;
    }
    fetchJamState();
  } catch (e) {
    showJamError("Join failed: " + e.message);
    debugLog("[jam] joinJam error: " + e);
  }
}

async function leaveJam() {
  try {
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    await fetch(apiUrl("/api/jam/leave"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ identity: identity })
    });
    // Mute jam audio
    if (_jamAudioEl) {
      _jamAudioEl.muted = true;
    }
    fetchJamState();
  } catch (e) {
    showJamError("Leave failed: " + e.message);
    debugLog("[jam] leaveJam error: " + e);
  }
}

// ──────────────────────────────────────────
// State Polling
// ──────────────────────────────────────────

async function fetchJamState() {
  try {
    var resp = await fetch(apiUrl("/api/jam/state"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!resp.ok) return;
    _jamState = await resp.json();
    renderJamPanel();
  } catch (e) {
    debugLog("[jam] state poll error: " + e);
  }
}

function renderJamPanel() {
  if (!_jamState) return;
  var identity = room && room.localParticipant ? room.localParticipant.identity : "";

  // Spotify status
  var statusEl = document.getElementById("jam-spotify-status");
  if (statusEl) {
    statusEl.textContent = _jamState.spotify_connected ? "Spotify Connected" : "Not Connected";
    statusEl.className = "jam-spotify-status " + (_jamState.spotify_connected ? "connected" : "");
  }

  // Connect button visibility
  var connectBtn = document.getElementById("jam-connect-spotify");
  if (connectBtn) connectBtn.style.display = _jamState.spotify_connected ? "none" : "";

  // Host controls visibility (show if spotify is connected)
  var hostControls = document.getElementById("jam-host-controls");
  if (hostControls) {
    hostControls.style.display = _jamState.spotify_connected ? "" : "none";
  }

  var startBtn = document.getElementById("jam-start-btn");
  var stopBtn = document.getElementById("jam-stop-btn");
  var skipBtn = document.getElementById("jam-skip-btn");
  if (startBtn) startBtn.style.display = _jamState.active ? "none" : "";
  if (stopBtn) stopBtn.style.display = _jamState.active ? "" : "none";
  if (skipBtn) skipBtn.style.display = _jamState.active ? "" : "none";

  // Now Playing
  renderNowPlaying(_jamState.now_playing);

  // Queue
  renderQueue(_jamState.queue || []);

  // Join/Leave
  var isListening = _jamState.listeners && _jamState.listeners.indexOf(identity) !== -1;
  var joinBtn = document.getElementById("jam-join-btn");
  var leaveBtn = document.getElementById("jam-leave-btn");
  var listenCount = document.getElementById("jam-listener-count");
  if (joinBtn) joinBtn.style.display = (!isListening && _jamState.active) ? "" : "none";
  if (leaveBtn) leaveBtn.style.display = (isListening && _jamState.active) ? "" : "none";
  if (listenCount) listenCount.textContent = (_jamState.listener_count || 0) + " listening";

  // Search + queue sections visible only when spotify connected
  var searchSection = document.getElementById("jam-search-section");
  var queueSection = document.getElementById("jam-queue-section");
  if (searchSection) searchSection.style.display = _jamState.spotify_connected ? "" : "none";
  if (queueSection) queueSection.style.display = _jamState.spotify_connected ? "" : "none";

  // Jam actions visible only when jam is active
  var actionsSection = document.getElementById("jam-actions-section");
  if (actionsSection) actionsSection.style.display = _jamState.active ? "" : "none";
}

function renderNowPlaying(np) {
  var container = document.getElementById("jam-now-playing");
  if (!container) return;
  if (!np || !np.name) {
    container.innerHTML = '<div class="jam-now-playing-empty">No music playing</div>';
    return;
  }
  var progress = np.duration_ms > 0 ? Math.min(100, (np.progress_ms / np.duration_ms) * 100) : 0;
  container.innerHTML =
    '<img class="jam-now-playing-art" src="' + escapeHtml(np.album_art_url || "") + '" alt="">' +
    '<div class="jam-now-playing-info">' +
      '<div class="jam-now-playing-name">' + escapeHtml(np.name) + '</div>' +
      '<div class="jam-now-playing-artist">' + escapeHtml(np.artist) + '</div>' +
    '</div>' +
    '<div class="jam-progress"><div class="jam-progress-bar" style="width:' + progress.toFixed(1) + '%"></div></div>';
}

function renderQueue(queue) {
  var container = document.getElementById("jam-queue-list");
  if (!container) return;
  if (!queue.length) {
    container.innerHTML = '<div class="jam-queue-empty">Queue is empty</div>';
    return;
  }
  container.innerHTML = "";
  queue.forEach(function(t, i) {
    var item = document.createElement("div");
    item.className = "jam-queue-item";
    item.innerHTML =
      '<img class="jam-result-art" src="' + escapeHtml(t.album_art_url || "") + '" alt="">' +
      '<div class="jam-result-info">' +
        '<div class="jam-result-name">' + escapeHtml(t.name) + '</div>' +
        '<div class="jam-result-artist">' + escapeHtml(t.artist) + ' \u00b7 Added by ' + escapeHtml(t.added_by) + '</div>' +
      '</div>';
    container.appendChild(item);
  });
}

// ──────────────────────────────────────────
// Jam Audio Handler (called from app.js)
// ──────────────────────────────────────────

function handleJamAudioSubscribed(track, publication, participant) {
  debugLog("[jam] received jam-audio track from " + (participant && participant.identity ? participant.identity : "unknown"));
  var el = track.attach();
  if (!el.srcObject && track.mediaStreamTrack) {
    el.srcObject = new MediaStream([track.mediaStreamTrack]);
  }

  // Check if user has joined the jam
  var identity = room && room.localParticipant ? room.localParticipant.identity : "";
  var isListening = _jamState && _jamState.listeners && _jamState.listeners.indexOf(identity) !== -1;

  el.volume = isListening ? (_jamVolume / 100) : 0;
  el.muted = !isListening;

  var bucket = document.getElementById("audio-bucket");
  if (bucket) bucket.appendChild(el);

  // Apply speaker device
  var speakerSelect = document.getElementById("speaker-select");
  if (speakerSelect && speakerSelect.value && typeof el.setSinkId === "function") {
    el.setSinkId(speakerSelect.value).catch(function() {});
  }

  el.play().catch(function() {});
  _jamAudioEl = el;
}

function handleJamAudioUnsubscribed() {
  if (_jamAudioEl) {
    _jamAudioEl.pause();
    _jamAudioEl.srcObject = null;
    _jamAudioEl.remove();
    _jamAudioEl = null;
  }
}

// ──────────────────────────────────────────
// Volume
// ──────────────────────────────────────────

function onJamVolumeChange(e) {
  _jamVolume = parseInt(e.target.value, 10);
  var label = document.getElementById("jam-volume-value");
  if (label) label.textContent = _jamVolume + "%";
  if (_jamAudioEl && !_jamAudioEl.muted) {
    _jamAudioEl.volume = _jamVolume / 100;
  }
}

// ──────────────────────────────────────────
// Toast Notifications
// ──────────────────────────────────────────

function showJamToast(message) {
  var existing = document.querySelector(".jam-toast");
  if (existing) existing.remove();
  var toast = document.createElement("div");
  toast.className = "jam-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function() { toast.classList.add("jam-toast-visible"); }, 10);
  setTimeout(function() {
    toast.classList.remove("jam-toast-visible");
    setTimeout(function() { toast.remove(); }, 400);
  }, 4000);
}

function showJamError(msg) {
  var el = document.getElementById("jam-status");
  if (el) { el.textContent = msg; el.className = "jam-status error"; }
  setTimeout(function() { if (el) el.textContent = ""; }, 5000);
}

function showJamStatus(msg) {
  var el = document.getElementById("jam-status");
  if (el) { el.textContent = msg; el.className = "jam-status"; }
}

// ──────────────────────────────────────────
// Data Channel Handler (jam messages)
// ──────────────────────────────────────────

function handleJamDataMessage(payload) {
  // payload is already parsed JSON with { type: "jam-started"|"jam-stopped", host: ... }
  if (!payload || !payload.type) return;
  if (payload.type === "jam-started") {
    showJamToast("Jam started by " + (payload.host || "someone") + "!");
    fetchJamState();
  } else if (payload.type === "jam-stopped") {
    showJamToast("Jam session ended");
    fetchJamState();
  }
}

// ──────────────────────────────────────────
// Init
// ──────────────────────────────────────────

function initJam() {
  if (_jamInited) return;
  _jamInited = true;

  // Wire up event listeners
  var closeBtn = document.getElementById("close-jam");
  if (closeBtn) closeBtn.onclick = closeJamPanel;

  var connectBtn = document.getElementById("jam-connect-spotify");
  if (connectBtn) connectBtn.onclick = connectSpotify;

  var startBtn = document.getElementById("jam-start-btn");
  if (startBtn) startBtn.onclick = startJam;

  var stopBtn = document.getElementById("jam-stop-btn");
  if (stopBtn) stopBtn.onclick = stopJam;

  var skipBtn = document.getElementById("jam-skip-btn");
  if (skipBtn) skipBtn.onclick = skipTrack;

  var joinBtn = document.getElementById("jam-join-btn");
  if (joinBtn) joinBtn.onclick = joinJam;

  var leaveBtn = document.getElementById("jam-leave-btn");
  if (leaveBtn) leaveBtn.onclick = leaveJam;

  var searchInput = document.getElementById("jam-search-input");
  if (searchInput) searchInput.oninput = onSearchInput;

  var volumeInput = document.getElementById("jam-volume-slider");
  if (volumeInput) volumeInput.oninput = onJamVolumeChange;

  // Start polling
  fetchJamState();
  _jamPollTimer = setInterval(fetchJamState, 5000);
}

// Cleanup on disconnect (called from app.js if wired up)
function cleanupJam() {
  if (_jamPollTimer) {
    clearInterval(_jamPollTimer);
    _jamPollTimer = null;
  }
  if (_spotifyPollTimer) {
    clearInterval(_spotifyPollTimer);
    _spotifyPollTimer = null;
  }
  _jamState = null;
  _jamInited = false;
  handleJamAudioUnsubscribed();
  closeJamPanel();
}
