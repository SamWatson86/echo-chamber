/* =========================================================
   THEME — Theme switching, special effects, and UI opacity
   ========================================================= */

// Version info + Update button at bottom of settings.
// Called after room connect so it appears after the device/NC/chime sections.
function shouldShowDesktopUpdater(options) {
  var opts = options || {};
  return opts.nativeShell === true && opts.hasIpc === true;
}

function buildVersionSection() {
  if (!settingsDevicePanel) return;
  if (document.getElementById("version-settings-section")) return;
  var section = document.createElement("div");
  section.id = "version-settings-section";
  section.className = "chime-settings-section";
  section.innerHTML = '<div class="chime-settings-title">About</div>';
  var versionRow = document.createElement("div");
  versionRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-top:6px;";
  var versionLabel = document.createElement("span");
  versionLabel.id = "app-version-label";
  versionLabel.textContent = "Version: ...";
  versionLabel.style.cssText = "opacity:0.7; font-size:13px;";
  var updateBtn = document.createElement("button");
  updateBtn.type = "button";
  updateBtn.textContent = "Check for Updates";
  updateBtn.style.cssText = "font-size:12px; padding:4px 10px; cursor:pointer;";
  var updateStatus = document.createElement("span");
  updateStatus.id = "update-status";
  updateStatus.style.cssText = "font-size:12px; opacity:0.7; margin-left:4px;";
  versionRow.appendChild(versionLabel);
  var showDesktopUpdater = shouldShowDesktopUpdater({
    nativeShell: window.__ECHO_NATIVE__ === true,
    hasIpc: hasTauriIPC(),
  });
  if (showDesktopUpdater) versionRow.appendChild(updateBtn);
  versionRow.appendChild(updateStatus);
  section.appendChild(versionRow);
  settingsDevicePanel.appendChild(section);

  (async function() {
    try {
      if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
        var info = await tauriInvoke("get_app_info");
        versionLabel.textContent = "Version: v" + info.version + " (" + info.platform + ")";
      } else {
        versionLabel.textContent = "Version: browser viewer";
      }
    } catch (e) {
      versionLabel.textContent = "Version: unknown";
    }
  })();

  if (!showDesktopUpdater) {
    updateStatus.textContent = "Updates automatically with the Echo server.";
    return;
  }

  updateBtn.addEventListener("click", async function() {
    updateBtn.disabled = true;
    updateStatus.textContent = "Checking...";
    try {
      var cUrl = controlUrlInput ? controlUrlInput.value.trim() : "";
      var currentVer = versionLabel.textContent.replace(/^Version:\s*v?/, "").split(" ")[0];
      if (typeof isLocalTestBuildVersion === "function" && isLocalTestBuildVersion(currentVer)) {
        updateStatus.textContent = "Local test build — auto-update disabled.";
        updateBtn.disabled = false;
        return;
      }
      var latestClient = "";
      if (cUrl) {
        var verResp = await fetch(cUrl + "/api/version");
        if (verResp.ok) {
          var verData = await verResp.json();
          latestClient = verData.latest_client || "";
        }
      }
      if (latestClient && currentVer && currentVer !== "browser" && currentVer !== "unknown" && currentVer !== "..." && isNewerVersion(latestClient, currentVer)) {
        updateStatus.textContent = "Update available: v" + latestClient + "!";
        if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
          try {
            var result = await tauriInvoke("check_for_updates");
            if (result === "local_test_build") {
              updateStatus.textContent = "Local test build — auto-update disabled.";
            } else if (result !== "up_to_date") {
              updateStatus.textContent = "Installing v" + latestClient + "... app will restart.";
            }
          } catch (e2) { /* auto-update unavailable */ }
        }
      } else if (currentVer && currentVer !== "browser" && currentVer !== "unknown" && currentVer !== "...") {
        updateStatus.textContent = "You're on the latest version!";
      } else if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
        var fallbackResult = await tauriInvoke("check_for_updates");
        if (fallbackResult === "local_test_build") {
          updateStatus.textContent = "Local test build — auto-update disabled.";
        } else {
          updateStatus.textContent = fallbackResult === "up_to_date"
            ? "You're on the latest version!"
            : "Installing... app will restart.";
        }
      } else {
        updateStatus.textContent = "Version check not available in browser.";
      }
    } catch (e) {
      debugLog("[updater] check failed: " + (e.message || e));
      updateStatus.textContent = "Update check failed.";
    }
    updateBtn.disabled = false;
  });
}

