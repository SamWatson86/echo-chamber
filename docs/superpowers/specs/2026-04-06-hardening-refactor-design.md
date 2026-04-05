# Echo Chamber — Hardening, Refactor & Documentation Spec

**Date:** 2026-04-06
**Initiated by:** Spencer (architecture/process recommendation)
**Goal:** Remove dead code, split monolithic files, document architecture, enable maintenance and scaling

---

## 1. Dead Code Archival

### Modules to Archive → `core/client/src/archive/`

| Module | Lines | Why Dead | Revival Condition |
|--------|-------|----------|-------------------|
| `nvfbc_capture.rs` | 813 | GeForce driver blocks NVFBC. Wrapper DLL doesn't help. Also compositor-bound on Windows. | NVIDIA unblocks NVFBC on consumer GPUs |
| `game_capture.rs` | 555 | Present() hook fails with DLSS Frame Generation — proxy swap chain sends garbled data across 4 channels | DLSS FG architecture changes or game-specific workaround found |
| `injector.rs` | 385 | DLL injector only serves game_capture | game_capture revived |
| `control_block_client.rs` | 107 | Shared memory IPC only serves game_capture/injector | game_capture revived |

**Also archived:** `core/hook/` directory (DLL source, 96 lines + build config) → `core/client/src/archive/hook/`

**Archive README.md** documents each approach with: what it did, why it was abandoned, performance numbers achieved, and what would need to change to revive it.

### JS Fallback Chain Simplification

**Before:** NVFBC → WGC → DXGI DD → Present hook (4 methods, 2 dead)
**After:** WGC (Win11 24H2+) → DXGI DD (older Windows / monitors)

Remove from `screen-share.js`:
- NVFBC check/start block (~20 lines)
- Present hook fallback block (~10 lines)
- Emergency WGC fallback after game capture failure (~15 lines)

### main.rs Cleanup

Remove IPC commands:
- `check_nvfbc_available`, `start_nvfbc_capture`, `stop_nvfbc_capture`
- `start_game_capture`, `stop_game_capture`
- `mod nvfbc_capture`, `mod game_capture`, `mod injector`, `mod control_block_client`

Remove from `generate_handler![]` macro invocation.

---

## 2. Control Plane Split (main.rs → 9 modules)

### Current State
`core/control/src/main.rs` — 4,758 lines, single file containing all routes, state, auth, and business logic.

### Target Structure
```
core/control/src/
├── main.rs          (~500 lines)  — AppState struct, router assembly, startup, background tasks
├── config.rs        (~420 lines)  — .env loading, path resolution, TLS cert gen, utility helpers
├── auth.rs          (~105 lines)  — login, JWT token issuance, ensure_admin() gate
├── sfu_proxy.rs     (~115 lines)  — WebSocket bridge to LiveKit SFU, token relay
├── file_serving.rs  (~130 lines)  — viewer/admin static files, health, version, updater manifest
├── rooms.rs         (~350 lines)  — room CRUD, participant heartbeat/leave, session tracking, ICE
├── soundboard.rs    (~245 lines)  — per-room audio clip management, file upload/serve
├── chat.rs          (~610 lines)  — messages, file uploads, avatars, chimes
├── admin.rs         (~770 lines)  — dashboard, metrics snapshots, bug reports, deploys, kick/mute
└── jam_session.rs   (~960 lines)  — Spotify OAuth PKCE, queue, now-playing, audio WS streaming
```

### Extraction Order (dependency-safe)
1. `config.rs` — zero internal deps
2. `sfu_proxy.rs` + `file_serving.rs` — config only
3. `auth.rs` — config only
4. `rooms.rs` + `soundboard.rs` + `chat.rs` — auth + config
5. `admin.rs` + `jam_session.rs` — auth + config + rooms

### Shared State Strategy
`AppState` stays in main.rs as the single holder. Each module receives `State<AppState>` via Axum extractors and accesses only what it needs. No duplication of ownership, no new state types.

### Risk Mitigation
- Extract without changing any lock logic — preserve existing Mutex ordering
- Test each module extraction individually before proceeding
- Run full integration test (connect, share screen, chat, soundboard) after each phase

---

## 3. Viewer JS Splits

### 3a. screen-share.js (2,190 lines → 5 files)

| File | Lines | Purpose | Dependencies |
|------|-------|---------|--------------|
| `screen-share-state.js` | ~30 | Shared global variables + constants | None |
| `screen-share-config.js` | ~40 | `getScreenSharePublishOptions()` | None |
| `screen-share-quality.js` | ~150 | FPS warning banner + native audio auto-detection | tauriListen, showToast, debugLog |
| `screen-share-native.js` | ~1,300 | Capture pipeline (WGC/DD fallback) + WASAPI audio + worklet | tauriInvoke, getLiveKitClient, room, screen-share-state |
| `screen-share-adaptive.js` | ~565 | Inbound AIMD bitrate + publisher cap + camera adaptation | room, getLiveKitClient, screen-share-state |

**Load order in index.html:**
```
screen-share-state.js → screen-share-config.js → screen-share-quality.js → screen-share-native.js → screen-share-adaptive.js
```

**Shared state** (in screen-share-state.js):
- `_screenShareVideoTrack`, `_screenShareAudioTrack` — published track refs
- `_latestOutboundBwe` — BWE reading for adaptive decisions
- `_cameraReducedForScreenShare`, `_bweLowTicks`, `_bweKickAttempted` — cross-module adaptation state
- Constants: `BITRATE_DEFAULT_HIGH/MED/LOW`, `QUALITY_WARN_FPS_THRESHOLD`

### 3b. participants.js (2,078 lines → 3 files)

