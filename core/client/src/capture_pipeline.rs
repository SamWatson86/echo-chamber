//! Shared capture -> SFU publish pipeline.
//! Used by WGC (screen_capture) and DXGI DD (desktop_capture).
//!
//! Eliminates ~100 lines of duplicated LiveKit connect/publish/frame-push
//! code from each capture module. Capture-specific logic (WGC Handler,
//! DXGI OutputDuplication, GPU shaders, anti-MPO) stays in its own module.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::file_debug_log;
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::*;
use livekit::webrtc::stats::RtcStats;
use livekit::webrtc::video_source::native::NativeVideoSource;

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

/// Soft cap for the capture push rate when OpenH264 software encode is active.
/// Software H264 at 1080p at 60+ fps pins the CPU at ~90-100% and caused
/// Jeff's v0.6.6 crash after ~54 min of sustained load (28K NACKs, CPU
/// cascade into encoder deadline misses). 20 fps is ~30% CPU at 1080p —
/// sustainable indefinitely, still watchable for screen content (text,
/// browsing, video playback where the source is already 24-30 fps).
/// The WGC/DXGI capture loops still run at native refresh for responsive
/// frame delivery; this cap just drops excess frames before conversion.
const TARGET_ENCODE_FPS_SOFTWARE: f64 = 20.0;
const MIN_FRAME_INTERVAL_SOFTWARE: std::time::Duration =
    std::time::Duration::from_nanos((1_000_000_000.0 / TARGET_ENCODE_FPS_SOFTWARE) as u64);

/// Global flag: true if nvcuda.dll loaded successfully at client startup.
/// When false, the capture pipeline uses MIN_FRAME_INTERVAL_SOFTWARE to
/// prevent CPU saturation under OpenH264 software encode. Set once in
/// main.rs's startup probe and never changes after that.
pub static HAS_NVCUDA: AtomicBool = AtomicBool::new(false);

/// Desktop wire-level publish framerate cap. Game/window capture can opt into
/// the high-motion profile below. The capture loop runs at native display
/// refresh rate (often 144+ Hz), but the publisher paces frames to the selected
/// profile's wire target.
pub const PUBLISH_TARGET_FPS: u32 = 30;
pub const GAME_PUBLISH_TARGET_FPS: u32 = 60;
pub const STATIC_FRAME_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PublishProfile {
    Desktop,
    Game,
}

impl Default for PublishProfile {
    fn default() -> Self {
        Self::Desktop
    }
}

impl PublishProfile {
    pub fn target_fps(self) -> u32 {
        match self {
            Self::Desktop => PUBLISH_TARGET_FPS,
            Self::Game => GAME_PUBLISH_TARGET_FPS,
        }
    }

    fn max_bitrate(self) -> u64 {
        match self {
            Self::Desktop => 4_000_000,
            Self::Game => 8_000_000,
        }
    }

    fn min_bitrate(self) -> u64 {
        match self {
            Self::Desktop => 2_500_000,
            Self::Game => 3_000_000,
        }
    }

    fn hardware_min_frame_interval(self) -> Duration {
        Duration::from_nanos((1_000_000_000.0 / self.target_fps() as f64) as u64)
    }
}

/// Shared publisher that connects to the LiveKit SFU, creates a NativeVideoSource,
/// publishes a caller-selected video track, and provides helpers to push BGRA frames
/// and emit stats.
pub struct CapturePublisher {
    room: Room,
    source: NativeVideoSource,
    track: LocalVideoTrack,
    start_time: Instant,
    frame_count: u64,
    next_push_at: Option<Instant>,
    hardware_min_frame_interval: Duration,
}

fn should_push_frame_at_deadline(
    now: Instant,
    next_push_at: &mut Option<Instant>,
    min_interval: Duration,
) -> bool {
    let Some(next) = next_push_at else {
        *next_push_at = Some(now + min_interval);
        return true;
    };

    if now < *next {
        return false;
    }

    while *next <= now {
        *next += min_interval;
    }
    true
}

pub(crate) struct StaticFrameHeartbeat {
    interval: Duration,
    last_fresh_frame_at: Option<Instant>,
    last_heartbeat_at: Option<Instant>,
}

