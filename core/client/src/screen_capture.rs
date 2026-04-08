//! Native screen capture via Windows.Graphics.Capture (WGC) + LiveKit Rust SDK
//!
//! Bypasses Chromium's getDisplayMedia entirely. WGC runs at the OS level and
//! is immune to WebView background throttling. Frames are BGRA from the GPU,
//! converted to I420 via libyuv, and published directly to the LiveKit SFU
//! through the Rust SDK. H264 encoding uses Media Foundation → NVENC on NVIDIA GPUs.
//!
//! Architecture:
//!   windows-capture (WGC/BGRA @ 60fps)
//!     → argb_to_i420 (libyuv, sub-1ms)
//!       → NativeVideoSource::capture_frame
//!         → libwebrtc H264 encoder (MFT → NVENC)
//!           → RTP → SFU

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use crate::capture_pipeline::CapturePublisher;
use crate::capture_health::{CaptureHealthState, CaptureMode, EncoderType};

// ── Types ──

#[derive(serde::Serialize, Clone, Debug)]
pub struct CaptureSource {
    pub id: u64,
    pub title: String,
    pub is_monitor: bool,
    /// "game", "window", or "monitor"
    pub source_type: String,
    /// Process ID (0 for monitors)
    pub pid: u32,
}

// ── Global State ──

struct ShareHandle {
    running: Arc<AtomicBool>,
}

fn global_state() -> &'static Mutex<Option<ShareHandle>> {
    static STATE: OnceLock<Mutex<Option<ShareHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

// ── Public API (called from Tauri IPC) ──

/// List available capture sources (monitors + windows).
pub fn list_sources() -> Vec<CaptureSource> {
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;

    let mut sources = Vec::new();

    // ── 1. Enumerate monitors ──
    unsafe extern "system" fn monitor_callback(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(lparam.0 as *mut Vec<CaptureSource>);
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmonitor, &mut info as *mut _ as *mut _).as_bool() {
            let device = String::from_utf16_lossy(
                &info.szDevice[..info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len())],
            );
            let idx = monitors.iter().filter(|s| s.is_monitor).count() + 1;
            let title = format!("Monitor {} ({})", idx, device);
            monitors.push(CaptureSource {
                id: hmonitor.0 as u64,
                title,
                is_monitor: true,
                source_type: "monitor".to_string(),
                pid: 0,
            });
        }
        TRUE
    }

    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_callback),
            LPARAM(&mut sources as *mut Vec<CaptureSource> as isize),
        );
    }

    // ── 2. Enumerate windows ──

    // Known non-game executables for classification heuristic
    const NON_GAME_EXES: &[&str] = &[
        "explorer.exe", "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe",
        "opera.exe", "vivaldi.exe", "discord.exe", "slack.exe", "teams.exe",
        "code.exe", "devenv.exe", "rider64.exe", "idea64.exe",
        "notepad.exe", "notepad++.exe", "sublime_text.exe",
        "spotify.exe", "wmplayer.exe", "vlc.exe",
        "powershell.exe", "pwsh.exe", "cmd.exe", "windowsterminal.exe",
        "taskmgr.exe", "mmc.exe", "regedit.exe", "control.exe",
        "outlook.exe", "winword.exe", "excel.exe", "powerpnt.exe",
        "onenote.exe", "thunderbird.exe",
        "filezilla.exe", "putty.exe", "winscp.exe",
        "obs64.exe", "obs.exe", "streamlabs.exe",
        "echo-core-client.exe", "echo-core-control.exe",
        "applicationframehost.exe", "systemsettings.exe",
        "searchhost.exe", "shellexperiencehost.exe",
        "textinputhost.exe", "lockapp.exe",
    ];

    /// Get the executable name for a process ID.
    fn exe_name_for_pid(pid: u32) -> Option<String> {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
        use windows::Win32::Foundation::HMODULE;

        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 260];
            let len = GetModuleFileNameExW(handle, HMODULE::default(), &mut buf);
            let _ = windows::Win32::Foundation::CloseHandle(handle);
            if len == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().map(|s| s.to_lowercase())
        }
    }

    match windows_capture::window::Window::enumerate() {
        Ok(windows) => {
            for w in windows {
                let hwnd = w.as_raw_hwnd() as isize;

                // Filter: must be visible
                let visible = unsafe {
                    IsWindowVisible(windows::Win32::Foundation::HWND(hwnd as *mut _)).as_bool()
                };
                if !visible {
                    continue;
                }

                // Filter: skip tool windows
                let ex_style = unsafe {
                    GetWindowLongW(windows::Win32::Foundation::HWND(hwnd as *mut _), GWL_EXSTYLE)
                } as u32;
                if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
                    continue;
                }

                let title = match w.title() {
                    Ok(t) if !t.is_empty() => t,
                    _ => continue,
                };

                // Get PID
                let mut pid: u32 = 0;
                unsafe {
                    GetWindowThreadProcessId(
                        windows::Win32::Foundation::HWND(hwnd as *mut _),
                        Some(&mut pid),
                    );
                }

                // Classify: game vs window
                let exe = exe_name_for_pid(pid);
                let is_game = match &exe {
                    Some(name) => !NON_GAME_EXES.iter().any(|&known| known == name.as_str()),
                    None => false, // can't determine → default to window
                };

                sources.push(CaptureSource {
                    id: hwnd as u64,
                    title,
                    is_monitor: false,
                    source_type: if is_game { "game".to_string() } else { "window".to_string() },
                    pid,
                });
            }
        }
        Err(e) => eprintln!("[screen-capture] window enumerate error: {}", e),
    }

    sources
}

