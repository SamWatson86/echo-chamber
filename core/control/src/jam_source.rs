use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{info, warn};

use crate::AppState;

pub(crate) const JAM_SOURCE_PROTOCOL_VERSION: u8 = 2;
pub(crate) const AUDIBLE_PEAK_THRESHOLD: f32 = 0.0005;
const MAX_AUDIO_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const SOURCE_ACTIVITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const SOURCE_FRAME_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const CAPTURE_RESTART_DEBOUNCE: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Clone, Debug)]
pub(crate) enum SourceEvent {
    Connected,
    Disconnected,
    Format {
        generation: u64,
        sample_rate: u32,
        channels: u32,
    },
    Ready {
        generation: u64,
        pid: u32,
    },
    Restarting {
        generation: u64,
    },
    Error {
        generation: u64,
        message: String,
    },
    Audio {
        generation: u64,
        sample_rate: u32,
        channels: u32,
        samples: Vec<f32>,
    },
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct JamSourceSnapshot {
    pub(crate) configured: bool,
    pub(crate) connected: bool,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) generation: Option<u64>,
    pub(crate) ready: bool,
    pub(crate) pid: Option<u32>,
    pub(crate) sample_rate: Option<u32>,
    pub(crate) channels: Option<u32>,
    pub(crate) last_frame_ms: Option<u64>,
    pub(crate) peak: f32,
}

struct ConnectedSource {
    connection_id: u64,
    command_tx: mpsc::UnboundedSender<Message>,
}

struct SourceInner {
    connection: Option<ConnectedSource>,
    desired_generation: Option<u64>,
    ready_generation: Option<u64>,
    format_generation: Option<u64>,
    sample_rate: Option<u32>,
    channels: Option<u32>,
    pid: Option<u32>,
    status: String,
    error: Option<String>,
    last_activity_at: Option<Instant>,
    ready_at: Option<Instant>,
    last_frame_at: Option<Instant>,
    last_audible_at: Option<Instant>,
    restart_pending_generation: Option<u64>,
    last_restart: Option<(u64, Instant)>,
    peak: f32,
}

impl Default for SourceInner {
    fn default() -> Self {
        Self {
            connection: None,
            desired_generation: None,
            ready_generation: None,
            format_generation: None,
            sample_rate: None,
            channels: None,
            pid: None,
            status: "offline".to_string(),
            error: None,
            last_activity_at: None,
            ready_at: None,
            last_frame_at: None,
            last_audible_at: None,
            restart_pending_generation: None,
            last_restart: None,
            peak: 0.0,
        }
    }
}

#[derive(Clone)]
pub(crate) struct JamSourceRegistry {
    configured: bool,
    inner: Arc<Mutex<SourceInner>>,
    events: broadcast::Sender<SourceEvent>,
    next_connection_id: Arc<AtomicU64>,
}

