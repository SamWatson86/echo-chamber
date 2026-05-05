# Guarded Native Screen Presenter Gate 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the guarded native receive spike for screen-share tracks: opt-in setting, receive-only token identity, Tauri IPC, Rust frame counter, and dashboard telemetry, with WebView2 still rendering all visible video.

**Architecture:** The viewer remains the source of truth for rooms and tiles. JavaScript requests a hidden receive-only native presenter token for one eligible screen tile, then sends the target room/SFU/token/track metadata to the Windows desktop client. The Rust client connects as `<viewer>$native-presenter`, subscribes only to the requested screen track, counts native frames via `NativeVideoStream`, reports status through Tauri, and never hides or replaces the WebView2 `<video>` element in Gate 1.

**Tech Stack:** Rust/Tauri 2, patched local `livekit` and `libwebrtc`, WebView2 JavaScript, Node test runner, Axum control plane.

---

## Scope

This plan implements Gate 1 from the design spec:

- Native receive feasibility.
- Receive-only hidden/system identity.
- Off/On/Auto setting plumbing, with `Off` as normal-user default.
- One target screen tile at a time.
- Native frame-rate telemetry.
- Immediate disable/stop path.

This plan does not draw native video, hide WebView2 video, create native child windows, or change stream quality. Those belong to the Gate 2 one-tile presentation plan after Gate 1 proves safe.

## File Structure

- Create `core/client/src/native_presenter.rs`: Windows-only native presenter manager, request/status types, identity helper, status state machine, LiveKit receive worker.
- Modify `core/client/src/main.rs`: register the native presenter module, managed state, and Tauri commands.
- Modify `core/client/Cargo.toml`: add direct Windows dependencies for `libwebrtc` and `futures-util`, and enable `tokio/sync`.
- Modify `core/control/src/auth.rs`: classify `$native-presenter` identities as hidden receive-only companion identities.
- Modify `core/control/src/admin.rs`: accept and merge native presenter telemetry.
- Create `core/viewer/native-presenter.js`: viewer-side setting parser, target builder, token fetch, Tauri IPC calls, status snapshot helper.
- Create `core/viewer/native-presenter.test.js`: Node tests for mode parsing, identity generation, tile geometry, and native report shaping.
- Modify `core/viewer/settings.js`: persist the native presenter setting key.
- Modify `core/viewer/index.html`: load `native-presenter.js` before screen tile registration code.
- Modify `core/viewer/participants-fullscreen.js`: start/stop native receive probing from `registerScreenTrack` and `unregisterScreenTrack`.
- Modify `core/viewer/participants-grid.js`: stop native receive probing from `clearMedia`.
- Modify `core/viewer/screen-share-adaptive.js`: include native presenter status in `/api/client-stats-report`.
- Modify `core/viewer/admin.js`: show a small native presenter status chip for live diagnostics.

---

### Task 1: Client Native Presenter State Model

**Files:**
- Create: `core/client/src/native_presenter.rs`
- Modify: `core/client/src/main.rs`

- [ ] **Step 1: Add the Windows module declaration**

Modify `core/client/src/main.rs` near the other Windows-only modules:

```rust
#[cfg(target_os = "windows")]
mod native_presenter;
```

- [ ] **Step 2: Write the failing state-model tests**

Create `core/client/src/native_presenter.rs` with these tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_defaults_to_off_for_unknown_values() {
        assert_eq!(NativePresenterMode::from_setting("off"), NativePresenterMode::Off);
        assert_eq!(NativePresenterMode::from_setting("on"), NativePresenterMode::On);
        assert_eq!(NativePresenterMode::from_setting("auto"), NativePresenterMode::Auto);
        assert_eq!(NativePresenterMode::from_setting(""), NativePresenterMode::Off);
        assert_eq!(NativePresenterMode::from_setting("fast"), NativePresenterMode::Off);
    }

    #[test]
    fn native_presenter_identity_is_derived_from_viewer_identity() {
        assert_eq!(
            native_presenter_identity("Sam-1234"),
            "Sam-1234$native-presenter"
        );
        assert_eq!(
            native_presenter_identity("Sam-1234$native-presenter"),
            "Sam-1234$native-presenter"
        );
    }

    #[test]
    fn status_starts_disabled() {
        let manager = NativePresenterManager::new();
        let status = manager.status();
        assert_eq!(status.state, NativePresenterState::Disabled);
        assert_eq!(status.render_path, "webview2");
        assert_eq!(status.native_receive_fps, None);
    }

    #[test]
    fn rejected_start_records_fallback_reason() {
        let manager = NativePresenterManager::new();
        let request = NativePresenterStartRequest {
            mode: NativePresenterMode::Off,
            room: "main".to_string(),
            sfu_url: "wss://example.invalid".to_string(),
            token: "token".to_string(),
            viewer_identity: "Sam-1234".to_string(),
            participant_identity: "Spencer-2222".to_string(),
            track_sid: "TR_screen".to_string(),
            tile: NativePresenterTileRect { x: 0, y: 0, width: 1920, height: 1080, scale_factor: 1.0 },
        };

        let result = manager.validate_start_request(&request);

        assert!(result.is_err());
        assert_eq!(manager.status().state, NativePresenterState::Fallback);
        assert_eq!(
            manager.status().fallback_reason.as_deref(),
            Some("native presenter mode is off")
        );
    }
}
```

- [ ] **Step 3: Run the state-model tests and verify failure**

Run:

```powershell
cargo test -p echo-core-client native_presenter
```

Expected: compile failure because the native presenter types do not exist yet.

- [ ] **Step 4: Implement the state model**

Replace `core/client/src/native_presenter.rs` with:

```rust
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativePresenterMode {
    Off,
    On,
    Auto,
}

