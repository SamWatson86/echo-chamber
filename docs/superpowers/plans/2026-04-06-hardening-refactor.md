# Echo Chamber Hardening & Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead code, split monolithic files into focused modules, document architecture, and enable maintenance/scaling.

**Architecture:** 8 phases executed in dependency order. Dead code removed first (unblocks everything), then Rust control plane split (most complex, standalone), then JS splits (depend on control plane for cache-bust), then capture trait unification, then documentation. Each phase produces a commit that builds and runs.

**Tech Stack:** Rust (Axum, Tauri, LiveKit SDK), JavaScript (vanilla, LiveKit client), Markdown documentation

**Spec:** `docs/superpowers/specs/2026-04-06-hardening-refactor-design.md`

---

## Phase 1: Dead Code Archival

### Task 1.1: Create Archive Directory and Move Dead Rust Modules

**Files:**
- Create: `core/client/src/archive/README.md`
- Move: `core/client/src/nvfbc_capture.rs` → `core/client/src/archive/nvfbc_capture.rs`
- Move: `core/client/src/game_capture.rs` → `core/client/src/archive/game_capture.rs`
- Move: `core/client/src/injector.rs` → `core/client/src/archive/injector.rs`
- Move: `core/client/src/control_block_client.rs` → `core/client/src/archive/control_block_client.rs`
- Move: `core/hook/` → `core/client/src/archive/hook/`

- [ ] **Step 1: Create archive directory**
```bash
mkdir -p core/client/src/archive
```

- [ ] **Step 2: Write archive README**
Create `core/client/src/archive/README.md`:
```markdown
# Archived Capture Methods

These modules were removed from active use but preserved for reference.
Each represents a capture approach that was fully implemented and tested
before being abandoned due to platform limitations.

## nvfbc_capture.rs (813 lines) — NVIDIA FrameBuffer Capture
**What:** Captured GPU scanout buffer via NvFBC API. Highest quality — bypasses
compositor, immune to game engine, anti-cheat, DLSS.
**Why abandoned:** GeForce driver (595.79+) blocks NvFBC on consumer GPUs.
Wrapper DLL attempted but driver detects and blocks. Also compositor-bound
on Windows even when working.
**Performance achieved:** N/A on GeForce. Would have been 60fps+ under any load.
**Revival condition:** NVIDIA unblocks NvFBC on consumer GPUs.

## game_capture.rs (555 lines) + injector.rs (385 lines) + control_block_client.rs (107 lines) — Present() Hook
**What:** Injected echo_game_hook.dll into game process, hooked DirectX Present(),
captured frames via shared D3D11 texture with keyed mutex synchronization.
**Why abandoned:** Fails with DLSS Frame Generation. The DLSS proxy swap chain
sends garbled data across 4 channels. Not fixable from our side. Tested
extensively with Crimson Desert 4K — frames are corrupted.
**Performance achieved:** 30-60fps on DX11 games without DLSS FG.
**Revival condition:** DLSS FG architecture changes, or game-specific workaround.

## hook/ (DLL source) — echo_game_hook.dll
**What:** The DLL that game_capture.rs injects. Hooks Present() vtable,
writes BGRA to shared texture, signals frame event.
**Why archived:** Dead without game_capture.rs.
```

- [ ] **Step 3: Move dead Rust modules to archive**
```bash
mv core/client/src/nvfbc_capture.rs core/client/src/archive/
mv core/client/src/game_capture.rs core/client/src/archive/
mv core/client/src/injector.rs core/client/src/archive/
mv core/client/src/control_block_client.rs core/client/src/archive/
cp -r core/hook core/client/src/archive/hook
```

- [ ] **Step 4: Remove mod declarations and IPC commands from main.rs**

In `core/client/src/main.rs`, remove these module declarations:
```rust
// REMOVE these lines:
#[cfg(target_os = "windows")]
mod control_block_client;
#[cfg(target_os = "windows")]
mod injector;
#[cfg(target_os = "windows")]
mod game_capture;
#[cfg(target_os = "windows")]
mod nvfbc_capture;
```

Remove these IPC command functions (entire function bodies):
- `start_game_capture` (~8 lines)
- `stop_game_capture` (~3 lines)
- `check_nvfbc_available` (~3 lines)
- `start_nvfbc_capture` (~8 lines)
- `stop_nvfbc_capture` (~3 lines)

Remove from `generate_handler![]`:
```rust
// REMOVE these entries:
#[cfg(target_os = "windows")]
start_game_capture,
#[cfg(target_os = "windows")]
stop_game_capture,
#[cfg(target_os = "windows")]
check_nvfbc_available,
#[cfg(target_os = "windows")]
start_nvfbc_capture,
#[cfg(target_os = "windows")]
stop_nvfbc_capture,
```