/// Start native screen sharing: capture window → encode H264 → publish to SFU.
pub async fn start_share(
    source_id: u64,
    sfu_url: String,
    token: String,
    app: AppHandle,
    health: Arc<CaptureHealthState>,
) -> Result<(), String> {
    stop_share();

    let running = Arc::new(AtomicBool::new(true));

    {
        let mut state = global_state().lock().unwrap();
        *state = Some(ShareHandle {
            running: running.clone(),
        });
    }

    let app2 = app.clone();
    let r2 = running.clone();
    tokio::spawn(async move {
        if let Err(e) = share_loop(source_id, &sfu_url, &token, &app2, &r2, health).await {
            eprintln!("[screen-capture] error: {}", e);
            let _ = app2.emit("screen-capture-error", format!("{}", e));
        }
        let _ = app2.emit("screen-capture-stopped", ());
        eprintln!("[screen-capture] task exited");
        let mut state = global_state().lock().unwrap();
        *state = None;
    });

    Ok(())
}

/// Stop the current screen share.
pub fn stop_share() {
    let mut state = global_state().lock().unwrap();
    if let Some(handle) = state.take() {
        handle.running.store(false, Ordering::SeqCst);
        eprintln!("[screen-capture] stop requested");
    }
}

// ── Thumbnail Generation ──

