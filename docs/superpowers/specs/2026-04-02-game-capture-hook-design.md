# Game Capture Hook DLL — Design Spec

**Date:** 2026-04-02
**Status:** Draft
**Component:** Native screen capture pipeline (Tauri client)

## Problem

The current WGC-based screen capture drops to ~5fps when a game has focus because WGC reads from the DWM compositor, which is starved when the GPU is fully utilized by a game. This is a fundamental limitation of WGC — no amount of async staging or encoding optimization fixes it.

## Solution

Hook `IDXGISwapChain::Present()` inside the game process to capture frames at the game's native framerate, before the compositor. Frames are shared cross-process via D3D11 shared textures. WGC is retained as fallback for non-game windows and anti-cheat-protected games.

## Architecture Overview

Two components:

1. **Hook DLL** (`echo-capture-hook.dll`) — injected into the game process. Hooks `Present`/`Present1`, copies each frame's backbuffer to a shared D3D11 texture, signals the host.
2. **Host-side capture** (in `screen_capture.rs`) — injects the DLL, reads shared frames, converts BGRA→I420, publishes to LiveKit via the existing `NativeVideoSource` pipeline.

```
Game Process (hook DLL)                    Host Process (Tauri client)
┌──────────────────────┐                   ┌──────────────────────────────┐
│ Present() called     │                   │ 1. Create shared mem + events│
│   ↓                  │                   │ 2. Inject DLL into game      │
│ Hook fires           │                   │                              │
│   ↓                  │                   │                              │
│ GetBuffer(0)         │                   │                              │
│   ↓                  │                   │                              │
│ CopyResource →       │ ══shared tex══▶   │ 6. Open shared texture       │
│   shared texture     │                   │   ↓                          │
│   ↓                  │                   │ Map → BGRA→I420 → LiveKit   │
│ SetEvent(frame)      │ ──event signal─▶  │ WaitForSingleObject(frame)  │
│   ↓                  │                   │                              │
│ Call real Present()  │                   │                              │
└──────────────────────┘                   └──────────────────────────────┘
```

## Crate Structure

```
core/capture-hook/
├── Cargo.toml              # [lib] crate-type = ["cdylib"]
├── src/
│   ├── lib.rs              # DllMain → spawn init thread (avoids loader lock)
│   ├── hook.rs             # Dummy swapchain → vtable read → retour inline hooks
│   ├── capture.rs          # DX11 backbuffer copy + DX12 via D3D11On12Device
│   └── ipc.rs              # Named shared memory struct + named events
```

Added to workspace: `core/Cargo.toml` → `members = [..., "capture-hook"]`

## Cross-Process IPC

### Shared Memory

Named file mapping: `Local\EchoChamberCapture_{game_pid}`

```rust
#[repr(C)]
struct SharedCaptureData {
    magic: u32,            // 0xEC40CA9E — validation
    version: u32,          // 1 — protocol version
    width: u32,            // frame width
    height: u32,           // frame height
    format: u32,           // DXGI_FORMAT value
    frame_count: u64,      // monotonic, incremented each Present()
    shared_handle: u64,    // HANDLE to D3D11 shared texture (cast to u64)
    dx_version: u32,       // 11 or 12
    hook_alive: u32,       // heartbeat counter for health checks
}
```

### Named Events

- `Local\EchoChamberFrame_{pid}` — DLL signals after copying a frame
- `Local\EchoChamberStop_{pid}` — Host signals DLL to unhook and unload

### Lifecycle

1. Host creates shared memory + both events before injection
2. Host injects DLL via `CreateRemoteThread` + `LoadLibraryW`
3. DLL init thread: create dummy swapchain, read vtable, install hooks, create shared texture, write handle to shared memory, set `hook_alive` to 1
4. Host polls shared memory until `shared_handle != 0` (DLL ready), then opens the shared texture
5. Frame loop: hook fires on each Present → copy → signal → host reads
6. Shutdown: host sets stop event → DLL unhooks → `FreeLibraryAndExitThread`

## Hooking Mechanism

### Finding Present()

1. DLL init thread creates a hidden window + D3D11 device + DXGI swapchain
2. Reads the swapchain's vtable — `Present` at index 8, `Present1` at index 22
3. Saves function pointers, destroys dummy objects
4. Installs inline hooks via `retour` crate on both addresses

### Why Inline Hooking (not vtable patching)

- Vtable patching is per-object — lost if game creates a new swapchain
- Inline hooking patches the function prologue — catches ALL calls globally
- `retour` handles trampolines (preserves original bytes for calling the real function)

### Hooked Present Pseudocode

```
our_present(swapchain, sync_interval, flags):
    backbuffer = swapchain.GetBuffer(0)
    if backbuffer is ID3D11Texture2D:
        context.CopyResource(shared_texture, backbuffer)
    else if backbuffer is ID3D12Resource:
        wrapped = d3d11on12_device.AcquireWrappedResource(backbuffer)
        context.CopyResource(shared_texture, wrapped)
        d3d11on12_device.ReleaseWrappedResource(wrapped)
    shared_mem.frame_count += 1
    SetEvent(frame_event)
    return original_present(swapchain, sync_interval, flags)
```

### DX12 Handling

DX12 games still call `IDXGISwapChain::Present` (DXGI is the common presentation layer). The difference is `GetBuffer(0)` returns `ID3D12Resource`. We handle this by:

