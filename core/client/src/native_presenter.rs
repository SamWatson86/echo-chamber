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
}