/// Generate a 240x135 thumbnail of a capture source as a base64 BMP data URI.
pub fn get_thumbnail(source_id: u64, is_monitor: bool) -> Option<String> {
    use base64::Engine;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        GetDIBits, GetDC, ReleaseDC, SelectObject, SetStretchBltMode,
        StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HALFTONE, SRCCOPY,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    const THUMB_W: i32 = 240;
    const THUMB_H: i32 = 135;

    unsafe {
        let (src_dc, src_bmp_handle, src_w, src_h) = if is_monitor {
            // Monitor: capture the monitor's region from the screen DC
            use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFOEXW};

            let hmonitor = HMONITOR(source_id as *mut _);
            let mut info: MONITORINFOEXW = std::mem::zeroed();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if !GetMonitorInfoW(hmonitor, &mut info as *mut _ as *mut _).as_bool() {
                eprintln!("[thumbnail] GetMonitorInfoW failed");
                return None;
            }
            let r = info.monitorInfo.rcMonitor;
            let w = r.right - r.left;
            let h = r.bottom - r.top;

            let screen_dc = GetDC(HWND::default());
            if screen_dc.is_invalid() {
                return None;
            }
            let mem_dc = CreateCompatibleDC(screen_dc);
            let src_bmp = CreateCompatibleBitmap(screen_dc, w, h);
            SelectObject(mem_dc, src_bmp);
            BitBlt(mem_dc, 0, 0, w, h, screen_dc, r.left, r.top, SRCCOPY).ok();
            ReleaseDC(HWND::default(), screen_dc);
            // src_bmp is selected into mem_dc, ready for StretchBlt
            (mem_dc, src_bmp, w, h)
        } else {
            // Window: use PrintWindow
            let hwnd = HWND(source_id as *mut _);
            let mut rect = RECT::default();
            if !GetClientRect(hwnd, &mut rect).is_ok() {
                eprintln!("[thumbnail] GetClientRect failed");
                return None;
            }
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            if w <= 0 || h <= 0 {
                return None;
            }

            let wnd_dc = GetDC(hwnd);
            if wnd_dc.is_invalid() {
                return None;
            }
            let mem_dc = CreateCompatibleDC(wnd_dc);
            let src_bmp = CreateCompatibleBitmap(wnd_dc, w, h);
            SelectObject(mem_dc, src_bmp);

            // PrintWindow with PW_RENDERFULLCONTENT (0x2) captures GPU-rendered/DWM-composed
            // content (Chrome, Discord, VSCode, games). Without this flag, PrintWindow only
            // captures GDI content → black/empty thumbnails for modern apps.
            // PW_CLIENTONLY (0x1) | PW_RENDERFULLCONTENT (0x2) = 0x3
            let ok = PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(0x3));
            ReleaseDC(hwnd, wnd_dc);
            if !ok.as_bool() {
                // Fallback: try BitBlt from window DC
                let wnd_dc2 = GetDC(hwnd);
                BitBlt(mem_dc, 0, 0, w, h, wnd_dc2, 0, 0, SRCCOPY).ok();
                ReleaseDC(hwnd, wnd_dc2);
            }

            (mem_dc, src_bmp, w, h)
        };

        if src_w <= 0 || src_h <= 0 {
            DeleteDC(src_dc);
            DeleteObject(src_bmp_handle);
            return None;
        }

        // Create thumbnail bitmap
        let thumb_dc = CreateCompatibleDC(src_dc);
        let thumb_bmp = CreateCompatibleBitmap(src_dc, THUMB_W, THUMB_H);
        let old_thumb = SelectObject(thumb_dc, thumb_bmp);

        SetStretchBltMode(thumb_dc, HALFTONE);
        StretchBlt(
            thumb_dc, 0, 0, THUMB_W, THUMB_H,
            src_dc, 0, 0, src_w, src_h,
            SRCCOPY,
        ).ok();

        // Read pixels from thumbnail
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: THUMB_W,
                biHeight: -THUMB_H, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0 as u32,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default()],
        };

        let row_size = (THUMB_W * 4) as usize;
        let pixel_data_size = row_size * THUMB_H as usize;
        let mut pixels = vec![0u8; pixel_data_size];

        let lines = GetDIBits(
            thumb_dc,
            thumb_bmp,
            0,
            THUMB_H as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // Cleanup GDI
        SelectObject(thumb_dc, old_thumb);
        DeleteObject(thumb_bmp);
        DeleteDC(thumb_dc);

        // Clean up source DC and bitmap
        DeleteDC(src_dc);
        DeleteObject(src_bmp_handle);

        if lines == 0 {
            eprintln!("[thumbnail] GetDIBits returned 0 lines");
            return None;
        }

        // Detect all-black thumbnails (PrintWindow failed silently) — check a sparse
        // sample of pixels across the image. BMP pixels are BGRA, so check RGB channels.
        let mut has_content = false;
        let sample_step = (pixel_data_size / 64).max(4); // ~64 evenly-spaced sample points
        let mut offset = 0;
        while offset + 3 < pixel_data_size {
            // Check BGR channels (skip alpha at offset+3)
            if pixels[offset] != 0 || pixels[offset + 1] != 0 || pixels[offset + 2] != 0 {
                has_content = true;
                break;
            }
            offset += sample_step;
        }
        if !has_content {
            // All sampled pixels are black — thumbnail is empty/failed
            return None;
        }

        // Build BMP file in memory (header + pixel data)
        let file_header_size = 14u32;
        let info_header_size = 40u32;
        let headers_size = file_header_size + info_header_size;
        let file_size = headers_size + pixel_data_size as u32;

        let mut bmp_data = Vec::with_capacity(file_size as usize);

        // BMP file header (14 bytes)
        bmp_data.extend_from_slice(b"BM");
        bmp_data.extend_from_slice(&file_size.to_le_bytes());
        bmp_data.extend_from_slice(&0u16.to_le_bytes()); // reserved1
        bmp_data.extend_from_slice(&0u16.to_le_bytes()); // reserved2
        bmp_data.extend_from_slice(&headers_size.to_le_bytes()); // pixel data offset

        // BITMAPINFOHEADER (40 bytes) — bottom-up for BMP file format
        bmp_data.extend_from_slice(&info_header_size.to_le_bytes());
        bmp_data.extend_from_slice(&THUMB_W.to_le_bytes());
        bmp_data.extend_from_slice(&THUMB_H.to_le_bytes()); // positive = bottom-up
        bmp_data.extend_from_slice(&1u16.to_le_bytes()); // planes
        bmp_data.extend_from_slice(&32u16.to_le_bytes()); // bpp
        bmp_data.extend_from_slice(&0u32.to_le_bytes()); // compression (BI_RGB)
        bmp_data.extend_from_slice(&(pixel_data_size as u32).to_le_bytes());
        bmp_data.extend_from_slice(&0i32.to_le_bytes()); // x ppm
        bmp_data.extend_from_slice(&0i32.to_le_bytes()); // y ppm
        bmp_data.extend_from_slice(&0u32.to_le_bytes()); // colors used
        bmp_data.extend_from_slice(&0u32.to_le_bytes()); // colors important

        // Flip rows (GetDIBits gave us top-down, BMP wants bottom-up)
        for y in (0..THUMB_H as usize).rev() {
            let start = y * row_size;
            bmp_data.extend_from_slice(&pixels[start..start + row_size]);
        }

        let b64 = base64::engine::general_purpose::STANDARD.encode(&bmp_data);
        Some(format!("data:image/bmp;base64,{}", b64))
    }
}