- [ ] **Step 5: Build and verify**
```bash
cd core && cargo build -p echo-core-client --release 2>&1 | tail -5
```
Expected: `Finished release profile` with no errors (warnings OK)

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "refactor: archive dead capture methods (NVFBC, present hook, injector)

Moved nvfbc_capture.rs, game_capture.rs, injector.rs, control_block_client.rs,
and hook/ DLL to core/client/src/archive/ with README documenting why each
was abandoned. Removed IPC commands from main.rs."
```

### Task 1.2: Clean JS Fallback Chain

**Files:**
- Modify: `core/viewer/screen-share.js`

- [ ] **Step 1: Remove NVFBC fallback from startScreenShareManual()**

In `screen-share.js`, the game capture fallback chain (inside `if (source.sourceType === 'game')`) currently has 4 steps. Remove step 1 (NVFBC) and step 4 (present hook). The chain becomes:

```javascript
      if (source.sourceType === 'game') {
        // Capture fallback chain: WGC (24H2+) → DXGI DD
        var captureStarted = false;

        // 1. Try WGC window capture (MPO-aware, requires Win11 24H2+)
        if (!captureStarted && wgcSupported) {
          // ... existing WGC block (keep as-is) ...
        } else if (!captureStarted && !wgcSupported) {
          debugLog('[wgc] skipped — requires Win11 24H2+ (build 26100+), current: ' + osBuild);
        }

        // 2. Fall back to DXGI Desktop Duplication (compositor capture)
        if (!captureStarted) {
          // ... existing DXGI DD block (keep as-is) ...
        }

        // REMOVED: NVFBC block (GeForce blocks it)
        // REMOVED: Present hook block (DLSS FG breaks it)
      }
```

Remove the NVFBC check/start block (~lines 761-780).
Remove the present hook fallback block (~lines 731-742).

- [ ] **Step 2: Clean up stopScreenShareManual()**

In `stopScreenShareManual()`, remove the NVFBC and game capture stop branches:
```javascript
// REMOVE these branches from the if/else chain:
      if (window._echoNativeCaptureMode === 'nvfbc') {
        await tauriInvoke('stop_nvfbc_capture');
      } else if ...
      } else if (window._echoNativeCaptureMode === 'game') {
        await tauriInvoke('stop_game_capture');
      }
```

Keep only:
```javascript
      if (window._echoNativeCaptureMode === 'desktop-dd') {
        await tauriInvoke('stop_desktop_capture');
      } else {
        await tauriInvoke('stop_screen_share');
      }
```

- [ ] **Step 3: Remove dead event listeners**

Remove `nvfbc-capture-stopped` and `game-capture-stopped` Tauri event listeners from the capture start flow (they reference archived modules).

- [ ] **Step 4: Remove emergency WGC fallback after game capture**

The catch block that tries WGC after game capture failure — remove it since game capture is archived. Replace with a simple error toast.

- [ ] **Step 5: Update modeLabel**

Remove NVFBC and Game Capture labels:
```javascript
      var modeLabel = window._echoNativeCaptureMode === 'desktop-dd' ? 'Desktop Duplication' : 'Window Capture';
```

- [ ] **Step 6: Commit**
```bash
git add core/viewer/screen-share.js && git commit -m "refactor: simplify capture fallback chain (WGC → DXGI DD only)

Removed NVFBC and present hook branches from JS fallback chain.
These capture methods are archived in core/client/src/archive/."
```

---

## Phase 2: Control Plane Split

### Task 2.1: Extract config.rs

**Files:**
- Create: `core/control/src/config.rs`
- Modify: `core/control/src/main.rs`

- [ ] **Step 1: Create config.rs with Config struct and all utility functions**

Extract from main.rs:
- `Config` struct (line 216-237)
- `load_dotenv()` function
- `resolve_path()` helper
- `resolve_viewer_dir()`, `resolve_admin_dir()`, `resolve_deploy_dir()`
- `stamp_viewer_index()` (including the updated capture-picker entries)
- `now_ts()`, `now_ts_ms()`, `random_secret()`
- `identity_base()`, `urlencoded()`
- `generate_self_signed()` (TLS cert generation)

Add at top of config.rs:
```rust
use std::path::PathBuf;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use axum_server::tls_rustls::RustlsConfig;
use serde::Deserialize;
use rand::RngCore;

