//! Shared capture -> SFU publish pipeline.
//! Used by WGC (screen_capture) and DXGI DD (desktop_capture).
//!
//! Eliminates ~100 lines of duplicated LiveKit connect/publish/frame-push
//! code from each capture module. Capture-specific logic (WGC Handler,
//! DXGI OutputDuplication, GPU shaders, anti-MPO) stays in its own module.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use livekit::prelude::*;
use livekit::webrtc::prelude::*;
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};

// ── Stats ──

#[derive(Serialize, Clone, Debug)]
pub struct CaptureStats {
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub frames: u64,
    pub method: String,
}

// ── CapturePublisher ──

/// Hard cap for the capture push rate when NVENC hardware encode is active.
/// This must match the intended wire publish cap for native screen share.
/// The previous 240fps cap let WGC/DXGI push far above the 30fps publish target
/// in real sessions, which drove Sam's local FPS hit while still reporting a
/// nominal 30fps target in capture-health.
const TARGET_ENCODE_FPS_HARDWARE: f64 = PUBLISH_TARGET_FPS as f64;
const MIN_FRAME_INTERVAL_HARDWARE: Duration =
    Duration::from_nanos((1_000_000_000.0 / TARGET_ENCODE_FPS_HARDWARE) as u64);

/// Soft cap for the capture push rate when OpenH264 software encode is active.
/// Software H264 at 1080p at 60+ fps pins the CPU at ~90-100% and caused
/// Jeff's v0.6.6 crash after ~54 min of sustained load (28K NACKs, CPU
/// cascade into encoder deadline misses). 20 fps is ~30% CPU at 1080p —
/// sustainable indefinitely, still watchable for screen content (text,
/// browsing, video playback where the source is already 24-30 fps).
/// The WGC/DXGI capture loops still run at native refresh for responsive
/// frame delivery; this cap just drops excess frames before conversion.
const TARGET_ENCODE_FPS_SOFTWARE: f64 = 20.0;
const MIN_FRAME_INTERVAL_SOFTWARE: Duration =
    Duration::from_nanos((1_000_000_000.0 / TARGET_ENCODE_FPS_SOFTWARE) as u64);

/// Global flag: true if nvcuda.dll loaded successfully at client startup.
/// When false, the capture pipeline uses MIN_FRAME_INTERVAL_SOFTWARE to
/// prevent CPU saturation under OpenH264 software encode. Set once in
/// main.rs's startup probe and never changes after that.
pub static HAS_NVCUDA: AtomicBool = AtomicBool::new(false);

/// Wire-level publish framerate cap for native screen share.
/// Keep the capture-side pacing aligned with this number so native publishers
/// don't push 100+ fps into WebRTC while the rest of the stack thinks the
/// target is 30fps.
pub const PUBLISH_TARGET_FPS: u32 = 30;

/// Heartbeat interval for WGC/static-content frame duplication.
/// If the real capture path has not pushed a new frame in this long, re-push
/// the most recent BGRA frame so the wire stream stays alive at ~30fps.
const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(33);

/// Shared heartbeat state.
///
/// WGC window capture is event-driven: `on_frame_arrived` only fires when the
/// captured window repaints. Some windows can go effectively wire-silent when
/// their redraw pattern changes even though the user still expects a live
/// stream. The heartbeat thread re-pushes the most recent BGRA frame whenever
/// the real capture path has been idle for longer than HEARTBEAT_INTERVAL.
struct HeartbeatState {
    last_frame: Option<LastFrameBuffer>,
    last_real_push: Instant,
}

struct LastFrameBuffer {
    bgra: Vec<u8>,
    stride: u32,
    width: u32,
    height: u32,
}

