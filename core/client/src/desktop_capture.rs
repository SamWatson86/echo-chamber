//! DXGI Desktop Duplication capture + LiveKit publishing.
//!
//! Captures the DWM compositor output — works with every game in
//! windowed/borderless mode regardless of DX11/DX12/Vulkan, DLSS FG,
//! HDR, anti-cheat. The compositor always composites the final frame.
//!
//! Pipeline (GPU-accelerated):
//!   DXGI OutputDuplication (compositor → D3D11 texture, zero-copy)
//!     → CopyResource to GPU texture (GPU→GPU, keeps format)
//!       → D3D11 compute shader: HDR→SDR + downscale (GPU, <1ms)
//!         → CopyResource to small staging (GPU→CPU, ~8MB not 66MB)
//!           → libyuv BGRA→I420
//!             → NativeVideoSource::capture_frame
//!               → libwebrtc H264 encoder (NVENC on RTX 4090)
//!                 → RTP → SFU

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tauri::Emitter;

use windows::core::{Interface, PCSTR};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11_USAGE_DEFAULT, D3D11_CPU_ACCESS_READ,
    ID3D11Device, ID3D11Texture2D,
};
use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1,
    IDXGIOutputDuplication, IDXGIResource, DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, GetWindowThreadProcessId,
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, SetWindowPos,
    SetLayeredWindowAttributes,
    WNDCLASSEXW, WS_POPUP, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_EX_LAYERED,
    WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE, HWND_TOPMOST,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    LWA_ALPHA,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};

use crate::capture_pipeline::CapturePublisher;

// ── GPU HDR→SDR Conversion Pipeline (shared module) ──

use crate::gpu_converter::GpuConverter;

// ── Global State ──

struct DesktopShareHandle {
    running: Arc<AtomicBool>,
}

fn global_state() -> &'static Mutex<Option<DesktopShareHandle>> {
    static STATE: OnceLock<Mutex<Option<DesktopShareHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

// ── Public API ──

/// Check if DXGI Desktop Duplication is available.
pub fn check_available() -> (bool, String) {
    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(e) => return (false, format!("CreateDXGIFactory1 failed: {e}")),
        };

        let adapter: IDXGIAdapter1 = match factory.EnumAdapters1(0) {
            Ok(a) => a,
            Err(e) => return (false, format!("No adapters: {e}")),
        };

        let output: IDXGIOutput = match adapter.EnumOutputs(0) {
            Ok(o) => o,
            Err(e) => return (false, format!("No outputs: {e}")),
        };

        if let Ok(desc) = output.GetDesc() {
            let name = String::from_utf16_lossy(
                &desc.DeviceName[..desc.DeviceName.iter().position(|&c| c == 0).unwrap_or(desc.DeviceName.len())],
            );
            let r = desc.DesktopCoordinates;
            (true, format!(
                "DXGI DD available: {} ({}x{})",
                name,
                r.right - r.left,
                r.bottom - r.top,
            ))
        } else {
            (true, "DXGI DD available".into())
        }
    }
}

/// Start desktop capture: DXGI duplication → publish to SFU via LiveKit.
///
/// `hwnd` — game window handle (for crop region in windowed mode).
/// `fullscreen` — if true, capture full monitor (no crop).
/// `sfu_url`, `token` — LiveKit SFU connection params ($screen identity).
pub async fn start(
    hwnd: u64,
    fullscreen: bool,
    sfu_url: String,
    token: String,
    app: AppHandle,
) -> Result<(), String> {
    stop();

    let running = Arc::new(AtomicBool::new(true));

    {
        let mut state = global_state().lock().unwrap();
        *state = Some(DesktopShareHandle {
            running: running.clone(),
        });
    }

    // Get game PID for audio capture
    let target_pid = unsafe {
        let mut pid = 0u32;
        let hwnd_val = HWND(hwnd as *mut _);
        GetWindowThreadProcessId(hwnd_val, Some(&mut pid));
        pid
    };

    let _ = app.emit("desktop-capture-started", target_pid);

    let r2 = running.clone();
    tokio::spawn(async move {
        // Run DXGI capture on a blocking thread — it uses COM and blocking waits
        let result = tokio::task::spawn_blocking(move || {
            capture_loop_blocking(&sfu_url, &token, &app, &r2, hwnd, fullscreen)
        })
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?;

        if let Err(e) = result {
            eprintln!("[desktop-capture] error: {e}");
        }

        let mut state = global_state().lock().unwrap();
        *state = None;
        Ok::<(), String>(())
    });

    Ok(())
}

