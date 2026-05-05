use crate::file_debug_log;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativePresenterMode {
    Off,
    On,
    Auto,
}

impl NativePresenterMode {
    pub(crate) fn from_setting(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "on" => Self::On,
            "auto" => Self::Auto,
            _ => Self::Off,
        }
    }
}

impl Default for NativePresenterMode {
    fn default() -> Self {
        Self::Off
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct NativePresenterTileRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) scale_factor: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct NativePresenterStartRequest {
    pub(crate) mode: NativePresenterMode,
    pub(crate) room: String,
    pub(crate) sfu_url: String,
    pub(crate) token: String,
    #[serde(default)]
    pub(crate) viewer_token: Option<String>,
    pub(crate) viewer_identity: String,
    #[serde(default)]
    pub(crate) viewer_name: Option<String>,
    #[serde(default)]
    pub(crate) control_url: Option<String>,
    pub(crate) participant_identity: String,
    pub(crate) track_sid: String,
    pub(crate) tile: NativePresenterTileRect,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativePresenterState {
    Disabled,
    Starting,
    Receiving,
    Fallback,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct NativePresenterStatus {
    pub(crate) state: NativePresenterState,
    pub(crate) render_path: String,
    pub(crate) target_identity: Option<String>,
    pub(crate) target_track_sid: Option<String>,
    pub(crate) native_receive_fps: Option<f64>,
    pub(crate) native_presented_fps: Option<f64>,
    pub(crate) native_frames_received: u64,
    pub(crate) native_frames_dropped: u64,
    pub(crate) queue_depth: u32,
    pub(crate) tile_width: Option<u32>,
    pub(crate) tile_height: Option<u32>,
    pub(crate) fallback_reason: Option<String>,
    pub(crate) updated_at_ms: u64,
}

#[derive(Serialize)]
struct NativePresenterStatsReportPayload<'a> {
    identity: &'a str,
    name: &'a str,
    room: &'a str,
    native_presenter: &'a NativePresenterStatus,
}

impl Default for NativePresenterStatus {
    fn default() -> Self {
        Self {
            state: NativePresenterState::Disabled,
            render_path: "webview2".to_string(),
            target_identity: None,
            target_track_sid: None,
            native_receive_fps: None,
            native_presented_fps: None,
            native_frames_received: 0,
            native_frames_dropped: 0,
            queue_depth: 0,
            tile_width: None,
            tile_height: None,
            fallback_reason: None,
            updated_at_ms: 0,
        }
    }
}

pub(crate) fn native_presenter_identity(viewer_identity: &str) -> String {
    let trimmed = viewer_identity.trim();
    if trimmed.ends_with("$native-presenter") {
        trimmed.to_string()
    } else {
        format!("{trimmed}$native-presenter")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeTrackSource {
    ScreenShare,
    Camera,
    Other,
}

pub(crate) fn is_target_screen_track(
    target_track_sid: &str,
    publication_track_sid: &str,
    source: NativeTrackSource,
) -> bool {
    let _ = source;
    !target_track_sid.is_empty() && target_track_sid == publication_track_sid
}

fn native_track_source_label(source: NativeTrackSource) -> &'static str {
    match source {
        NativeTrackSource::ScreenShare => "screen_share",
        NativeTrackSource::Camera => "camera",
        NativeTrackSource::Other => "other",
    }
}

fn native_presenter_start_log_line(
    generation: u64,
    request: &NativePresenterStartRequest,
) -> String {
    format!(
        "[native-presenter] start generation={} mode={:?} room={} sfu_url={} viewer={} presenter={} target={} track_sid={} tile={},{} {}x{} scale={}",
        generation,
        request.mode,
        request.room,
        request.sfu_url,
        request.viewer_identity,
        native_presenter_identity(&request.viewer_identity),
        request.participant_identity,
        request.track_sid,
        request.tile.x,
        request.tile.y,
        request.tile.width,
        request.tile.height,
        request.tile.scale_factor
    )
}

fn native_presenter_track_log_line(
    target_track_sid: &str,
    publication_track_sid: &str,
    source: NativeTrackSource,
    matched: bool,
) -> String {
    format!(
        "[native-presenter] subscribed-track target_sid={} publication_sid={} source={} matched={}",
        target_track_sid,
        publication_track_sid,
        native_track_source_label(source),
        matched
    )
}

fn native_presenter_frame_log_line(
    frames: u64,
    elapsed_secs: f64,
    width: u32,
    height: u32,
) -> String {
    let fps = if elapsed_secs > 0.0 {
        ((frames as f64 / elapsed_secs) * 10.0).round() / 10.0
    } else {
        0.0
    };
    format!(
        "[native-presenter] frames frames={} fps={:.1} frame={}x{}",
        frames, fps, width, height
    )
}

fn native_presenter_receiver_stats_log_line(
    stats: &[livekit::webrtc::stats::RtcStats],
) -> Option<String> {
    use livekit::webrtc::stats::RtcStats;

    let inbound = stats.iter().find_map(|stat| match stat {
        RtcStats::InboundRtp(inbound)
            if inbound.stream.kind.eq_ignore_ascii_case("video")
                || inbound.inbound.frame_width > 0
                || inbound.inbound.frames_received > 0
                || inbound.inbound.frames_decoded > 0 =>
        {
            Some(inbound)
        }
        _ => None,
    })?;
    let codec = stats
        .iter()
        .find_map(|stat| match stat {
            RtcStats::Codec(codec) if codec.rtc.id == inbound.stream.codec_id => {
                Some(codec.codec.mime_type.as_str())
            }
            _ => None,
        })
        .unwrap_or("?");
    Some(format!(
        "[native-presenter] receiver-stats codec={} packets={} lost={} jitter_ms={:.1} bytes={} frames_received={} frames_decoded={} key_frames={} fps={:.1} size={}x{} decoder={} nack={} pli={} fir={}",
        codec,
        inbound.received.packets_received,
        inbound.received.packets_lost,
        inbound.received.jitter * 1000.0,
        inbound.inbound.bytes_received,
        inbound.inbound.frames_received,
        inbound.inbound.frames_decoded,
        inbound.inbound.key_frames_decoded,
        inbound.inbound.frames_per_second,
        inbound.inbound.frame_width,
        inbound.inbound.frame_height,
        if inbound.inbound.decoder_implementation.is_empty() {
            "?"
        } else {
            inbound.inbound.decoder_implementation.as_str()
        },
        inbound.inbound.nack_count,
        inbound.inbound.pli_count,
        inbound.inbound.fir_count
    ))
}

#[cfg(target_os = "windows")]
async fn log_native_presenter_receiver_stats(video_track: &livekit::prelude::RemoteVideoTrack) {
    match video_track.get_stats().await {
        Ok(stats) => {
            if let Some(line) = native_presenter_receiver_stats_log_line(&stats) {
                file_debug_log::append(&line);
            } else {
                file_debug_log::append("[native-presenter] receiver-stats no inbound video report");
            }
        }
        Err(error) => {
            file_debug_log::append(&format!(
                "[native-presenter] receiver-stats error={}",
                error
            ));
        }
    }
}

fn native_presenter_stats_report_url(control_url: &str) -> Option<String> {
    let trimmed = control_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    Some(format!("{trimmed}/api/client-stats-report"))
}

fn native_presenter_stats_report_body(
    request: &NativePresenterStartRequest,
    status: &NativePresenterStatus,
) -> Result<String, serde_json::Error> {
    let payload = NativePresenterStatsReportPayload {
        identity: request.viewer_identity.as_str(),
        name: request.viewer_name.as_deref().unwrap_or(""),
        room: request.room.as_str(),
        native_presenter: status,
    };
    serde_json::to_string(&payload)
}

async fn post_native_presenter_stats(
    request: &NativePresenterStartRequest,
    status: &NativePresenterStatus,
) {
    let Some(token) = request
        .viewer_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
    else {
        return;
    };
    let Some(url) = request
        .control_url
        .as_deref()
        .and_then(native_presenter_stats_report_url)
    else {
        return;
    };
    let body = match native_presenter_stats_report_body(request, status) {
        Ok(body) => body,
        Err(error) => {
            file_debug_log::append(&format!(
                "[native-presenter] stats report skipped serialization error={}",
                error
            ));
            return;
        }
    };
    let result = reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => {
            file_debug_log::append(&format!(
                "[native-presenter] stats report posted state={:?} fps={:?} frames={}",
                status.state, status.native_receive_fps, status.native_frames_received
            ));
        }
        Ok(response) => {
            file_debug_log::append(&format!(
                "[native-presenter] stats report failed status={}",
                response.status()
            ));
        }
        Err(error) => {
            file_debug_log::append(&format!(
                "[native-presenter] stats report failed error={}",
                error
            ));
        }
    }
}

pub(crate) struct NativePresenterManager {
    generation: AtomicU64,
    status: Mutex<NativePresenterStatus>,
    started_at: Instant,
}

impl NativePresenterManager {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            generation: AtomicU64::new(0),
            status: Mutex::new(NativePresenterStatus::default()),
            started_at: Instant::now(),
        })
    }

    pub(crate) fn status(&self) -> NativePresenterStatus {
        self.status.lock().clone()
    }

    pub(crate) fn validate_start_request(
        &self,
        request: &NativePresenterStartRequest,
    ) -> Result<(), String> {
        if request.mode == NativePresenterMode::Off {
            self.set_fallback("native presenter mode is off");
            return Err("native presenter mode is off".to_string());
        }
        if request.room.trim().is_empty() {
            self.set_fallback("room is empty");
            return Err("room is empty".to_string());
        }
        if request.sfu_url.trim().is_empty() {
            self.set_fallback("sfu_url is empty");
            return Err("sfu_url is empty".to_string());
        }
        if request.token.trim().is_empty() {
            self.set_fallback("token is empty");
            return Err("token is empty".to_string());
        }
        if request.viewer_identity.trim().is_empty() {
            self.set_fallback("viewer_identity is empty");
            return Err("viewer_identity is empty".to_string());
        }
        if request.participant_identity.trim().is_empty() {
            self.set_fallback("participant_identity is empty");
            return Err("participant_identity is empty".to_string());
        }
        if request.track_sid.trim().is_empty() {
            self.set_fallback("track_sid is empty");
            return Err("track_sid is empty".to_string());
        }
        if request.tile.width == 0 || request.tile.height == 0 {
            self.set_fallback("tile has zero size");
            return Err("tile has zero size".to_string());
        }
        Ok(())
    }

    pub(crate) fn mark_starting(&self, request: &NativePresenterStartRequest) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut status = self.status.lock();
        *status = NativePresenterStatus {
            state: NativePresenterState::Starting,
            render_path: "native_receive_probe".to_string(),
            target_identity: Some(request.participant_identity.clone()),
            target_track_sid: Some(request.track_sid.clone()),
            native_receive_fps: None,
            native_presented_fps: None,
            native_frames_received: 0,
            native_frames_dropped: 0,
            queue_depth: 0,
            tile_width: Some(request.tile.width),
            tile_height: Some(request.tile.height),
            fallback_reason: None,
            updated_at_ms: self.elapsed_ms(),
        };
        file_debug_log::append(&native_presenter_start_log_line(generation, request));
        generation
    }

    pub(crate) fn stop(&self, reason: &str) -> NativePresenterStatus {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let mut status = self.status.lock();
        status.state = NativePresenterState::Stopped;
        status.render_path = "webview2".to_string();
        status.fallback_reason = Some(reason.to_string());
        status.updated_at_ms = self.elapsed_ms();
        file_debug_log::append(&format!("[native-presenter] stop reason={}", reason));
        status.clone()
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub(crate) async fn start_receive_probe(
        self: &Arc<Self>,
        request: NativePresenterStartRequest,
    ) -> Result<NativePresenterStatus, String> {
        self.validate_start_request(&request)?;
        let generation = self.mark_starting(&request);
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = run_receive_probe(manager.clone(), generation, request).await {
                file_debug_log::append(&format!(
                    "[native-presenter] receive-probe error generation={} error={}",
                    generation, error
                ));
                if manager.generation() == generation {
                    manager.set_fallback(&error);
                }
            }
        });
        Ok(self.status())
    }

    pub(crate) fn record_native_frame_sample(&self, frames: u64, elapsed_secs: f64) {
        let fps = if elapsed_secs > 0.0 {
            Some(((frames as f64 / elapsed_secs) * 10.0).round() / 10.0)
        } else {
            None
        };
        let mut status = self.status.lock();
        status.state = NativePresenterState::Receiving;
        status.native_frames_received = frames;
        status.native_receive_fps = fps;
        status.native_presented_fps = None;
        status.queue_depth = 0;
        status.updated_at_ms = self.elapsed_ms();
    }

    fn set_fallback(&self, reason: &str) {
        let mut status = self.status.lock();
        status.state = NativePresenterState::Fallback;
        status.render_path = "webview2".to_string();
        status.fallback_reason = Some(reason.to_string());
        status.updated_at_ms = self.elapsed_ms();
        file_debug_log::append(&format!("[native-presenter] fallback reason={}", reason));
    }

    fn elapsed_ms(&self) -> u64 {
        self.started_at
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }
}