// Re-export Config for other modules
pub use self::Config;
```

- [ ] **Step 2: Add `pub mod config;` to main.rs and update imports**

Replace direct function calls with `config::function_name()` or `use crate::config::*;`.

- [ ] **Step 3: Build and verify**
```bash
cd core && cargo check -p echo-core-control 2>&1 | tail -5
```

- [ ] **Step 4: Commit**
```bash
git add core/control/src/ && git commit -m "refactor(control): extract config.rs (Config struct, utility helpers, TLS)"
```

### Task 2.2: Extract auth.rs

**Files:**
- Create: `core/control/src/auth.rs`
- Modify: `core/control/src/main.rs`

- [ ] **Step 1: Create auth.rs**

Extract:
- `AdminClaims` struct (line 467)
- `LiveKitClaims` + `LiveKitVideoGrant` structs (lines 475-493)
- `LoginRequest`, `LoginResponse`, `TokenRequest`, `TokenResponse` structs
- `login()` handler (line 1311)
- `issue_token()` handler (line 1376)
- `ensure_admin()` helper (extracts JWT from Authorization header, validates)

```rust
use crate::config::Config;
use crate::AppState;
use axum::extract::{Json, State, ConnectInfo};
use axum::http::{HeaderMap, StatusCode};
// ... etc
```

- [ ] **Step 2: Update main.rs — add `pub mod auth;`, update router to use `auth::login`, `auth::issue_token`**

- [ ] **Step 3: Build and verify**

- [ ] **Step 4: Commit**
```bash
git commit -m "refactor(control): extract auth.rs (login, JWT tokens, admin gate)"
```

### Task 2.3: Extract sfu_proxy.rs

**Files:**
- Create: `core/control/src/sfu_proxy.rs`
- Modify: `core/control/src/main.rs`

- [ ] **Step 1: Create sfu_proxy.rs**

Extract:
- `sfu_proxy()` handler (line 1093)
- `handle_sfu_socket()` (line 1131)

- [ ] **Step 2: Update main.rs router**

- [ ] **Step 3: Build and verify**

- [ ] **Step 4: Commit**
```bash
git commit -m "refactor(control): extract sfu_proxy.rs (WebSocket bridge to LiveKit SFU)"
```

### Task 2.4: Extract file_serving.rs

**Files:**
- Create: `core/control/src/file_serving.rs`
- Modify: `core/control/src/main.rs`

- [ ] **Step 1: Create file_serving.rs**

Extract:
- `HealthResponse` struct (line 396)
- `health()` handler (line 1235)
- `api_version()` handler (line 1243)
- `api_update_latest()` handler (line 1261)
- `root_route()` handler (line 1300)
- `open_url()` handler (line 1282)
- `online_users()` handler (line 1291)

- [ ] **Step 2-4: Update main.rs, build, commit**
```bash
git commit -m "refactor(control): extract file_serving.rs (health, version, static files)"
```

### Task 2.5: Extract rooms.rs

**Files:**
- Create: `core/control/src/rooms.rs`
- Modify: `core/control/src/main.rs`

- [ ] **Step 1: Create rooms.rs**

Extract:
- `RoomInfo`, `RoomStatusEntry`, `RoomStatusParticipant` structs
- `ParticipantEntry`, `SessionEvent` structs
- `ParticipantLeaveRequest` struct
- `list_rooms()`, `create_room()`, `get_room()`, `delete_room()` handlers
- `rooms_status()`, `participant_heartbeat()`, `participant_leave()` handlers
- `metrics()`, `ice_servers()` handlers
- `admin_kick_participant()`, `admin_mute_participant()` handlers
- `append_session_event()` helper

- [ ] **Step 2-4: Update main.rs, build, commit**
```bash
git commit -m "refactor(control): extract rooms.rs (room CRUD, participants, kick/mute)"
```

### Task 2.6: Extract soundboard.rs

**Files:**
- Create: `core/control/src/soundboard.rs`
- Modify: `core/control/src/main.rs`

- [ ] **Step 1: Create soundboard.rs**

Extract:
- `SoundboardState`, `SoundboardSound`, `SoundboardPublic` structs
- `SoundboardListQuery`, `SoundboardUploadQuery`, `SoundboardUpdateRequest` structs
- `SoundboardListResponse`, `SoundboardSoundResponse` structs
- `soundboard_list()`, `soundboard_file()`, `soundboard_upload()`, `soundboard_update()` handlers

- [ ] **Step 2-4: Update main.rs, build, commit**
```bash
git commit -m "refactor(control): extract soundboard.rs (per-room audio clip CRUD)"
```

### Task 2.7: Extract chat.rs

**Files:**
- Create: `core/control/src/chat.rs`
- Modify: `core/control/src/main.rs`

- [ ] **Step 1: Create chat.rs**

Extract:
- `ChatState`, `ChatMessage`, `ChatDeleteRequest`, `ChatUploadResponse`, `ChatUploadQuery` structs
- `AvatarUploadQuery` struct
- `ChimeEntry`, `ChimeUploadQuery`, `ChimeDeleteRequest` structs
- All chat handlers: `chat_save_message()`, `chat_delete_message()`, `chat_get_history()`, `chat_upload_file()`, `chat_get_upload()`
- Avatar handlers: `avatar_upload()`, `avatar_get()`
- Chime handlers: `chime_upload()`, `chime_get()`, `chime_delete()`

- [ ] **Step 2-4: Update main.rs, build, commit**
```bash
git commit -m "refactor(control): extract chat.rs (messages, uploads, avatars, chimes)"
```

### Task 2.8: Extract admin.rs

**Files:**
- Create: `core/control/src/admin.rs`
- Modify: `core/control/src/main.rs`

- [ ] **Step 1: Create admin.rs**

Extract:
- `ClientStats`, `StatsSnapshot`, `BugReport`, `BugReportRequest` structs
- `admin_dashboard()`, `admin_sessions()`, `admin_dashboard_metrics()` handlers
- `admin_report_stats()`, `admin_metrics()` handlers
- `submit_bug_report()`, `admin_bug_reports()`, `admin_deploys()` handlers
- `create_github_issue()` helper
- `append_stats_snapshot()`, `append_bug_report()` helpers

- [ ] **Step 2-4: Update main.rs, build, commit**
```bash
git commit -m "refactor(control): extract admin.rs (dashboard, metrics, bug reports)"
```

### Task 2.9: Extract jam_session.rs

**Files:**
- Create: `core/control/src/jam_session.rs`
- Modify: `core/control/src/main.rs`

- [ ] **Step 1: Create jam_session.rs**

Extract:
- `SpotifyToken`, `SpotifyPending`, `JamState`, `QueuedTrack`, `NowPlayingInfo` structs
- All jam handlers: `jam_spotify_init()`, `jam_spotify_callback()`, `jam_spotify_code()`, `jam_spotify_token()`
- `jam_start()`, `jam_stop()`, `jam_state()`, `jam_search()`
- `jam_queue_add()`, `jam_queue_remove()`, `jam_skip()`
- `jam_join()`, `jam_leave()`, `jam_audio_ws()`, `jam_audio_ws_handler()`
- Helpers: `spotify_api_request()`, `refresh_spotify_token()`, `stop_jam_bot()`, `schedule_jam_auto_end()`

- [ ] **Step 2-4: Update main.rs, build, commit**
```bash
git commit -m "refactor(control): extract jam_session.rs (Spotify OAuth, queue, audio streaming)"
```

### Task 2.10: Final control plane verification

- [ ] **Step 1: Full build**
```bash
cd core && cargo build -p echo-core-control 2>&1 | tail -5
```

- [ ] **Step 2: Verify main.rs is now ~500 lines** (AppState + router + main + background tasks)

- [ ] **Step 3: Start control plane and smoke test**
```bash
powershell -ExecutionPolicy Bypass -File core/run-core.ps1
curl -sk https://127.0.0.1:9443/health
```

- [ ] **Step 4: Commit any fixups**

---

## Phase 3: screen-share.js Split

### Task 3.1: Create screen-share-state.js

**Files:**
- Create: `core/viewer/screen-share-state.js`
- Modify: `core/viewer/index.html` (add before other screen-share scripts)

- [ ] **Step 1: Create screen-share-state.js with shared globals**

Extract from screen-share.js (lines 42-48, 143-155):
```javascript
/* Screen share shared state — globals accessed across screen-share-*.js modules */