/// Stop the current desktop capture.
pub fn stop() {
    let mut state = global_state().lock().unwrap();
    if let Some(handle) = state.take() {
        handle.running.store(false, Ordering::SeqCst);
        eprintln!("[desktop-capture] stop requested");
    }
}

/// Returns true if a desktop capture is currently running.
pub fn is_running() -> bool {
    global_state().lock().unwrap().is_some()
}

// ── DXGI Desktop Duplication Setup ──

/// Find the DXGI output (monitor) that contains the given window or monitor handle.
///
/// `hwnd_or_hmonitor` — either a window HWND or a monitor HMONITOR.
/// `is_monitor` — if true, treat the value as an HMONITOR directly.
fn find_output_for_window(
    factory: &IDXGIFactory1,
    hwnd_or_hmonitor: u64,
    is_monitor: bool,
) -> Result<(IDXGIAdapter1, IDXGIOutput1, u32, u32), String> {
    let monitor = if is_monitor {
        // Value is already an HMONITOR from the picker
        use windows::Win32::Graphics::Gdi::HMONITOR;
        HMONITOR(hwnd_or_hmonitor as *mut _)
    } else {
        let hwnd_val = HWND(hwnd_or_hmonitor as *mut _);
        unsafe { MonitorFromWindow(hwnd_val, MONITOR_DEFAULTTONEAREST) }
    };

    // Get monitor rect
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
            return Err(format!("GetMonitorInfoW failed (is_monitor={}, handle={})", is_monitor, hwnd_or_hmonitor));
        }
    }
    let mon_w = (mi.rcMonitor.right - mi.rcMonitor.left) as u32;
    let mon_h = (mi.rcMonitor.bottom - mi.rcMonitor.top) as u32;

    // Find matching DXGI output
    let mut adapter_idx = 0u32;
    loop {
        let adapter: IDXGIAdapter1 = unsafe {
            factory
                .EnumAdapters1(adapter_idx)
                .map_err(|_| "No matching adapter found".to_string())?
        };

        let mut output_idx = 0u32;
        loop {
            let output: IDXGIOutput = match unsafe { adapter.EnumOutputs(output_idx) } {
                Ok(o) => o,
                Err(_) => break, // No more outputs on this adapter
            };

            if let Ok(desc) = unsafe { output.GetDesc() } {
                if desc.Monitor == monitor {
                    let output1: IDXGIOutput1 = output
                        .cast()
                        .map_err(|e| format!("cast IDXGIOutput1: {e}"))?;
                    eprintln!(
                        "[desktop-capture] found monitor: adapter={} output={} {}x{}",
                        adapter_idx, output_idx, mon_w, mon_h,
                    );
                    return Ok((adapter, output1, mon_w, mon_h));
                }
            }
            output_idx += 1;
        }
        adapter_idx += 1;
    }
}

/// Get the window rect relative to the monitor.
fn get_window_crop(hwnd: u64) -> Option<(i32, i32, u32, u32)> {
    let hwnd_val = HWND(hwnd as *mut _);
    let mut rect = RECT::default();
    unsafe {
        if GetWindowRect(hwnd_val, &mut rect).is_err() {
            return None;
        }
    }

    // Get the monitor's top-left to make coordinates relative
    let monitor = unsafe { MonitorFromWindow(hwnd_val, MONITOR_DEFAULTTONEAREST) };
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
            return None;
        }
    }

    let x = (rect.left - mi.rcMonitor.left).max(0);
    let y = (rect.top - mi.rcMonitor.top).max(0);
    let w = (rect.right - rect.left).max(1);
    let h = (rect.bottom - rect.top).max(1);

    Some((x, y, w as u32, h as u32))
}

