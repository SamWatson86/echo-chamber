# Game Capture Hook DLL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hook IDXGISwapChain::Present() inside game processes to capture frames at native framerate, bypassing the DWM compositor bottleneck that limits WGC to ~5fps under GPU load.

**Architecture:** A Rust cdylib DLL (`echo-capture-hook.dll`) is injected into the game process via CreateRemoteThread+LoadLibraryW. The DLL hooks Present/Present1 using `retour` inline detours, copies each frame's backbuffer to a D3D11 shared texture, and signals the host process via named events. The host reads the shared texture, converts BGRA→I420, and publishes to LiveKit. WGC is retained as fallback for non-game windows and anti-cheat-protected games.

**Tech Stack:** Rust, `retour` 0.3 (inline function hooking), `windows` 0.58 (D3D11/DXGI/Win32), LiveKit Rust SDK 0.7, Tauri 2

**Spec:** `docs/superpowers/specs/2026-04-02-game-capture-hook-design.md`

---

## File Structure

### New crate: `core/capture-hook/`

| File | Responsibility | Est. lines |
|------|---------------|-----------|
| `Cargo.toml` | cdylib crate config, retour + windows deps | 30 |
| `src/lib.rs` | DllMain entry, init thread orchestration, shutdown | 80 |
| `src/ipc.rs` | SharedCaptureData struct, named shared memory, named events | 90 |
| `src/hook.rs` | Dummy swapchain vtable discovery, retour static detours | 130 |
| `src/capture.rs` | D3D11 shared texture creation, backbuffer copy, DX12 bridge | 160 |

### Modified in `core/client/src/`

| File | Responsibility | Est. lines |
|------|---------------|-----------|
| `screen_capture.rs` | Public API (list/start/stop), capture method decision, stats | 180 |
| `hook_capture.rs` (NEW) | DLL injection, shared texture reader, frame receive loop | 160 |
| `wgc_capture.rs` (NEW) | Extracted WGC pipeline (moved from screen_capture.rs) | 170 |
| `anticheat.rs` (NEW) | Process/module/driver anti-cheat detection | 100 |

### Config changes

| File | Change |
|------|--------|
| `core/Cargo.toml` | Add `capture-hook` to workspace members |
| `core/client/Cargo.toml` | Add windows features for injection + process inspection |
| `core/client/tauri.conf.json` | Add DLL as bundled resource |

---

## Phase 1: Hook DLL (MVP — DX11)

### Task 1: Scaffold capture-hook crate

**Files:**
- Create: `core/capture-hook/Cargo.toml`
- Create: `core/capture-hook/src/lib.rs`
- Modify: `core/Cargo.toml`

- [ ] **Step 1: Create Cargo.toml**

```toml
# core/capture-hook/Cargo.toml
[package]
name = "echo-capture-hook"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
retour = { version = "0.3", features = ["static-detour"] }
windows-core = "0.58"

[dependencies.windows]
version = "0.58"
features = [
    "Win32_Foundation",
    "Win32_Graphics_Dxgi",
    "Win32_Graphics_Dxgi_Common",
    "Win32_Graphics_Direct3D",
    "Win32_Graphics_Direct3D11",
    "Win32_System_Threading",
    "Win32_System_Memory",
    "Win32_System_LibraryLoader",
    "Win32_UI_WindowsAndMessaging",
    "Win32_System_SystemServices",
]
```

- [ ] **Step 2: Create lib.rs skeleton**

```rust
// core/capture-hook/src/lib.rs
//! Echo Chamber game capture hook DLL.
//! Injected into game processes to hook IDXGISwapChain::Present()
//! and copy frames to a cross-process shared D3D11 texture.

mod ipc;
mod hook;
mod capture;

use std::ffi::c_void;
use windows::Win32::Foundation::{BOOL, HINSTANCE, TRUE};
use windows::Win32::System::SystemServices::{DLL_PROCESS_ATTACH, DLL_PROCESS_DETACH};

#[no_mangle]
unsafe extern "system" fn DllMain(
    _hinst: HINSTANCE,
    reason: u32,
    _reserved: *mut c_void,
) -> BOOL {
    match reason {
        DLL_PROCESS_ATTACH => {
            // Spawn init on a new thread to avoid loader lock deadlocks.
            // DllMain runs under the loader lock — calling LoadLibrary, COM init,
            // or waiting on threads from here would deadlock.
            std::thread::spawn(|| {
                if let Err(e) = init() {
                    log(&format!("init failed: {:?}", e));
                }
            });
        }
        DLL_PROCESS_DETACH => {
            // Hooks are cleaned up by the init thread's shutdown path.
            // Nothing to do here — avoid loader-lock-sensitive work.
        }
        _ => {}
    }
    TRUE
}

fn init() -> Result<(), Box<dyn std::error::Error>> {
    log("echo-capture-hook loaded, initializing...");
    // Implemented in Task 6 after all modules are ready
    Ok(())
}

/// Debug logging via OutputDebugString (visible in DebugView / VS Output).
fn log(msg: &str) {
    let wide: Vec<u16> = format!("[echo-hook] {}\0", msg).encode_utf16().collect();
    unsafe {
        windows::Win32::System::Diagnostics::Debug::OutputDebugStringW(
            windows::core::PCWSTR(wide.as_ptr()),
        );
    }
}
```

- [ ] **Step 3: Add OutputDebugString feature to Cargo.toml**

Add this feature to the `[dependencies.windows]` features list in `core/capture-hook/Cargo.toml`:

```
"Win32_System_Diagnostics_Debug",
```

- [ ] **Step 4: Add capture-hook to workspace**

In `core/Cargo.toml`, change `members` to:

```toml
[workspace]
members = [
  "control",
  "client",
  "admin-client",
  "capture-hook"
]
default-members = [
  "control",
  "client"
]
resolver = "2"
```

- [ ] **Step 5: Verify it compiles**

Run: `cd core && cargo build -p echo-capture-hook`
Expected: Compiles successfully, produces `core/target/debug/echo_capture_hook.dll`

- [ ] **Step 6: Commit**

```bash
git add core/capture-hook/ core/Cargo.toml
git commit -m "feat: scaffold capture-hook crate (cdylib DLL skeleton)"
```

---

### Task 2: IPC module — shared memory + events

**Files:**
- Create: `core/capture-hook/src/ipc.rs`

- [ ] **Step 1: Write the SharedCaptureData struct and constants**

```rust
// core/capture-hook/src/ipc.rs
//! Cross-process IPC via named shared memory and named events.
//! Host creates these objects before injecting the DLL.
//! DLL opens them on init and writes frame metadata + shared texture handle.

use std::ffi::c_void;
use windows::Win32::Foundation::*;
use windows::Win32::System::Memory::*;
use windows::Win32::System::Threading::*;
use windows::core::*;

pub const CAPTURE_MAGIC: u32 = 0xEC40_CA9E;
pub const CAPTURE_VERSION: u32 = 1;

/// Layout of the shared memory region. Must match exactly on both sides.
/// All fields are little-endian (x86/x64 native).
#[repr(C)]
#[derive(Debug)]
pub struct SharedCaptureData {
    pub magic: u32,
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub format: u32,          // DXGI_FORMAT value
    pub frame_count: u64,
    pub shared_handle: u64,   // D3D11 shared texture HANDLE (cast to u64)
    pub dx_version: u32,      // 11 or 12
    pub hook_alive: u32,      // set to 1 when hook is ready
}

/// Named IPC object names. `{pid}` is the target game's process ID.
pub fn shm_name(pid: u32) -> String {
    format!("Local\\EchoChamberCapture_{}", pid)
}

pub fn frame_event_name(pid: u32) -> String {
    format!("Local\\EchoChamberFrame_{}", pid)
}

pub fn stop_event_name(pid: u32) -> String {
    format!("Local\\EchoChamberStop_{}", pid)
}
```

- [ ] **Step 2: Add DLL-side open functions**

Append to `core/capture-hook/src/ipc.rs`:

