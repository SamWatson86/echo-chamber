# Capture Pipeline Health Monitor — Design

**Date:** 2026-04-08
**Status:** Proposed
**Owner:** Sam (with Claude)

## Problem

Sam's local capture pipeline can degrade silently and, in the worst documented case, corrupt the Windows display driver to the point where only a full reboot fixes it. The reference incident is the WGC monitor capture flicker (`CURRENT_SESSION.md` ⛔ DO NOT TOUCH section): `windows-capture::Monitor` in `Rgba16F` mode interacting with Sam's 4K HDR + 144Hz dual-monitor setup left his display driver in a wedged state that survived process kills, `Win+Ctrl+Shift+B`, and a sign-out. Reboot was the only fix.

The capture pipeline already emits early warning signs long before that death spiral — DXGI reinit retries, climbing consecutive timeout counts, capture FPS collapsing under no game load, NVENC silently falling back to OpenH264, GPU shader errors. **Today these signals only land in client log files that nobody reads in real time.** By the time Sam notices "my screens are flickering," the damage is done.

This spec exposes those signals to the existing admin dashboard with a Green/Yellow/Red health classifier so Sam can take action — stop sharing, restart his client, or schedule a reboot — *before* the pipeline corrupts.

A second QoL prerequisite is folded into this spec because the dashboard work is useless without it: there is currently no way for Sam to log in as admin from his Tauri client. Today his only path to admin data is opening Edge separately, navigating to `/admin`, logging in there, and leaving the tab open in the background. Phase 0 fixes that with a small "Admin" button on the existing viewer login screen.

## Goals