// ── Anti-MPO Overlay ──
//
// Windows 10/11 can bypass DWM compositing for borderless windowed games using
// hardware overlay planes (Multiplane Overlay / Independent Flip). When this
// happens, DXGI Desktop Duplication only captures the DWM back buffer which
// doesn't include the game frames → capture drops to 5-15fps.
//
// Fix: create a 1x1 invisible topmost window. DWM cannot use Independent Flip
// when a topmost window overlaps the game, forcing all frames through the
// compositor. This is the same technique used by ForceComposedFlip.
// Cost: one frame of compositor latency on the host display — irrelevant for streaming.

static ANTI_MPO_CLASS_REGISTERED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

unsafe extern "system" fn anti_mpo_wndproc(
    hwnd: HWND, msg: u32, wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Create a 1x1 invisible topmost window on the given monitor to force DWM Composed Flip.
/// Returns the HWND which must be destroyed when capture stops.
unsafe fn create_anti_mpo_window(monitor_rect: &RECT) -> Option<HWND> {
    // Register window class once
    let hinstance = windows::Win32::Foundation::HINSTANCE(
        GetModuleHandleW(None).unwrap_or_default().0
    );
    if !ANTI_MPO_CLASS_REGISTERED.swap(true, Ordering::SeqCst) {
        let class_name = windows::core::w!("EchoAntiMPO");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(anti_mpo_wndproc),
            lpszClassName: class_name,
            hInstance: hinstance,
            ..Default::default()
        };
        RegisterClassExW(&wc);
    }

    let class_name = windows::core::w!("EchoAntiMPO");
    let ex_style = WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_LAYERED
        | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;

    // Place the 1x1 window at the top-left of the monitor containing the game
    let hwnd = CreateWindowExW(
        ex_style,
        class_name,
        windows::core::w!(""),
        WS_POPUP,
        monitor_rect.left,
        monitor_rect.top,
        1,
        1,
        None,
        None,
        hinstance,
        None,
    );

    if let Ok(hwnd) = hwnd {
        if hwnd.0.is_null() {
            eprintln!("[anti-mpo] CreateWindowExW returned null");
            return None;
        }
        // Make fully transparent
        let _ = SetLayeredWindowAttributes(hwnd, None, 0, LWA_ALPHA);
        // Ensure topmost + visible
        let _ = SetWindowPos(
            hwnd, HWND_TOPMOST,
            0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        eprintln!("[anti-mpo] overlay window created — DWM forced to Composed Flip");
        Some(hwnd)
    } else {
        eprintln!("[anti-mpo] CreateWindowExW failed: {:?}", hwnd.err());
        None
    }
}

/// Reassert topmost status — games can temporarily promote themselves above other windows.
unsafe fn refresh_anti_mpo_window(hwnd: HWND) {
    let _ = SetWindowPos(
        hwnd, HWND_TOPMOST,
        0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
    );
}

// ── Capture Loop ──

fn capture_loop_blocking(
    sfu_url: &str,
    token: &str,
    app: &AppHandle,
    running: &Arc<AtomicBool>,
    hwnd: u64,
    fullscreen: bool,
) -> Result<(), String> {
    eprintln!("[desktop-capture] initializing DXGI Desktop Duplication...");

    // 1. Find the monitor containing the game window
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|e| format!("CreateDXGIFactory1: {e}"))?;

    let (adapter, output1, mon_w, mon_h) = find_output_for_window(&factory, hwnd, fullscreen)?;

    // 1b. Create anti-MPO overlay to force DWM Composed Flip.
    // Without this, borderless windowed games trigger Independent Flip / MPO,
    // causing DXGI DD to capture at 5-15fps instead of the game's native framerate.
    let anti_mpo_hwnd = unsafe {
        let monitor = if fullscreen {
            use windows::Win32::Graphics::Gdi::HMONITOR;
            HMONITOR(hwnd as *mut _)
        } else {
            let hwnd_val = HWND(hwnd as *mut _);
            MonitorFromWindow(hwnd_val, MONITOR_DEFAULTTONEAREST)
        };
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut mi).as_bool() {
            create_anti_mpo_window(&mi.rcMonitor)
        } else {
            eprintln!("[anti-mpo] GetMonitorInfoW failed, skipping overlay");
            None
        }
    };

    // 2. Create D3D11 device on the same adapter
    let adapter_base: windows::Win32::Graphics::Dxgi::IDXGIAdapter = adapter.cast()
        .map_err(|e| format!("cast IDXGIAdapter: {e}"))?;
    let mut device: Option<ID3D11Device> = None;
    unsafe {
        D3D11CreateDevice(
            Some(&adapter_base),
            D3D_DRIVER_TYPE_UNKNOWN,
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None, // feature levels (default)
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
        .map_err(|e| format!("D3D11CreateDevice: {e}"))?;
    }
    let device = device.ok_or("D3D11CreateDevice returned null")?;
    let context = unsafe { device.GetImmediateContext() }
        .map_err(|e| format!("GetImmediateContext: {e}"))?;

    // 3. Create output duplication — as a closure so we can reinit on
    // recoverable stalls (5+ seconds of AcquireNextFrame timeouts from
    // driver hiccups, UAC intrusions, desktop mode flickers, GPU contention
    // during heavy encode load, etc). Prior behavior was to bail the capture
    // loop entirely on 50 consecutive timeouts, which crashed the share.
    // Try IDXGIOutput5::DuplicateOutput1 first — supports HDR formats and
    // captures DirectFlip content that DuplicateOutput misses (black frames).
    let create_duplication = || -> Result<IDXGIOutputDuplication, String> {
        unsafe {
            let output5: Result<windows::Win32::Graphics::Dxgi::IDXGIOutput5, _> = output1.cast();
            if let Ok(out5) = output5 {
                // Request both formats — prefer BGRA (SDR, no conversion needed),
                // accept float16 (HDR) if SDR not available.
                let formats = [
                    DXGI_FORMAT_B8G8R8A8_UNORM,
                    windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R16G16B16A16_FLOAT,
                    windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R10G10B10A2_UNORM,
                ];
                match out5.DuplicateOutput1(&device, 0, &formats) {
                    Ok(dup) => {
                        eprintln!("[desktop-capture] using DuplicateOutput1 (HDR-capable)");
                        return Ok(dup);
                    }
                    Err(e) => {
                        eprintln!("[desktop-capture] DuplicateOutput1 failed: {e}, falling back");
                    }
                }
            } else {
                eprintln!("[desktop-capture] IDXGIOutput5 not available, using DuplicateOutput");
            }
            output1
                .DuplicateOutput(&device)
                .map_err(|e| format!("DuplicateOutput: {e}"))
        }
    };
    let mut duplication: IDXGIOutputDuplication = create_duplication()?;

    // Determine capture dimensions
    let crop = if fullscreen {
        None
    } else {
        get_window_crop(hwnd)
    };

    let (cap_w, cap_h) = match crop {
        Some((_, _, w, h)) => (w, h),
        None => (mon_w, mon_h),
    };

    // Compute encode dimensions — cap at 1920x1080 to avoid NVENC init failures at 4K.
    // Maintain aspect ratio, round to even (H.264 requirement).
    const MAX_ENC_W: u32 = 1920;
    const MAX_ENC_H: u32 = 1080;
    let (enc_w, enc_h) = if cap_w > MAX_ENC_W || cap_h > MAX_ENC_H {
        let scale = (MAX_ENC_W as f64 / cap_w as f64).min(MAX_ENC_H as f64 / cap_h as f64);
        let w = ((cap_w as f64 * scale) as u32) & !1;
        let h = ((cap_h as f64 * scale) as u32) & !1;
        (w, h)
    } else {
        (cap_w & !1, cap_h & !1)
    };
    let needs_downscale = enc_w != cap_w || enc_h != cap_h;

    eprintln!(
        "[desktop-capture] capture: {}x{} → encode: {}x{} (fullscreen={}, crop={:?})",
        cap_w, cap_h, enc_w, enc_h, fullscreen, crop,
    );

    // 4. Connect to LiveKit and publish track via shared pipeline
    let rt = tokio::runtime::Handle::current();
    let mut publisher = CapturePublisher::connect_and_publish_blocking(
        &rt, sfu_url, token, enc_w, enc_h, "desktop-capture",
    )?;

    // 6. Prepare GPU converter (shader pipeline) or CPU fallback
    let mut gpu_converter: Option<GpuConverter> = None;
    // CPU fallback staging (only used if GPU path fails)
    let mut staging: Option<ID3D11Texture2D> = None;
    let mut staging_w = 0u32;
    let mut staging_h = 0u32;
    let mut scale_buf: Vec<u8> = vec![0u8; (enc_w * enc_h * 4) as usize];

    let mut consecutive_timeouts = 0u32;

    eprintln!("[desktop-capture] starting frame loop");

    // 7. Frame loop
    while running.load(Ordering::SeqCst) {
        // Acquire next frame from compositor (blocks up to 100ms)
        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;

        let acquire_result = unsafe {
            duplication.AcquireNextFrame(100, &mut frame_info, &mut resource)
        };

        match acquire_result {
            Err(e) => {
                let code = e.code().0 as u32;
                if code == 0x887A0027 {
                    // DXGI_ERROR_WAIT_TIMEOUT — no new frame, just loop.
                    // 50 consecutive = ~5 seconds of stall (100ms per timeout).
                    // Reinit the duplication interface instead of bailing —
                    // transient stalls are caused by GPU contention under heavy
                    // encode load, driver hiccups, UAC intrusions, display mode
                    // changes, etc. Reinit typically recovers immediately.
                    consecutive_timeouts += 1;
                    if consecutive_timeouts >= 50 {
                        eprintln!(
                            "[desktop-capture] 50 consecutive timeouts (~5s stall) \
                             — reinitializing DXGI Desktop Duplication"
                        );
                        // Drop the old duplication interface before creating a
                        // new one (the old one may be holding a locked frame
                        // we never released due to the error path).
                        drop(duplication);
                        match create_duplication() {
                            Ok(new_dup) => {
                                duplication = new_dup;
                                consecutive_timeouts = 0;
                                eprintln!(
                                    "[desktop-capture] DXGI DD reinit OK, capture continuing"
                                );
                                continue;
                            }
                            Err(err) => {
                                eprintln!(
                                    "[desktop-capture] DXGI DD reinit FAILED: {err} — stopping"
                                );
                                break;
                            }
                        }
                    }
                    continue;
                } else if code == 0x887A0026 {
                    // DXGI_ERROR_ACCESS_LOST — desktop switch, secure desktop
                    // (UAC), display mode change. Recoverable by reinit.
                    eprintln!(
                        "[desktop-capture] access lost (desktop switch/UAC/mode change) \
                         — reinitializing DXGI Desktop Duplication"
                    );
                    drop(duplication);
                    match create_duplication() {
                        Ok(new_dup) => {
                            duplication = new_dup;
                            consecutive_timeouts = 0;
                            eprintln!(
                                "[desktop-capture] DXGI DD reinit OK after access-lost"
                            );
                            continue;
                        }
                        Err(err) => {
                            eprintln!(
                                "[desktop-capture] DXGI DD reinit FAILED after access-lost: {err} — stopping"
                            );
                            break;
                        }
                    }
                } else {
                    eprintln!("[desktop-capture] AcquireNextFrame error: {e}");
                    consecutive_timeouts += 1;
                    if consecutive_timeouts >= 10 {
                        break;
                    }
                    continue;
                }
            }
            Ok(()) => {
                consecutive_timeouts = 0;
            }
        }

        // Skip frames with no visual update
        if frame_info.LastPresentTime == 0 {
            unsafe { duplication.ReleaseFrame().ok(); }
            continue;
        }

        let resource = match resource {
            Some(r) => r,
            None => {
                unsafe { duplication.ReleaseFrame().ok(); }
                continue;
            }
        };

        // Get the frame as a D3D11 texture
        let frame_texture: ID3D11Texture2D = match resource.cast() {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[desktop-capture] cast texture: {e}");
                unsafe { duplication.ReleaseFrame().ok(); }
                continue;
            }
        };

        // Get actual frame dimensions
        let mut frame_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { frame_texture.GetDesc(&mut frame_desc); }
        let frame_w = frame_desc.Width;
        let frame_h = frame_desc.Height;

        // Determine effective output dimensions (may differ from initial if crop changed)
        let current_crop = if fullscreen {
            None
        } else {
            get_window_crop(hwnd)
        };

        let (out_w, out_h) = match current_crop {
            Some((_, _, w, h)) => (w.min(frame_w), h.min(frame_h)),
            None => (frame_w, frame_h),
        };

        if out_w == 0 || out_h == 0 {
            unsafe { duplication.ReleaseFrame().ok(); }
            continue;
        }

        // (Re)create staging texture if dimensions or format changed
        let frame_fmt = frame_desc.Format;
        if staging.is_none() || frame_w != staging_w || frame_h != staging_h {
            staging = create_staging_texture_fmt(&device, frame_w, frame_h, frame_fmt).ok();
            staging_w = frame_w;
            staging_h = frame_h;
            eprintln!("[desktop-capture] staging: {frame_w}x{frame_h} fmt={}", frame_fmt.0);
        }

        let staging_tex = match &staging {
            Some(s) => s,
            None => {
                unsafe { duplication.ReleaseFrame().ok(); }
                continue;
            }
        };

        let is_hdr = frame_fmt == DXGI_FORMAT_R16G16B16A16_FLOAT;

        // Initialize GPU converter on first HDR frame (or when dimensions change)
        if is_hdr && (gpu_converter.is_none()
            || gpu_converter.as_ref().map(|c| c.src_w) != Some(frame_w)
            || gpu_converter.as_ref().map(|c| c.src_h) != Some(frame_h))
        {
            match GpuConverter::new(&device, frame_w, frame_h, frame_fmt, enc_w, enc_h) {
                Ok(c) => {
                    eprintln!("[desktop-capture] GPU converter ready: {}x{} HDR → {}x{} SDR",
                        frame_w, frame_h, enc_w, enc_h);
                    gpu_converter = Some(c);
                }
                Err(e) => {
                    eprintln!("[desktop-capture] GPU converter failed: {e} — using CPU path");
                    gpu_converter = None;
                }
            }
        }

        // Determine crop region
        let (crop_x, crop_y, crop_w, crop_h) = match current_crop {
            Some((cx, cy, cw, ch)) => (
                cx as u32,
                cy as u32,
                cw.min(frame_w.saturating_sub(cx as u32)),
                ch.min(frame_h.saturating_sub(cy as u32)),
            ),
            None => (0, 0, frame_w, frame_h),
        };

        unsafe {
            let dst_stride = enc_w * 4;
            let dst_needed = (dst_stride * enc_h) as usize;

            // === GPU PATH: HDR->SDR + downscale via compute shader ===
            if is_hdr && gpu_converter.is_some() {
                let converter = gpu_converter.as_ref().unwrap();
                match converter.convert(&context, &frame_texture, crop_x, crop_y, crop_w, crop_h) {
                    Ok((bgra_ptr, stride, w, h)) => {
                        duplication.ReleaseFrame().ok();
                        let bgra_data = std::slice::from_raw_parts(bgra_ptr, (stride * h) as usize);
                        publisher.push_frame_strided(bgra_data, stride, w, h);
                        converter.unmap(&context);
                    }
                    Err(e) => {
                        duplication.ReleaseFrame().ok();
                        eprintln!("[desktop-capture] GPU convert error (frame {}): {e}", publisher.frame_count());
                        // Disable GPU path, fall back to CPU next frame
                        gpu_converter = None;
                        continue;
                    }
                }
            } else {
                // === CPU PATH: staging -> map -> convert ===
                if staging.is_none() || frame_w != staging_w || frame_h != staging_h {
                    staging = create_staging_texture_fmt(&device, frame_w, frame_h, frame_fmt).ok();
                    staging_w = frame_w;
                    staging_h = frame_h;
                    eprintln!("[desktop-capture] CPU staging: {frame_w}x{frame_h} fmt={}", frame_fmt.0);
                }
                let staging_tex = match &staging {
                    Some(s) => s,
                    None => { duplication.ReleaseFrame().ok(); continue; }
                };
                context.CopyResource(staging_tex, &frame_texture);
                duplication.ReleaseFrame().ok();

                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                if context.Map(staging_tex, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).is_err() {
                    continue;
                }
                let src_stride = mapped.RowPitch;
                let src_data = std::slice::from_raw_parts(
                    mapped.pData as *const u8, (src_stride * frame_h) as usize,
                );

                if is_hdr {
                    // Fused HDR->SDR + downscale (CPU fallback)
                    let src_ptr = src_data.as_ptr();
                    let dst_ptr = scale_buf.as_mut_ptr();
                    let src_row_stride = src_stride as usize;
                    let ew = enc_w as usize;
                    let eh = enc_h as usize;
                    let sw = crop_w as usize;
                    let sh = crop_h as usize;
                    for dy in 0..eh {
                        let sy_idx = (dy * sh / eh).min(sh - 1);
                        let src_row = src_ptr.add((crop_y as usize + sy_idx) * src_row_stride + crop_x as usize * 8);
                        let dst_row = dst_ptr.add(dy * dst_stride as usize);
                        let src16 = src_row as *const u16;
                        for dx in 0..ew {
                            let sx_idx = (dx * sw / ew).min(sw - 1);
                            let sp = src16.add(sx_idx * 4);
                            let dp = dst_row.add(dx * 4);
                            let r = fast_f16_to_u8(*sp);
                            let g = fast_f16_to_u8(*sp.add(1));
                            let b = fast_f16_to_u8(*sp.add(2));
                            *dp = b;
                            *dp.add(1) = g;
                            *dp.add(2) = r;
                            *dp.add(3) = 255;
                        }
                    }
                } else if needs_downscale {
                    let ew = enc_w as usize;
                    let eh = enc_h as usize;
                    let sw = crop_w as usize;
                    let sh = crop_h as usize;
                    for dy in 0..eh {
                        let sy_idx = (dy * sh / eh).min(sh - 1);
                        let sr = (crop_y as usize + sy_idx) * src_stride as usize + crop_x as usize * 4;
                        let dr = dy * dst_stride as usize;
                        for dx in 0..ew {
                            let sx_idx = (dx * sw / ew).min(sw - 1);
                            scale_buf[dr + dx * 4..dr + dx * 4 + 4]
                                .copy_from_slice(&src_data[sr + sx_idx * 4..sr + sx_idx * 4 + 4]);
                        }
                    }
                } else {
                    for y in 0..enc_h as usize {
                        let src_off = (crop_y as usize + y) * src_stride as usize + crop_x as usize * 4;
                        let dst_off = y * dst_stride as usize;
                        let row_bytes = (enc_w * 4) as usize;
                        scale_buf[dst_off..dst_off + row_bytes]
                            .copy_from_slice(&src_data[src_off..src_off + row_bytes]);
                    }
                }
                context.Unmap(staging_tex, 0);

                publisher.push_frame(&scale_buf[..dst_needed], enc_w, enc_h);
            }
        }

        let frame_count = publisher.frame_count();

        // Reassert anti-MPO overlay topmost status every 60 frames (~1s).
        // Games can temporarily promote themselves above our overlay.
        if frame_count % 60 == 0 {
            if let Some(h) = anti_mpo_hwnd {
                unsafe { refresh_anti_mpo_window(h); }
            }
        }

        // Stats every 60 frames
        if frame_count % 60 == 0 {
            if let Some(fps) = publisher.maybe_emit_stats(
                app, "desktop-capture-stats", "dxgi-dd", enc_w, enc_h, 60,
            ) {
                eprintln!("[desktop-capture] {enc_w}x{enc_h} @ {fps}fps ({frame_count} frames)");
            }
        }
    }

    running.store(false, Ordering::SeqCst);
    eprintln!("[desktop-capture] shutting down, {} frames captured", publisher.frame_count());

    // Destroy anti-MPO overlay -- restore normal DWM flip behavior
    if let Some(h) = anti_mpo_hwnd {
        unsafe { let _ = DestroyWindow(h); }
        eprintln!("[anti-mpo] overlay window destroyed");
    }

    publisher.shutdown_blocking(&rt);
    eprintln!("[desktop-capture] SFU room closed");

    Ok(())
}