struct HeartbeatHandle {
    running: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for HeartbeatHandle {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Shared publisher that connects to the LiveKit SFU, creates a NativeVideoSource,
/// publishes a Camera track, and provides helpers to push BGRA frames and emit stats.
pub struct CapturePublisher {
    room: Room,
    source: NativeVideoSource,
    start_time: Instant,
    frame_count: u64,
    last_pushed: Option<Instant>,
    heartbeat_state: Arc<Mutex<HeartbeatState>>,
    heartbeat_handle: Option<HeartbeatHandle>,
}

impl CapturePublisher {
    /// Connect to the SFU and publish a Camera video track.
    ///
    /// Creates a 1080p (or custom resolution) NativeVideoSource, publishes as
    /// Camera with H264 @ 20Mbps/60fps, and waits 3 seconds for SDP negotiation.
    pub async fn connect_and_publish(
        sfu_url: &str,
        token: &str,
        enc_w: u32,
        enc_h: u32,
        log_prefix: &str,
    ) -> Result<Self, String> {
        eprintln!("[{}] connecting to SFU: {}", log_prefix, sfu_url);

        let (room, _events) = Room::connect(sfu_url, token, RoomOptions::default())
            .await
            .map_err(|e| format!("SFU connect failed: {}", e))?;

        eprintln!(
            "[{}] connected as {}",
            log_prefix,
            room.local_participant().identity().as_str(),
        );

        // Video source at encode resolution — NOT screencast (game streaming prioritizes FPS)
        let source = NativeVideoSource::new(
            VideoResolution {
                width: enc_w,
                height: enc_h,
            },
            false,
        );
        let track = LocalVideoTrack::create_video_track(
            "screen",
            RtcVideoSource::Native(source.clone()),
        );

        let publish_options = TrackPublishOptions {
            source: TrackSource::Camera,
            video_codec: VideoCodec::H264,
            simulcast: false,
            video_encoding: Some(VideoEncoding {
                // Capped at 4 Mbps for multi-publisher rooms. Validated 2026-04-07
                // with 3 simultaneous 1080p shares and a residential-WAN viewer
                // (David) who saw 0fps at 8Mbps. 4Mbps × 3 publishers = 12Mbps
                // aggregate, comfortably under most residential downloads. Per-stream
                // quality at 1080p30 H264 is still excellent for screen content.
                // Twitch source quality reference: 6 Mbps at 1080p60 gameplay.
                max_bitrate: 4_000_000,
                // 2.5 Mbps hard floor — prevents libwebrtc GoogCC from throttling
                // to zero under packet loss / RTT spikes, so the stream stays
                // visible instead of dropping to 0fps and slowly probing back up.
                min_bitrate: 2_500_000,
                // 60fps for safe stable testing with David (remote friend).
                // The level=AUTOSELECT fix is still in h264_encoder_impl.cpp
                // for later 144fps retest on SAM-PC — harmless at 60fps.
                // Capped at 30fps for multi-publisher rooms. With 3 simultaneous
                // 1920x1080 H264 publishers, the cumulative NVDEC decode load
                // and SFU forwarding pressure makes 60fps unsustainable —
                // receivers see 10fps after pacing kicks in. 30fps gives
                // headroom for all parties and is plenty for screen content.
                // Spencer's recommendation, validated 2026-04-07 with 3 sharers.
                max_framerate: PUBLISH_TARGET_FPS as f64,
            }),
            ..Default::default()
        };

        room.local_participant()
            .publish_track(LocalTrack::Video(track), publish_options)
            .await
            .map_err(|e| format!("publish failed: {}", e))?;

        eprintln!("[{}] track published, waiting for negotiation...", log_prefix);
        tokio::time::sleep(Duration::from_secs(3)).await;

        let start_time = Instant::now();
        let heartbeat_state = Arc::new(Mutex::new(HeartbeatState {
            last_frame: None,
            last_real_push: start_time,
        }));
        let heartbeat_handle = Self::spawn_heartbeat(
            heartbeat_state.clone(),
            source.clone(),
            start_time,
            log_prefix,
        );

        Ok(Self {
            room,
            source,
            start_time,
            frame_count: 0,
            last_pushed: None,
            heartbeat_state,
            heartbeat_handle: Some(heartbeat_handle),
        })
    }

    /// Blocking variant for use inside `spawn_blocking` (DXGI DD path).
    ///
    /// Identical to `connect_and_publish` but uses `block_on` + `thread::sleep`
    /// instead of async, since DXGI DD runs on a blocking OS thread.
    pub fn connect_and_publish_blocking(
        rt: &tokio::runtime::Handle,
        sfu_url: &str,
        token: &str,
        enc_w: u32,
        enc_h: u32,
        log_prefix: &str,
    ) -> Result<Self, String> {
        eprintln!("[{}] connecting to SFU: {}", log_prefix, sfu_url);

        let (room, _events) = rt
            .block_on(Room::connect(sfu_url, token, RoomOptions::default()))
            .map_err(|e| format!("SFU connect failed: {}", e))?;

        eprintln!(
            "[{}] connected as {}",
            log_prefix,
            room.local_participant().identity().as_str(),
        );

        let source = NativeVideoSource::new(
            VideoResolution {
                width: enc_w,
                height: enc_h,
            },
            false,
        );
        let track = LocalVideoTrack::create_video_track(
            "screen",
            RtcVideoSource::Native(source.clone()),
        );

        let publish_options = TrackPublishOptions {
            source: TrackSource::Camera,
            video_codec: VideoCodec::H264,
            simulcast: false,
            video_encoding: Some(VideoEncoding {
                // Capped at 4 Mbps for multi-publisher rooms. Validated 2026-04-07
                // with 3 simultaneous 1080p shares and a residential-WAN viewer
                // (David) who saw 0fps at 8Mbps. 4Mbps × 3 publishers = 12Mbps
                // aggregate, comfortably under most residential downloads. Per-stream
                // quality at 1080p30 H264 is still excellent for screen content.
                // Twitch source quality reference: 6 Mbps at 1080p60 gameplay.
                max_bitrate: 4_000_000,
                // 2.5 Mbps hard floor — prevents libwebrtc GoogCC from throttling
                // to zero under packet loss / RTT spikes, so the stream stays
                // visible instead of dropping to 0fps and slowly probing back up.
                min_bitrate: 2_500_000,
                // 60fps for safe stable testing with David (remote friend).
                // The level=AUTOSELECT fix is still in h264_encoder_impl.cpp
                // for later 144fps retest on SAM-PC — harmless at 60fps.
                // Capped at 30fps for multi-publisher rooms. With 3 simultaneous
                // 1920x1080 H264 publishers, the cumulative NVDEC decode load
                // and SFU forwarding pressure makes 60fps unsustainable —
                // receivers see 10fps after pacing kicks in. 30fps gives
                // headroom for all parties and is plenty for screen content.
                // Spencer's recommendation, validated 2026-04-07 with 3 sharers.
                max_framerate: PUBLISH_TARGET_FPS as f64,
            }),
            ..Default::default()
        };

        rt.block_on(
            room.local_participant()
                .publish_track(LocalTrack::Video(track), publish_options),
        )
        .map_err(|e| format!("publish failed: {}", e))?;

        eprintln!("[{}] track published, waiting for negotiation...", log_prefix);
        std::thread::sleep(Duration::from_secs(3));

        let start_time = Instant::now();
        let heartbeat_state = Arc::new(Mutex::new(HeartbeatState {
            last_frame: None,
            last_real_push: start_time,
        }));
        let heartbeat_handle = Self::spawn_heartbeat(
            heartbeat_state.clone(),
            source.clone(),
            start_time,
            log_prefix,
        );

        Ok(Self {
            room,
            source,
            start_time,
            frame_count: 0,
            last_pushed: None,
            heartbeat_state,
            heartbeat_handle: Some(heartbeat_handle),
        })
    }

    fn spawn_heartbeat(
        state: Arc<Mutex<HeartbeatState>>,
        source: NativeVideoSource,
        start_time: Instant,
        log_prefix: &str,
    ) -> HeartbeatHandle {
        let running = Arc::new(AtomicBool::new(true));
        let running_clone = running.clone();
        let log_prefix = log_prefix.to_string();
        let thread = std::thread::Builder::new()
            .name(format!("heartbeat-{}", log_prefix))
            .spawn(move || {
                eprintln!("[{}] heartbeat watchdog started", log_prefix);
                let mut heartbeat_pushes: u64 = 0;
                let mut last_log = Instant::now();

                while running_clone.load(Ordering::Relaxed) {
                    std::thread::sleep(HEARTBEAT_INTERVAL);
                    if !running_clone.load(Ordering::Relaxed) {
                        break;
                    }

                    let snapshot = {
                        let state = match state.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        if state.last_real_push.elapsed() < HEARTBEAT_INTERVAL {
                            None
                        } else {
                            state.last_frame.as_ref().map(|frame| LastFrameBuffer {
                                bgra: frame.bgra.clone(),
                                stride: frame.stride,
                                width: frame.width,
                                height: frame.height,
                            })
                        }
                    };

                    let Some(frame) = snapshot else { continue };

                    let mut i420 = I420Buffer::new(frame.width, frame.height);
                    let (sy, su, sv) = i420.strides();
                    let (y, u, v) = i420.data_mut();
                    yuv_helper::argb_to_i420(
                        &frame.bgra,
                        frame.stride,
                        y,
                        sy,
                        u,
                        su,
                        v,
                        sv,
                        frame.width as i32,
                        frame.height as i32,
                    );

                    let vf = VideoFrame {
                        rotation: VideoRotation::VideoRotation0,
                        buffer: i420,
                        timestamp_us: start_time.elapsed().as_micros() as i64,
                    };
                    source.capture_frame(&vf);
                    heartbeat_pushes += 1;

                    if last_log.elapsed() >= Duration::from_secs(10) {
                        eprintln!(
                            "[{}] heartbeat: {} duplicate frames pushed in last 10s",
                            log_prefix, heartbeat_pushes
                        );
                        heartbeat_pushes = 0;
                        last_log = Instant::now();
                    }
                }

                eprintln!("[{}] heartbeat watchdog stopped", log_prefix);
            })
            .expect("spawn heartbeat thread");

        HeartbeatHandle {
            running,
            thread: Some(thread),
        }
    }

    /// Convert a BGRA frame to I420 via libyuv and push it to the NativeVideoSource.
    ///
    /// `bgra` must be tightly packed (stride = width * 4). For pitched data,
    /// use `push_frame_strided`.
    pub fn push_frame(&mut self, bgra: &[u8], width: u32, height: u32) {
        self.push_frame_strided(bgra, width * 4, width, height);
    }

    /// Convert a BGRA frame with explicit stride to I420 and push to the video source.
    pub fn push_frame_strided(&mut self, bgra: &[u8], stride: u32, width: u32, height: u32) {
        // Pace native capture to the real publish target. Without this, WGC/DXGI
        // can still push well above 30fps on NVENC systems and drag local FPS down.
        let min_interval = if HAS_NVCUDA.load(Ordering::Relaxed) {
            MIN_FRAME_INTERVAL_HARDWARE
        } else {
            MIN_FRAME_INTERVAL_SOFTWARE
        };
        let now = Instant::now();
        if let Some(last) = self.last_pushed {
            if now.duration_since(last) < min_interval {
                return; // drop this frame
            }
        }
        self.last_pushed = Some(now);

        let mut i420 = I420Buffer::new(width, height);
        let (sy, su, sv) = i420.strides();
        let (y, u, v) = i420.data_mut();

        yuv_helper::argb_to_i420(
            bgra, stride, y, sy, u, su, v, sv,
            width as i32, height as i32,
        );

        let vf = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            buffer: i420,
            timestamp_us: self.start_time.elapsed().as_micros() as i64,
        };
        self.source.capture_frame(&vf);
        self.frame_count += 1;

        if let Ok(mut state) = self.heartbeat_state.lock() {
            state.last_real_push = now;
            state.last_frame = Some(LastFrameBuffer {
                bgra: bgra.to_vec(),
                stride,
                width,
                height,
            });
        }
    }

    /// Emit stats via Tauri event every `every_n` frames. Returns current FPS.
    ///
    /// Call this after every `push_frame`. It's a no-op unless `frame_count % every_n == 0`.
    pub fn maybe_emit_stats(
        &self,
        app: &AppHandle,
        event_name: &str,
        method: &str,
        width: u32,
        height: u32,
        every_n: u64,
    ) -> Option<u32> {
        if self.frame_count == 0 || self.frame_count % every_n != 0 {
            return None;
        }
        let elapsed = self.start_time.elapsed().as_secs_f64();
        let fps = if elapsed > 0.0 {
            (self.frame_count as f64 / elapsed) as u32
        } else {
            0
        };
        let _ = app.emit(
            event_name,
            CaptureStats {
                fps,
                width,
                height,
                frames: self.frame_count,
                method: method.to_string(),
            },
        );
        Some(fps)
    }

    /// Current cumulative frame count.
    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }

    /// Elapsed time since the publisher was created.
    pub fn elapsed(&self) -> Duration {
        self.start_time.elapsed()
    }

    /// Close the SFU room connection.
    pub async fn shutdown(self) {
        let Self {
            room,
            heartbeat_handle,
            ..
        } = self;
        drop(heartbeat_handle);
        room.close().await.ok();
    }

    /// Blocking variant of shutdown for use inside `spawn_blocking`.
    pub fn shutdown_blocking(self, rt: &tokio::runtime::Handle) {
        let Self {
            room,
            heartbeat_handle,
            ..
        } = self;
        drop(heartbeat_handle);
        rt.block_on(room.close()).ok();
    }
}
