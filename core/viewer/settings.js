/* =========================================================
   SETTINGS — Persistent settings via Tauri IPC or localStorage
   ========================================================= */

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage errors (private mode / blocked storage)
  }
}

// ─── Persistent Settings (origin-independent) ───
// In native client, settings are stored in a JSON file via Tauri IPC.
// In browser, falls back to localStorage. echoGet/echoSet are synchronous
// after the initial async loadAllSettings() call at startup.
var _settingsCache = {};
var _settingsLoaded = false;
var _settingsSaveTimer = null;

var _SETTINGS_KEYS = [
  "echo-core-theme", "echo-core-ui-opacity",
  "echo-core-soundboard-volume", "echo-core-soundboard-clip-volume",
  "echo-soundboard-favorites", "echo-soundboard-order",
  "echo-noise-cancel", "echo-nc-level",
  "echo-device-mic", "echo-device-cam", "echo-device-speaker",
  "echo-core-remember-name", "echo-core-remember-pass",
  "echo-core-identity-suffix", "echo-core-device-id",
  "echo-avatar-device", "echo-volume-prefs"
];

async function loadAllSettings() {
  if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
    try {
      var json = await tauriInvoke("load_settings");
      _settingsCache = JSON.parse(json || "{}");
      debugLog("[settings] loaded " + Object.keys(_settingsCache).length + " settings from file");
    } catch (e) {
      debugLog("[settings] load_settings failed: " + e + " — using defaults");
      _settingsCache = {};
    }
  }
  // If cache is empty (first run or browser mode), try localStorage migration
  if (Object.keys(_settingsCache).length === 0) {
    var migrated = 0;
    for (var i = 0; i < _SETTINGS_KEYS.length; i++) {
      try {
        var v = localStorage.getItem(_SETTINGS_KEYS[i]);
        if (v !== null) { _settingsCache[_SETTINGS_KEYS[i]] = v; migrated++; }
      } catch (e) {}
    }
    // Also migrate dynamic avatar keys
    try {
      for (var j = 0; j < localStorage.length; j++) {
        var k = localStorage.key(j);
        if (k && k.startsWith("echo-avatar-")) {
          _settingsCache[k] = localStorage.getItem(k);
          migrated++;
        }
      }
    } catch (e) {}
    if (migrated > 0) {
      debugLog("[settings] migrated " + migrated + " settings from localStorage");
      _persistSettings();
    }
  }
  _settingsLoaded = true;
}

function echoGet(key) {
  // Before _settingsCache is assigned (var hoisting), fall back to localStorage
  if (_settingsCache) {
    var v = _settingsCache[key];
    if (v !== undefined) return v;
  }
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function echoSet(key, value) {
  _settingsCache[key] = String(value);
  // Also write to localStorage as fallback
  try { localStorage.setItem(key, String(value)); } catch (e) {}
  // Debounced persist to file (batch rapid writes like volume slider)
  _debouncedPersist();
}

function _debouncedPersist() {
  if (!window.__ECHO_NATIVE__ || !hasTauriIPC()) return;
  // Don't persist until settings have been loaded from file — prevents
  // synchronous init code from overwriting the saved file with defaults
  if (!_settingsLoaded) return;
  if (_settingsSaveTimer) clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(_persistSettings, 300);
}

function _persistSettings() {
  if (!window.__ECHO_NATIVE__ || !hasTauriIPC()) return;
  tauriInvoke("save_settings", { settings: JSON.stringify(_settingsCache) }).catch(function(e) {
    debugLog("[settings] save failed: " + e);
  });
}

// ─── Per-participant volume persistence ───
function _getVolumePrefs() {
  try { return JSON.parse(echoGet("echo-volume-prefs") || "{}"); } catch(e) { return {}; }
}
function _saveVolumePrefs(prefs) {
  echoSet("echo-volume-prefs", JSON.stringify(prefs));
}
function saveParticipantVolume(identity, mic, screen, chime) {
  var prefs = _getVolumePrefs();
  prefs[identity] = { mic: mic, screen: screen, chime: chime };
  _saveVolumePrefs(prefs);
}
function getParticipantVolume(identity) {
  var prefs = _getVolumePrefs();
  return prefs[identity] || null;
}

function _reapplySettingsAfterLoad() {
  // Theme
  var savedTheme = echoGet(THEME_STORAGE_KEY);
  if (savedTheme && savedTheme !== document.body.dataset.theme) {
    debugLog("[settings] reapplying theme: " + savedTheme);
    applyTheme(savedTheme, true);
  }
  // UI opacity
  var savedOpacity = echoGet(UI_OPACITY_KEY);
  if (savedOpacity) applyUiOpacity(parseInt(savedOpacity, 10));
  // Name + password in lobby
  var savedName = echoGet(REMEMBER_NAME_KEY);
  if (savedName && nameInput) nameInput.value = savedName;
  var savedPass = echoGet(REMEMBER_PASS_KEY);
  if (savedPass && passwordInput) passwordInput.value = savedPass;
}

// Fire settings load at startup — async, re-applies settings when loaded.
// setTimeout(fn, 0) defers to a macrotask so ALL scripts are loaded before
// _reapplySettingsAfterLoad runs (otherwise the microtask fires between script
// tags in browser mode, before theme.js defines applyTheme/applyUiOpacity).
var _settingsReadyPromise = loadAllSettings().then(function() {
  setTimeout(function() {
    debugLog("[settings] ready (" + Object.keys(_settingsCache).length + " keys)");
    _reapplySettingsAfterLoad();
  }, 0);
}).catch(function(e) {
  debugLog("[settings] loadAllSettings error: " + e);
});