// ============================================================================
// THEME EFFECTS
// ============================================================================

var themeEffectController = null;
if (
  window.EchoThemeEffects &&
  typeof window.EchoThemeEffects.createThemeEffectController === "function"
) {
  themeEffectController = window.EchoThemeEffects.createThemeEffectController({
    document: document,
    window: window,
  });
}

function stopActiveThemeEffect() {
  if (themeEffectController) themeEffectController.stop();
}

function syncThemeEffects(state) {
  if (themeEffectController) themeEffectController.sync(state);
}

window.EchoThemeEffectDiagnostics = Object.freeze({
  getMetrics: function () {
    return themeEffectController
      ? themeEffectController.getMetrics()
      : Object.freeze({ active: false });
  },
});

// ============================================================================
// THEME STUDIO
// ============================================================================

var THEME_PRESENTATION = {
  frost: {
    badge: "Default",
    vibe: "Cobalt glass, electric cyan, clean depth.",
  },
  cyberpunk: {
    badge: "Pop",
    vibe: "Hot pink, aqua, and a hit of acid energy.",
  },
  aurora: {
    badge: "Flow",
    vibe: "Emerald light folding through deep indigo.",
  },
  ember: {
    badge: "Warm",
    vibe: "Coral glow, amber sparks, and dark plum.",
  },
  matrix: {
    badge: "Digital",
    vibe: "Falling code, phosphor glow, and the classic digital rain.",
  },
  "event-horizon": {
    badge: "Cosmic",
    vibe: "Violet nebulae, cold starlight, and impossible depth.",
  },
  tempest: {
    badge: "Storm",
    vibe: "Slate clouds, cold rain, and distant electric light.",
  },
  abyss: {
    badge: "Ocean",
    vibe: "Deep water, bioluminescent currents, and drifting light.",
  },
  "neon-wilds": {
    badge: "Living",
    vibe: "Midnight foliage, luminous moss, and wandering fireflies.",
  },
  midnight: {
    badge: "Quiet",
    vibe: "Graphite, soft silver, and restrained lilac.",
  },
  "ultra-instinct": {
    badge: "Autonomous",
    vibe: "It's astounding! This mortal really is something else...Look at that brilliant form...There can be no doubt! This is the true power, complete in all its majesty! This is... AUTONOMOUS ULTRA INSTINCT!!!!",
  },
};

var MOTION_PRESENTATION = {
  still: "Zero decorative animation.",
  ambient: "Slow, restrained atmosphere.",
  full: "Complete theme effects.",
};

var MODULE_PRESENTATION = {
  stage: "Workspace and shared media",
  people: "Participant rail",
  chat: "Conversation panel",
  jam: "Shared listening",
  camera: "Pre-stage camera view",
  soundboard: "Compact and editor views",
  settings: "Device and app controls",
  capture: "Window and screen picker",
};

var themeRuntime = window.EchoThemeRuntime;
var themeController = null;
var themeStudioLastFocus = null;
var themeStudioStatus = document.getElementById("theme-status");
var themeStudioScrim = document.getElementById("theme-studio-scrim");
var themeStudioGrid = document.getElementById("theme-grid");
var themeCoreGrid = document.getElementById("theme-core-grid");
var themeAnimatedGrid = document.getElementById("theme-animated-grid");
var themeMotionOptions = document.getElementById("theme-motion-options");
var themeModuleGrid = document.getElementById("theme-module-grid");
var themeResetModules = document.getElementById("theme-reset-modules");
var themePortalButton = document.getElementById("open-theme-portal");

