//! Dedicated Spotify Jam source agent.
//!
//! This runs in the interactive desktop process, independently of the viewer
//! and independently of screen-share audio. The control plane selects when a
//! generation starts; this configured client is the only capture authority.

use crate::audio_capture::{
    find_spotify_root_pid, start_owned_process_capture, validate_spotify_root_pid,
    OwnedProcessCapture, ProcessCaptureEvent,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, USER_AGENT};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const PROTOCOL_VERSION: u8 = 2;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(250);
const WEBSOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const WEBSOCKET_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RECONNECT_DELAY_SECS: u64 = 30;

fn log_jam_source(message: &str) {
    eprintln!("{}", message);
    crate::file_debug_log::append(message);
}

#[derive(Clone, Deserialize)]
pub struct JamSourceConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub token: String,
}

impl JamSourceConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("jam_source.id cannot be empty".to_string());
        }
        if self.token.trim().is_empty() {
            return Err("jam_source.token cannot be empty".to_string());
        }
        Ok(())
    }
}

pub struct JamSourceAgent {
    shutdown: Arc<AtomicBool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl JamSourceAgent {
    pub fn start(server: String, config: JamSourceConfig) -> Result<Self, String> {
        config.validate()?;
        let endpoint = build_source_ws_url(&server, &config.id)?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let task_shutdown = shutdown.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_agent(endpoint, config, task_shutdown).await;
        });

        Ok(Self { shutdown, task })
    }

    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

impl Drop for JamSourceAgent {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.task.abort();
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ServerCommand {
    Start { generation: u64 },
    Stop { generation: u64 },
    Restart { generation: u64 },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum SourceMessage<'a> {
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
        message: &'a str,
    },
    Heartbeat {
        generation: u64,
    },
    Restarting {
        generation: u64,
    },
}

struct ActiveCapture {
    generation: u64,
    pid: u32,
    _handle: OwnedProcessCapture,
    events: tokio::sync::mpsc::Receiver<ProcessCaptureEvent>,
}

#[derive(Default)]
struct GenerationFence {
    highest_seen: u64,
    stopped_through: Option<u64>,
}

impl GenerationFence {
    fn accept_start(&mut self, generation: u64, active_generation: Option<u64>) -> bool {
        if active_generation == Some(generation) || generation < self.highest_seen {
            return false;
        }
        if self
            .stopped_through
            .map(|stopped| generation <= stopped)
            .unwrap_or(false)
        {
            return false;
        }
        self.highest_seen = self.highest_seen.max(generation);
        true
    }

    fn accept_stop(&mut self, generation: u64) -> bool {
        if generation < self.highest_seen {
            return false;
        }
        self.highest_seen = generation;
        self.stopped_through = Some(
            self.stopped_through
                .map(|stopped| stopped.max(generation))
                .unwrap_or(generation),
        );
        true
    }

    fn accept_restart(&self, generation: u64, active_generation: Option<u64>) -> bool {
        active_generation == Some(generation)
            && self.highest_seen == generation
            && self
                .stopped_through
                .map(|stopped| generation > stopped)
                .unwrap_or(true)
    }
}

#[derive(Default)]
struct ConnectionAttemptState {
    websocket_established: bool,
}

impl ConnectionAttemptState {
    fn mark_websocket_established(&mut self) {
        self.websocket_established = true;
    }

    fn retry_delay_secs(&self, current_delay_secs: u64) -> u64 {
        if self.websocket_established {
            1
        } else {
            current_delay_secs
        }
    }
}

async fn run_agent(endpoint: String, config: JamSourceConfig, shutdown: Arc<AtomicBool>) {
    let mut reconnect_delay_secs = 1_u64;

    while !shutdown.load(Ordering::SeqCst) {
        let mut attempt = ConnectionAttemptState::default();
        let result = run_connection(&endpoint, &config, &shutdown, &mut attempt).await;
        reconnect_delay_secs = attempt.retry_delay_secs(reconnect_delay_secs);

        match result {
            Ok(()) => {
                log_jam_source("[jam-source] connection closed; reconnecting");
            }
            Err(error) => {
                log_jam_source(&format!(
                    "[jam-source] connection failed: {}; retrying in {}s",
                    error, reconnect_delay_secs
                ));
            }
        }

        if wait_or_shutdown(Duration::from_secs(reconnect_delay_secs), &shutdown).await {
            break;
        }
        reconnect_delay_secs = next_reconnect_delay(reconnect_delay_secs);
    }

    log_jam_source("[jam-source] agent stopped");
}