/// Fast f16 → clamped u8 [0,255]. Inlined for hot loop performance.
/// Handles the common case (normalized, 0-1 range) without branching.
#[inline(always)]
unsafe fn fast_f16_to_u8(h: u16) -> u8 {
    // f16: 1 sign, 5 exponent, 10 mantissa
    // For SDR output we only care about [0.0, 1.0] range
    let sign = h >> 15;
    if sign != 0 {
        return 0; // negative → 0
    }
    let exp = (h >> 10) & 0x1F;
    if exp == 0 {
        return 0; // subnormal/zero → 0
    }
    if exp >= 15 {
        return 255; // >= 1.0 → 255
    }
    // 0 < value < 1.0: exp in [1..14], bias=15, so actual exp = exp-15 (negative)
    // value = (1 + mantissa/1024) * 2^(exp-15)
    let mantissa = (h & 0x3FF) as u32;
    let frac = 1024 + mantissa; // 1.mantissa in fixed point (11 bits, [1024..2047])
    // Shift to get value * 255: frac * 255 >> (25 - exp)
    // exp=14 → shift=11, exp=13 → shift=12, etc.
    let shift = 25u32.saturating_sub(exp as u32);
    if shift >= 32 {
        return 0;
    }
    let val = (frac * 255) >> shift;
    val.min(255) as u8
}

