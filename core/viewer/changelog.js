/* =========================================================
   CHANGELOG — What's New after each update
   Loaded AFTER app.js. Shares global scope.

   Uses a content stamp (not client binary version) so updates
   show even for viewer-only changes with no new release.
   ========================================================= */

var ECHO_CHANGELOG = [
  {
    version: "2026-04-12b",
    title: "Post-Reboot Connect Hotfix (v0.6.10)",
    notes: [
      "Fixed the nasty desktop crash that could hit right after a reboot when you clicked Connect. The failure was inside the Windows WebView2 callback path, not the room or screen-share logic, and the app now hardens that callback layer instead of aborting the whole process.",
      "This release keeps the high-motion native game-share headroom from v0.6.9, but ships it on a safer desktop runtime after the reboot/connect crash was root-caused and patched."
    ]
  },
  {
    version: "2026-04-12",
    title: "High-Motion Native Game Shares (v0.6.9)",
    notes: [
      "Native game and app-window shares now use a dedicated high-motion publish profile instead of the conservative desktop limits. Heavy games have more bitrate and frame-rate headroom than ordinary desktop sharing.",
      "Test desktop builds are now hardened so prerelease clients do not auto-update over the top of the live installed app."
    ]
  },
  {
    version: "2026-04-11",
    title: "Reliable Screen Share Restarts (v0.6.8)",
    notes: [
      "Native screen sharing now shuts the previous capture task down cleanly before a new $screen publisher connects. Rapid stop/start no longer creates duplicate identities or reconnect churn.",
      "Watching remote screen shares is much more reliable after reconnects and reloads. Existing live shares attach correctly, Start Watching resolves the real $screen companion, and native stop listeners no longer stack across repeated restarts.",
      "The app no longer shows a false New Version Available banner on prerelease-style local builds, and Win10 machines now block unsupported native Windows capture choices instead of failing silently.",
      "Static native window shares keep their stream alive with heartbeat frames, and native publish pacing is aligned to the intended 30fps wire target.",
      "Native game shares no longer inherit desktop-share limits. High-motion window/game capture now uses a dedicated 60fps profile with a higher bitrate ceiling, so heavy games have more headroom than ordinary desktop sharing."
    ]
  },
  {
    version: "2026-04-09b",
    title: "Stability + Smart Defaults (v0.6.7)",
    notes: [
      "AMD/Intel users: capture rate now capped at 20fps to prevent the CPU crash Jeff experienced during a 54-minute 4-publisher stress test. Software encoding at 60+ fps was pinning the CPU at ~90%. 20fps is smooth for screen content and sustainable indefinitely.",
      "Capture health false-alarm fixes: 10-second grace period after starting a share (no more Red flash on startup), and the banner requires 2 consecutive Red cycles before firing (no more flapping alarms).",
      "Correct encoder detection: AMD/Intel machines now show 'OpenH264' on the capture health chip instead of incorrectly claiming NVENC. The admin can see at a glance who has hardware vs software encoding.",
      "GPU flicker recovery script: if Sam's display driver gets wedged again, there's now a PowerShell script at tools/gpu-flicker-recovery.ps1 that tries non-reboot recovery before falling back to 'reboot required'.",
      "Screen share opt-in fixed: other people's screen shares no longer auto-appear in your grid before you click 'Start Watching'. Also fixes the grid layout stacking horizontally instead of 2x2."
    ]
  },
  {
    version: "2026-04-09",
    title: "Actually works on AMD/Intel GPUs (v0.6.6)",
    notes: [
      "v0.6.5 was supposed to fix the AMD/Intel brick but it didn't actually work — the delay-load linker flag was emitted from the wrong build script (a library crate) and cargo silently ignored it. The shipped binary had nvcuda.dll as a normal import resolved at process startup, exactly like v0.6.4, and Jeff's machine still wouldn't launch.",
      "v0.6.6 puts the linker flag in the right place (the binary crate's build.rs). Verified via dumpbin that nvcuda.dll is now in the DELAY IMPORTS section instead of the normal IMPORTS section. AMD/Intel machines launch cleanly and fall back to OpenH264. NVIDIA users keep hardware NVENC/NVDEC unchanged.",
      "Sorry about the v0.6.5 false alarm. The lesson: always verify the shipped binary's actual imports with dumpbin before claiming a fix works."
    ]
  },
  {
    version: "2026-04-08c",
    title: "Works on AMD/Intel GPUs again (v0.6.5)",
    notes: [
      "Critical fix: v0.6.3 and v0.6.4 had a hard dependency on nvcuda.dll which only exists on machines with NVIDIA drivers. Friends with AMD or Intel GPUs (like Jeff) couldn't even launch the app — it would error with 'The code execution cannot proceed because nvcuda.dll was not found' before any code ran. v0.6.5 makes the NVIDIA hardware encoder a delay-loaded optional dependency: NVIDIA users still get hardware encode + decode automatically, AMD/Intel users fall back to software encoding cleanly without crashing.",
      "Same pattern OBS, Discord, and most production video apps use for optional GPU codec libraries.",
      "If you were stuck on v0.6.2 because of the brick on v0.6.3+, you can update normally now. If you manually downgraded to v0.6.2 to escape the brick, the auto-updater will offer v0.6.5 next time you launch."
    ]
  },
  {
    version: "2026-04-08b",
    title: "Fewer False Alarms (v0.6.4)",
    notes: [
      "The capture-health chip no longer flashes red when you share a specific window of static content (like a web page that isn't changing). Window capture is 'event-driven' — it only fires when the window actually repaints — so a still browser naturally produces only 1-5 frames per second, and the classifier was incorrectly interpreting that as degraded capture. Now the fps threshold only applies to entire-screen captures (which poll at full rate) so WGC window sharing stays green when things are fine.",
      "Other real problems (reinits, encoder fallback, shader errors, consecutive capture timeouts) still trigger the red banner correctly on window capture — only the 'low fps' false positive is removed.",
      "Known limitation (will fix in v0.6.5): when you share a specific window that isn't changing, viewers will see your mouse and scrolling at a lower frame rate. Switching back to 'entire screen' share gives smoother playback for mostly-static content, at the cost of more CPU. Heartbeat frame duplication for static window captures is planned for the next release."
    ]
  },
  {
    version: "2026-04-08",
    title: "Hardware Encoding for Everyone (v0.6.3)",
    notes: [
      "Hardware NVENC encoding in the installer — the biggest one. Every friend who installs via auto-updater now gets real NVIDIA NVENC hardware encoding instead of OpenH264 software fallback. OpenH264 was capped at ~9 fps which is why screen shares have been miserable up to now. Fixed at the CI level so it just works going forward.",
      "Hardware NVDEC decoding too — as a bonus, the new CI build also includes NVDEC, so hardware H.264 decoding of everyone else's streams is enabled.",
      "Capture pipeline health monitor — Sam now has an admin panel inside the client showing each participant's capture health as a colored chip (Green / Yellow / Red) with live fps, reinit count, consecutive-timeout count, encoder type, and capture mode. Yellow→Red transitions pop a top banner + alert chime. Lets us catch capture degradation before it becomes a visible problem.",
      "Admin login from inside the viewer — new 🛡 Admin button on the connect screen so Sam can become admin without opening a separate browser tab. Token persists across reloads. Panel toggles from the badge so it doesn't cover your share controls.",
      "Per-receiver stats — every client now reports what each receiver actually sees from each publisher (fps, packet loss, NACK, PLI, jitter, ICE candidate type). Lets us diagnose 'why does David see it differently than Decker' mysteries with real numbers instead of guessing.",
      "Win+P no longer kills your screen share — DXGI_ERROR_INVALID_CALL on display mode change was silently breaking the capture loop. Now treated the same as access-lost: drop the interface, reinit, keep going.",
      "Fewer false alarms on the health chip — target fps is now the real wire rate (30), not the hardcoded 60 placeholder.",
      "Encoder fallback automatically flagged — if libwebrtc ever falls back to OpenH264 at runtime, the chip turns Red immediately so we know before the quality disaster happens."
    ]
  },
  {
    version: "2026-04-07b",
    title: "No More Stuck Sessions",
    notes: [
      "Forced auto-reload — when the server is updated or a session-disrupting change happens, you'll see a red countdown banner and the app will refresh itself in 5 seconds. No more sitting in a dead room wondering why nobody's there.",
      "Sam can also push a manual reload to all connected clients from the admin dashboard, useful when SFU/network state goes weird without a full server restart."
    ]
  },
  {
    version: "2026-04-07",
    title: "Stream Stability + Image Quality (v0.6.2)",
    notes: [
      "Colors fixed — HDR displays no longer produce washed-out, lifted-black screen shares. If you have an HDR monitor and your colors looked grey before, this is the big one.",
      "Text is readable again — NVENC tuning switched to LOW_LATENCY with spatial/temporal adaptive quantization and a 1-second rate control buffer. Text, cursor, and fine detail stay sharp instead of turning into 'blob smearing.'",
      "Colorspace correctly tagged — H.264 bitstream now declares BT.709 so receiving clients apply the right color matrix. No more subtle green/red shifts.",
      "Proxy stability — full-duplex SFU proxy rewrite eliminates the 10-15 second reconnect cycles that plagued external viewers under real internet conditions. Validated with a 21-minute continuous share over WAN.",
      "No more zero-FPS drops — 2.5 Mbps minimum bitrate floor prevents the rate controller from collapsing the stream under packet loss. Stream stays visible and recovers on its own.",
      "Capture self-recovery — screen share no longer dies if the desktop capture briefly stalls under heavy load. The capture loop automatically reinitializes instead of quitting.",
      "Aspect ratio preserved — ultrawide displays (3440×1440 etc.) no longer stretched when shared.",
      "Grid layout fix — 3 screen shares now land in a 2x2 grid instead of stacking horizontally.",
      "Fullscreen + volume button layout — no more overlap on screen tiles.",
      "Screen share chime fix — the shared-screen companion no longer plays the enter/exit chime of the person who started the share.",
      "Known limitation: cursor not visible in entire-screen shares (landing in v0.6.3).",
      "Known limitation: stream quality can dip briefly when a slow receiver joins mid-stream (landing in v0.6.3)."
    ]
  },
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