impl NativePresenterMode {
    pub(crate) fn from_setting(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "on" => Self::On,
            "auto" => Self::Auto,
            _ => Self::Off,
        }
    }
}

impl Default for NativePresenterMode {
    fn default() -> Self {
        Self::Off
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct NativePresenterTileRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) scale_factor: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct NativePresenterStartRequest {
    pub(crate) mode: NativePresenterMode,
    pub(crate) room: String,
    pub(crate) sfu_url: String,
    pub(crate) token: String,
    pub(crate) viewer_identity: String,
    pub(crate) participant_identity: String,
    pub(crate) track_sid: String,
    pub(crate) tile: NativePresenterTileRect,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativePresenterState {
    Disabled,
    Starting,
    Receiving,
    Fallback,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct NativePresenterStatus {
    pub(crate) state: NativePresenterState,
    pub(crate) render_path: String,
    pub(crate) target_identity: Option<String>,
    pub(crate) target_track_sid: Option<String>,
    pub(crate) native_receive_fps: Option<f64>,
    pub(crate) native_presented_fps: Option<f64>,
    pub(crate) native_frames_received: u64,
    pub(crate) native_frames_dropped: u64,
    pub(crate) queue_depth: u32,
    pub(crate) tile_width: Option<u32>,
    pub(crate) tile_height: Option<u32>,
    pub(crate) fallback_reason: Option<String>,
    pub(crate) updated_at_ms: u64,
}

impl Default for NativePresenterStatus {
    fn default() -> Self {
        Self {
            state: NativePresenterState::Disabled,
            render_path: "webview2".to_string(),
            target_identity: None,
            target_track_sid: None,
            native_receive_fps: None,
            native_presented_fps: None,
            native_frames_received: 0,
            native_frames_dropped: 0,
            queue_depth: 0,
            tile_width: None,
            tile_height: None,
            fallback_reason: None,
            updated_at_ms: 0,
        }
    }
}

pub(crate) fn native_presenter_identity(viewer_identity: &str) -> String {
    let trimmed = viewer_identity.trim();
    if trimmed.ends_with("$native-presenter") {
        trimmed.to_string()
    } else {
        format!("{trimmed}$native-presenter")
    }
}

pub(crate) struct NativePresenterManager {
    generation: AtomicU64,
    status: Mutex<NativePresenterStatus>,
    started_at: Instant,
}

impl NativePresenterManager {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            generation: AtomicU64::new(0),
            status: Mutex::new(NativePresenterStatus::default()),
            started_at: Instant::now(),
        })
    }

    pub(crate) fn status(&self) -> NativePresenterStatus {
        self.status.lock().clone()
    }

    pub(crate) fn validate_start_request(
        &self,
        request: &NativePresenterStartRequest,
    ) -> Result<(), String> {
        if request.mode == NativePresenterMode::Off {
            self.set_fallback("native presenter mode is off");
            return Err("native presenter mode is off".to_string());
        }
        if request.room.trim().is_empty() {
            self.set_fallback("room is empty");
            return Err("room is empty".to_string());
        }
        if request.sfu_url.trim().is_empty() {
            self.set_fallback("sfu_url is empty");
            return Err("sfu_url is empty".to_string());
        }
        if request.token.trim().is_empty() {
            self.set_fallback("token is empty");
            return Err("token is empty".to_string());
        }
        if request.viewer_identity.trim().is_empty() {
            self.set_fallback("viewer_identity is empty");
            return Err("viewer_identity is empty".to_string());
        }
        if request.participant_identity.trim().is_empty() {
            self.set_fallback("participant_identity is empty");
            return Err("participant_identity is empty".to_string());
        }
        if request.track_sid.trim().is_empty() {
            self.set_fallback("track_sid is empty");
            return Err("track_sid is empty".to_string());
        }
        if request.tile.width == 0 || request.tile.height == 0 {
            self.set_fallback("tile has zero size");
            return Err("tile has zero size".to_string());
        }
        Ok(())
    }

