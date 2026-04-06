/* =========================================================
   CHANGELOG — What's New after each update
   Loaded AFTER app.js. Shares global scope.

   Uses a content stamp (not client binary version) so updates
   show even for viewer-only changes with no new release.
   ========================================================= */

var ECHO_CHANGELOG = [
  {
    version: "2026-04-05b",
    title: "Smart Capture + Quality Alerts",
    notes: [
      "OS-aware capture — auto-detects Windows version, uses WGC on Win11 24H2+, falls back to DXGI DD on older Windows",
      "Stream quality warning — dismissable banner when your game is impacting stream FPS, with 'Don't show again' option",
      "WGC throughput optimization — larger frame buffer + skip-to-latest reduces frame drops during heavy gaming",
      "Friends on Win10 can now screen share (monitor capture via DXGI DD fallback)"
    ]
  },
  {
    version: "2026-04-05",
    title: "WGC Capture + SFU Bandwidth Fix (v0.6.0)",
    notes: [
      "Windows Graphics Capture (WGC) — captures games at 50-60fps even while focused, replaces DXGI DD for game capture",
      "GPU shader pipeline — 4K capture downscaled to 1080p on GPU in under 1ms, no CPU bottleneck",
      "SFU bandwidth fix — stream now delivers full bitrate to all viewers (was throttled to 720kbps)",
      "NVENC encodes every frame — zero skipped frames at up to 20Mbps",
      "No more yellow capture border around shared games",
      "Battlefield 6 at 4K: 53fps capture, viewers see 60fps"
    ]
  },
  {
    version: "2026-04-04",
    title: "DXGI Desktop Duplication Capture",
    notes: [
      "DXGI Desktop Duplication — captures DWM compositor output, works with every game regardless of DX11/DX12/Vulkan, DLSS Frame Generation, HDR, anti-cheat",
      "Works on ALL GPUs (not just NVIDIA) — standard Windows API used by OBS, Discord, etc.",
      "Zero game performance impact — capture reads the compositor's front buffer, no hook DLL injected",
      "Auto-detects availability — falls back to DX11 hook capture when not available",
      "WASAPI per-process audio auto-starts when game capture begins"
    ]
  },
  {
    version: "2026-04-03b",
    title: "DX12 Game Capture + Picker Upgrade",
    notes: [
      "DX12 game capture now works — HDR 10-bit (R10G10B10A2) and other formats auto-converted via GPU shader blit",
      "Capture picker: much better window thumbnails (GPU-rendered apps like Chrome, Discord, VSCode now show previews)",
      "Capture picker: larger thumbnails, clean fallback icon for apps that can't be previewed, double-click to share",
      "Fixed green flash when game capture starts — dark poster overlay until first real frame",
      "3-second startup delay removed — game capture streams start immediately"
    ]
  },
  {
    version: "2026-04-03",
    title: "Game Capture Hook",
    notes: [
      "Full-FPS game capture via Present() hook DLL (DX11)",
      "Custom capture source picker with thumbnails",
      "Monitor capture support (share your entire screen)",
      "Adaptive FPS throttle based on GPU/CPU/network conditions",
      "Automatic fallback to standard capture when game hook is unavailable"
    ]
  },
  {
    version: "2026-04-02",
    title: "v0.5.0 — Native Screen Capture (Game Mode!)",
    notes: [
      "HUGE: Screen sharing now runs natively through Windows capture — completely bypasses browser limitations",
      "Full FPS while gaming — no more 5fps drops when your game has focus",
      "Hardware H264 encoding via NVENC — near-zero CPU cost on NVIDIA GPUs",
      "Custom window picker — select exactly which window to share",
      "Faster freeze recovery — keyframe requests now fire every 200ms instead of 500ms",
      "Fixed: Admin kick/mute buttons were missing (config detection fix)",
      "Fixed: SFU was throttling localhost subscribers to 93kbps (TWCC feedback stripped)"
    ]
  },
  {
    version: "2026-03-15",
    title: "Bug Fixes + Device Switching",
    notes: [
      "Fixed mic/camera switching while connected — no longer requires disconnect/reconnect",
      "Fixed stale device fallback — if saved mic/camera is unplugged, falls back to default instead of failing",
      "Output device dropdown now shows native Windows device names (switching is still a known WebView2 limitation)",
      "Fixed PG-13 Mode not syncing to late joiners — new users now query for room state on connect",
      "Fixed screenshots in bug reports — now embedded directly in GitHub issues"
    ]
  },
  {
    version: "2026-03-14",
    title: "Stream Stability Fix",
    notes: [
      "Fixed stream freezing caused by layer switching oscillation — quality changes no longer trigger instant re-downgrades",
      "AIMD bitrate control ramps gradually instead of instant snap-back (was causing encoder stalls)",
      "Keyframe requests throttled to 1 per 8 seconds per track (was flooding encoder on packet loss)",
      "Stall detection now requires 2+ consecutive 0fps ticks instead of 1 (layer switches naturally cause brief 0fps)",
      "Watchdog recovery tamed — no more subscription cycling storms"
    ]
  },
  {
    version: "2026-03-06",
    title: "Security & Screen Share Fixes",
    notes: [
      "Login rate limiting: Blocks brute-force password guessing (5 attempts per 15 min)",
      "Screen share overflow fixed: No more scrollbars when window is maximized",
      "Screen share stop fix: Browser 'sharing your screen' banner now disappears properly",
      "Path traversal protection on room names and file uploads",
      "Chat security: Blocks malicious external file URLs"
    ]
  },
  {
    version: "2026-03-02",
    title: "PG-13 Mode & Quality of Life",
    notes: [
      "PG-13 Mode: Toggle a room-wide content warning with glowing border + speech announcement",
      "Admin kick/mute buttons restored for server host",
      "Debug button moved to top bar for a cleaner sidebar"
    ]
  },
  {
    version: "2026-02-28",
    title: "Feedback, Chat & Mobile Improvements",
    notes: [
      "Feedback: Title field added, character limit raised to 5000, screenshot upload fixed",
      "Feedback dialog scrolls properly on small screens",
      "Chat: Per-user color coding with unique border stripes",
      "Soundboard: Emoji + name pills with search filter",
      "Screen share: Volume slider on hover over screen tiles",
      "Login page: Clean layout with Advanced toggle for URLs and devices",
      "Mobile: Camera flip button, better disconnect cleanup, 16:9 aspect ratio"
    ]
  },
  {
    version: "v0.4.1",
    title: "Stability & macOS",
    notes: [
      "macOS Apple Silicon support (DMG + auto-updater)",
      "Fix 'Update available' banner version mismatch",
      "Fix jam queue draining when searching for songs",
      "Chat image fullscreen lightbox",
      "Clipboard paste in feedback dialog",
      "12 bug fixes from your reports"
    ]
  },
  {
    version: "v0.4.0",
    title: "Modular Viewer & macOS",
    notes: [
      "Viewer split into focused JS modules for faster updates",
      "macOS Apple Silicon DMG in releases",
      "Camera desync fix, LiveKit stability improvements"
    ]
  },
  {
    version: "v0.3.1",
    title: "Admin Dashboard & Performance",
    notes: [
      "Admin Dashboard with live stats and session history",
      "AIMD bitrate control for adaptive quality",
      "Volume boost and per-participant audio controls",
      "Security: Links open on YOUR computer, not the server",
      "Chat: Videos and audio play inline",
      "Soundboard: See who played each sound",
      "Auto-notification when updates are available",
      "33 issues resolved"
    ]
  },
  {
    version: "v0.3.0",
    title: "Jam Session & Bug Reports",
    notes: [
      "Jam Session: Listen to Spotify together in real-time",
      "Now Playing banner shows current track",
      "Search, queue, and skip songs",
      "Bug report system with screenshots and stats"
    ]
  }
];

