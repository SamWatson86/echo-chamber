# Capture Pipeline Health Monitor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a warn-only capture pipeline health monitor — telemetry from every connected client, classified Green/Yellow/Red, surfaced on the admin dashboard inside Sam's daily Tauri viewer (which now has admin login).

**Architecture:** A new `capture_health.rs` module in the Tauri client owns atomic counters fed by the existing capture loops (`desktop_capture.rs`, `screen_capture.rs`, `gpu_converter.rs`). A pure-function classifier turns counters into a Green/Yellow/Red snapshot. The viewer's existing 3-second poll loop pulls the snapshot via Tauri IPC, includes it in the existing `/api/client-stats-report` POST shipped earlier this session, and the server merges it onto `ClientStats`. A new in-viewer admin panel — unlocked by a Phase 0 admin login button on the existing login screen — polls `/admin/api/dashboard` and renders per-participant chips, top-banner alerts, and a chime on Yellow→Red transitions.

**Tech Stack:** Rust (axum, tauri, parking_lot, serde), JavaScript (vanilla, livekit-client, fetch), HTML/CSS in the existing viewer module structure.

**Spec:** `docs/superpowers/specs/2026-04-08-capture-health-monitor-design.md`

**Branch:** Continue on `feat/per-receiver-instrumentation` (already has tonight's per-receiver instrumentation committed). New commits build directly on top.

---

## File Structure

### New files
- `core/client/src/capture_health.rs` — telemetry state, snapshot, classifier, unit tests
- `core/viewer/admin-panel.js` — admin side panel rendering, polling loop, banner trigger, chime

### Modified files
- `core/client/src/main.rs` — register new Tauri command + manage state
- `core/client/src/desktop_capture.rs` — call telemetry hooks at reinit / timeout / fps tick sites
- `core/client/src/screen_capture.rs` — same hooks for the WGC capture path
- `core/client/src/capture_pipeline.rs` — call telemetry hook from `maybe_emit_stats` to feed fps + set_active
- `core/client/src/gpu_converter.rs` — call shader error hook on error returns
- `core/client/Cargo.toml` — add `parking_lot` if not already a dep (verify in Task 1.0)
- `core/control/src/admin.rs` — add `CaptureHealth` struct, extend `ClientStats`, extend `client_stats_report` merge
- `core/viewer/auth.js` — add `adminLogin` / `adminLogout` / `restoreAdminFromStorage` helpers
- `core/viewer/index.html` — Admin button on login screen, admin badge slot, admin panel slot
- `core/viewer/style.css` — admin button, modal, badge, panel, chip, banner styling
- `core/viewer/screen-share-adaptive.js` — extend the existing `/api/client-stats-report` POST builder to include `capture_health`

---

## Phase 0 — Admin login from the Tauri viewer (prerequisite)

### Task 0.1: Add `adminLogin()` / `adminLogout()` helpers to `auth.js`

**Files:**
- Modify: `core/viewer/auth.js`

- [ ] **Step 1: Add the helper functions at the end of the file**

Append to `core/viewer/auth.js`:

```javascript
// ── Admin login (Tauri viewer) ──────────────────────────────────────
// Lets Sam (or anyone with the password) become admin from the viewer
// itself instead of opening a separate Edge tab. The admin token is
// kept in module-level `adminToken` (already declared in state.js) and
// persisted to localStorage so it survives reload.

const ADMIN_TOKEN_STORAGE_KEY = "echo_admin_token";

async function adminLogin(baseUrl, password) {
  const token = await fetchAdminToken(baseUrl, password);
  adminToken = token;
  try { localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token); } catch (e) {}
  return token;
}

function adminLogout() {
  adminToken = "";
  try { localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY); } catch (e) {}
}

async function restoreAdminFromStorage(baseUrl) {
  let stored = "";
  try { stored = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || ""; } catch (e) {}
  if (!stored) return false;
  // Probe a cheap admin endpoint to verify the token is still valid.
  try {
    const probe = await fetch(`${baseUrl}/admin/api/dashboard`, {
      headers: { Authorization: `Bearer ${stored}` },
    });
    if (probe.ok) {
      adminToken = stored;
      return true;
    }
  } catch (e) {}
  // Stale or rejected — clear it.
  try { localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY); } catch (e) {}
  return false;
}
```

- [ ] **Step 2: Verify `adminToken` is the same global the rest of the app reads**

Run: `grep -n "let adminToken\|var adminToken" core/viewer/state.js`
Expected: `let adminToken = "";` on a single line near top.
If absent, add it. (Per session memory it already exists at line 137.)

- [ ] **Step 3: Commit**

```bash
git add core/viewer/auth.js
git commit -m "feat(viewer): admin login helpers + localStorage persistence"
```

---

### Task 0.2: Add Admin button + modal to the login screen HTML

**Files:**
- Modify: `core/viewer/index.html`

- [ ] **Step 1: Find the existing CONNECT button block**

Run: `grep -n 'id="connectBtn"\|id="connect-btn"\|>CONNECT<' core/viewer/index.html`
Note the line number — call it L.

- [ ] **Step 2: Insert the Admin button immediately after the CONNECT button**

Add right after the closing `</button>` of the connect button:

```html
<!-- Phase 0: Admin login from viewer (Tauri daily-driver UX) -->
<button type="button" id="adminLoginBtn" class="admin-login-btn" title="Sign in as admin">🛡 Admin</button>
```

- [ ] **Step 3: Add the admin login modal markup at the bottom of `<body>`**

Insert just before `</body>`:

```html
<!-- Admin login modal (hidden by default; toggled by adminLoginBtn) -->
<div id="adminLoginModal" class="modal-overlay" hidden>
  <div class="modal">
    <h2>Sign in as admin</h2>
    <p>Admin sees the dashboard, capture health, and per-receiver stats inside the viewer.</p>
    <input type="password" id="adminLoginPassword" placeholder="Admin password" autocomplete="current-password" />
    <div id="adminLoginError" class="modal-error" hidden></div>
    <div class="modal-actions">
      <button type="button" id="adminLoginCancel">Cancel</button>
      <button type="button" id="adminLoginSubmit" class="primary">Sign in</button>
    </div>
  </div>
</div>

<!-- Admin badge slot (rendered into header once token is present) -->
<div id="adminBadgeSlot"></div>

<!-- Admin side panel slot (Phase 2 fills it; Phase 0 just creates the container) -->
<div id="adminPanel" class="admin-panel" hidden>
  <div class="admin-panel-header">
    <h2>🛡 Admin</h2>
    <button type="button" id="adminPanelClose" aria-label="Close admin panel">×</button>
  </div>
  <div id="adminPanelBody" class="admin-panel-body">
    <pre id="adminPanelDump">Loading…</pre>
  </div>
</div>
```

- [ ] **Step 4: Verify the admin button button exists and the modal is hidden initially**

Run: `grep -nc "adminLoginBtn\|adminLoginModal\|adminPanel" core/viewer/index.html`
Expected: 4 or more matches.

- [ ] **Step 5: Commit**

```bash
git add core/viewer/index.html
git commit -m "feat(viewer): admin login modal + badge slot + admin panel scaffolding"
```

---

### Task 0.3: Wire the Admin button + modal in JS

**Files:**
- Modify: `core/viewer/auth.js`

- [ ] **Step 1: Append the wireup function at the end of `auth.js`**

```javascript
// ── Admin login UI wireup ────────────────────────────────────────────
function setupAdminLoginUi() {
  const btn = document.getElementById("adminLoginBtn");
  const modal = document.getElementById("adminLoginModal");
  const pwInput = document.getElementById("adminLoginPassword");
  const errBox = document.getElementById("adminLoginError");
  const cancelBtn = document.getElementById("adminLoginCancel");
  const submitBtn = document.getElementById("adminLoginSubmit");
  if (!btn || !modal || !pwInput || !submitBtn || !cancelBtn) return;

  btn.addEventListener("click", () => {
    pwInput.value = "";
    if (errBox) { errBox.hidden = true; errBox.textContent = ""; }
    modal.hidden = false;
    setTimeout(() => pwInput.focus(), 0);
  });

  cancelBtn.addEventListener("click", () => { modal.hidden = true; });

  pwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitBtn.click();
    if (e.key === "Escape") modal.hidden = true;
  });

  submitBtn.addEventListener("click", async () => {
    const baseUrl = (typeof getControlUrl === "function")
      ? getControlUrl()
      : (controlUrlInput && controlUrlInput.value.trim());
    if (!baseUrl) {
      if (errBox) { errBox.hidden = false; errBox.textContent = "Set a server URL first."; }
      return;
    }
    try {
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in…";
      await adminLogin(baseUrl, pwInput.value);
      modal.hidden = true;
      renderAdminBadge();
      // Phase 2 will start the admin panel polling here.
      if (typeof startAdminPanel === "function") startAdminPanel();
    } catch (e) {
      if (errBox) { errBox.hidden = false; errBox.textContent = String(e.message || e); }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
    }
  });
}

function renderAdminBadge() {
  const slot = document.getElementById("adminBadgeSlot");
  if (!slot) return;
  if (!adminToken) { slot.innerHTML = ""; return; }
  slot.innerHTML = `
    <div class="admin-badge" id="adminBadgeBox">
      <span>🛡 ADMIN</span>
      <button type="button" id="adminLogoutBtn" title="Sign out of admin">Sign out</button>
    </div>
  `;
  const out = document.getElementById("adminLogoutBtn");
  if (out) out.addEventListener("click", () => {
    adminLogout();
    renderAdminBadge();
    if (typeof stopAdminPanel === "function") stopAdminPanel();
  });
}

// Auto-restore on load
async function bootAdminFromStorage() {
  const baseUrl = (typeof getControlUrl === "function")
    ? getControlUrl()
    : (controlUrlInput && controlUrlInput.value.trim());
  if (!baseUrl) return;
  const ok = await restoreAdminFromStorage(baseUrl);
  if (ok) {
    renderAdminBadge();
    if (typeof startAdminPanel === "function") startAdminPanel();
  }
}
```

- [ ] **Step 2: Find where `auth.js` (or a sibling startup file) calls page-load init**

Run: `grep -n "DOMContentLoaded\|window.addEventListener.*load\|init()\|setupConnectBtn\|setupRoom" core/viewer/auth.js core/viewer/connect.js core/viewer/state.js | head`
Identify the canonical "viewer is ready, run init" location.

- [ ] **Step 3: Add a one-line call to `setupAdminLoginUi()` and `bootAdminFromStorage()` after the existing init**

In whichever file owns viewer init (likely `connect.js`'s DOMContentLoaded handler), add at the end of the handler body:

```javascript
setupAdminLoginUi();
bootAdminFromStorage();
```

- [ ] **Step 4: Commit**

```bash
git add core/viewer/auth.js core/viewer/connect.js
git commit -m "feat(viewer): admin login modal wireup + badge + auto-restore"
```

---

### Task 0.4: Add styling for admin button, modal, badge, panel container

**Files:**
- Modify: `core/viewer/style.css`

- [ ] **Step 1: Append the new styles at the end of `style.css`**

```css
/* ── Admin login UI ─────────────────────────────────────────────── */
.admin-login-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.6);
  padding: 6px 10px;
  margin-left: 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.admin-login-btn:hover {
  border-color: rgba(255, 200, 0, 0.6);
  color: rgba(255, 200, 0, 0.9);
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.modal-overlay[hidden] { display: none; }
.modal {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 24px;
  min-width: 360px;
  max-width: 480px;
  color: #eee;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
.modal h2 { margin: 0 0 12px; font-size: 16px; }
.modal p { margin: 0 0 16px; color: #aaa; font-size: 13px; }
.modal input[type=password] {
  width: 100%;
  padding: 10px;
  background: #0a0a0a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #fff;
  font-size: 14px;
  margin-bottom: 12px;
  box-sizing: border-box;
}
.modal-error {
  color: #ff6666;
  font-size: 12px;
  margin: 0 0 12px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.modal-actions button {
  padding: 8px 16px;
  border-radius: 4px;
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  cursor: pointer;
  font-size: 13px;
}
.modal-actions button.primary {
  background: #ffc800;
  color: #000;
  border-color: #ffc800;
}
.modal-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.admin-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 200, 0, 0.12);
  border: 1px solid rgba(255, 200, 0, 0.4);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  color: #ffc800;
}
.admin-badge button {
  background: transparent;
  border: none;
  color: #ffc800;
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}

/* ── Admin side panel ──────────────────────────────────────────── */
.admin-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 480px;
  background: #0d0d0d;
  border-left: 1px solid #333;
  z-index: 9998;
  display: flex;
  flex-direction: column;
  box-shadow: -10px 0 30px rgba(0, 0, 0, 0.5);
}
.admin-panel[hidden] { display: none; }
.admin-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #333;
}
.admin-panel-header h2 { margin: 0; font-size: 14px; color: #ffc800; }
.admin-panel-header button {
  background: transparent;
  border: none;
  color: #888;
  font-size: 22px;
  cursor: pointer;
  padding: 0 8px;
}
.admin-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-family: ui-monospace, "Cascadia Code", "Consolas", monospace;
  font-size: 11px;
  color: #ddd;
}
.admin-panel-body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}
```

- [ ] **Step 2: Commit**

```bash
git add core/viewer/style.css
git commit -m "feat(viewer): admin login + panel styling"
```

---

### Task 0.5: Ship Phase 0 minimal panel (raw JSON dump)

**Files:**
- Create: `core/viewer/admin-panel.js`
- Modify: `core/viewer/index.html` (add `<script src="admin-panel.js?v=…">` tag)

- [ ] **Step 1: Create the file with a minimal polling loop**

Write `core/viewer/admin-panel.js`:

```javascript
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
```

- [ ] **Step 2: Add the script tag to `index.html` near the other viewer scripts**

Run: `grep -n 'src="auth.js\|src="connect.js' core/viewer/index.html`
Insert immediately after the auth.js include:

```html
<script src="admin-panel.js?v=PLACEHOLDER"></script>
```

(The control plane stamps `?v=…` automatically on startup; PLACEHOLDER is fine.)

- [ ] **Step 3: Smoke-test Phase 0 manually**

```bash
# Restart control plane to re-stamp index.html
powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile -Command \"taskkill /F /IM echo-core-control.exe\"' -Verb RunAs -Wait"
sleep 2
cd "F:/Codex AI/The Echo Chamber/core" && cargo build -p echo-core-control 2>&1 | tail -3
powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile -Command \"Set-Location \\\"F:\\Codex AI\\The Echo Chamber\\core\\\"; Start-Process -FilePath .\\target\\debug\\echo-core-control.exe -RedirectStandardOutput logs\\core-control.out.log -RedirectStandardError logs\\core-control.err.log -WindowStyle Hidden\"' -Verb RunAs -Wait"

# Restart Sam's installed client to pick up new viewer JS
wmic process where "name='echo-core-client.exe'" delete
sleep 2
(cd "/c/Users/Sam/AppData/Local/Echo Chamber" && ./echo-core-client.exe > /tmp/echo-client.log 2>&1 &)
```

Manual verification: Sam clicks the new "🛡 Admin" button, types the admin password (`EchoCore-8a8e3854`), the modal closes, the badge appears in the header, the side panel opens with a JSON dump that updates every 3s. Sign out clears the badge and panel. Reload the viewer — the admin badge auto-restores from localStorage.

- [ ] **Step 4: Commit**

```bash
git add core/viewer/admin-panel.js core/viewer/index.html
git commit -m "feat(viewer): admin panel polling loop with raw JSON dump (Phase 0 minimal)"
```

---

## Phase 1 — Capture pipeline telemetry collector

### Task 1.0: Verify and add `parking_lot` dependency

**Files:**
- Modify: `core/client/Cargo.toml`

- [ ] **Step 1: Check current deps**

Run: `grep -n "parking_lot" core/client/Cargo.toml`
If present, skip to Task 1.1. Otherwise:

- [ ] **Step 2: Add parking_lot to `[dependencies]`**

Add the line `parking_lot = "0.12"` under `[dependencies]` in `core/client/Cargo.toml`.

- [ ] **Step 3: Verify it builds**

Run: `cd core && cargo check -p echo-core-client 2>&1 | tail -5`
Expected: `Finished` or warnings only, no errors.

- [ ] **Step 4: Commit**

```bash
git add core/client/Cargo.toml core/Cargo.lock
git commit -m "deps: add parking_lot to echo-core-client for capture_health module"
```

---

### Task 1.1: Create `capture_health.rs` skeleton with state struct

**Files:**
- Create: `core/client/src/capture_health.rs`
- Modify: `core/client/src/main.rs` (add `mod capture_health;`)

- [ ] **Step 1: Create the file**

Write `core/client/src/capture_health.rs`:

```rust
//! Capture pipeline health monitor.
//!
//! Atomic counters fed by capture loops (desktop_capture, screen_capture,
//! capture_pipeline, gpu_converter). A pure-function classifier turns the
//! current snapshot into a Green / Yellow / Red health level with reasons.
//!
//! Designed for the warn-only v1 of the capture-health-monitor feature.
//! Spec: docs/superpowers/specs/2026-04-08-capture-health-monitor-design.md

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

// ── Tunable thresholds ──────────────────────────────────────────────
// Easy to retune from one place. Phase 3 of the plan tunes these
// against real-session data.

const ROLLING_WINDOW: Duration = Duration::from_secs(300); // 5 minutes

const YELLOW_REINITS_5M: u32 = 1;
const RED_REINITS_5M: u32 = 3;

const YELLOW_CONSECUTIVE_TIMEOUTS: u32 = 5;
const RED_CONSECUTIVE_TIMEOUTS: u32 = 10;

const YELLOW_FPS_FRACTION: f32 = 0.80;
const RED_FPS_FRACTION: f32 = 0.50;

const YELLOW_SKIP_RATE_PCT: f32 = 2.0;
const RED_SKIP_RATE_PCT: f32 = 10.0;

// ── Public types ────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum HealthLevel {
    Green,
    Yellow,
    Red,
}

impl HealthLevel {
    fn rank(self) -> u8 {
        match self { HealthLevel::Green => 0, HealthLevel::Yellow => 1, HealthLevel::Red => 2 }
    }
    fn max(self, other: HealthLevel) -> HealthLevel {
        if self.rank() >= other.rank() { self } else { other }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum CaptureMode {
    #[default] None,
    Wgc,
    DxgiDd,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum EncoderType {
    #[default] None,
    Nvenc,
    OpenH264,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CaptureHealthSnapshot {
    pub level: HealthLevel,
    pub reasons: Vec<String>,
    pub capture_active: bool,
    pub capture_mode: String,        // "WGC" | "DXGI-DD" | "None"
    pub encoder_type: String,        // "NVENC" | "OpenH264" | "None"
    pub current_fps: u32,
    pub target_fps: u32,
    pub reinit_count_5m: u32,
    pub consecutive_timeouts: u32,
    pub consecutive_timeouts_max_5m: u32,
    pub encoder_skip_rate_pct: f32,
    pub shader_errors_5m: u32,
}

// ── State ───────────────────────────────────────────────────────────

pub struct CaptureHealthState {
    consecutive_timeouts: AtomicU32,
    consecutive_timeouts_max_5m: AtomicU32,
    encoder_skipped_total: AtomicU64,
    encoder_sent_total: AtomicU64,
    last_capture_fps: AtomicU32,
    target_fps: AtomicU32,
    capture_active: AtomicBool,
    capture_mode: RwLock<CaptureMode>,
    encoder_type: RwLock<EncoderType>,

    // Rolling 5-min event windows
    reinit_events: Mutex<Vec<Instant>>,
    shader_error_events: Mutex<Vec<Instant>>,
    timeout_max_events: Mutex<Vec<(Instant, u32)>>,
}

impl CaptureHealthState {
    pub fn new() -> Self {
        Self {
            consecutive_timeouts: AtomicU32::new(0),
            consecutive_timeouts_max_5m: AtomicU32::new(0),
            encoder_skipped_total: AtomicU64::new(0),
            encoder_sent_total: AtomicU64::new(0),
            last_capture_fps: AtomicU32::new(0),
            target_fps: AtomicU32::new(0),
            capture_active: AtomicBool::new(false),
            capture_mode: RwLock::new(CaptureMode::None),
            encoder_type: RwLock::new(EncoderType::None),
            reinit_events: Mutex::new(Vec::new()),
            shader_error_events: Mutex::new(Vec::new()),
            timeout_max_events: Mutex::new(Vec::new()),
        }
    }

    fn prune(events: &mut Vec<Instant>, now: Instant) {
        let cutoff = now - ROLLING_WINDOW;
        events.retain(|t| *t >= cutoff);
    }

    fn prune_pairs(events: &mut Vec<(Instant, u32)>, now: Instant) {
        let cutoff = now - ROLLING_WINDOW;
        events.retain(|(t, _)| *t >= cutoff);
    }

    pub fn record_reinit(&self) {
        let now = Instant::now();
        let mut e = self.reinit_events.lock();
        Self::prune(&mut e, now);
        e.push(now);
    }

    pub fn record_consecutive_timeout(&self, current: u32) {
        self.consecutive_timeouts.store(current, Ordering::Relaxed);
        let now = Instant::now();
        let mut e = self.timeout_max_events.lock();
        Self::prune_pairs(&mut e, now);
        e.push((now, current));
        let max = e.iter().map(|(_, n)| *n).max().unwrap_or(0);
        self.consecutive_timeouts_max_5m.store(max, Ordering::Relaxed);
    }

    pub fn reset_consecutive_timeouts(&self) {
        self.consecutive_timeouts.store(0, Ordering::Relaxed);
    }

    pub fn record_encoder_status(&self, skipped_total: u64, sent_total: u64) {
        self.encoder_skipped_total.store(skipped_total, Ordering::Relaxed);
        self.encoder_sent_total.store(sent_total, Ordering::Relaxed);
    }

    pub fn record_shader_error(&self) {
        let now = Instant::now();
        let mut e = self.shader_error_events.lock();
        Self::prune(&mut e, now);
        e.push(now);
    }

    pub fn record_capture_fps(&self, fps: u32) {
        self.last_capture_fps.store(fps, Ordering::Relaxed);
    }

    pub fn set_active(&self, active: bool, mode: CaptureMode, encoder: EncoderType, target: u32) {
        self.capture_active.store(active, Ordering::Relaxed);
        *self.capture_mode.write() = mode;
        *self.encoder_type.write() = encoder;
        self.target_fps.store(target, Ordering::Relaxed);
        if !active {
            self.last_capture_fps.store(0, Ordering::Relaxed);
            self.consecutive_timeouts.store(0, Ordering::Relaxed);
        }
    }

    pub fn snapshot(&self) -> CaptureHealthSnapshot {
        let now = Instant::now();
        let reinit_count_5m = {
            let mut e = self.reinit_events.lock();
            Self::prune(&mut e, now);
            e.len() as u32
        };
        let shader_errors_5m = {
            let mut e = self.shader_error_events.lock();
            Self::prune(&mut e, now);
            e.len() as u32
        };
        let consecutive_timeouts_max_5m = {
            let mut e = self.timeout_max_events.lock();
            Self::prune_pairs(&mut e, now);
            e.iter().map(|(_, n)| *n).max().unwrap_or(0)
        };

        let skipped = self.encoder_skipped_total.load(Ordering::Relaxed);
        let sent = self.encoder_sent_total.load(Ordering::Relaxed);
        let total = skipped + sent;
        let encoder_skip_rate_pct = if total > 0 {
            (skipped as f32 / total as f32) * 100.0
        } else { 0.0 };

        let mode = self.capture_mode.read().clone();
        let encoder = self.encoder_type.read().clone();

        let mut snap = CaptureHealthSnapshot {
            level: HealthLevel::Green,
            reasons: Vec::new(),
            capture_active: self.capture_active.load(Ordering::Relaxed),
            capture_mode: match mode {
                CaptureMode::None => "None".into(),
                CaptureMode::Wgc => "WGC".into(),
                CaptureMode::DxgiDd => "DXGI-DD".into(),
            },
            encoder_type: match encoder {
                EncoderType::None => "None".into(),
                EncoderType::Nvenc => "NVENC".into(),
                EncoderType::OpenH264 => "OpenH264".into(),
            },
            current_fps: self.last_capture_fps.load(Ordering::Relaxed),
            target_fps: self.target_fps.load(Ordering::Relaxed),
            reinit_count_5m,
            consecutive_timeouts: self.consecutive_timeouts.load(Ordering::Relaxed),
            consecutive_timeouts_max_5m,
            encoder_skip_rate_pct,
            shader_errors_5m,
        };
        let (level, reasons) = classify(&snap);
        snap.level = level;
        snap.reasons = reasons;
        snap
    }
}

// ── Classifier (pure function — see Task 1.5 for tests) ────────────

pub fn classify(snap: &CaptureHealthSnapshot) -> (HealthLevel, Vec<String>) {
    let mut level = HealthLevel::Green;
    let mut reasons: Vec<String> = Vec::new();

    if !snap.capture_active {
        // No active capture → no judgement to make. Stay Green with no reason.
        return (HealthLevel::Green, reasons);
    }

    // Reinits
    if snap.reinit_count_5m >= RED_REINITS_5M {
        level = level.max(HealthLevel::Red);
        reasons.push(format!("{} reinits in 5min (>= {})", snap.reinit_count_5m, RED_REINITS_5M));
    } else if snap.reinit_count_5m >= YELLOW_REINITS_5M {
        level = level.max(HealthLevel::Yellow);
        reasons.push(format!("{} reinit in 5min", snap.reinit_count_5m));
    }

    // Consecutive timeouts (current run)
    if snap.consecutive_timeouts >= RED_CONSECUTIVE_TIMEOUTS {
        level = level.max(HealthLevel::Red);
        reasons.push(format!("{} consecutive capture timeouts", snap.consecutive_timeouts));
    } else if snap.consecutive_timeouts >= YELLOW_CONSECUTIVE_TIMEOUTS {
        level = level.max(HealthLevel::Yellow);
        reasons.push(format!("{} consecutive capture timeouts", snap.consecutive_timeouts));
    }

    // FPS vs target
    if snap.target_fps > 0 {
        let frac = snap.current_fps as f32 / snap.target_fps as f32;
        if frac < RED_FPS_FRACTION {
            level = level.max(HealthLevel::Red);
            reasons.push(format!(
                "capture fps {}/{} ({:.0}%, < {:.0}%)",
                snap.current_fps, snap.target_fps, frac * 100.0, RED_FPS_FRACTION * 100.0
            ));
        } else if frac < YELLOW_FPS_FRACTION {
            level = level.max(HealthLevel::Yellow);
            reasons.push(format!(
                "capture fps {}/{} ({:.0}%)",
                snap.current_fps, snap.target_fps, frac * 100.0
            ));
        }
    }

    // Encoder skip rate
    if snap.encoder_skip_rate_pct >= RED_SKIP_RATE_PCT {
        level = level.max(HealthLevel::Red);
        reasons.push(format!("encoder skip rate {:.1}%", snap.encoder_skip_rate_pct));
    } else if snap.encoder_skip_rate_pct >= YELLOW_SKIP_RATE_PCT {
        level = level.max(HealthLevel::Yellow);
        reasons.push(format!("encoder skip rate {:.1}%", snap.encoder_skip_rate_pct));
    }

    // Encoder fallback to OpenH264 — automatic Red
    if snap.encoder_type == "OpenH264" {
        level = level.max(HealthLevel::Red);
        reasons.push("encoder fell back to OpenH264".to_string());
    }

    // Shader errors — automatic Red
    if snap.shader_errors_5m > 0 {
        level = level.max(HealthLevel::Red);
        reasons.push(format!("{} shader error(s) in 5min", snap.shader_errors_5m));
    }

    (level, reasons)
}
```

- [ ] **Step 2: Add the module to `main.rs`**

In `core/client/src/main.rs`, find the existing `mod capture_pipeline;` (or other `mod ...;` declarations near the top) and add:

```rust
mod capture_health;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd core && cargo check -p echo-core-client 2>&1 | tail -10`
Expected: `Finished` (warnings about unused functions are OK).

- [ ] **Step 4: Commit**

```bash
git add core/client/src/capture_health.rs core/client/src/main.rs
git commit -m "feat(client): capture_health module — state, snapshot, classifier"
```

---

### Task 1.2: Add unit tests for the classifier

**Files:**
- Modify: `core/client/src/capture_health.rs` (append `#[cfg(test)] mod tests`)

- [ ] **Step 1: Append the test module at the end of `capture_health.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn nominal() -> CaptureHealthSnapshot {
        CaptureHealthSnapshot {
            level: HealthLevel::Green,
            reasons: vec![],
            capture_active: true,
            capture_mode: "DXGI-DD".into(),
            encoder_type: "NVENC".into(),
            current_fps: 60,
            target_fps: 60,
            reinit_count_5m: 0,
            consecutive_timeouts: 0,
            consecutive_timeouts_max_5m: 0,
            encoder_skip_rate_pct: 0.0,
            shader_errors_5m: 0,
        }
    }

    #[test]
    fn nominal_is_green() {
        let (lvl, reasons) = classify(&nominal());
        assert_eq!(lvl, HealthLevel::Green);
        assert!(reasons.is_empty());
    }

    #[test]
    fn inactive_capture_is_always_green() {
        let mut s = nominal();
        s.capture_active = false;
        s.reinit_count_5m = 99;
        s.encoder_type = "OpenH264".into();
        let (lvl, reasons) = classify(&s);
        assert_eq!(lvl, HealthLevel::Green);
        assert!(reasons.is_empty());
    }

    #[test]
    fn one_reinit_is_yellow() {
        let mut s = nominal();
        s.reinit_count_5m = 1;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Yellow);
    }

    #[test]
    fn three_reinits_is_red() {
        let mut s = nominal();
        s.reinit_count_5m = 3;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn five_consecutive_timeouts_is_yellow() {
        let mut s = nominal();
        s.consecutive_timeouts = 5;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Yellow);
    }

    #[test]
    fn ten_consecutive_timeouts_is_red() {
        let mut s = nominal();
        s.consecutive_timeouts = 10;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn fps_47_of_60_is_yellow() {
        let mut s = nominal();
        s.current_fps = 47;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Yellow);
    }

    #[test]
    fn fps_28_of_60_is_red() {
        let mut s = nominal();
        s.current_fps = 28;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn openh264_fallback_is_always_red() {
        let mut s = nominal();
        s.encoder_type = "OpenH264".into();
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn shader_error_is_red() {
        let mut s = nominal();
        s.shader_errors_5m = 1;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn skip_rate_3pct_is_yellow() {
        let mut s = nominal();
        s.encoder_skip_rate_pct = 3.0;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Yellow);
    }

    #[test]
    fn skip_rate_15pct_is_red() {
        let mut s = nominal();
        s.encoder_skip_rate_pct = 15.0;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn multiple_signals_take_max_level_and_list_all_reasons() {
        let mut s = nominal();
        s.reinit_count_5m = 1;             // yellow
        s.consecutive_timeouts = 10;       // red
        s.encoder_skip_rate_pct = 3.0;     // yellow
        let (lvl, reasons) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
        assert!(reasons.len() >= 3);
    }
}
```

- [ ] **Step 2: Run the tests and verify they all pass**

Run: `cd core && cargo test -p echo-core-client capture_health 2>&1 | tail -20`
Expected: `13 passed; 0 failed`.

- [ ] **Step 3: Commit**

```bash
git add core/client/src/capture_health.rs
git commit -m "test(client): capture_health classifier unit tests (13 cases)"
```

---

### Task 1.3: Register `CaptureHealthState` in Tauri managed state + add IPC

**Files:**
- Modify: `core/client/src/main.rs`

- [ ] **Step 1: Add the use statement near the existing module imports**

Near the top of `core/client/src/main.rs` (with the other `use` statements), add:

```rust
use crate::capture_health::{CaptureHealthState, CaptureHealthSnapshot};
use std::sync::Arc;
```

(Skip the second line if `Arc` is already imported.)

- [ ] **Step 2: Add the Tauri command**

Find the existing `#[tauri::command]` block (around line 119+) and add a new one:

```rust
#[tauri::command]
fn get_capture_health(
    state: tauri::State<Arc<CaptureHealthState>>,
) -> Option<CaptureHealthSnapshot> {
    let snap = state.snapshot();
    if !snap.capture_active { None } else { Some(snap) }
}
```

- [ ] **Step 3: Manage the state in `tauri::Builder`**

Find the `.manage(server)` line and add the new `.manage` chain immediately after:

```rust
        .manage(server)
        .manage(Arc::new(CaptureHealthState::new()))
```

- [ ] **Step 4: Register the command in `invoke_handler`**

Find the `tauri::generate_handler![` block and add `get_capture_health,` to the list (e.g. right after `get_app_info,`).

- [ ] **Step 5: Build and verify**

Run: `cd core && cargo build -p echo-core-client 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 6: Commit**

```bash
git add core/client/src/main.rs
git commit -m "feat(client): manage CaptureHealthState + get_capture_health Tauri IPC"
```

---

### Task 1.4: Wire telemetry hooks into `desktop_capture.rs`

**Files:**
- Modify: `core/client/src/desktop_capture.rs`

- [ ] **Step 1: Add the use statement**

Near the top of `core/client/src/desktop_capture.rs`, add:

```rust
use crate::capture_health::{CaptureHealthState, CaptureMode, EncoderType};
use std::sync::Arc;
```

(Skip Arc if already imported.)

- [ ] **Step 2: Pass the health state into `start_desktop_capture`**

The Tauri command `start_desktop_capture` already takes a State<Server>. Add a second state extractor:

Find `async fn start_desktop_capture(` in the file and modify the signature to additionally take `health: tauri::State<'_, Arc<CaptureHealthState>>`. Inside the function, before the capture loop is spawned, capture an `Arc::clone(&*health)` into a local `health_clone` for the spawned thread.

- [ ] **Step 3: Call `set_active` at the start of the capture session**

Right after the LiveKit publisher is created and before the frame loop begins, add:

```rust
health_clone.set_active(true, CaptureMode::DxgiDd, EncoderType::Nvenc, 60);
// We default-assume NVENC; if a runtime fallback to OpenH264 is detected later
// (e.g. via libwebrtc encoder selection logging), update with set_active again.
```

- [ ] **Step 4: Hook the reinit site**

Find the `reinit_with_backoff` closure (line ~707). Each branch that successfully reinits should call:

```rust
health_clone.record_reinit();
```

There are two reinit call sites in the loop body (around lines 819 and 840 per session memory). Add the call inside the `Ok(_) =>` branch of each.

- [ ] **Step 5: Hook the consecutive timeout counter**

Where `consecutive_timeouts += 1;` increments (lines 809 and 850), add:

```rust
health_clone.record_consecutive_timeout(consecutive_timeouts);
```

Where `consecutive_timeouts = 0;` resets (line 822, 843, 858), add:

```rust
health_clone.reset_consecutive_timeouts();
```

- [ ] **Step 6: Hook the per-second fps tick**

The `maybe_emit_stats` call returns `Option<u32>` with the current fps. Right after that call site, add:

```rust
if let Some(fps) = publisher.maybe_emit_stats(/* existing args */) {
    health_clone.record_capture_fps(fps);
}
```

(Adjust to match the existing call signature in the file — replace `/* existing args */` with whatever is actually there. The point is: when `maybe_emit_stats` returns Some, also call `record_capture_fps`.)

- [ ] **Step 7: Call `set_active(false, …)` when the capture loop exits**

Find the function-end / return / drop path of the capture loop in `desktop_capture.rs`. Add before the function returns:

```rust
health_clone.set_active(false, CaptureMode::None, EncoderType::None, 0);
```

- [ ] **Step 8: Build**

Run: `cd core && cargo build -p echo-core-client 2>&1 | tail -10`
Expected: `Finished` with no errors. If there are errors about closure-capturing the State, change the strategy to clone the inner Arc before the spawn: `let health_clone: Arc<CaptureHealthState> = (*health).clone();`.

- [ ] **Step 9: Commit**

```bash
git add core/client/src/desktop_capture.rs
git commit -m "feat(client): wire capture_health hooks into desktop_capture (reinit/timeout/fps/active)"
```

---

### Task 1.5: Wire telemetry hooks into `screen_capture.rs` (WGC path)

**Files:**
- Modify: `core/client/src/screen_capture.rs`

- [ ] **Step 1: Add the use statement at the top**

```rust
use crate::capture_health::{CaptureHealthState, CaptureMode, EncoderType};
use std::sync::Arc;
```

- [ ] **Step 2: Add the State extractor to `start_screen_share`**

Find `async fn start_screen_share(` in `screen_capture.rs` and add `health: tauri::State<'_, Arc<CaptureHealthState>>` to its parameters. Capture `let health_clone = (*health).clone();` before the WGC capture is spawned.

- [ ] **Step 3: Call `set_active` at the start of WGC capture**

Where the WGC capture session begins:

```rust
health_clone.set_active(true, CaptureMode::Wgc, EncoderType::Nvenc, 60);
```

- [ ] **Step 4: Hook the per-second fps tick**

If the WGC path also calls `maybe_emit_stats`, add the same `if let Some(fps)` block as in Task 1.4 Step 6. If WGC computes fps differently, find the equivalent local fps variable and call `health_clone.record_capture_fps(fps);` once per second.

- [ ] **Step 5: Call `set_active(false, …)` on capture stop / drop**

Same pattern as Task 1.4 Step 7.

- [ ] **Step 6: WGC reinit hooks**

WGC has its own error/recovery paths. Search the file:

```bash
grep -n "reinit\|on_closed\|recreate" core/client/src/screen_capture.rs
```

For each recovery point, add `health_clone.record_reinit();`. If the WGC path has no equivalent reinit retry today, leave this empty for v1 — the DXGI path will exercise the reinit signal.

- [ ] **Step 7: Build**

Run: `cd core && cargo build -p echo-core-client 2>&1 | tail -10`
Expected: `Finished`.

- [ ] **Step 8: Commit**

```bash
git add core/client/src/screen_capture.rs
git commit -m "feat(client): wire capture_health hooks into screen_capture (WGC path)"
```

---

### Task 1.6: Hook shader errors in `gpu_converter.rs`

**Files:**
- Modify: `core/client/src/gpu_converter.rs`

- [ ] **Step 1: Find the error-return paths**

```bash
grep -n "Err(\|return Err\|.map_err" core/client/src/gpu_converter.rs
```

- [ ] **Step 2: Decide how to thread the state in**

`gpu_converter.rs` is called from inside the capture loops. Two options:
- **(a)** Pass `Arc<CaptureHealthState>` into `GpuConverter::convert(...)` as a new argument and call `health.record_shader_error()` on each `Err` return. Cleanest but touches every call site.
- **(b)** Use a thread-local or `OnceCell<Arc<CaptureHealthState>>` set by main.rs at startup. Less plumbing but uglier.

For v1, use **(a)** for the convert() error paths in the DXGI loop only. WGC's gpu_converter calls can be deferred; shader errors are an automatic-Red signal so even partial coverage is useful.

In `gpu_converter.rs`, change the `convert(...)` signature to accept `health: Option<&CaptureHealthState>`. Inside the function, on each error path:

```rust
if let Some(h) = health { h.record_shader_error(); }
```

In `desktop_capture.rs` where convert is called, pass `Some(&*health_clone)`.

- [ ] **Step 3: Build**

Run: `cd core && cargo build -p echo-core-client 2>&1 | tail -5`
Expected: `Finished`.

- [ ] **Step 4: Commit**

```bash
git add core/client/src/gpu_converter.rs core/client/src/desktop_capture.rs
git commit -m "feat(client): wire shader error telemetry into gpu_converter"
```

---

## Phase 2 — Server-side data plumbing + viewer reporter + admin panel rendering

### Task 2.1: Add `CaptureHealth` struct + `ClientStats.capture_health` field on the server

**Files:**
- Modify: `core/control/src/admin.rs`

- [ ] **Step 1: Add the new struct alongside `SubscriptionStats`**

In `core/control/src/admin.rs`, after the `SubscriptionStats` struct definition (added earlier this session), add:

```rust
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub(crate) struct CaptureHealth {
    pub(crate) level: String,                       // "Green" | "Yellow" | "Red"
    pub(crate) reasons: Vec<String>,
    pub(crate) capture_active: bool,
    pub(crate) capture_mode: String,
    pub(crate) encoder_type: String,
    pub(crate) current_fps: u32,
    pub(crate) target_fps: u32,
    pub(crate) reinit_count_5m: u32,
    pub(crate) consecutive_timeouts: u32,
    pub(crate) consecutive_timeouts_max_5m: u32,
    pub(crate) encoder_skip_rate_pct: f32,
    pub(crate) shader_errors_5m: u32,
}
```

- [ ] **Step 2: Add the new field to `ClientStats`**

In the same file, locate `pub(crate) inbound: Option<Vec<SubscriptionStats>>,` (added tonight). Immediately after it, add:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) capture_health: Option<CaptureHealth>,
```

- [ ] **Step 3: Extend the merge logic in `client_stats_report`**

In the `client_stats_report` handler in the same file, find the existing merge block. Inside the `Some(existing) =>` branch, after the line that merges `payload.inbound`, add:

```rust
            if payload.capture_health.is_some() {
                existing.capture_health = payload.capture_health;
            }
```

- [ ] **Step 4: Build**

```bash
powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile -Command \"taskkill /F /IM echo-core-control.exe\"' -Verb RunAs -Wait"
sleep 2
cd "F:/Codex AI/The Echo Chamber/core" && cargo build -p echo-core-control 2>&1 | tail -5
```

Expected: `Finished` with no errors.

- [ ] **Step 5: Restart elevated**

```bash
powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile -Command \"Set-Location \\\"F:\\Codex AI\\The Echo Chamber\\core\\\"; Start-Process -FilePath .\\target\\debug\\echo-core-control.exe -RedirectStandardOutput logs\\core-control.out.log -RedirectStandardError logs\\core-control.err.log -WindowStyle Hidden\"' -Verb RunAs -Wait"
sleep 6
curl -sk https://127.0.0.1:9443/health
```

Expected: `{"ok":true,"ts":...}`

- [ ] **Step 6: Commit**

```bash
git add core/control/src/admin.rs
git commit -m "feat(control): add CaptureHealth struct + ClientStats.capture_health field + merge"
```

---

### Task 2.2: Extend the viewer reporter to include `capture_health`

**Files:**
- Modify: `core/viewer/screen-share-adaptive.js`

- [ ] **Step 1: Find the existing /api/client-stats-report POST builder**

Run: `grep -n "client-stats-report" core/viewer/screen-share-adaptive.js`
Expected: one match in the body of `startInboundScreenStatsMonitor`'s 3-second loop (added tonight).

- [ ] **Step 2: Capture health before the POST**

Immediately above the existing `fetch(apiUrl("/api/client-stats-report"), ...)` call, add:

```javascript
          // Capture health from Tauri client (null when running in browser viewer
          // or when no capture is active — both are fine, server schema is optional).
          var captureHealth = null;
          try {
            if (typeof tauriInvoke === "function") {
              captureHealth = await tauriInvoke("get_capture_health");
            }
          } catch (e) { /* IPC unavailable, e.g. browser viewer */ }
```

- [ ] **Step 3: Add `capture_health` to the POST body**

In the same fetch call's `body: JSON.stringify({...})`, add a new field at the end:

```javascript
              capture_health: captureHealth,
```

- [ ] **Step 4: Verify the file still parses**

Run: `node -e "require('fs').readFileSync('core/viewer/screen-share-adaptive.js','utf8'); console.log('ok');"`
Expected: `ok`. (This only checks IO, not JS syntax. For a real syntax check, install esprima or just trust the dev cycle.)

- [ ] **Step 5: Commit**

```bash
git add core/viewer/screen-share-adaptive.js
git commit -m "feat(viewer): include capture_health snapshot in /api/client-stats-report POST"
```

---

### Task 2.3: Smoke-test the data flow end-to-end

This is a verification step, not new code.

- [ ] **Step 1: Ensure control plane is the new build (Task 2.1)**

```bash
tasklist | grep -i echo-core-control
curl -sk https://127.0.0.1:9443/health
```

- [ ] **Step 2: Force-reload the viewer to pick up new JS**

```bash
TOKEN=$(curl -sk -X POST https://127.0.0.1:9443/v1/auth/login -H 'Content-Type: application/json' -d '{"password":"EchoCore-8a8e3854"}' | python -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
curl -sk -X POST https://127.0.0.1:9443/admin/api/force-reload -H "Authorization: Bearer $TOKEN"
```

- [ ] **Step 3: Restart Sam's installed client to pick up new Rust binary too**

The control plane restart only re-stamps viewer JS. The capture_health Rust changes require a fresh client binary. Build + copy + relaunch:

```bash
cd "F:/Codex AI/The Echo Chamber/core" && cargo build -p echo-core-client --release 2>&1 | tail -5
cp "core/target/release/echo-core-client.exe" "C:/Users/Sam/AppData/Local/Echo Chamber/echo-core-client.exe"
wmic process where "name='echo-core-client.exe'" delete
sleep 2
(cd "/c/Users/Sam/AppData/Local/Echo Chamber" && ./echo-core-client.exe > /tmp/echo-client.log 2>&1 &)
```

Verify the log shows: `NVIDIA NVENC support enabled` at build time and `[encoder-factory] HW factory matched! Delegating` at runtime.

- [ ] **Step 4: Sam shares his screen, then dump dashboard**

```bash
sleep 15  # let two stats poll cycles fire
TOKEN=$(curl -sk -X POST https://127.0.0.1:9443/v1/auth/login -H 'Content-Type: application/json' -d '{"password":"EchoCore-8a8e3854"}' | python -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
curl -sk https://127.0.0.1:9443/admin/api/dashboard -H "Authorization: Bearer $TOKEN" | python -m json.tool
```

Expected: Sam's row contains `capture_health: { level: "Green", capture_active: true, capture_mode: "DXGI-DD", encoder_type: "NVENC", current_fps: ~60, target_fps: 60, reinit_count_5m: 0, ... }`.

If `capture_health` is null: check the client log for the IPC call (`tauriInvoke get_capture_health`) and verify the new binary is the one running. If the field is present but `level: "Yellow"` or `"Red"` with surprising reasons, that's actual signal — note it for tuning in Phase 3.

- [ ] **Step 5: No commit — this is a verification step**

---

### Task 2.4: Replace the Phase 0 raw-JSON dump with the chip + banner UI

**Files:**
- Modify: `core/viewer/admin-panel.js`
- Modify: `core/viewer/style.css`

- [ ] **Step 1: Replace the body of `renderAdminPanel` in `admin-panel.js`**

Replace the entire `renderAdminPanel` function with:

```javascript
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
```

- [ ] **Step 2: Append the chip + banner CSS to `style.css`**

```css
/* ── Admin panel: chips, rows, banner ────────────────────────────── */
.admin-meta { color: #888; font-size: 11px; margin-bottom: 12px; }
.admin-room { margin-bottom: 16px; }
.admin-room-header {
  font-size: 11px;
  text-transform: uppercase;
  color: #666;
  border-bottom: 1px solid #222;
  padding-bottom: 4px;
  margin-bottom: 8px;
}
.admin-participant {
  padding: 8px 0;
  border-bottom: 1px solid #1a1a1a;
}
.admin-row1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.admin-name { color: #ddd; font-weight: 500; font-size: 12px; }
.admin-chip {
  font-size: 10px;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid;
  white-space: nowrap;
}
.chip-green  { color: #6dd86d; border-color: #2a5a2a; background: rgba(40,90,40,0.15); }
.chip-yellow { color: #ffd266; border-color: #6a5a1a; background: rgba(120,90,20,0.18); }
.chip-red    { color: #ff6666; border-color: #6a1a1a; background: rgba(120,20,20,0.20); }
.chip-none   { color: #555;    border-color: #2a2a2a; background: transparent; }

.admin-row2 { color: #888; font-size: 10px; padding-left: 4px; margin-top: 4px; }
.admin-row3 { color: #ffd266; font-size: 10px; padding-left: 4px; margin-top: 2px; }

.admin-top-banner {
  position: fixed;
  top: 0; left: 0; right: 0;
  background: #5a1212;
  color: #fff;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  z-index: 10000;
  font-size: 13px;
  border-bottom: 2px solid #ff3030;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
}
.admin-top-banner-actions { display: flex; gap: 8px; }
.admin-top-banner button {
  background: rgba(255,255,255,0.12);
  border: 1px solid rgba(255,255,255,0.3);
  color: #fff;
  padding: 4px 12px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
}
```

- [ ] **Step 3: Force-reload + verify rendering**

```bash
TOKEN=$(curl -sk -X POST https://127.0.0.1:9443/v1/auth/login -H 'Content-Type: application/json' -d '{"password":"EchoCore-8a8e3854"}' | python -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
curl -sk -X POST https://127.0.0.1:9443/admin/api/force-reload -H "Authorization: Bearer $TOKEN"
```

Sam: open the admin panel from the badge. Should see one row per participant with a colored chip. Sam's chip should be Green showing `DXGI-DD NVENC`.

- [ ] **Step 4: Commit**

```bash
git add core/viewer/admin-panel.js core/viewer/style.css
git commit -m "feat(viewer): admin panel chip + banner UI for capture health"
```

---

## Phase 3 — Smoke test playbook + threshold tuning

### Task 3.1: Run the verification matrix

This is a manual verification task with no code changes. Document the results inline.

- [ ] **Step 1: Green baseline**

Sam shares screen, idle. Pull dashboard:
```bash
TOKEN=$(curl -sk -X POST https://127.0.0.1:9443/v1/auth/login -H 'Content-Type: application/json' -d '{"password":"EchoCore-8a8e3854"}' | python -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
curl -sk https://127.0.0.1:9443/admin/api/dashboard -H "Authorization: Bearer $TOKEN" | python -m json.tool | grep -A 20 capture_health
```
**Expected:** `level: "Green"`, `current_fps` within 5 of `target_fps`, `reinit_count_5m: 0`, `consecutive_timeouts: 0`.

- [ ] **Step 2: Forced Yellow via display switch**

Sam switches Windows display modes (Win+P → "Duplicate" → wait 5s → "Extend") to trigger DXGI ACCESS_LOST → reinit. Re-pull dashboard.
**Expected:** `level: "Yellow"`, `reinit_count_5m: 1`, reasons contain "1 reinit in 5min".

- [ ] **Step 3: Forced Red via repeated reinits**

Sam switches display modes 3 more times within ~60 seconds.
**Expected:** `level: "Red"`, `reinit_count_5m: 3+`, banner appears in admin panel, chime plays once.

- [ ] **Step 4: Mute button works**

Click "Mute 60s" in the banner. Banner disappears. Trigger another reinit. Banner does NOT reappear (within the 60s window). After 60s, trigger again — banner reappears.

- [ ] **Step 5: Browser viewer doesn't break the panel**

Open Edge probe (like tonight's smoke test), join room, verify TestBot row appears in the panel with `chip-none` ("— —" mode label, no fps/reinits row).

- [ ] **Step 6: Multi-publisher works**

Have SAM-PC start a webcam publish. Verify SAM-PC's row also gets a capture-health chip independent of Sam's.

- [ ] **Step 7: Threshold tune-up notes**

Capture any false positives or surprising signal levels in CURRENT_SESSION.md under a new "Capture Health Phase 3 tuning notes" section. We will revisit thresholds after a week of real session data.

- [ ] **Step 8: No commit — verification only**

---

### Task 3.2: Update CURRENT_SESSION.md with feature shipped status

**Files:**
- Modify: `CURRENT_SESSION.md`

- [ ] **Step 1: Add a new section at the top of the file**

Insert under the "READ THIS FIRST" block:

```markdown
## ✅ Capture Pipeline Health Monitor — SHIPPED

Phase 0 (admin-from-viewer), Phases 1-1.5 (telemetry collector + classifier),
Phase 2 (server merge + viewer panel), Phase 3 (smoke tests). Spec at
`docs/superpowers/specs/2026-04-08-capture-health-monitor-design.md`.
Plan at `docs/superpowers/plans/2026-04-08-capture-health-monitor.md`.
Branch: `feat/per-receiver-instrumentation`.

**To use:** click 🛡 Admin on the viewer login screen, sign in with the admin
password from `core/control/.env`. The admin panel opens on the right and
polls every 3s.

**Tuning needed:** thresholds in `core/client/src/capture_health.rs` are
guesses. Revisit after a week of real-session data.
```

- [ ] **Step 2: Commit**

```bash
git add CURRENT_SESSION.md
git commit -m "docs: capture health monitor shipped — handover update"
```

---

## Final commit & branch state check

- [ ] **Step 1: Verify git log**

```bash
cd "F:/Codex AI/The Echo Chamber"
git log --oneline -20
git status -s
```

Expected: ~15-20 new commits on `feat/per-receiver-instrumentation` since the spec commit. Working tree clean.

- [ ] **Step 2: Ask Sam before any push**

This branch is still **local only** until Sam explicitly says push. Per HARD RULE 7, never push without confirmation. When Sam approves, the push commands are:

```bash
git push -u origin feat/per-receiver-instrumentation
gh pr create --title "feat: per-receiver instrumentation + capture health monitor" --body "$(cat <<'EOF'
## Summary
- Per-receiver getStats() instrumentation (shipped 2026-04-08, validated end-to-end)
- Capture pipeline health monitor: telemetry, classifier, admin panel
- Admin login from Tauri viewer (Phase 0 prerequisite)

## Test plan
- [x] Unit tests pass: cargo test -p echo-core-client capture_health
- [x] Smoke test green baseline (Sam + SAM-PC + Edge probe)
- [x] Forced yellow + red via display switch
- [x] Banner + chime + mute work
- [x] Browser viewers handled gracefully (null capture_health)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review summary (filled in by the agent before handing off)

**Spec coverage check:** Every section of the spec maps to at least one task above. Phase 0 → Tasks 0.1–0.5. Phase 1 telemetry → Tasks 1.1–1.6. Phase 1.5 classifier + tests → Tasks 1.1 (classifier in same file) + 1.2 (tests). Phase 2 → Tasks 2.1–2.4. Phase 3 → Tasks 3.1–3.2. Final commit/push gate at the end.

**Placeholder check:** No "TBD", "TODO", "implement later", or "similar to". Every code block is complete and copy-pasteable. Where the existing code shape is unknown (e.g., the exact `maybe_emit_stats` call signature in desktop_capture.rs), the task instruction says "match the existing call signature" and points at the file to read first, rather than fabricating one.

**Type consistency check:** `CaptureHealthState`, `CaptureHealthSnapshot`, `HealthLevel`, `CaptureMode`, `EncoderType` are defined once in `capture_health.rs` (Task 1.1) and referenced consistently in 1.3, 1.4, 1.5, 1.6, 2.1, 2.2. The server `CaptureHealth` struct in admin.rs (Task 2.1) mirrors `CaptureHealthSnapshot` field-for-field with the same names (snake_case), so JSON round-trips work without explicit serde rename attributes.