function themeLabel(themeId) {
  if (!themeController) return themeId;
  var match = themeController.getCatalog().find(function (theme) {
    return theme.id === themeId;
  });
  return match ? match.label : themeId;
}

function announceThemeStatus(message, tone) {
  if (!themeStudioStatus) return;
  themeStudioStatus.textContent = message || "";
  themeStudioStatus.classList.remove("is-success", "is-warning", "is-error");
  if (tone) themeStudioStatus.classList.add("is-" + tone);
}

function createThemeCard(theme) {
  var presentation = THEME_PRESENTATION[theme.id] || {};
  var card = document.createElement("button");
  card.type = "button";
  card.className = "theme-card";
  card.dataset.theme = theme.id;
  card.setAttribute("aria-label", "Use " + theme.label + " everywhere");
  card.setAttribute("aria-pressed", "false");

  var preview = document.createElement("span");
  preview.className = "theme-preview " + theme.id + "-preview";
  preview.dataset.theme = theme.id;
  preview.setAttribute("aria-hidden", "true");

  var copy = document.createElement("span");
  copy.className = "theme-card-copy";
  var name = document.createElement("span");
  name.className = "theme-name";
  name.textContent = theme.label;
  var badge = document.createElement("span");
  badge.className = "theme-badge";
  badge.textContent = presentation.badge || "Theme";
  var vibe = document.createElement("span");
  vibe.className = "theme-vibe";
  vibe.textContent = presentation.vibe || "A complete Echo look.";
  copy.appendChild(name);
  copy.appendChild(badge);
  copy.appendChild(vibe);
  card.appendChild(preview);
  card.appendChild(copy);

  card.addEventListener("click", function () {
    applyTheme(theme.id);
    announceThemeStatus(theme.label + " now flows through all of Echo.", "success");
  });
  return card;
}

function createMotionOption(motion) {
  var option = document.createElement("button");
  option.type = "button";
  option.className = "theme-motion-option";
  option.dataset.motion = motion.id;
  option.setAttribute("aria-pressed", "false");
  var name = document.createElement("strong");
  name.className = "theme-motion-option-name";
  name.textContent = motion.label;
  var copy = document.createElement("small");
  copy.className = "theme-motion-option-copy";
  copy.textContent = MOTION_PRESENTATION[motion.id] || "";
  option.appendChild(name);
  option.appendChild(copy);
  option.addEventListener("click", function () {
    applyMotionPreference(motion.id);
    var state = themeController.getState();
    if (state.reducedMotion && motion.id !== "still") {
      announceThemeStatus(
        motion.label + " is saved. Your system reduced-motion setting keeps Echo still for now.",
        "warning"
      );
    } else {
      announceThemeStatus("Motion set to " + motion.label + ".", "success");
    }
  });
  return option;
}

function createModuleRow(moduleDefinition, themes) {
  var row = document.createElement("label");
  row.className = "theme-module-row";
  row.dataset.themeModule = moduleDefinition.id;

  var copy = document.createElement("span");
  copy.className = "theme-module-copy";
  var name = document.createElement("strong");
  name.textContent = moduleDefinition.label;
  var description = document.createElement("small");
  description.textContent = MODULE_PRESENTATION[moduleDefinition.id] || "Echo space";
  copy.appendChild(name);
  copy.appendChild(description);

  var select = document.createElement("select");
  select.className = "theme-module-select";
  select.dataset.themeModuleSelect = moduleDefinition.id;
  select.setAttribute("aria-label", moduleDefinition.label + " theme");
  var followGlobal = document.createElement("option");
  followGlobal.value = "global";
  followGlobal.textContent = "Follow global";
  select.appendChild(followGlobal);
  [
    { id: "core", label: "Core Looks" },
    { id: "animated", label: "Animated Worlds" },
  ].forEach(function (collection) {
    var group = document.createElement("optgroup");
    group.label = collection.label;
    themes.forEach(function (theme) {
      if ((theme.collection || "core") !== collection.id) return;
      var option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.label;
      group.appendChild(option);
    });
    select.appendChild(group);
  });
  select.addEventListener("change", function () {
    var selected = select.value;
    applyModuleTheme(moduleDefinition.id, selected);
    if (selected === "global") {
      announceThemeStatus(moduleDefinition.label + " is following the global look again.", "success");
    } else {
      announceThemeStatus(
        moduleDefinition.label + " now uses " + themeLabel(selected) + ".",
        "success"
      );
    }
  });

  row.appendChild(copy);
  row.appendChild(select);
  return row;
}