// The latest changelog stamp — bump this whenever you add a new entry
var CHANGELOG_LATEST = ECHO_CHANGELOG[0].version;

var _changelogSeenKey = "echo-changelog-seen";

(function initChangelog() {
  setTimeout(function() {
    var lastSeen = null;
    // Use echoGet if available (Tauri persistent storage), else localStorage
    if (typeof echoGet === "function") {
      lastSeen = echoGet(_changelogSeenKey);
    } else {
      lastSeen = localStorage.getItem(_changelogSeenKey);
    }

    if (lastSeen === CHANGELOG_LATEST) {
      return; // Already seen
    }

    // Show the latest entry as a popup
    var latest = ECHO_CHANGELOG[0];
    showWhatsNew(latest.version, latest.title, latest.notes);
    _markChangelogSeen();
  }, 2500);
})();

function _markChangelogSeen() {
  if (typeof echoSet === "function") {
    echoSet(_changelogSeenKey, CHANGELOG_LATEST);
  } else {
    localStorage.setItem(_changelogSeenKey, CHANGELOG_LATEST);
  }
}

function showWhatsNew(version, title, notes) {
  var overlay = document.createElement("div");
  overlay.className = "whats-new-overlay";

  var panel = document.createElement("div");
  panel.className = "whats-new-panel";

  var header = document.createElement("div");
  header.className = "whats-new-header";
  header.innerHTML = '<span class="whats-new-badge">NEW</span>' +
    '<h2>' + _escHtml(title || ("What's New — " + version)) + '</h2>';

  var list = document.createElement("ul");
  list.className = "whats-new-list";
  notes.forEach(function(note) {
    var li = document.createElement("li");
    li.textContent = note;
    list.appendChild(li);
  });

  var footer = document.createElement("div");
  footer.className = "whats-new-footer";
  var btn = document.createElement("button");
  btn.className = "whats-new-close";
  btn.textContent = "Got it";
  btn.addEventListener("click", function() {
    overlay.classList.add("whats-new-closing");
    setTimeout(function() { overlay.remove(); }, 300);
  });
  footer.appendChild(btn);

  panel.appendChild(header);
  panel.appendChild(list);
  panel.appendChild(footer);
  overlay.appendChild(panel);

  overlay.addEventListener("click", function(e) {
    if (e.target === overlay) {
      overlay.classList.add("whats-new-closing");
      setTimeout(function() { overlay.remove(); }, 300);
    }
  });

  document.body.appendChild(overlay);
}

