/* =========================================================
   THEME — Theme switching, special effects, and UI opacity
   ========================================================= */

// ── Version info + Update button at bottom of settings ──
// Called after room connect so it appears at the bottom (after device/NC/chime sections)
function buildVersionSection() {
  if (!settingsDevicePanel) return;
  if (document.getElementById("version-settings-section")) return; // already built
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
  versionRow.appendChild(updateBtn);
  versionRow.appendChild(updateStatus);
  section.appendChild(versionRow);
  settingsDevicePanel.appendChild(section);

  // Populate version from Tauri IPC or fallback
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

  // Check for updates — query server /api/version then try Tauri auto-update
  updateBtn.addEventListener("click", async function() {
    updateBtn.disabled = true;
    updateStatus.textContent = "Checking...";
    try {
      var cUrl = controlUrlInput ? controlUrlInput.value.trim() : "";
      var currentVer = versionLabel.textContent.replace(/^Version:\s*v?/, "").split(" ")[0];
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
        // Try Tauri auto-update if available
        if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
          try {
            var result = await tauriInvoke("check_for_updates");
            if (result !== "up_to_date") {
              updateStatus.textContent = "Installing v" + latestClient + "... app will restart.";
            }
          } catch (e2) { /* auto-update unavailable */ }
        }
      } else if (currentVer && currentVer !== "browser" && currentVer !== "unknown" && currentVer !== "...") {
        updateStatus.textContent = "You're on the latest version!";
      } else {
        // Fallback for browser viewer or unknown version
        if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
          var result = await tauriInvoke("check_for_updates");
          updateStatus.textContent = result === "up_to_date" ? "You're on the latest version!" : "Installing... app will restart.";
        } else {
          updateStatus.textContent = "Version check not available in browser.";
        }
      }
    } catch (e) {
      debugLog("[updater] check failed: " + (e.message || e));
      updateStatus.textContent = "Update check failed.";
    }
    updateBtn.disabled = false;
  });
}

// ═══════════════════════════════════════════
// THEME SYSTEM
// ═══════════════════════════════════════════

let matrixCanvas = null;
let matrixAnimationId = null;
let matrixResizeHandler = null;