| File | Lines | Purpose |
|------|-------|---------|
| `participants-grid.js` | ~800 | Video tile grid layout, resize observer, tile creation/removal |
| `participants-avatar.js` | ~400 | Avatar upload, display, initials fallback, name badges |
| `participants-fullscreen.js` | ~400 | Fullscreen/PiP mode, screen share tile management, quality display |

Remaining ~478 lines stay in `participants.js` as the coordinator (exports public API, delegates to sub-modules).

### Script Load Order Update
Add new files to `index.html` AND to the control plane's `stamp_viewer_index()` asset list for cache-busting.

---

## 4. Unified Capture Trait (Rust)

### Current State
WGC (`screen_capture.rs`) and DXGI DD (`desktop_capture.rs`) share the same pipeline pattern:
1. Connect to LiveKit SFU
2. Create NativeVideoSource at 1080p
3. Publish track as Camera with 20Mbps cap
4. Start capture → channel → libyuv → capture_frame loop
5. Emit stats events
6. Stop via AtomicBool

But each implements this independently with duplicated code.

### Target
Extract shared pipeline into `capture_pipeline.rs`:

```rust
pub struct CapturePublisher {
    room: Room,
    source: NativeVideoSource,
    running: Arc<AtomicBool>,
    app: AppHandle,
    start_time: Instant,
    frame_count: u64,
    drop_count: u64,
}

impl CapturePublisher {
    pub async fn connect_and_publish(sfu_url: &str, token: &str, app: &AppHandle) -> Result<Self, String>;
    pub fn push_frame(&mut self, bgra: &[u8], width: u32, height: u32);
    pub fn emit_stats(&self, event_name: &str);
    pub async fn shutdown(self);
}
```

WGC and DXGI DD then focus only on their capture-specific logic (WGC callback setup, DXGI duplication setup) and delegate the SFU connection + frame publishing to `CapturePublisher`.

### Benefits
- Eliminates ~200 lines of duplicated LiveKit connection/publish/stats code
- Single place to fix frame pipeline bugs (like the channel capacity issue)
- New capture methods (future) only implement the source-specific part

---

## 5. SDK Patch Documentation

### File: `core/docs/SDK_PATCHES.md`

Documents all 8 modifications across the two forked SDKs:

**livekit-local (1 patch):**
1. RID 'q' → 'f' for single-layer non-simulcast (`options.rs:252-255`)

**webrtc-sys-local (7 patches):**
1. `is_screencast()` added to VideoTrackSource (`video_track.h`, `video_track.cpp`)
2. AdaptFrame bypass for NVENC (`video_track.cpp:150-158`)
3. ContentHint=Fluid for non-screencast tracks (`peer_connection_factory.cpp:119-125`)
4. CBR rate control mode (`h264_encoder_impl.cpp:247`)
5. `has_trusted_rate_controller=true` + `is_qp_trusted=true` (`h264_encoder_impl.cpp:465-467`)
6. Force 60fps to NVENC, override SetRates (`h264_encoder_impl.cpp:496-530`)
7. Multi-profile H264 + HEVC support (`nvidia_encoder_factory.cpp:12-43`)

Each patch documented with: file, exact lines, what was changed, why (root cause), impact (before/after), and upstream bug status.

---

## 6. Architecture Documentation

### Complete rewrite of `core/docs/`

| Document | Purpose |
|----------|---------|
| `ARCHITECTURE.md` | System overview: components, data flow, deployment topology |
| `CAPTURE_PIPELINE.md` | WGC + DXGI DD capture flow, GPU shader, NVENC, libyuv, SFU publish |
| `AUDIO_PIPELINE.md` | WASAPI → base64 events → AudioWorklet → MediaStream → LiveKit publish |
| `SFU_PROXY.md` | WebSocket proxy architecture, token relay, congestion control settings |
| `VIEWER_MODULES.md` | JS module map, dependency graph, load order, what each file does |
| `CLIENT_MODULES.md` | Rust module map, IPC commands, platform abstraction |
| `CONTROL_MODULES.md` | API route tree, state management, module responsibilities |
| `SDK_PATCHES.md` | Forked SDK modifications (detailed above) |
| `NETWORKING.md` | LAN/WAN topology, port forwarding, hairpin NAT, TURN |
| `DECISIONS.md` | Decision log: what was tried, what failed, what was chosen and why |

---

## 7. Cache-Busting Fix

Add ALL viewer JS/CSS files to the control plane's `stamp_viewer_index()` asset list. Currently missing:
- `capture-picker.js`
- `capture-picker.css`
- All new split files from sections 3a and 3b

---

## 8. Verification Strategy

After each phase:
1. **Build check:** `cargo build -p echo-core-client --release` + `cargo build -p echo-core-control`
2. **Smoke test:** Start control plane + client, join room, verify video/audio/chat
3. **Capture test:** Share screen via WGC, verify 60fps to self-view
4. **Audio test:** Share game, verify WASAPI audio flows to viewers
5. **External test:** Deploy to SAM-PC, verify remote connection

---

## Implementation Phases

| Phase | Scope | Risk |
|-------|-------|------|
| **Phase 1** | Dead code archival + fallback chain cleanup | Low |
| **Phase 2** | Control plane split (9 modules) | Medium |
| **Phase 3** | screen-share.js split (5 files) | Medium |
| **Phase 4** | participants.js split (3 files) | Medium |
| **Phase 5** | Unified capture trait (Rust) | Medium |
| **Phase 6** | SDK patch documentation | Low |
| **Phase 7** | Architecture docs rewrite | Low |
| **Phase 8** | Final verification + cache-busting | Low |
