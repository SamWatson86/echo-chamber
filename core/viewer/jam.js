/* =========================================================
   JAM SESSION — Communal Spotify listening for Echo Chamber
   Loaded AFTER app.js. Shares global scope with app.js.
   ========================================================= */

// === Globals ===
var _jamState = null;
var _jamPollTimer = null;
var _jamVolume = 50;
var _spotifyAuthState = null;
var _spotifyVerifier = null;
var _spotifyPollTimer = null;
var _jamInited = false;       // lazy init -- don't poll until panel opened once
var _bannerPollTimer = null;  // lightweight poll for now-playing banner (runs even if panel not open)

// WebSocket audio streaming
var _jamAudioWs = null;        // WebSocket connection
var _jamAudioCtx = null;       // AudioContext for playback
var _jamGainNode = null;       // GainNode for volume control
var _jamNextPlayTime = 0;      // next scheduled buffer start time

// === HTML Escape ===
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
        await tauriInvoke("open_external_url", { url: authUrl });
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
// Jam Controls
// ──────────────────────────────────────────

async function startJam() {
  try {
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    debugLog("[jam] startJam called by " + identity);
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

    // Host is auto-joined as listener — start audio stream
    // Small delay to let the bot start capturing
    setTimeout(function() { startJamAudioStream(); }, 2000);
    fetchJamState();
  } catch (e) {
    showJamError("Start jam error: " + e.message);
    debugLog("[jam] startJam error: " + e);
  }
}

async function stopJam() {
  try {
    var identity = room && room.localParticipant ? room.localParticipant.identity : "";
    var stopResp = await fetch(apiUrl("/api/jam/stop"), {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ identity: identity })
    });
    if (!stopResp.ok) {
      if (stopResp.status === 403) {
        showJamError("Only the host can end the Jam");
        return;
      }
      showJamError("Stop failed: " + stopResp.status);
      return;
    }

    // Stop audio stream
    stopJamAudioStream();

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
    renderSearchResults(Array.isArray(data) ? data : (data.tracks || []));
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
    // Start receiving audio via WebSocket
    startJamAudioStream();
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
    // Stop receiving audio
    stopJamAudioStream();
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
    updateNowPlayingBanner(_jamState);
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

  // Strip -XXXX reconnect suffixes for identity comparison
  var idBase = typeof getIdentityBase === "function" ? getIdentityBase : function(id) { return id; };
  var myBase = idBase(identity);

  var startBtn = document.getElementById("jam-start-btn");
  var stopBtn = document.getElementById("jam-stop-btn");
  var skipBtn = document.getElementById("jam-skip-btn");
  if (startBtn) startBtn.style.display = _jamState.active ? "none" : "";
  // End Jam is hidden — jam auto-ends when all listeners leave (30s timeout)
  if (stopBtn) stopBtn.style.display = "none";
  if (skipBtn) skipBtn.style.display = _jamState.active ? "" : "none";

  // Now Playing
  renderNowPlaying(_jamState.now_playing);

  // Queue
  renderQueue(_jamState.queue || []);

  var isListening = false;
  if (_jamState.listeners && myBase) {
    for (var li = 0; li < _jamState.listeners.length; li++) {
      if (idBase(_jamState.listeners[li]) === myBase) { isListening = true; break; }
    }
  }
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
  if (!np || !np.name || !np.is_playing) {
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

  // Click now-playing card to join jam if not already listening
  if (!_jamAudioWs && _jamState && _jamState.active) {
    container.style.cursor = "pointer";
    container.title = "Click to join the Jam";
    container.onclick = function() { joinJam(); };
  } else {
    container.style.cursor = "";
    container.title = "";
    container.onclick = null;
  }
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
      '</div>' +
      '<button class="jam-queue-remove" data-index="' + i + '" title="Remove from queue">\u2715</button>';
    item.querySelector(".jam-queue-remove").addEventListener("click", function() {
      var idx = parseInt(this.getAttribute("data-index"), 10);
      removeFromQueue(idx);
    });
    container.appendChild(item);
  });
}

