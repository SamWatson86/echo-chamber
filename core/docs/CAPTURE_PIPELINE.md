# Capture Pipeline

Screen capture runs in the Tauri client (Rust). Two active methods are used depending on OS version. The JS picker (`capture-picker.js`) selects the source; the Rust backend does the actual capture.

## Active Capture Methods

### WGC — Windows.Graphics.Capture (Win11 24H2+ only)

- Module: `core/client/src/screen_capture.rs`
- API: `windows-capture` crate wrapping WGC
- Output: BGRA frames from GPU
- Passes frames through `gpu_converter.rs` for HDR→SDR + downscale
- Encoding: Media Foundation → NVENC (H264)

Activated when OS build ≥ 26100 (Win11 24H2). Detection in `screen-share-native.js`:

```js
var osBuild = await tauriInvoke('get_os_build_number');
var useWgc = osBuild >= 26100;
```

### DXGI Desktop Duplication (fallback — Win10 / older builds)

- Module: `core/client/src/desktop_capture.rs`
- API: `IDXGIOutputDuplication` (DWM compositor frames)
- Works with every game in windowed/borderless regardless of DX version, DLSS FG, or anti-cheat
- Also passes through `gpu_converter.rs`

## GPU Shader Pipeline

Shared module: `core/client/src/gpu_converter.rs`

```
Captured D3D11 texture (any format: BGRA8, RGBA16F/HDR)
  │
  ▼ CopyResource to GPU SRV texture (GPU→GPU, zero-copy)
[GPU texture]
  │
  ▼ D3D11 compute shader dispatch (16×16 threadgroups)
    • HDR→SDR: saturate() tonemap (no-op for SDR input)
    • Downscale: nearest-neighbor to encode resolution
    • R/B swap: HLSL outputs R8G8B8A8_UNORM (hardware UAV constraint)
[BGRA8 texture @ encode resolution]
  │
  ▼ CopyResource to CPU staging texture (~8MB not ~66MB at 4K)
[CPU memory]
  │
  ▼ libyuv BGRA→I420
[I420 frame]
  │
  ▼ NativeVideoSource::capture_frame (Rust LiveKit SDK)
[H264 via NVENC — RTX 4090]
  │
  ▼ RTP → SFU → viewer
```

HLSL shader summary:
```hlsl
Texture2D<float4> src : register(t0);
RWTexture2D<unorm float4> dst : register(u0);
// Nearest-neighbor sample from src, saturate(), write to dst
// Note: UAV uses R8G8B8A8_UNORM — R/B swap done in HLSL
```

## OS-Aware Fallback Chain

Detection runs in JS (`screen-share-native.js`) before starting Tauri IPC capture:

1. Query `get_os_build_number` via Tauri IPC
2. If build ≥ 26100: start `start_screen_share_wgc` (WGC path)
3. Otherwise: start `start_screen_share_dxgi` (DXGI DD path)
4. If Tauri IPC unavailable (browser fallback): use `getDisplayMedia` (browser capture, lower quality)

The JS side always derives the SFU URL from the control URL (`https→wss`) — never connects to port 7880 directly.

## Encoding

- Encoder: NVENC (H264) via webrtc-sys local fork
- Local fork path: `core/webrtc-sys-local/` (fixes missing abseil headers that cause silent NVENC exclusion)
- ContentHint: `fluid` — maps to MAINTAIN_FRAMERATE in libwebrtc, prevents WebRTC from reducing FPS under bitrate pressure
- Simulcast: disabled for screen share; single layer labeled `f` (HIGH RID) so SFU allocates full bandwidth
- Non-simulcast bug fixed: `VIDEO_RIDS[0]` was `'q'` (LOW) — changed to `'f'` (HIGH) in `core/livekit-local/`

## Performance Numbers (RTX 4090, 4K source)

| Scenario | Capture FPS | Viewer FPS |
|----------|------------|------------|
| Desktop (no game) | 100+ | ~60 |
| Light game (Megabonk) | 139 | ~60 |
| Crimson Desert 4K borderless | 45-55 | 45-55 |
| BF6 4K (WGC) | 53 | ~53 |

Capture is limited by the DWM compositor under heavy GPU load, not by the pipeline.

## Archived Methods

Dead methods live in `core/client/src/archive/`. Not compiled into the binary.

| Method | File | Why Dead |
|--------|------|----------|
| NVFBC | `archive/nvfbc_capture.rs` | Blocked by NVIDIA driver 595.79 on GeForce. Also compositor-bound on Windows — no advantage over DXGI DD. |
| Present() hook | `archive/hook/`, `archive/game_capture.rs`, `archive/injector.rs` | Fails with DLSS Frame Generation — swap chain buffers arrive empty/garbled. Not fixable. |
| Control block client | `archive/control_block_client.rs` | Superseded by direct IPC approach. |

See `core/client/src/archive/README.md` for details.