/// Convert IEEE 754 half-precision float (f16) to f32.
fn half_to_f32(h: u16) -> f32 {
    let sign = ((h >> 15) & 1) as u32;
    let exp = ((h >> 10) & 0x1F) as u32;
    let frac = (h & 0x3FF) as u32;

    if exp == 0 {
        // Subnormal or zero
        if frac == 0 {
            return f32::from_bits(sign << 31);
        }
        // Subnormal: convert to normalized f32
        let mut e = exp as i32;
        let mut f = frac;
        while (f & 0x400) == 0 {
            f <<= 1;
            e -= 1;
        }
        f &= 0x3FF;
        let exp32 = ((127 - 15 + 1) + e) as u32;
        return f32::from_bits((sign << 31) | (exp32 << 23) | (f << 13));
    }
    if exp == 31 {
        // Inf or NaN
        return f32::from_bits((sign << 31) | (0xFF << 23) | (frac << 13));
    }
    // Normalized
    let exp32 = exp + (127 - 15);
    f32::from_bits((sign << 31) | (exp32 << 23) | (frac << 13))
}

/// Create a D3D11 staging texture for CPU readback.
fn create_staging_texture_fmt(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        CPUAccessFlags: 0x20000, // D3D11_CPU_ACCESS_READ
        ..Default::default()
    };

    unsafe {
        let mut texture: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|e| format!("staging texture: {e}"))?;
        texture.ok_or("null staging texture".into())
    }
}
