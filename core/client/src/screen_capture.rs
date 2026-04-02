//! Native screen capture via Windows.Graphics.Capture (WGC) + LiveKit Rust SDK
//!
//! Bypasses Chromium's getDisplayMedia entirely. WGC runs at the OS level and
//! is immune to WebView background throttling.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

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
    pub encoder: String,
    pub status: String,
}

struct ShareHandle {
    running: Arc<AtomicBool>,
}

fn global_state() -> &'static Mutex<Option<ShareHandle>> {
    static STATE: OnceLock<Mutex<Option<ShareHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

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

/// Start native screen share. Spawns the entire pipeline in a background task.
/// Uses a oneshot channel to report success/failure back to the caller.
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

    // Use a oneshot channel: background task reports Ok/Err after SFU connect + first frame
    let (result_tx, result_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    let app2 = app.clone();
    let r2 = running.clone();
    tokio::spawn(async move {
        let result = share_pipeline(source_id, &sfu_url, &token, &app2, &r2).await;
        let _ = result_tx.send(result);
    });

    // Wait for the pipeline to report success or failure (with timeout)
    match tokio::time::timeout(std::time::Duration::from_secs(10), result_rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(e))) => {
            let mut state = global_state().lock().unwrap();
            *state = None;
            Err(e)
        }
        Ok(Err(_)) => {
            let mut state = global_state().lock().unwrap();
            *state = None;
            Err("Screen capture task dropped unexpectedly".into())
        }
        Err(_) => {
            running.store(false, Ordering::SeqCst);
            let mut state = global_state().lock().unwrap();
            *state = None;
            Err("Screen capture timed out (10s)".into())
        }
    }
}

async fn share_pipeline(
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

    // 1. Connect to SFU
    eprintln!("[screen-capture] connecting to SFU: {}", sfu_url);
    let (room, _events) = Room::connect(sfu_url, token, RoomOptions::default())
        .await
        .map_err(|e| format!("SFU connect failed: {}", e))?;
    eprintln!("[screen-capture] connected as {}", room.local_participant().identity().as_str());

    // 2. Create source + track + publish
    let source = NativeVideoSource::new(VideoResolution { width: 1280, height: 720 }, false);
    let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
    room.local_participant()
        .publish_track(LocalTrack::Video(track), TrackPublishOptions {
            source: TrackSource::Screenshare,
            video_codec: VideoCodec::H264,
            ..Default::default()
        })
        .await
        .map_err(|e| format!("Publish failed: {}", e))?;
    eprintln!("[screen-capture] track published, starting WGC for HWND {}", source_id);

    // 3. Start WGC capture thread
    let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<(Vec<u8>, u32, u32)>(2);
    let cr = running.clone();
    std::thread::spawn(move || {
        use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
        use windows_capture::settings::*;
        use windows_capture::window::Window;

        struct H {
            tx: std::sync::mpsc::SyncSender<(Vec<u8>, u32, u32)>,
            running: Arc<AtomicBool>,
            n: u64,
        }
        impl GraphicsCaptureApiHandler for H {
            type Flags = (std::sync::mpsc::SyncSender<(Vec<u8>, u32, u32)>, Arc<AtomicBool>);
            type Error = Box<dyn std::error::Error + Send + Sync>;
            fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
                let (tx, running) = ctx.flags;
                eprintln!("[WGC] handler created");
                Ok(Self { tx, running, n: 0 })
            }
            fn on_frame_arrived(&mut self, frame: &mut windows_capture::frame::Frame, ctrl: windows_capture::graphics_capture_api::InternalCaptureControl) -> Result<(), Self::Error> {
                if !self.running.load(Ordering::SeqCst) { ctrl.stop(); return Ok(()); }
                let w = frame.width();
                let h = frame.height();
                let mut buf = frame.buffer()?;
                let pixels = buf.as_nopadding_buffer()?.to_vec();
                let _ = self.tx.try_send((pixels, w, h));
                self.n += 1;
                if self.n == 1 { eprintln!("[WGC] FIRST FRAME {}x{}", w, h); }
                Ok(())
            }
            fn on_closed(&mut self) -> Result<(), Self::Error> { eprintln!("[WGC] closed"); Ok(()) }
        }

        let win = unsafe { Window::from_raw_hwnd(source_id as *mut std::ffi::c_void) };
        let s = Settings::new(win, CursorCaptureSettings::Default, DrawBorderSettings::Default,
            SecondaryWindowSettings::Default, MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default, ColorFormat::Bgra8, (frame_tx, cr.clone()));
        eprintln!("[WGC] launching...");
        match H::start_free_threaded(s) {
            Ok(c) => { eprintln!("[WGC] running"); let _ = c.wait(); }
            Err(e) => eprintln!("[WGC] FAILED: {:?}", e),
        }
    });

    // 4. Wait for first frame (proves capture works)
    let (first, fw, fh) = frame_rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "No WGC frames in 5s — capture may not support this window".to_string())?;
    eprintln!("[screen-capture] first frame OK {}x{}", fw, fh);

    // Process first frame
    let mut i420 = I420Buffer::new(fw, fh);
    let (sy, su, sv) = i420.strides();
    let (y, u, v) = i420.data_mut();
    yuv_helper::argb_to_i420(&first, fw * 4, y, sy, u, su, v, sv, fw as i32, fh as i32);
    source.capture_frame(&VideoFrame { rotation: VideoRotation::VideoRotation0, buffer: i420, timestamp_us: 0 });

    let _ = app.emit("screen-capture-started", ());

    // 5. Continuous frame loop
    let app2 = app.clone();
    let running2 = running.clone();
    let start = std::time::Instant::now();
    let mut count: u64 = 1;
    loop {
        match frame_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok((bgra, w, h)) => {
                let mut buf = I420Buffer::new(w, h);
                let (sy, su, sv) = buf.strides();
                let (y, u, v) = buf.data_mut();
                yuv_helper::argb_to_i420(&bgra, w * 4, y, sy, u, su, v, sv, w as i32, h as i32);
                source.capture_frame(&VideoFrame {
                    rotation: VideoRotation::VideoRotation0, buffer: buf,
                    timestamp_us: start.elapsed().as_micros() as i64,
                });
                count += 1;
                if count % 60 == 0 {
                    let fps = (count as f64 / start.elapsed().as_secs_f64()) as u32;
                    let _ = app2.emit("screen-capture-stats", ScreenShareStats {
                        fps, width: w, height: h, encoder: "NVENC/H264".into(), status: "active".into(),
                    });
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if !running2.load(Ordering::SeqCst) { break; }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    eprintln!("[screen-capture] done, {} frames", count);
    room.close().await.ok();
    Ok(())
}

pub fn stop_share() {
    let mut state = global_state().lock().unwrap();
    if let Some(handle) = state.take() {
        handle.running.store(false, Ordering::SeqCst);
        eprintln!("[screen-capture] stop requested");
    }
}