// Quality warning state
var _qualityWarnUnlisten = null;
var _qualityWarnLowSince = 0;
var _qualityWarnShowing = false;
var _qualityWarnDismissed = false;
var _qualityWarnBannerEl = null;
const QUALITY_WARN_FPS_THRESHOLD = 30;
const QUALITY_WARN_DURATION_MS = 5000;

// Track refs for manual screen share
let _screenShareVideoTrack = null;
let _screenShareAudioTrack = null;
let _screenShareStatsInterval = null;
let _inboundScreenStatsInterval = null;
let _inboundScreenLastBytes = new Map();
let _inboundDropTracker = new Map();
let _pubBitrateControl = new Map();

// Native audio state
var _nativeAudioCtx = null;
var _nativeAudioWorklet = null;
var _nativeAudioDest = null;
var _nativeAudioTrack = null;
var _nativeAudioUnlisten = null;
var _nativeAudioActive = false;

// Bitrate control state
var _bitrateCaps = new Map();
var _currentAppliedCap = null;
var _bitrateCapCleanupTimer = null;

// Constants
const BITRATE_DEFAULT_HIGH = 15_000_000;
const BITRATE_DEFAULT_MED = 5_000_000;
const BITRATE_DEFAULT_LOW = 1_500_000;
const BITRATE_CAP_TTL = 30000;
```

- [ ] **Step 2: Add to index.html BEFORE screen-share.js**
```html
<script src="screen-share-state.js"></script>
```

- [ ] **Step 3: Add to control plane stamp list in config.rs**

- [ ] **Step 4: Commit**
```bash
git commit -m "refactor(viewer): extract screen-share-state.js (shared globals)"
```

### Task 3.2: Extract screen-share-config.js

**Files:**
- Create: `core/viewer/screen-share-config.js`

- [ ] **Step 1: Move `getScreenSharePublishOptions()` (lines 5-38) to new file**

- [ ] **Step 2: Add to index.html after screen-share-state.js**

- [ ] **Step 3: Remove from screen-share.js, verify no breakage**

- [ ] **Step 4: Commit**
```bash
git commit -m "refactor(viewer): extract screen-share-config.js (publish options)"
```

### Task 3.3: Extract screen-share-quality.js

**Files:**
- Create: `core/viewer/screen-share-quality.js`

- [ ] **Step 1: Move quality warning functions (lines 50-140) to new file**

Functions: `_onCaptureStats()`, `_showQualityWarning()`, `_hideQualityWarning()`, `_startQualityWarnListener()`, `_stopQualityWarnListener()`

- [ ] **Step 2: Add to index.html, update stamp list**

- [ ] **Step 3: Commit**
```bash
git commit -m "refactor(viewer): extract screen-share-quality.js (FPS warning banner)"
```

### Task 3.4: Extract screen-share-adaptive.js

**Files:**
- Create: `core/viewer/screen-share-adaptive.js`

- [ ] **Step 1: Move adaptive bitrate functions to new file**

From lines 157-697: `startInboundScreenStatsMonitor()`, `stopInboundScreenStatsMonitor()`
From lines 2049-2082: `reduceCameraForScreenShare()`, `restoreCameraQuality()`
From lines 2085-2191: `handleBitrateCapRequest()`, `cleanupAndApplyBitrateCaps()`, `applyMostRestrictiveCap()`, `applyBitrateToSender()`

- [ ] **Step 2: Add to index.html after screen-share-quality.js**

- [ ] **Step 3: Verify cross-file callers still work:**
- `audio-routing.js` calls `startInboundScreenStatsMonitor()` (lines 494, 549)
- `participants.js` calls `stopInboundScreenStatsMonitor()` (line 469)
- `connect.js` calls `handleBitrateCapRequest()` (line 1109)

- [ ] **Step 4: Commit**
```bash
git commit -m "refactor(viewer): extract screen-share-adaptive.js (AIMD bitrate, camera adaptation)"
```

### Task 3.5: Rename remaining screen-share.js → screen-share-native.js

**Files:**
- Rename: `core/viewer/screen-share.js` → `core/viewer/screen-share-native.js`
- Modify: `core/viewer/index.html`

- [ ] **Step 1: After extracting all other sections, the remaining file contains:**
- `startScreenShareManual()` (~900 lines)
- `stopScreenShareManual()` (~80 lines)
- `autoDetectNativeAudio()` (~100 lines)
- `startNativeAudioCapture()` (~150 lines)
- `stopNativeAudioCapture()` (~40 lines)
- `_nativeAudioWorkletCode` (worklet source, ~30 lines)

This is the native capture + audio pipeline — rename to `screen-share-native.js`.

- [ ] **Step 2: Update index.html**

- [ ] **Step 3: Verify all cross-file callers:**
- `media-controls.js` calls `startScreenShareManual()` and `stopScreenShareManual()`
- `connect.js` calls `stopNativeAudioCapture()`

- [ ] **Step 4: Commit**
```bash
git commit -m "refactor(viewer): rename screen-share.js → screen-share-native.js (capture + audio pipeline)"
```

---

## Phase 4: participants.js Split

### Task 4.1: Analyze and split participants.js

**Files:**
- Create: `core/viewer/participants-grid.js`
- Create: `core/viewer/participants-avatar.js`
- Create: `core/viewer/participants-fullscreen.js`
- Modify: `core/viewer/participants.js` (coordinator, ~500 lines)

- [ ] **Step 1: Read participants.js and identify section boundaries**

- [ ] **Step 2: Extract grid layout functions → participants-grid.js**
Functions: `addTile()`, `removeTile()`, `reorderTiles()`, resize observer logic

- [ ] **Step 3: Extract avatar functions → participants-avatar.js**
Functions: `uploadAvatar()`, `displayAvatar()`, initials generation, name badge

- [ ] **Step 4: Extract fullscreen/PiP → participants-fullscreen.js**
Functions: `toggleFullscreen()`, `enterPiP()`, screen share tile management, quality overlay

- [ ] **Step 5: Update index.html with new scripts in correct order**

- [ ] **Step 6: Verify cross-file callers:**
- `audio-routing.js` calls `addTile()`, `addScreenTile()`, `removeScreenTile()`
- `connect.js` calls `addTile()`, `configureVideoElement()`, etc.

- [ ] **Step 7: Commit**
```bash
git commit -m "refactor(viewer): split participants.js into grid, avatar, fullscreen modules"
```

---

## Phase 5: Unified Capture Trait

### Task 5.1: Create capture_pipeline.rs

**Files:**
- Create: `core/client/src/capture_pipeline.rs`
- Modify: `core/client/src/screen_capture.rs`
- Modify: `core/client/src/desktop_capture.rs`
- Modify: `core/client/src/main.rs`

- [ ] **Step 1: Create capture_pipeline.rs with shared publisher**

```rust
//! Shared capture → SFU publish pipeline.
//! Used by WGC (screen_capture) and DXGI DD (desktop_capture) to avoid
//! duplicating LiveKit connection, I420 conversion, and frame publishing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use livekit::prelude::*;
use livekit::webrtc::prelude::*;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::native::yuv_helper;
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};

