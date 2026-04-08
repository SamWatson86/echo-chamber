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

function renderAdminPanel(data) {
  // Phase 0: pretty-printed JSON. Phase 2 replaces this entire function.
  const dump = document.getElementById("adminPanelDump");
  if (dump) dump.textContent = JSON.stringify(data, null, 2);
}
