//! Game capture consumer — reads shared texture frames and publishes via LiveKit.
//!
//! Architecture:
//!   injector::inject() hooks game's Present()
//!     → game writes BGRA to shared D3D11 texture + signals event
//!       → this module waits on event → keyed mutex acquire → copy to staging
//!         → map staging → BGRA→I420 (libyuv) → NativeVideoSource::capture_frame
//!           → libwebrtc H264 encoder (MFT → NVENC) → RTP → SFU

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tauri::Emitter;
use windows::Win32::System::Threading::WaitForSingleObject;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW,
    TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32, MODULEENTRY32W,
};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Texture2D,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
};
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::core::Interface;

use livekit::prelude::*;
use livekit::webrtc::prelude::*;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::native::yuv_helper;
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};

use crate::injector::{self, InjectionHandle};

// ── Global State ──

struct GameShareHandle {
    running: Arc<AtomicBool>,
    target_pid: u32,
}

fn global_state() -> &'static Mutex<Option<GameShareHandle>> {
    static STATE: OnceLock<Mutex<Option<GameShareHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

// ── Public API (called from Tauri IPC) ──

/// Start game capture: inject hook DLL, read shared texture, publish to SFU.
pub async fn start(
    hwnd: u64,
    sfu_url: String,
    token: String,
    app: AppHandle,
) -> Result<(), String> {
    stop();

    // Wait for previous hook DLL to fully unload.
    // Poll the target process for up to 2 seconds instead of a blind sleep.
    let target_pid = unsafe {
        let mut pid = 0u32;
        let hwnd_val = windows::Win32::Foundation::HWND(hwnd as *mut _);
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd_val, Some(&mut pid));
        pid
    };
    if target_pid > 0 {
        for attempt in 0..20 {
            if !is_dll_loaded(target_pid, "echo_game_hook.dll") {
                eprintln!("[game-capture] previous DLL unloaded after {}ms", attempt * 100);
                break;
            }
            if attempt == 19 {
                eprintln!("[game-capture] WARNING: old DLL still loaded after 2s — re-injection may fail");
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    } else {
        // Fallback blind wait if we can't get the PID
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    let running = Arc::new(AtomicBool::new(true));

    // Inject the hook DLL into the game process
    let injection = injector::inject(hwnd, 60)?;
    let target_pid = injection.target_pid;

    {
        let mut state = global_state().lock().unwrap();
        *state = Some(GameShareHandle {
            running: running.clone(),
            target_pid,
        });
    }

    let _ = app.emit("game-capture-started", target_pid);

    let r2 = running.clone();
    tokio::spawn(async move {
        match capture_loop(&sfu_url, &token, &app, &r2, injection).await {
            Ok(()) => eprintln!("[game-capture] stopped cleanly"),
            Err(e) => {
                eprintln!("[game-capture] error: {e}");
                let _ = app.emit("game-capture-error", e.to_string());
            }
        }
        let _ = app.emit("game-capture-stopped", ());
        let mut state = global_state().lock().unwrap();
        *state = None;
    });

    Ok(())
}

/// Stop the current game capture.
pub fn stop() {
    let mut state = global_state().lock().unwrap();
    if let Some(handle) = state.take() {
        handle.running.store(false, Ordering::SeqCst);
        eprintln!("[game-capture] stop requested");

        // Force-unload the DLL from the game process.
        // The hook checks running=0 on Present(), but if the game isn't rendering
        // (minimized, paused, loading screen), Present() never fires and the DLL
        // never self-unloads. Use CreateRemoteThread + FreeLibrary to force it.
        if handle.target_pid > 0 {
            std::thread::spawn(move || {
                // Give the hook a chance to self-unload via Present() first
                std::thread::sleep(std::time::Duration::from_millis(500));
                if is_dll_loaded(handle.target_pid, "echo_game_hook.dll") {
                    eprintln!("[game-capture] DLL still loaded after 500ms, force-unloading");
                    force_unload_dll(handle.target_pid, "echo_game_hook.dll");
                } else {
                    eprintln!("[game-capture] DLL self-unloaded successfully");
                }
            });
        }
    }
}

// ── Capture + Publish Loop ──

async fn capture_loop(
    sfu_url: &str,
    token: &str,
    app: &AppHandle,
    running: &Arc<AtomicBool>,
    injection: InjectionHandle,
) -> Result<(), String> {
    eprintln!("[game-capture] connecting to SFU: {}", sfu_url);

    // 1. Connect to LiveKit SFU as $screen identity
    let (room, _events) = Room::connect(sfu_url, token, RoomOptions::default())
        .await
        .map_err(|e| format!("SFU connect failed: {e}"))?;

    eprintln!(
        "[game-capture] connected as {}",
        room.local_participant().identity().as_str()
    );

    // 2. Create video source and track (is_screencast=true for screen share behavior)
    // Use the shared texture dimensions as the initial resolution hint
    let cb = injection.control.block();
    let init_w = if cb.width > 0 { cb.width } else { 1920 };
    let init_h = if cb.height > 0 { cb.height } else { 1080 };
    let source = NativeVideoSource::new(VideoResolution {
        width: init_w,
        height: init_h,
    }, true);
    let track = LocalVideoTrack::create_video_track(
        "screen",
        RtcVideoSource::Native(source.clone()),
    );

    // 3. Publish the track as screenshare with H264 (NVENC).
    // Simulcast OFF for now: enabling simulcast caused the stream to not appear
    // in the viewer (SFU may not forward simulcast layers from Rust SDK correctly
    // with use_external_ip=true). Needs investigation.
    // The min-bitrate SDP patch (livekit-local) prevents TWCC from starving
    // the encoder on localhost.
    // Bitrate is set at publish time before we know the actual resolution.
    // Use 20 Mbps as a safe default — works for all resolutions including 4K.
    // 50 Mbps caused oversized keyframes at 4K that overwhelmed the transport.
    let max_bitrate = 20_000_000u64;
    eprintln!("[game-capture] max_bitrate={}Mbps", max_bitrate / 1_000_000);

    let publish_options = TrackPublishOptions {
        source: TrackSource::Screenshare,
        video_codec: VideoCodec::H264,
        simulcast: false,
        video_encoding: Some(VideoEncoding {
            max_bitrate,
            max_framerate: 60.0,
        }),
        ..Default::default()
    };
    room.local_participant()
        .publish_track(LocalTrack::Video(track), publish_options)
        .await
        .map_err(|e| format!("publish failed: {e}"))?;

    eprintln!("[game-capture] track published, waiting for negotiation...");

    // Wait for SDP+ICE+DTLS to complete. The publisher transport needs time to
    // establish before we start pushing frames. Without this, the SFU hits
    // "publish time out" because frames arrive before the transport is ready.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Log the local participant's published tracks
    let tracks = room.local_participant().track_publications();
    eprintln!("[game-capture] published tracks: {}", tracks.len());
    for (sid, pub_track) in &tracks {
        eprintln!("[game-capture]   track sid={} name={}", sid, pub_track.name());
    }
    eprintln!("[game-capture] room connection state: {:?}", room.connection_state());

    eprintln!("[game-capture] starting frame loop");

    // 4. Get D3D11 device context for texture operations
    let device = &injection.d3d_device;
    let context = unsafe { device.GetImmediateContext() }
        .map_err(|e| format!("GetImmediateContext: {e}"))?;

    // 5. Get keyed mutex from shared texture for synchronization
    let shared_texture = &injection.shared_texture;
    let mutex: IDXGIKeyedMutex = shared_texture.cast()
        .map_err(|e| format!("cast keyed mutex: {e}"))?;

    let mut staging: Option<ID3D11Texture2D> = None;
    let mut staging_width = 0u32;
    // Pre-allocated buffer for R10G10B10A2→R8G8B8A8 conversion (avoids 8MB alloc per frame)
    let mut rgba_conv_buf: Vec<u8> = Vec::new();
    let mut staging_height = 0u32;
    let mut frame_count: u64 = 0;
    let start_time = std::time::Instant::now();

    // 6. Frame loop: wait for event → acquire mutex → copy → convert → publish
    let cb_ptr = injection.control.ptr;
    let mut timeout_count = 0u32;
    const MAX_CONSECUTIVE_TIMEOUTS: u32 = 50; // 50 × 100ms = 5 seconds with no frames → game likely exited
    while running.load(Ordering::SeqCst) {
        // Wait up to 100ms for the hook DLL to signal a new frame
        let wait_result = unsafe { WaitForSingleObject(injection.frame_event, 100) };
        // WAIT_OBJECT_0 = 0 in Win32
        if wait_result.0 != 0 {
            timeout_count += 1;
            if timeout_count <= 3 || timeout_count % 100 == 0 {
                let w = unsafe { std::ptr::read_volatile(&(*cb_ptr).width) };
                let h = unsafe { std::ptr::read_volatile(&(*cb_ptr).height) };
                let f = unsafe { std::ptr::read_volatile(&(*cb_ptr).frame_number) };
                let r = unsafe { std::ptr::read_volatile(&(*cb_ptr).running) };
                eprintln!("[game-capture] wait timeout #{timeout_count} (result={:#x}) cb: w={w} h={h} frame={f} running={r}", wait_result.0);
            }
            // If no frames for 5 seconds, game likely exited — auto-stop
            if timeout_count >= MAX_CONSECUTIVE_TIMEOUTS {
                eprintln!("[game-capture] {MAX_CONSECUTIVE_TIMEOUTS} consecutive timeouts — game likely exited, stopping");
                break;
            }
            continue; // Timeout or error — check running flag and retry
        }
        timeout_count = 0; // Reset on successful frame

        // Read frame dimensions from control block (volatile — written by another process)
        let cb_ptr = injection.control.ptr;
        let frame_num = unsafe { std::ptr::read_volatile(&(*cb_ptr).frame_number) };
        let width = unsafe { std::ptr::read_volatile(&(*cb_ptr).width) };
        let height = unsafe { std::ptr::read_volatile(&(*cb_ptr).height) };
        if width == 0 || height == 0 || frame_num < 5 {
            continue; // Skip first 5 hook frames — stale GPU data causes green flash
        }

        // (Re)create staging texture if dimensions changed
        if staging.is_none() || width != staging_width || height != staging_height {
            staging = create_staging_texture(device, width, height).ok();
            staging_width = width;
            staging_height = height;
            eprintln!("[game-capture] staging texture: {width}x{height}");
        }
        let staging_tex = match &staging {
            Some(s) => s,
            None => continue,
        };

        unsafe {
            // Acquire keyed mutex (key=1 for consumer, released with key=0 for producer)
            if mutex.AcquireSync(1, 0).is_err() {
                continue; // Producer hasn't released yet — skip frame
            }

            // Copy shared texture → staging (GPU-side, fast)
            context.CopyResource(staging_tex, shared_texture);

            // Flush to ensure GPU copy completes before releasing mutex
            context.Flush();

            // Release mutex back to producer
            let _ = mutex.ReleaseSync(0);

            // Map staging texture for CPU read
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if context.Map(staging_tex, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).is_err() {
                continue;
            }

            let raw_stride = mapped.RowPitch;
            let raw_data = std::slice::from_raw_parts(
                mapped.pData as *const u8,
                (raw_stride * height) as usize,
            );

            // Check format from control block: 2 = R10G10B10A2 raw, else R8G8B8A8
            let pixel_format = std::ptr::read_volatile(&(*cb_ptr).format);

            let dst_stride = width * 4;
            let (bgra_data, bgra_stride): (&[u8], u32) = if pixel_format == 2 {
                // R10G10B10A2 raw bytes — convert to R8G8B8A8
                let needed = (dst_stride * height) as usize;
                if rgba_conv_buf.len() < needed { rgba_conv_buf.resize(needed, 0); }
                let out = &mut rgba_conv_buf[..needed];
                let row_pixels = width as usize;
                for y in 0..height as usize {
                    let src_row = y * raw_stride as usize;
                    let dst_row = y * dst_stride as usize;
                    for x in 0..row_pixels {
                        let s = src_row + x * 4;
                        if s + 4 > raw_data.len() { break; }
                        let p = u32::from_le_bytes([raw_data[s], raw_data[s+1], raw_data[s+2], raw_data[s+3]]);
                        let d = dst_row + x * 4;
                        out[d]   = ((p & 0x3FF) >> 2) as u8;
                        out[d+1] = (((p >> 10) & 0x3FF) >> 2) as u8;
                        out[d+2] = (((p >> 20) & 0x3FF) >> 2) as u8;
                        out[d+3] = (((p >> 30) & 0x3) * 85) as u8;
                    }
                }
                (&rgba_conv_buf[..needed], dst_stride)
            } else {
                (raw_data, raw_stride)
            };

            // Convert RGBA → I420 using libyuv
            let mut i420 = I420Buffer::new(width, height);
            let (sy, su, sv) = i420.strides();
            let (y, u, v) = i420.data_mut();

            // R8G8B8A8_UNORM in memory = ABGR in 32-bit register (little-endian)
            yuv_helper::abgr_to_i420(
                bgra_data, bgra_stride,
                y, sy,
                u, su,
                v, sv,
                width as i32, height as i32,
            );

            context.Unmap(staging_tex, 0);

            // Log frame data to verify non-black (check frames 0, 60, 120)
            if frame_count == 0 || frame_count == 60 || frame_count == 120 {
                // Check shared texture desc matches expected
                let mut tex_desc = D3D11_TEXTURE2D_DESC::default();
                shared_texture.GetDesc(&mut tex_desc);
                eprintln!("[game-capture] shared texture: {}x{} fmt={} misc={:#x}",
                    tex_desc.Width, tex_desc.Height, tex_desc.Format.0, tex_desc.MiscFlags);
                let mut stg_desc = D3D11_TEXTURE2D_DESC::default();
                staging_tex.GetDesc(&mut stg_desc);
                eprintln!("[game-capture] staging texture: {}x{} fmt={} usage={}",
                    stg_desc.Width, stg_desc.Height, stg_desc.Format.0, stg_desc.Usage.0);
                eprintln!("[game-capture] mapped: pitch={} ptr={:?}",
                    mapped.RowPitch, mapped.pData);

                let sum: u64 = bgra_data.iter().take(4000).map(|&b| b as u64).sum();
                let nonzero = bgra_data.iter().take(40960).filter(|&&b| b != 0).count();
                eprintln!("[game-capture] first frame: sum(4000)={sum} nonzero(40960)={nonzero}");
            }

            // Push frame to LiveKit
            let vf = VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                buffer: i420,
                timestamp_us: start_time.elapsed().as_micros() as i64,
            };
            source.capture_frame(&vf);
        }

        frame_count += 1;
        if frame_count % 60 == 0 {
            let elapsed = start_time.elapsed().as_secs_f64();
            let fps = if elapsed > 0.0 { (frame_count as f64 / elapsed) as u32 } else { 0 };
            eprintln!("[game-capture] {width}x{height} @ {fps}fps ({frame_count} frames)");
            let _ = app.emit(
                "game-capture-stats",
                serde_json::json!({
                    "fps": fps,
                    "width": width,
                    "height": height,
                    "frames": frame_count,
                }),
            );

            // Adaptive FPS — adjust every 1 second (roughly every 60 frames at 60fps)
            if frame_count > 0 {
                let elapsed_s = start_time.elapsed().as_secs_f64();
                let actual_fps = frame_count as f64 / elapsed_s;
                let target = injection.control.block().target_fps;

                let new_target = if actual_fps > target as f64 * 0.9 {
                    // Headroom — try increasing (cap at 120)
                    (target + 5).min(120)
                } else if actual_fps < target as f64 * 0.7 {
                    // Overloaded — scale down (floor at 15)
                    (target.saturating_sub(10)).max(15)
                } else {
                    target // Hold steady
                };

                if new_target != target {
                    injection.control.block_mut().target_fps = new_target;
                    eprintln!("[game-capture] adaptive: actual={actual_fps:.1} target={target}→{new_target}");
                }
            }
        }
    }

    // Signal the hook DLL to stop and self-unload (do this FIRST, before closing Room)
    unsafe { std::ptr::write_volatile(&mut (*cb_ptr).running, 0) };
    running.store(false, Ordering::SeqCst);
    eprintln!("[game-capture] shutting down, {} frames captured", frame_count);

    // Close the SFU Room — this removes the $screen participant from the SFU,
    // which triggers TrackUnsubscribed/ParticipantDisconnected in all viewers.
    room.close().await.ok();
    eprintln!("[game-capture] SFU room closed, $screen participant removed");

    Ok(())
}

/// Create a D3D11 staging texture for CPU readback.
fn create_staging_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_R8G8B8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        CPUAccessFlags: 0x20000, // D3D11_CPU_ACCESS_READ = 0x20000
        ..Default::default()
    };

    unsafe {
        let mut texture: Option<ID3D11Texture2D> = None;
        device.CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|e| format!("staging texture: {e}"))?;
        texture.ok_or("no staging texture".into())
    }
}