pub struct CapturePublisher {
    pub room: Room,
    pub source: NativeVideoSource,
    pub running: Arc<AtomicBool>,
    pub app: AppHandle,
    pub start_time: std::time::Instant,
    pub frame_count: u64,
    pub drop_count: u64,
    yuv_total_us: u64,
    capture_total_us: u64,
}

impl CapturePublisher {
    /// Connect to SFU, create 1080p video source, publish as Camera track.
    pub async fn connect_and_publish(
        sfu_url: &str,
        token: &str,
        app: &AppHandle,
        running: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let (room, _events) = Room::connect(sfu_url, token, RoomOptions::default())
            .await
            .map_err(|e| format!("SFU connect failed: {}", e))?;

        let source = NativeVideoSource::new(
            VideoResolution { width: 1920, height: 1080 },
            false,
        );
        let track = LocalVideoTrack::create_video_track(
            "screen",
            RtcVideoSource::Native(source.clone()),
        );

        let publish_options = TrackPublishOptions {
            source: TrackSource::Camera,
            video_codec: VideoCodec::H264,
            simulcast: false,
            video_encoding: Some(VideoEncoding {
                max_bitrate: 20_000_000,
                max_framerate: 60.0,
            }),
            ..Default::default()
        };
        room.local_participant()
            .publish_track(LocalTrack::Video(track), publish_options)
            .await
            .map_err(|e| format!("publish failed: {}", e))?;

        eprintln!("[capture-pipeline] published, waiting for negotiation...");
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        Ok(Self {
            room, source, running,
            app: app.clone(),
            start_time: std::time::Instant::now(),
            frame_count: 0,
            drop_count: 0,
            yuv_total_us: 0,
            capture_total_us: 0,
        })
    }