// ── Capture + Publish Loop ──

async fn share_loop(
    source_id: u64,
    sfu_url: &str,
    token: &str,
    app: &AppHandle,
    running: &Arc<AtomicBool>,
    health: Arc<CaptureHealthState>,
) -> Result<(), String> {
    // 1. Connect to SFU and publish track via shared pipeline
    let mut publisher = CapturePublisher::connect_and_publish(
        sfu_url, token, 1920, 1080, "screen-capture",
    ).await?;

    // Resolve HWND -> PID for WASAPI audio auto-start
    let target_pid = unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
        let hwnd = HWND(source_id as *mut _);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        eprintln!("[screen-capture] HWND {} -> PID {}", source_id, pid);
        pid
    };

    eprintln!("[screen-capture] starting WGC capture");
    let _ = app.emit("screen-capture-started", target_pid);
    health.set_active(
        true,
        CaptureMode::Wgc,
        EncoderType::Nvenc,
        crate::capture_pipeline::PUBLISH_TARGET_FPS,
    );

    // 2. Start WGC capture -- callback sends BGRA frames via channel
    // Channel sends 1080p BGRA frames (8MB each, GPU-downscaled from 4K)
    let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<(Vec<u8>, u32, u32)>(4);
    let capture_running = running.clone();

    std::thread::spawn(move || {
        use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
        use windows_capture::settings::*;
        use windows_capture::window::Window;
        use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext};
        use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
        use crate::gpu_converter::GpuConverter;

        const ENC_W: u32 = 1920;
        const ENC_H: u32 = 1080;

        struct Handler {
            tx: std::sync::mpsc::SyncSender<(Vec<u8>, u32, u32)>,
            running: Arc<AtomicBool>,
            wgc_frame_count: u64,
            wgc_start: std::time::Instant,
            /// GPU pipeline: (device, context, converter) -- lazily created on first frame
            gpu: Option<(ID3D11Device, ID3D11DeviceContext, GpuConverter)>,
        }

        impl GraphicsCaptureApiHandler for Handler {
            type Flags = (
                std::sync::mpsc::SyncSender<(Vec<u8>, u32, u32)>,
                Arc<AtomicBool>,
            );
            type Error = Box<dyn std::error::Error + Send + Sync>;

            fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
                let (tx, running) = ctx.flags;
                Ok(Self {
                    tx, running,
                    wgc_frame_count: 0,
                    wgc_start: std::time::Instant::now(),
                    gpu: None,
                })
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

                self.wgc_frame_count += 1;
                let w = frame.width();
                let h = frame.height();

                // Log WGC callback FPS every 60 frames
                if self.wgc_frame_count % 60 == 0 {
                    let elapsed = self.wgc_start.elapsed().as_secs_f64();
                    let fps = if elapsed > 0.0 { (self.wgc_frame_count as f64 / elapsed) as u32 } else { 0 };
                    eprintln!("[wgc-callback] {}x{} @ {}fps ({} frames)", w, h, fps, self.wgc_frame_count);
                }

                // Get the GPU texture directly (no CPU copy!)
                // windows-capture uses windows v0.61, we use v0.58.
                // Both are #[repr(transparent)] COM wrappers for the same interface.
                // Safe to transmute the reference.
                let frame_texture: &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D = unsafe {
                    std::mem::transmute(frame.as_raw_texture())
                };

                // Lazily initialize GPU pipeline on WGC's own device
                if self.gpu.is_none() {
                    unsafe {
                        let device: ID3D11Device = frame_texture.GetDevice()
                            .map_err(|e| format!("GetDevice: {e}"))?;
                        let context = device.GetImmediateContext()
                            .map_err(|e| format!("GetImmediateContext: {e}"))?;
                        let converter = GpuConverter::new(
                            &device, w, h,
                            DXGI_FORMAT_B8G8R8A8_UNORM,
                            ENC_W, ENC_H,
                        ).map_err(|e| format!("GpuConverter: {e}"))?;
                        eprintln!("[wgc-gpu] pipeline initialized on WGC device: {}x{} -> {}x{}", w, h, ENC_W, ENC_H);
                        self.gpu = Some((device, context, converter));
                    }
                }

                let (_, context, converter) = self.gpu.as_ref().unwrap();

                // GPU pipeline: CopyResource -> compute shader -> staging -> Map -> CPU buffer
                unsafe {
                    let (ptr, pitch, out_w, out_h) = converter.convert(
                        context, frame_texture,
                        0, 0, w, h, None,
                    ).map_err(|e| format!("convert: {e}"))?;

                    // Copy from mapped staging to owned buffer
                    let row_bytes = (out_w * 4) as usize;
                    let mut bgra = vec![0u8; (out_w * out_h * 4) as usize];
                    for y in 0..out_h as usize {
                        std::ptr::copy_nonoverlapping(
                            ptr.add(y * pitch as usize),
                            bgra.as_mut_ptr().add(y * row_bytes),
                            row_bytes,
                        );
                    }
                    converter.unmap(context);

                    // Non-blocking: drop frame if receiver is behind
                    let _ = self.tx.try_send((bgra, out_w, out_h));
                }

                Ok(())
            }

            fn on_closed(&mut self) -> Result<(), Self::Error> {
                eprintln!("[screen-capture] WGC closed");
                Ok(())
            }
        }

        let hwnd = source_id as isize;
        let window = unsafe { Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void) };

        // MinimumUpdateInterval MUST be >= 1ms. The default (0ms) has a Windows bug
        // that caps capture at ~50fps. With 1ms, WGC captures at the app's native FPS.
        let settings = Settings::new(
            window,
            CursorCaptureSettings::Default,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(std::time::Duration::from_millis(1)),
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            (frame_tx, capture_running),
        );

        eprintln!("[screen-capture] WGC starting for HWND {}", source_id);
        match Handler::start_free_threaded(settings) {
            Ok(ctrl) => {
                let _ = ctrl.wait();
            }
            Err(e) => eprintln!("[screen-capture] WGC start error: {:?}", e),
        }
        eprintln!("[screen-capture] WGC thread exiting");
    });

    // 3. Frame loop: receive BGRA -> push to SFU via CapturePublisher
    let mut drop_count: u64 = 0;
    let mut yuv_total_us: u64 = 0;
    let mut capture_total_us: u64 = 0;

    // Drain channel aggressively: if multiple frames queued, skip to latest
    while running.load(Ordering::SeqCst) {
        let frame = match frame_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(f) => f,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };

        // Skip to newest frame if channel has backed up
        let mut latest = frame;
        while let Ok(newer) = frame_rx.try_recv() {
            drop_count += 1;
            latest = newer;
        }
        let (bgra_data, width, height) = latest;

        // Data arrives already downscaled to 1080p by GPU shader
        let t0 = std::time::Instant::now();
        publisher.push_frame(&bgra_data, width, height);
        let t1 = std::time::Instant::now();

        yuv_total_us += (t1 - t0).as_micros() as u64;
        let fc = publisher.frame_count();

        if fc % 30 == 0 {
            let elapsed = publisher.elapsed().as_secs_f64();
            let fps = if elapsed > 0.0 { (fc as f64 / elapsed) as u32 } else { 0 };
            let avg_yuv_ms = if fc > 0 { yuv_total_us as f64 / fc as f64 / 1000.0 } else { 0.0 };
            eprintln!("[wgc-publish] {}x{} @ {}fps ({} frames, {} skipped, yuv={:.1}ms)",
                width, height, fps, fc, drop_count, avg_yuv_ms);
            if let Some(emit_fps) = publisher.maybe_emit_stats(app, "screen-capture-stats", "wgc", width, height, 30) {
                health.record_capture_fps(emit_fps);
            }
        }
    }

    running.store(false, Ordering::SeqCst);
    eprintln!("[screen-capture] shutting down, {} frames captured", publisher.frame_count());
    health.set_active(false, CaptureMode::None, EncoderType::None, 0);
    publisher.shutdown().await;
    Ok(())
}