// ── Browsable Updates Panel ──

function showUpdatesPanel() {
  // Remove existing if open
  var existing = document.querySelector(".updates-overlay");
  if (existing) { existing.remove(); return; }

  var overlay = document.createElement("div");
  overlay.className = "whats-new-overlay updates-overlay";

  var panel = document.createElement("div");
  panel.className = "whats-new-panel updates-panel";

  var header = document.createElement("div");
  header.className = "whats-new-header";
  header.innerHTML = '<h2>Update History</h2>';

  var closeBtn = document.createElement("button");
  closeBtn.className = "updates-close-x";
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", function() {
    overlay.classList.add("whats-new-closing");
    setTimeout(function() { overlay.remove(); }, 300);
  });
  header.appendChild(closeBtn);

  panel.appendChild(header);

  ECHO_CHANGELOG.forEach(function(entry, i) {
    var section = document.createElement("div");
    section.className = "updates-entry";
    if (i === 0) section.classList.add("updates-latest");

    var entryHeader = document.createElement("div");
    entryHeader.className = "updates-entry-header";
    var titleEl = document.createElement("h3");
    titleEl.textContent = entry.title || entry.version;
    var versionEl = document.createElement("span");
    versionEl.className = "updates-entry-version";
    versionEl.textContent = entry.version;
    entryHeader.appendChild(titleEl);
    entryHeader.appendChild(versionEl);
    section.appendChild(entryHeader);

    var list = document.createElement("ul");
    list.className = "whats-new-list";
    entry.notes.forEach(function(note) {
      var li = document.createElement("li");
      li.textContent = note;
      list.appendChild(li);
    });
    section.appendChild(list);
    panel.appendChild(section);
  });

  overlay.appendChild(panel);

  overlay.addEventListener("click", function(e) {
    if (e.target === overlay) {
      overlay.classList.add("whats-new-closing");
      setTimeout(function() { overlay.remove(); }, 300);
    }
  });

  // Mark as seen
  _markChangelogSeen();
  // Clear badge
  var badge = document.getElementById("updates-badge");
  if (badge) badge.classList.add("hidden");

  document.body.appendChild(overlay);
}

function _escHtml(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ── Button wiring ──
var openUpdatesBtn = document.getElementById("open-updates");
if (openUpdatesBtn) {
  openUpdatesBtn.addEventListener("click", showUpdatesPanel);

  // Show badge dot if there are unseen updates
  setTimeout(function() {
    var lastSeen = null;
    if (typeof echoGet === "function") {
      lastSeen = echoGet(_changelogSeenKey);
    } else {
      lastSeen = localStorage.getItem(_changelogSeenKey);
    }
    if (lastSeen !== CHANGELOG_LATEST) {
      // Add a small notification dot
      var badge = document.createElement("span");
      badge.id = "updates-badge";
      badge.className = "updates-badge";
      openUpdatesBtn.style.position = "relative";
      openUpdatesBtn.appendChild(badge);
    }
  }, 500);
}