function removeFromQueue(index) {
  fetch(apiUrl("/api/jam/queue-remove"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
    body: JSON.stringify({ index: index }),
  }).then(function(r) {
    if (r.ok) { fetchJamState(); }
    else { debugLog("[jam] remove failed: " + r.status); }
  }).catch(function(e) { debugLog("[jam] remove error: " + e); });
}

// ──────────────────────────────────────────
// WebSocket Audio Streaming
// ──────────────────────────────────────────

function startJamAudioStream() {
  if (_jamAudioWs) return; // already connected

  try {
    // Build WebSocket URL from current API base (wss for https, ws for http)
    var base = apiUrl("/api/jam/audio");
    var wsUrl;
    if (base.indexOf("https://") === 0) {
      wsUrl = "wss://" + base.substring(8);
    } else if (base.indexOf("http://") === 0) {
      wsUrl = "ws://" + base.substring(7);
    } else {
      var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = proto + "//" + window.location.host + base;
    }

    // WebSocket API doesn't support custom headers, so pass token as query param
    var sep = wsUrl.indexOf("?") >= 0 ? "&" : "?";
    wsUrl += sep + "token=" + encodeURIComponent(adminToken);

    debugLog("[jam] connecting audio WebSocket: " + wsUrl.split("?")[0] + "?token=...");

    // Create AudioContext for playback (48 kHz stereo)
    if (!_jamAudioCtx) {
      _jamAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      _jamGainNode = _jamAudioCtx.createGain();
      _jamGainNode.gain.value = _jamVolume / 100;

      var speakerSelect = document.getElementById("speaker-select");
      if (speakerSelect && speakerSelect.value && typeof _jamAudioCtx.setSinkId === "function") {
        _jamAudioCtx.setSinkId(speakerSelect.value).catch(function() {});
      }

      _jamGainNode.connect(_jamAudioCtx.destination);
    }

    if (_jamAudioCtx.state === "suspended") {
      _jamAudioCtx.resume();
    }

    _jamNextPlayTime = 0;

    var ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    _jamAudioWs = ws;

    ws.onopen = function() {
      debugLog("[jam] audio WebSocket connected");
    };

    ws.onmessage = function(e) {
      if (!(e.data instanceof ArrayBuffer)) return;

      var f32 = new Float32Array(e.data);
      var samplesPerChannel = f32.length / 2;
      if (samplesPerChannel <= 0) return;

      var buffer = _jamAudioCtx.createBuffer(2, samplesPerChannel, 48000);
      var left = buffer.getChannelData(0);
      var right = buffer.getChannelData(1);
      for (var i = 0; i < samplesPerChannel; i++) {
        left[i] = f32[i * 2];
        right[i] = f32[i * 2 + 1];
      }

      var now = _jamAudioCtx.currentTime;
      if (_jamNextPlayTime < now) {
        _jamNextPlayTime = now + 0.02;
      }

      var source = _jamAudioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(_jamGainNode);
      source.start(_jamNextPlayTime);
      _jamNextPlayTime += buffer.duration;
    };

    ws.onclose = function() {
      debugLog("[jam] audio WebSocket closed");
      _jamAudioWs = null;
    };

    ws.onerror = function(e) {
      debugLog("[jam] audio WebSocket error: " + (e.message || e.type || "unknown"));
      _jamAudioWs = null;
    };
  } catch (ex) {
    debugLog("[jam] startJamAudioStream exception: " + ex.message);
  }
}

function stopJamAudioStream() {
  if (_jamAudioWs) {
    _jamAudioWs.close();
    _jamAudioWs = null;
  }
  if (_jamAudioCtx) {
    _jamAudioCtx.close().catch(function() {});
    _jamAudioCtx = null;
    _jamGainNode = null;
  }
  _jamNextPlayTime = 0;
}

