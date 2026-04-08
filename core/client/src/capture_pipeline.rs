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

/// Hard cap for the capture push rate. Set to 240fps so 144Hz/165Hz/240Hz
/// monitors push their full native rate without being throttled. NVENC is
/// initialized at the same rate via VideoEncoding.max_framerate so its
/// bitrate-per-frame budget matches reality.
const TARGET_ENCODE_FPS: f64 = 240.0;
const MIN_FRAME_INTERVAL: std::time::Duration =
    std::time::Duration::from_nanos((1_000_000_000.0 / TARGET_ENCODE_FPS) as u64);

/// Wire-level publish framerate cap. The capture loop runs at native display
/// refresh rate (often 144+ Hz) but NVENC's frame_drop=1 throttles the wire
/// output to this rate. This is the "target" the capture-health classifier
/// compares current capture FPS against — if capture drops far below this
/// number something upstream is starving the pipeline.
pub const PUBLISH_TARGET_FPS: u32 = 30;

/// Heartbeat interval for the static-content frame-duplication watchdog.
/// If no new frame has been pushed for this long, the heartbeat thread
/// re-pushes the last captured frame to keep the wire rate at target fps.
/// See HeartbeatState below for the full rationale.
const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(33); // ~30 fps

/// Shared state for the heartbeat frame-duplication watchdog.
///
/// Problem: WGC window capture is event-driven. `on_frame_arrived` only fires
/// when DWM actually repaints the captured window. A static browser page may
/// go 10+ seconds without any repaints, during which nothing is pushed to the
/// NativeVideoSource. Without new frames, the WebRTC wire output goes silent
/// and subscribers see a frozen last frame forever (confirmed by Sam with
/// David's live friend session 2026-04-08: "Davids stream will actually STOP
/// completely unless he moves his mouse").
///
/// Fix: a dedicated thread wakes every HEARTBEAT_INTERVAL (~33 ms) and, if
/// the real capture loop hasn't pushed anything in that long, re-pushes the
/// last captured BGRA buffer. NVENC's internal same-frame detection + inter-
/// frame compression means repeated identical frames encode to near-zero
/// bandwidth (just a small skip-frame marker), so the only cost is:
///   - ~8 MB per push for the BGRA buffer clone (~240 MB/s sustained at 30fps)
///   - One extra I420 conversion per heartbeat tick
/// Both are well within capture-path budgets.
///
/// DXGI Desktop Duplication is unaffected because its push cadence is always
/// >30 fps — the heartbeat condition (">33 ms since last push") is never
/// satisfied in practice, so the heartbeat thread silently no-ops.
struct HeartbeatState {
    /// Most recent captured BGRA frame, or None if capture hasn't started.
    last_frame: Option<LastFrameBuffer>,
    /// When the real capture path last called push_frame_strided.
    last_real_push: Instant,
}

/// Owned copy of the last BGRA frame for heartbeat re-pushing.
struct LastFrameBuffer {
    bgra: Vec<u8>,
    stride: u32,
    width: u32,
    height: u32,
}

/// Handle to the heartbeat watchdog thread; dropped on shutdown.
struct HeartbeatHandle {
    running: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for HeartbeatHandle {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(h) = self.thread.take() {
            let _ = h.join();
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
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

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
        std::thread::sleep(std::time::Duration::from_secs(3));

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

    /// Spawn the heartbeat frame-duplication watchdog thread.
    ///
    /// Wakes every HEARTBEAT_INTERVAL. If no real frame has been pushed in
    /// that long, re-converts and re-pushes the last stored BGRA frame to
    /// the NativeVideoSource. Silently no-ops when the real capture loop
    /// is pushing faster than heartbeat rate (DXGI DD path). Stops when
    /// `running` atomic flips to false (set by HeartbeatHandle::drop).
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

                    // Snapshot the stored frame + last-push time under a short lock.
                    // Clone the BGRA bytes out so we can do the I420 conversion
                    // outside the lock (avoid blocking the real capture path).
                    let snapshot = {
                        let s = match state.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        if s.last_real_push.elapsed() < HEARTBEAT_INTERVAL {
                            // Real capture pushed recently — nothing to do.
                            None
                        } else {
                            s.last_frame.as_ref().map(|f| LastFrameBuffer {
                                bgra: f.bgra.clone(),
                                stride: f.stride,
                                width: f.width,
                                height: f.height,
                            })
                        }
                    };

                    let Some(frame) = snapshot else { continue };

                    // Rebuild I420 and push outside the lock.
                    let mut i420 = I420Buffer::new(frame.width, frame.height);
                    let (sy, su, sv) = i420.strides();
                    let (y, u, v) = i420.data_mut();
                    yuv_helper::argb_to_i420(
                        &frame.bgra, frame.stride, y, sy, u, su, v, sv,
                        frame.width as i32, frame.height as i32,
                    );
                    let vf = VideoFrame {
                        rotation: VideoRotation::VideoRotation0,
                        buffer: i420,
                        timestamp_us: start_time.elapsed().as_micros() as i64,
                    };
                    source.capture_frame(&vf);
                    heartbeat_pushes += 1;

                    // Periodic log so we can see it working in the field.
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
        // Frame rate limiter — drop frames if we'd exceed TARGET_ENCODE_FPS.
        // NVENC is initialized at 60fps; pushing 143fps from a high-refresh
        // monitor causes pacer overflow and visual corruption (smearing).
        // Dropping frames in software is the cleanest fix because NVENC
        // rejects runtime fps reconfiguration and the rate control math
        // assumes the configured framerate.
        let now = Instant::now();
        if let Some(last) = self.last_pushed {
            if now.duration_since(last) < MIN_FRAME_INTERVAL {
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

        // Update the heartbeat watchdog state so it knows a real frame was
        // just pushed (suppresses duplicate pushes) and has a fresh BGRA
        // snapshot available if the capture goes silent. The clone is a
        // flat memcpy of ~8MB for 1080p BGRA — at 30-60 fps this is
        // 240-500 MB/s of memory bandwidth, well within capture budgets.
        // Done AFTER capture_frame so a slow lock here never stalls the
        // real wire output.
        if let Ok(mut s) = self.heartbeat_state.lock() {
            s.last_real_push = now;
            // Only clone+store if the dimensions changed OR we don't have
            // a stored frame yet. Avoids the 8MB memcpy on every push when
            // the window size is stable (the common case).
            let needs_refresh = match &s.last_frame {
                None => true,
                Some(f) => f.width != width || f.height != height || f.stride != stride,
            };
            // Always refresh the BGRA on every real push so the heartbeat
            // re-pushes the MOST RECENT captured frame, not a stale one.
            // If memory bandwidth becomes an issue, we could gate this on
            // "last refresh was > X ms ago" but for now correctness wins.
            let _ = needs_refresh; // silence unused — see comment
            s.last_frame = Some(LastFrameBuffer {
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
    pub fn elapsed(&self) -> std::time::Duration {
        self.start_time.elapsed()
    }

    /// Close the SFU room connection.
    pub async fn shutdown(self) {
        self.room.close().await.ok();
    }

    /// Blocking variant of shutdown for use inside `spawn_blocking`.
    pub fn shutdown_blocking(self, rt: &tokio::runtime::Handle) {
        rt.block_on(self.room.close()).ok();
    }
}
