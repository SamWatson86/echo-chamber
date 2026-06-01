# Capture Pipeline

Screen capture runs in the Tauri client. The viewer picker chooses the source,
`screen-share-native.js` chooses the native path, and Rust captures/publishes
through the shared LiveKit capture pipeline.

## Active Capture Methods

### WGC - Windows.Graphics.Capture

- Module: `core/client/src/screen_capture.rs`
- Used for window/game capture on supported Windows builds
- Started through the `start_screen_share` Tauri command
- Passes frames through `gpu_converter.rs`
- Publishes through `capture_pipeline.rs`

### DXGI Desktop Duplication

- Module: `core/client/src/desktop_capture.rs`
- Production monitor-capture path
- Fallback path for older Windows builds and unsupported native sources
- Started through the `start_desktop_capture` Tauri command
- Passes frames through `gpu_converter.rs`
- Publishes through `capture_pipeline.rs`

The Tauri command `start_screen_share_monitor` exists for the older WGC monitor
experiment, but it is not the production picker path. Do not call or revive that
path for monitor sharing without a fresh design and explicit hardware-risk
review. Current monitor shares should go through DXGI Desktop Duplication.

## GPU Shader Pipeline

Shared module: `core/client/src/gpu_converter.rs`

```text
Captured D3D11 texture
  |
  v
GPU shader conversion / downscale
  |
  v
CPU staging texture
  |
  v
libyuv BGRA to I420
  |
  v
NativeVideoSource::capture_frame
  |
  v
H264 via NVENC
  |
  v
RTP to SFU to viewer
```

## OS-Aware Fallback Chain

Detection runs in `core/viewer/screen-share-native.js` before starting native
capture:

1. Query `get_os_build_number` through Tauri IPC.
2. For window/game sources on supported builds, call `start_screen_share`.
3. For monitor sources, or when WGC is unsupported, call
   `start_desktop_capture`.
4. If Tauri IPC is unavailable, use browser `getDisplayMedia` fallback.

The JS side derives the SFU URL from the control URL. It does not connect to
port 7880 directly.

## Encoding

- Encoder: NVENC (H264) through the local `webrtc-sys` fork.
- Local fork path: `core/webrtc-sys-local/`.
- ContentHint: `fluid`, which maps to MAINTAIN_FRAMERATE in libwebrtc.
- Simulcast: disabled for screen share.
- Game streams advertise their real min bitrate floor and start bitrate.

## Archived Methods

Dead methods live in `core/client/src/archive/`. The old top-level `core/hook/`
crate is also excluded from the active Cargo workspace. These paths are
reference-only and must not be copied into production capture work without a
fresh design review.

| Method | File | Why dead |
|---|---|---|
| NVFBC | `archive/nvfbc_capture.rs` | Blocked by NVIDIA driver 595.79 on GeForce. |
| Present hook | `archive/hook/`, `archive/game_capture.rs`, `archive/injector.rs` | Fails with DLSS Frame Generation. |
| Control block client | `archive/control_block_client.rs` | Superseded by direct IPC approach. |

See `core/client/src/archive/README.md` for details.