```rust
/// Handles held by the DLL after opening host-created IPC objects.
pub struct DllIpcHandles {
    pub data: *mut SharedCaptureData,
    pub frame_event: HANDLE,
    pub stop_event: HANDLE,
    _mapping: HANDLE,
}

impl DllIpcHandles {
    /// Open the shared memory + events created by the host process.
    /// Called from the DLL's init thread after injection.
    pub unsafe fn open() -> Result<Self> {
        let pid = std::process::id();

        // Open named shared memory (host already created it)
        let shm = shm_name(pid);
        let shm_wide: Vec<u16> = shm.encode_utf16().chain(std::iter::once(0)).collect();
        let mapping = OpenFileMappingW(
            FILE_MAP_ALL_ACCESS.0,
            false,
            PCWSTR(shm_wide.as_ptr()),
        )?;

        let ptr = MapViewOfFile(
            mapping,
            FILE_MAP_ALL_ACCESS,
            0,
            0,
            std::mem::size_of::<SharedCaptureData>(),
        );
        if ptr.Value.is_null() {
            return Err(Error::from_win32());
        }
        let data = ptr.Value as *mut SharedCaptureData;

        // Validate magic
        if (*data).magic != CAPTURE_MAGIC {
            return Err(Error::new(E_FAIL, "bad magic in shared memory"));
        }

        // Open named events
        let frame_name: Vec<u16> = frame_event_name(pid)
            .encode_utf16().chain(std::iter::once(0)).collect();
        let frame_event = OpenEventW(
            SYNCHRONIZATION_ACCESS_RIGHTS(0x1F0003), // EVENT_ALL_ACCESS
            false,
            PCWSTR(frame_name.as_ptr()),
        )?;

        let stop_name: Vec<u16> = stop_event_name(pid)
            .encode_utf16().chain(std::iter::once(0)).collect();
        let stop_event = OpenEventW(
            SYNCHRONIZATION_ACCESS_RIGHTS(0x1F0003),
            false,
            PCWSTR(stop_name.as_ptr()),
        )?;

        Ok(Self {
            data,
            frame_event,
            stop_event,
            _mapping: mapping,
        })
    }

    /// Signal that a new frame is ready for the host to read.
    pub unsafe fn signal_frame(&self) {
        let _ = SetEvent(self.frame_event);
    }

    /// Check if the host has requested shutdown (non-blocking).
    pub unsafe fn should_stop(&self) -> bool {
        WaitForSingleObject(self.stop_event, 0) == WAIT_OBJECT_0
    }
}

impl Drop for DllIpcHandles {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.data as *mut c_void });
            let _ = CloseHandle(self._mapping);
            let _ = CloseHandle(self.frame_event);
            let _ = CloseHandle(self.stop_event);
        }
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd core && cargo build -p echo-capture-hook`
Expected: Compiles. Warnings about unused imports are fine at this stage.

- [ ] **Step 4: Commit**

```bash
git add core/capture-hook/src/ipc.rs
git commit -m "feat(capture-hook): IPC module — shared memory struct + named events"
```

---

### Task 3: Hook module — find Present + install detours

**Files:**
- Create: `core/capture-hook/src/hook.rs`

- [ ] **Step 1: Write vtable discovery function**

```rust
// core/capture-hook/src/hook.rs
//! Discover IDXGISwapChain::Present vtable address via a dummy swapchain,
//! then install inline hooks using retour.

use std::ffi::c_void;
use retour::static_detour;
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::UI::WindowsAndMessaging::*;

/// Function signature for IDXGISwapChain::Present (COM calling convention).
/// this, SyncInterval, Flags -> HRESULT
type PresentFn = unsafe extern "system" fn(*mut c_void, u32, u32) -> i32;

/// Function signature for IDXGISwapChain1::Present1.
/// this, SyncInterval, PresentFlags, *const DXGI_PRESENT_PARAMETERS -> HRESULT
type Present1Fn = unsafe extern "system" fn(*mut c_void, u32, u32, *const c_void) -> i32;

static_detour! {
    static HookPresent: unsafe extern "system" fn(*mut c_void, u32, u32) -> i32;
    static HookPresent1: unsafe extern "system" fn(*mut c_void, u32, u32, *const c_void) -> i32;
}

/// Raw function pointer addresses for Present (vtable[8]) and Present1 (vtable[22]).
pub struct PresentAddresses {
    pub present: PresentFn,
    pub present1: Present1Fn,
}

/// Create a throwaway D3D11 device + swapchain to read the vtable.
pub unsafe fn find_present_addresses() -> Result<PresentAddresses> {
    // Hidden window for the dummy swapchain
    let class_name = w!("EchoHookDummy");
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(DefWindowProcW),
        lpszClassName: class_name,
        ..std::mem::zeroed()
    };
    RegisterClassExW(&wc);

    let hwnd = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        class_name,
        w!(""),
        WS_OVERLAPPED,
        0, 0, 1, 1,
        None, None, None, None,
    )?;

    let swap_desc = DXGI_SWAP_CHAIN_DESC {
        BufferCount: 1,
        BufferDesc: DXGI_MODE_DESC {
            Width: 1,
            Height: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            ..std::mem::zeroed()
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        OutputWindow: hwnd,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Windowed: TRUE,
        SwapEffect: DXGI_SWAP_EFFECT_DISCARD,
        ..std::mem::zeroed()
    };

    let mut device = None;
    let mut swapchain = None;

    D3D11CreateDeviceAndSwapChain(
        None,                              // adapter (default)
        D3D_DRIVER_TYPE_HARDWARE,
        None,                              // software module
        D3D11_CREATE_DEVICE_FLAG(0),
        None,                              // feature levels (default)
        D3D11_SDK_VERSION,
        Some(&swap_desc),
        Some(&mut swapchain),
        Some(&mut device),
        None,
        None,
    )?;

    let swapchain = swapchain.ok_or(Error::new(E_FAIL, "no swapchain"))?;

    // Read the vtable: COM object ptr -> vtable ptr -> function pointers
    let vtable = *(Interface::as_raw(&swapchain) as *const *const usize);
    let present_addr = *vtable.add(8);   // IDXGISwapChain::Present
    let present1_addr = *vtable.add(22); // IDXGISwapChain1::Present1

    // Cleanup dummy objects
    drop(swapchain);
    drop(device);
    let _ = DestroyWindow(hwnd);
    let _ = UnregisterClassW(class_name, None);

    Ok(PresentAddresses {
        present: std::mem::transmute(present_addr),
        present1: std::mem::transmute(present1_addr),
    })
}
```

- [ ] **Step 2: Add hook installation and the detour callbacks**

Append to `core/capture-hook/src/hook.rs`:

```rust
use crate::capture;
use crate::log;

/// Install inline hooks on Present and Present1.
/// Must be called AFTER capture::init_shared_texture() so the capture
/// state is ready before any hooked Present call fires.
pub unsafe fn install(addrs: &PresentAddresses) -> Result<()> {
    HookPresent
        .initialize(addrs.present, hooked_present)?
        .enable()?;
    log("Present hook installed");

    HookPresent1
        .initialize(addrs.present1, hooked_present1)?
        .enable()?;
    log("Present1 hook installed");

    Ok(())
}

/// Remove hooks cleanly. Called before DLL unload.
pub unsafe fn uninstall() {
    let _ = HookPresent.disable();
    let _ = HookPresent1.disable();
    log("hooks removed");
}

/// Our Present detour. Runs inside the game's render thread.
fn hooked_present(this: *mut c_void, sync_interval: u32, flags: u32) -> i32 {
    // Grab the backbuffer and copy to shared texture.
    // This must be fast — we're in the game's Present() call path.
    let swapchain = this as *mut c_void;
    capture::on_present(swapchain);

    // Call the original Present so the game renders normally.
    unsafe { HookPresent.call(this, sync_interval, flags) }
}

/// Our Present1 detour (DXGI 1.1+ path, used by some games).
fn hooked_present1(this: *mut c_void, sync_interval: u32, flags: u32, params: *const c_void) -> i32 {
    let swapchain = this as *mut c_void;
    capture::on_present(swapchain);
    unsafe { HookPresent1.call(this, sync_interval, flags, params) }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd core && cargo build -p echo-capture-hook`
