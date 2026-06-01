# Archived Present-Hook DLL

This crate is an abandoned experiment for DirectX `Present()` hooking. It is
intentionally excluded from the active Cargo workspace and is not part of the
production desktop client.

Do not build, import, copy, or revive this crate for routine capture work.

Production capture lives in:

- `core/client/src/screen_capture.rs` for WGC window/game capture
- `core/client/src/desktop_capture.rs` for DXGI Desktop Duplication monitor and
  fallback capture
- `core/client/src/capture_pipeline.rs` for shared LiveKit publishing

The archived copy under `core/client/src/archive/hook/` is the historical
reference paired with the abandoned injector/game-capture code.
