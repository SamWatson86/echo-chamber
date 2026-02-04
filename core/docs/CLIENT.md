# Native Client (Draft)

The Core client is a native desktop app built in Rust with a native UI (no embedded browser).

## Capture + Audio plan
- Windows: Windows Graphics Capture (WGC) + WASAPI loopback for system audio.
- macOS: ScreenCaptureKit + AVFoundation for mic.

## Media transport
- LiveKit native SDK (C++). We will use FFI bindings from Rust.
- This allows 1080p60 capture + simulcast control from the client.

## UI
- Native UI using `egui` (initially) to avoid WebView constraints.
- Later we can evaluate WGPU or another native framework if needed.

## Status
Scaffolding only. Implementation begins after control plane validation.