    pub(crate) fn mark_starting(&self, request: &NativePresenterStartRequest) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut status = self.status.lock();
        *status = NativePresenterStatus {
            state: NativePresenterState::Starting,
            render_path: "native_receive_probe".to_string(),
            target_identity: Some(request.participant_identity.clone()),
            target_track_sid: Some(request.track_sid.clone()),
            native_receive_fps: None,
            native_presented_fps: None,
            native_frames_received: 0,
            native_frames_dropped: 0,
            queue_depth: 0,
            tile_width: Some(request.tile.width),
            tile_height: Some(request.tile.height),
            fallback_reason: None,
            updated_at_ms: self.elapsed_ms(),
        };
        generation
    }

    pub(crate) fn stop(&self, reason: &str) -> NativePresenterStatus {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let mut status = self.status.lock();
        status.state = NativePresenterState::Stopped;
        status.render_path = "webview2".to_string();
        status.fallback_reason = Some(reason.to_string());
        status.updated_at_ms = self.elapsed_ms();
        status.clone()
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn set_fallback(&self, reason: &str) {
        let mut status = self.status.lock();
        status.state = NativePresenterState::Fallback;
        status.render_path = "webview2".to_string();
        status.fallback_reason = Some(reason.to_string());
        status.updated_at_ms = self.elapsed_ms();
    }

    fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }
}
```

Keep the tests from Step 2 at the end of the file.

- [ ] **Step 5: Run the state-model tests and verify pass**

Run:

```powershell
cargo test -p echo-core-client native_presenter
```

Expected: all native presenter state-model tests pass.

- [ ] **Step 6: Commit Task 1**

Run:

```powershell
git add core/client/src/main.rs core/client/src/native_presenter.rs
git commit -m "feat(client): add native presenter state model"
```

---

### Task 2: Hidden Receive-Only Token Identity

**Files:**
- Modify: `core/control/src/auth.rs`

- [ ] **Step 1: Write helper tests for companion identity grants**

Add this `#[cfg(test)]` module at the end of `core/control/src/auth.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_companion_identity_gets_publish_only_grant() {
        let kind = companion_identity_kind("Sam-1234$screen");
        let grant = livekit_video_grant("main".to_string(), kind);

        assert_eq!(kind, Some(CompanionIdentityKind::ScreenPublisher));
        assert!(grant.canPublish);
        assert!(!grant.canSubscribe);
        assert!(grant.canPublishData);
        assert!(skip_participant_tracking(kind));
    }

    #[test]
    fn native_presenter_identity_gets_receive_only_grant() {
        let kind = companion_identity_kind("Sam-1234$native-presenter");
        let grant = livekit_video_grant("main".to_string(), kind);

        assert_eq!(kind, Some(CompanionIdentityKind::NativePresenter));
        assert!(!grant.canPublish);
        assert!(grant.canSubscribe);
        assert!(!grant.canPublishData);
        assert!(skip_participant_tracking(kind));
    }

    #[test]
    fn normal_identity_gets_normal_viewer_grant() {
        let kind = companion_identity_kind("Sam-1234");
        let grant = livekit_video_grant("main".to_string(), kind);

        assert_eq!(kind, None);
        assert!(grant.canPublish);
        assert!(grant.canSubscribe);
        assert!(grant.canPublishData);
        assert!(!skip_participant_tracking(kind));
    }
}
```

- [ ] **Step 2: Run the helper tests and verify failure**

Run:

```powershell
cargo test -p echo-core-control auth::tests
```

Expected: compile failure because the helper functions do not exist yet.

- [ ] **Step 3: Add companion identity helpers**

Add these helpers above `issue_token` in `core/control/src/auth.rs`:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CompanionIdentityKind {
    ScreenPublisher,
    NativePresenter,
}

pub(crate) fn companion_identity_kind(identity: &str) -> Option<CompanionIdentityKind> {
    if identity.ends_with("$screen") {
        Some(CompanionIdentityKind::ScreenPublisher)
    } else if identity.ends_with("$native-presenter") {
        Some(CompanionIdentityKind::NativePresenter)
    } else {
        None
    }
}

pub(crate) fn livekit_video_grant(
    room: String,
    kind: Option<CompanionIdentityKind>,
) -> LiveKitVideoGrant {
    match kind {
        Some(CompanionIdentityKind::ScreenPublisher) => LiveKitVideoGrant {
            room,
            roomJoin: true,
            canPublish: true,
            canSubscribe: false,
            canPublishData: true,
        },
        Some(CompanionIdentityKind::NativePresenter) => LiveKitVideoGrant {
            room,
            roomJoin: true,
            canPublish: false,
            canSubscribe: true,
            canPublishData: false,
        },
        None => LiveKitVideoGrant {
            room,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        },
    }
}

pub(crate) fn skip_participant_tracking(kind: Option<CompanionIdentityKind>) -> bool {
    kind.is_some()
}
```

- [ ] **Step 4: Replace the hard-coded `$screen` grant logic**

In `issue_token`, replace:

```rust
// $screen identities are companion connections for native screen capture.
// They publish video only (no subscribe needed) and skip name conflict checks.
let is_screen_identity = payload.identity.ends_with("$screen");
```

with:

```rust
// Companion identities are system connections, not visible people.
let companion_kind = companion_identity_kind(&payload.identity);
```

Replace the inline `video: LiveKitVideoGrant { ... }` block with:

```rust
video: livekit_video_grant(payload.room.clone(), companion_kind),
```

Replace:

```rust
// $screen identities skip participant tracking — they're not real users
if is_screen_identity {
    info!("issued $screen token for room={} identity={}", payload.room, payload.identity);
    return Ok(Json(TokenResponse {
        token,
        expires_in_seconds: state.config.livekit_token_ttl_secs,
    }));
}
```

with:

```rust
// Companion identities skip participant tracking — they're not real users.
if skip_participant_tracking(companion_kind) {
    info!(
        "issued companion token for room={} identity={} kind={:?}",
        payload.room, payload.identity, companion_kind
    );
    return Ok(Json(TokenResponse {
        token,
        expires_in_seconds: state.config.livekit_token_ttl_secs,
    }));
}
```

- [ ] **Step 5: Run control auth tests and verify pass**

Run:

```powershell
cargo test -p echo-core-control auth::tests
```

Expected: all auth helper tests pass.

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
git add core/control/src/auth.rs
git commit -m "feat(control): issue receive-only native presenter tokens"
```

---

### Task 3: Tauri Native Presenter IPC

**Files:**
- Modify: `core/client/src/main.rs`
- Modify: `core/client/src/native_presenter.rs`

- [ ] **Step 1: Add command wrapper tests to the manager**

Add these tests to `core/client/src/native_presenter.rs`:

```rust
#[test]
fn start_validation_accepts_on_mode_with_complete_target() {
    let manager = NativePresenterManager::new();
    let request = NativePresenterStartRequest {
        mode: NativePresenterMode::On,
        room: "main".to_string(),
        sfu_url: "wss://echo.example.invalid".to_string(),
        token: "token".to_string(),
        viewer_identity: "Sam-1234".to_string(),
        participant_identity: "Spencer-2222".to_string(),
        track_sid: "TR_screen".to_string(),
        tile: NativePresenterTileRect { x: 10, y: 20, width: 1920, height: 1080, scale_factor: 1.0 },
    };

    assert!(manager.validate_start_request(&request).is_ok());
}