    /// Convert BGRA frame to I420 and push to LiveKit.
    pub fn push_frame(&mut self, bgra: &[u8], width: u32, height: u32) {
        let t0 = std::time::Instant::now();
        let mut i420 = I420Buffer::new(width, height);
        let (sy, su, sv) = i420.strides();
        let (y, u, v) = i420.data_mut();

        yuv_helper::argb_to_i420(
            bgra, width * 4, y, sy, u, su, v, sv,
            width as i32, height as i32,
        );
        let t1 = std::time::Instant::now();

        let vf = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            buffer: i420,
            timestamp_us: self.start_time.elapsed().as_micros() as i64,
        };
        self.source.capture_frame(&vf);
        let t2 = std::time::Instant::now();

        self.yuv_total_us += (t1 - t0).as_micros() as u64;
        self.capture_total_us += (t2 - t1).as_micros() as u64;
        self.frame_count += 1;
    }

    /// Emit stats event every N frames. Returns current FPS.
    pub fn maybe_emit_stats(&self, event_name: &str, every_n: u64) -> Option<u32> {
        if self.frame_count == 0 || self.frame_count % every_n != 0 { return None; }
        let elapsed = self.start_time.elapsed().as_secs_f64();
        let fps = if elapsed > 0.0 { (self.frame_count as f64 / elapsed) as u32 } else { 0 };
        let avg_yuv_ms = self.yuv_total_us as f64 / self.frame_count as f64 / 1000.0;
        let avg_cap_ms = self.capture_total_us as f64 / self.frame_count as f64 / 1000.0;
        eprintln!("[capture-pipeline] {}fps ({} frames, {} skipped, yuv={:.1}ms, cap={:.1}ms)",
            fps, self.frame_count, self.drop_count, avg_yuv_ms, avg_cap_ms);
        // Emit to JS via Tauri event
        let _ = self.app.emit(event_name, serde_json::json!({
            "fps": fps, "width": 1920, "height": 1080,
            "bitrate_kbps": 0, "encoder": "NVENC/H264", "status": "active"
        }));
        Some(fps)
    }

    /// Shutdown: close SFU room.
    pub async fn shutdown(self) {
        self.room.close().await.ok();
        eprintln!("[capture-pipeline] shutdown, {} frames captured", self.frame_count);
    }
}
```

- [ ] **Step 2: Refactor screen_capture.rs to use CapturePublisher**

Replace the inline LiveKit connect + publish + frame loop with:
```rust
use crate::capture_pipeline::CapturePublisher;