impl StaticFrameHeartbeat {
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_fresh_frame_at: None,
            last_heartbeat_at: None,
        }
    }

    pub(crate) fn record_fresh_frame(&mut self, now: Instant) {
        self.last_fresh_frame_at = Some(now);
        self.last_heartbeat_at = None;
    }

    pub(crate) fn should_publish(&mut self, now: Instant) -> bool {
        let Some(last_fresh_frame_at) = self.last_fresh_frame_at else {
            return false;
        };
        let last_publish_at = self.last_heartbeat_at.unwrap_or(last_fresh_frame_at);
        if now.duration_since(last_publish_at) < self.interval {
            return false;
        }
        self.last_heartbeat_at = Some(now);
        true
    }
}

async fn log_room_events(log_prefix: String, mut events: UnboundedReceiver<RoomEvent>) {
    while let Some(event) = events.recv().await {
        match event {
            RoomEvent::LocalTrackPublished { publication, .. } => {
                let line = format!(
                    "[{}] room-event local-track-published sid={} source={:?}",
                    log_prefix,
                    publication.sid(),
                    publication.source(),
                );
                eprintln!("{}", line);
                file_debug_log::append(&line);
            }
            RoomEvent::LocalTrackSubscribed { track } => {
                let line = format!(
                    "[{}] room-event local-track-subscribed sid={} kind={:?}",
                    log_prefix,
                    track.sid(),
                    track.kind(),
                );
                eprintln!("{}", line);
                file_debug_log::append(&line);
            }
            _ => {}
        }
    }
}

