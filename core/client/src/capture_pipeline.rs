//! Shared capture -> SFU publish pipeline.
//! Used by WGC (screen_capture) and DXGI DD (desktop_capture).
//!
//! Eliminates ~100 lines of duplicated LiveKit connect/publish/frame-push
//! code from each capture module. Capture-specific logic (WGC Handler,
//! DXGI OutputDuplication, GPU shaders, anti-MPO) stays in its own module.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

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

/// Shared publisher that connects to the LiveKit SFU, creates a NativeVideoSource,
/// publishes a Camera track, and provides helpers to push BGRA frames and emit stats.
pub struct CapturePublisher {
    room: Room,
    source: NativeVideoSource,
    start_time: Instant,
    frame_count: u64,
    last_pushed: Option<Instant>,
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
                max_framerate: 30.0,
            }),
            ..Default::default()
        };

        room.local_participant()
            .publish_track(LocalTrack::Video(track), publish_options)
            .await
            .map_err(|e| format!("publish failed: {}", e))?;

        eprintln!("[{}] track published, waiting for negotiation...", log_prefix);
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        Ok(Self {
            room,
            source,
            start_time: Instant::now(),
            frame_count: 0,
            last_pushed: None,
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
                max_framerate: 30.0,
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

        Ok(Self {
            room,
            source,
            start_time: Instant::now(),
            frame_count: 0,
            last_pushed: None,
        })
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