function buildThemeStudio() {
  if (!themeController) return;
  var themes = themeController.getCatalog();

  if (themeCoreGrid && themeAnimatedGrid) {
    themeCoreGrid.textContent = "";
    themeAnimatedGrid.textContent = "";
    themes.forEach(function (theme) {
      var target = theme.collection === "animated"
        ? themeAnimatedGrid
        : themeCoreGrid;
      target.appendChild(createThemeCard(theme));
    });
  }

  if (themeMotionOptions) {
    themeMotionOptions.textContent = "";
    themeController.getMotionLevels().forEach(function (motion) {
      themeMotionOptions.appendChild(createMotionOption(motion));
    });
  }

  if (themeModuleGrid) {
    themeModuleGrid.textContent = "";
    themeController.getModules().forEach(function (moduleDefinition) {
      themeModuleGrid.appendChild(createModuleRow(moduleDefinition, themes));
    });
  }
}

function syncThemeStudio(state) {
  if (!state) return;
  if (themeStudioGrid) {
    themeStudioGrid.querySelectorAll(".theme-card").forEach(function (card) {
      var active = card.dataset.theme === state.globalTheme;
      card.classList.toggle("is-active", active);
      card.setAttribute("aria-pressed", String(active));
    });
  }
  if (themeMotionOptions) {
    themeMotionOptions.querySelectorAll(".theme-motion-option").forEach(function (option) {
      var active = option.dataset.motion === state.requestedMotion;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-pressed", String(active));
    });
  }
  if (themeModuleGrid) {
    themeModuleGrid.querySelectorAll("[data-theme-module-select]").forEach(function (select) {
      var moduleId = select.dataset.themeModuleSelect;
      select.value = state.overrides[moduleId] || "global";
      if (select.options.length) {
        select.options[0].textContent = "Follow global · " + themeLabel(state.globalTheme);
      }
    });
  }
  if (themeResetModules) {
    themeResetModules.disabled = Object.keys(state.overrides).length === 0;
  }
}

function isThemeStudioOpen() {
  return !!themePanel && !themePanel.classList.contains("hidden");
}

function setThemeStudioOpen(open) {
  if (!themePanel) return;
  var shouldOpen = open === true;
  if (shouldOpen === isThemeStudioOpen()) return;

  if (shouldOpen) themeStudioLastFocus = document.activeElement;
  themePanel.classList.toggle("hidden", !shouldOpen);
  themePanel.setAttribute("aria-hidden", String(!shouldOpen));
  if (themeStudioScrim) {
    themeStudioScrim.classList.toggle("hidden", !shouldOpen);
    themeStudioScrim.setAttribute("aria-hidden", String(!shouldOpen));
  }
  [openThemeButton, themePortalButton].forEach(function (opener) {
    if (opener) opener.setAttribute("aria-expanded", String(shouldOpen));
  });

  if (shouldOpen) {
    var state = themeController ? themeController.getState() : null;
    syncThemeStudio(state);
    if (state && state.reducedMotion && state.requestedMotion !== "still") {
      announceThemeStatus(
        "System reduced motion is active. Your saved motion choice will return when that setting is off.",
        "warning"
      );
    }
    requestAnimationFrame(function () {
      var selectedCard = themePanel.querySelector('.theme-card[aria-pressed="true"]');
      (selectedCard || closeThemeButton || themePanel).focus();
    });
  } else {
    announceThemeStatus("");
    if (
      themeStudioLastFocus &&
      themeStudioLastFocus.isConnected &&
      typeof themeStudioLastFocus.focus === "function"
    ) {
      themeStudioLastFocus.focus();
    }
    themeStudioLastFocus = null;
  }
}