// In share_loop():
let mut publisher = CapturePublisher::connect_and_publish(sfu_url, token, app, running.clone()).await?;
let _ = app.emit("screen-capture-started", target_pid);

// Frame loop:
while running.load(Ordering::SeqCst) {
    // ... channel recv + drain ...
    publisher.push_frame(&bgra_data, width, height);
    publisher.maybe_emit_stats("screen-capture-stats", 30);
}
publisher.shutdown().await;
```

- [ ] **Step 3: Refactor desktop_capture.rs to use CapturePublisher**

Same pattern — replace inline LiveKit code with CapturePublisher calls.

- [ ] **Step 4: Add `mod capture_pipeline;` to main.rs**

- [ ] **Step 5: Build and verify**
```bash
cd core && cargo build -p echo-core-client --release 2>&1 | tail -5
```

- [ ] **Step 6: Commit**
```bash
git commit -m "refactor(client): extract capture_pipeline.rs (shared SFU publish + frame conversion)"
```

---

## Phase 6: SDK Patch Documentation

### Task 6.1: Write SDK_PATCHES.md

**Files:**
- Create: `core/docs/SDK_PATCHES.md`

- [ ] **Step 1: Document all 8 patches**

```markdown
# Echo Chamber SDK Patches

Modifications to vendored LiveKit SDKs required for high-performance
game streaming. Each patch is critical — removing any one causes
measurable degradation.

## livekit-local (LiveKit Rust SDK fork)

### Patch 1: RID Quality Label Fix
**File:** `src/room/options.rs` lines 252-255
**What:** Single-layer non-simulcast tracks get RID 'f' (HIGH) instead of 'q' (LOW)
**Why:** VIDEO_RIDS[0]='q'. Non-simulcast tracks use index 0 → SFU sees LOW quality → allocates ~700kbps instead of full bandwidth
**Impact:** Before: 700kbps allocated. After: full 20Mbps. Desktop viewer goes from 5fps to 100fps.
**Upstream:** Bug in livekit-rust-sdks affecting all non-simulcast tracks

## webrtc-sys-local (WebRTC C++ bindings fork)

### Patch 2: is_screencast() Method
**Files:** `include/livekit/video_track.h` lines 87-123, `src/video_track.cpp` lines 113-115
**What:** Added `is_screencast()` to VideoTrackSource
**Why:** Needed by Patch 3 to distinguish game content from screen shares

### Patch 3: ContentHint=Fluid (MAINTAIN_FRAMERATE)
**File:** `src/peer_connection_factory.cpp` lines 119-125
**What:** Sets ContentHint::Fluid on non-screencast video tracks at creation
**Why:** Default degradation drops FPS when bandwidth constrained. Fluid → MAINTAIN_FRAMERATE → reduces resolution instead
**Impact:** Before: SetRates fps=10 → capture degrades to 12fps. After: SetRates fps=101 → 100fps sustained.