#[cfg(target_os = "windows")]
async fn run_receive_probe(
    manager: Arc<NativePresenterManager>,
    generation: u64,
    request: NativePresenterStartRequest,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use libwebrtc::video_stream::native::{NativeVideoStream, NativeVideoStreamOptions};
    use livekit::{prelude::*, Room, RoomEvent, RoomOptions};
    use std::time::{Duration, Instant};

    livekit::ensure_runtime_initialized();
    let mut options = RoomOptions::default();
    options.auto_subscribe = true;
    options.adaptive_stream = false;
    options.dynacast = false;
    let (_room, mut events) = Room::connect(&request.sfu_url, &request.token, options)
        .await
        .map_err(|error| format!("native presenter connect failed: {error}"))?;
    file_debug_log::append(&format!(
        "[native-presenter] connected generation={} room={} presenter={} target={} track_sid={}",
        generation,
        request.room,
        native_presenter_identity(&request.viewer_identity),
        request.participant_identity,
        request.track_sid
    ));

    let startup_deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if manager.generation() != generation {
            file_debug_log::append(&format!(
                "[native-presenter] generation superseded generation={}",
                generation
            ));
            return Ok(());
        }
        if Instant::now() > startup_deadline {
            return Err("target screen track was not subscribed within 8 seconds".to_string());
        }
        let event = match tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => return Err("native presenter room event stream closed".to_string()),
            Err(_) => continue,
        };
        let RoomEvent::TrackSubscribed {
            track, publication, ..
        } = event
        else {
            continue;
        };
        let source = match publication.source() {
            TrackSource::Screenshare => NativeTrackSource::ScreenShare,
            TrackSource::Camera => NativeTrackSource::Camera,
            _ => NativeTrackSource::Other,
        };
        let publication_sid = publication.sid().to_string();
        let matched = is_target_screen_track(&request.track_sid, &publication_sid, source);
        file_debug_log::append(&native_presenter_track_log_line(
            &request.track_sid,
            &publication_sid,
            source,
            matched,
        ));
        if !matched {
            continue;
        }
        let RemoteTrack::Video(video_track) = track else {
            file_debug_log::append(&format!(
                "[native-presenter] matched track was not video track_sid={}",
                publication_sid
            ));
            continue;
        };
        let stats_track = video_track.clone();
        let mut stream = NativeVideoStream::with_options(
            video_track.rtc_track(),
            NativeVideoStreamOptions {
                queue_size_frames: Some(1),
            },
        );
        file_debug_log::append(&format!(
            "[native-presenter] native video stream opened generation={} track_sid={} queue_size_frames=1",
            generation, publication_sid
        ));
        post_native_presenter_stats(&request, &manager.status()).await;
        let started = Instant::now();
        let mut frames = 0u64;
        let mut logged_waiting_for_frames = false;
        let mut last_stats_report = Instant::now() - Duration::from_secs(60);
        let mut last_receiver_stats_report = Instant::now() - Duration::from_secs(60);
        while manager.generation() == generation {
            let frame = tokio::time::timeout(Duration::from_millis(500), stream.next()).await;
            match frame {
                Ok(Some(frame)) => {
                    let width = frame.buffer.width();
                    let height = frame.buffer.height();
                    frames += 1;
                    let elapsed = started.elapsed().as_secs_f64();
                    if frames == 1 || frames % 30 == 0 {
                        manager.record_native_frame_sample(frames, elapsed);
                        file_debug_log::append(&native_presenter_frame_log_line(
                            frames, elapsed, width, height,
                        ));
                        if frames == 1 || last_stats_report.elapsed() >= Duration::from_millis(2500)
                        {
                            last_stats_report = Instant::now();
                            post_native_presenter_stats(&request, &manager.status()).await;
                        }
                    }
                }
                Ok(None) => return Err("native video stream ended".to_string()),
                Err(_) => {
                    if started.elapsed() > Duration::from_secs(2) {
                        manager.record_native_frame_sample(frames, started.elapsed().as_secs_f64());
                        if !logged_waiting_for_frames {
                            logged_waiting_for_frames = true;
                            file_debug_log::append(&format!(
                                "[native-presenter] waiting for frames generation={} track_sid={} frames={}",
                                generation, publication_sid, frames
                            ));
                        }
                    }
                }
            }
            if last_receiver_stats_report.elapsed() >= Duration::from_millis(2500) {
                last_receiver_stats_report = Instant::now();
                log_native_presenter_receiver_stats(&stats_track).await;
            }
        }
        stream.close();
        file_debug_log::append(&format!(
            "[native-presenter] native video stream closed generation={} track_sid={} frames={}",
            generation, publication_sid, frames
        ));
        return Ok(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_defaults_to_off_for_unknown_values() {
        assert_eq!(
            NativePresenterMode::from_setting("off"),
            NativePresenterMode::Off
        );
        assert_eq!(
            NativePresenterMode::from_setting("on"),
            NativePresenterMode::On
        );
        assert_eq!(
            NativePresenterMode::from_setting("auto"),
            NativePresenterMode::Auto
        );
        assert_eq!(
            NativePresenterMode::from_setting(""),
            NativePresenterMode::Off
        );
        assert_eq!(
            NativePresenterMode::from_setting("fast"),
            NativePresenterMode::Off
        );
    }

    #[test]
    fn native_presenter_identity_is_derived_from_viewer_identity() {
        assert_eq!(
            native_presenter_identity("Sam-1234"),
            "Sam-1234$native-presenter"
        );
        assert_eq!(
            native_presenter_identity("Sam-1234$native-presenter"),
            "Sam-1234$native-presenter"
        );
    }

    #[test]
    fn status_starts_disabled() {
        let manager = NativePresenterManager::new();
        let status = manager.status();
        assert_eq!(status.state, NativePresenterState::Disabled);
        assert_eq!(status.render_path, "webview2");
        assert_eq!(status.native_receive_fps, None);
    }

    #[test]
    fn rejected_start_records_fallback_reason() {
        let manager = NativePresenterManager::new();
        let request = NativePresenterStartRequest {
            mode: NativePresenterMode::Off,
            room: "main".to_string(),
            sfu_url: "wss://example.invalid".to_string(),
            token: "token".to_string(),
            viewer_token: None,
            viewer_identity: "Sam-1234".to_string(),
            viewer_name: None,
            control_url: None,
            participant_identity: "Spencer-2222".to_string(),
            track_sid: "TR_screen".to_string(),
            tile: NativePresenterTileRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale_factor: 1.0,
            },
        };

        let result = manager.validate_start_request(&request);

        assert!(result.is_err());
        assert_eq!(manager.status().state, NativePresenterState::Fallback);
        assert_eq!(
            manager.status().fallback_reason.as_deref(),
            Some("native presenter mode is off")
        );
    }

    #[test]
    fn start_validation_accepts_on_mode_with_complete_target() {
        let manager = NativePresenterManager::new();
        let request = NativePresenterStartRequest {
            mode: NativePresenterMode::On,
            room: "main".to_string(),
            sfu_url: "wss://echo.example.invalid".to_string(),
            token: "token".to_string(),
            viewer_token: None,
            viewer_identity: "Sam-1234".to_string(),
            viewer_name: None,
            control_url: None,
            participant_identity: "Spencer-2222".to_string(),
            track_sid: "TR_screen".to_string(),
            tile: NativePresenterTileRect {
                x: 10,
                y: 20,
                width: 1920,
                height: 1080,
                scale_factor: 1.0,
            },
        };

        assert!(manager.validate_start_request(&request).is_ok());
    }

    #[test]
    fn stop_returns_webview2_status() {
        let manager = NativePresenterManager::new();

        let status = manager.stop("user disabled native presenter");

        assert_eq!(status.state, NativePresenterState::Stopped);
        assert_eq!(status.render_path, "webview2");
        assert_eq!(
            status.fallback_reason.as_deref(),
            Some("user disabled native presenter")
        );
    }

    #[test]
    fn track_match_requires_target_sid() {
        assert!(is_target_screen_track(
            "TR_screen",
            "TR_screen",
            NativeTrackSource::ScreenShare
        ));
        assert!(!is_target_screen_track(
            "TR_screen",
            "TR_camera",
            NativeTrackSource::ScreenShare
        ));
        assert!(is_target_screen_track(
            "TR_screen",
            "TR_screen",
            NativeTrackSource::Camera
        ));
    }

    #[test]
    fn target_sid_match_accepts_camera_labeled_screen_companion_tracks() {
        assert!(is_target_screen_track(
            "TR_screen",
            "TR_screen",
            NativeTrackSource::Camera
        ));
    }

    #[test]
    fn receiver_stats_log_line_reports_inbound_video_decode_state() {
        use livekit::webrtc::stats::{dictionaries, CodecStats, InboundRtpStats, RtcStats};

        let stats = vec![
            RtcStats::Codec(CodecStats {
                rtc: dictionaries::RtcStats {
                    id: "codec_1".to_string(),
                    timestamp: 1,
                },
                codec: dictionaries::CodecStats {
                    mime_type: "video/H264".to_string(),
                    ..Default::default()
                },
            }),
            RtcStats::InboundRtp(InboundRtpStats {
                stream: dictionaries::RtpStreamStats {
                    kind: "video".to_string(),
                    codec_id: "codec_1".to_string(),
                    ..Default::default()
                },
                received: dictionaries::ReceivedRtpStreamStats {
                    packets_received: 44,
                    packets_lost: 2,
                    jitter: 0.012,
                },
                inbound: dictionaries::InboundRtpStreamStats {
                    bytes_received: 88_000,
                    frames_received: 30,
                    frames_decoded: 0,
                    key_frames_decoded: 0,
                    frames_per_second: 0.0,
                    frame_width: 1920,
                    frame_height: 1080,
                    decoder_implementation: "unknown".to_string(),
                    nack_count: 3,
                    pli_count: 1,
                    fir_count: 0,
                    ..Default::default()
                },
                ..Default::default()
            }),
        ];

        let line = native_presenter_receiver_stats_log_line(&stats).expect("stats log line");

        assert!(line.contains("codec=video/H264"));
        assert!(line.contains("packets=44"));
        assert!(line.contains("bytes=88000"));
        assert!(line.contains("frames_received=30"));
        assert!(line.contains("frames_decoded=0"));
        assert!(line.contains("decoder=unknown"));
    }

    #[test]
    fn frame_sample_updates_receive_fps() {
        let manager = NativePresenterManager::new();
        let request = NativePresenterStartRequest {
            mode: NativePresenterMode::On,
            room: "main".to_string(),
            sfu_url: "wss://echo.example.invalid".to_string(),
            token: "token".to_string(),
            viewer_token: None,
            viewer_identity: "Sam-1234".to_string(),
            viewer_name: None,
            control_url: None,
            participant_identity: "Spencer-2222".to_string(),
            track_sid: "TR_screen".to_string(),
            tile: NativePresenterTileRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale_factor: 1.0,
            },
        };
        manager.mark_starting(&request);

        manager.record_native_frame_sample(120, 2.0);

        let status = manager.status();
        assert_eq!(status.state, NativePresenterState::Receiving);
        assert_eq!(status.native_frames_received, 120);
        assert_eq!(status.native_receive_fps, Some(60.0));
    }

    #[test]
    fn start_log_line_includes_target_context_without_token() {
        let request = NativePresenterStartRequest {
            mode: NativePresenterMode::On,
            room: "main".to_string(),
            sfu_url: "wss://echo.example.invalid".to_string(),
            token: "secret-token".to_string(),
            viewer_token: None,
            viewer_identity: "Sam-1234".to_string(),
            viewer_name: None,
            control_url: None,
            participant_identity: "Spencer-2222".to_string(),
            track_sid: "TR_screen".to_string(),
            tile: NativePresenterTileRect {
                x: -100,
                y: 20,
                width: 1920,
                height: 1080,
                scale_factor: 1.5,
            },
        };

        let line = native_presenter_start_log_line(4, &request);

        assert!(line.contains("generation=4"));
        assert!(line.contains("viewer=Sam-1234"));
        assert!(line.contains("target=Spencer-2222"));
        assert!(line.contains("track_sid=TR_screen"));
        assert!(line.contains("tile=-100,20 1920x1080 scale=1.5"));
        assert!(!line.contains("secret-token"));
    }

    #[test]
    fn track_log_line_marks_target_match() {
        let line = native_presenter_track_log_line(
            "TR_screen",
            "TR_screen",
            NativeTrackSource::ScreenShare,
            true,
        );

        assert!(line.contains("publication_sid=TR_screen"));
        assert!(line.contains("source=screen_share"));
        assert!(line.contains("matched=true"));
    }

    #[test]
    fn stats_report_url_uses_control_url_without_double_slash() {
        assert_eq!(
            native_presenter_stats_report_url("https://echo.example.invalid/"),
            Some("https://echo.example.invalid/api/client-stats-report".to_string())
        );
        assert_eq!(native_presenter_stats_report_url("   "), None);
    }

    #[test]
    fn stats_report_payload_uses_visible_identity_without_tokens() {
        let request = NativePresenterStartRequest {
            mode: NativePresenterMode::On,
            room: "main".to_string(),
            sfu_url: "wss://echo.example.invalid".to_string(),
            token: "hidden-native-token".to_string(),
            viewer_token: Some("visible-viewer-token".to_string()),
            viewer_identity: "Sam-1234".to_string(),
            viewer_name: Some("Sam".to_string()),
            control_url: Some("https://echo.example.invalid".to_string()),
            participant_identity: "Spencer-2222".to_string(),
            track_sid: "TR_screen".to_string(),
            tile: NativePresenterTileRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale_factor: 1.0,
            },
        };
        let status = NativePresenterStatus {
            state: NativePresenterState::Receiving,
            render_path: "native_receive_probe".to_string(),
            target_identity: Some("Spencer-2222".to_string()),
            target_track_sid: Some("TR_screen".to_string()),
            native_receive_fps: Some(58.5),
            native_presented_fps: None,
            native_frames_received: 120,
            native_frames_dropped: 0,
            queue_depth: 0,
            tile_width: Some(1920),
            tile_height: Some(1080),
            fallback_reason: None,
            updated_at_ms: 1234,
        };

        let body = native_presenter_stats_report_body(&request, &status).unwrap();

        assert!(body.contains("\"identity\":\"Sam-1234\""));
        assert!(body.contains("\"name\":\"Sam\""));
        assert!(body.contains("\"native_receive_fps\":58.5"));
        assert!(!body.contains("hidden-native-token"));
        assert!(!body.contains("visible-viewer-token"));
    }
}
