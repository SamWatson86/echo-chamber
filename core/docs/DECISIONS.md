# Architecture Decisions

## 2026-02-04 — Initial Stack

- **SFU**: LiveKit server. Proven, supports simulcast and adaptive downlink.
- **Control plane**: Rust (axum). Auth, room metadata, admin, file serving.
- **Client**: Tauri native desktop app (Windows primary, macOS stub).
- **Host**: Sam self-hosts on personal PC. SFU + control plane on same machine.
- **Rooms**: Default room = "main". Additional rooms supported.
- **Auth**: Control plane issues LiveKit access tokens (API key/secret via env).
- **TURN**: pion/turn Go binary for NAT traversal.

## 2026-02-xx — Single-Port Architecture

All external traffic through port 9443 (HTTPS + WSS). SFU never exposed directly.

Rationale: simplifies firewall rules, single TLS cert, easier for friends to connect. Control plane proxies WebSocket connections to SFU at `/rtc`/`/sfu`. SFU URL derived from control URL (`https→wss`).

## 2026-03-xx — Capture Strategy: DXGI DD over NVFBC

NVFBC blocked by NVIDIA driver 595.79 on GeForce cards. Wrapper DLL approach attempted and abandoned — driver-level block cannot be bypassed. DXGI Desktop Duplication chosen as primary capture method: works with all games in windowed/borderless, immune to anti-cheat, handles DX11/DX12/Vulkan/DLSS.

## 2026-03-xx — GPU Shader Pipeline

CPU was the bottleneck for HDR→SDR conversion on 4K HDR frames (66MB BGRA per frame at 4K). Moved conversion to D3D11 compute shader. Results: <1ms GPU time, enables staging texture at encode resolution (~8MB, not 66MB).

Constraint discovered: D3D11 UAVs don't support BGRA8 (`DXGI_FORMAT_B8G8R8A8_UNORM`). Must use `R8G8B8A8_UNORM` and swap R/B channels in HLSL.

## 2026-03-xx — Present() Hook: Dead End

Hook DLL injected into game process to intercept `IDXGISwapChain::Present()`. Worked for standard games but completely failed with DLSS Frame Generation — FG uses multiple swap chains and the composited frame never appears on the hooked chain. Buffers arrive empty or garbled across all four DLSS FG channels. Not fixable without NVIDIA SDK access. Archived in `core/client/src/archive/hook/`.

**Do not re-propose Present() hooks.**

## 2026-03-xx — WGC (Windows.Graphics.Capture) Addition

Added WGC as alternative path. WGC captures from the OS compositor, bypasses WebView background throttling. Available on Win11 24H2+ (build 26100+). Used as primary method on qualifying builds; DXGI DD as fallback for Win10/older.

Performance under gaming: WGC hits 53fps BF6 4K, 15fps Crimson Desert 4K focused. Compositor-bound under heavy GPU load, same as DXGI DD.

## 2026-03-xx — NVENC: Local webrtc-sys Fork

webrtc-sys crate silently excludes NVENC when abseil headers are missing. Without NVENC, encoder falls back to OpenH264 (software) — results in ~9fps viewer FPS vs 60fps with NVENC.

Fix: local fork of webrtc-sys at `core/webrtc-sys-local/` with correct header configuration. Declared in `core/Cargo.toml` as path override.

## 2026-03-xx — RID 'q' Bug Fix

LiveKit SDK's `VIDEO_RIDS[0]` was `'q'` (LOW quality). Non-simulcast screen share tracks use index 0, so the SFU received LOW quality label and allocated minimum bandwidth (~700kbps). Fixed in local LiveKit SDK fork (`core/livekit-local/`) — single-layer tracks use `'f'` (HIGH).

## 2026-03-xx — ContentHint=Fluid

WebRTC degrades FPS under bitrate pressure by default (`MAINTAIN_RESOLUTION` mode — reduces FPS to conserve quality). This caused viewer FPS to drop to 10fps even when NVENC was encoding at 45fps. Setting `ContentHint=Fluid` on the video track maps to `MAINTAIN_FRAMERATE` in peer_connection_factory, which prevents WebRTC from ever reducing FPS. Fixed in `core/livekit-local/`.

## 2026-04-xx — Audio Pipeline: startNativeAudioCapture() vs Raw IPC

Bug: calling `tauriInvoke('start_audio_capture', { pid })` directly bypassed the event listener setup and AudioWorklet initialization. Audio was captured in Rust but nobody was consuming the `audio-chunk` events. Fixed: all audio capture must go through `startNativeAudioCapture()` which sets up the full pipeline in order before starting Rust-side capture.

## 2026-04-xx — Archive vs Delete Strategy

Dead capture methods (NVFBC, Present hook, related injector/hook code) were archived in `core/client/src/archive/` rather than deleted from git. Rationale: these contain non-trivial investigation work and post-mortems that may be useful as reference. The archive is excluded from compilation — it does not affect binary size or build time.

## 2026-04-xx — OS Fallback Approach

Two capture methods available: WGC (Win11 24H2+) and DXGI DD (all Windows). Decision: detect OS build number at runtime via Tauri IPC (`get_os_build_number`) and select the appropriate method in JS. No compile-time selection. If build detection fails, assume WGC is supported and let the Rust side return an error naturally, triggering DXGI DD fallback.

## 2026-04-xx — Hardening Initiative (Phase 7)

Control plane split from monolithic `main.rs` into 9 focused modules. Viewer JS split: `screen-share.js` → 5 files, `participants.js` → 4 files. Dead capture code moved to `archive/`. Documentation rewritten from scratch.

Rationale: ~9200-line `app.js` and monolithic control plane were hitting token limits in AI-assisted development, causing incomplete reads and missed context. Smaller modules enable focused edits and better test coverage.