- Detect capture pipeline degradation 30+ seconds before symptoms become visible to Sam
- Surface the data on the existing admin dashboard (no separate UI to maintain)
- Collect telemetry from **every** connected client, not just Sam, so we have a multi-machine sample for tuning thresholds
- Let Sam log in as admin from his Tauri client without leaving Edge open in the background
- Stay strictly warn-only in v1 — no auto-stop, no auto-restart, no auto-reset (we don't trust the classifier yet)

## Non-goals (out of scope for v1)

- Auto-stop sharing on RED, auto-restart capture pipeline, auto-restart Tauri client, auto-reboot OS
- Server-side rate-limiting of participant churn (different feature; we ruled it out — see "What we considered and rejected")
- Historical capture-health graphs or persistence (real-time only; data lives in memory only)
- Friend-facing UI (admin dashboard only)
- Capture-health on Edge browser viewers — they have no Tauri IPC; they send `null` and the chip is hidden
- GPU-level diagnostics via NVIDIA driver APIs (out of scope; capture-pipeline-level signals are sufficient)
- Per-user admin model (still single shared admin password — hardening item, not in scope)

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tauri client (Rust)                                                │
│                                                                     │
│  desktop_capture.rs      capture_health.rs       main.rs            │
│  ─────────────────       ─────────────────       ───────            │
│  reinit count       ──→  CaptureHealthState ──→  IPC:                │
│  consec timeouts    ──→    (atomic counters)     get_capture_health │
│  capture fps        ──→    + 5-min rolling                           │
│  encoder type       ──→    + classifier                              │
│  encoder skip rate  ──→  → snapshot()                                │
│  shader errors      ──→                                              │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Viewer (JS, in same Tauri webview)                                 │
│                                                                     │
│  screen-share-adaptive.js (already polls every 3s — extend it)      │
│  ───────────────────────────────────────────────                    │
│  on each tick:                                                      │
│    inboundArr = collect getStats() (existing tonight)               │
│    captureHealth = await tauriInvoke('get_capture_health')          │
│        // null if no capture or browser viewer                      │
│    POST /api/client-stats-report { ..., capture_health }            │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Control plane (Rust, axum)                                         │
│                                                                     │
│  admin.rs                                                           │
│  ────────                                                           │
│  ClientStats {                                                      │
│      ... existing fields ...                                        │
│      inbound: Option<Vec<SubscriptionStats>>,  // tonight           │
│      capture_health: Option<CaptureHealth>,    // NEW               │
│  }                                                                  │
│                                                                     │
│  client_stats_report (already exists tonight) merges new field      │
│  admin_dashboard returns capture_health per-participant             │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Viewer admin panel (Tauri webview, Phase 0 unlocks this)           │
│                                                                     │
│  - "Admin" button on login screen → password modal → adminToken     │
│  - Once adminToken set: admin badge in header + Admin side panel    │
│  - Side panel polls /admin/api/dashboard every 3s                   │
│  - Renders per-participant chip: 🟢/🟡/🔴 + capture mode label      │
│  - On RED transition: top banner + alert chime (once per transition)│
│  - Banner has 60s mute button                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Phase 0 — Admin login from the Tauri viewer (prerequisite)

**Why this is Phase 0:** Sam uses the Tauri client as his daily driver. Today, to see admin data, he has to open Edge separately, navigate to `https://echo.fellowshipoftheboatrace.party:9443/admin`, log in, and leave the tab open. Every other phase of this spec assumes Sam can see the admin panel from the same window he's already in. Without Phase 0, the entire feature is built but unusable from Sam's actual workflow.

**Scope:**

1. **Login screen button.** A discreet "Admin" link/button next to or under the existing CONNECT button on the viewer login form. Style: subtle, doesn't draw friend-attention.
2. **Password modal.** Click → inline modal with a password field, a "Sign in as admin" button, and a Cancel. Reuses existing modal CSS.
3. **Auth call.** On submit, POST to existing `/v1/auth/login` with `{password}`. Stores returned token in `state.js` `adminToken` (variable already exists in the codebase).
4. **Persistence.** Token also saved to `localStorage['echo_admin_token']`. On viewer load, auto-restore from localStorage and validate (call any cheap admin endpoint like `/admin/api/dashboard`; on 401, clear and require re-login).
5. **Admin badge.** Once `adminToken` is set, a small badge appears in the viewer header: `🛡 ADMIN`. Click → drop-down with "Sign out of admin" + token expiry timestamp.
6. **Admin panel button.** Once `adminToken` is set, a new "Admin" button appears in the action row alongside Chat/Soundboard/Theme. Click → opens a side panel.
7. **Admin side panel (initial).** First version is just a JSON pretty-print of `/admin/api/dashboard` polled every 3s. Phase 2 replaces this with the chip/banner UI. Doing the panel scaffolding in Phase 0 means Phase 2 only has to write the rendering layer.

**Files touched (Phase 0):**
- `core/viewer/auth.js` — extend with `adminLogin(password)` / `adminLogout()` / `restoreAdminFromStorage()`
- `core/viewer/index.html` — Admin button on login screen, Admin badge slot in header, Admin button in action row, Admin side panel container
- `core/viewer/style.css` — modal + badge + side panel styling
- `core/viewer/state.js` — `adminToken` already exists, no change

**Server changes (Phase 0):** none. `/v1/auth/login` and `ensure_admin` already exist.

**Security note:** This does not weaken security. The admin password stays in `core/control/.env`, never in client code. Friends can't log in because they don't know the password. If a friend's machine is compromised, the new button gives an attacker no advantage they didn't already have via curl.

## Phase 1 — Capture pipeline telemetry collector (Rust client)

**New file:** `core/client/src/capture_health.rs`

**State struct:**
```rust
pub struct CaptureHealthState {
    // Atomic counters incremented from the capture loop
    reinit_total: AtomicU64,                    // lifetime
    consecutive_timeouts: AtomicU32,            // current run-length
    consecutive_timeouts_max_5m: AtomicU32,     // max in last 5min
    encoder_skipped_total: AtomicU64,           // lifetime
    encoder_sent_total: AtomicU64,              // lifetime
    shader_errors_total: AtomicU64,             // lifetime
    last_capture_fps: AtomicU32,                // updated by fps tick
    capture_active: AtomicBool,
    capture_mode: parking_lot::RwLock<CaptureMode>,  // WGC | DxgiDD | None
    encoder_type: parking_lot::RwLock<EncoderType>,  // NVENC | OpenH264 | None
    target_fps: AtomicU32,                      // 30 or 60 from publish opts

    // Rolling 5-min window of timestamped events
    reinit_events: Mutex<VecDeque<Instant>>,
}
```

**Public API:**
- `record_reinit()` — call from `desktop_capture.rs::reinit_with_backoff` and `screen_capture.rs` reinit paths
- `record_consecutive_timeout(n)` — call from the timeout counter in capture loops
- `record_encoder_status(skipped: u64, sent: u64)` — call from capture_pipeline encoder reporter
- `record_shader_error()` — call from `gpu_converter.rs` error paths
- `record_capture_fps(fps: u32)` — call from per-second fps tick
- `set_active(active: bool, mode: CaptureMode, encoder: EncoderType, target: u32)` — call from start/stop screen share
- `snapshot() -> CaptureHealthSnapshot` — assembles current state into a serializable snapshot

**Snapshot struct (returned to Tauri IPC, then to viewer, then to server):**
```rust
#[derive(Serialize, Deserialize)]
pub struct CaptureHealthSnapshot {
    pub level: HealthLevel,                 // Green | Yellow | Red
    pub reasons: Vec<String>,               // human-readable, e.g. "4 reinits in 60s"
    pub capture_active: bool,
    pub capture_mode: String,               // "WGC" | "DXGI-DD" | "None"
    pub encoder_type: String,               // "NVENC" | "OpenH264" | "None"
    pub current_fps: u32,
    pub target_fps: u32,
    pub reinit_count_5m: u32,
    pub consecutive_timeouts: u32,
    pub consecutive_timeouts_max_5m: u32,
    pub encoder_skip_rate_pct: f32,         // skipped / (skipped + sent) over last 30s
    pub shader_errors_5m: u32,
}
```

**Tauri IPC:** `core/client/src/main.rs` adds:
```rust
#[tauri::command]
fn get_capture_health(state: State<...>) -> Option<CaptureHealthSnapshot>
```
Returns `None` when capture is not active. Cheap — just reads atomics + acquires one short Mutex lock for the rolling window prune.

**Wiring (places to call the new methods):**
- `desktop_capture.rs::reinit_with_backoff` → `record_reinit()`
- `desktop_capture.rs` timeout counter → `record_consecutive_timeout(n)`
- `desktop_capture.rs` per-second fps tick → `record_capture_fps(fps)`
- `screen_capture.rs` (WGC) reinit / fps / shader paths → equivalents
- `capture_pipeline.rs` encoder reporter → `record_encoder_status(skipped, sent)`
- `capture_pipeline.rs` start_screen_share / start_desktop_capture entry points → `set_active(true, mode, encoder, target)`
- Stop / drop paths → `set_active(false, None, None, 0)`
- `gpu_converter.rs` error returns → `record_shader_error()`

**Concurrency:** Single global `Arc<CaptureHealthState>` lives in Tauri's managed state. All counters are atomic; the rolling-window deque is the only mutex contention point and snapshot()'s lock window is microseconds.

## Phase 1.5 — Health classifier (pure function)

In the same `capture_health.rs` file, alongside `snapshot()`:

```rust
fn classify(snap: &CaptureHealthSnapshot) -> (HealthLevel, Vec<String>)
```

**Thresholds (constants at top of file, easy to retune):**

```rust
// GREEN (default): all signals nominal
const YELLOW_REINITS_5M: u32 = 1;
const RED_REINITS_5M: u32 = 3;

const YELLOW_CONSECUTIVE_TIMEOUTS: u32 = 5;
const RED_CONSECUTIVE_TIMEOUTS: u32 = 10;

const YELLOW_FPS_PCT: f32 = 0.80;  // current_fps < 80% of target
const RED_FPS_PCT: f32 = 0.50;     // current_fps < 50% of target

const YELLOW_SKIP_RATE_PCT: f32 = 2.0;
const RED_SKIP_RATE_PCT: f32 = 10.0;

const RED_ON_OPENH264: bool = true;        // encoder fallback = automatic RED
const RED_ON_SHADER_ERROR: bool = true;    // any shader error in 5min = RED
```

Classifier logic:
- Start at Green
- For each signal that crosses a Yellow threshold, escalate to Yellow and append a reason string
- For each signal that crosses a Red threshold, escalate to Red and append a reason string
- Final level is the max escalation
- Reasons list is human-readable, e.g. `"4 reinits in 60s (>= 3)"`, `"capture fps 28/60 (47%, < 50%)"`, `"encoder fell back to OpenH264"`

**Unit tests** (in same file or `capture_health_tests.rs`):
- All-nominal snapshot → Green, no reasons
- 1 reinit → Yellow with "1 reinit in 5min" reason
- 3 reinits → Red with that reason
- 5 consecutive timeouts → Yellow
- 10 consecutive timeouts → Red
- fps 50/60 → Yellow ("83% of target" — not yellow yet — wait, 50/60 = 83% > 80%, so Green; use 47/60 = 78%)
- fps 28/60 (<50%) → Red
- OpenH264 fallback → Red regardless of other signals
- Shader error in window → Red regardless
- Multiple signals at different levels → final level is the max, all reasons listed

## Phase 2 — Viewer reporter + admin panel rendering

**Viewer reporter** (`core/viewer/screen-share-adaptive.js`):
- Already POSTs to `/api/client-stats-report` every 3s (added tonight)
- Extend the POST builder: also call `await tauriInvoke('get_capture_health').catch(()=>null)` and include the result as `capture_health` in the body
- Browser viewers (no Tauri IPC) silently get `null` and the field is omitted server-side via `skip_serializing_if`

**Server changes** (`core/control/src/admin.rs`):
- New struct `CaptureHealth` mirroring `CaptureHealthSnapshot` (same fields, JSON-compatible)
- Add `pub capture_health: Option<CaptureHealth>` to `ClientStats`, with `#[serde(default, skip_serializing_if = "Option::is_none")]`
- `client_stats_report` merge handler (already exists from tonight) extends to also merge `capture_health` if present
- `admin_dashboard` already pulls `client_stats.get(&p.identity)` so per-participant capture_health flows through automatically — zero handler changes there

**Admin side panel rendering** (`core/viewer/admin.js` or new `core/viewer/admin-panel.js`):

Layout:
```
┌─────────────────────────────── ADMIN ─────────────────────────────┐
│  Server: 0.6.2 / Up: 2h 14m / Online: 3                           │
│  ─────────────────────────────────────────────────────────────    │
│  Sam-7475                                          🟢 WGC NVENC   │
│    fps 60/60  reinits 0/5m  skip 0%                                │
│  SAM-PC                                            🟢 -- --        │
│    (no capture)                                                    │
│  Jeff-1234                                         🟡 DXGI NVENC   │
│    fps 38/60  reinits 1/5m  skip 3%  consec_to 4                   │
│    └─ Yellow: capture fps 38/60 (63%)                              │
└────────────────────────────────────────────────────────────────────┘
```

**Top banner** (renders into existing viewer banner slot above the main grid):
- Triggered when ANY participant transitions from non-Red to Red
- Format: `⚠️ {name} capture health: RED — {first 2 reasons}. Stop sharing or restart client.`
- Plays alert chime ONCE per transition (track `_lastCaptureHealthState` per identity)
- Has Dismiss button → suppresses chime + banner for 60s for that specific identity
- Auto-clears when the identity returns to Yellow or Green

**Files touched (Phase 2):**
- `core/viewer/screen-share-adaptive.js` — extend POST body with `capture_health`
- `core/control/src/admin.rs` — `CaptureHealth` struct, `ClientStats.capture_health` field, merge in `client_stats_report`
- `core/viewer/admin-panel.js` — new file (or extend `admin.js`) — panel rendering, polling loop, banner trigger
- `core/viewer/style.css` — chip colors, panel layout, banner styling
- `core/viewer/index.html` — admin panel container slot

## Phase 3 — Smoke test plan

Before declaring done:

1. **Unit tests pass** (`cargo test capture_health`)
2. **Local smoke**: Start client, share screen, verify dashboard shows GREEN with WGC + NVENC labels
3. **Forced YELLOW**: Briefly stop the DXGI duplication (e.g. trigger a display mode change with display switcher), watch consecutive_timeouts climb past 5, verify chip turns yellow
4. **Forced RED**: Trigger 3 reinit cycles in 5 minutes by toggling display orientation rapidly, verify red banner + chime
5. **Browser viewer**: Open Edge probe (like tonight), verify it appears in the admin panel with no capture chip (null capture_health)
6. **Multi-client**: Sam + SAM-PC sharing simultaneously, verify both rows show their own capture health independently

## Data flow summary (one diagram, all phases)

```
┌─────────────┐  IPC          ┌────────────────┐  fetch    ┌──────────────┐
│ Capture     │ get_capture_  │ Viewer JS poll │ POST      │ Control plane│
│ loops       │ health        │ (3s interval)  │ /api/     │ /admin.rs    │
│ (Rust)      │──────────────▶│                │ client-   │              │
│             │               │ inboundArr   ──┼──────────▶│ ClientStats  │
│ counters &  │               │ captureHealth ─┤  stats-   │  .inbound    │
│ atomic      │               │                │  report   │  .capture_   │
│ state       │               │                │           │  health      │
└─────────────┘               └────────────────┘           └──────┬───────┘
                                                                   │
                                                                   │  GET /admin/api/dashboard
                                                                   │  (every 3s from admin panel)
                                                                   ▼
                                                          ┌────────────────┐
                                                          │ Admin panel    │
                                                          │ (in Tauri      │
                                                          │  viewer, Phase │
                                                          │  0 unlocks)    │
                                                          │                │
                                                          │ chip + banner  │
                                                          │ + chime        │
                                                          └────────────────┘
```

## Estimated effort

- Phase 0 (admin from viewer): ~80 lines JS + ~30 lines CSS + ~20 lines HTML. Half a day.
- Phase 1 (telemetry collector + IPC): ~250 lines Rust. One day.
- Phase 1.5 (classifier + tests): ~80 lines Rust + 10 unit tests. Half a day.
- Phase 2 (viewer reporter + admin panel rendering): ~150 lines JS + ~50 lines CSS + ~30 lines Rust server merge. One day.
- Phase 3 (smoke test, threshold tuning, polish): half a day.

**Total: ~2.5 work days.** Realistic across one or two sessions with friend testing in between.

## Risks and tradeoffs

- **False positives kicking Sam out of a working session**: mitigated by warn-only v1. The classifier can be wrong without breaking anything. We'll learn its behavior over real sessions before considering auto-actions.
- **Threshold tuning is guess-based**: thresholds are constants, easy to change. Phase 3 explicitly includes tuning. We may need to revisit them after a week of real data — Sam said we need data to make this right, this design is the data-collection foundation.
- **localStorage persistence of admin token**: standard web pattern, low risk. Token is JWT with expiry; worst case it expires and Sam has to log in again.
- **Telemetry overhead in capture hot path**: all counters are atomic, increment-only, no allocations. Encoder reporter and reinit paths are cold (rare events). FPS tick is once per second. Snapshot is called once per 3s. Negligible.
- **Chime fatigue**: if RED triggers fire repeatedly, mute button gives Sam a 60s breather. We're not building a "permanent mute" because that would defeat the purpose.

## What we considered and rejected

- **Server-side rate-limiting of participant churn**: we initially thought the WGC flicker was triggered by Jeff reconnecting in a storm. Investigation found no documented evidence linking other participants' churn to Sam's GPU state. The only documented "flicker requires reboot" incident was Sam's own WGC monitor capture path. Building churn rate-limiting would be solving a non-problem.
- **Auto-stop sharing on RED**: too risky for v1 with an untuned classifier. Could interrupt working sessions on false positives. Reconsider in v2 once we have a week of real-session data.
- **Auto-restart client on RED**: even more invasive, same reasoning. Sam can do this manually with one click in the new admin panel if we want a button.
- **Local soft-reset of capture pipeline (stop+start without app close)**: plausible but probably won't help — if the GPU state is corrupted, restarting capture doesn't unwedge the driver. The reference incident proved kill+restart didn't fix it; only reboot did. Not worth building.
- **Per-receiver inbound stats already shipped tonight**: separate concern (this measures what each receiver sees from each publisher; capture health measures the publisher's local pipeline). They share the same `/api/client-stats-report` endpoint and `ClientStats` struct, so the new field slots in cleanly alongside `inbound`.

## Open questions for Sam to confirm before implementation

None — the design questions are all answered:
1. ✅ Warn-only guardrails for v1
2. ✅ Track all participants, not just Sam
3. ✅ Admin login from viewer is Phase 0
4. ✅ All Phase 0 + 1 + 2 in one spec, one PR

## Success criteria

- Sam can log in as admin from his Tauri viewer in under 5 seconds
- The admin side panel polls every 3s and shows live per-participant capture health
- A simulated capture failure (forced reinit storm, encoder fallback) reliably triggers a YELLOW or RED chip and the appropriate banner+chime
- Browser viewers and non-publishing clients don't break the panel
- After 1 week of real use, Sam reports that the chip color tracks his subjective sense of capture health (correlation, not perfection)
- Zero false positives that interrupt a working session (warn-only is the safety net here)
