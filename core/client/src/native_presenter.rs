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
    pub(crate) viewer_identity: String,
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
    source == NativeTrackSource::ScreenShare && target_track_sid == publication_track_sid
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
        generation
    }

    pub(crate) fn stop(&self, reason: &str) -> NativePresenterStatus {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let mut status = self.status.lock();
        status.state = NativePresenterState::Stopped;
        status.render_path = "webview2".to_string();
        status.fallback_reason = Some(reason.to_string());
        status.updated_at_ms = self.elapsed_ms();
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

    let startup_deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if manager.generation() != generation {
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
        let RoomEvent::TrackSubscribed { track, publication, .. } = event else {
            continue;
        };
        let source = match publication.source() {
            TrackSource::Screenshare => NativeTrackSource::ScreenShare,
            TrackSource::Camera => NativeTrackSource::Camera,
            _ => NativeTrackSource::Other,
        };
        if !is_target_screen_track(&request.track_sid, &publication.sid().to_string(), source) {
            continue;
        }
        let RemoteTrack::Video(video_track) = track else {
            continue;
        };
        let mut stream = NativeVideoStream::with_options(
            video_track.rtc_track(),
            NativeVideoStreamOptions {
                queue_size_frames: Some(1),
            },
        );
        let started = Instant::now();
        let mut frames = 0u64;
        while manager.generation() == generation {
            let frame = tokio::time::timeout(Duration::from_millis(500), stream.next()).await;
            match frame {
                Ok(Some(frame)) => {
                    let _width = frame.buffer.width();
                    let _height = frame.buffer.height();
                    frames += 1;
                    let elapsed = started.elapsed().as_secs_f64();
                    if frames == 1 || frames % 30 == 0 {
                        manager.record_native_frame_sample(frames, elapsed);
                    }
                }
                Ok(None) => return Err("native video stream ended".to_string()),
                Err(_) => {
                    if started.elapsed() > Duration::from_secs(2) {
                        manager.record_native_frame_sample(frames, started.elapsed().as_secs_f64());
                    }
                }
            }
        }
        stream.close();
        return Ok(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_defaults_to_off_for_unknown_values() {
        assert_eq!(NativePresenterMode::from_setting("off"), NativePresenterMode::Off);
        assert_eq!(NativePresenterMode::from_setting("on"), NativePresenterMode::On);
        assert_eq!(NativePresenterMode::from_setting("auto"), NativePresenterMode::Auto);
        assert_eq!(NativePresenterMode::from_setting(""), NativePresenterMode::Off);
        assert_eq!(NativePresenterMode::from_setting("fast"), NativePresenterMode::Off);
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
            viewer_identity: "Sam-1234".to_string(),
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
            viewer_identity: "Sam-1234".to_string(),
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
    fn track_match_requires_target_sid_and_screen_source() {
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
        assert!(!is_target_screen_track(
            "TR_screen",
            "TR_screen",
            NativeTrackSource::Camera
        ));
    }

    #[test]
    fn frame_sample_updates_receive_fps() {
        let manager = NativePresenterManager::new();
        let request = NativePresenterStartRequest {
            mode: NativePresenterMode::On,
            room: "main".to_string(),
            sfu_url: "wss://echo.example.invalid".to_string(),
            token: "token".to_string(),
            viewer_identity: "Sam-1234".to_string(),
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
}