function trapThemeStudioFocus(event) {
  if (!isThemeStudioOpen()) return;
  if (event.key === "Escape") {
    event.preventDefault();
    setThemeStudioOpen(false);
    return;
  }
  if (event.key !== "Tab") return;
  var focusable = Array.prototype.filter.call(
    themePanel.querySelectorAll(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])'
    ),
    function (element) {
      return element.getClientRects().length > 0;
    }
  );
  if (!focusable.length) {
    event.preventDefault();
    themePanel.focus();
    return;
  }
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  if (!themePanel.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function applyTheme(name, skipSave) {
  if (!themeController) return false;
  return themeController.setGlobalTheme(name, { persist: skipSave !== true });
}

function applyMotionPreference(level) {
  return themeController ? themeController.setMotion(level) : false;
}

function applyModuleTheme(moduleId, themeId) {
  return themeController ? themeController.setModuleTheme(moduleId, themeId) : false;
}

function reloadThemePreferences() {
  return themeController ? themeController.reloadFromSettings() : null;
}

function initTheme() {
  return reloadThemePreferences();
}

if (themeRuntime && typeof themeRuntime.createThemeController === "function") {
  themeController = themeRuntime.createThemeController({
    document: document,
    matchMedia: window.matchMedia ? window.matchMedia.bind(window) : null,
    readSetting: echoGet,
    writeSetting: echoSet,
    syncEffects: syncThemeEffects,
  });
  window.EchoTheme = themeController;
  buildThemeStudio();
  syncThemeStudio(themeController.getState());
  themeController.subscribe(syncThemeStudio);
}

if (openThemeButton && themePanel) {
  openThemeButton.addEventListener("click", function () {
    setThemeStudioOpen(true);
  });
}
if (themePortalButton && themePanel) {
  themePortalButton.addEventListener("click", function () {
    setThemeStudioOpen(true);
  });
}
if (closeThemeButton && themePanel) {
  closeThemeButton.addEventListener("click", function () {
    setThemeStudioOpen(false);
  });
}
if (themeStudioScrim) {
  themeStudioScrim.addEventListener("click", function () {
    setThemeStudioOpen(false);
  });
}
if (themeResetModules) {
  themeResetModules.addEventListener("click", function () {
    if (!themeController) return;
    themeController.clearModuleOverrides();
    announceThemeStatus("Every space is following the global look.", "success");
  });
}
document.addEventListener("keydown", trapThemeStudioFocus);
window.addEventListener("pagehide", stopActiveThemeEffect);
window.addEventListener("pageshow", function () {
  if (
    themeController &&
    (
      typeof themeController.isDestroyed !== "function" ||
      !themeController.isDestroyed()
    )
  ) {
    syncThemeEffects(themeController.getState());
  }
});

// ============================================================================
// UI TRANSPARENCY
// ============================================================================

function applyUiOpacity(value, skipSave) {
  var parsed = Number(value);
  if (!Number.isFinite(parsed)) parsed = 100;
  var clamped = Math.max(20, Math.min(100, Math.round(parsed)));
  document.documentElement.style.setProperty("--ui-bg-alpha", clamped / 100);
  document.documentElement.style.setProperty(
    "--theme-opacity-progress",
    (((clamped - 20) / 80) * 100) + "%"
  );
  if (skipSave !== true) echoSet(UI_OPACITY_KEY, clamped);
  if (uiOpacityValue) uiOpacityValue.textContent = clamped + "%";
  if (uiOpacitySlider && parseInt(uiOpacitySlider.value, 10) !== clamped) {
    uiOpacitySlider.value = clamped;
  }
  return clamped;
}

applyUiOpacity(parseInt(echoGet(UI_OPACITY_KEY) || "100", 10), true);

if (uiOpacitySlider) {
  uiOpacitySlider.addEventListener("input", function (event) {
    applyUiOpacity(parseInt(event.target.value, 10));
  });
}