// ──────────────────────────────────────────
// Volume
// ──────────────────────────────────────────

function onJamVolumeChange(e) {
  _jamVolume = parseInt(e.target.value, 10);
  var label = document.getElementById("jam-volume-value");
  if (label) label.textContent = _jamVolume + "%";
  if (_jamGainNode) {
    _jamGainNode.gain.value = _jamVolume / 100;
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
// Jam notification chime (Web Audio API)
// ──────────────────────────────────────────

function playJamStartChime() {
  try {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    var ctx = new AudioCtx();
    var now = ctx.currentTime;
    // Fun ascending arpeggio — musical "something exciting is starting"
    var notes = [
      [523.25, 0],      // C5
      [659.25, 0.1],    // E5
      [783.99, 0.2],    // G5
      [1046.5, 0.3]     // C6
    ];
    notes.forEach(function(pair) {
      var freq = pair[0], offset = pair[1];
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.35);
    });
    // Close context after chime finishes
    setTimeout(function() { ctx.close(); }, 1000);
  } catch (e) {
    // silent — chime is non-critical
  }
}

// ──────────────────────────────────────────
// Data Channel Handler (jam messages)
// ──────────────────────────────────────────

function handleJamDataMessage(payload) {
  if (!payload || !payload.type) return;
  if (payload.type === "jam-started") {
    playJamStartChime();
    startBannerPolling();
    fetchJamState();
  } else if (payload.type === "jam-stopped") {
    stopBannerPolling();
    updateNowPlayingBanner(null);
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
  stopBannerPolling();
  updateNowPlayingBanner(null);
  _jamState = null;
  _jamInited = false;
  stopJamAudioStream();
  closeJamPanel();
}

// ──────────────────────────────────────────
// Now Playing Banner (room-top bar)
// ──────────────────────────────────────────

function updateNowPlayingBanner(state) {
  var banner = document.getElementById("jam-banner");
  if (!banner) return;

  if (!state || !state.active || !state.now_playing || !state.now_playing.name || !state.now_playing.is_playing) {
    banner.classList.add("hidden");
    return;
  }

  var np = state.now_playing;
  banner.innerHTML =
    '<img class="jam-banner-art" src="' + escapeHtml(np.album_art_url || "") + '" alt="">' +
    '<div class="jam-banner-info">' +
      '<div class="jam-banner-title">' + escapeHtml(np.name) + '</div>' +
      '<div class="jam-banner-artist">' + escapeHtml(np.artist) + '</div>' +
    '</div>' +
    '<span class="jam-banner-live">JAM</span>';
  banner.classList.remove("hidden");

  // Click banner to open jam panel and auto-join
  if (!banner._jamClickBound) {
    banner.style.cursor = "pointer";
    banner.addEventListener("click", function() {
      openJamPanel();
      // Auto-join if not already listening
      if (_jamState && _jamState.active && !_jamAudioWs) joinJam();
    });
    banner._jamClickBound = true;
  }
}

// Lightweight poll for banner — runs independently of the Jam panel
async function fetchBannerState() {
  try {
    var resp = await fetch(apiUrl("/api/jam/state"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!resp.ok) return;
    var state = await resp.json();
    // Keep _jamState in sync if the panel hasn't initialized its own poll
    if (!_jamPollTimer) _jamState = state;
    updateNowPlayingBanner(state);
    // If jam ended, stop polling
    if (!state.active) stopBannerPolling();
  } catch (e) {
    // silent — banner is non-critical
  }
}

function startBannerPolling() {
  if (_bannerPollTimer) return;  // already running
  if (_jamPollTimer) return;     // full poll already running, it updates the banner
  fetchBannerState();
  _bannerPollTimer = setInterval(fetchBannerState, 5000);
}

function stopBannerPolling() {
  if (_bannerPollTimer) {
    clearInterval(_bannerPollTimer);
    _bannerPollTimer = null;
  }
}
