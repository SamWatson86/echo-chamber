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

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

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

/// List available capture sources (windows + monitors).
pub fn list_sources() -> Vec<CaptureSource> {
    let mut sources = Vec::new();

    match windows_capture::window::Window::enumerate() {
        Ok(windows) => {
            for w in windows {
                if let Ok(title) = w.title() {
                    if title.is_empty() {
                        continue;
                    }
                    sources.push(CaptureSource {
                        id: w.as_raw_hwnd() as u64,
                        title,
                        is_monitor: false,
                    });
                }
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
        if let Err(e) = share_loop(source_id, &sfu_url, &token, &app2, &r2).await {
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

// ── Capture + Publish Loop ──

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
    use livekit::webrtc::native::yuv_helper;
    use livekit::options::{TrackPublishOptions, VideoCodec};

    eprintln!("[screen-capture] connecting to SFU: {}", sfu_url);

    // 1. Connect to LiveKit SFU
    let (room, _events) = Room::connect(sfu_url, token, RoomOptions::default())
        .await
        .map_err(|e| format!("SFU connect failed: {}", e))?;

    eprintln!(
        "[screen-capture] connected as {}",
        room.local_participant().identity().as_str()
    );

    // 2. Create video source and track
    let source = NativeVideoSource::new(VideoResolution {
        width: 1280,
        height: 720,
    }, false);
    let track = LocalVideoTrack::create_video_track(
        "screen",
        RtcVideoSource::Native(source.clone()),
    );

    // 3. Publish the track
    let publish_options = TrackPublishOptions {
        source: TrackSource::Screenshare,
        video_codec: VideoCodec::H264,
        ..Default::default()
    };
    room.local_participant()
        .publish_track(LocalTrack::Video(track), publish_options)
        .await
        .map_err(|e| format!("publish failed: {}", e))?;

    eprintln!("[screen-capture] track published, starting WGC capture");
    let _ = app.emit("screen-capture-started", ());

    // 4. Start WGC capture — callback sends BGRA frames via channel
    let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<(Vec<u8>, u32, u32)>(2);
    let capture_running = running.clone();

    std::thread::spawn(move || {
        use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
        use windows_capture::settings::*;
        use windows_capture::window::Window;

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

            fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
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

                // Non-blocking: drop frame if receiver is behind
                let _ = self.tx.try_send((data, w, h));
                Ok(())
            }

            fn on_closed(&mut self) -> Result<(), Self::Error> {
                eprintln!("[screen-capture] WGC closed");
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

        eprintln!("[screen-capture] WGC starting for HWND {}", source_id);
        match Handler::start_free_threaded(settings) {
            Ok(ctrl) => {
                let _ = ctrl.wait();
            }
            Err(e) => eprintln!("[screen-capture] WGC start error: {:?}", e),
        }
        eprintln!("[screen-capture] WGC thread exiting");
    });

    // 5. Frame loop: receive BGRA → convert I420 → push to LiveKit
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
                    let _ = app.emit(
                        "screen-capture-stats",
                        ScreenShareStats {
                            fps,
                            width,
                            height,
                            bitrate_kbps: 0,
                            encoder: "NVENC/H264".to_string(),
                            status: "active".to_string(),
                        },
                    );
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    running.store(false, Ordering::SeqCst);
    eprintln!("[screen-capture] shutting down, {} frames captured", frame_count);
    room.close().await.ok();
    Ok(())
}