// ── Public API: Monitor capture (full screen) ──

/// Start native monitor sharing: capture entire monitor via WGC → encode H264 → publish.
/// Unlike `start_share` (window capture), this:
///   - Includes the cursor automatically (via WGC's CursorCaptureSettings::Default)
///   - Uses Microsoft's HDR→SDR conversion (no manual gamma shader needed)
///   - Captures system-wide audio mixing rather than per-process WASAPI
pub async fn start_share_monitor(
    hmonitor: u64,
    sfu_url: String,
    token: String,
    app: AppHandle,
    health: Arc<CaptureHealthState>,
) -> Result<(), String> {
    stop_share();

    let running = Arc::new(AtomicBool::new(true));

    {
        let mut state = global_state().lock().unwrap();
        *state = Some(ShareHandle {
            running: running.clone(),
        });
    }

    let app2 = app.clone();
    let r2 = running.clone();
    tokio::spawn(async move {
        if let Err(e) = share_loop_monitor(hmonitor, &sfu_url, &token, &app2, &r2, health).await {
            eprintln!("[screen-capture-monitor] error: {}", e);
            let _ = app2.emit("screen-capture-error", format!("{}", e));
        }
        let _ = app2.emit("screen-capture-stopped", ());
        eprintln!("[screen-capture-monitor] task exited");
        let mut state = global_state().lock().unwrap();
        *state = None;
    });

    Ok(())
}