/// Check if a DLL is loaded in a target process using CreateToolhelp32Snapshot.
fn is_dll_loaded(pid: u32, dll_name: &str) -> bool {
    find_dll_module(pid, dll_name).is_some()
}

/// Find a DLL's base address (HMODULE) in a target process.
fn find_dll_module(pid: u32, dll_name: &str) -> Option<usize> {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid).ok()?;

        let mut entry = MODULEENTRY32W {
            dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
            ..Default::default()
        };

        let dll_lower = dll_name.to_lowercase();
        let mut result = None;

        if Module32FirstW(snap, &mut entry).is_ok() {
            loop {
                let name = String::from_utf16_lossy(
                    &entry.szModule[..entry.szModule.iter().position(|&c| c == 0).unwrap_or(entry.szModule.len())]
                );
                if name.to_lowercase() == dll_lower {
                    result = Some(entry.modBaseAddr as usize);
                    break;
                }
                entry.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
                if Module32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snap);
        result
    }
}

/// Force-unload a DLL from a remote process using CreateRemoteThread + FreeLibrary.
fn force_unload_dll(pid: u32, dll_name: &str) {
    use windows::Win32::System::Threading::{OpenProcess, CreateRemoteThread, PROCESS_ALL_ACCESS};
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    let module_addr = match find_dll_module(pid, dll_name) {
        Some(addr) => addr,
        None => {
            eprintln!("[game-capture] force_unload: DLL not found in PID {pid}");
            return;
        }
    };

    unsafe {
        let process = match OpenProcess(PROCESS_ALL_ACCESS, false, pid) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[game-capture] force_unload: OpenProcess failed: {e}");
                return;
            }
        };

        // Get FreeLibrary address from kernel32 (same in all processes due to ASLR base)
        let kernel32 = GetModuleHandleW(windows::core::w!("kernel32.dll")).unwrap();
        let free_library = GetProcAddress(kernel32, windows::core::s!("FreeLibrary")).unwrap();

        // CreateRemoteThread calling FreeLibrary(module_handle) in the target process
        let thread = CreateRemoteThread(
            process,
            None,
            0,
            Some(std::mem::transmute(free_library)),
            Some(module_addr as *const _),
            0,
            None,
        );

        match thread {
            Ok(h) => {
                // Wait up to 2 seconds for FreeLibrary to complete
                WaitForSingleObject(h, 2000);
                let _ = CloseHandle(h);
                eprintln!("[game-capture] force_unload: FreeLibrary called in PID {pid}");
            }
            Err(e) => {
                eprintln!("[game-capture] force_unload: CreateRemoteThread failed: {e}");
            }
        }

        let _ = CloseHandle(process);
    }
}
