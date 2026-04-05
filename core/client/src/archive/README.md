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