async fn run_connection(
    endpoint: &str,
    config: &JamSourceConfig,
    shutdown: &AtomicBool,
    attempt: &mut ConnectionAttemptState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut request = endpoint.into_client_request()?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", config.token))?,
    );
    request.headers_mut().insert(
        USER_AGENT,
        HeaderValue::from_str(&format!(
            "echo-core-client/{} jam-source/{}",
            env!("CARGO_PKG_VERSION"),
            PROTOCOL_VERSION
        ))?,
    );

    let connect_result = tokio::time::timeout(
        WEBSOCKET_CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| {
        reconnect_error(format!(
            "WebSocket connection timed out after {}s",
            WEBSOCKET_CONNECT_TIMEOUT.as_secs()
        ))
    })?;
    let (socket, _) = connect_result?;
    attempt.mark_websocket_established();
    log_jam_source(&format!(
        "[jam-source] configured source '{}' connected",
        config.id
    ));
    let (mut writer, mut reader) = socket.split();
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut shutdown_poll = tokio::time::interval(SHUTDOWN_POLL_INTERVAL);
    shutdown_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut active: Option<ActiveCapture> = None;
    let mut generation_fence = GenerationFence::default();

    loop {
        tokio::select! {
            incoming = reader.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let command = match parse_server_command(&text) {
                            Ok(command) => command,
                            Err(error) => {
                                send_source_message(
                                    &mut writer,
                                    &SourceMessage::Error {
                                        generation: active.as_ref().map(|capture| capture.generation).unwrap_or(0),
                                        message: &error,
                                    },
                                ).await?;
                                continue;
                            }
                        };

                        match command {
                            ServerCommand::Start { generation } => {
                                if !generation_fence.accept_start(
                                    generation,
                                    active.as_ref().map(|capture| capture.generation),
                                ) {
                                    continue;
                                }

                                active.take();
                                match start_spotify_capture(generation) {
                                    Ok(capture) => active = Some(capture),
                                    Err(error) => {
                                        send_source_message(
                                            &mut writer,
                                            &SourceMessage::Error {
                                                generation,
                                                message: &error,
                                            },
                                        ).await?;
                                        return Err(reconnect_error(error));
                                    }
                                }
                            }
                            ServerCommand::Stop { generation } => {
                                if !generation_fence.accept_stop(generation) {
                                    continue;
                                }
                                if active
                                    .as_ref()
                                    .map(|capture| capture.generation <= generation)
                                    .unwrap_or(false)
                                {
                                    log_jam_source(&format!(
                                        "[jam-source] stopping generation {}",
                                        generation
                                    ));
                                    active.take();
                                }
                            }
                            ServerCommand::Restart { generation } => {
                                if !generation_fence.accept_restart(
                                    generation,
                                    active.as_ref().map(|capture| capture.generation),
                                ) {
                                    continue;
                                }

                                // Drop the old handle before acknowledging. Messages sent
                                // before `restarting` belong to the old capture; messages
                                // after it belong to the replacement on this ordered socket.
                                active.take();
                                log_jam_source(&format!(
                                    "[jam-source] restarting stalled capture generation {}",
                                    generation
                                ));
                                send_source_message(
                                    &mut writer,
                                    &SourceMessage::Restarting { generation },
                                ).await?;

                                match start_spotify_capture(generation) {
                                    Ok(capture) => active = Some(capture),
                                    Err(error) => {
                                        send_source_message(
                                            &mut writer,
                                            &SourceMessage::Error {
                                                generation,
                                                message: &error,
                                            },
                                        ).await?;
                                        return Err(reconnect_error(error));
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        send_ws_message(&mut writer, Message::Pong(payload)).await?;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(error.into()),
                }
            }
            capture_event = next_capture_event(&mut active) => {
                let Some((generation, event)) = capture_event else {
                    if let Some(capture) = active.take() {
                        let message = "Spotify audio capture event channel closed";
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Error {
                                generation: capture.generation,
                                message,
                            },
                        ).await?;
                        return Err(reconnect_error(format!(
                            "generation {} {}",
                            capture.generation, message
                        )));
                    }
                    continue;
                };
                let terminal_reason = terminal_capture_reconnect_reason(&event);
                match event {
                    ProcessCaptureEvent::Format(format) => {
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Format {
                                generation,
                                sample_rate: format.sample_rate,
                                channels: format.channels,
                            },
                        ).await?;
                    }
                    ProcessCaptureEvent::Started { pid } => {
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Ready { generation, pid },
                        ).await?;
                    }
                    ProcessCaptureEvent::Data(bytes) => {
                        send_ws_message(
                            &mut writer,
                            Message::Binary(frame_payload(generation, &bytes)),
                        ).await?;
                    }
                    ProcessCaptureEvent::Error(message) => {
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Error {
                                generation,
                                message: &message,
                            },
                        ).await?;
                    }
                    ProcessCaptureEvent::Stopped => {
                        let message = "Spotify audio capture stopped";
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Error { generation, message },
                        ).await?;
                    }
                }
                if let Some(reason) = terminal_reason {
                    return Err(reconnect_error(format!(
                        "generation {} {}",
                        generation, reason
                    )));
                }
            }
            _ = heartbeat.tick() => {
                if let Some((generation, pid)) = active
                    .as_ref()
                    .map(|capture| (capture.generation, capture.pid))
                {
                    if let Err(error) = validate_spotify_root_pid(pid) {
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Error {
                                generation,
                                message: &error,
                            },
                        ).await?;
                        return Err(reconnect_error(format!(
                            "generation {} lost Spotify root PID {}: {}",
                            generation, pid, error
                        )));
                    }
                }
                send_source_message(
                    &mut writer,
                    &SourceMessage::Heartbeat {
                        generation: active.as_ref().map(|capture| capture.generation).unwrap_or(0),
                    },
                ).await?;
            }
            _ = shutdown_poll.tick() => {
                if shutdown.load(Ordering::SeqCst) {
                    send_ws_message(&mut writer, Message::Close(None)).await?;
                    break;
                }
            }
        }
    }

    // Dropping the owned handle stops only Jam capture before reconnecting.
    active.take();
    Ok(())
}

