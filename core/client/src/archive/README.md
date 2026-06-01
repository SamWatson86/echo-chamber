# Archived Capture Methods

This folder is reference-only. These modules are not production capture paths,
must not be imported by active code, and must not be used as templates for new
capture work without a fresh design review from Sam.

Active production capture lives in:

- `core/client/src/screen_capture.rs` - WGC window/game capture
- `core/client/src/desktop_capture.rs` - DXGI Desktop Duplication monitor and
  fallback capture
- `core/client/src/capture_pipeline.rs` - shared LiveKit publisher

## nvfbc_capture.rs - NVIDIA FrameBuffer Capture

**What:** Captured GPU scanout buffer via NvFBC API.

**Why abandoned:** GeForce driver 595.79+ blocks NvFBC on consumer GPUs. Wrapper
DLL attempts were detected and blocked by the driver. On Windows it was also
still compositor-bound when working.

**Revival condition:** NVIDIA officially supports NvFBC on consumer GPUs, and
Sam explicitly asks for a fresh capture design.

## game_capture.rs + injector.rs + control_block_client.rs - Present Hook

**What:** Injected `echo_game_hook.dll` into a game process, hooked DirectX
`Present()`, and captured frames through a shared D3D11 texture with keyed mutex
synchronization.

**Why abandoned:** Failed with DLSS Frame Generation. The DLSS proxy swap chain
sent empty or garbled data across multiple channels. This was not fixable from
Echo's side.

**Revival condition:** Treat as dead unless Sam explicitly asks for a fresh game
capture design. Do not re-propose Present hooks as routine cleanup or bug-fix
work.

## hook/ - echo_game_hook.dll source

**What:** DLL source used by the abandoned Present-hook path.

**Why archived:** Dead without `game_capture.rs` and intentionally excluded from
the active Cargo workspace.