1. Detecting DX version via `QueryInterface` on the backbuffer
2. Creating a `D3D11On12Device` inside the game process to wrap DX12 resources as DX11 textures
3. Copying via D3D11 as normal — the shared texture is always D3D11

This means the host process only ever deals with D3D11 shared textures.

## Anti-Cheat Detection

Performed BEFORE injection — never inject into a protected process.

### Three-layer scan

1. **Process scan** — known anti-cheat executables running on the system:
   - `vgk.exe`, `vgtray.exe` (Vanguard)
   - `EasyAntiCheat.exe`, `EasyAntiCheat_EOS.exe` (EAC)
   - `BEService.exe` (BattlEye)
   - `atvi-crowdstrike.exe` (Ricochet)

2. **Module scan** — anti-cheat DLLs loaded in the target game process:
   - `EasyAntiCheat.dll`, `BEClient.dll`, `BEClient_x64.dll`
   - Uses `EnumProcessModules` + `GetModuleFileNameEx`

3. **Kernel driver check** — anti-cheat kernel drivers loaded:
   - `vgk.sys`, `BEDaisy.sys`, `EasyAntiCheat.sys`
   - Uses `EnumDeviceDrivers`

If ANY check hits → skip injection → WGC fallback with user-visible warning.

## Capture Fallback Chain

```
User clicks "Share" on a window
        │
        ▼
  Game window detected? (D3D/DXGI DLLs loaded in target process)
   ├─ No  → WGC capture (30fps, great for browsers/Discord/apps)
   └─ Yes → Anti-cheat detected?
             ├─ Yes → WGC + status: "Limited FPS — anti-cheat detected"
             └─ No  → Inject hook DLL → full framerate capture
```

### Game detection heuristics

- Target process has `d3d11.dll`, `d3d12.dll`, or `dxgi.dll` loaded
- Window style indicates fullscreen or borderless-fullscreen
- User can manually force "game mode" in the capture picker if heuristics miss

## Integration with Existing Code

### screen_capture.rs restructuring

```
screen_capture.rs (~450 lines after changes)
├── list_sources()            — unchanged
├── start_share()             — decides hook vs WGC, dispatches
│   ├── try_hook_capture()    — NEW: inject, read shared texture, feed LiveKit
│   └── start_wgc_capture()   — existing WGC pipeline, extracted to own function
├── stop_share()              — extended: cleanup for both paths
├── detect_anti_cheat()       — NEW
├── inject_hook_dll()         — NEW
└── is_game_window()          — NEW
```

I420 conversion + LiveKit NativeVideoSource publishing is shared between both capture paths.

### IPC commands — unchanged

Same signatures: `list_screen_sources`, `start_screen_share`, `stop_screen_share`. The capture method is transparent to the frontend.

### Stats event — extended

Existing `capture-stats` event adds a `method` field: `"hook"`, `"wgc"`, or `"hook-fallback-wgc"`.

## Build & Bundling

### Cargo workspace

```toml
# core/Cargo.toml
members = ["control", "client", "capture-hook"]
```

### Hook DLL crate

```toml
# core/capture-hook/Cargo.toml
[lib]
crate-type = ["cdylib"]

[dependencies]
retour = { version = "0.4", features = ["static-detour"] }
windows-core = "0.58"

[dependencies.windows]
version = "0.58"
features = [
    "Win32_Foundation",
    "Win32_Graphics_Dxgi",
    "Win32_Graphics_Dxgi_Common",
    "Win32_Graphics_Direct3D",
    "Win32_Graphics_Direct3D11",
    "Win32_Graphics_Direct3D12",
    "Win32_System_Threading",
    "Win32_System_Memory",
    "Win32_System_LibraryLoader",
    "Win32_UI_WindowsAndMessaging",
]
```

### Tauri resource bundling

```json
// core/client/tauri.conf.json
"bundle": {
  "resources": ["../target/release/echo_capture_hook.dll"]
}
```

Runtime: `app.path().resource_dir()` in release, `target/debug/` in dev.

### Build output

- Dev: `core/target/debug/echo_capture_hook.dll`
- Release: `core/target/release/echo_capture_hook.dll` (bundled in NSIS installer)

## Scope Estimate

| Component | Lines (est.) | Description |
|-----------|-------------|-------------|
| `capture-hook` crate | ~400 | DLL: DllMain, hooking, DX11/DX12 capture, IPC |
| `screen_capture.rs` changes | ~150 | Injection, shared texture reader, fallback logic |
| Config files | ~10 | Cargo.toml workspace, tauri.conf.json resources |
| **Total** | **~560** | |

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Anti-cheat bans | Three-layer detection before injection; never inject if any check fails |
| Game crash from bad hook | Robust error handling in hook; DLL cleanup on panic; stop event for graceful unload |
| DX12 games with unusual swapchain setup | D3D11On12 bridge handles the common case; log and fall back to WGC for edge cases |
| Hook DLL not found at runtime | Check file exists before injection; clear error in stats event |
| Game creates multiple swapchains | Inline hooking is global — catches all Present calls on any swapchain |

## Out of Scope

- Vulkan game capture (different API, different hook — future work if needed)
- NVFBC / GPU-level capture (blocked on GeForce consumer cards)
- Anti-cheat whitelist partnerships (requires business relationships)
- OpenGL game capture (negligible market share for modern games)