impl JamSourceRegistry {
    pub(crate) fn new(configured: bool) -> Self {
        let (events, _) = broadcast::channel(256);
        let mut inner = SourceInner::default();
        if !configured {
            inner.status = "unconfigured".to_string();
        }
        Self {
            configured,
            inner: Arc::new(Mutex::new(inner)),
            events,
            next_connection_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<SourceEvent> {
        self.events.subscribe()
    }

    pub(crate) async fn start(&self, generation: u64) -> Result<(), String> {
        if !self.configured {
            return Err("Jam source is not configured".to_string());
        }
        let message = serde_json::json!({
            "type": "start",
            "generation": generation,
        })
        .to_string();
        let mut inner = self.inner.lock().await;
        let command_tx = inner
            .connection
            .as_ref()
            .map(|connection| connection.command_tx.clone())
            .ok_or_else(|| "Configured Jam source is offline".to_string())?;
        if inner
            .last_activity_at
            .map(|at| at.elapsed() > SOURCE_ACTIVITY_TIMEOUT)
            .unwrap_or(true)
        {
            return Err("Configured Jam source heartbeat is stale".to_string());
        }
        command_tx
            .send(Message::Text(message))
            .map_err(|_| "Configured Jam source disconnected".to_string())?;
        inner.desired_generation = Some(generation);
        inner.ready_generation = None;
        inner.format_generation = None;
        inner.sample_rate = None;
        inner.channels = None;
        inner.pid = None;
        inner.status = "starting".to_string();
        inner.error = None;
        inner.ready_at = None;
        inner.last_frame_at = None;
        inner.last_audible_at = None;
        inner.restart_pending_generation = None;
        inner.last_restart = None;
        inner.peak = 0.0;
        Ok(())
    }

    pub(crate) async fn stop(&self, generation: u64) {
        let message = serde_json::json!({
            "type": "stop",
            "generation": generation,
        })
        .to_string();
        let mut inner = self.inner.lock().await;
        if let Some(connection) = &inner.connection {
            let _ = connection.command_tx.send(Message::Text(message));
        }
        if inner.desired_generation == Some(generation) {
            inner.desired_generation = None;
            inner.ready_generation = None;
            inner.format_generation = None;
            inner.sample_rate = None;
            inner.channels = None;
            inner.pid = None;
            inner.status = if inner.connection.is_some() {
                "ready".to_string()
            } else if self.configured {
                "offline".to_string()
            } else {
                "unconfigured".to_string()
            };
            inner.ready_at = None;
            inner.last_frame_at = None;
            inner.last_audible_at = None;
            inner.restart_pending_generation = None;
            inner.last_restart = None;
            inner.peak = 0.0;
        }
    }

    /// Ask the current source connection to replace a packet-stalled WASAPI
    /// capture without ending the Jam generation or its listener sockets.
    /// Playback expectation is checked by the Jam session; this method adds
    /// generation, connection, raw-packet-stall, and debounce fencing.
    pub(crate) async fn restart_stalled_capture(&self, generation: u64) -> bool {
        let mut inner = self.inner.lock().await;
        if inner.desired_generation != Some(generation)
            || inner.ready_generation != Some(generation)
            || !capture_packets_stalled(&inner)
            || inner
                .last_activity_at
                .map(|at| at.elapsed() > SOURCE_ACTIVITY_TIMEOUT)
                .unwrap_or(true)
        {
            return false;
        }
        if inner
            .last_restart
            .filter(|(restart_generation, _)| *restart_generation == generation)
            .map(|(_, at)| at.elapsed() < CAPTURE_RESTART_DEBOUNCE)
            .unwrap_or(false)
        {
            return false;
        }
        let Some(command_tx) = inner
            .connection
            .as_ref()
            .map(|connection| connection.command_tx.clone())
        else {
            return false;
        };
        let message = serde_json::json!({
            "type": "restart",
            "generation": generation,
        })
        .to_string();
        if command_tx.send(Message::Text(message)).is_err() {
            return false;
        }
        inner.restart_pending_generation = Some(generation);
        inner.last_restart = Some((generation, Instant::now()));
        true
    }

    pub(crate) async fn snapshot(&self) -> JamSourceSnapshot {
        let inner = self.inner.lock().await;
        let activity_stale = inner.connection.is_some()
            && inner
                .last_activity_at
                .map(|at| at.elapsed() > SOURCE_ACTIVITY_TIMEOUT)
                .unwrap_or(true);
        let last_frame_ms = inner
            .last_frame_at
            .map(|at| at.elapsed().as_millis().min(u64::MAX as u128) as u64);
        let status = if !self.configured {
            "unconfigured".to_string()
        } else if inner.connection.is_none() || activity_stale {
            "offline".to_string()
        } else if inner.error.is_some() {
            "error".to_string()
        } else if inner.desired_generation.is_some()
            && inner.ready_generation != inner.desired_generation
        {
            "starting".to_string()
        } else if inner.ready_generation.is_some() {
            match last_frame_ms {
                None if capture_packets_stalled(&inner) => "stalled".to_string(),
                None => "ready".to_string(),
                Some(age) if age > SOURCE_FRAME_STALL_TIMEOUT.as_millis() as u64 => {
                    "stalled".to_string()
                }
                Some(_)
                    if inner
                        .last_audible_at
                        .map(|at| at.elapsed().as_millis() <= 2_000)
                        .unwrap_or(false) =>
                {
                    "live".to_string()
                }
                Some(_) => "silent".to_string(),
            }
        } else {
            inner.status.clone()
        };
        JamSourceSnapshot {
            configured: self.configured,
            connected: inner.connection.is_some() && !activity_stale,
            status,
            error: if activity_stale {
                Some("Jam source heartbeat timed out".to_string())
            } else {
                inner.error.clone()
            },
            generation: inner.desired_generation,
            ready: !activity_stale
                && inner.desired_generation.is_some()
                && inner.ready_generation == inner.desired_generation,
            pid: inner.pid,
            sample_rate: inner.sample_rate,
            channels: inner.channels,
            last_frame_ms,
            peak: inner.peak,
        }
    }

    async fn register(&self, command_tx: mpsc::UnboundedSender<Message>) -> u64 {
        let connection_id = self.next_connection_id.fetch_add(1, Ordering::Relaxed);
        let replay_tx = command_tx.clone();
        let (old, desired_generation) = {
            let mut inner = self.inner.lock().await;
            let old = inner.connection.replace(ConnectedSource {
                connection_id,
                command_tx,
            });
            let desired_generation = inner.desired_generation;
            inner.status = if desired_generation.is_some() {
                "starting".to_string()
            } else {
                "ready".to_string()
            };
            inner.error = None;
            inner.ready_generation = None;
            inner.format_generation = None;
            inner.sample_rate = None;
            inner.channels = None;
            inner.pid = None;
            inner.last_activity_at = Some(Instant::now());
            inner.ready_at = None;
            inner.last_frame_at = None;
            inner.last_audible_at = None;
            inner.restart_pending_generation = None;
            inner.last_restart = None;
            (old, desired_generation)
        };
        if let Some(old) = old {
            let _ = old.command_tx.send(Message::Close(None));
        }
        if let Some(generation) = desired_generation {
            let _ = replay_tx.send(Message::Text(
                serde_json::json!({ "type": "start", "generation": generation }).to_string(),
            ));
        }
        let _ = self.events.send(SourceEvent::Connected);
        connection_id
    }

    async fn unregister(&self, connection_id: u64) {
        let removed = {
            let mut inner = self.inner.lock().await;
            if inner
                .connection
                .as_ref()
                .map(|connection| connection.connection_id)
                == Some(connection_id)
            {
                inner.connection = None;
                inner.ready_generation = None;
                inner.ready_at = None;
                inner.last_activity_at = None;
                inner.restart_pending_generation = None;
                inner.last_restart = None;
                inner.status = if self.configured {
                    "offline".to_string()
                } else {
                    "unconfigured".to_string()
                };
                true
            } else {
                false
            }
        };
        if removed {
            let _ = self.events.send(SourceEvent::Disconnected);
        }
    }

    #[cfg(test)]
    pub(crate) async fn test_register(&self, command_tx: mpsc::UnboundedSender<Message>) -> u64 {
        self.register(command_tx).await
    }

    #[cfg(test)]
    pub(crate) async fn test_unregister(&self, connection_id: u64) {
        self.unregister(connection_id).await;
    }

    #[cfg(test)]
    pub(crate) async fn test_ready(&self, connection_id: u64, generation: u64) {
        handle_text(
            self,
            connection_id,
            &serde_json::json!({
                "type": "ready",
                "generation": generation,
                "pid": 123,
            })
            .to_string(),
        )
        .await;
    }
}

fn capture_packets_stalled(inner: &SourceInner) -> bool {
    if inner.ready_generation.is_none() {
        return false;
    }
    inner
        .last_frame_at
        .or(inner.ready_at)
        .map(|at| at.elapsed() > SOURCE_FRAME_STALL_TIMEOUT)
        .unwrap_or(false)
}

#[derive(Deserialize)]
pub(crate) struct JamSourceQuery {
    source_id: String,
    protocol: u8,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum SourceTextMessage {
    Format {
        generation: u64,
        sample_rate: u32,
        channels: u32,
    },
    Ready {
        generation: u64,
        pid: u32,
    },
    Error {
        generation: u64,
        message: String,
    },
    Heartbeat {
        generation: u64,
    },
    Restarting {
        generation: u64,
    },
}

pub(crate) async fn jam_source_ws(
    ws: WebSocketUpgrade,
    Query(query): Query<JamSourceQuery>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    let configured_id = state
        .config
        .jam_source_id
        .as_deref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let configured_token = state
        .config
        .jam_source_token
        .as_deref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    if query.protocol != JAM_SOURCE_PROTOCOL_VERSION || query.source_id != configured_id {
        return Err(StatusCode::FORBIDDEN);
    }
    let supplied_token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !constant_time_eq(supplied_token.as_bytes(), configured_token.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let registry = state.jam_source.clone();
    Ok(ws.on_upgrade(move |socket| source_socket(socket, registry)))
}

async fn source_socket(socket: WebSocket, registry: JamSourceRegistry) {
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (command_tx, mut command_rx) = mpsc::unbounded_channel();
    let connection_id = registry.register(command_tx).await;
    info!(
        "[jam-source] protocol v2 source connected id={}",
        connection_id
    );

    let writer = tokio::spawn(async move {
        while let Some(message) = command_rx.recv().await {
            if socket_tx.send(message).await.is_err() {
                break;
            }
        }
    });

    while let Some(message) = socket_rx.next().await {
        match message {
            Ok(Message::Text(text)) => handle_text(&registry, connection_id, &text).await,
            Ok(Message::Binary(bytes)) => handle_audio(&registry, connection_id, &bytes).await,
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
        }
    }

    writer.abort();
    let _ = writer.await;
    registry.unregister(connection_id).await;
    info!("[jam-source] source disconnected id={}", connection_id);
}

async fn handle_text(registry: &JamSourceRegistry, connection_id: u64, text: &str) {
    let message = match serde_json::from_str::<SourceTextMessage>(text) {
        Ok(message) => message,
        Err(error) => {
            warn!("[jam-source] invalid text message: {}", error);
            return;
        }
    };
    let mut inner = registry.inner.lock().await;
    if inner
        .connection
        .as_ref()
        .map(|connection| connection.connection_id)
        != Some(connection_id)
    {
        return;
    }
    match message {
        SourceTextMessage::Format {
            generation,
            sample_rate,
            channels,
        } => {
            if inner.desired_generation != Some(generation)
                || !(8_000..=192_000).contains(&sample_rate)
                || !(1..=8).contains(&channels)
            {
                return;
            }
            inner.last_activity_at = Some(Instant::now());
            inner.format_generation = Some(generation);
            inner.sample_rate = Some(sample_rate);
            inner.channels = Some(channels);
            let _ = registry.events.send(SourceEvent::Format {
                generation,
                sample_rate,
                channels,
            });
        }
        SourceTextMessage::Ready { generation, pid } => {
            if inner.desired_generation != Some(generation) {
                return;
            }
            inner.last_activity_at = Some(Instant::now());
            inner.ready_generation = Some(generation);
            inner.ready_at = Some(Instant::now());
            inner.pid = Some(pid);
            inner.status = "ready".to_string();
            inner.error = None;
            inner.last_frame_at = None;
            inner.last_audible_at = None;
            inner.peak = 0.0;
            let _ = registry.events.send(SourceEvent::Ready { generation, pid });
        }
        SourceTextMessage::Error {
            generation,
            message,
        } => {
            if inner.desired_generation != Some(generation) {
                return;
            }
            inner.last_activity_at = Some(Instant::now());
            let message = message.chars().take(500).collect::<String>();
            inner.ready_generation = None;
            inner.ready_at = None;
            inner.status = "error".to_string();
            inner.error = Some(message.clone());
            let _ = registry.events.send(SourceEvent::Error {
                generation,
                message,
            });
        }
        SourceTextMessage::Heartbeat { generation } => {
            let valid_generation = match inner.desired_generation {
                Some(desired) => generation == desired,
                None => generation == 0,
            };
            if !valid_generation {
                return;
            }
            inner.last_activity_at = Some(Instant::now());
        }
        SourceTextMessage::Restarting { generation } => {
            if inner.desired_generation != Some(generation)
                || inner.restart_pending_generation != Some(generation)
            {
                return;
            }
            inner.last_activity_at = Some(Instant::now());
            inner.ready_generation = None;
            inner.format_generation = None;
            inner.sample_rate = None;
            inner.channels = None;
            inner.pid = None;
            inner.status = "starting".to_string();
            inner.error = None;
            inner.ready_at = None;
            inner.last_frame_at = None;
            inner.last_audible_at = None;
            inner.restart_pending_generation = None;
            inner.peak = 0.0;
            let _ = registry.events.send(SourceEvent::Restarting { generation });
        }
    }
}

async fn handle_audio(registry: &JamSourceRegistry, connection_id: u64, bytes: &[u8]) {
    if bytes.len() < 12
        || bytes.len() > MAX_AUDIO_MESSAGE_BYTES
        || (bytes.len() - 8) % std::mem::size_of::<f32>() != 0
    {
        return;
    }
    let generation = u64::from_le_bytes(bytes[..8].try_into().unwrap());
    let mut inner = registry.inner.lock().await;
    if inner
        .connection
        .as_ref()
        .map(|connection| connection.connection_id)
        != Some(connection_id)
    {
        return;
    }
    if inner.desired_generation != Some(generation)
        || inner.ready_generation != Some(generation)
        || inner.format_generation != Some(generation)
    {
        return;
    }
    let (Some(sample_rate), Some(channels)) = (inner.sample_rate, inner.channels) else {
        return;
    };
    let sample_count = (bytes.len() - 8) / std::mem::size_of::<f32>();
    if sample_count % channels as usize != 0 {
        return;
    }
    let mut samples = Vec::with_capacity((bytes.len() - 8) / 4);
    let mut peak = 0.0_f32;
    for chunk in bytes[8..].chunks_exact(4) {
        let sample = f32::from_le_bytes(chunk.try_into().unwrap());
        if !sample.is_finite() {
            return;
        }
        peak = peak.max(sample.abs());
        samples.push(sample.clamp(-1.0, 1.0));
    }
    if samples.is_empty() {
        return;
    }
    inner.last_activity_at = Some(Instant::now());
    inner.last_frame_at = Some(Instant::now());
    inner.peak = peak;
    if peak >= AUDIBLE_PEAK_THRESHOLD {
        inner.last_audible_at = Some(Instant::now());
    }
    drop(inner);
    let _ = registry.events.send(SourceEvent::Audio {
        generation,
        sample_rate,
        channels,
        samples,
    });
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_token_comparison_requires_exact_match() {
        assert!(constant_time_eq(b"source-secret", b"source-secret"));
        assert!(!constant_time_eq(b"source-secret", b"source-secreu"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[tokio::test]
    async fn stale_generation_audio_is_ignored() {
        let registry = JamSourceRegistry::new(true);
        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        let connection_id = registry.register(command_tx).await;
        {
            let mut inner = registry.inner.lock().await;
            inner.desired_generation = Some(8);
            inner.ready_generation = Some(8);
            inner.format_generation = Some(8);
            inner.sample_rate = Some(48_000);
            inner.channels = Some(2);
        }
        let mut bytes = 7_u64.to_le_bytes().to_vec();
        bytes.extend_from_slice(&0.5_f32.to_le_bytes());
        bytes.extend_from_slice(&0.5_f32.to_le_bytes());
        handle_audio(&registry, connection_id, &bytes).await;
        let snapshot = registry.snapshot().await;
        assert!(snapshot.last_frame_ms.is_none());
        assert_eq!(snapshot.peak, 0.0);
    }

    #[tokio::test]
    async fn valid_audio_updates_measured_health() {
        let registry = JamSourceRegistry::new(true);
        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        let connection_id = registry.register(command_tx).await;
        {
            let mut inner = registry.inner.lock().await;
            inner.desired_generation = Some(9);
            inner.ready_generation = Some(9);
            inner.format_generation = Some(9);
            inner.sample_rate = Some(48_000);
            inner.channels = Some(2);
        }
        let mut bytes = 9_u64.to_le_bytes().to_vec();
        bytes.extend_from_slice(&0.25_f32.to_le_bytes());
        bytes.extend_from_slice(&(-0.5_f32).to_le_bytes());
        handle_audio(&registry, connection_id, &bytes).await;
        let snapshot = registry.snapshot().await;
        assert_eq!(snapshot.status, "live");
        assert_eq!(snapshot.peak, 0.5);
        assert!(snapshot.last_frame_ms.is_some());
    }

    #[tokio::test]
    async fn reconnect_replays_current_generation_start() {
        let registry = JamSourceRegistry::new(true);
        registry.inner.lock().await.desired_generation = Some(44);
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        registry.register(command_tx).await;
        let message = command_rx.recv().await.expect("replayed start command");
        let Message::Text(text) = message else {
            panic!("expected text command");
        };
        assert!(text.contains("\"type\":\"start\""));
        assert!(text.contains("\"generation\":44"));
    }

    #[tokio::test]
    async fn stalled_capture_restart_is_generation_scoped_and_debounced() {
        let registry = JamSourceRegistry::new(true);
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        let connection_id = registry.register(command_tx).await;
        {
            let mut inner = registry.inner.lock().await;
            inner.desired_generation = Some(45);
            inner.ready_generation = Some(45);
            inner.format_generation = Some(45);
            inner.sample_rate = Some(48_000);
            inner.channels = Some(2);
            inner.ready_at = Some(
                Instant::now() - SOURCE_FRAME_STALL_TIMEOUT - std::time::Duration::from_secs(1),
            );
        }

        handle_text(
            &registry,
            connection_id,
            r#"{"type":"restarting","generation":45}"#,
        )
        .await;
        assert!(registry.snapshot().await.ready);
        assert!(!registry.restart_stalled_capture(44).await);
        assert!(registry.restart_stalled_capture(45).await);
        let Message::Text(command) = command_rx.recv().await.expect("restart command") else {
            panic!("expected restart text command");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&command).unwrap(),
            serde_json::json!({ "type": "restart", "generation": 45 })
        );
        assert!(!registry.restart_stalled_capture(45).await);
        assert!(command_rx.try_recv().is_err());

        handle_text(
            &registry,
            connection_id,
            r#"{"type":"restarting","generation":45}"#,
        )
        .await;
        let snapshot = registry.snapshot().await;
        assert_eq!(snapshot.status, "starting");
        assert!(!snapshot.ready);

        handle_text(
            &registry,
            connection_id,
            r#"{"type":"format","generation":45,"sample_rate":48000,"channels":2}"#,
        )
        .await;
        handle_text(
            &registry,
            connection_id,
            r#"{"type":"ready","generation":45,"pid":456}"#,
        )
        .await;
        let snapshot = registry.snapshot().await;
        assert_eq!(snapshot.status, "ready");
        assert!(snapshot.ready);
        assert_eq!(snapshot.pid, Some(456));
    }

    #[tokio::test]
    async fn ready_capture_without_any_packets_eventually_becomes_stalled() {
        let registry = JamSourceRegistry::new(true);
        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        registry.register(command_tx).await;
        {
            let mut inner = registry.inner.lock().await;
            inner.desired_generation = Some(46);
            inner.ready_generation = Some(46);
            inner.ready_at = Some(
                Instant::now() - SOURCE_FRAME_STALL_TIMEOUT - std::time::Duration::from_secs(1),
            );
        }

        assert_eq!(registry.snapshot().await.status, "stalled");
    }

    #[tokio::test]
    async fn old_frame_health_becomes_stalled() {
        let registry = JamSourceRegistry::new(true);
        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        registry.register(command_tx).await;
        {
            let mut inner = registry.inner.lock().await;
            inner.desired_generation = Some(3);
            inner.ready_generation = Some(3);
            inner.status = "live".to_string();
            inner.last_frame_at = Some(Instant::now() - std::time::Duration::from_secs(4));
        }
        assert_eq!(registry.snapshot().await.status, "stalled");
    }

    #[tokio::test]
    async fn recent_frames_without_recent_audible_signal_are_silent() {
        let registry = JamSourceRegistry::new(true);
        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        registry.register(command_tx).await;
        {
            let mut inner = registry.inner.lock().await;
            inner.desired_generation = Some(4);
            inner.ready_generation = Some(4);
            inner.last_frame_at = Some(Instant::now());
            inner.last_audible_at = Some(Instant::now() - std::time::Duration::from_secs(3));
        }
        assert_eq!(registry.snapshot().await.status, "silent");
    }

    #[tokio::test]
    async fn stale_heartbeat_is_offline_and_start_is_rejected() {
        let registry = JamSourceRegistry::new(true);
        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        registry.register(command_tx).await;
        registry.inner.lock().await.last_activity_at =
            Some(Instant::now() - SOURCE_ACTIVITY_TIMEOUT - std::time::Duration::from_secs(1));

        let snapshot = registry.snapshot().await;
        assert_eq!(snapshot.status, "offline");
        assert!(!snapshot.connected);
        assert!(!snapshot.ready);
        assert_eq!(
            registry.start(12).await.unwrap_err(),
            "Configured Jam source heartbeat is stale"
        );
    }

    #[tokio::test]
    async fn active_generation_rejects_idle_or_stale_heartbeat_liveness() {
        let registry = JamSourceRegistry::new(true);
        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        let connection_id = registry.register(command_tx).await;
        {
            let mut inner = registry.inner.lock().await;
            inner.desired_generation = Some(12);
            inner.ready_generation = Some(12);
            inner.last_activity_at =
                Some(Instant::now() - SOURCE_ACTIVITY_TIMEOUT - std::time::Duration::from_secs(1));
        }

        handle_text(
            &registry,
            connection_id,
            r#"{"type":"heartbeat","generation":0}"#,
        )
        .await;
        assert_eq!(registry.snapshot().await.status, "offline");

        handle_text(
            &registry,
            connection_id,
            r#"{"type":"heartbeat","generation":12}"#,
        )
        .await;
        let snapshot = registry.snapshot().await;
        assert!(snapshot.connected);
        assert!(snapshot.ready);
    }

    #[tokio::test]
    async fn superseded_connection_cannot_report_ready() {
        let registry = JamSourceRegistry::new(true);
        let (old_tx, _old_rx) = mpsc::unbounded_channel();
        let old_connection_id = registry.register(old_tx).await;
        let (new_tx, _new_rx) = mpsc::unbounded_channel();
        registry.register(new_tx).await;
        registry.inner.lock().await.desired_generation = Some(17);

        handle_text(
            &registry,
            old_connection_id,
            r#"{"type":"ready","generation":17,"pid":123}"#,
        )
        .await;

        assert!(!registry.snapshot().await.ready);
    }

    #[tokio::test]
    async fn ready_clears_a_prior_capture_error() {
        let registry = JamSourceRegistry::new(true);
        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        let connection_id = registry.register(command_tx).await;
        registry.inner.lock().await.desired_generation = Some(21);

        handle_text(
            &registry,
            connection_id,
            r#"{"type":"error","generation":21,"message":"capture failed"}"#,
        )
        .await;
        assert_eq!(registry.snapshot().await.status, "error");

        handle_text(
            &registry,
            connection_id,
            r#"{"type":"ready","generation":21,"pid":456}"#,
        )
        .await;
        let snapshot = registry.snapshot().await;
        assert!(snapshot.ready);
        assert_eq!(snapshot.status, "ready");
        assert!(snapshot.error.is_none());
    }
}