impl CapturePublisher {
    /// Connect to the SFU and publish a caller-selected video track.
    ///
    /// Creates a 1080p (or custom resolution) NativeVideoSource, publishes with
    /// H264, and waits 3 seconds for SDP negotiation.
    pub async fn connect_and_publish(
        sfu_url: &str,
        token: &str,
        enc_w: u32,
        enc_h: u32,
        publish_profile: PublishProfile,
        log_prefix: &str,
        track_source: TrackSource,
        is_screencast: bool,
    ) -> Result<Self, String> {
        eprintln!("[{}] connecting to SFU: {}", log_prefix, sfu_url);
        file_debug_log::append(&format!(
            "[{}] connect_and_publish start sfu_url={} enc={}x{} profile={:?} target_fps={} max_bitrate={} min_bitrate={}",
            log_prefix,
            sfu_url,
            enc_w,
            enc_h,
            publish_profile,
            publish_profile.target_fps(),
            publish_profile.max_bitrate(),
            publish_profile.min_bitrate()
        ));

        let (room, events) = Room::connect(sfu_url, token, RoomOptions::default())
            .await
            .map_err(|e| format!("SFU connect failed: {}", e))?;
        tokio::spawn(log_room_events(log_prefix.to_string(), events));

        eprintln!(
            "[{}] connected as {}",
            log_prefix,
            room.local_participant().identity().as_str(),
        );
        file_debug_log::append(&format!(
            "[{}] connected as {}",
            log_prefix,
            room.local_participant().identity().as_str()
        ));

        // Source profile is caller-controlled so DXGI/WGC screen shares can use
        // screencast semantics while legacy motion/game paths keep Fluid behavior.
        let source = NativeVideoSource::new(
            VideoResolution {
                width: enc_w,
                height: enc_h,
            },
            is_screencast,
        );
        let track =
            LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));

        let publish_options = TrackPublishOptions {
            source: track_source,
            video_codec: VideoCodec::H264,
            simulcast: false,
            video_encoding: Some(VideoEncoding {
                // Desktop uses the conservative multi-publisher budget validated
                // 2026-04-07. Game shares opt into a higher-motion bitrate budget.
                max_bitrate: publish_profile.max_bitrate(),
                // 2.5 Mbps hard floor — prevents libwebrtc GoogCC from throttling
                // to zero under packet loss / RTT spikes, so the stream stays
                // visible instead of dropping to 0fps and slowly probing back up.
                min_bitrate: publish_profile.min_bitrate(),
                // Profile-selected wire target: desktop stays conservative;
                // game/window capture gets the high-motion 60fps path.
                max_framerate: publish_profile.target_fps() as f64,
            }),
            ..Default::default()
        };

        let publication = room
            .local_participant()
            .publish_track(LocalTrack::Video(track.clone()), publish_options)
            .await
            .map_err(|e| format!("publish failed: {}", e))?;

        eprintln!(
            "[{}] track published sid={} source={:?}, waiting for negotiation...",
            log_prefix,
            publication.sid(),
            publication.source(),
        );
        file_debug_log::append(&format!(
            "[{}] track published sid={} source={:?}",
            log_prefix,
            publication.sid(),
            publication.source(),
        ));
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        Ok(Self {
            room,
            source,
            track,
            start_time: Instant::now(),
            frame_count: 0,
            next_push_at: None,
            hardware_min_frame_interval: publish_profile.hardware_min_frame_interval(),
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
        publish_profile: PublishProfile,
        log_prefix: &str,
        track_source: TrackSource,
        is_screencast: bool,
    ) -> Result<Self, String> {
        eprintln!("[{}] connecting to SFU: {}", log_prefix, sfu_url);
        file_debug_log::append(&format!(
            "[{}] connect_and_publish_blocking start sfu_url={} enc={}x{} profile={:?} target_fps={} max_bitrate={} min_bitrate={}",
            log_prefix,
            sfu_url,
            enc_w,
            enc_h,
            publish_profile,
            publish_profile.target_fps(),
            publish_profile.max_bitrate(),
            publish_profile.min_bitrate()
        ));

        let (room, events) = rt
            .block_on(Room::connect(sfu_url, token, RoomOptions::default()))
            .map_err(|e| format!("SFU connect failed: {}", e))?;
        rt.spawn(log_room_events(log_prefix.to_string(), events));

        eprintln!(
            "[{}] connected as {}",
            log_prefix,
            room.local_participant().identity().as_str(),
        );
        file_debug_log::append(&format!(
            "[{}] connected as {}",
            log_prefix,
            room.local_participant().identity().as_str()
        ));

        let source = NativeVideoSource::new(
            VideoResolution {
                width: enc_w,
                height: enc_h,
            },
            is_screencast,
        );
        let track =
            LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));

        let publish_options = TrackPublishOptions {
            source: track_source,
            video_codec: VideoCodec::H264,
            simulcast: false,
            video_encoding: Some(VideoEncoding {
                // Desktop uses the conservative multi-publisher budget validated
                // 2026-04-07. Game shares opt into a higher-motion bitrate budget.
                max_bitrate: publish_profile.max_bitrate(),
                // 2.5 Mbps hard floor — prevents libwebrtc GoogCC from throttling
                // to zero under packet loss / RTT spikes, so the stream stays
                // visible instead of dropping to 0fps and slowly probing back up.
                min_bitrate: publish_profile.min_bitrate(),
                // Profile-selected wire target: desktop stays conservative;
                // game/window capture gets the high-motion 60fps path.
                max_framerate: publish_profile.target_fps() as f64,
            }),
            ..Default::default()
        };

        let publication = rt
            .block_on(
                room.local_participant()
                    .publish_track(LocalTrack::Video(track.clone()), publish_options),
            )
            .map_err(|e| format!("publish failed: {}", e))?;

        eprintln!(
            "[{}] track published sid={} source={:?}, waiting for negotiation...",
            log_prefix,
            publication.sid(),
            publication.source(),
        );
        file_debug_log::append(&format!(
            "[{}] track published sid={} source={:?}",
            log_prefix,
            publication.sid(),
            publication.source(),
        ));
        std::thread::sleep(std::time::Duration::from_secs(3));

        Ok(Self {
            room,
            source,
            track,
            start_time: Instant::now(),
            frame_count: 0,
            next_push_at: None,
            hardware_min_frame_interval: publish_profile.hardware_min_frame_interval(),
        })
    }

    /// Convert a BGRA frame to I420 via libyuv and push it to the NativeVideoSource.
    ///
    /// `bgra` must be tightly packed (stride = width * 4). For pitched data,
    /// use `push_frame_strided`.
    pub fn push_frame(&mut self, bgra: &[u8], width: u32, height: u32) -> bool {
        self.push_frame_strided(bgra, width * 4, width, height)
    }

    /// Convert a BGRA frame with explicit stride to I420 and push to the video source.
    pub fn push_frame_strided(
        &mut self,
        bgra: &[u8],
        stride: u32,
        width: u32,
        height: u32,
    ) -> bool {
        // Frame rate limiter — choose the interval based on whether we have
        // hardware (NVENC) or software (OpenH264) encoding. NVENC can handle
        // 240fps input because it's a dedicated ASIC. OpenH264 runs on CPU
        // and pins ~90-100% at 60+ fps 1080p — which crashed Jeff's AMD
        // machine after ~54 min of sustained load. Cap software encode at
        // 20fps to keep CPU at a sustainable ~30%.
        let min_interval = if HAS_NVCUDA.load(Ordering::Relaxed) {
            self.hardware_min_frame_interval
        } else {
            MIN_FRAME_INTERVAL_SOFTWARE
        };
        if !should_push_frame_at_deadline(Instant::now(), &mut self.next_push_at, min_interval) {
            return false; // drop this frame
        }

        let mut i420 = I420Buffer::new(width, height);
        let (sy, su, sv) = i420.strides();
        let (y, u, v) = i420.data_mut();

        yuv_helper::argb_to_i420(
            bgra,
            stride,
            y,
            sy,
            u,
            su,
            v,
            sv,
            width as i32,
            height as i32,
        );

        let vf = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            buffer: i420,
            timestamp_us: self.start_time.elapsed().as_micros() as i64,
        };
        self.source.capture_frame(&vf);
        self.frame_count += 1;
        true
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

    pub async fn log_sender_stats(&self, log_prefix: &str) {
        match self.track.get_stats().await {
            Ok(stats) => {
                let transport = stats.iter().find_map(|stat| match stat {
                    RtcStats::Transport(transport) => Some(transport),
                    _ => None,
                });
                let codec_by_id: std::collections::HashMap<_, _> = stats
                    .iter()
                    .filter_map(|stat| match stat {
                        RtcStats::Codec(codec) => Some((codec.rtc.id.as_str(), codec)),
                        _ => None,
                    })
                    .collect();
                let candidate_pair_by_id: std::collections::HashMap<_, _> = stats
                    .iter()
                    .filter_map(|stat| match stat {
                        RtcStats::CandidatePair(pair) => Some((pair.rtc.id.as_str(), pair)),
                        _ => None,
                    })
                    .collect();
                let local_candidate_by_id: std::collections::HashMap<_, _> = stats
                    .iter()
                    .filter_map(|stat| match stat {
                        RtcStats::LocalCandidate(candidate) => {
                            Some((candidate.rtc.id.as_str(), candidate))
                        }
                        _ => None,
                    })
                    .collect();
                let remote_candidate_by_id: std::collections::HashMap<_, _> = stats
                    .iter()
                    .filter_map(|stat| match stat {
                        RtcStats::RemoteCandidate(candidate) => {
                            Some((candidate.rtc.id.as_str(), candidate))
                        }
                        _ => None,
                    })
                    .collect();
                let outbound = stats.iter().find_map(|stat| match stat {
                    RtcStats::OutboundRtp(outbound) => Some(outbound),
                    _ => None,
                });
                if let Some(outbound) = outbound {
                    let codec = codec_by_id.get(outbound.stream.codec_id.as_str()).copied();
                    let remote_inbound = if outbound.outbound.remote_id.is_empty() {
                        None
                    } else {
                        stats.iter().find_map(|stat| match stat {
                            RtcStats::RemoteInboundRtp(remote)
                                if remote.rtc.id == outbound.outbound.remote_id =>
                            {
                                Some(remote)
                            }
                            _ => None,
                        })
                    };
                    let codec_name = codec
                        .map(|codec| codec.codec.mime_type.as_str())
                        .filter(|mime| !mime.is_empty())
                        .unwrap_or("<unknown>");
                    let codec_fmtp = codec
                        .map(|codec| codec.codec.sdp_fmtp_line.as_str())
                        .filter(|fmtp| !fmtp.is_empty())
                        .unwrap_or("<none>");
                    let remote_fraction_lost = remote_inbound
                        .map(|remote| format!("{:.3}", remote.remote_inbound.fraction_lost))
                        .unwrap_or_else(|| "<none>".to_string());
                    let remote_rtt = remote_inbound
                        .map(|remote| format!("{:.3}", remote.remote_inbound.round_trip_time))
                        .unwrap_or_else(|| "<none>".to_string());
                    let sender_line = format!(
                        "[{}] sender-stats bytes={} packets={} frames_sent={} frames_encoded={} key_frames={} fps={:.1} active={} size={}x{} target_bitrate={:.0} encoder={} codec={} fmtp={} quality={:?} nack={} fir={} pli={} remote_fraction_lost={} remote_rtt={}",
                        log_prefix,
                        outbound.sent.bytes_sent,
                        outbound.sent.packets_sent,
                        outbound.outbound.frames_sent,
                        outbound.outbound.frames_encoded,
                        outbound.outbound.key_frames_encoded,
                        outbound.outbound.frames_per_second,
                        outbound.outbound.active,
                        outbound.outbound.frame_width,
                        outbound.outbound.frame_height,
                        outbound.outbound.target_bitrate,
                        outbound.outbound.encoder_implementation,
                        codec_name,
                        codec_fmtp,
                        outbound.outbound.quality_limitation_reason,
                        outbound.outbound.nack_count,
                        outbound.outbound.fir_count,
                        outbound.outbound.pli_count,
                        remote_fraction_lost,
                        remote_rtt,
                    );
                    eprintln!("{}", sender_line);
                    file_debug_log::append(&sender_line);
                } else {
                    eprintln!("[{}] sender-stats no outbound RTP report", log_prefix);
                    file_debug_log::append(&format!(
                        "[{}] sender-stats no outbound RTP report",
                        log_prefix
                    ));
                }

                if let Some(transport) = transport {
                    let selected_pair_id = transport.transport.selected_candidate_pair_id.as_str();
                    let selected_pair = candidate_pair_by_id.get(selected_pair_id).copied();
                    let local_candidate = selected_pair.and_then(|pair| {
                        local_candidate_by_id
                            .get(pair.candidate_pair.local_candidate_id.as_str())
                            .copied()
                    });
                    let remote_candidate = selected_pair.and_then(|pair| {
                        remote_candidate_by_id
                            .get(pair.candidate_pair.remote_candidate_id.as_str())
                            .copied()
                    });

                    eprintln!(
                        "[{}] transport ice={:?} dtls={:?} bytes_sent={} bytes_recv={} selected_pair={}",
                        log_prefix,
                        transport.transport.ice_state,
                        transport.transport.dtls_state,
                        transport.transport.bytes_sent,
                        transport.transport.bytes_received,
                        if selected_pair_id.is_empty() { "<none>" } else { selected_pair_id },
                    );
                    file_debug_log::append(&format!(
                        "[{}] transport ice={:?} dtls={:?} bytes_sent={} bytes_recv={} selected_pair={}",
                        log_prefix,
                        transport.transport.ice_state,
                        transport.transport.dtls_state,
                        transport.transport.bytes_sent,
                        transport.transport.bytes_received,
                        if selected_pair_id.is_empty() { "<none>" } else { selected_pair_id },
                    ));

                    if let Some(pair) = selected_pair {
                        eprintln!(
                            "[{}] candidate-pair state={:?} nominated={} bytes_sent={} bytes_recv={} current_rtt={:.3} out_bitrate={:.0}",
                            log_prefix,
                            pair.candidate_pair.state,
                            pair.candidate_pair.nominated,
                            pair.candidate_pair.bytes_sent,
                            pair.candidate_pair.bytes_received,
                            pair.candidate_pair.current_round_trip_time,
                            pair.candidate_pair.available_outgoing_bitrate,
                        );
                        file_debug_log::append(&format!(
                            "[{}] candidate-pair state={:?} nominated={} bytes_sent={} bytes_recv={} current_rtt={:.3} out_bitrate={:.0}",
                            log_prefix,
                            pair.candidate_pair.state,
                            pair.candidate_pair.nominated,
                            pair.candidate_pair.bytes_sent,
                            pair.candidate_pair.bytes_received,
                            pair.candidate_pair.current_round_trip_time,
                            pair.candidate_pair.available_outgoing_bitrate,
                        ));
                    } else {
                        eprintln!(
                            "[{}] candidate-pair missing for selected transport pair",
                            log_prefix
                        );
                        file_debug_log::append(&format!(
                            "[{}] candidate-pair missing for selected transport pair",
                            log_prefix
                        ));
                    }

                    if let Some(local) = local_candidate {
                        eprintln!(
                            "[{}] local-candidate type={:?} protocol={} addr={}:{}",
                            log_prefix,
                            local.local_candidate.candidate_type,
                            local.local_candidate.protocol,
                            local.local_candidate.address,
                            local.local_candidate.port,
                        );
                    }
                    if let Some(remote) = remote_candidate {
                        eprintln!(
                            "[{}] remote-candidate type={:?} protocol={} addr={}:{}",
                            log_prefix,
                            remote.remote_candidate.candidate_type,
                            remote.remote_candidate.protocol,
                            remote.remote_candidate.address,
                            remote.remote_candidate.port,
                        );
                    }
                } else {
                    eprintln!("[{}] transport stats missing", log_prefix);
                    file_debug_log::append(&format!("[{}] transport stats missing", log_prefix));
                }
            }
            Err(e) => {
                eprintln!("[{}] sender-stats error: {}", log_prefix, e);
                file_debug_log::append(&format!("[{}] sender-stats error: {}", log_prefix, e));
            }
        }
    }

    pub fn log_sender_stats_blocking(&self, rt: &tokio::runtime::Handle, log_prefix: &str) {
        rt.block_on(self.log_sender_stats(log_prefix));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_profile_stays_conservative() {
        assert_eq!(PublishProfile::Desktop.target_fps(), PUBLISH_TARGET_FPS);
        assert_eq!(PublishProfile::Desktop.max_bitrate(), 4_000_000);
        assert_eq!(PublishProfile::Desktop.min_bitrate(), 2_500_000);
    }

    #[test]
    fn game_profile_is_high_motion() {
        let profile: PublishProfile = serde_json::from_str("\"game\"").expect("game profile");

        assert_eq!(profile, PublishProfile::Game);
        assert_eq!(profile.target_fps(), 60);
        assert_eq!(profile.max_bitrate(), 8_000_000);
        assert_eq!(profile.min_bitrate(), 3_000_000);
    }

    fn pushed_frame_count(source_hz: u32, target_hz: u32, seconds: u32) -> usize {
        let start = Instant::now();
        let source_interval_ns = (1_000_000_000.0 / source_hz as f64) as u64;
        let target_interval = Duration::from_nanos((1_000_000_000.0 / target_hz as f64) as u64);
        let mut next_push_at = None;

        (0..source_hz * seconds)
            .filter(|frame| {
                let now = start + Duration::from_nanos(source_interval_ns * *frame as u64);
                should_push_frame_at_deadline(now, &mut next_push_at, target_interval)
            })
            .count()
    }

    #[test]
    fn frame_deadline_pacer_preserves_60fps_from_144hz_capture() {
        assert_eq!(pushed_frame_count(144, 60, 1), 60);
    }

    #[test]
    fn frame_deadline_pacer_preserves_30fps_from_120hz_capture() {
        assert_eq!(pushed_frame_count(120, 30, 1), 30);
    }

    #[test]
    fn static_frame_heartbeat_waits_until_a_frame_exists() {
        let start = Instant::now();
        let mut heartbeat = StaticFrameHeartbeat::new(Duration::from_millis(200));

        assert!(!heartbeat.should_publish(start + Duration::from_secs(1)));
    }

    #[test]
    fn static_frame_heartbeat_republishes_after_static_interval() {
        let start = Instant::now();
        let mut heartbeat = StaticFrameHeartbeat::new(Duration::from_millis(200));

        heartbeat.record_fresh_frame(start);

        assert!(!heartbeat.should_publish(start + Duration::from_millis(199)));
        assert!(heartbeat.should_publish(start + Duration::from_millis(200)));
        assert!(!heartbeat.should_publish(start + Duration::from_millis(399)));
        assert!(heartbeat.should_publish(start + Duration::from_millis(400)));
    }

    #[test]
    fn static_frame_heartbeat_fresh_frame_resets_deadline() {
        let start = Instant::now();
        let mut heartbeat = StaticFrameHeartbeat::new(Duration::from_millis(200));

        heartbeat.record_fresh_frame(start);
        assert!(heartbeat.should_publish(start + Duration::from_millis(250)));

        heartbeat.record_fresh_frame(start + Duration::from_millis(300));

        assert!(!heartbeat.should_publish(start + Duration::from_millis(499)));
        assert!(heartbeat.should_publish(start + Duration::from_millis(500)));
    }
}
