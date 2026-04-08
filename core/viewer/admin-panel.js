/* ============================================================
   ADMIN PANEL — polls /admin/api/dashboard every 3s and renders
   into the side panel container. Phase 0 just dumps JSON;
   Phase 2 replaces the body with chip + banner UI.
   ============================================================ */

let _adminPanelInterval = null;

function startAdminPanel() {
  if (_adminPanelInterval) return;
  if (!adminToken) return;
  const panel = document.getElementById("adminPanel");
  if (panel) panel.hidden = false;
  const closeBtn = document.getElementById("adminPanelClose");
  if (closeBtn && !closeBtn._wired) {
    closeBtn._wired = true;
    closeBtn.addEventListener("click", () => { panel.hidden = true; });
  }
  pollAdminPanel();
  _adminPanelInterval = setInterval(pollAdminPanel, 3000);
}

function stopAdminPanel() {
  if (_adminPanelInterval) {
    clearInterval(_adminPanelInterval);
    _adminPanelInterval = null;
  }
  const panel = document.getElementById("adminPanel");
  if (panel) panel.hidden = true;
}

async function pollAdminPanel() {
  if (!adminToken) { stopAdminPanel(); return; }
  const baseUrl = (typeof getControlUrl === "function")
    ? getControlUrl()
    : (controlUrlInput && controlUrlInput.value.trim());
  if (!baseUrl) return;
  try {
    const r = await fetch(`${baseUrl}/admin/api/dashboard`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (r.status === 401) { adminLogout(); renderAdminBadge(); stopAdminPanel(); return; }
    if (!r.ok) return;
    const data = await r.json();
    renderAdminPanel(data);
  } catch (e) { /* network blip — try again next tick */ }
}

// Per-identity Yellow→Red transition tracking — chime fires once per
// transition rather than every poll, with a 60s manual mute window.
const _adminPrevHealthLevel = new Map();
const _adminMutedUntil = new Map();

function renderAdminPanel(data) {
  const body = document.getElementById("adminPanelBody");
  if (!body) return;

  let html = "";
  html += `<div class="admin-meta">Server: ${data.server_version || "?"} · Online: ${data.total_online || 0}</div>`;

  let bannerLines = [];
  const now = Date.now();

  for (const room of (data.rooms || [])) {
    html += `<div class="admin-room"><div class="admin-room-header">${escapeHtml(room.room_id)}</div>`;
    for (const p of (room.participants || [])) {
      const stats = p.stats || {};
      const ch = stats.capture_health;
      const chipColor = ch ? ch.level || "Green" : "None";
      const chipClass = `chip-${chipColor.toLowerCase()}`;
      const modeLabel = ch && ch.capture_active
        ? `${ch.capture_mode || "?"} ${ch.encoder_type || "?"}`
        : "—";

      html += `<div class="admin-participant">
        <div class="admin-row1">
          <span class="admin-name">${escapeHtml(p.name || p.identity)}</span>
          <span class="admin-chip ${chipClass}">● ${chipColor} ${escapeHtml(modeLabel)}</span>
        </div>`;
      if (ch && ch.capture_active) {
        const fpsTxt = `${ch.current_fps}/${ch.target_fps}`;
        const reinits = `reinits ${ch.reinit_count_5m}/5m`;
        const skip = `skip ${(ch.encoder_skip_rate_pct || 0).toFixed(1)}%`;
        const ct = `consec_to ${ch.consecutive_timeouts || 0}`;
        html += `<div class="admin-row2">fps ${fpsTxt}  ${reinits}  ${skip}  ${ct}</div>`;
        if (ch.reasons && ch.reasons.length > 0) {
          html += `<div class="admin-row3">└─ ${escapeHtml(ch.reasons.join("; "))}</div>`;
        }
      }
      html += `</div>`;

      // Banner / chime trigger on Yellow→Red or Green→Red transition
      if (ch) {
        const prev = _adminPrevHealthLevel.get(p.identity) || "Green";
        if (ch.level === "Red" && prev !== "Red") {
          const muteUntil = _adminMutedUntil.get(p.identity) || 0;
          if (now > muteUntil) {
            bannerLines.push(`${p.name || p.identity}: ${(ch.reasons || []).slice(0,2).join("; ")}`);
            playAdminAlertChime();
          }
        }
        _adminPrevHealthLevel.set(p.identity, ch.level);
      }
    }
    html += `</div>`;
  }

  body.innerHTML = html;

  // Render or clear the top banner
  renderAdminBanner(bannerLines);
}

function renderAdminBanner(lines) {
  let banner = document.getElementById("adminTopBanner");
  if (lines.length === 0) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "adminTopBanner";
    banner.className = "admin-top-banner";
    document.body.prepend(banner);
  }
  banner.innerHTML = `
    <div class="admin-top-banner-text">⚠️ CAPTURE HEALTH RED — ${lines.map(escapeHtml).join(" · ")}</div>
    <div class="admin-top-banner-actions">
      <button type="button" id="adminBannerMuteBtn">Mute 60s</button>
      <button type="button" id="adminBannerCloseBtn">×</button>
    </div>
  `;
  const muteBtn = document.getElementById("adminBannerMuteBtn");
  if (muteBtn) muteBtn.addEventListener("click", () => {
    const until = Date.now() + 60000;
    for (const ident of _adminPrevHealthLevel.keys()) {
      _adminMutedUntil.set(ident, until);
    }
    banner.remove();
  });
  const closeBtn = document.getElementById("adminBannerCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", () => banner.remove());
}

function playAdminAlertChime() {
  // Reuse Web Audio for a synthesized alert tone — no asset needed.
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    setTimeout(() => { o.frequency.value = 660; }, 120);
    setTimeout(() => { o.stop(); ctx.close(); }, 280);
  } catch (e) { /* audio context blocked, ignore */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