function startMatrixRain() {
  if (matrixCanvas) return;
  matrixCanvas = document.createElement("canvas");
  matrixCanvas.id = "matrix-rain";
  document.body.prepend(matrixCanvas);
  const ctx = matrixCanvas.getContext("2d");
  const resize = () => {
    matrixCanvas.width = window.innerWidth;
    matrixCanvas.height = window.innerHeight;
  };
  resize();
  matrixResizeHandler = resize;
  window.addEventListener("resize", matrixResizeHandler);
  const fontSize = 14;
  let columns = Math.floor(matrixCanvas.width / fontSize);
  let drops = new Array(columns).fill(0).map(() => Math.random() * -50);
  const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF";
  function draw() {
    const cols = Math.floor(matrixCanvas.width / fontSize);
    if (cols !== columns) {
      columns = cols;
      drops = new Array(columns).fill(0).map(() => Math.random() * -50);
    }
    ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
    ctx.fillRect(0, 0, matrixCanvas.width, matrixCanvas.height);
    ctx.fillStyle = "#00ff41";
    ctx.font = `${fontSize}px monospace`;
    for (let i = 0; i < drops.length; i++) {
      const char = chars[Math.floor(Math.random() * chars.length)];
      const x = i * fontSize;
      const y = drops[i] * fontSize;
      ctx.globalAlpha = 0.8 + Math.random() * 0.2;
      ctx.fillText(char, x, y);
      if (y > matrixCanvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
    ctx.globalAlpha = 1;
    matrixAnimationId = requestAnimationFrame(draw);
  }
  draw();
}

function stopMatrixRain() {
  if (matrixAnimationId) {
    cancelAnimationFrame(matrixAnimationId);
    matrixAnimationId = null;
  }
  if (matrixResizeHandler) {
    window.removeEventListener("resize", matrixResizeHandler);
    matrixResizeHandler = null;
  }
  if (matrixCanvas) {
    matrixCanvas.remove();
    matrixCanvas = null;
  }
}

// ── Ultra Instinct energy particles ──
let uiParticleCanvas = null;
let uiParticleAnimationId = null;
let uiParticleResizeHandler = null;

function startUltraInstinctParticles() {
  if (uiParticleCanvas) return;
  uiParticleCanvas = document.createElement("canvas");
  uiParticleCanvas.id = "ui-particles";
  document.body.prepend(uiParticleCanvas);
  const ctx = uiParticleCanvas.getContext("2d");

  let w, h;

  // ── Sparkle particles (overlay on top of GIF background) ──
  const PARTICLE_COUNT = 80;
  const particles = [];

  function spawnParticle() {
    const type = Math.random();
    if (type < 0.55) {
      // White sparks — fast rising
      return {
        x: Math.random() * w,
        y: h + Math.random() * 30,
        vx: (Math.random() - 0.5) * 1.0,
        vy: -(1.0 + Math.random() * 2.0),
        size: 1 + Math.random() * 1.5,
        life: 1,
        decay: 0.005 + Math.random() * 0.006,
        kind: "spark",
      };
    } else if (type < 0.8) {
      // Silver orbs — slow drift
      return {
        x: Math.random() * w,
        y: h + Math.random() * 60,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -(0.3 + Math.random() * 0.6),
        size: 2 + Math.random() * 3,
        life: 1,
        decay: 0.001 + Math.random() * 0.002,
        kind: "orb",
      };
    } else {
      // Blue-silver wisps
      return {
        x: Math.random() * w,
        y: h + Math.random() * 80,
        vx: (Math.random() - 0.5) * 0.6,
        vy: -(0.4 + Math.random() * 0.8),
        size: 2 + Math.random() * 3,
        life: 1,
        decay: 0.002 + Math.random() * 0.003,
        kind: "wisp",
      };
    }
  }

  const resize = () => {
    w = uiParticleCanvas.width = window.innerWidth;
    h = uiParticleCanvas.height = window.innerHeight;
  };
  resize();
  uiParticleResizeHandler = resize;
  window.addEventListener("resize", uiParticleResizeHandler);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = spawnParticle();
    p.y = Math.random() * h;
    p.life = 0.3 + Math.random() * 0.7;
    particles.push(p);
  }

  let lastTime = performance.now();

  function draw(now) {
    const dt = Math.min((now - lastTime) / 16.667, 3);
    lastTime = now;
    ctx.clearRect(0, 0, w, h);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= p.decay * dt;

      if (p.kind === "wisp") {
        p.x += Math.sin(now * 0.001 + i) * 0.2 * dt;
      }

      if (p.life <= 0 || p.y < -20) {
        particles[i] = spawnParticle();
        continue;
      }

      const alpha = p.life * (p.kind === "spark" ? 0.85 : 0.5);

      if (p.kind === "orb") {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3);
        grad.addColorStop(0, `rgba(225, 230, 240, ${alpha})`);
        grad.addColorStop(0.4, `rgba(200, 208, 220, ${alpha * 0.5})`);
        grad.addColorStop(1, `rgba(180, 188, 200, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === "spark") {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 2);
        grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
        grad.addColorStop(0.5, `rgba(215, 225, 245, ${alpha * 0.4})`);
        grad.addColorStop(1, `rgba(190, 205, 235, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 4);
        grad.addColorStop(0, `rgba(150, 195, 250, ${alpha * 0.6})`);
        grad.addColorStop(0.5, `rgba(120, 165, 235, ${alpha * 0.25})`);
        grad.addColorStop(1, `rgba(90, 135, 215, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    uiParticleAnimationId = requestAnimationFrame(draw);
  }

  uiParticleAnimationId = requestAnimationFrame(draw);
}

function stopUltraInstinctParticles() {
  if (uiParticleAnimationId) {
    cancelAnimationFrame(uiParticleAnimationId);
    uiParticleAnimationId = null;
  }
  if (uiParticleResizeHandler) {
    window.removeEventListener("resize", uiParticleResizeHandler);
    uiParticleResizeHandler = null;
  }
  if (uiParticleCanvas) {
    uiParticleCanvas.remove();
    uiParticleCanvas = null;
  }
}

function applyTheme(name, skipSave) {
  document.body.dataset.theme = name;
  if (!skipSave) echoSet(THEME_STORAGE_KEY, name);
  // Toggle matrix rain
  if (name === "matrix") {
    startMatrixRain();
  } else {
    stopMatrixRain();
  }
  // Toggle ultra instinct particles
  if (name === "ultra-instinct") {
    startUltraInstinctParticles();
  } else {
    stopUltraInstinctParticles();
  }
  // Update active state on theme cards
  if (themePanel) {
    themePanel.querySelectorAll(".theme-card").forEach((card) => {
      card.classList.toggle("is-active", card.dataset.theme === name);
    });
  }
}

function initTheme() {
  const saved = echoGet(THEME_STORAGE_KEY) || "frost";
  // skipSave=true: don't overwrite saved settings before loadAllSettings() finishes
  applyTheme(saved, true);
}

// Theme panel open/close
if (openThemeButton && themePanel) {
  openThemeButton.addEventListener("click", () => {
    themePanel.classList.toggle("hidden");
  });
}

if (closeThemeButton && themePanel) {
  closeThemeButton.addEventListener("click", () => {
    themePanel.classList.add("hidden");
  });
}

// Theme card clicks
if (themePanel) {
  themePanel.querySelectorAll(".theme-card").forEach((card) => {
    card.addEventListener("click", () => {
      const theme = card.dataset.theme;
      if (theme) applyTheme(theme);
    });
  });
}

// Initialize theme on load
initTheme();

// ── UI Transparency slider ──
function applyUiOpacity(val) {
  const clamped = Math.max(20, Math.min(100, val));
  document.documentElement.style.setProperty("--ui-bg-alpha", clamped / 100);
  echoSet(UI_OPACITY_KEY, clamped);
  if (uiOpacityValue) uiOpacityValue.textContent = `${clamped}%`;
  if (uiOpacitySlider && parseInt(uiOpacitySlider.value, 10) !== clamped) {
    uiOpacitySlider.value = clamped;
  }
}

// Init from saved value
applyUiOpacity(parseInt(echoGet(UI_OPACITY_KEY) || "100", 10));

if (uiOpacitySlider) {
  uiOpacitySlider.addEventListener("input", (e) => {
    applyUiOpacity(parseInt(e.target.value, 10));
  });
}