Expected: Compiles (capture::on_present doesn't exist yet — add a stub in capture.rs first).

Create a temporary stub in `core/capture-hook/src/capture.rs`:

```rust
// core/capture-hook/src/capture.rs
// Stub — implemented in Task 4

pub fn on_present(_swapchain: *mut std::ffi::c_void) {}
```

Then build. Expected: success.

- [ ] **Step 4: Commit**

```bash
git add core/capture-hook/src/hook.rs core/capture-hook/src/capture.rs
git commit -m "feat(capture-hook): hook module — vtable discovery + retour detours"
```

---

### Task 4: Capture module — DX11 shared texture + backbuffer copy

**Files:**
- Modify: `core/capture-hook/src/capture.rs` (replace stub)

- [ ] **Step 1: Write capture state and initialization**

Replace `core/capture-hook/src/capture.rs` entirely:

```rust
// core/capture-hook/src/capture.rs
//! Captures the game's backbuffer on each Present() call and copies it
//! to a D3D11 shared texture readable by the host process.

use std::ffi::c_void;
use std::sync::OnceLock;
use std::sync::Mutex;
use windows::core::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Dxgi::Common::*;

use crate::ipc::{self, DllIpcHandles, SharedCaptureData};
use crate::log;

/// State held across Present() calls. Initialized once on first frame.
struct CaptureState {
    /// The game's D3D11 device (obtained from swapchain).
    device: ID3D11Device,
    /// The game's immediate context (for CopyResource).
    context: ID3D11DeviceContext,
    /// Shared texture (created on the game's device with MISC_SHARED).
    shared_texture: ID3D11Texture2D,
    /// IPC handles (shared memory + events).
    ipc: DllIpcHandles,
    /// Current texture dimensions (recreate if game resizes).
    width: u32,
    height: u32,
}

static STATE: OnceLock<Mutex<Option<CaptureState>>> = OnceLock::new();

/// Called from lib.rs init to set up IPC. The actual D3D11 state is
/// lazily initialized on the first Present() call, because we need
/// the game's swapchain to get its device.
pub fn init_ipc() -> Result<()> {
    let ipc = unsafe { DllIpcHandles::open()? };
    STATE.get_or_init(|| Mutex::new(None));
    // Store IPC handles temporarily — full state is built on first present
    // We use a separate OnceLock for the IPC to avoid chicken-and-egg
    IPC_HANDLES.get_or_init(|| Mutex::new(Some(ipc)));
    Ok(())
}

static IPC_HANDLES: OnceLock<Mutex<Option<DllIpcHandles>>> = OnceLock::new();

/// Called from the hooked Present/Present1. Must be fast.
pub fn on_present(swapchain_ptr: *mut c_void) {
    // Safety: called from the game's render thread with valid swapchain
    if let Err(e) = unsafe { on_present_inner(swapchain_ptr) } {
        // Log once, don't spam
        static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            log(&format!("capture error: {:?}", e));
        }
    }
}

unsafe fn on_present_inner(swapchain_ptr: *mut c_void) -> Result<()> {
    let state_lock = STATE.get_or_init(|| Mutex::new(None));
    let mut state_guard = state_lock.lock().map_err(|_| Error::new(E_FAIL, "lock"))?;

    // Recover the IDXGISwapChain from raw pointer
    let swapchain: IDXGISwapChain = IDXGISwapChain::from_raw_borrowed(&swapchain_ptr)
        .ok_or(Error::new(E_FAIL, "bad swapchain ptr"))?
        .clone();

    // Get the backbuffer
    let backbuffer: ID3D11Texture2D = swapchain.GetBuffer(0)?;

    let mut desc = D3D11_TEXTURE2D_DESC::default();
    backbuffer.GetDesc(&mut desc);

    // Lazy init or resize
    let need_init = match &*state_guard {
        None => true,
        Some(s) => s.width != desc.Width || s.height != desc.Height,
    };

    if need_init {
        let state = init_capture_state(&swapchain, desc.Width, desc.Height, desc.Format)?;
        *state_guard = Some(state);
    }

    let state = state_guard.as_mut().unwrap();

    // Copy backbuffer → shared texture (GPU-side, fast)
    state.context.CopyResource(&state.shared_texture, &backbuffer);

    // Update shared memory metadata
    let data = &mut *state.ipc.data;
    data.frame_count += 1;
    data.hook_alive = 1;

    // Signal host that a new frame is ready
    state.ipc.signal_frame();

    Ok(())
}

/// Create the shared D3D11 texture on the game's device and fill IPC metadata.
unsafe fn init_capture_state(
    swapchain: &IDXGISwapChain,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
) -> Result<CaptureState> {
    log(&format!("init capture: {}x{} format={}", width, height, format.0));

    // Get the game's D3D11 device from the swapchain
    let device: ID3D11Device = swapchain.GetDevice()?;
    let context = device.GetImmediateContext()?;

    // Create shared texture on the game's device
    let tex_desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_FLAG(0),
        CPUAccessFlags: D3D11_CPU_ACCESS_FLAG(0),
        MiscFlags: D3D11_RESOURCE_MISC_SHARED,
    };

    let mut shared_tex: Option<ID3D11Texture2D> = None;
    device.CreateTexture2D(&tex_desc, None, Some(&mut shared_tex))?;
    let shared_tex = shared_tex.unwrap();

    // Get the shared HANDLE for cross-process access
    let dxgi_resource: IDXGIResource = shared_tex.cast()?;
    let shared_handle = dxgi_resource.GetSharedHandle()?;

    // Take IPC handles from the temporary storage
    let mut ipc_lock = IPC_HANDLES.get().unwrap().lock().unwrap();
    let ipc = ipc_lock.take().ok_or(Error::new(E_FAIL, "IPC already taken"))?;

    // Write metadata to shared memory
    let data = &mut *ipc.data;
    data.width = width;
    data.height = height;
    data.format = format.0 as u32;
    data.shared_handle = shared_handle.0 as u64;
    data.dx_version = 11;
    data.hook_alive = 1;

    log(&format!("shared texture ready, handle={:?}", shared_handle));

    Ok(CaptureState {
        device,
        context,
        shared_texture: shared_tex,
        ipc,
        width,
        height,
    })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd core && cargo build -p echo-capture-hook`
Expected: Compiles. May need to adjust exact `windows` crate API signatures if 0.58 differs from what's shown.

- [ ] **Step 3: Commit**

```bash
git add core/capture-hook/src/capture.rs
git commit -m "feat(capture-hook): DX11 capture — shared texture + backbuffer copy"
```

---

### Task 5: Wire up DLL init + shutdown lifecycle

**Files:**
- Modify: `core/capture-hook/src/lib.rs`

- [ ] **Step 1: Implement the init function**

Replace the `init()` function and add `shutdown()` in `core/capture-hook/src/lib.rs`:

```rust
fn init() -> Result<(), Box<dyn std::error::Error>> {
    log("echo-capture-hook loaded, initializing...");

    // 1. Open IPC objects (shared memory + events created by host)
    capture::init_ipc().map_err(|e| format!("IPC open failed: {}", e))?;
    log("IPC opened");

    // 2. Find Present/Present1 addresses via dummy swapchain
    let addrs = unsafe { hook::find_present_addresses() }
        .map_err(|e| format!("vtable discovery failed: {}", e))?;
    log("Present addresses found");

    // 3. Install inline hooks
    unsafe { hook::install(&addrs) }
        .map_err(|e| format!("hook install failed: {}", e))?;
    log("hooks installed — capture active");

    // 4. Wait for stop signal from host
    wait_for_stop();

    // 5. Clean shutdown
    shutdown();

    Ok(())
}

fn wait_for_stop() {
    use windows::Win32::System::Threading::*;

    // Poll the stop event every 100ms. We could also WaitForSingleObject
    // with INFINITE, but polling lets us update the heartbeat.
    loop {
        // Check if IPC handles are still valid (capture state has them)
        // For now, just sleep — the stop event is checked in capture::on_present
        // via ipc.should_stop(). We'll use a simpler approach: check a global flag.
        std::thread::sleep(std::time::Duration::from_millis(100));

        if STOP_REQUESTED.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
    }
}

fn shutdown() {
    log("shutting down...");
    unsafe { hook::uninstall(); }
    log("cleanup complete, DLL ready to unload");
}

/// Global stop flag. Set when the stop event is detected.
static STOP_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Called from capture module when stop event is detected.
pub fn request_stop() {
    STOP_REQUESTED.store(true, std::sync::atomic::Ordering::Relaxed);
}
```

- [ ] **Step 2: Add stop-event check to capture's on_present**

In `core/capture-hook/src/capture.rs`, add a stop check at the top of `on_present_inner`:

```rust
// Add at the top of on_present_inner, before the state lock:
    // Check stop event (non-blocking)
    if let Some(ipc_lock) = IPC_HANDLES.get() {
        if let Ok(guard) = ipc_lock.lock() {
            if let Some(ref ipc) = *guard {
                if ipc.should_stop() {
                    crate::request_stop();
                    return Ok(());
                }
            }
        }
    }
```

Note: after the first frame initializes CaptureState and takes the IPC handles from IPC_HANDLES, this check won't fire. Move the stop check to use the CaptureState's IPC:

After the `let state = state_guard.as_mut().unwrap();` line, before CopyResource:

```rust
    // Check if host wants us to stop
    if state.ipc.should_stop() {
        crate::request_stop();
        return Ok(());
    }
```

- [ ] **Step 3: Verify it compiles**

Run: `cd core && cargo build -p echo-capture-hook`
Expected: Compiles successfully.

- [ ] **Step 4: Commit**

```bash
git add core/capture-hook/src/lib.rs core/capture-hook/src/capture.rs
git commit -m "feat(capture-hook): DLL lifecycle — init, hook, wait for stop, cleanup"
```

---

## Phase 2: Host-Side Integration

### Task 6: Extract WGC pipeline to its own module

**Files:**
- Create: `core/client/src/wgc_capture.rs`
- Modify: `core/client/src/screen_capture.rs`

- [ ] **Step 1: Create wgc_capture.rs with the existing WGC pipeline**

Move the WGC-specific code from `screen_capture.rs` into `core/client/src/wgc_capture.rs`. This is the `windows-capture` based pipeline (lines 171-245 of current screen_capture.rs for the WGC thread, and lines 247-290 for the frame loop).

```rust
// core/client/src/wgc_capture.rs
//! WGC-based screen capture. Used for non-game windows (browsers, Discord, desktop apps)
//! and as fallback when hook injection isn't safe (anti-cheat).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use livekit::prelude::*;
use livekit::webrtc::prelude::*;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::native::yuv_helper;

use crate::screen_capture::ScreenShareStats;

/// Run the WGC capture + LiveKit publish loop.
/// Blocks until `running` is set to false or the WGC source disconnects.
pub async fn run_wgc_capture(
    source_id: u64,
    room: &Room,
    source: &NativeVideoSource,
    app: &AppHandle,
    running: &Arc<AtomicBool>,
) -> Result<(), String> {
    use windows_capture::capture::GraphicsCaptureApiHandler;
    use windows_capture::settings::*;
    use windows_capture::window::Window;

    let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<(Vec<u8>, u32, u32)>(2);
    let capture_running = running.clone();

    // WGC capture thread — COM objects are !Send
    std::thread::spawn(move || {
        struct Handler {
            tx: std::sync::mpsc::SyncSender<(Vec<u8>, u32, u32)>,
            running: Arc<AtomicBool>,
        }

        impl GraphicsCaptureApiHandler for Handler {
            type Flags = (
                std::sync::mpsc::SyncSender<(Vec<u8>, u32, u32)>,
                Arc<AtomicBool>,
            );
            type Error = Box<dyn std::error::Error + Send + Sync>;

            fn new(
                ctx: windows_capture::capture::Context<Self::Flags>,
            ) -> Result<Self, Self::Error> {
                let (tx, running) = ctx.flags;
                Ok(Self { tx, running })
            }

            fn on_frame_arrived(
                &mut self,
                frame: &mut windows_capture::frame::Frame,
                capture_control: windows_capture::graphics_capture_api::InternalCaptureControl,
            ) -> Result<(), Self::Error> {
                if !self.running.load(Ordering::SeqCst) {
                    capture_control.stop();
                    return Ok(());
                }
                let w = frame.width();
                let h = frame.height();
                let mut buffer = frame.buffer()?;
                let data = buffer.as_nopadding_buffer()?.to_vec();
                let _ = self.tx.try_send((data, w, h));
                Ok(())
            }

            fn on_closed(&mut self) -> Result<(), Self::Error> {
                eprintln!("[wgc-capture] closed");
                Ok(())
            }
        }

        let hwnd = source_id as isize;
        let window = unsafe { Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void) };
        let settings = Settings::new(
            window,
            CursorCaptureSettings::Default,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            (frame_tx, capture_running),
        );

        eprintln!("[wgc-capture] starting for HWND {}", source_id);
        match Handler::start_free_threaded(settings) {
            Ok(ctrl) => { let _ = ctrl.wait(); }
            Err(e) => eprintln!("[wgc-capture] start error: {:?}", e),
        }
        eprintln!("[wgc-capture] thread exiting");
    });

    // Frame receive loop: BGRA → I420 → LiveKit
    let mut frame_count: u64 = 0;
    let start_time = std::time::Instant::now();

    while running.load(Ordering::SeqCst) {
        match frame_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok((bgra_data, width, height)) => {
                let mut i420 = I420Buffer::new(width, height);
                let (sy, su, sv) = i420.strides();
                let (y, u, v) = i420.data_mut();
                yuv_helper::argb_to_i420(
                    &bgra_data, width * 4, y, sy, u, su, v, sv,
                    width as i32, height as i32,
                );
                let vf = VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    buffer: i420,
                    timestamp_us: start_time.elapsed().as_micros() as i64,
                };
                source.capture_frame(&vf);
                frame_count += 1;

                if frame_count % 60 == 0 {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let fps = if elapsed > 0.0 { (frame_count as f64 / elapsed) as u32 } else { 0 };
                    let _ = app.emit("screen-capture-stats", ScreenShareStats {
                        fps, width, height,
                        bitrate_kbps: 0,
                        encoder: "NVENC/H264".to_string(),
                        status: "active".to_string(),
                        method: "wgc".to_string(),
                    });
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    Ok(())
}
```

- [ ] **Step 2: Update ScreenShareStats to include method field**

In `core/client/src/screen_capture.rs`, add `method` to the struct:

```rust
#[derive(Serialize, Clone, Debug)]
pub struct ScreenShareStats {
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub bitrate_kbps: u32,
    pub encoder: String,
    pub status: String,
    pub method: String,  // "hook", "wgc", or "hook-fallback-wgc"
}
```

- [ ] **Step 3: Update screen_capture.rs to use wgc_capture module**

Rewrite `core/client/src/screen_capture.rs` to delegate to the WGC module. The LiveKit connection + track publishing stays here (shared between WGC and hook paths):

```rust
// core/client/src/screen_capture.rs
//! Native screen capture — dispatches to hook-based capture (games)
//! or WGC-based capture (non-game windows / anti-cheat fallback).

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
mod wgc_capture;
#[cfg(target_os = "windows")]
mod hook_capture;
#[cfg(target_os = "windows")]
mod anticheat;

// ── Types ──

#[derive(Serialize, Clone, Debug)]
pub struct CaptureSource {
    pub id: u64,
    pub title: String,
    pub is_monitor: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct ScreenShareStats {
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub bitrate_kbps: u32,
    pub encoder: String,
    pub status: String,
    pub method: String,
}

// ── Global State ──

struct ShareHandle {
    running: Arc<AtomicBool>,
}

fn global_state() -> &'static Mutex<Option<ShareHandle>> {
    static STATE: OnceLock<Mutex<Option<ShareHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

// ── Public API ──

pub fn list_sources() -> Vec<CaptureSource> {
    let mut sources = Vec::new();
    match windows_capture::window::Window::enumerate() {
        Ok(windows) => {
            for w in windows {
                if let Ok(title) = w.title() {
                    if title.is_empty() { continue; }
                    sources.push(CaptureSource {
                        id: w.as_raw_hwnd() as u64,
                        title,
                        is_monitor: false,
                    });
                }
            }
        }
        Err(e) => eprintln!("[screen-capture] enumerate error: {}", e),
    }
    sources
}

pub async fn start_share(
    source_id: u64,
    sfu_url: String,
    token: String,
    app: AppHandle,
) -> Result<(), String> {
    stop_share();

    let running = Arc::new(AtomicBool::new(true));
    {
        let mut state = global_state().lock().unwrap();
        *state = Some(ShareHandle { running: running.clone() });
    }

    let r2 = running.clone();
    tokio::spawn(async move {
        if let Err(e) = share_loop(source_id, &sfu_url, &token, &app, &r2).await {
            eprintln!("[screen-capture] error: {}", e);
            let _ = app.emit("screen-capture-error", format!("{}", e));
        }
        let _ = app.emit("screen-capture-stopped", ());
        let mut state = global_state().lock().unwrap();
        *state = None;
    });

    Ok(())
}

pub fn stop_share() {
    let mut state = global_state().lock().unwrap();
    if let Some(handle) = state.take() {
        handle.running.store(false, Ordering::SeqCst);
        eprintln!("[screen-capture] stop requested");
    }
}

// ── Capture dispatch ──

async fn share_loop(
    source_id: u64,
    sfu_url: &str,
    token: &str,
    app: &AppHandle,
    running: &Arc<AtomicBool>,
) -> Result<(), String> {
    use livekit::prelude::*;
    use livekit::webrtc::prelude::*;
    use livekit::webrtc::video_source::native::NativeVideoSource;
    use livekit::options::{TrackPublishOptions, VideoCodec};

    // 1. Connect to LiveKit SFU
    let (room, _events) = Room::connect(sfu_url, token, RoomOptions::default())
        .await
        .map_err(|e| format!("SFU connect failed: {}", e))?;

    // 2. Create video source + track
    let source = NativeVideoSource::new(
        VideoResolution { width: 1920, height: 1080 }, false,
    );
    let track = LocalVideoTrack::create_video_track(
        "screen",
        RtcVideoSource::Native(source.clone()),
    );

    // 3. Publish
    let opts = TrackPublishOptions {
        source: TrackSource::Screenshare,
        video_codec: VideoCodec::H264,
        ..Default::default()
    };
    room.local_participant()
        .publish_track(LocalTrack::Video(track), opts)
        .await
        .map_err(|e| format!("publish failed: {}", e))?;

    let _ = app.emit("screen-capture-started", ());

    // 4. Decide capture method: hook (game) vs WGC (non-game/anti-cheat)
    // For now, always use WGC. Hook path added in Task 9.
    wgc_capture::run_wgc_capture(source_id, &room, &source, app, running).await?;

    running.store(false, Ordering::SeqCst);
    room.close().await.ok();
    Ok(())
}
```

- [ ] **Step 4: Register new modules in main.rs**

No changes needed to `main.rs` — the modules are internal to screen_capture. But `wgc_capture.rs` and `hook_capture.rs` need to be siblings, not children of screen_capture. Update the `mod` declarations.

Actually, since `wgc_capture` uses `windows_capture` crate types and `screen_capture` already conditionally compiles on windows, the module structure should be:

In `core/client/src/main.rs`, the existing `mod screen_capture;` stays. Then `wgc_capture` is a separate module:

```rust
// In main.rs, add after mod screen_capture:
#[cfg(target_os = "windows")]
mod wgc_capture;
#[cfg(target_os = "windows")]
mod hook_capture;
#[cfg(target_os = "windows")]
mod anticheat;
```

And remove the `mod` declarations from inside `screen_capture.rs` — they should be top-level in main.rs.

- [ ] **Step 5: Create empty stubs for hook_capture and anticheat**

```rust
// core/client/src/hook_capture.rs
//! Hook-based game capture via injected DLL. Implemented in Task 8.

// core/client/src/anticheat.rs
//! Anti-cheat detection. Implemented in Task 7.
pub fn has_anticheat(_pid: u32) -> bool { false }
```

- [ ] **Step 6: Verify it compiles**

Run: `cd core && cargo build -p echo-core-client`
Expected: Compiles. Functionally identical to before (still uses WGC for everything).

- [ ] **Step 7: Commit**

```bash
git add core/client/src/wgc_capture.rs core/client/src/hook_capture.rs core/client/src/anticheat.rs core/client/src/screen_capture.rs core/client/src/main.rs
git commit -m "refactor: extract WGC capture to own module, prepare for hook capture"
```

---

### Task 7: Anti-cheat detection

**Files:**
- Modify: `core/client/src/anticheat.rs`
- Modify: `core/client/Cargo.toml` (add windows features)

- [ ] **Step 1: Add required windows features to client Cargo.toml**

In `core/client/Cargo.toml`, add these to the `[target.'cfg(windows)'.dependencies.windows]` features:

```
"Win32_System_ProcessStatus",
"Win32_System_Diagnostics_Debug",
```

- [ ] **Step 2: Implement anti-cheat detection**

Replace `core/client/src/anticheat.rs`:

```rust
// core/client/src/anticheat.rs
//! Detect anti-cheat systems before DLL injection.
//! Three checks: running processes, loaded modules in target, kernel drivers.
//! If ANY check hits, we skip injection and fall back to WGC.

use windows::Win32::Foundation::*;
use windows::Win32::System::ProcessStatus::*;
use windows::Win32::System::Threading::*;

/// Known anti-cheat process names (lowercase for case-insensitive comparison).
const AC_PROCESSES: &[&str] = &[
    "vgk.exe",                  // Vanguard (Valorant)
    "vgtray.exe",               // Vanguard tray
    "easyanticheat.exe",        // EAC
    "easyanticheat_eos.exe",    // EAC (Epic Online Services)
    "beservice.exe",            // BattlEye service
    "atvi-crowdstrike.exe",     // Ricochet (Warzone)
];

/// Known anti-cheat DLLs loaded inside game processes.
const AC_MODULES: &[&str] = &[
    "easyanticheat.dll",
    "beclient.dll",
    "beclient_x64.dll",
];

/// Known anti-cheat kernel drivers.
const AC_DRIVERS: &[&str] = &[
    "vgk.sys",
    "bedaisy.sys",
    "easyanticheat.sys",
];

/// Returns true if anti-cheat is detected for the given game process.
/// Runs all three checks: processes, modules, drivers.
pub fn has_anticheat(target_pid: u32) -> bool {
    if check_processes() {
        eprintln!("[anticheat] anti-cheat process detected");
        return true;
    }
    if check_modules(target_pid) {
        eprintln!("[anticheat] anti-cheat module in target process");
        return true;
    }
    if check_drivers() {
        eprintln!("[anticheat] anti-cheat kernel driver loaded");
        return true;
    }
    false
}

/// Scan running processes for known anti-cheat executables.
fn check_processes() -> bool {
    let mut pids = vec![0u32; 4096];
    let mut bytes_returned = 0u32;
    unsafe {
        if EnumProcesses(pids.as_mut_ptr(), (pids.len() * 4) as u32, &mut bytes_returned).is_err() {
            return false;
        }
    }
    let count = bytes_returned as usize / 4;
    for &pid in &pids[..count] {
        if pid == 0 { continue; }
        if let Some(name) = get_process_name(pid) {
            let lower = name.to_lowercase();
            if AC_PROCESSES.iter().any(|ac| lower.ends_with(ac)) {
                return true;
            }
        }
    }
    false
}

/// Check if target process has anti-cheat DLLs loaded.
fn check_modules(pid: u32) -> bool {
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) {
            Ok(h) => h,
            Err(_) => return false,
        };

        let mut modules = vec![HMODULE::default(); 1024];
        let mut needed = 0u32;
        if EnumProcessModules(
            handle,
            modules.as_mut_ptr(),
            (modules.len() * std::mem::size_of::<HMODULE>()) as u32,
            &mut needed,
        ).is_err() {
            let _ = CloseHandle(handle);
            return false;
        }

        let count = needed as usize / std::mem::size_of::<HMODULE>();
        for &module in &modules[..count] {
            let mut name_buf = [0u16; 260];
            let len = GetModuleFileNameExW(handle, module, &mut name_buf);
            if len > 0 {
                let name = String::from_utf16_lossy(&name_buf[..len as usize]);
                let lower = name.to_lowercase();
                if AC_MODULES.iter().any(|ac| lower.ends_with(ac)) {
                    let _ = CloseHandle(handle);
                    return true;
                }
            }
        }

        let _ = CloseHandle(handle);
    }
    false
}

/// Check for loaded anti-cheat kernel drivers.
fn check_drivers() -> bool {
    unsafe {
        let mut drivers = vec![std::ptr::null_mut::<std::ffi::c_void>(); 2048];
        let mut needed = 0u32;
        if EnumDeviceDrivers(
            drivers.as_mut_ptr(),
            (drivers.len() * std::mem::size_of::<*mut std::ffi::c_void>()) as u32,
            &mut needed,
        ).is_err() {
            return false;
        }

        let count = needed as usize / std::mem::size_of::<*mut std::ffi::c_void>();
        for &driver in &drivers[..count] {
            if driver.is_null() { continue; }
            let mut name_buf = [0u16; 260];
            let len = GetDeviceDriverFileNameW(driver, &mut name_buf);
            if len > 0 {
                let name = String::from_utf16_lossy(&name_buf[..len as usize]);
                let lower = name.to_lowercase();
                if AC_DRIVERS.iter().any(|ac| lower.ends_with(ac)) {
                    return true;
                }
            }
        }
    }
    false
}

/// Get the executable name for a process ID.
fn get_process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid).ok()?;
        let mut module = HMODULE::default();
        let mut needed = 0u32;
        let ok = EnumProcessModules(
            handle,
            &mut module,
            std::mem::size_of::<HMODULE>() as u32,
            &mut needed,
        );
        if ok.is_err() {
            let _ = CloseHandle(handle);
            return None;
        }
        let mut name_buf = [0u16; 260];
        let len = GetModuleFileNameExW(handle, module, &mut name_buf);
        let _ = CloseHandle(handle);
        if len > 0 {
            Some(String::from_utf16_lossy(&name_buf[..len as usize]))
        } else {
            None
        }
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd core && cargo build -p echo-core-client`
Expected: Compiles. `has_anticheat` is available but not yet wired into the capture decision.

- [ ] **Step 4: Commit**

```bash
git add core/client/src/anticheat.rs core/client/Cargo.toml
git commit -m "feat: anti-cheat detection — process, module, and driver scans"
```

---

### Task 8: Host-side DLL injection + shared texture reader

**Files:**
- Modify: `core/client/src/hook_capture.rs`
- Modify: `core/client/Cargo.toml`

- [ ] **Step 1: Add windows features for injection**

In `core/client/Cargo.toml`, add to the windows features:

```
"Win32_System_Memory",
"Win32_System_LibraryLoader",
"Win32_System_Diagnostics_Debug",
"Win32_Graphics_Direct3D",
"Win32_Graphics_Direct3D11",
"Win32_Graphics_Dxgi",
"Win32_Graphics_Dxgi_Common",
```

- [ ] **Step 2: Implement DLL injection + shared texture reader**

Replace `core/client/src/hook_capture.rs`:

```rust
// core/client/src/hook_capture.rs
//! Host-side game capture: inject hook DLL into game process,
//! read frames from D3D11 shared texture, push to LiveKit.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::System::Memory::*;
use windows::Win32::System::Threading::*;
use windows::Win32::System::LibraryLoader::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use livekit::prelude::*;
use livekit::webrtc::prelude::*;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::native::yuv_helper;

use crate::screen_capture::ScreenShareStats;

// Re-use the same IPC struct layout as the hook DLL.
// Must match core/capture-hook/src/ipc.rs exactly.
const CAPTURE_MAGIC: u32 = 0xEC40_CA9E;

#[repr(C)]
struct SharedCaptureData {
    magic: u32,
    version: u32,
    width: u32,
    height: u32,
    format: u32,
    frame_count: u64,
    shared_handle: u64,
    dx_version: u32,
    hook_alive: u32,
}

/// Inject the hook DLL and run the frame capture loop.
/// Returns when `running` is set to false or the hook disconnects.
pub async fn run_hook_capture(
    source_id: u64,
    room: &Room,
    video_source: &NativeVideoSource,
    app: &AppHandle,
    running: &Arc<AtomicBool>,
) -> Result<(), String> {
    // Get game process ID from window handle
    let hwnd = HWND(source_id as *mut c_void);
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return Err("Could not get game process ID".into());
    }
    eprintln!("[hook-capture] target PID: {}", pid);

    // Create IPC objects (shared memory + events)
    let (shm_handle, shm_ptr, frame_event, stop_event) = unsafe {
        create_ipc(pid).map_err(|e| format!("IPC create failed: {}", e))?
    };

    // Inject the hook DLL
    let dll_path = find_hook_dll().map_err(|e| format!("hook DLL not found: {}", e))?;
    eprintln!("[hook-capture] injecting: {}", dll_path);
    unsafe {
        inject_dll(pid, &dll_path).map_err(|e| format!("injection failed: {}", e))?;
    }
    eprintln!("[hook-capture] DLL injected, waiting for hook to initialize...");

    // Wait for hook to write shared_handle (poll shared memory)
    let data = shm_ptr as *const SharedCaptureData;
    let timeout = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if std::time::Instant::now() > timeout {
            return Err("Hook DLL did not initialize within 10 seconds".into());
        }
        unsafe {
            if (*data).hook_alive != 0 && (*data).shared_handle != 0 {
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let (width, height, shared_handle_val) = unsafe {
        ((*data).width, (*data).height, (*data).shared_handle)
    };
    eprintln!("[hook-capture] hook ready: {}x{}, handle=0x{:X}", width, height, shared_handle_val);

    // Open the shared D3D11 texture
    let (device, context, shared_texture) = unsafe {
        open_shared_texture(shared_handle_val)
            .map_err(|e| format!("open shared texture failed: {}", e))?
    };

    // Frame capture loop
    let mut frame_count: u64 = 0;
    let mut last_hook_frame: u64 = 0;
    let start_time = std::time::Instant::now();

    // Create a CPU-readable staging texture for BGRA readback
    let staging = unsafe {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        shared_texture.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = D3D11_BIND_FLAG(0);
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        desc.MiscFlags = D3D11_RESOURCE_MISC_FLAG(0);
        let mut tex: Option<ID3D11Texture2D> = None;
        device.CreateTexture2D(&desc, None, Some(&mut tex))
            .map_err(|e| format!("staging texture: {}", e))?;
        tex.unwrap()
    };

    while running.load(Ordering::SeqCst) {
        // Wait for frame signal from hook DLL (timeout 100ms)
        let wait_result = unsafe { WaitForSingleObject(frame_event, 100) };
        if wait_result != WAIT_OBJECT_0 {
            continue; // timeout, check running flag and retry
        }

        // Check if hook has a new frame
        let hook_frame = unsafe { (*data).frame_count };
        if hook_frame == last_hook_frame {
            continue;
        }
        last_hook_frame = hook_frame;

        // Copy shared texture → staging texture (GPU → CPU-readable)
        unsafe {
            context.CopyResource(&staging, &shared_texture);
        }

        // Map staging texture to read BGRA pixels
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        let map_result = unsafe {
            context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        };
        if map_result.is_err() {
            continue;
        }

        let w = unsafe { (*data).width };
        let h = unsafe { (*data).height };

        // Copy BGRA data (handle stride padding)
        let row_bytes = (w * 4) as usize;
        let mut bgra_data = vec![0u8; row_bytes * h as usize];
        unsafe {
            let src = mapped.pData as *const u8;
            for row in 0..h as usize {
                std::ptr::copy_nonoverlapping(
                    src.add(row * mapped.RowPitch as usize),
                    bgra_data.as_mut_ptr().add(row * row_bytes),
                    row_bytes,
                );
            }
            context.Unmap(&staging, 0);
        }

        // Convert BGRA → I420 and push to LiveKit
        let mut i420 = I420Buffer::new(w, h);
        let (sy, su, sv) = i420.strides();
        let (y, u, v) = i420.data_mut();
        yuv_helper::argb_to_i420(
            &bgra_data, w * 4, y, sy, u, su, v, sv,
            w as i32, h as i32,
        );
        let vf = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            buffer: i420,
            timestamp_us: start_time.elapsed().as_micros() as i64,
        };
        video_source.capture_frame(&vf);
        frame_count += 1;

        if frame_count % 60 == 0 {
            let elapsed = start_time.elapsed().as_secs_f64();
            let fps = if elapsed > 0.0 { (frame_count as f64 / elapsed) as u32 } else { 0 };
            let _ = app.emit("screen-capture-stats", ScreenShareStats {
                fps, width: w, height: h,
                bitrate_kbps: 0,
                encoder: "NVENC/H264".to_string(),
                status: "active".to_string(),
                method: "hook".to_string(),
            });
        }
    }

    // Signal the hook DLL to stop and unload
    unsafe { let _ = SetEvent(stop_event); }
    eprintln!("[hook-capture] stopped, {} frames captured", frame_count);

    // Cleanup
    unsafe {
        let _ = CloseHandle(frame_event);
        let _ = CloseHandle(stop_event);
        let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: shm_ptr });
        let _ = CloseHandle(shm_handle);
    }

    Ok(())
}

// ── Helper functions ──

/// Create named shared memory + events for IPC with the hook DLL.
unsafe fn create_ipc(pid: u32) -> Result<(HANDLE, *mut c_void, HANDLE, HANDLE)> {
    let shm_name = format!("Local\\EchoChamberCapture_{}\0", pid);
    let shm_wide: Vec<u16> = shm_name.encode_utf16().collect();

    let size = std::mem::size_of::<SharedCaptureData>() as u32;
    let mapping = CreateFileMappingW(
        INVALID_HANDLE_VALUE,
        None,
        PAGE_READWRITE,
        0,
        size,
        PCWSTR(shm_wide.as_ptr()),
    )?;

    let ptr = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, size as usize);
    if ptr.Value.is_null() {
        return Err(Error::from_win32());
    }

    // Initialize shared memory with magic + version
    let data = ptr.Value as *mut SharedCaptureData;
    (*data).magic = CAPTURE_MAGIC;
    (*data).version = 1;

    // Create named events
    let frame_name = format!("Local\\EchoChamberFrame_{}\0", pid);
    let frame_wide: Vec<u16> = frame_name.encode_utf16().collect();
    let frame_event = CreateEventW(None, false, false, PCWSTR(frame_wide.as_ptr()))?;

    let stop_name = format!("Local\\EchoChamberStop_{}\0", pid);
    let stop_wide: Vec<u16> = stop_name.encode_utf16().collect();
    let stop_event = CreateEventW(None, true, false, PCWSTR(stop_wide.as_ptr()))?;

    Ok((mapping, ptr.Value, frame_event, stop_event))
}

/// Find the hook DLL path. In dev: target/debug/. In release: resource dir.
fn find_hook_dll() -> Result<String> {
    // Try next to the exe first (release / NSIS install)
    let exe = std::env::current_exe().map_err(|e| Error::new(E_FAIL, e.to_string()))?;
    let exe_dir = exe.parent().unwrap();

    let candidates = [
        exe_dir.join("echo_capture_hook.dll"),
        exe_dir.join("../target/debug/echo_capture_hook.dll"),
    ];

    for path in &candidates {
        if path.exists() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }

    Err(Error::new(E_FAIL, format!(
        "echo_capture_hook.dll not found in {:?}", exe_dir
    )))
}

/// Inject a DLL into the target process via CreateRemoteThread + LoadLibraryW.
unsafe fn inject_dll(pid: u32, dll_path: &str) -> Result<()> {
    let process = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION,
        false,
        pid,
    )?;

    // Convert DLL path to wide string
    let wide_path: Vec<u16> = dll_path.encode_utf16().chain(std::iter::once(0)).collect();
    let path_bytes = wide_path.len() * 2;

    // Allocate memory in the target process for the DLL path
    let remote_mem = VirtualAllocEx(
        process,
        None,
        path_bytes,
        MEM_COMMIT | MEM_RESERVE,
        PAGE_READWRITE,
    );
    if remote_mem.is_null() {
        let _ = CloseHandle(process);
        return Err(Error::from_win32());
    }

    // Write the DLL path to remote memory
    WriteProcessMemory(
        process,
        remote_mem,
        wide_path.as_ptr() as *const c_void,
        path_bytes,
        None,
    )?;

    // Get LoadLibraryW address (same in all processes due to ASLR base of kernel32)
    let kernel32 = GetModuleHandleW(w!("kernel32.dll"))?;
    let load_library = GetProcAddress(kernel32, s!("LoadLibraryW"))
        .ok_or(Error::new(E_FAIL, "LoadLibraryW not found"))?;

    // Create remote thread that calls LoadLibraryW(dll_path)
    let thread = CreateRemoteThread(
        process,
        None,
        0,
        Some(std::mem::transmute(load_library)),
        Some(remote_mem),
        0,
        None,
    )?;

    // Wait for LoadLibraryW to complete (5 second timeout)
    WaitForSingleObject(thread, 5000);

    // Cleanup
    VirtualFreeEx(process, remote_mem, 0, MEM_RELEASE)?;
    let _ = CloseHandle(thread);
    let _ = CloseHandle(process);

    Ok(())
}

/// Create a D3D11 device and open the shared texture handle from the game process.
unsafe fn open_shared_texture(handle_val: u64) -> Result<(ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D)> {
    let mut device = None;
    let mut context = None;
    D3D11CreateDevice(
        None,
        D3D_DRIVER_TYPE_HARDWARE,
        None,
        D3D11_CREATE_DEVICE_FLAG(0),
        None,
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        Some(&mut context),
    )?;

    let device = device.unwrap();
    let context = context.unwrap();

    let shared_handle = HANDLE(handle_val as *mut c_void);
    let texture: ID3D11Texture2D = device.OpenSharedResource(shared_handle)?;

    Ok((device, context, texture))
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd core && cargo build -p echo-core-client`
Expected: Compiles. The hook capture path isn't wired into the decision logic yet.

- [ ] **Step 4: Commit**

```bash
git add core/client/src/hook_capture.rs core/client/Cargo.toml
git commit -m "feat: host-side DLL injection + shared texture frame reader"
```

---

### Task 9: Wire up capture decision logic (hook vs WGC)

**Files:**
- Modify: `core/client/src/screen_capture.rs`

- [ ] **Step 1: Add game detection heuristic**

Add to `core/client/src/screen_capture.rs`, before `share_loop`:

```rust
/// Check if a window belongs to a game process (has D3D/DXGI loaded).
fn is_game_window(hwnd_val: u64) -> bool {
    use windows::Win32::Foundation::*;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::Win32::System::Threading::*;
    use windows::Win32::System::ProcessStatus::*;

    let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 { return false; }

    let game_indicators = ["d3d11.dll", "d3d12.dll", "dxgi.dll", "vulkan-1.dll"];

    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) {
            Ok(h) => h,
            Err(_) => return false,
        };

        let mut modules = vec![HMODULE::default(); 1024];
        let mut needed = 0u32;
        if EnumProcessModules(
            handle,
            modules.as_mut_ptr(),
            (modules.len() * std::mem::size_of::<HMODULE>()) as u32,
            &mut needed,
        ).is_err() {
            let _ = CloseHandle(handle);
            return false;
        }

        let count = needed as usize / std::mem::size_of::<HMODULE>();
        for &module in &modules[..count] {
            let mut name_buf = [0u16; 260];
            let len = GetModuleFileNameExW(handle, module, &mut name_buf);
            if len > 0 {
                let name = String::from_utf16_lossy(&name_buf[..len as usize]).to_lowercase();
                if game_indicators.iter().any(|g| name.ends_with(g)) {
                    let _ = CloseHandle(handle);
                    return true;
                }
            }
        }
        let _ = CloseHandle(handle);
    }
    false
}
```

- [ ] **Step 2: Update share_loop to use capture decision logic**

Replace the capture dispatch section in `share_loop` (the comment "// 4. Decide capture method"):

```rust
    // 4. Decide capture method
    let use_hook = if is_game_window(source_id) {
        let hwnd = HWND(source_id as *mut std::ffi::c_void);
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };

        if anticheat::has_anticheat(pid) {
            eprintln!("[screen-capture] anti-cheat detected for PID {}, using WGC", pid);
            let _ = app.emit("screen-capture-status", "Anti-cheat detected — limited FPS");
            false
        } else {
            eprintln!("[screen-capture] game window detected, using hook capture");
            true
        }
    } else {
        eprintln!("[screen-capture] non-game window, using WGC capture");
        false
    };

    if use_hook {
        match hook_capture::run_hook_capture(source_id, &room, &source, app, running).await {
            Ok(()) => {},
            Err(e) => {
                eprintln!("[screen-capture] hook capture failed: {}, falling back to WGC", e);
                let _ = app.emit("screen-capture-status", "Hook failed — falling back to WGC");
                wgc_capture::run_wgc_capture(source_id, &room, &source, app, running).await?;
            }
        }
    } else {
        wgc_capture::run_wgc_capture(source_id, &room, &source, app, running).await?;
    }
```

- [ ] **Step 3: Add required imports to screen_capture.rs**

Make sure these are imported at the top of `screen_capture.rs`:

```rust
use windows::Win32::Foundation::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::System::Threading::*;
use windows::Win32::System::ProcessStatus::*;
```

- [ ] **Step 4: Verify it compiles**

Run: `cd core && cargo build -p echo-core-client`
Expected: Compiles. The full pipeline is now wired up.

- [ ] **Step 5: Commit**

```bash
git add core/client/src/screen_capture.rs
git commit -m "feat: capture decision logic — hook for games, WGC fallback"
```

---

### Task 10: Build configuration + Tauri bundling

**Files:**
- Modify: `core/client/tauri.conf.json`

- [ ] **Step 1: Add hook DLL as Tauri resource**

In `core/client/tauri.conf.json`, add a `resources` array to the `bundle` object (after `"icon"`):

```json
"resources": [
  "../target/release/echo_capture_hook.dll"
],
```

The full bundle section becomes:

```json
"bundle": {
    "active": true,
    "targets": ["nsis", "dmg"],
    "createUpdaterArtifacts": true,
    "resources": [
      "../target/release/echo_capture_hook.dll"
    ],
    "icon": [
```

- [ ] **Step 2: Build entire workspace**

Run: `cd core && cargo build --workspace`
Expected: Both `echo-core-client` and `echo-capture-hook` compile. The DLL appears at `core/target/debug/echo_capture_hook.dll`.

- [ ] **Step 3: Verify DLL exists and is reasonable size**

Run: `ls -la core/target/debug/echo_capture_hook.dll`
Expected: File exists, size is in the hundreds of KB to low MB range (Rust cdylib with windows crate).

- [ ] **Step 4: Commit**

```bash
git add core/client/tauri.conf.json
git commit -m "chore: bundle capture hook DLL in Tauri resources"
```

---

## Phase 3: DX12 Support

### Task 11: DX12 capture via D3D11On12 bridge

**Files:**
- Modify: `core/capture-hook/Cargo.toml`
- Modify: `core/capture-hook/src/capture.rs`

- [ ] **Step 1: Add DX12 features to capture-hook Cargo.toml**

Add to `core/capture-hook/Cargo.toml` windows features:

```
"Win32_Graphics_Direct3D12",
```

- [ ] **Step 2: Add DX12 detection and D3D11On12 bridge to capture.rs**

In `core/capture-hook/src/capture.rs`, modify `on_present_inner` to detect DX12 and handle it. Replace the section after recovering the swapchain:

```rust
unsafe fn on_present_inner(swapchain_ptr: *mut c_void) -> Result<()> {
    let state_lock = STATE.get_or_init(|| Mutex::new(None));
    let mut state_guard = state_lock.lock().map_err(|_| Error::new(E_FAIL, "lock"))?;

    let swapchain: IDXGISwapChain = IDXGISwapChain::from_raw_borrowed(&swapchain_ptr)
        .ok_or(Error::new(E_FAIL, "bad swapchain ptr"))?
        .clone();

    // Try to get backbuffer as DX11 texture first
    let backbuffer_11: std::result::Result<ID3D11Texture2D, _> = swapchain.GetBuffer(0);

    let (width, height, format) = if let Ok(ref tex) = backbuffer_11 {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        tex.GetDesc(&mut desc);
        (desc.Width, desc.Height, desc.Format)
    } else {
        // DX12 path: get buffer as ID3D12Resource to read dimensions
        use windows::Win32::Graphics::Direct3D12::*;
        let res: ID3D12Resource = swapchain.GetBuffer(0)?;
        let desc = res.GetDesc();
        (desc.Width as u32, desc.Height as u32, desc.Format)
    };

    // Lazy init or resize
    let need_init = match &*state_guard {
        None => true,
        Some(s) => s.width != width || s.height != height,
    };

    if need_init {
        let is_dx12 = backbuffer_11.is_err();
        let state = init_capture_state(&swapchain, width, height, format, is_dx12)?;
        *state_guard = Some(state);
    }

    let state = state_guard.as_mut().unwrap();

    // Check if host wants us to stop
    if state.ipc.should_stop() {
        crate::request_stop();
        return Ok(());
    }

    // Copy backbuffer to shared texture
    if let Ok(ref backbuffer) = backbuffer_11 {
        // DX11: direct copy
        state.context.CopyResource(&state.shared_texture, backbuffer);
    } else if let Some(ref bridge) = state.dx12_bridge {
        // DX12: acquire wrapped resource, copy, release
        use windows::Win32::Graphics::Direct3D12::*;
        let backbuffer_12: ID3D12Resource = swapchain.GetBuffer(0)?;

        let mut wrapped: Option<ID3D11Resource> = None;
        bridge.d3d11on12.CreateWrappedResource(
            &backbuffer_12,
            &D3D11_RESOURCE_FLAGS::default(),
            D3D12_RESOURCE_STATE_COPY_SOURCE,
            D3D12_RESOURCE_STATE_PRESENT,
            &mut wrapped,
        )?;
        let wrapped = wrapped.unwrap();

        bridge.d3d11on12.AcquireWrappedResources(&[Some(wrapped.clone())]);
        state.context.CopyResource(&state.shared_texture, &wrapped);
        bridge.d3d11on12.ReleaseWrappedResources(&[Some(wrapped)]);
        state.context.Flush();
    }

    let data = &mut *state.ipc.data;
    data.frame_count += 1;
    data.hook_alive = 1;
    state.ipc.signal_frame();

    Ok(())
}
```

- [ ] **Step 3: Add Dx12Bridge struct and update CaptureState**

Add to `capture.rs`:

```rust
use windows::Win32::Graphics::Direct3D12::*;

struct Dx12Bridge {
    d3d11on12: ID3D11On12Device,
}

// Update CaptureState:
struct CaptureState {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    shared_texture: ID3D11Texture2D,
    ipc: DllIpcHandles,
    width: u32,
    height: u32,
    dx12_bridge: Option<Dx12Bridge>,
}
```

And update `init_capture_state` to accept `is_dx12: bool`:

```rust
unsafe fn init_capture_state(
    swapchain: &IDXGISwapChain,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
    is_dx12: bool,
) -> Result<CaptureState> {
    log(&format!("init capture: {}x{} format={} dx12={}", width, height, format.0, is_dx12));

    let (device, context, dx12_bridge) = if is_dx12 {
        // Get the DX12 device from the swapchain
        let d3d12_device: ID3D12Device = swapchain.GetDevice()?;

        // Create a command queue for D3D11On12
        let queue_desc = D3D12_COMMAND_QUEUE_DESC {
            Type: D3D12_COMMAND_LIST_TYPE_DIRECT,
            ..std::mem::zeroed()
        };
        let cmd_queue: ID3D12CommandQueue = d3d12_device.CreateCommandQueue(&queue_desc)?;

        // Create D3D11On12 device
        let mut d3d11_device: Option<ID3D11Device> = None;
        let mut d3d11_context: Option<ID3D11DeviceContext> = None;

        D3D11On12CreateDevice(
            &d3d12_device,
            0,
            None,
            Some(&[Some(cmd_queue.cast()?)]),
            0,
            Some(&mut d3d11_device),
            Some(&mut d3d11_context),
            None,
        )?;

        let d3d11_device = d3d11_device.unwrap();
        let d3d11_context = d3d11_context.unwrap();
        let d3d11on12: ID3D11On12Device = d3d11_device.cast()?;

        (d3d11_device, d3d11_context, Some(Dx12Bridge { d3d11on12 }))
    } else {
        // DX11: get device directly from swapchain
        let device: ID3D11Device = swapchain.GetDevice()?;
        let context = device.GetImmediateContext()?;
        (device, context, None)
    };

    // Create shared texture (same for both DX11 and DX12 paths)
    let tex_desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_FLAG(0),
        CPUAccessFlags: D3D11_CPU_ACCESS_FLAG(0),
        MiscFlags: D3D11_RESOURCE_MISC_SHARED,
    };

    let mut shared_tex: Option<ID3D11Texture2D> = None;
    device.CreateTexture2D(&tex_desc, None, Some(&mut shared_tex))?;
    let shared_tex = shared_tex.unwrap();

    let dxgi_resource: IDXGIResource = shared_tex.cast()?;
    let shared_handle = dxgi_resource.GetSharedHandle()?;

    let mut ipc_lock = IPC_HANDLES.get().unwrap().lock().unwrap();
    let ipc = ipc_lock.take().ok_or(Error::new(E_FAIL, "IPC already taken"))?;

    let data = &mut *ipc.data;
    data.width = width;
    data.height = height;
    data.format = format.0 as u32;
    data.shared_handle = shared_handle.0 as u64;
    data.dx_version = if is_dx12 { 12 } else { 11 };
    data.hook_alive = 1;

    log(&format!("shared texture ready, handle={:?}, dx_version={}", shared_handle, data.dx_version));

    Ok(CaptureState {
        device,
        context,
        shared_texture: shared_tex,
        ipc,
        width,
        height,
        dx12_bridge,
    })
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd core && cargo build -p echo-capture-hook`
Expected: Compiles with DX12 support.

- [ ] **Step 5: Commit**

```bash
git add core/capture-hook/src/capture.rs core/capture-hook/Cargo.toml
git commit -m "feat(capture-hook): DX12 support via D3D11On12 bridge"
```

---

## Phase 4: Integration Testing

### Task 12: End-to-end test

**Files:** None (manual testing)

- [ ] **Step 1: Build everything**

Run: `cd core && cargo build --workspace`
Expected: All crates compile. `echo_capture_hook.dll` and `echo-core-client.exe` both exist in `target/debug/`.

- [ ] **Step 2: Verify DLL is findable by client**

The `find_hook_dll()` function looks for the DLL relative to the exe. For dev testing, verify:
- `core/target/debug/echo_capture_hook.dll` exists
- `core/target/debug/echo-core-client.exe` exists

- [ ] **Step 3: Test with a DX11 game (non-anti-cheat)**

1. Launch a DX11 game (e.g., Terraria, Valheim, any indie game)
2. Start the Echo Chamber control plane: `powershell -ExecutionPolicy Bypass -File .\run-core.ps1`
3. Launch the client: `core/target/debug/echo-core-client.exe`
4. Join a room, click "Share Screen", select the game window
5. Check the console output for:
   - `[screen-capture] game window detected, using hook capture`
   - `[hook-capture] target PID: ...`
   - `[hook-capture] DLL injected, waiting for hook to initialize...`
   - `[hook-capture] hook ready: WxH, handle=0x...`
6. Verify the screen share shows in other participants' views
7. Check `capture-stats` events show `method: "hook"` and FPS > 30

- [ ] **Step 4: Test fallback to WGC**

1. Open a non-game window (browser, Discord)
2. Share that window
3. Verify console shows `[screen-capture] non-game window, using WGC capture`
4. Verify the share works at WGC rates (~30fps)

- [ ] **Step 5: Test anti-cheat fallback**

1. If a game with anti-cheat is available, try sharing it
2. Verify console shows `[anticheat] anti-cheat process/module/driver detected`
3. Verify it falls back to WGC with status message

- [ ] **Step 6: Test stop-share cleanup**

1. While hook capture is running, click "Stop Share"
2. Verify the hook DLL unloads cleanly (no game crash)
3. Verify the game continues running normally

- [ ] **Step 7: Commit any fixes**

If any issues are found during testing, fix them and commit:
```bash
git add -A
git commit -m "fix: address issues found during integration testing"
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| Phase 1 | 1-5 | Hook DLL: scaffold, IPC, hooks, DX11 capture, lifecycle |
| Phase 2 | 6-10 | Host: extract WGC, anti-cheat, injection, fallback chain, build config |
| Phase 3 | 11 | DX12 support via D3D11On12 bridge |
| Phase 4 | 12 | End-to-end integration testing |

Total estimated new code: ~560 lines across hook DLL + host integration.