#[test]
fn stop_returns_webview2_status() {
    let manager = NativePresenterManager::new();

    let status = manager.stop("user disabled native presenter");

    assert_eq!(status.state, NativePresenterState::Stopped);
    assert_eq!(status.render_path, "webview2");
    assert_eq!(
        status.fallback_reason.as_deref(),
        Some("user disabled native presenter")
    );
}
```

- [ ] **Step 2: Run the manager tests and verify pass**

Run:

```powershell
cargo test -p echo-core-client native_presenter
```

Expected: manager tests pass before IPC wiring.

- [ ] **Step 3: Add command functions**

In `core/client/src/main.rs`, add these imports near the existing imports:

```rust
#[cfg(target_os = "windows")]
use crate::native_presenter::{
    NativePresenterManager, NativePresenterStartRequest, NativePresenterStatus,
};
```

Add these commands near the display placement commands:

```rust
#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_native_presenter(
    presenter: tauri::State<'_, Arc<NativePresenterManager>>,
    request: NativePresenterStartRequest,
) -> Result<NativePresenterStatus, String> {
    presenter.start_receive_probe(request).await
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn stop_native_presenter(
    presenter: tauri::State<'_, Arc<NativePresenterManager>>,
    reason: Option<String>,
) -> Result<NativePresenterStatus, String> {
    Ok(presenter.stop(reason.as_deref().unwrap_or("stopped by viewer")))
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_native_presenter_status(
    presenter: tauri::State<'_, Arc<NativePresenterManager>>,
) -> Result<NativePresenterStatus, String> {
    Ok(presenter.status())
}
```

- [ ] **Step 4: Add a temporary receive-probe stub**

Add this method to `impl NativePresenterManager` in `core/client/src/native_presenter.rs`:

```rust
pub(crate) async fn start_receive_probe(
    self: &Arc<Self>,
    request: NativePresenterStartRequest,
) -> Result<NativePresenterStatus, String> {
    self.validate_start_request(&request)?;
    self.mark_starting(&request);
    Ok(self.status())
}
```

- [ ] **Step 5: Register managed state and commands**

In `main.rs`, after the existing Windows `builder.manage(Arc::new(CaptureHealthState::new()))`, add:

```rust
#[cfg(target_os = "windows")]
let builder = builder.manage(NativePresenterManager::new());
```

In the `tauri::generate_handler!` list, add:

```rust
#[cfg(target_os = "windows")]
start_native_presenter,
#[cfg(target_os = "windows")]
stop_native_presenter,
#[cfg(target_os = "windows")]
get_native_presenter_status,
```

- [ ] **Step 6: Run client tests/check**

Run:

```powershell
cargo test -p echo-core-client native_presenter
cargo check -p echo-core-client
```

Expected: tests pass and client check completes.

- [ ] **Step 7: Commit Task 3**

Run:

```powershell
git add core/client/src/main.rs core/client/src/native_presenter.rs
git commit -m "feat(client): expose native presenter ipc"
```

---

### Task 4: Viewer Native Presenter Bridge

**Files:**
- Create: `core/viewer/native-presenter.js`
- Create: `core/viewer/native-presenter.test.js`
- Modify: `core/viewer/settings.js`
- Modify: `core/viewer/index.html`
- Modify: `core/viewer/participants-fullscreen.js`
- Modify: `core/viewer/participants-grid.js`

- [ ] **Step 1: Write viewer bridge tests**

Create `core/viewer/native-presenter.test.js`:

```javascript
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeNativePresenterMode,
  nativePresenterIdentity,
  buildNativePresenterTileRect,
  buildNativePresenterReport,
} = require("./native-presenter.js");

test("native presenter mode defaults to off", () => {
  assert.equal(normalizeNativePresenterMode("off"), "off");
  assert.equal(normalizeNativePresenterMode("on"), "on");
  assert.equal(normalizeNativePresenterMode("auto"), "auto");
  assert.equal(normalizeNativePresenterMode(""), "off");
  assert.equal(normalizeNativePresenterMode("turbo"), "off");
});

test("native presenter identity is a hidden companion identity", () => {
  assert.equal(nativePresenterIdentity("Sam-1234"), "Sam-1234$native-presenter");
  assert.equal(
    nativePresenterIdentity("Sam-1234$native-presenter"),
    "Sam-1234$native-presenter"
  );
});

test("tile rect is converted to physical pixels", () => {
  const tile = {
    getBoundingClientRect() {
      return { left: 10.25, top: 20.5, width: 640.5, height: 360.25 };
    },
  };
  const rect = buildNativePresenterTileRect(tile, 1.5);
  assert.deepEqual(rect, {
    x: 15,
    y: 31,
    width: 961,
    height: 540,
    scale_factor: 1.5,
  });
});

test("native presenter report is null when status is missing", () => {
  assert.equal(buildNativePresenterReport(null), null);
});

test("native presenter report exposes safe telemetry names", () => {
  const report = buildNativePresenterReport({
    state: "receiving",
    render_path: "native_receive_probe",
    target_identity: "Spencer-2222",
    target_track_sid: "TR_screen",
    native_receive_fps: 59.7,
    native_presented_fps: null,
    native_frames_received: 120,
    native_frames_dropped: 0,
    queue_depth: 0,
    fallback_reason: null,
    tile_width: 1920,
    tile_height: 1080,
    updated_at_ms: 4567,
  });

  assert.equal(report.state, "receiving");
  assert.equal(report.render_path, "native_receive_probe");
  assert.equal(report.native_receive_fps, 59.7);
  assert.equal(report.native_presented_fps, null);
  assert.equal(report.target_identity, "Spencer-2222");
});
```

- [ ] **Step 2: Run viewer bridge tests and verify failure**

Run:

```powershell
node --test core/viewer/native-presenter.test.js
```

Expected: module-not-found failure because `native-presenter.js` does not exist yet.

- [ ] **Step 3: Implement `native-presenter.js`**

Create `core/viewer/native-presenter.js`:

```javascript
/* =========================================================
   NATIVE PRESENTER - guarded native receive probe for screen tiles
   ========================================================= */

const NATIVE_PRESENTER_MODE_KEY = "echo-native-presenter-mode";
var _nativePresenterStatus = null;
var _nativePresenterActiveTrackSid = "";
var _nativePresenterPollTimer = null;

function normalizeNativePresenterMode(value) {
  var mode = String(value || "off").toLowerCase();
  return mode === "on" || mode === "auto" ? mode : "off";
}

function getNativePresenterMode() {
  if (typeof echoGet !== "function") return "off";
  return normalizeNativePresenterMode(echoGet(NATIVE_PRESENTER_MODE_KEY));
}

function nativePresenterIdentity(viewerIdentity) {
  var identity = String(viewerIdentity || "").trim();
  if (!identity) return "";
  return identity.endsWith("$native-presenter") ? identity : identity + "$native-presenter";
}

function buildNativePresenterTileRect(tile, scaleFactor) {
  var rect = tile.getBoundingClientRect();
  var scale = Number(scaleFactor || window.devicePixelRatio || 1) || 1;
  return {
    x: Math.round(rect.left * scale),
    y: Math.round(rect.top * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
    scale_factor: scale,
  };
}

function buildNativePresenterReport(status) {
  if (!status) return null;
  return {
    state: status.state || "disabled",
    render_path: status.render_path || "webview2",
    target_identity: status.target_identity || null,
    target_track_sid: status.target_track_sid || null,
    native_receive_fps: status.native_receive_fps ?? null,
    native_presented_fps: status.native_presented_fps ?? null,
    native_frames_received: status.native_frames_received || 0,
    native_frames_dropped: status.native_frames_dropped || 0,
    queue_depth: status.queue_depth || 0,
    fallback_reason: status.fallback_reason || null,
    tile_width: status.tile_width || null,
    tile_height: status.tile_height || null,
    updated_at_ms: status.updated_at_ms || 0,
  };
}

function getNativePresenterStatusSnapshot() {
  return buildNativePresenterReport(_nativePresenterStatus);
}

function shouldNativePresenterProbeScreen(mode, tile) {
  if (!window.__ECHO_NATIVE__ || typeof hasTauriIPC !== "function" || !hasTauriIPC()) return false;
  if (mode === "off") return false;
  if (!tile || !tile.dataset || !tile.dataset.trackSid || !tile.dataset.identity) return false;
  if (mode === "on") return true;
  var rect = tile.getBoundingClientRect();
  return rect.width >= 1600 || rect.height >= 900;
}

async function fetchNativePresenterToken(identity) {
  if (!adminToken) throw new Error("admin token unavailable");
  var controlUrl = controlUrlInput.value.trim();
  var roomId = currentRoomName || "main";
  var presenterIdentity = nativePresenterIdentity(identity);
  var presenterName = (nameInput.value.trim() || "Viewer") + " Native Presenter";
  return fetchRoomToken(controlUrl, adminToken, roomId, presenterIdentity, presenterName);
}

async function maybeStartNativePresenterForScreenTrack(meta) {
  try {
    var mode = getNativePresenterMode();
    var tile = meta && meta.tile;
    if (!shouldNativePresenterProbeScreen(mode, tile)) return null;
    var identity = meta.identity || (tile.dataset && tile.dataset.identity) || "";
    var trackSid = meta.trackSid || (tile.dataset && tile.dataset.trackSid) || "";
    if (!identity || !trackSid) return null;
    if (_nativePresenterActiveTrackSid === trackSid) return _nativePresenterStatus;

    var token = await fetchNativePresenterToken(room?.localParticipant?.identity || identityInput.value || identity);
    var status = await tauriInvoke("start_native_presenter", {
      request: {
        mode: mode,
        room: currentRoomName || "main",
        sfu_url: sfuUrlInput.value.trim(),
        token: token,
        viewer_identity: room?.localParticipant?.identity || identityInput.value || "",
        participant_identity: identity,
        track_sid: trackSid,
        tile: buildNativePresenterTileRect(tile, window.devicePixelRatio || 1),
      },
    });
    _nativePresenterStatus = status;
    _nativePresenterActiveTrackSid = trackSid;
    startNativePresenterStatusPolling();
    debugLog("[native-presenter] receive probe started for " + identity + " " + trackSid);
    return status;
  } catch (e) {
    debugLog("[native-presenter] start failed: " + (e && e.message ? e.message : e));
    return null;
  }
}

async function stopNativePresenterForTrack(trackSid) {
  if (!_nativePresenterActiveTrackSid || _nativePresenterActiveTrackSid !== trackSid) return null;
  return stopAllNativePresenter("track removed");
}

async function stopAllNativePresenter(reason) {
  if (!window.__ECHO_NATIVE__ || typeof hasTauriIPC !== "function" || !hasTauriIPC()) return null;
  try {
    var status = await tauriInvoke("stop_native_presenter", { reason: reason || "viewer stopped" });
    _nativePresenterStatus = status;
    _nativePresenterActiveTrackSid = "";
    return status;
  } catch (e) {
    debugLog("[native-presenter] stop failed: " + (e && e.message ? e.message : e));
    return null;
  }
}

function startNativePresenterStatusPolling() {
  if (_nativePresenterPollTimer) return;
  _nativePresenterPollTimer = setInterval(async function() {
    try {
      if (!window.__ECHO_NATIVE__ || typeof hasTauriIPC !== "function" || !hasTauriIPC()) return;
      _nativePresenterStatus = await tauriInvoke("get_native_presenter_status");
    } catch (e) {
      debugLog("[native-presenter] status failed: " + (e && e.message ? e.message : e));
    }
  }, 1000);
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    normalizeNativePresenterMode,
    nativePresenterIdentity,
    buildNativePresenterTileRect,
    buildNativePresenterReport,
  };
}
```

- [ ] **Step 4: Persist the setting key**

In `core/viewer/settings.js`, add `"echo-native-presenter-mode"` to `_SETTINGS_KEYS` immediately after `"echo-performance-mode"`:

```javascript
"echo-performance-mode", "echo-native-presenter-mode",
```

- [ ] **Step 5: Load the script in the viewer**

In `core/viewer/index.html`, insert this script after `display-status.js` and before `identity.js`:

```html
<script src="native-presenter.js?v=0.6.11.1777695458"></script>
```

Use the same stamp format already present in the file. The control server may restamp this file during local testing, so verify this script tag remains present before committing.

- [ ] **Step 6: Start/stop probing from screen track registration**

In `core/viewer/participants-fullscreen.js`, inside `registerScreenTrack` after `screenTrackMeta.set(...)`, add:

```javascript
if (typeof maybeStartNativePresenterForScreenTrack === "function") {
  maybeStartNativePresenterForScreenTrack({ trackSid, publication, tile, identity }).catch(function(e) {
    debugLog("[native-presenter] register start failed: " + (e && e.message ? e.message : e));
  });
}
```

In `unregisterScreenTrack`, before `screenTrackMeta.delete(trackSid)`, add:

```javascript
if (typeof stopNativePresenterForTrack === "function") {
  stopNativePresenterForTrack(trackSid).catch(function(e) {
    debugLog("[native-presenter] unregister stop failed: " + (e && e.message ? e.message : e));
  });
}
```

- [ ] **Step 7: Stop probing during full media cleanup**

In `core/viewer/participants-grid.js`, at the top of `clearMedia()`, add:

```javascript
if (typeof stopAllNativePresenter === "function") {
  stopAllNativePresenter("media cleared").catch(function(e) {
    debugLog("[native-presenter] clearMedia stop failed: " + (e && e.message ? e.message : e));
  });
}
```

- [ ] **Step 8: Run viewer tests**

Run:

```powershell
node --test core/viewer/native-presenter.test.js
node --test core/viewer/*.test.js
```

Expected: all viewer tests pass.

- [ ] **Step 9: Commit Task 4**

Run:

```powershell
git add core/viewer/native-presenter.js core/viewer/native-presenter.test.js core/viewer/settings.js core/viewer/index.html core/viewer/participants-fullscreen.js core/viewer/participants-grid.js
git commit -m "feat(viewer): add guarded native presenter bridge"
```

---

### Task 5: Native Presenter Telemetry In Control And Dashboard

**Files:**
- Modify: `core/control/src/admin.rs`
- Modify: `core/viewer/screen-share-adaptive.js`
- Modify: `core/viewer/admin.js`

- [ ] **Step 1: Add control-plane telemetry structs**

In `core/control/src/admin.rs`, add this field to `ClientStats` after `display_status`:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub(crate) native_presenter: Option<NativePresenterReport>,
```

Add this struct after `ClientDisplayStatus`:

```rust
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub(crate) struct NativePresenterReport {
    pub(crate) state: String,
    pub(crate) render_path: String,
    pub(crate) target_identity: Option<String>,
    pub(crate) target_track_sid: Option<String>,
    pub(crate) native_receive_fps: Option<f64>,
    pub(crate) native_presented_fps: Option<f64>,
    pub(crate) native_frames_received: u64,
    pub(crate) native_frames_dropped: u64,
    pub(crate) queue_depth: u32,
    pub(crate) fallback_reason: Option<String>,
    pub(crate) tile_width: Option<u32>,
    pub(crate) tile_height: Option<u32>,
    pub(crate) updated_at_ms: u64,
}
```

- [ ] **Step 2: Merge telemetry reports**

In `client_stats_report`, after the `display_status` merge, add:

```rust
if payload.native_presenter.is_some() {
    existing.native_presenter = payload.native_presenter;
}
```

- [ ] **Step 3: Add viewer POST field**

In `core/viewer/screen-share-adaptive.js`, after `displayStatus`, add:

```javascript
var nativePresenter = typeof getNativePresenterStatusSnapshot === "function"
  ? getNativePresenterStatusSnapshot()
  : null;
```

Change the POST condition from:

```javascript
if (inboundArr2.length > 0 || captureHealth || displayStatus) {
```

to:

```javascript
if (inboundArr2.length > 0 || captureHealth || displayStatus || nativePresenter) {
```

Add this field to the JSON body:

```javascript
native_presenter: nativePresenter,
```

- [ ] **Step 4: Add a dashboard chip**

In `core/viewer/admin.js`, inside `fetchAdminDashboard()` where participant chips are built, after the display/screen FPS chips, add:

```javascript
if (s.native_presenter && s.native_presenter.state && s.native_presenter.state !== "disabled") {
  var np = s.native_presenter;
  var npText = "native " + np.state;
  if (np.native_receive_fps != null) npText += " " + Math.round(np.native_receive_fps) + "fps";
  if (np.fallback_reason) npText += " · " + np.fallback_reason;
  chips += '<span class="adm-chip" title="Native presenter receive probe">' + escAdm(npText) + '</span>';
}
```

- [ ] **Step 5: Run checks**

Run:

```powershell
cargo check -p echo-core-control
node --test core/viewer/*.test.js
```

Expected: control check passes and viewer tests pass.

- [ ] **Step 6: Commit Task 5**

Run:

```powershell
git add core/control/src/admin.rs core/viewer/screen-share-adaptive.js core/viewer/admin.js
git commit -m "feat(control): report native presenter telemetry"
```

---

### Task 6: Native LiveKit Receive Worker

**Files:**
- Modify: `core/client/Cargo.toml`
- Modify: `core/client/src/native_presenter.rs`

- [ ] **Step 1: Add receive-worker unit tests**

Add these tests to `core/client/src/native_presenter.rs`:

```rust
#[test]
fn track_match_requires_target_sid_and_screen_source() {
    assert!(is_target_screen_track(
        "TR_screen",
        "TR_screen",
        NativeTrackSource::ScreenShare
    ));
    assert!(!is_target_screen_track(
        "TR_screen",
        "TR_camera",
        NativeTrackSource::ScreenShare
    ));
    assert!(!is_target_screen_track(
        "TR_screen",
        "TR_screen",
        NativeTrackSource::Camera
    ));
}

#[test]
fn frame_sample_updates_receive_fps() {
    let manager = NativePresenterManager::new();
    let request = NativePresenterStartRequest {
        mode: NativePresenterMode::On,
        room: "main".to_string(),
        sfu_url: "wss://echo.example.invalid".to_string(),
        token: "token".to_string(),
        viewer_identity: "Sam-1234".to_string(),
        participant_identity: "Spencer-2222".to_string(),
        track_sid: "TR_screen".to_string(),
        tile: NativePresenterTileRect { x: 0, y: 0, width: 1920, height: 1080, scale_factor: 1.0 },
    };
    manager.mark_starting(&request);

    manager.record_native_frame_sample(120, 2.0);

    let status = manager.status();
    assert_eq!(status.state, NativePresenterState::Receiving);
    assert_eq!(status.native_frames_received, 120);
    assert_eq!(status.native_receive_fps, Some(60.0));
}
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
cargo test -p echo-core-client native_presenter
```

Expected: compile failure because `NativeTrackSource`, `is_target_screen_track`, and `record_native_frame_sample` do not exist yet.

- [ ] **Step 3: Add direct dependencies**

In `core/client/Cargo.toml`, change:

```toml
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time"] }
```

to:

```toml
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "sync"] }
```

Under `[target.'cfg(windows)'.dependencies]`, add:

```toml
futures-util = "0.3"
libwebrtc = "0.3.29"
```

- [ ] **Step 4: Add receive-worker helpers**

In `core/client/src/native_presenter.rs`, add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeTrackSource {
    ScreenShare,
    Camera,
    Other,
}

pub(crate) fn is_target_screen_track(
    target_track_sid: &str,
    publication_track_sid: &str,
    source: NativeTrackSource,
) -> bool {
    source == NativeTrackSource::ScreenShare && target_track_sid == publication_track_sid
}
```

Add this method to `impl NativePresenterManager`:

```rust
pub(crate) fn record_native_frame_sample(&self, frames: u64, elapsed_secs: f64) {
    let fps = if elapsed_secs > 0.0 {
        Some(((frames as f64 / elapsed_secs) * 10.0).round() / 10.0)
    } else {
        None
    };
    let mut status = self.status.lock();
    status.state = NativePresenterState::Receiving;
    status.native_frames_received = frames;
    status.native_receive_fps = fps;
    status.native_presented_fps = None;
    status.queue_depth = 0;
    status.updated_at_ms = self.elapsed_ms();
}
```

- [ ] **Step 5: Replace the start stub with a LiveKit receive worker**

Replace `start_receive_probe` with:

```rust
pub(crate) async fn start_receive_probe(
    self: &Arc<Self>,
    request: NativePresenterStartRequest,
) -> Result<NativePresenterStatus, String> {
    self.validate_start_request(&request)?;
    let generation = self.mark_starting(&request);
    let manager = Arc::clone(self);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_receive_probe(manager.clone(), generation, request).await {
            if manager.generation() == generation {
                manager.set_fallback(&error);
            }
        }
    });
    Ok(self.status())
}
```

Add the worker below the manager implementation:

```rust
#[cfg(target_os = "windows")]
async fn run_receive_probe(
    manager: Arc<NativePresenterManager>,
    generation: u64,
    request: NativePresenterStartRequest,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use libwebrtc::video_stream::native::{NativeVideoStream, NativeVideoStreamOptions};
    use livekit::{prelude::*, Room, RoomEvent, RoomOptions};
    use std::time::{Duration, Instant};

    livekit::ensure_runtime_initialized();
    let options = RoomOptions {
        auto_subscribe: true,
        adaptive_stream: false,
        dynacast: false,
        ..Default::default()
    };
    let (_room, mut events) = Room::connect(&request.sfu_url, &request.token, options)
        .await
        .map_err(|error| format!("native presenter connect failed: {error}"))?;

    let startup_deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if manager.generation() != generation {
            return Ok(());
        }
        if Instant::now() > startup_deadline {
            return Err("target screen track was not subscribed within 8 seconds".to_string());
        }
        let event = match tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => return Err("native presenter room event stream closed".to_string()),
            Err(_) => continue,
        };
        let RoomEvent::TrackSubscribed { track, publication, .. } = event else {
            continue;
        };
        let source = match publication.source() {
            TrackSource::Screenshare => NativeTrackSource::ScreenShare,
            TrackSource::Camera => NativeTrackSource::Camera,
            _ => NativeTrackSource::Other,
        };
        if !is_target_screen_track(
            &request.track_sid,
            &publication.sid().to_string(),
            source,
        ) {
            continue;
        }
        let RemoteTrack::Video(video_track) = track else {
            continue;
        };
        let mut stream = NativeVideoStream::with_options(
            video_track.rtc_track(),
            NativeVideoStreamOptions { queue_size_frames: Some(1) },
        );
        let started = Instant::now();
        let mut frames = 0u64;
        while manager.generation() == generation {
            let frame = tokio::time::timeout(Duration::from_millis(500), stream.next()).await;
            match frame {
                Ok(Some(frame)) => {
                    let _width = frame.buffer.width();
                    let _height = frame.buffer.height();
                    frames += 1;
                    let elapsed = started.elapsed().as_secs_f64();
                    if frames == 1 || frames % 30 == 0 {
                        manager.record_native_frame_sample(frames, elapsed);
                    }
                }
                Ok(None) => return Err("native video stream ended".to_string()),
                Err(_) => {
                    if started.elapsed() > Duration::from_secs(2) {
                        manager.record_native_frame_sample(frames, started.elapsed().as_secs_f64());
                    }
                }
            }
        }
        stream.close();
        return Ok(());
    }
}
```

- [ ] **Step 6: Run tests and checks**

Run:

```powershell
cargo test -p echo-core-client native_presenter
cargo check -p echo-core-client
```

Expected: tests pass and client check completes.

- [ ] **Step 7: Commit Task 6**

Run:

```powershell
git add core/client/Cargo.toml core/client/src/native_presenter.rs
git commit -m "feat(client): receive native screen frames"
```

---

### Task 7: Final Verification And Local Handoff

**Files:**
- Modify: `docs/handovers/2026-05-02-native-presenter-gate-1.md`

- [ ] **Step 1: Run focused automated verification**

Run:

```powershell
node --test core/viewer/*.test.js
cargo test -p echo-core-client native_presenter
cargo test -p echo-core-control auth::tests
cargo check -p echo-core-client -p echo-core-control
```

Expected:

- All viewer tests pass.
- Native presenter client tests pass.
- Control auth tests pass.
- Cargo check passes for client and control.

- [ ] **Step 2: Build the desktop client**

Run:

```powershell
cargo build -p echo-core-client
```

Expected: debug desktop client builds successfully.

- [ ] **Step 3: Write the Gate 1 handoff**

Create `docs/handovers/2026-05-02-native-presenter-gate-1.md`:

```markdown
# Native Presenter Gate 1 Handoff

Date: 2026-05-02
Branch: codex/screen-sources-command-investigation

## What Changed

- Added a guarded Windows native presenter receive probe.
- Added hidden receive-only `$native-presenter` LiveKit token support.
- Added viewer opt-in setting plumbing with normal default `off`.
- Added native receive FPS/status telemetry to client stats and dashboard.
- Kept WebView2 as the visible rendering path.

## What This Proves

Gate 1 proves whether the desktop client can safely join as a hidden receive-only companion and receive the selected screen track natively without disturbing the normal viewer.

## What This Does Not Do

- It does not draw native video.
- It does not hide or replace the WebView2 video element.
- It does not reduce stream quality.
- It does not deploy to friends.

## Local Test Protocol

1. Close Echo before testing a new desktop build.
2. Open the branch debug client from `F:\EC-worktrees\screen-sources-command\core\target\debug\echo-core-client.exe`.
3. Confirm the running client path before monitoring.
4. Enable the native presenter setting only for Sam's local test.
5. Join a room with one remote screen share.
6. Confirm dashboard native presenter status shows `starting` then `receiving`.
7. Compare WebView receive FPS, WebView presented FPS, and native receive FPS.
8. Turn the setting off and confirm status returns to WebView2/stopped without restarting.

## Next Decision

If native receive FPS is healthy while WebView presented FPS remains low in maximized 4K mode, proceed to the Gate 2 one-tile native presentation plan.
```

- [ ] **Step 4: Verify no accidental generated-only changes are staged**

Run:

```powershell
git status --short
git diff -- core/viewer/index.html
```

Expected:

- Only intentional code/docs changes remain.
- `core/viewer/index.html` includes the `native-presenter.js` script tag.
- Cache-busting stamp churn is understood before staging.

- [ ] **Step 5: Commit Task 7**

Run:

```powershell
git add docs/handovers/2026-05-02-native-presenter-gate-1.md
git commit -m "docs: record native presenter gate 1 validation"
```

---

## Full Verification Command Set

Run before claiming Gate 1 is complete:

```powershell
node --test core/viewer/*.test.js
cargo test -p echo-core-client native_presenter
cargo test -p echo-core-control auth::tests
cargo check -p echo-core-client -p echo-core-control
cargo build -p echo-core-client
```

## Manual Test Gate

Do not silently monitor. Tell Sam first:

```text
Close Echo now. I will reopen the branch debug client and confirm the running path before we test. After it opens, join the room and enable the native presenter setting. Then I will monitor the dashboard for native receive FPS versus WebView presented FPS.
```

Gate 1 passes only if:

- The native presenter remains hidden from normal participants.
- The dashboard shows native presenter `receiving` for the selected screen track.
- Native receive FPS is plausible for the stream.
- Turning the setting off stops the native probe without restarting Echo.
- WebView2 remains the visible fallback at all times.

## Self-Review

- Spec coverage: Gate 1 covers hidden identity, opt-in setting, native receive feasibility, telemetry, fallback/stop, and no quality reduction.
- Deferred by design: native video drawing, z-order handling, D3D11/DirectComposition, and hiding WebView video are Gate 2 work after receive is proven.
- Risk control: normal default remains `off`, and Gate 1 never replaces the visible video path.