### Patch 4: AdaptFrame Bypass
**File:** `src/video_track.cpp` lines 150-158
**What:** Calls OnFrame() directly instead of through AdaptFrame()
**Why:** AdaptFrame uses software encoder heuristics — drops to 8fps when NVENC handles full rate
**Impact:** All captured frames reach the encoder

### Patch 5: CBR Rate Control
**File:** `src/nvidia/h264_encoder_impl.cpp` line 247
**What:** `rateControlMode = NV_ENC_PARAMS_RC_CBR`
**Why:** Constant bitrate prevents frame-to-frame quality spikes

### Patch 6: Trusted Rate Controller
**File:** `src/nvidia/h264_encoder_impl.cpp` lines 465-467
**What:** `has_trusted_rate_controller = true`, `is_qp_trusted = true`
**Why:** Tells WebRTC's encoder queue to accept all frames — NVENC handles drops internally via CBR
**Impact:** Zero skipped frames at up to 20Mbps

### Patch 7: Force 60fps to NVENC
**File:** `src/nvidia/h264_encoder_impl.cpp` lines 496-530
**What:** Overrides SetRates fps with constant 60fps to NVENC
**Why:** Low fps target (9fps) creates huge per-frame bursts → pacer congestion → more drops
**Impact:** Small smooth ~20KB frames instead of 200KB bursts

### Patch 8: Multi-Profile H264 + HEVC
**File:** `src/nvidia/nvidia_encoder_factory.cpp` lines 12-43
**What:** Registers Constrained Baseline, High, Constrained High, Main profiles + HEVC
**Why:** Ensures SDP negotiation succeeds with all decoder variants
```

- [ ] **Step 2: Commit**
```bash
git commit -m "docs: SDK patch documentation (8 patches across 2 forks)"
```

---

## Phase 7: Architecture Documentation

### Task 7.1: Write architecture docs

**Files:**
- Rewrite: `core/docs/ARCHITECTURE.md`
- Rewrite: `core/docs/CLIENT.md` → `core/docs/CLIENT_MODULES.md`
- Rewrite: `core/docs/CONTROL_PLANE.md` → `core/docs/CONTROL_MODULES.md`
- Create: `core/docs/CAPTURE_PIPELINE.md`
- Create: `core/docs/AUDIO_PIPELINE.md`
- Create: `core/docs/VIEWER_MODULES.md`
- Create: `core/docs/NETWORKING.md`
- Update: `core/docs/DECISIONS.md`

- [ ] **Step 1: Write ARCHITECTURE.md** — System overview with component diagram, data flow, deployment topology

- [ ] **Step 2: Write CAPTURE_PIPELINE.md** — WGC + DXGI DD flow, GPU shader, NVENC, channel architecture, OS fallback

- [ ] **Step 3: Write AUDIO_PIPELINE.md** — WASAPI → base64 → AudioWorklet → MediaStream → LiveKit

- [ ] **Step 4: Write VIEWER_MODULES.md** — JS module map with dependency graph, load order, what each file does

- [ ] **Step 5: Write CLIENT_MODULES.md** — Rust module map, IPC commands, platform abstraction

- [ ] **Step 6: Write CONTROL_MODULES.md** — API route tree, new module structure, state management

- [ ] **Step 7: Write NETWORKING.md** — LAN/WAN topology, port forwarding, hairpin NAT, TURN, SFU proxy

- [ ] **Step 8: Update DECISIONS.md** — Add entries for all abandoned approaches with rationale

- [ ] **Step 9: Commit**
```bash
git commit -m "docs: complete architecture documentation rewrite (10 documents)"
```

---

## Phase 8: Final Verification & Cleanup

### Task 8.1: Full build verification

- [ ] **Step 1: Build client**
```bash
cd core && cargo build -p echo-core-client --release 2>&1 | tail -5
```

- [ ] **Step 2: Build control plane**
```bash
cd core && cargo build -p echo-core-control 2>&1 | tail -5
```

- [ ] **Step 3: Start control plane and verify health**
```bash
curl -sk https://127.0.0.1:9443/health
```

- [ ] **Step 4: Start client, verify viewer loads with all JS modules**

- [ ] **Step 5: Test screen share (WGC) — verify 60fps capture**

- [ ] **Step 6: Test game audio — verify WASAPI → viewer pipeline**

- [ ] **Step 7: Verify cache-busting — all new JS files get version stamps**

- [ ] **Step 8: Deploy to SAM-PC, verify remote connection**

- [ ] **Step 9: Update CURRENT_SESSION.md with refactor completion**

- [ ] **Step 10: Final commit**
```bash
git commit -m "chore: hardening & refactor complete — verification passed"
```