fn start_spotify_capture(generation: u64) -> Result<ActiveCapture, String> {
    let pid = find_spotify_root_pid().map_err(|error| {
        format!(
            "generation {} could not bind Spotify: {}",
            generation, error
        )
    })?;
    let (handle, events) = start_owned_process_capture(pid).map_err(|error| {
        format!(
            "generation {} capture start failed for Spotify root PID {}: {}",
            generation, pid, error
        )
    })?;
    log_jam_source(&format!(
        "[jam-source] generation {} capturing Spotify root PID {}",
        generation, pid
    ));
    Ok(ActiveCapture {
        generation,
        pid,
        _handle: handle,
        events,
    })
}

async fn next_capture_event(
    active: &mut Option<ActiveCapture>,
) -> Option<(u64, ProcessCaptureEvent)> {
    match active {
        Some(capture) => capture
            .events
            .recv()
            .await
            .map(|event| (capture.generation, event)),
        None => std::future::pending().await,
    }
}

async fn send_source_message<S>(
    writer: &mut S,
    message: &SourceMessage<'_>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    send_ws_message(writer, Message::Text(serde_json::to_string(message)?)).await?;
    Ok(())
}

async fn send_ws_message<S>(
    writer: &mut S,
    message: Message,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    send_ws_message_with_timeout(writer, message, WEBSOCKET_SEND_TIMEOUT).await
}

async fn send_ws_message_with_timeout<S>(
    writer: &mut S,
    message: Message,
    timeout: Duration,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    tokio::time::timeout(timeout, writer.send(message))
        .await
        .map_err(|_| {
            reconnect_error(format!(
                "WebSocket send timed out after {}ms",
                timeout.as_millis()
            ))
        })??;
    Ok(())
}

async fn wait_or_shutdown(duration: Duration, shutdown: &AtomicBool) -> bool {
    let deadline = tokio::time::sleep(duration);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return shutdown.load(Ordering::SeqCst),
            _ = tokio::time::sleep(SHUTDOWN_POLL_INTERVAL) => {
                if shutdown.load(Ordering::SeqCst) {
                    return true;
                }
            }
        }
    }
}

fn parse_server_command(text: &str) -> Result<ServerCommand, String> {
    serde_json::from_str(text).map_err(|error| format!("invalid source command: {}", error))
}

fn terminal_capture_reconnect_reason(event: &ProcessCaptureEvent) -> Option<String> {
    match event {
        ProcessCaptureEvent::Error(message) => {
            Some(format!("Spotify audio capture failed: {}", message))
        }
        ProcessCaptureEvent::Stopped => Some("Spotify audio capture stopped".to_string()),
        _ => None,
    }
}

fn reconnect_error(message: String) -> Box<dyn std::error::Error + Send + Sync> {
    std::io::Error::other(message).into()
}

fn frame_payload(generation: u64, pcm_f32_le: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8 + pcm_f32_le.len());
    payload.extend_from_slice(&generation.to_le_bytes());
    payload.extend_from_slice(pcm_f32_le);
    payload
}

fn next_reconnect_delay(current_secs: u64) -> u64 {
    current_secs.saturating_mul(2).min(MAX_RECONNECT_DELAY_SECS)
}

