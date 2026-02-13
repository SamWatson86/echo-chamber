/* =========================================================
   CHANGELOG — What's New after each update
   Loaded AFTER app.js. Shares global scope.
   ========================================================= */

var ECHO_CHANGELOG = {
  "0.3.0": [
    "Jam Session: Listen to Spotify together in real-time with everyone in the room",
    "Now Playing banner shows the current track at the top of the screen",
    "Search for songs, queue them up, and skip tracks",
    "Audio streams automatically to all connected listeners",
    "Bug report system: report issues directly from the app",
    "Performance metrics displayed in settings"
  ],
  "0.2.9": [
    "macOS support for Apple Silicon",
    "Screen share improvements and adaptive quality",
    "Various bug fixes and stability improvements"
  ]
};

// Current app version (set by Tauri IPC or fallback)
var _whatsNewVersion = null;

(function initWhatsNew() {
  // Only run in native client
  if (!window.__ECHO_NATIVE__) return;

  // Wait for Tauri IPC to be ready
  setTimeout(function() {
    if (typeof tauriInvoke !== "function") return;
    tauriInvoke("get_app_info").then(function(info) {
      if (!info || !info.version) return;
      _whatsNewVersion = info.version;

      var storageKey = "echo-whats-new-seen";
      var lastSeen = localStorage.getItem(storageKey);
      if (lastSeen === info.version) return; // Already seen this version

      var notes = ECHO_CHANGELOG[info.version];
      if (!notes || !notes.length) return; // No notes for this version

      showWhatsNew(info.version, notes);
      localStorage.setItem(storageKey, info.version);
    }).catch(function() {});
  }, 2000);
})();

function showWhatsNew(version, notes) {
  // Build the overlay
  var overlay = document.createElement("div");
  overlay.className = "whats-new-overlay";

  var panel = document.createElement("div");
  panel.className = "whats-new-panel";

  var header = document.createElement("div");
  header.className = "whats-new-header";
  header.innerHTML = '<span class="whats-new-badge">NEW</span>' +
    '<h2>What\'s New in v' + version + '</h2>';

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

  // Close on overlay click
  overlay.addEventListener("click", function(e) {
    if (e.target === overlay) {
      overlay.classList.add("whats-new-closing");
      setTimeout(function() { overlay.remove(); }, 300);
    }
  });

  document.body.appendChild(overlay);
}