async fn share_loop_monitor(
    hmonitor: u64,
    sfu_url: &str,
    token: &str,
    app: &AppHandle,
    running: &Arc<AtomicBool>,
    health: Arc<CaptureHealthState>,
) -> Result<(), String> {
    // 1. Connect to SFU and publish track via shared pipeline
    let mut publisher = CapturePublisher::connect_and_publish(
        sfu_url, token, 1920, 1080, "screen-capture-monitor",
    ).await?;

    eprintln!("[screen-capture-monitor] starting WGC monitor capture for HMONITOR {}", hmonitor);
    // No PID for monitor capture — system-wide audio not per-process
    let _ = app.emit("screen-capture-started", 0u32);
    health.set_active(
        true,
        CaptureMode::Wgc,
        EncoderType::Nvenc,
        crate::capture_pipeline::PUBLISH_TARGET_FPS,
    );

    let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<(Vec<u8>, u32, u32)>(4);
    let capture_running = running.clone();

    std::thread::spawn(move || {
        use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
        use windows_capture::settings::*;
        use windows_capture::monitor::Monitor;
        use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext};
        use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R16G16B16A16_FLOAT;
        use crate::gpu_converter::GpuConverter;

        const ENC_W: u32 = 1920;
        const ENC_H: u32 = 1080;

        struct Handler {
            tx: std::sync::mpsc::SyncSender<(Vec<u8>, u32, u32)>,
            running: Arc<AtomicBool>,
            wgc_frame_count: u64,
            wgc_start: std::time::Instant,
            gpu: Option<(ID3D11Device, ID3D11DeviceContext, GpuConverter)>,
        }

        impl GraphicsCaptureApiHandler for Handler {
            type Flags = (
                std::sync::mpsc::SyncSender<(Vec<u8>, u32, u32)>,
                Arc<AtomicBool>,
            );
            type Error = Box<dyn std::error::Error + Send + Sync>;

            fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
                let (tx, running) = ctx.flags;
                Ok(Self {
                    tx, running,
                    wgc_frame_count: 0,
                    wgc_start: std::time::Instant::now(),
                    gpu: None,
                })
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

                self.wgc_frame_count += 1;
                let w = frame.width();
                let h = frame.height();

                if self.wgc_frame_count % 60 == 0 {
                    let elapsed = self.wgc_start.elapsed().as_secs_f64();
                    let fps = if elapsed > 0.0 { (self.wgc_frame_count as f64 / elapsed) as u32 } else { 0 };
                    eprintln!("[wgc-monitor-callback] {}x{} @ {}fps ({} frames)", w, h, fps, self.wgc_frame_count);
                }

                let frame_texture: &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D = unsafe {
                    std::mem::transmute(frame.as_raw_texture())
                };

                if self.gpu.is_none() {
                    unsafe {
                        let device: ID3D11Device = frame_texture.GetDevice()
                            .map_err(|e| format!("GetDevice: {e}"))?;
                        let context = device.GetImmediateContext()
                            .map_err(|e| format!("GetImmediateContext: {e}"))?;
                        // Capture in HDR scRGB float — avoids forcing Windows to do
                        // HDR->SDR mode conversion (which causes monitor flicker on
                        // HDR displays). Our GpuConverter detects this format and
                        // applies linear->sRGB gamma correction in the shader.
                        let converter = GpuConverter::new(
                            &device, w, h,
                            DXGI_FORMAT_R16G16B16A16_FLOAT,
                            ENC_W, ENC_H,
                        ).map_err(|e| format!("GpuConverter: {e}"))?;
                        eprintln!("[wgc-monitor-gpu] pipeline initialized: {}x{} HDR -> {}x{} SDR", w, h, ENC_W, ENC_H);
                        self.gpu = Some((device, context, converter));
                    }
                }

                let (_, context, converter) = self.gpu.as_ref().unwrap();

                unsafe {
                    let (ptr, pitch, out_w, out_h) = converter.convert(
                        context, frame_texture,
                        0, 0, w, h, None,
                    ).map_err(|e| format!("convert: {e}"))?;

                    let row_bytes = (out_w * 4) as usize;
                    let mut bgra = vec![0u8; (out_w * out_h * 4) as usize];
                    for y in 0..out_h as usize {
                        std::ptr::copy_nonoverlapping(
                            ptr.add(y * pitch as usize),
                            bgra.as_mut_ptr().add(y * row_bytes),
                            row_bytes,
                        );
                    }
                    converter.unmap(context);

                    let _ = self.tx.try_send((bgra, out_w, out_h));
                }

                Ok(())
            }

            fn on_closed(&mut self) -> Result<(), Self::Error> {
                eprintln!("[screen-capture-monitor] WGC closed");
                Ok(())
            }
        }

        // Create monitor capture target from HMONITOR pointer
        let monitor = Monitor::from_raw_hmonitor(hmonitor as *mut std::ffi::c_void);

        // Same settings as window capture: cursor enabled, 1ms update interval
        // (default 0ms has Windows bug capping at ~50fps).
        // ColorFormat::Rgba16F (HDR scRGB float) — requesting Bgra8 from an HDR
        // monitor forces Windows to renegotiate the display mode, causing
        // visible monitor flicker. Capturing in HDR native and converting in
        // our shader eliminates the mode-switch flicker entirely.
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,  // cursor INCLUDED — this is the win
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(std::time::Duration::from_millis(1)),
            DirtyRegionSettings::Default,
            ColorFormat::Rgba16F,
            (frame_tx, capture_running),
        );

        eprintln!("[screen-capture-monitor] WGC starting for HMONITOR {}", hmonitor);
        match Handler::start_free_threaded(settings) {
            Ok(ctrl) => {
                let _ = ctrl.wait();
            }
            Err(e) => eprintln!("[screen-capture-monitor] WGC start error: {:?}", e),
        }
        eprintln!("[screen-capture-monitor] WGC thread exiting");
    });

    let mut drop_count: u64 = 0;
    let mut yuv_total_us: u64 = 0;

    while running.load(Ordering::SeqCst) {
        let frame = match frame_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(f) => f,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };

        let mut latest = frame;
        while let Ok(newer) = frame_rx.try_recv() {
            drop_count += 1;
            latest = newer;
        }
        let (bgra_data, width, height) = latest;

        let t0 = std::time::Instant::now();
        publisher.push_frame(&bgra_data, width, height);
        let t1 = std::time::Instant::now();

        yuv_total_us += (t1 - t0).as_micros() as u64;
        let fc = publisher.frame_count();

        if fc % 30 == 0 {
            let elapsed = publisher.elapsed().as_secs_f64();
            let fps = if elapsed > 0.0 { (fc as f64 / elapsed) as u32 } else { 0 };
            let avg_yuv_ms = if fc > 0 { yuv_total_us as f64 / fc as f64 / 1000.0 } else { 0.0 };
            eprintln!("[wgc-monitor-publish] {}x{} @ {}fps ({} frames, {} skipped, yuv={:.1}ms)",
                width, height, fps, fc, drop_count, avg_yuv_ms);
            if let Some(emit_fps) = publisher.maybe_emit_stats(app, "screen-capture-stats", "wgc-monitor", width, height, 30) {
                health.record_capture_fps(emit_fps);
            }
        }
    }

    running.store(false, Ordering::SeqCst);
    eprintln!("[screen-capture-monitor] shutting down, {} frames captured", publisher.frame_count());
    health.set_active(false, CaptureMode::None, EncoderType::None, 0);
    publisher.shutdown().await;
    Ok(())
}