fn build_source_ws_url(server: &str, source_id: &str) -> Result<String, String> {
    let base = server.trim().trim_end_matches('/');
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{}", rest)
    } else if base.starts_with("wss://") || base.starts_with("ws://") {
        base.to_string()
    } else {
        return Err("Jam source server must use http, https, ws, or wss".to_string());
    };

    Ok(format!(
        "{}/api/jam/source?source_id={}&protocol={}",
        ws_base,
        percent_encode_component(source_id),
        PROTOCOL_VERSION
    ))
}

fn percent_encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_authenticated_source_endpoint_without_token_in_url() {
        let url = build_source_ws_url("https://echo.example:9443/", "SAM PC/source").unwrap();
        assert_eq!(
            url,
            "wss://echo.example:9443/api/jam/source?source_id=SAM%20PC%2Fsource&protocol=2"
        );
        assert!(!url.contains("token"));
    }

    #[test]
    fn parses_generation_commands() {
        assert_eq!(
            parse_server_command(r#"{"type":"start","generation":42}"#).unwrap(),
            ServerCommand::Start { generation: 42 }
        );
        assert_eq!(
            parse_server_command(r#"{"type":"stop","generation":43}"#).unwrap(),
            ServerCommand::Stop { generation: 43 }
        );
        assert_eq!(
            parse_server_command(r#"{"type":"restart","generation":42}"#).unwrap(),
            ServerCommand::Restart { generation: 42 }
        );
    }

    #[test]
    fn binary_frame_prefix_is_little_endian_generation() {
        let pcm = [0_u8, 0, 128, 63];
        let payload = frame_payload(0x0102_0304_0506_0708, &pcm);
        assert_eq!(&payload[..8], &[8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(&payload[8..], &pcm);
    }

    #[test]
    fn reconnect_backoff_is_bounded() {
        assert_eq!(next_reconnect_delay(1), 2);
        assert_eq!(next_reconnect_delay(16), 30);
        assert_eq!(next_reconnect_delay(30), 30);
    }

    #[test]
    fn established_connection_resets_backoff_even_after_later_error() {
        let mut attempt = ConnectionAttemptState::default();
        assert_eq!(attempt.retry_delay_secs(30), 30);

        attempt.mark_websocket_established();
        let later_session_result: Result<(), &str> = Err("Spotify capture stopped");

        assert!(later_session_result.is_err());
        assert_eq!(attempt.retry_delay_secs(30), 1);
    }

    #[test]
    fn source_config_rejects_missing_binding_values() {
        assert!(JamSourceConfig {
            id: "".into(),
            token: "secret".into()
        }
        .validate()
        .is_err());
        assert!(JamSourceConfig {
            id: "sam-pc".into(),
            token: "".into()
        }
        .validate()
        .is_err());
    }

    #[test]
    fn generation_fence_ignores_stale_start_after_stop() {
        let mut fence = GenerationFence::default();
        assert!(fence.accept_start(7, None));
        assert!(fence.accept_stop(7));
        assert!(!fence.accept_start(7, None));
        assert!(!fence.accept_start(6, None));
        assert!(fence.accept_start(8, None));
    }

    #[test]
    fn capture_restart_requires_the_exact_active_unstopped_generation() {
        let mut fence = GenerationFence::default();
        assert!(!fence.accept_restart(7, Some(7)));
        assert!(fence.accept_start(7, None));
        assert!(fence.accept_restart(7, Some(7)));
        assert!(!fence.accept_restart(6, Some(7)));
        assert!(!fence.accept_restart(7, None));
        assert!(fence.accept_stop(7));
        assert!(!fence.accept_restart(7, Some(7)));
        assert!(fence.accept_start(8, None));
        assert!(!fence.accept_restart(7, Some(8)));
        assert!(fence.accept_restart(8, Some(8)));
    }

    #[test]
    fn terminal_capture_events_require_connection_replay() {
        assert!(
            terminal_capture_reconnect_reason(&ProcessCaptureEvent::Error(
                "device invalidated".into()
            ))
            .is_some()
        );
        assert!(terminal_capture_reconnect_reason(&ProcessCaptureEvent::Stopped).is_some());
        assert!(
            terminal_capture_reconnect_reason(&ProcessCaptureEvent::Data(vec![0; 4])).is_none()
        );
    }

    #[tokio::test]
    async fn websocket_send_timeout_breaks_a_stalled_sink() {
        let mut stalled_sink = Box::pin(futures_util::sink::unfold(
            (),
            |(), _message: Message| async move {
                std::future::pending::<Result<(), tokio_tungstenite::tungstenite::Error>>().await
            },
        ));

        let error = send_ws_message_with_timeout(
            &mut stalled_sink,
            Message::Text("heartbeat".into()),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("WebSocket send timed out"));
    }
}
