use crate::auth::{
    ensure_admin, ensure_jam_actor, ensure_jam_participant, ensure_jam_participant_token, JamActor,
    RevokedParticipantBinding,
};
use crate::config::*;
use crate::jam_history::new_history_observation;
use crate::jam_library::{
    fetch_favorite_summary, fetch_playlist_expansion, valid_spotify_id, FavoriteKind,
    FavoriteSummary, JamApiError, SkippedPlaylistItem,
};
use crate::rooms::schedule_jam_auto_end;
use crate::AppState;

use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::{
    extract::{Json, Query, State},
    http::{header::RETRY_AFTER, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tracing::{info, warn};

const SPOTIFY_RELEASE_PAUSE_TIMEOUT: Duration = Duration::from_secs(15);
const SPOTIFY_START_BIND_TIMEOUT: Duration = Duration::from_secs(15);
const SPOTIFY_RECOVERY_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const SOURCE_START_RECHECK_INTERVAL: Duration = Duration::from_millis(100);

// ── Structs ──────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct SpotifyToken {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) expires_at: u64, // unix timestamp
}

pub(crate) struct SpotifyPending {
    pub(crate) state: String,
    pub(crate) code: Option<String>,
}

#[derive(Default)]
pub(crate) struct JamState {
    pub(crate) active: bool,
    pub(crate) starting: bool,
    pub(crate) generation: u64,
    pub(crate) host_identity: String,
    pub(crate) host_participant_auth_id: String,
    pub(crate) spotify_token: Option<SpotifyToken>,
    pub(crate) queue: Vec<QueuedTrack>,
    pub(crate) playlist_queue_receipts: HashMap<String, PlaylistQueueReceipt>,
    pub(crate) queue_control_epoch: u64,
    pub(crate) queue_control_stopped: bool,
    pub(crate) last_history_spotify_id: Option<String>,
    pub(crate) now_playing: Option<NowPlayingInfo>,
    pub(crate) listeners: HashMap<String, String>,
    pub(crate) audio_connections: HashMap<String, JamAudioConnection>,
    pub(crate) next_audio_connection_id: u64,
    pub(crate) spotify_device_id: Option<String>,
    pub(crate) spotify_device_name: Option<String>,
    pub(crate) last_error: Option<String>,
    pub(crate) spotify_is_playing: bool,
    pub(crate) audio_expected_since: Option<std::time::Instant>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JamAudioConnection {
    pub(crate) participant_auth_id: String,
    pub(crate) generation: u64,
    pub(crate) connection_id: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) struct QueuedPlaylistProvenance {
    pub(crate) spotify_id: String,
    pub(crate) spotify_uri: String,
    pub(crate) spotify_url: String,
    pub(crate) name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct QueuedTrack {
    #[serde(default)]
    pub(crate) queue_entry_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) queue_batch_id: Option<String>,
    #[serde(default)]
    pub(crate) spotify_id: String,
    pub(crate) spotify_uri: String,
    #[serde(default)]
    pub(crate) spotify_url: String,
    pub(crate) name: String,
    pub(crate) artist: String,
    pub(crate) album_art_url: String,
    pub(crate) duration_ms: u64,
    #[serde(default)]
    pub(crate) added_at_ms: u64,
    #[serde(default)]
    pub(crate) added_by_actor_id: String,
    #[serde(default)]
    pub(crate) added_by_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) playlist: Option<QueuedPlaylistProvenance>,
    // Kept for compatibility with the existing viewer during rollout.
    pub(crate) added_by: String,
}

#[derive(Clone, Debug)]
pub(crate) struct PlaylistQueueReceipt {
    actor_id: String,
    playlist_id: String,
    generation: u64,
    created_at_ms: u64,
    response: PlaylistQueueResponse,
}

fn insert_playlist_queue_receipt(
    jam: &mut JamState,
    request_id: String,
    receipt: PlaylistQueueReceipt,
) {
    if jam.playlist_queue_receipts.len() >= 128 {
        let oldest = jam
            .playlist_queue_receipts
            .iter()
            .min_by_key(|(_, receipt)| receipt.created_at_ms)
            .map(|(request_id, _)| request_id.clone());
        if let Some(oldest) = oldest {
            jam.playlist_queue_receipts.remove(&oldest);
        }
    }
    jam.playlist_queue_receipts.insert(request_id, receipt);
}

fn playlist_queue_receipt_response(
    jam: &JamState,
    request_id: &str,
    actor_id: &str,
    playlist_id: &str,
    generation: u64,
) -> Result<Option<PlaylistQueueResponse>, ()> {
    let Some(receipt) = jam.playlist_queue_receipts.get(request_id) else {
        return Ok(None);
    };
    if receipt.actor_id == actor_id
        && receipt.playlist_id == playlist_id
        && receipt.generation == generation
    {
        Ok(Some(receipt.response.clone()))
    } else {
        Err(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct NowPlayingInfo {
    #[serde(default)]
    pub(crate) spotify_id: String,
    #[serde(default)]
    pub(crate) spotify_uri: String,
    #[serde(default)]
    pub(crate) spotify_url: String,
    pub(crate) name: String,
    pub(crate) artist: String,
    pub(crate) album_art_url: String,
    pub(crate) duration_ms: u64,
    pub(crate) progress_ms: u64,
    pub(crate) is_playing: bool,
    #[serde(skip)]
    pub(crate) fetched_at: Option<std::time::Instant>,
}

// ── Request structs ──────────────────────────────────────────────────────

#[derive(Deserialize)]
pub(crate) struct SpotifyInitRequest {
    state: String,
    challenge: String,
}

#[derive(Deserialize)]
pub(crate) struct SpotifyCallbackQuery {
    code: String,
    state: String,
}

#[derive(Deserialize)]
pub(crate) struct SpotifyCodeQuery {
    state: String,
}

#[derive(Deserialize)]
pub(crate) struct SpotifyTokenRequest {
    code: String,
    verifier: String,
}

#[derive(Deserialize)]
pub(crate) struct JamStartRequest {
    identity: String,
}

#[derive(Deserialize)]
pub(crate) struct JamSearchRequest {
    query: String,
}

#[derive(Deserialize)]
pub(crate) struct JamQueueRequest {
    generation: u64,
    spotify_uri: String,
    #[serde(rename = "name")]
    _name: String,
    #[serde(rename = "artist")]
    _artist: String,
    #[serde(rename = "album_art_url")]
    _album_art_url: String,
    #[serde(rename = "duration_ms")]
    _duration_ms: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PlaylistQueueRequest {
    generation: u64,
    playlist_id: String,
    request_id: String,
    #[serde(default)]
    confirmed: bool,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PlaylistQueueFailure {
    status: u16,
    error: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PlaylistQueueResponse {
    schema_version: u16,
    ok: bool,
    partial: bool,
    request_id: String,
    queue_batch_id: String,
    // Compatibility alias for early clients built during this workstream.
    batch_id: String,
    generation: u64,
    playlist: QueuedPlaylistProvenance,
    queued: Vec<QueuedTrack>,
    queued_count: usize,
    skipped: Vec<SkippedPlaylistItem>,
    skipped_count: usize,
    complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<PlaylistQueueFailure>,
}

#[derive(Deserialize)]
pub(crate) struct JamIdentityRequest {
    identity: String,
    generation: u64,
}

#[derive(Deserialize)]
pub(crate) struct JamGenerationRequest {
    generation: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JamAudioAuthMessage {
    #[serde(rename = "type")]
    message_type: String,
    token: String,
}

// ── Spotify OAuth endpoints ──────────────────────────────────────────────

pub(crate) async fn jam_spotify_init(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SpotifyInitRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let client_id = state.spotify_client_id.clone();
    if client_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let redirect_uri = format!(
        "https://127.0.0.1:{}/api/jam/spotify-callback",
        state.config.port
    );
    let scopes = "user-read-private user-modify-playback-state user-read-currently-playing user-read-playback-state user-library-read playlist-read-private playlist-read-collaborative";
    let auth_url = format!(
        "https://accounts.spotify.com/authorize?client_id={}&response_type=code&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        urlencoded(&client_id),
        urlencoded(&redirect_uri),
        urlencoded(scopes),
        urlencoded(&payload.state),
        urlencoded(&payload.challenge),
    );

    let mut pending = state
        .spotify_pending
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *pending = Some(SpotifyPending {
        state: payload.state,
        code: None,
    });

    Ok(Json(serde_json::json!({ "auth_url": auth_url })))
}

pub(crate) async fn jam_spotify_callback(
    State(state): State<AppState>,
    Query(params): Query<SpotifyCallbackQuery>,
) -> Result<Html<String>, StatusCode> {
    let mut pending = state
        .spotify_pending
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let p = pending.as_mut().ok_or(StatusCode::BAD_REQUEST)?;
    if p.state != params.state {
        return Err(StatusCode::BAD_REQUEST);
    }
    p.code = Some(params.code);
    Ok(Html("<html><body><h1>Spotify Connected!</h1><p>You can close this tab and return to Echo Chamber.</p></body></html>".to_string()))
}

pub(crate) async fn jam_spotify_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SpotifyCodeQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let pending = state
        .spotify_pending
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(p) = pending.as_ref() {
        if p.state == params.state {
            if let Some(code) = &p.code {
                return Ok(Json(serde_json::json!({ "code": code })));
            }
        }
    }
    Err(StatusCode::NOT_FOUND)
}

pub(crate) async fn jam_spotify_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SpotifyTokenRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let client_id = state.spotify_client_id.clone();
    if client_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let redirect_uri = format!(
        "https://127.0.0.1:{}/api/jam/spotify-callback",
        state.config.port
    );
    let resp = state
        .http_client
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", &payload.code),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", &client_id),
            ("code_verifier", &payload.verifier),
        ])
        .send()
        .await
        .map_err(|e| {
            warn!("Spotify token exchange failed: {}", e);
            StatusCode::BAD_GATEWAY
        })?;

    let data: serde_json::Value = resp.json().await.map_err(|e| {
        warn!("Spotify token response parse failed: {}", e);
        StatusCode::BAD_GATEWAY
    })?;

    let access_token = data["access_token"]
        .as_str()
        .ok_or(StatusCode::BAD_GATEWAY)?
        .to_string();
    let refresh_token = data["refresh_token"]
        .as_str()
        .ok_or(StatusCode::BAD_GATEWAY)?
        .to_string();
    let expires_in = data["expires_in"].as_u64().unwrap_or(3600);

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let token = SpotifyToken {
        access_token,
        refresh_token,
        expires_at: now_secs + expires_in,
    };

    {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        jam.spotify_token = Some(token.clone());
    }
    {
        let mut pending = state
            .spotify_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *pending = None;
    }

    let persisted = persist_spotify_token(
        &state.spotify_token_file,
        &token,
        state.spotify_token_storage_enabled,
    );
    if persisted {
        info!("Spotify token stored in memory and persisted to disk");
    } else {
        info!("Spotify token stored in memory only");
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) fn persist_spotify_token(
    path: &std::path::Path,
    token: &SpotifyToken,
    storage_enabled: bool,
) -> bool {
    if !storage_enabled {
        warn!("Spotify token persistence is disabled because its path is not private");
        return false;
    }
    match serde_json::to_string_pretty(token) {
        Ok(json) => {
            if let Err(e) = fs::write(path, &json) {
                warn!("Failed to persist Spotify token: {}", e);
                false
            } else {
                info!("Spotify token persisted to {:?}", path);
                true
            }
        }
        Err(e) => {
            warn!("Failed to serialize Spotify token: {}", e);
            false
        }
    }
}

// ── Spotify API proxy helper ─────────────────────────────────────────────

fn spotify_rate_limit_error(state: &AppState) -> Option<(StatusCode, String)> {
    let seconds = spotify_retry_after_seconds(state)?;
    Some((
        StatusCode::TOO_MANY_REQUESTS,
        format!("Spotify rate limit is active; retry after {seconds} seconds"),
    ))
}

fn remember_spotify_rate_limit(state: &AppState, response: &reqwest::Response) {
    if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
        return;
    }
    let Some(seconds) = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return;
    };
    let until = std::time::Instant::now() + Duration::from_secs(seconds.min(24 * 60 * 60));
    let mut guard = state
        .spotify_rate_limit_until
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if guard.is_none_or(|current| until > current) {
        *guard = Some(until);
    }
}

pub(crate) fn spotify_retry_after_seconds(state: &AppState) -> Option<String> {
    let remaining = state
        .spotify_rate_limit_until
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .and_then(|until| until.checked_duration_since(std::time::Instant::now()))?;
    Some(
        remaining
            .as_secs()
            .saturating_add(u64::from(remaining.subsec_nanos() > 0))
            .max(1)
            .to_string(),
    )
}

pub(crate) async fn spotify_api_request(
    state: &AppState,
    method: reqwest::Method,
    url: &str,
    body: Option<serde_json::Value>,
) -> Result<reqwest::Response, (StatusCode, String)> {
    let token = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        jam.spotify_token
            .clone()
            .ok_or((StatusCode::BAD_REQUEST, "Spotify not connected".to_string()))?
    };

    let mut req = state
        .http_client
        .request(method.clone(), url)
        .header("Authorization", format!("Bearer {}", token.access_token));

    if let Some(b) = &body {
        req = req.json(b);
    } else if method == reqwest::Method::POST || method == reqwest::Method::PUT {
        // Spotify returns 411 Length Required for POST/PUT without Content-Length
        req = req.header("Content-Length", "0");
    }

    if let Some(error) = spotify_rate_limit_error(state) {
        return Err(error);
    }
    let resp = {
        let _permit = state.spotify_request_limit.acquire().await.map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Spotify request gate is unavailable".to_string(),
            )
        })?;
        req.send()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?
    };
    remember_spotify_rate_limit(state, &resp);

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        // Try refresh
        if let Some(new_token) = refresh_spotify_token(state, &token).await {
            let mut retry = state.http_client.request(method.clone(), url).header(
                "Authorization",
                format!("Bearer {}", new_token.access_token),
            );
            if let Some(b) = body {
                retry = retry.json(&b);
            } else if method == reqwest::Method::POST || method == reqwest::Method::PUT {
                retry = retry.header("Content-Length", "0");
            }
            if let Some(error) = spotify_rate_limit_error(state) {
                return Err(error);
            }
            let _permit = state.spotify_request_limit.acquire().await.map_err(|_| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Spotify request gate is unavailable".to_string(),
                )
            })?;
            let response = retry
                .send()
                .await
                .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
            remember_spotify_rate_limit(state, &response);
            return Ok(response);
        }
        if let Some(error) = spotify_rate_limit_error(state) {
            return Err(error);
        }
    }

    Ok(resp)
}

async fn refresh_spotify_token(state: &AppState, old: &SpotifyToken) -> Option<SpotifyToken> {
    let _refresh = state.spotify_refresh_lock.lock().await;
    let current = {
        state
            .jam
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .spotify_token
            .clone()
    };
    if let Some(current) = current {
        if current.access_token != old.access_token {
            return Some(current);
        }
    }
    if spotify_rate_limit_error(state).is_some() {
        return None;
    }
    let resp = {
        let _permit = state.spotify_request_limit.acquire().await.ok()?;
        state
            .http_client
            .post("https://accounts.spotify.com/api/token")
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &old.refresh_token),
                ("client_id", &state.spotify_client_id),
            ])
            .send()
            .await
            .ok()?
    };
    remember_spotify_rate_limit(state, &resp);

    let data: serde_json::Value = resp.json().await.ok()?;
    let new_token = SpotifyToken {
        access_token: data["access_token"].as_str()?.to_string(),
        refresh_token: data
            .get("refresh_token")
            .and_then(|r| r.as_str())
            .unwrap_or(&old.refresh_token)
            .to_string(),
        expires_at: SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs()
            + data["expires_in"].as_u64().unwrap_or(3600),
    };

    {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        jam.spotify_token = Some(new_token.clone());
    }
    let persisted = persist_spotify_token(
        &state.spotify_token_file,
        &new_token,
        state.spotify_token_storage_enabled,
    );
    if persisted {
        info!("Spotify token refreshed and persisted");
    } else {
        info!("Spotify token refreshed in memory only");
    }
    Some(new_token)
}

#[derive(Clone, Debug)]
struct SpotifyDevice {
    id: String,
    name: String,
}

fn select_spotify_device(
    candidates: Vec<SpotifyDevice>,
    configured_id: Option<&str>,
    configured_name: Option<&str>,
) -> Result<SpotifyDevice, (StatusCode, String)> {
    if let Some(configured_id) = configured_id {
        return candidates
            .into_iter()
            .find(|device| device.id == configured_id)
            .ok_or_else(|| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!(
                        "Configured Spotify device ID '{}' is offline, restricted, or no longer valid",
                        configured_id
                    ),
                )
            });
    }

    let configured_name = configured_name.unwrap_or_default();
    let mut matches = candidates
        .into_iter()
        .filter(|device| device.name.eq_ignore_ascii_case(configured_name));
    let first = matches.next().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Configured Spotify device '{}' is offline", configured_name),
        )
    })?;
    if matches.next().is_some() {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "More than one Spotify device is named '{}'; configure SPOTIFY_DEVICE_ID",
                configured_name
            ),
        ));
    }
    Ok(first)
}

async fn resolve_spotify_device(state: &AppState) -> Result<SpotifyDevice, (StatusCode, String)> {
    if state.config.spotify_device_id.is_none() && state.config.spotify_device_name.is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Spotify source device is not configured (set SPOTIFY_DEVICE_ID or SPOTIFY_DEVICE_NAME)"
                .to_string(),
        ));
    }
    let response = spotify_api_request(
        state,
        reqwest::Method::GET,
        "https://api.spotify.com/v1/me/player/devices",
        None,
    )
    .await?;
    if !response.status().is_success() {
        return Err(spotify_response_error(response, "List Spotify devices").await);
    }
    let data: serde_json::Value = response.json().await.map_err(|error| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Spotify devices response was invalid: {}", error),
        )
    })?;
    let candidates = data["devices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|device| {
            let id = device["id"].as_str()?.trim();
            let name = device["name"].as_str()?.trim();
            if id.is_empty()
                || name.is_empty()
                || device["is_restricted"].as_bool().unwrap_or(false)
            {
                return None;
            }
            Some(SpotifyDevice {
                id: id.to_string(),
                name: name.to_string(),
            })
        })
        .collect::<Vec<_>>();

    select_spotify_device(
        candidates,
        state.config.spotify_device_id.as_deref(),
        state.config.spotify_device_name.as_deref(),
    )
}

async fn bind_spotify_playback_to_device(
    state: &AppState,
    device: &SpotifyDevice,
) -> Result<bool, (StatusCode, String)> {
    let response = spotify_api_request(
        state,
        reqwest::Method::GET,
        "https://api.spotify.com/v1/me/player",
        None,
    )
    .await?;
    let was_playing = if response.status() == reqwest::StatusCode::NO_CONTENT {
        false
    } else if response.status().is_success() {
        let playback: serde_json::Value = response.json().await.map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Spotify playback response was invalid: {}", error),
            )
        })?;
        if playback["device"]["id"].as_str() == Some(device.id.as_str()) {
            return Ok(playback["is_playing"].as_bool().unwrap_or(false));
        }
        playback["is_playing"].as_bool().unwrap_or(false)
    } else {
        return Err(spotify_response_error(response, "Read Spotify playback").await);
    };
    let response = spotify_api_request(
        state,
        reqwest::Method::PUT,
        "https://api.spotify.com/v1/me/player",
        Some(serde_json::json!({
            "device_ids": [device.id],
            "play": was_playing,
        })),
    )
    .await?;
    if !response.status().is_success() {
        return Err(spotify_response_error(response, "Transfer Spotify playback").await);
    }
    Ok(was_playing)
}

fn spotify_pause_url(device_id: &str) -> String {
    format!(
        "https://api.spotify.com/v1/me/player/pause?device_id={}",
        urlencoded(device_id)
    )
}

async fn pause_spotify_playback_on_device(
    state: &AppState,
    device: &SpotifyDevice,
) -> Result<(), (StatusCode, String)> {
    // Stop Music must never transfer playback. Resolve the configured device,
    // then address Spotify's pause endpoint for that device directly.
    let response = spotify_api_request(
        state,
        reqwest::Method::PUT,
        &spotify_pause_url(&device.id),
        None,
    )
    .await?;
    if !response.status().is_success() {
        return Err(spotify_response_error(response, "Stop Spotify playback").await);
    }
    Ok(())
}

async fn spotify_response_error(
    response: reqwest::Response,
    operation: &str,
) -> (StatusCode, String) {
    let upstream_status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value["error"]["message"]
                .as_str()
                .or_else(|| value["error_description"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    let status = match upstream_status {
        reqwest::StatusCode::TOO_MANY_REQUESTS => StatusCode::TOO_MANY_REQUESTS,
        reqwest::StatusCode::FORBIDDEN => StatusCode::FORBIDDEN,
        reqwest::StatusCode::NOT_FOUND => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_GATEWAY,
    };
    (
        status,
        format!(
            "{} failed (Spotify {}): {}",
            operation, upstream_status, message
        ),
    )
}

// ── Jam Session endpoints ────────────────────────────────────────────────

pub(crate) fn clear_active_jam_state(jam: &mut JamState) {
    jam.active = false;
    jam.starting = false;
    jam.host_identity.clear();
    jam.host_participant_auth_id.clear();
    jam.queue.clear();
    jam.playlist_queue_receipts.clear();
    jam.last_history_spotify_id = None;
    jam.listeners.clear();
    jam.audio_connections.clear();
    jam.now_playing = None;
    jam.spotify_device_id = None;
    jam.spotify_device_name = None;
    jam.spotify_is_playing = false;
    jam.queue_control_epoch = jam.queue_control_epoch.wrapping_add(1);
    jam.queue_control_stopped = false;
    jam.audio_expected_since = None;
}

#[derive(Clone, Copy)]
enum JamEndCondition {
    Active,
    ActiveOrStarting,
    NoListeners,
}

fn jam_end_condition_matches(jam: &JamState, generation: u64, condition: JamEndCondition) -> bool {
    if jam.generation != generation {
        return false;
    }
    match condition {
        JamEndCondition::Active => jam.active,
        JamEndCondition::ActiveOrStarting => jam.active || jam.starting,
        JamEndCondition::NoListeners => jam.active && jam.listeners.is_empty(),
    }
}

fn bound_spotify_device(jam: &JamState, generation: u64) -> Option<SpotifyDevice> {
    if jam.generation != generation {
        return None;
    }
    Some(SpotifyDevice {
        id: jam.spotify_device_id.clone()?,
        name: jam.spotify_device_name.clone().unwrap_or_default(),
    })
}

async fn pause_bound_spotify_before_release(
    state: &AppState,
    generation: u64,
    device: Option<&SpotifyDevice>,
) {
    let Some(device) = device else {
        return;
    };
    match tokio::time::timeout(
        SPOTIFY_RELEASE_PAUSE_TIMEOUT,
        pause_spotify_playback_on_device(state, device),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err((_, error))) => {
            // Teardown must still release a wedged source. This is best-effort,
            // but the attempt always precedes the source release command.
            warn!(
                "Jam generation {} could not pause Spotify before source release: {}",
                generation, error
            );
        }
        Err(_) => {
            warn!(
                "Jam generation {} Spotify pause exceeded the {}s source-release deadline",
                generation,
                SPOTIFY_RELEASE_PAUSE_TIMEOUT.as_secs()
            );
        }
    }
}

/// End one exact Jam generation while the caller holds `jam_lifecycle`.
/// Spotify is paused before the native source receives Stop, so restoring its
/// prior per-app output route does not normally make Jam audio erupt locally.
async fn end_jam_generation_locked(
    state: &AppState,
    generation: u64,
    condition: JamEndCondition,
    reason: &str,
    final_error: Option<String>,
) -> bool {
    let device = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !jam_end_condition_matches(&jam, generation, condition) {
            return false;
        }
        bound_spotify_device(&jam, generation)
    };

    pause_bound_spotify_before_release(state, generation, device.as_ref()).await;

    let ended = {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !jam_end_condition_matches(&jam, generation, condition) {
            false
        } else {
            clear_active_jam_state(&mut jam);
            jam.last_error = final_error;
            true
        }
    };
    if !ended {
        return false;
    }

    let bot = {
        let mut guard = state.jam_bot.lock().await;
        if guard.as_ref().map(|bot| bot.generation()) == Some(generation) {
            guard.take()
        } else {
            None
        }
    };
    if let Some(bot) = bot {
        bot.stop().await;
    } else {
        state.jam_source.stop(generation).await;
    }
    info!("Jam generation {} ended ({})", generation, reason);
    true
}

pub(crate) async fn end_jam_for_source_unavailable(
    state: &AppState,
    generation: u64,
    reason: String,
) -> bool {
    let _lifecycle = state.jam_lifecycle.lock().await;
    end_jam_generation_locked(
        state,
        generation,
        JamEndCondition::ActiveOrStarting,
        "source unavailable",
        Some(reason),
    )
    .await
}

fn active_jam_source_watchdog_error(
    source: &crate::jam_source::JamSourceSnapshot,
    generation: u64,
) -> Option<String> {
    let unavailable = !source.connected
        || !source.availability_known
        || !source.enabled
        || source.status == "error"
        || source.generation != Some(generation);
    if !unavailable {
        return None;
    }

    source.error.clone().or_else(|| {
        if source.generation != Some(generation) {
            Some(format!(
                "Jam source lost the active generation binding (expected {}, source {:?})",
                generation, source.generation
            ))
        } else {
            Some(format!(
                "Jam source became unavailable (status: {})",
                source.status
            ))
        }
    })
}

/// Redundant lifecycle reconciliation for a missed source event.
///
/// The source registry clears its desired generation when a connection is
/// replaced, disconnected, or disabled. Therefore the watchdog must derive the
/// exact teardown generation from the active Jam rather than relying on the
/// snapshot to retain it. Starting Jams are intentionally excluded: startup has
/// a normal pre-source binding window and its own source-loss guard.
pub(crate) async fn end_active_jam_if_source_unhealthy(state: &AppState) -> bool {
    let _lifecycle = state.jam_lifecycle.lock().await;
    let generation = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !jam.active {
            return false;
        }
        jam.generation
    };
    let source = state.jam_source.snapshot().await;
    let Some(reason) = active_jam_source_watchdog_error(&source, generation) else {
        return false;
    };

    end_jam_generation_locked(
        state,
        generation,
        JamEndCondition::Active,
        "source watchdog reconciliation",
        Some(reason),
    )
    .await
}

pub(crate) async fn end_jam_if_still_empty(
    state: &AppState,
    generation: u64,
    reason: &'static str,
) -> bool {
    let _lifecycle = state.jam_lifecycle.lock().await;
    end_jam_generation_locked(
        state,
        generation,
        JamEndCondition::NoListeners,
        reason,
        None,
    )
    .await
}

fn apply_revoked_participant_bindings(
    jam: &mut JamState,
    revoked: &[RevokedParticipantBinding],
) -> (Option<u64>, Option<u64>) {
    let host_revoked = jam.active
        && revoked.iter().any(|binding| {
            binding.identity == jam.host_identity && binding.auth_id == jam.host_participant_auth_id
        });

    for binding in revoked {
        if jam.listeners.get(&binding.identity) == Some(&binding.auth_id) {
            jam.listeners.remove(&binding.identity);
        }
        let remove_audio = jam
            .audio_connections
            .get(&binding.identity)
            .map(|connection| connection.participant_auth_id == binding.auth_id)
            .unwrap_or(false);
        if remove_audio {
            jam.audio_connections.remove(&binding.identity);
        }
    }

    if host_revoked {
        let generation = jam.generation;
        (Some(generation), None)
    } else {
        let auto_end = (jam.active && jam.listeners.is_empty()).then_some(jam.generation);
        (None, auto_end)
    }
}

pub(crate) async fn reconcile_revoked_participant_bindings(
    state: &AppState,
    revoked: &[RevokedParticipantBinding],
    reason: &'static str,
) {
    if revoked.is_empty() {
        return;
    }

    let _lifecycle = state.jam_lifecycle.lock().await;
    let (stop_generation, auto_end_generation) = {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        apply_revoked_participant_bindings(&mut jam, revoked)
    };

    if let Some(generation) = stop_generation {
        info!(
            "Jam generation {} ended because its host binding was revoked ({})",
            generation, reason
        );
        end_jam_generation_locked(
            state,
            generation,
            JamEndCondition::Active,
            reason,
            Some("Jam host authorization was revoked".to_string()),
        )
        .await;
    } else if let Some(generation) = auto_end_generation {
        schedule_jam_auto_end(state.clone(), generation, reason);
    }
}

fn apply_jam_start_result(
    jam: &mut JamState,
    identity: String,
    participant_auth_id: String,
    bot_started: bool,
) -> bool {
    jam.starting = false;
    if !bot_started {
        return false;
    }

    jam.active = true;
    jam.host_identity = identity.clone();
    jam.host_participant_auth_id = participant_auth_id.clone();
    jam.audio_connections.clear();
    jam.listeners.insert(identity, participant_auth_id);
    true
}

fn jam_start_response(generation: u64, device: &SpotifyDevice) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "generation": generation,
        "listener_joined": true,
        "source_status": "ready",
        "spotify_device_id": device.id,
        "spotify_device_name": device.name,
    })
}

fn jam_source_start_preflight(
    source: &crate::jam_source::JamSourceSnapshot,
) -> Result<(), (StatusCode, String)> {
    let message = if !source.configured {
        Some("Jam source is not configured".to_string())
    } else if !source.connected {
        Some(
            source
                .error
                .clone()
                .unwrap_or_else(|| "Configured Jam source is offline".to_string()),
        )
    } else if !source.availability_known {
        Some("Jam source availability is still negotiating".to_string())
    } else if !source.enabled {
        Some(
            source
                .error
                .clone()
                .unwrap_or_else(|| "Jam sharing is turned off on the source PC".to_string()),
        )
    } else if source.status == "error" {
        Some(
            source
                .error
                .clone()
                .unwrap_or_else(|| "Jam source is unavailable".to_string()),
        )
    } else {
        None
    };
    match message {
        Some(message) => Err((StatusCode::SERVICE_UNAVAILABLE, message)),
        None => Ok(()),
    }
}

fn jam_source_ready_for_generation(
    source: &crate::jam_source::JamSourceSnapshot,
    generation: u64,
) -> bool {
    jam_source_start_preflight(source).is_ok()
        && source.ready
        && source.generation == Some(generation)
}

async fn wait_for_source_start_loss(state: &AppState, generation: u64) -> String {
    let mut interval = tokio::time::interval(SOURCE_START_RECHECK_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let source = state.jam_source.snapshot().await;
        if !jam_source_ready_for_generation(&source, generation) {
            return source
                .error
                .unwrap_or_else(|| "Jam source changed during Spotify startup".to_string());
        }
    }
}

pub(crate) async fn jam_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamStartRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_admin(&state, &headers).map_err(|status| (status, String::new()))?;
    if payload.identity.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Identity is required".to_string()));
    }
    let actor = ensure_jam_participant(&state, &headers, Some(&payload.identity))
        .map_err(|status| (status, String::new()))?;
    let actor_auth_id = actor
        .echo_participant_auth_id
        .ok_or((StatusCode::UNAUTHORIZED, String::new()))?;
    let actor_identity = actor.sub;
    let _lifecycle = state.jam_lifecycle.lock().await;

    let source_before_start = state.jam_source.snapshot().await;
    jam_source_start_preflight(&source_before_start)?;

    let generation = {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if jam.spotify_token.is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Spotify is not connected".to_string(),
            ));
        }
        if jam.active || jam.starting {
            return Err((StatusCode::CONFLICT, "A Jam is already running".to_string()));
        }
        jam.starting = true;
        jam.generation = jam.generation.wrapping_add(1).max(1);
        jam.last_error = None;
        jam.generation
    };

    let device = match resolve_spotify_device(&state).await {
        Ok(device) => device,
        Err(error) => {
            fail_jam_start(&state, generation, &error.1);
            return Err(error);
        }
    };
    if let Some(stale) = state.jam_bot.lock().await.take() {
        stale.stop().await;
    }
    let bot = match crate::jam_bot::JamBot::start(
        generation,
        state.jam_source.clone(),
        Duration::from_secs(10),
    )
    .await
    {
        Ok(bot) => bot,
        Err(error) => {
            warn!("Jam audio bot failed to start: {}", error);
            fail_jam_start(&state, generation, &error);
            return Err((StatusCode::SERVICE_UNAVAILABLE, error));
        }
    };

    // Ready means the source PC has both acquired its silent per-app route and
    // opened process capture. Recheck immediately before Spotify transfer so a
    // local Off toggle cannot race playback onto the PC speakers.
    let source_before_transfer = state.jam_source.snapshot().await;
    if let Err(error) = jam_source_start_preflight(&source_before_transfer) {
        bot.stop().await;
        fail_jam_start(&state, generation, &error.1);
        return Err(error);
    }
    if !jam_source_ready_for_generation(&source_before_transfer, generation) {
        let error = "Jam source changed before Spotify playback could be transferred".to_string();
        bot.stop().await;
        fail_jam_start(&state, generation, &error);
        return Err((StatusCode::SERVICE_UNAVAILABLE, error));
    }

    let spotify_bind = tokio::select! {
        result = tokio::time::timeout(
            SPOTIFY_START_BIND_TIMEOUT,
            bind_spotify_playback_to_device(&state, &device),
        ) => match result {
            Ok(result) => result,
            Err(_) => Err((
                StatusCode::SERVICE_UNAVAILABLE,
                format!(
                    "Spotify startup exceeded the {}s safety deadline",
                    SPOTIFY_START_BIND_TIMEOUT.as_secs()
                ),
            )),
        },
        reason = wait_for_source_start_loss(&state, generation) => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            reason,
        )),
    };
    let spotify_is_playing = match spotify_bind {
        Ok(is_playing) => is_playing,
        Err(error) => {
            // The transfer request may have reached Spotify before a timeout
            // or source-loss cancellation. Pause the exact target before the
            // source route is released.
            pause_bound_spotify_before_release(&state, generation, Some(&device)).await;
            bot.stop().await;
            fail_jam_start(&state, generation, &error.1);
            return Err(error);
        }
    };

    let source_after_transfer = state.jam_source.snapshot().await;
    if !jam_source_ready_for_generation(&source_after_transfer, generation) || !bot.is_healthy() {
        let error = "Jam source changed while Spotify playback was transferring".to_string();
        pause_bound_spotify_before_release(&state, generation, Some(&device)).await;
        bot.stop().await;
        fail_jam_start(&state, generation, &error);
        return Err((StatusCode::SERVICE_UNAVAILABLE, error));
    }
    *state.jam_bot.lock().await = Some(bot);
    info!(
        "Jam audio bot started successfully generation={}",
        generation
    );

    let binding_still_current =
        participant_binding_is_current(&state, &actor_identity, &actor_auth_id);
    let activated = {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if jam.generation != generation || !jam.starting || !binding_still_current {
            if jam.generation == generation && jam.starting {
                jam.starting = false;
                jam.last_error = Some("Jam host authorization changed during startup".to_string());
            }
            false
        } else {
            apply_jam_start_result(
                &mut jam,
                actor_identity.clone(),
                actor_auth_id.clone(),
                true,
            );
            jam.spotify_device_id = Some(device.id.clone());
            jam.spotify_device_name = Some(device.name.clone());
            jam.spotify_is_playing = spotify_is_playing;
            jam.queue_control_epoch = jam.queue_control_epoch.wrapping_add(1);
            jam.queue_control_stopped = false;
            jam.audio_expected_since = spotify_is_playing.then(std::time::Instant::now);
            info!(
                "Jam session started by {} (auto-joined as listener)",
                jam.host_identity
            );
            true
        }
    };
    if !activated {
        pause_bound_spotify_before_release(&state, generation, Some(&device)).await;
        if let Some(bot) = state.jam_bot.lock().await.take() {
            bot.stop().await;
        }
        return Err((StatusCode::CONFLICT, "Jam start was superseded".to_string()));
    }

    Ok(Json(jam_start_response(generation, &device)))
}

fn fail_jam_start(state: &AppState, generation: u64, error: &str) {
    let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
    if jam.generation == generation && jam.starting {
        jam.starting = false;
        jam.active = false;
        jam.last_error = Some(error.to_string());
        jam.spotify_is_playing = false;
        jam.audio_expected_since = None;
    }
}

fn public_source_health(
    active: bool,
    spotify_is_playing: bool,
    audio_expected_ms: Option<u64>,
    source_ready: bool,
    source_status: String,
    source_error: Option<String>,
) -> (String, Option<String>) {
    // WASAPI process loopback legitimately emits no packets while Spotify is
    // paused. A ready source is therefore healthy until playback is expected.
    if active && source_ready {
        if !spotify_is_playing {
            return ("ready".to_string(), None);
        }
        if source_status != "live" {
            if audio_expected_ms.map(|age| age > 5_000).unwrap_or(false) {
                return (
                    "stalled".to_string(),
                    Some("Spotify is playing but Echo is receiving no audible audio".to_string()),
                );
            }
            return ("ready".to_string(), None);
        }
    }
    (source_status, source_error)
}

fn should_restart_stalled_capture(
    active: bool,
    spotify_is_playing: bool,
    audio_expected_ms: Option<u64>,
    raw_source_status: &str,
) -> bool {
    active
        && spotify_is_playing
        && audio_expected_ms.map(|age| age > 5_000).unwrap_or(false)
        // Silent PCM packets prove that WASAPI is still flowing. Only a raw
        // packet stall warrants tearing down and rebinding the capture handle.
        && raw_source_status == "stalled"
}

async fn ensure_jam_source_ready(state: &AppState) -> Result<u64, (StatusCode, String)> {
    let (generation, spotify_is_playing, audio_expected_ms) = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !jam.active {
            return Err((StatusCode::CONFLICT, "No active Jam".to_string()));
        }
        (
            jam.generation,
            jam.spotify_is_playing,
            jam.audio_expected_since
                .map(|at| at.elapsed().as_millis().min(u64::MAX as u128) as u64),
        )
    };
    let source = state.jam_source.snapshot().await;
    let bot_healthy = state
        .jam_bot
        .lock()
        .await
        .as_ref()
        .map(|bot| bot.generation() == generation && bot.is_healthy())
        .unwrap_or(false);
    let (public_status, public_error) = public_source_health(
        true,
        spotify_is_playing,
        audio_expected_ms,
        source.ready,
        source.status.clone(),
        source.error.clone(),
    );
    if !source.ready
        || source.generation != Some(generation)
        || !bot_healthy
        || !matches!(public_status.as_str(), "ready" | "live")
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            public_error.unwrap_or_else(|| {
                format!("Jam audio source is not ready (status: {})", public_status)
            }),
        ));
    }
    Ok(generation)
}

fn source_status_allows_recovery_control(status: &str) -> bool {
    matches!(status, "ready" | "live" | "silent" | "stalled")
}

async fn ensure_jam_recovery_controls_ready(state: &AppState) -> Result<u64, (StatusCode, String)> {
    let generation = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !jam.active {
            return Err((StatusCode::CONFLICT, "No active Jam".to_string()));
        }
        jam.generation
    };
    let source = state.jam_source.snapshot().await;
    let bot_healthy = state
        .jam_bot
        .lock()
        .await
        .as_ref()
        .map(|bot| bot.generation() == generation && bot.is_healthy())
        .unwrap_or(false);
    if !source.ready
        || source.generation != Some(generation)
        || !bot_healthy
        || !source_status_allows_recovery_control(&source.status)
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            source.error.unwrap_or_else(|| {
                format!(
                    "Jam audio source cannot accept recovery controls (status: {})",
                    source.status
                )
            }),
        ));
    }
    Ok(generation)
}

async fn wait_for_jam_recovery_controls_loss(
    state: &AppState,
    generation: u64,
) -> (StatusCode, String) {
    let mut interval = tokio::time::interval(SOURCE_START_RECHECK_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match ensure_jam_recovery_controls_ready(state).await {
            Ok(current_generation) if current_generation == generation => {}
            Ok(_) => {
                return (
                    StatusCode::CONFLICT,
                    "Jam generation changed during Spotify control".to_string(),
                );
            }
            Err(error) => return error,
        }
    }
}

/// Run a playback-changing Spotify operation only while the exact Jam source
/// generation remains safe. Cancellation is ambiguous because Spotify may have
/// accepted a request before the HTTP future was dropped, so every safety exit
/// pauses the exact bound device before the desktop may restore its old route.
async fn run_guarded_spotify_recovery_operation<T, F>(
    state: &AppState,
    generation: u64,
    device: &SpotifyDevice,
    operation_name: &str,
    operation: F,
) -> Result<T, (StatusCode, String)>
where
    F: Future<Output = Result<T, (StatusCode, String)>>,
{
    let guarded_result: Result<Result<T, (StatusCode, String)>, (StatusCode, String)> = tokio::select! {
        result = tokio::time::timeout(SPOTIFY_RECOVERY_OPERATION_TIMEOUT, operation) => {
            match result {
                Ok(result) => Ok(result),
                Err(_) => Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!(
                        "{} exceeded the {}s source-safety deadline",
                        operation_name,
                        SPOTIFY_RECOVERY_OPERATION_TIMEOUT.as_secs(),
                    ),
                )),
            }
        }
        error = wait_for_jam_recovery_controls_loss(state, generation) => Err(error),
    };

    match guarded_result {
        Err(safety_error) => {
            pause_bound_spotify_before_release(state, generation, Some(device)).await;
            Err(safety_error)
        }
        Ok(operation_result) => match ensure_jam_recovery_controls_ready(state).await {
            Ok(current_generation) if current_generation == generation => operation_result,
            Ok(_) => {
                pause_bound_spotify_before_release(state, generation, Some(device)).await;
                Err((
                    StatusCode::CONFLICT,
                    "Jam generation changed during Spotify control".to_string(),
                ))
            }
            Err(error) => {
                pause_bound_spotify_before_release(state, generation, Some(device)).await;
                Err(error)
            }
        },
    }
}

fn apply_spotify_pause_result(jam: &mut JamState, generation: u64, device: &SpotifyDevice) -> bool {
    if !active_generation_matches(jam, generation)
        || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
    {
        return false;
    }

    jam.spotify_is_playing = false;
    jam.queue_control_epoch = jam.queue_control_epoch.wrapping_add(1);
    jam.queue_control_stopped = true;
    jam.audio_expected_since = None;
    jam.last_error = None;
    if let Some(now_playing) = jam.now_playing.as_mut() {
        now_playing.is_playing = false;
        now_playing.fetched_at = Some(std::time::Instant::now());
    }
    true
}

fn jam_stop_authorized(jam: &JamState, identity: &str, participant_auth_id: &str) -> bool {
    !identity.trim().is_empty()
        && !jam.host_identity.is_empty()
        && identity == jam.host_identity
        && participant_auth_id == jam.host_participant_auth_id
}

fn active_generation_matches(jam: &JamState, generation: u64) -> bool {
    jam.active && jam.generation == generation
}

pub(crate) async fn jam_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamIdentityRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    if payload.identity.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let actor = ensure_jam_participant(&state, &headers, Some(&payload.identity))?;
    let actor_auth_id = actor
        .echo_participant_auth_id
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let actor_identity = actor.sub;
    let _lifecycle = state.jam_lifecycle.lock().await;

    let generation = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());

        if !active_generation_matches(&jam, payload.generation) {
            return Err(StatusCode::CONFLICT);
        }

        // Only the exact host installation that started this generation can stop it.
        if !jam_stop_authorized(&jam, &actor_identity, &actor_auth_id) {
            info!(
                "Jam stop denied: {} is not host {}",
                actor_identity, jam.host_identity
            );
            return Err(StatusCode::FORBIDDEN);
        }

        info!("Jam session stopped by {}", &actor_identity);
        payload.generation
    };

    if !end_jam_generation_locked(
        &state,
        generation,
        JamEndCondition::Active,
        "host ended Jam",
        None,
    )
    .await
    {
        return Err(StatusCode::CONFLICT);
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

fn playback_fetch_matches(jam: &JamState, generation: u64, device_id: &str) -> bool {
    jam.active
        && jam.generation == generation
        && jam.spotify_device_id.as_deref() == Some(device_id)
}

fn reconcile_queue_to_current(queue: &mut Vec<QueuedTrack>, current_uri: &str) -> Vec<QueuedTrack> {
    if current_uri.is_empty() || !queue.iter().any(|track| track.spotify_uri == current_uri) {
        return Vec::new();
    }
    let mut removed = Vec::new();
    while queue
        .first()
        .map(|track| track.spotify_uri.as_str() != current_uri)
        .unwrap_or(false)
    {
        removed.push(queue.remove(0));
    }
    removed
}

pub(crate) async fn jam_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    // Only one Spotify observation may be in flight. Without this fence, an
    // older network response can arrive last and overwrite fresher playback
    // state from a concurrent /api/jam/state request.
    let refresh_guard = state.jam_state_refresh.lock().await;

    // Check if we need to refresh now_playing from Spotify
    let playback_fetch = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !jam.active || jam.spotify_token.is_none() {
            None
        } else {
            let due = match &jam.now_playing {
                None => true,
                Some(np) => match np.fetched_at {
                    None => true,
                    Some(t) => t.elapsed() > Duration::from_secs(5),
                },
            };
            if due {
                jam.spotify_device_id
                    .clone()
                    .map(|device_id| (jam.generation, device_id))
            } else {
                None
            }
        }
    };
    let mut history_observation = None;

    if let Some((fetch_generation, fetch_device_id)) = playback_fetch {
        let resp_result = spotify_api_request(
            &state,
            reqwest::Method::GET,
            "https://api.spotify.com/v1/me/player",
            None,
        )
        .await;

        if let Ok(resp) = resp_result {
            if resp.status() == reqwest::StatusCode::NO_CONTENT {
                let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
                if playback_fetch_matches(&jam, fetch_generation, &fetch_device_id) {
                    jam.spotify_is_playing = false;
                    jam.audio_expected_since = None;
                    jam.now_playing = None;
                }
            } else if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    let item = &data["item"];
                    let current_uri = item["uri"].as_str().unwrap_or("").to_string();
                    let (current_spotify_id, canonical_uri, canonical_url) =
                        spotify_track_identity(item);
                    let np = NowPlayingInfo {
                        spotify_id: current_spotify_id.clone(),
                        spotify_uri: canonical_uri,
                        spotify_url: canonical_url,
                        name: item["name"].as_str().unwrap_or("").to_string(),
                        artist: item["artists"]
                            .as_array()
                            .and_then(|a| a.first())
                            .and_then(|a| a["name"].as_str())
                            .unwrap_or("")
                            .to_string(),
                        album_art_url: item["album"]["images"]
                            .as_array()
                            .and_then(|imgs| imgs.first())
                            .and_then(|img| img["url"].as_str())
                            .unwrap_or("")
                            .to_string(),
                        duration_ms: item["duration_ms"].as_u64().unwrap_or(0),
                        progress_ms: data["progress_ms"].as_u64().unwrap_or(0),
                        is_playing: data["is_playing"].as_bool().unwrap_or(false),
                        fetched_at: Some(std::time::Instant::now()),
                    };
                    let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
                    let actual_device_id = data["device"]["id"].as_str();
                    if !playback_fetch_matches(&jam, fetch_generation, &fetch_device_id) {
                        // A stop or newer Jam superseded this in-flight response.
                    } else if actual_device_id != Some(fetch_device_id.as_str()) {
                        jam.spotify_is_playing = false;
                        jam.audio_expected_since = None;
                        jam.now_playing = None;
                        jam.last_error = Some(format!(
                            "Spotify playback moved away from configured device '{}'",
                            jam.spotify_device_name.as_deref().unwrap_or("unknown")
                        ));
                    } else {
                        jam.spotify_is_playing = np.is_playing;
                        if np.is_playing {
                            jam.audio_expected_since
                                .get_or_insert_with(std::time::Instant::now);
                            jam.last_error = None;
                        } else {
                            jam.audio_expected_since = None;
                        }
                        // Only observed playback on the bound device can advance Echo's
                        // display queue. External items never drain queued Echo tracks.
                        for removed in reconcile_queue_to_current(&mut jam.queue, &current_uri) {
                            info!(
                                "Jam: auto-removed finished track '{}' from queue",
                                removed.name
                            );
                        }
                        let observed_spotify_id =
                            (!np.spotify_id.is_empty()).then_some(np.spotify_id.as_str());
                        let queued_track = jam
                            .queue
                            .first()
                            .filter(|track| track.spotify_uri == current_uri)
                            .cloned();
                        history_observation = new_history_observation(
                            jam.last_history_spotify_id.as_deref(),
                            observed_spotify_id,
                            queued_track.as_ref(),
                            np.is_playing,
                        )
                        .map(|observation| (fetch_generation, observation));
                        jam.now_playing = Some(np);
                    }
                }
            }
        }
    }
    if let Some((observation_generation, observation)) = history_observation {
        if let Some(track) = observation.queued_track {
            let history = std::sync::Arc::clone(&state.jam_history);
            let jam_state = std::sync::Arc::clone(&state.jam);
            let observed_spotify_id = observation.spotify_id;
            let played_at_ms = now_ts_ms();
            match tokio::task::spawn_blocking(move || {
                let entry = history.append_observation(&track, played_at_ms)?;
                let mut jam = jam_state.lock().unwrap_or_else(|error| error.into_inner());
                if active_generation_matches(&jam, observation_generation) {
                    jam.last_history_spotify_id = Some(observed_spotify_id);
                }
                Ok::<_, std::io::Error>(entry)
            })
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    warn!("Jam history observation could not be persisted: {}", error);
                }
                Err(error) => {
                    warn!("Jam history persistence task failed: {}", error);
                }
            }
        } else {
            // External Spotify playback is a run boundary, but is not itself
            // part of Echo's history.
            let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
            if active_generation_matches(&jam, observation_generation) {
                jam.last_history_spotify_id = Some(observation.spotify_id);
            }
        }
    }
    drop(refresh_guard);

    // Build response (extract all data from std::sync::Mutex before awaiting)
    let (
        active,
        starting,
        generation,
        host_identity,
        queue,
        now_playing,
        listeners,
        spotify_connected,
        spotify_device_id,
        spotify_device_name,
        last_error,
        spotify_is_playing,
        audio_expected_ms,
    ) = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        (
            jam.active,
            jam.starting,
            jam.generation,
            jam.host_identity.clone(),
            jam.queue.clone(),
            jam.now_playing.clone(),
            jam.listeners.keys().cloned().collect::<Vec<String>>(),
            jam.spotify_token.is_some(),
            jam.spotify_device_id.clone(),
            jam.spotify_device_name.clone(),
            jam.last_error.clone(),
            jam.spotify_is_playing,
            jam.audio_expected_since
                .map(|at| at.elapsed().as_millis().min(u64::MAX as u128) as u64),
        )
    };
    let listener_count = listeners.len();
    let bot_healthy = state
        .jam_bot
        .lock()
        .await
        .as_ref()
        .map(|bot| bot.is_healthy() && bot.generation() == generation)
        .unwrap_or(false);
    let source = state.jam_source.snapshot().await;
    let bot_connected = bot_healthy && source.ready && source.generation == Some(generation);
    let (source_status, source_error) = public_source_health(
        active,
        spotify_is_playing,
        audio_expected_ms,
        source.ready,
        source.status.clone(),
        source.error.clone(),
    );
    if should_restart_stalled_capture(
        active,
        spotify_is_playing,
        audio_expected_ms,
        &source.status,
    ) && state.jam_source.restart_stalled_capture(generation).await
    {
        warn!(
            "Jam source capture stalled while Spotify was playing; requested generation {} rebind",
            generation
        );
    }

    Ok(Json(serde_json::json!({
        "active": active,
        "starting": starting,
        "generation": generation,
        "host_identity": host_identity,
        "queue": queue,
        "now_playing": now_playing,
        "listeners": listeners,
        "listener_count": listener_count,
        "spotify_connected": spotify_connected,
        "spotify_device_id": spotify_device_id,
        "spotify_device_name": spotify_device_name,
        "spotify_is_playing": spotify_is_playing,
        "playback_stop_supported": true,
        "bot_connected": bot_connected,
        "last_error": last_error,
        "jam_protocol_version": crate::jam_source::JAM_SOURCE_PROTOCOL_VERSION,
        "source_status": source_status,
        "source_error": source_error,
        "source_availability_known": source.availability_known,
        "source_enabled": source.enabled,
        "source_last_frame_ms": source.last_frame_ms,
        "source_peak": source.peak,
        "source_ready": source.ready,
    })))
}

pub(crate) async fn jam_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamSearchRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let url = format!(
        "https://api.spotify.com/v1/search?q={}&type=track&limit=10",
        urlencoded(&payload.query)
    );

    let resp = spotify_api_request(&state, reqwest::Method::GET, &url, None)
        .await
        .map_err(|(_status, msg)| {
            warn!("Spotify search failed: {}", msg);
            StatusCode::BAD_GATEWAY
        })?;

    if !resp.status().is_success() {
        let (_, message) = spotify_response_error(resp, "Search Spotify").await;
        warn!("Spotify search failed: {}", message);
        return Err(StatusCode::BAD_GATEWAY);
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| {
        warn!("Spotify search parse failed: {}", e);
        StatusCode::BAD_GATEWAY
    })?;

    let tracks = data["tracks"]["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    serde_json::json!({
                        "spotify_uri": item["uri"].as_str().unwrap_or(""),
                        "name": item["name"].as_str().unwrap_or(""),
                        "artist": item["artists"].as_array()
                            .and_then(|a| a.first())
                            .and_then(|a| a["name"].as_str())
                            .unwrap_or(""),
                        "album_art_url": item["album"]["images"].as_array()
                            .and_then(|imgs| imgs.first())
                            .and_then(|img| img["url"].as_str())
                            .unwrap_or(""),
                        "duration_ms": item["duration_ms"].as_u64().unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(Json(serde_json::json!(tracks)))
}

fn spotify_track_id_from_uri(uri: &str) -> Option<&str> {
    let id = uri.strip_prefix("spotify:track:")?;
    valid_spotify_id(id).then_some(id)
}

fn spotify_track_identity(item: &serde_json::Value) -> (String, String, String) {
    if item.get("type").and_then(serde_json::Value::as_str) != Some("track") {
        return (String::new(), String::new(), String::new());
    }
    let Some(id) = item
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| valid_spotify_id(id))
    else {
        return (String::new(), String::new(), String::new());
    };
    let uri = format!("spotify:track:{id}");
    if item.get("uri").and_then(serde_json::Value::as_str) != Some(uri.as_str()) {
        return (String::new(), String::new(), String::new());
    }
    (
        id.to_string(),
        uri,
        format!("https://open.spotify.com/track/{id}"),
    )
}

fn cached_queue_mode(
    expected_control_epoch: u64,
    current_control_epoch: u64,
    should_queue: Option<bool>,
) -> Option<bool> {
    (current_control_epoch == expected_control_epoch)
        .then_some(should_queue)
        .flatten()
}

fn enqueue_interrupted_by_stop(
    expected_control_epoch: u64,
    current_control_epoch: u64,
    control_stopped: bool,
) -> bool {
    current_control_epoch != expected_control_epoch && control_stopped
}

fn playlist_queue_request_id_valid(request_id: &str) -> bool {
    (8..=128).contains(&request_id.len())
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn playlist_batch_flags(has_failure: bool, skipped_count: usize) -> (bool, bool) {
    let partial = has_failure || skipped_count > 0;
    (partial, !partial)
}

fn playlist_provenance(summary: &FavoriteSummary) -> QueuedPlaylistProvenance {
    QueuedPlaylistProvenance {
        spotify_id: summary.spotify_id.clone(),
        spotify_uri: summary.spotify_uri.clone(),
        spotify_url: summary.spotify_url.clone(),
        name: summary.name.clone(),
    }
}

fn queued_track_from_summary(
    summary: &FavoriteSummary,
    actor: &JamActor,
    batch_id: Option<&str>,
    playlist: Option<&QueuedPlaylistProvenance>,
    added_at_ms: u64,
) -> QueuedTrack {
    QueuedTrack {
        queue_entry_id: format!("qe1_{}", random_secret()),
        queue_batch_id: batch_id.map(str::to_string),
        spotify_id: summary.spotify_id.clone(),
        spotify_uri: summary.spotify_uri.clone(),
        spotify_url: summary.spotify_url.clone(),
        name: summary.name.clone(),
        artist: summary.artist.clone().unwrap_or_default(),
        album_art_url: summary.artwork_url.clone().unwrap_or_default(),
        duration_ms: summary.duration_ms.unwrap_or_default(),
        added_at_ms,
        added_by_actor_id: actor.actor_id.clone(),
        added_by_name: actor.display_name.clone(),
        playlist: playlist.cloned(),
        added_by: actor.display_name.clone(),
    }
}

async fn spotify_playback_should_queue(
    state: &AppState,
    device: &SpotifyDevice,
) -> Result<bool, (StatusCode, String)> {
    let response = spotify_api_request(
        state,
        reqwest::Method::GET,
        "https://api.spotify.com/v1/me/player",
        None,
    )
    .await?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(spotify_response_error(response, "Read Spotify playback").await);
    }
    let playback: serde_json::Value = response.json().await.map_err(|error| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Spotify playback response was invalid: {error}"),
        )
    })?;
    Ok(playback["is_playing"].as_bool().unwrap_or(false)
        && playback["device"]["id"].as_str() == Some(device.id.as_str()))
}

async fn place_spotify_track(
    state: &AppState,
    device: &SpotifyDevice,
    spotify_uri: &str,
    should_queue: bool,
) -> Result<(), (StatusCode, String)> {
    if should_queue {
        let queue_url = format!(
            "https://api.spotify.com/v1/me/player/queue?uri={}&device_id={}",
            urlencoded(spotify_uri),
            urlencoded(&device.id),
        );
        let response = spotify_api_request(state, reqwest::Method::POST, &queue_url, None).await?;
        if !response.status().is_success() {
            return Err(spotify_response_error(response, "Queue Spotify track").await);
        }
        info!("Track queued on configured Spotify device: {spotify_uri}");
    } else {
        let play_url = format!(
            "https://api.spotify.com/v1/me/player/play?device_id={}",
            urlencoded(&device.id)
        );
        let play_body = serde_json::json!({ "uris": [spotify_uri] });
        let response =
            spotify_api_request(state, reqwest::Method::PUT, &play_url, Some(play_body)).await?;
        if !response.status().is_success() {
            return Err(spotify_response_error(response, "Start Spotify track").await);
        }
        info!("Track started on configured Spotify device: {spotify_uri}");
    }
    Ok(())
}

async fn enqueue_playlist_track_guarded(
    state: &AppState,
    generation: u64,
    track: &QueuedTrack,
    should_queue: Option<bool>,
    expected_control_epoch: u64,
) -> Result<u64, (StatusCode, String)> {
    // Keep the global lifecycle fence to one Spotify mutation. Stop, skip, and
    // teardown may run between batch entries and the next entry revalidates.
    let _refresh = state.jam_state_refresh.lock().await;
    let _lifecycle = state.jam_lifecycle.lock().await;
    let current_generation = ensure_jam_recovery_controls_ready(state).await?;
    if current_generation != generation {
        return Err((StatusCode::CONFLICT, "Jam generation changed".to_string()));
    }
    let (device, control_epoch, control_stopped) = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        (
            bound_spotify_device(&jam, generation).ok_or((
                StatusCode::SERVICE_UNAVAILABLE,
                "The active Jam has no bound Spotify device".to_string(),
            ))?,
            jam.queue_control_epoch,
            jam.queue_control_stopped,
        )
    };
    if enqueue_interrupted_by_stop(expected_control_epoch, control_epoch, control_stopped) {
        return Err((
            StatusCode::CONFLICT,
            "Playlist enqueue was interrupted by Stop Music".to_string(),
        ));
    }
    let should_queue = cached_queue_mode(expected_control_epoch, control_epoch, should_queue);
    run_guarded_spotify_recovery_operation(
        state,
        generation,
        &device,
        "Queueing a Spotify playlist track",
        async {
            let should_queue = match should_queue {
                Some(should_queue) => should_queue,
                None => spotify_playback_should_queue(state, &device).await?,
            };
            place_spotify_track(state, &device, &track.spotify_uri, should_queue).await
        },
    )
    .await?;

    let applied = {
        let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if !active_generation_matches(&jam, generation)
            || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
        {
            false
        } else {
            jam.spotify_device_name = Some(device.name.clone());
            jam.spotify_is_playing = true;
            jam.audio_expected_since = Some(std::time::Instant::now());
            jam.last_error = None;
            jam.queue_control_stopped = false;
            jam.queue.push(track.clone());
            jam.now_playing = None;
            true
        }
    };
    if !applied {
        pause_bound_spotify_before_release(state, generation, Some(&device)).await;
        return Err((
            StatusCode::CONFLICT,
            "Jam changed after Spotify accepted a playlist track".to_string(),
        ));
    }
    Ok(control_epoch)
}

pub(crate) async fn jam_queue_add(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamQueueRequest>,
) -> Result<Json<serde_json::Value>, Response> {
    ensure_admin(&state, &headers).map_err(|status| {
        playlist_queue_error_response(status, "unauthorized", "Authentication required")
    })?;
    let actor = ensure_jam_actor(&state, &headers).map_err(|status| {
        playlist_queue_error_response(
            status,
            "actor_required",
            "A current Echo participant token is required",
        )
    })?;
    let spotify_id = spotify_track_id_from_uri(&payload.spotify_uri)
        .ok_or_else(|| {
            playlist_queue_error_response(
                StatusCode::BAD_REQUEST,
                "invalid_track_uri",
                "Invalid Spotify track URI",
            )
        })?
        .to_string();
    let request_control_epoch = state
        .jam
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .queue_control_epoch;
    let summary = fetch_favorite_summary(&state, FavoriteKind::Track, &spotify_id)
        .await
        .map_err(JamApiError::into_response)?;
    let _queue_lifecycle = state.jam_queue_lifecycle.lock().await;
    let _refresh = state.jam_state_refresh.lock().await;
    let _lifecycle = state.jam_lifecycle.lock().await;
    let generation =
        ensure_jam_recovery_controls_ready(&state)
            .await
            .map_err(|(status, message)| {
                spotify_queue_error_response(&state, status, "jam_unavailable", message)
            })?;
    if generation != payload.generation {
        return Err(playlist_queue_error_response(
            StatusCode::CONFLICT,
            "generation_changed",
            "Jam generation changed",
        ));
    }
    {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if enqueue_interrupted_by_stop(
            request_control_epoch,
            jam.queue_control_epoch,
            jam.queue_control_stopped,
        ) {
            return Err(playlist_queue_error_response(
                StatusCode::CONFLICT,
                "queue_interrupted",
                "Track enqueue was interrupted by Stop Music",
            ));
        }
    }
    let device = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        bound_spotify_device(&jam, generation).ok_or_else(|| {
            playlist_queue_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "spotify_device_unavailable",
                "The active Jam has no bound Spotify device",
            )
        })?
    };

    run_guarded_spotify_recovery_operation(
        &state,
        generation,
        &device,
        "Queueing a Spotify track",
        async {
            let should_queue = spotify_playback_should_queue(&state, &device).await?;
            place_spotify_track(&state, &device, &payload.spotify_uri, should_queue).await
        },
    )
    .await
    .map_err(|(status, message)| {
        spotify_queue_error_response(&state, status, "spotify_queue_failed", message)
    })?;

    let track = queued_track_from_summary(&summary, &actor, None, None, now_ts_ms());
    let applied = {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !active_generation_matches(&jam, generation)
            || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
        {
            false
        } else {
            jam.spotify_device_name = Some(device.name.clone());
            jam.spotify_is_playing = true;
            jam.audio_expected_since = Some(std::time::Instant::now());
            jam.last_error = None;
            jam.queue_control_stopped = false;
            jam.queue.push(track.clone());
            jam.now_playing = None;
            true
        }
    };
    if !applied {
        pause_bound_spotify_before_release(&state, generation, Some(&device)).await;
        return Err(playlist_queue_error_response(
            StatusCode::CONFLICT,
            "generation_changed",
            "Jam changed while queueing the Spotify track",
        ));
    }
    Ok(Json(serde_json::json!({ "ok": true, "track": track })))
}

fn playlist_queue_error_response(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": code,
            "message": message.into(),
        })),
    )
        .into_response()
}

fn spotify_queue_error_response(
    state: &AppState,
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> Response {
    let mut response = playlist_queue_error_response(status, code, message);
    if status == StatusCode::TOO_MANY_REQUESTS {
        if let Some(retry_after) = spotify_retry_after_seconds(state) {
            if let Ok(value) = HeaderValue::from_str(&retry_after) {
                response.headers_mut().insert(RETRY_AFTER, value);
            }
        }
    }
    response
}

fn playlist_queue_failure(
    state: &AppState,
    status: StatusCode,
    message: String,
) -> PlaylistQueueFailure {
    let error = match status {
        StatusCode::TOO_MANY_REQUESTS => "spotify_rate_limited",
        StatusCode::UNAUTHORIZED => "spotify_unauthorized",
        StatusCode::FORBIDDEN => "spotify_forbidden",
        StatusCode::CONFLICT => "jam_conflict",
        StatusCode::SERVICE_UNAVAILABLE => "jam_unavailable",
        _ => "spotify_queue_failed",
    };
    PlaylistQueueFailure {
        status: status.as_u16(),
        error: error.to_string(),
        message,
        retry_after: (status == StatusCode::TOO_MANY_REQUESTS)
            .then(|| spotify_retry_after_seconds(state))
            .flatten(),
    }
}

pub(crate) async fn jam_queue_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PlaylistQueueRequest>,
) -> Result<Json<PlaylistQueueResponse>, Response> {
    ensure_admin(&state, &headers).map_err(|status| {
        playlist_queue_error_response(status, "unauthorized", "Authentication required")
    })?;
    let actor = ensure_jam_actor(&state, &headers).map_err(|status| {
        playlist_queue_error_response(
            status,
            "actor_required",
            "A current Echo participant token is required",
        )
    })?;
    if !valid_spotify_id(&payload.playlist_id) {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "invalid_playlist_id",
            "Invalid Spotify playlist ID",
        ));
    }
    if !playlist_queue_request_id_valid(&payload.request_id) {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request_id",
            "request_id must be 8-128 ASCII letters, digits, dashes, or underscores",
        ));
    }

    // Serialize enqueue requests without blocking stop/skip/teardown while
    // Spotify playlist metadata is fetched or a large batch is in progress.
    let _queue_lifecycle = state.jam_queue_lifecycle.lock().await;
    let generation =
        ensure_jam_recovery_controls_ready(&state)
            .await
            .map_err(|(status, message)| {
                playlist_queue_error_response(status, "jam_unavailable", message)
            })?;
    if generation != payload.generation {
        return Err(playlist_queue_error_response(
            StatusCode::CONFLICT,
            "generation_changed",
            "Jam generation changed",
        ));
    }

    let cached_receipt = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        playlist_queue_receipt_response(
            &jam,
            &payload.request_id,
            &actor.actor_id,
            &payload.playlist_id,
            generation,
        )
    };
    match cached_receipt {
        Ok(Some(response)) => return Ok(Json(response)),
        Ok(None) => {}
        Err(()) => {
            return Err(playlist_queue_error_response(
                StatusCode::CONFLICT,
                "request_id_conflict",
                "request_id was already used for a different playlist enqueue",
            ));
        }
    }
    let request_control_epoch = state
        .jam
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .queue_control_epoch;

    let expansion = fetch_playlist_expansion(&state, &payload.playlist_id)
        .await
        .map_err(JamApiError::into_response)?;
    if expansion.tracks.is_empty() {
        return Err(playlist_queue_error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "playlist_has_no_playable_tracks",
            "Playlist has no playable Spotify tracks",
        ));
    }
    if expansion.tracks.len() > 25 && !payload.confirmed {
        return Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "confirmation_required",
                "confirmation_required": true,
                "message": "Confirm before queueing more than 25 tracks",
                "playlist_id": payload.playlist_id,
                "playable_count": expansion.tracks.len(),
                "track_count": expansion.tracks.len(),
                "skipped_count": expansion.skipped.len(),
                "confirmation_threshold": 25,
            })),
        )
            .into_response());
    }

    let batch_id = format!("qb1_{}", random_secret());
    let batch_added_at_ms = now_ts_ms();
    let provenance = playlist_provenance(&expansion.playlist);
    let mut queued = Vec::with_capacity(expansion.tracks.len());
    let mut failure = None;
    let mut should_queue = None;
    let mut control_epoch = request_control_epoch;
    for (_, summary) in &expansion.tracks {
        let track = queued_track_from_summary(
            summary,
            &actor,
            Some(&batch_id),
            Some(&provenance),
            batch_added_at_ms,
        );
        let result =
            enqueue_playlist_track_guarded(&state, generation, &track, should_queue, control_epoch)
                .await;
        let observed_control_epoch = match result {
            Ok(control_epoch) => control_epoch,
            Err((status, message)) => {
                if queued.is_empty() {
                    return Err(spotify_queue_error_response(
                        &state,
                        status,
                        if status == StatusCode::TOO_MANY_REQUESTS {
                            "spotify_rate_limited"
                        } else {
                            "spotify_queue_failed"
                        },
                        message,
                    ));
                }
                failure = Some(playlist_queue_failure(&state, status, message));
                break;
            }
        };
        queued.push(track);
        should_queue = Some(true);
        control_epoch = observed_control_epoch;
    }

    let _receipt_lifecycle = state.jam_lifecycle.lock().await;
    let can_store_receipt = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        active_generation_matches(&jam, generation)
    };
    if !can_store_receipt && failure.is_none() {
        failure = Some(playlist_queue_failure(
            &state,
            StatusCode::CONFLICT,
            "Jam ended before the playlist enqueue receipt was committed".to_string(),
        ));
    }
    let skipped = expansion.skipped;
    let (partial, complete) = playlist_batch_flags(failure.is_some(), skipped.len());
    let response = PlaylistQueueResponse {
        schema_version: 1,
        ok: true,
        partial,
        request_id: payload.request_id.clone(),
        queue_batch_id: batch_id.clone(),
        batch_id,
        generation,
        playlist: provenance,
        queued_count: queued.len(),
        skipped_count: skipped.len(),
        queued,
        skipped,
        complete,
        failure,
    };
    if can_store_receipt {
        let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        insert_playlist_queue_receipt(
            &mut jam,
            payload.request_id,
            PlaylistQueueReceipt {
                actor_id: actor.actor_id,
                playlist_id: payload.playlist_id,
                generation,
                created_at_ms: now_ts_ms(),
                response: response.clone(),
            },
        );
    }
    Ok(Json(response))
}

pub(crate) async fn jam_stop_playback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamGenerationRequest>,
) -> Result<Json<serde_json::Value>, Response> {
    ensure_admin(&state, &headers).map_err(|status| {
        playlist_queue_error_response(status, "unauthorized", "Authentication required")
    })?;
    ensure_jam_participant(&state, &headers, None).map_err(|status| {
        playlist_queue_error_response(
            status,
            "participant_required",
            "A current Echo participant token is required",
        )
    })?;

    // Fence the Spotify observation used by /api/jam/state. Otherwise an
    // older in-flight GET can arrive after this pause and incorrectly mark
    // playback as running again for the same generation and device.
    let _refresh = state.jam_state_refresh.lock().await;

    // Serialize against start/end/queue/skip/leave. Capture health is
    // deliberately not consulted: Spotify playback can and should be stopped
    // even when the Jam source is stalled or offline.
    let _lifecycle = state.jam_lifecycle.lock().await;
    let device = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !active_generation_matches(&jam, payload.generation) {
            return Err(playlist_queue_error_response(
                StatusCode::CONFLICT,
                "generation_changed",
                "Jam generation changed",
            ));
        }
        bound_spotify_device(&jam, payload.generation).ok_or_else(|| {
            playlist_queue_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "spotify_device_unavailable",
                "The active Jam has no bound Spotify device",
            )
        })?
    };
    pause_spotify_playback_on_device(&state, &device)
        .await
        .map_err(|(status, message)| {
            spotify_queue_error_response(&state, status, "spotify_pause_failed", message)
        })?;

    let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
    if !apply_spotify_pause_result(&mut jam, payload.generation, &device) {
        return Err(playlist_queue_error_response(
            StatusCode::CONFLICT,
            "generation_changed",
            "Jam changed while Spotify playback was stopping",
        ));
    }
    info!(
        "Jam music stopped on configured Spotify device '{}' for generation {}",
        device.name, payload.generation
    );
    Ok(Json(serde_json::json!({
        "ok": true,
        "generation": payload.generation,
        "spotify_device_name": device.name,
    })))
}

pub(crate) async fn jam_skip(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamGenerationRequest>,
) -> Result<Json<serde_json::Value>, Response> {
    ensure_admin(&state, &headers).map_err(|status| {
        playlist_queue_error_response(status, "unauthorized", "Authentication required")
    })?;
    ensure_jam_participant(&state, &headers, None).map_err(|status| {
        playlist_queue_error_response(
            status,
            "participant_required",
            "A current Echo participant token is required",
        )
    })?;
    let _lifecycle = state.jam_lifecycle.lock().await;
    let generation =
        ensure_jam_recovery_controls_ready(&state)
            .await
            .map_err(|(status, message)| {
                spotify_queue_error_response(&state, status, "jam_unavailable", message)
            })?;
    if generation != payload.generation {
        return Err(playlist_queue_error_response(
            StatusCode::CONFLICT,
            "generation_changed",
            "Jam generation changed",
        ));
    }
    let device = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        bound_spotify_device(&jam, generation).ok_or_else(|| {
            playlist_queue_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "spotify_device_unavailable",
                "The active Jam has no bound Spotify device",
            )
        })?
    };
    let spotify_is_playing = run_guarded_spotify_recovery_operation(
        &state,
        generation,
        &device,
        "Skipping a Spotify track",
        async {
            let spotify_is_playing = bind_spotify_playback_to_device(&state, &device).await?;
            let next_url = format!(
                "https://api.spotify.com/v1/me/player/next?device_id={}",
                urlencoded(&device.id)
            );
            let response =
                spotify_api_request(&state, reqwest::Method::POST, &next_url, None).await?;
            if !response.status().is_success() {
                return Err(spotify_response_error(response, "Skip Spotify track").await);
            }
            Ok(spotify_is_playing)
        },
    )
    .await
    .map_err(|(status, message)| {
        spotify_queue_error_response(&state, status, "spotify_skip_failed", message)
    })?;

    let applied = {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !active_generation_matches(&jam, generation)
            || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
        {
            false
        } else {
            jam.spotify_device_name = Some(device.name.clone());
            jam.spotify_is_playing = spotify_is_playing;
            jam.audio_expected_since = spotify_is_playing.then(std::time::Instant::now);
            jam.last_error = None;
            jam.queue_control_epoch = jam.queue_control_epoch.wrapping_add(1);
            jam.queue_control_stopped = false;
            jam.now_playing = None;
            true
        }
    };
    if !applied {
        pause_bound_spotify_before_release(&state, generation, Some(&device)).await;
        return Err(playlist_queue_error_response(
            StatusCode::CONFLICT,
            "generation_changed",
            "Jam changed while skipping the Spotify track",
        ));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn jam_join(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamIdentityRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    if payload.identity.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let actor = ensure_jam_participant(&state, &headers, Some(&payload.identity))?;
    let actor_auth_id = actor
        .echo_participant_auth_id
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let actor_identity = actor.sub;
    let _lifecycle = state.jam_lifecycle.lock().await;
    {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !active_generation_matches(&jam, payload.generation) {
            return Err(StatusCode::CONFLICT);
        }
    }
    let generation = ensure_jam_source_ready(&state)
        .await
        .map_err(|(status, _)| status)?;
    if generation != payload.generation {
        return Err(StatusCode::CONFLICT);
    }
    let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
    if !active_generation_matches(&jam, generation) {
        return Err(StatusCode::CONFLICT);
    }
    jam.listeners.insert(actor_identity.clone(), actor_auth_id);
    info!("Jam: {} joined", actor_identity);
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn jam_leave(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamIdentityRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    if payload.identity.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let actor = ensure_jam_participant(&state, &headers, Some(&payload.identity))?;
    let actor_auth_id = actor
        .echo_participant_auth_id
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let actor_identity = actor.sub;
    let _lifecycle = state.jam_lifecycle.lock().await;

    let auto_end_generation = {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !active_generation_matches(&jam, payload.generation) {
            return Err(StatusCode::CONFLICT);
        }
        if jam.listeners.get(&actor_identity) == Some(&actor_auth_id) {
            jam.listeners.remove(&actor_identity);
        }
        let remove_audio = jam
            .audio_connections
            .get(&actor_identity)
            .map(|connection| connection.participant_auth_id == actor_auth_id)
            .unwrap_or(false);
        if remove_audio {
            jam.audio_connections.remove(&actor_identity);
        }
        info!(
            "Jam: {} left ({} listeners remain)",
            actor_identity,
            jam.listeners.len()
        );
        (jam.active && jam.listeners.is_empty()).then_some(jam.generation)
    };

    if let Some(generation) = auto_end_generation {
        schedule_jam_auto_end(state.clone(), generation, "listener left");
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── WebSocket audio streaming ────────────────────────────────────────────

/// WebSocket endpoint for streaming jam audio to viewers.
/// The URL contains only the protocol version and Jam generation. The first
/// WebSocket message must authenticate with the participant's bound LiveKit
/// JWT, keeping bearer credentials out of request-target logs.
pub(crate) async fn jam_audio_ws(
    ws: WebSocketUpgrade,
    Query(params): Query<std::collections::HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, StatusCode> {
    if !listener_protocol_is_current(&params) {
        return Err(StatusCode::UPGRADE_REQUIRED);
    }
    let generation = params
        .get("generation")
        .and_then(|generation| generation.parse::<u64>().ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    Ok(ws.on_upgrade(move |socket| jam_audio_ws_handler(socket, state, generation)))
}

fn listener_protocol_is_current(params: &std::collections::HashMap<String, String>) -> bool {
    params.len() == 2
        && params
            .get("jam_protocol_version")
            .and_then(|value| value.parse::<u8>().ok())
            == Some(crate::jam_source::JAM_SOURCE_PROTOCOL_VERSION)
        && params.contains_key("generation")
}

fn listener_attachment_allowed(
    jam: &JamState,
    identity: &str,
    participant_auth_id: &str,
    generation: u64,
) -> bool {
    jam.active
        && jam.generation == generation
        && jam.listeners.get(identity).map(String::as_str) == Some(participant_auth_id)
}

fn participant_binding_is_current(
    state: &AppState,
    identity: &str,
    participant_auth_id: &str,
) -> bool {
    state
        .participant_bindings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(identity)
        .map(|binding| binding.auth_id.as_str() == participant_auth_id)
        .unwrap_or(false)
}

fn parse_jam_audio_auth_message(text: &str) -> Option<String> {
    if text.len() > 16 * 1024 {
        return None;
    }
    let message: JamAudioAuthMessage = serde_json::from_str(text).ok()?;
    (message.message_type == "auth" && !message.token.is_empty()).then_some(message.token)
}

fn register_audio_connection(
    state: &AppState,
    identity: &str,
    participant_auth_id: &str,
    generation: u64,
) -> Option<u64> {
    // Lock order is bindings -> Jam. Stale cleanup takes participants ->
    // bindings -> Jam, so membership cannot disappear between this final
    // binding check and the connection registration.
    let bindings = state
        .participant_bindings
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if bindings
        .get(identity)
        .map(|binding| binding.auth_id.as_str())
        != Some(participant_auth_id)
    {
        return None;
    }
    let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
    if !listener_attachment_allowed(&jam, identity, participant_auth_id, generation) {
        return None;
    }
    jam.next_audio_connection_id = jam.next_audio_connection_id.wrapping_add(1).max(1);
    let connection_id = jam.next_audio_connection_id;
    jam.audio_connections.insert(
        identity.to_string(),
        JamAudioConnection {
            participant_auth_id: participant_auth_id.to_string(),
            generation,
            connection_id,
        },
    );
    Some(connection_id)
}

fn audio_connection_is_current(
    state: &AppState,
    identity: &str,
    participant_auth_id: &str,
    generation: u64,
    connection_id: u64,
) -> bool {
    let bindings = state
        .participant_bindings
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if bindings
        .get(identity)
        .map(|binding| binding.auth_id.as_str())
        != Some(participant_auth_id)
    {
        return false;
    }
    let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
    listener_attachment_allowed(&jam, identity, participant_auth_id, generation)
        && jam
            .audio_connections
            .get(identity)
            .map(|connection| {
                connection.participant_auth_id == participant_auth_id
                    && connection.generation == generation
                    && connection.connection_id == connection_id
            })
            .unwrap_or(false)
}

fn unregister_audio_connection(
    state: &AppState,
    identity: &str,
    participant_auth_id: &str,
    generation: u64,
    connection_id: u64,
) {
    let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
    unregister_audio_connection_from_jam(
        &mut jam,
        identity,
        participant_auth_id,
        generation,
        connection_id,
    );
}

fn unregister_audio_connection_from_jam(
    jam: &mut JamState,
    identity: &str,
    participant_auth_id: &str,
    generation: u64,
    connection_id: u64,
) -> bool {
    let matches = jam
        .audio_connections
        .get(identity)
        .map(|connection| {
            connection.participant_auth_id == participant_auth_id
                && connection.generation == generation
                && connection.connection_id == connection_id
        })
        .unwrap_or(false);
    if matches {
        jam.audio_connections.remove(identity);
    }
    matches
}

async fn jam_audio_ws_handler(mut socket: WebSocket, state: AppState, generation: u64) {
    use axum::extract::ws::Message;
    use futures_util::{SinkExt, StreamExt};

    let auth_text = match tokio::time::timeout(Duration::from_secs(5), socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };
    let Some(participant_token) = parse_jam_audio_auth_message(auth_text.as_str()) else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    let participant_claims = match ensure_jam_participant_token(&state, &participant_token) {
        Ok(claims) => claims,
        Err(_) => {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };
    let identity = participant_claims.sub;
    let Some(participant_auth_id) = participant_claims.echo_participant_auth_id else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };

    info!(
        "[jam-audio-ws] client authenticated generation={}",
        generation
    );

    if ensure_jam_source_ready(&state).await.ok() != Some(generation) {
        let _ = socket.send(Message::Close(None)).await;
        return;
    }
    let mut rx = {
        let bot_guard = state.jam_bot.lock().await;
        match &*bot_guard {
            Some(bot) if bot.generation() == generation && bot.is_healthy() => bot.subscribe(),
            None | Some(_) => {
                // No bot running — close with a message
                let _ = socket.send(Message::Close(None)).await;
                info!("[jam-audio-ws] no jam bot running, closing");
                return;
            }
        }
    };
    let Some(connection_id) =
        register_audio_connection(&state, &identity, &participant_auth_id, generation)
    else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    if socket
        .send(Message::Text(r#"{"type":"ready"}"#.into()))
        .await
        .is_err()
    {
        unregister_audio_connection(
            &state,
            &identity,
            &participant_auth_id,
            generation,
            connection_id,
        );
        return;
    }

    let (mut sender, mut receiver) = socket.split();
    let mut membership_check = tokio::time::interval(Duration::from_secs(5));
    membership_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Read and write halves are polled independently, so a close is observed
    // even while Spotify is paused and the PCM broadcast channel is idle.
    loop {
        tokio::select! {
            _ = membership_check.tick() => {
                if !audio_connection_is_current(
                    &state,
                    &identity,
                    &participant_auth_id,
                    generation,
                    connection_id,
                ) {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
            }
            // Receive audio frame from broadcast channel
            frame_result = rx.recv() => {
                match frame_result {
                    Ok(frame) => {
                        // Convert Vec<f32> to raw little-endian bytes
                        let bytes: Vec<u8> = frame.data.iter()
                            .flat_map(|s| s.to_le_bytes())
                            .collect();
                        if sender.send(Message::Binary(bytes.into())).await.is_err() {
                            break; // Client disconnected
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        // Client too slow, skip old frames
                        warn!("[jam-audio-ws] client lagged, dropped {} frames", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // Bot stopped — send close
                        let _ = sender.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
            // Check for incoming messages (client close, etc.)
            message = receiver.next() => {
                match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    unregister_audio_connection(
        &state,
        &identity,
        &participant_auth_id,
        generation,
        connection_id,
    );

    info!(
        "[jam-audio-ws] client disconnected generation={}",
        generation
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spotify_token() -> SpotifyToken {
        SpotifyToken {
            access_token: "access".to_string(),
            refresh_token: "refresh".to_string(),
            expires_at: 999_999,
        }
    }

    fn queued_track(uri: &str) -> QueuedTrack {
        QueuedTrack {
            queue_entry_id: format!("qe-{uri}"),
            queue_batch_id: None,
            spotify_id: String::new(),
            spotify_uri: uri.to_string(),
            spotify_url: String::new(),
            name: uri.to_string(),
            artist: "artist".to_string(),
            album_art_url: String::new(),
            duration_ms: 1,
            added_at_ms: 1,
            added_by_actor_id: "actor".to_string(),
            added_by_name: "sam-7475".to_string(),
            playlist: None,
            added_by: "sam-7475".to_string(),
        }
    }

    fn spotify_device(id: &str, name: &str) -> SpotifyDevice {
        SpotifyDevice {
            id: id.to_string(),
            name: name.to_string(),
        }
    }

    fn source_snapshot(
        connected: bool,
        availability_known: bool,
        enabled: bool,
        status: &str,
    ) -> crate::jam_source::JamSourceSnapshot {
        crate::jam_source::JamSourceSnapshot {
            configured: true,
            connected,
            availability_known,
            enabled,
            status: status.to_string(),
            error: None,
            generation: None,
            ready: false,
            pid: None,
            sample_rate: None,
            channels: None,
            last_frame_ms: None,
            peak: 0.0,
        }
    }

    fn now_playing(is_playing: bool) -> NowPlayingInfo {
        NowPlayingInfo {
            spotify_id: "0VjIjW4GlUZAMYd2vXMi3b".to_string(),
            spotify_uri: "spotify:track:0VjIjW4GlUZAMYd2vXMi3b".to_string(),
            spotify_url: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b".to_string(),
            name: "Current track".to_string(),
            artist: "Current artist".to_string(),
            album_art_url: String::new(),
            duration_ms: 120_000,
            progress_ms: 15_000,
            is_playing,
            fetched_at: None,
        }
    }

    #[test]
    fn failed_bot_start_does_not_activate_jam() {
        let mut jam = JamState {
            spotify_token: Some(spotify_token()),
            ..JamState::default()
        };

        let activated = apply_jam_start_result(
            &mut jam,
            "sam-7475".to_string(),
            "binding-a".to_string(),
            false,
        );

        assert!(!activated);
        assert!(!jam.active);
        assert!(jam.host_identity.is_empty());
        assert!(jam.listeners.is_empty());
    }

    #[test]
    fn jam_start_fails_closed_until_the_source_pc_is_explicitly_armed() {
        let negotiating = source_snapshot(true, false, false, "negotiating");
        assert_eq!(
            jam_source_start_preflight(&negotiating).unwrap_err().1,
            "Jam source availability is still negotiating"
        );

        let disabled = source_snapshot(true, true, false, "disabled");
        assert_eq!(
            jam_source_start_preflight(&disabled).unwrap_err().1,
            "Jam sharing is turned off on the source PC"
        );

        let armed = source_snapshot(true, true, true, "ready");
        assert!(jam_source_start_preflight(&armed).is_ok());
        assert!(!jam_source_ready_for_generation(&armed, 12));

        let mut exact_ready = armed.clone();
        exact_ready.ready = true;
        exact_ready.generation = Some(12);
        assert!(jam_source_ready_for_generation(&exact_ready, 12));
        assert!(!jam_source_ready_for_generation(&exact_ready, 13));

        exact_ready.connected = false;
        assert!(!jam_source_ready_for_generation(&exact_ready, 12));
    }

    #[test]
    fn source_watchdog_recovers_when_registry_generation_was_cleared() {
        let source = source_snapshot(true, true, true, "ready");
        let error = active_jam_source_watchdog_error(&source, 42)
            .expect("an active Jam cannot survive a cleared source generation");
        assert!(error.contains("expected 42"));
    }

    #[test]
    fn source_watchdog_allows_exact_generation_restart_but_rejects_terminal_error() {
        let mut source = source_snapshot(true, true, true, "starting");
        source.generation = Some(42);
        assert!(active_jam_source_watchdog_error(&source, 42).is_none());

        source.status = "error".to_string();
        source.error = Some("capture failed".to_string());
        assert_eq!(
            active_jam_source_watchdog_error(&source, 42).as_deref(),
            Some("capture failed")
        );
    }

    #[test]
    fn jam_teardown_conditions_are_generation_fenced() {
        let mut jam = JamState {
            active: true,
            generation: 12,
            ..JamState::default()
        };
        assert!(jam_end_condition_matches(&jam, 12, JamEndCondition::Active));
        assert!(!jam_end_condition_matches(
            &jam,
            11,
            JamEndCondition::Active
        ));
        assert!(jam_end_condition_matches(
            &jam,
            12,
            JamEndCondition::NoListeners
        ));
        jam.listeners.insert("sam".into(), "binding".into());
        assert!(!jam_end_condition_matches(
            &jam,
            12,
            JamEndCondition::NoListeners
        ));
        jam.active = false;
        jam.starting = true;
        assert!(jam_end_condition_matches(
            &jam,
            12,
            JamEndCondition::ActiveOrStarting
        ));
    }

    #[test]
    fn successful_bot_start_activates_host_listener() {
        let mut jam = JamState {
            spotify_token: Some(spotify_token()),
            ..JamState::default()
        };

        let activated = apply_jam_start_result(
            &mut jam,
            "sam-7475".to_string(),
            "binding-a".to_string(),
            true,
        );

        assert!(activated);
        assert!(jam.active);
        assert_eq!(jam.host_identity, "sam-7475");
        assert_eq!(
            jam.listeners.get("sam-7475").map(String::as_str),
            Some("binding-a")
        );

        let response = jam_start_response(7, &spotify_device("device-a", "Echo PC"));
        assert_eq!(response["generation"], 7);
        assert_eq!(response["listener_joined"], true);
    }

    #[test]
    fn public_stop_requires_the_host_identity() {
        let jam = JamState {
            active: true,
            host_identity: "sam-7475".to_string(),
            host_participant_auth_id: "binding-a".to_string(),
            ..JamState::default()
        };

        assert!(jam_stop_authorized(&jam, "sam-7475", "binding-a"));
        assert!(!jam_stop_authorized(&jam, "sam-1234", "binding-a"));
        assert!(!jam_stop_authorized(&jam, "sam-7475", "binding-b"));
        assert!(!jam_stop_authorized(&jam, "", "binding-a"));
        assert!(!jam_stop_authorized(&jam, "other-1234", "binding-a"));
    }

    #[test]
    fn spotify_pause_targets_only_the_encoded_device() {
        assert_eq!(
            spotify_pause_url("device id/+"),
            "https://api.spotify.com/v1/me/player/pause?device_id=device%20id%2F%2B"
        );
    }

    #[test]
    fn playback_stop_preserves_the_active_jam_and_marks_music_paused() {
        let mut listeners = HashMap::new();
        listeners.insert("sam-7475".to_string(), "binding-a".to_string());
        let mut jam = JamState {
            active: true,
            generation: 42,
            host_identity: "sam-7475".to_string(),
            host_participant_auth_id: "binding-a".to_string(),
            queue: vec![queued_track("spotify:track:one")],
            now_playing: Some(now_playing(true)),
            listeners,
            spotify_device_id: Some("device-a".to_string()),
            spotify_device_name: Some("Echo PC".to_string()),
            spotify_is_playing: true,
            audio_expected_since: Some(std::time::Instant::now()),
            last_error: Some("old capture warning".to_string()),
            ..JamState::default()
        };

        assert!(!apply_spotify_pause_result(
            &mut jam,
            42,
            &spotify_device("different-device", "Other PC")
        ));
        assert!(jam.spotify_is_playing);
        assert!(apply_spotify_pause_result(
            &mut jam,
            42,
            &spotify_device("device-a", "Echo PC")
        ));

        assert!(jam.active);
        assert_eq!(jam.generation, 42);
        assert_eq!(jam.host_identity, "sam-7475");
        assert_eq!(
            jam.listeners.get("sam-7475").map(String::as_str),
            Some("binding-a")
        );
        assert_eq!(jam.queue.len(), 1);
        assert_eq!(jam.queue[0].spotify_uri, "spotify:track:one");
        assert_eq!(jam.spotify_device_id.as_deref(), Some("device-a"));
        assert_eq!(jam.spotify_device_name.as_deref(), Some("Echo PC"));
        assert!(!jam.spotify_is_playing);
        assert!(jam.audio_expected_since.is_none());
        assert!(jam.last_error.is_none());
        assert_eq!(
            jam.now_playing.as_ref().map(|track| track.is_playing),
            Some(false)
        );
        assert!(jam
            .now_playing
            .as_ref()
            .and_then(|track| track.fetched_at)
            .is_some());
    }

    #[test]
    fn stale_playback_stop_cannot_mutate_a_newer_generation() {
        let mut jam = JamState {
            active: true,
            generation: 43,
            spotify_is_playing: true,
            now_playing: Some(now_playing(true)),
            ..JamState::default()
        };

        assert!(!apply_spotify_pause_result(
            &mut jam,
            42,
            &spotify_device("stale-device", "Stale Echo PC")
        ));
        assert_eq!(jam.generation, 43);
        assert!(jam.spotify_is_playing);
        assert!(jam.spotify_device_id.is_none());
        assert_eq!(
            jam.now_playing.as_ref().map(|track| track.is_playing),
            Some(true)
        );
    }

    #[test]
    fn mutations_are_fenced_to_the_active_generation() {
        let mut jam = JamState {
            active: true,
            generation: 42,
            ..JamState::default()
        };

        assert!(active_generation_matches(&jam, 42));
        assert!(!active_generation_matches(&jam, 41));
        jam.active = false;
        assert!(!active_generation_matches(&jam, 42));
    }

    #[test]
    fn spotify_device_id_is_preferred_over_name() {
        let selected = select_spotify_device(
            vec![
                spotify_device("id-a", "Echo PC"),
                spotify_device("id-b", "Echo PC"),
            ],
            Some("id-b"),
            Some("Echo PC"),
        )
        .expect("exact ID");
        assert_eq!(selected.id, "id-b");
    }

    #[test]
    fn duplicate_exact_spotify_device_names_are_rejected() {
        let error = select_spotify_device(
            vec![
                spotify_device("id-a", "Echo PC"),
                spotify_device("id-b", "echo pc"),
            ],
            None,
            Some("ECHO PC"),
        )
        .unwrap_err();
        assert_eq!(error.0, StatusCode::CONFLICT);
    }

    #[test]
    fn listener_audio_requires_current_protocol() {
        let mut params = std::collections::HashMap::new();
        assert!(!listener_protocol_is_current(&params));
        params.insert("generation".to_string(), "9".to_string());
        params.insert("jam_protocol_version".to_string(), "1".to_string());
        assert!(!listener_protocol_is_current(&params));
        params.insert(
            "jam_protocol_version".to_string(),
            crate::jam_source::JAM_SOURCE_PROTOCOL_VERSION.to_string(),
        );
        assert!(listener_protocol_is_current(&params));
        params.insert("identity".to_string(), "must-not-be-in-url".to_string());
        assert!(!listener_protocol_is_current(&params));
    }

    #[test]
    fn listener_audio_first_frame_must_be_a_bounded_auth_message() {
        assert_eq!(
            parse_jam_audio_auth_message(r#"{"type":"auth","token":"signed"}"#).as_deref(),
            Some("signed")
        );
        assert!(parse_jam_audio_auth_message(r#"{"type":"ready","token":"signed"}"#).is_none());
        assert!(parse_jam_audio_auth_message(r#"{"type":"auth","token":""}"#).is_none());
        assert!(parse_jam_audio_auth_message(
            r#"{"type":"auth","token":"signed","identity":"not-accepted"}"#
        )
        .is_none());
        assert!(parse_jam_audio_auth_message("not-json").is_none());
        assert!(parse_jam_audio_auth_message(&"x".repeat(16 * 1024 + 1)).is_none());
    }

    #[test]
    fn listener_audio_is_bound_to_identity_and_generation() {
        let mut jam = JamState {
            active: true,
            generation: 9,
            ..JamState::default()
        };
        jam.listeners
            .insert("sam-7475".to_string(), "binding-a".to_string());

        assert!(listener_attachment_allowed(
            &jam,
            "sam-7475",
            "binding-a",
            9
        ));
        assert!(!listener_attachment_allowed(
            &jam,
            "sam-7475",
            "binding-b",
            9
        ));
        assert!(!listener_attachment_allowed(
            &jam,
            "sam-7475",
            "binding-a",
            8
        ));
        assert!(!listener_attachment_allowed(
            &jam,
            "other-1234",
            "binding-a",
            9
        ));
        jam.active = false;
        assert!(!listener_attachment_allowed(
            &jam,
            "sam-7475",
            "binding-a",
            9
        ));
    }

    #[test]
    fn superseded_audio_socket_cannot_unregister_its_replacement() {
        let mut jam = JamState::default();
        jam.audio_connections.insert(
            "sam-7475".to_string(),
            JamAudioConnection {
                participant_auth_id: "binding-a".to_string(),
                generation: 9,
                connection_id: 2,
            },
        );

        assert!(!unregister_audio_connection_from_jam(
            &mut jam,
            "sam-7475",
            "binding-a",
            9,
            1,
        ));
        assert_eq!(jam.audio_connections["sam-7475"].connection_id, 2);
        assert!(unregister_audio_connection_from_jam(
            &mut jam,
            "sam-7475",
            "binding-a",
            9,
            2,
        ));
        assert!(!jam.audio_connections.contains_key("sam-7475"));
    }

    #[test]
    fn revocation_removes_only_the_exact_listener_and_audio_binding() {
        let mut jam = JamState {
            active: true,
            generation: 9,
            host_identity: "host-1111".to_string(),
            host_participant_auth_id: "host-binding".to_string(),
            ..JamState::default()
        };
        jam.listeners
            .insert("host-1111".to_string(), "host-binding".to_string());
        jam.listeners
            .insert("sam-7475".to_string(), "binding-new".to_string());
        jam.audio_connections.insert(
            "sam-7475".to_string(),
            JamAudioConnection {
                participant_auth_id: "binding-new".to_string(),
                generation: 9,
                connection_id: 2,
            },
        );

        let result = apply_revoked_participant_bindings(
            &mut jam,
            &[RevokedParticipantBinding {
                identity: "sam-7475".to_string(),
                auth_id: "binding-old".to_string(),
            }],
        );

        assert_eq!(result, (None, None));
        assert_eq!(
            jam.listeners.get("sam-7475").map(String::as_str),
            Some("binding-new")
        );
        assert!(jam.audio_connections.contains_key("sam-7475"));
    }

    #[test]
    fn revoking_the_exact_host_binding_requests_generation_teardown() {
        let mut jam = JamState {
            active: true,
            generation: 9,
            host_identity: "host-1111".to_string(),
            host_participant_auth_id: "host-binding".to_string(),
            ..JamState::default()
        };
        jam.listeners
            .insert("host-1111".to_string(), "host-binding".to_string());

        let result = apply_revoked_participant_bindings(
            &mut jam,
            &[RevokedParticipantBinding {
                identity: "host-1111".to_string(),
                auth_id: "host-binding".to_string(),
            }],
        );

        assert_eq!(result, (Some(9), None));
        // Session teardown is asynchronous because Spotify must be paused
        // before the source PC restores its output route.
        assert!(jam.active);
        assert_eq!(jam.host_identity, "host-1111");
        assert!(jam.listeners.is_empty());
        assert!(jam.audio_connections.is_empty());
    }

    #[test]
    fn paused_spotify_keeps_a_ready_source_healthy() {
        let health = public_source_health(true, false, None, true, "stalled".to_string(), None);
        assert_eq!(health, ("ready".to_string(), None));
    }

    #[test]
    fn resumed_spotify_gets_an_audio_startup_grace_period() {
        let health =
            public_source_health(true, true, Some(4_999), true, "stalled".to_string(), None);
        assert_eq!(health, ("ready".to_string(), None));
    }

    #[test]
    fn playing_spotify_without_audio_becomes_stalled_after_grace_period() {
        let health =
            public_source_health(true, true, Some(5_001), true, "silent".to_string(), None);
        assert_eq!(health.0, "stalled");
        assert_eq!(
            health.1.as_deref(),
            Some("Spotify is playing but Echo is receiving no audible audio")
        );
    }

    #[test]
    fn capture_rebind_requires_expected_audio_and_a_raw_packet_stall() {
        assert!(should_restart_stalled_capture(
            true,
            true,
            Some(5_001),
            "stalled"
        ));
        assert!(!should_restart_stalled_capture(
            true, false, None, "stalled"
        ));
        assert!(!should_restart_stalled_capture(
            true,
            true,
            Some(4_999),
            "stalled"
        ));
        assert!(!should_restart_stalled_capture(
            true,
            true,
            Some(5_001),
            "ready"
        ));
        assert!(!should_restart_stalled_capture(
            true,
            true,
            Some(5_001),
            "silent"
        ));
    }

    #[test]
    fn stalled_connected_source_still_allows_recovery_controls() {
        assert!(source_status_allows_recovery_control("ready"));
        assert!(source_status_allows_recovery_control("live"));
        assert!(source_status_allows_recovery_control("silent"));
        assert!(source_status_allows_recovery_control("stalled"));
        assert!(!source_status_allows_recovery_control("starting"));
        assert!(!source_status_allows_recovery_control("offline"));
        assert!(!source_status_allows_recovery_control("error"));
    }

    #[test]
    fn real_source_failure_is_not_hidden_while_paused() {
        let health = public_source_health(
            true,
            false,
            None,
            false,
            "error".to_string(),
            Some("capture failed".to_string()),
        );
        assert_eq!(
            health,
            ("error".to_string(), Some("capture failed".to_string()))
        );
    }

    #[test]
    fn spotify_refresh_scope_rejects_stale_generation_or_device() {
        let mut jam = JamState {
            active: true,
            generation: 12,
            spotify_device_id: Some("device-a".to_string()),
            ..JamState::default()
        };

        assert!(playback_fetch_matches(&jam, 12, "device-a"));
        assert!(!playback_fetch_matches(&jam, 11, "device-a"));
        assert!(!playback_fetch_matches(&jam, 12, "device-b"));
        jam.active = false;
        assert!(!playback_fetch_matches(&jam, 12, "device-a"));
    }

    #[test]
    fn queue_only_advances_to_an_observed_echo_track() {
        let mut queue = vec![queued_track("one"), queued_track("two")];

        assert!(reconcile_queue_to_current(&mut queue, "external").is_empty());
        assert_eq!(queue.len(), 2);

        let removed = reconcile_queue_to_current(&mut queue, "two");
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].spotify_uri, "one");
        assert_eq!(queue[0].spotify_uri, "two");
    }

    #[test]
    fn playlist_request_ids_and_track_uris_are_strict() {
        assert!(playlist_queue_request_id_valid("request_123"));
        assert!(!playlist_queue_request_id_valid("short"));
        assert!(!playlist_queue_request_id_valid("request with spaces"));
        assert_eq!(
            spotify_track_id_from_uri("spotify:track:0VjIjW4GlUZAMYd2vXMi3b"),
            Some("0VjIjW4GlUZAMYd2vXMi3b")
        );
        assert!(spotify_track_id_from_uri("spotify:track:short").is_none());
        assert!(spotify_track_id_from_uri("https://example.invalid").is_none());
    }

    #[test]
    fn queue_entries_use_server_summary_actor_and_playlist_provenance() {
        let summary = FavoriteSummary {
            spotify_id: "0VjIjW4GlUZAMYd2vXMi3b".to_string(),
            spotify_uri: "spotify:track:0VjIjW4GlUZAMYd2vXMi3b".to_string(),
            spotify_url: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b".to_string(),
            name: "Server name".to_string(),
            artist: Some("Server artist".to_string()),
            artwork_url: Some("https://image.example/server.jpg".to_string()),
            duration_ms: Some(321),
            ..FavoriteSummary::default()
        };
        let actor = JamActor {
            actor_id: "ea1_actor".to_string(),
            display_name: "Sam".to_string(),
        };
        let playlist = QueuedPlaylistProvenance {
            spotify_id: "3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
            spotify_uri: "spotify:playlist:3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
            spotify_url: "https://open.spotify.com/playlist/3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
            name: "Mix".to_string(),
        };
        let queued =
            queued_track_from_summary(&summary, &actor, Some("batch"), Some(&playlist), 99);
        assert_eq!(queued.name, "Server name");
        assert_eq!(queued.artist, "Server artist");
        assert_eq!(queued.added_by_actor_id, "ea1_actor");
        assert_eq!(queued.added_at_ms, 99);
        assert_eq!(queued.queue_batch_id.as_deref(), Some("batch"));
        assert_eq!(queued.playlist, Some(playlist));
    }

    #[test]
    fn queue_control_change_invalidates_cached_playback_mode() {
        assert_eq!(cached_queue_mode(4, 4, Some(true)), Some(true));
        assert_eq!(cached_queue_mode(4, 5, Some(true)), None);
        assert!(enqueue_interrupted_by_stop(4, 5, true));
        assert!(!enqueue_interrupted_by_stop(4, 5, false));
        assert!(!enqueue_interrupted_by_stop(5, 5, true));
        assert_eq!(playlist_batch_flags(false, 0), (false, true));
        assert_eq!(playlist_batch_flags(false, 1), (true, false));
        assert_eq!(playlist_batch_flags(true, 0), (true, false));
    }

    #[test]
    fn playlist_queue_response_serializes_ordered_partial_results_and_failure() {
        let playlist = QueuedPlaylistProvenance {
            spotify_id: "3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
            spotify_uri: "spotify:playlist:3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
            spotify_url: "https://open.spotify.com/playlist/3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
            name: "Server playlist".to_string(),
        };
        let actor = JamActor {
            actor_id: "ea1_actor".to_string(),
            display_name: "Sam".to_string(),
        };
        let summary = |spotify_id: &str, name: &str| FavoriteSummary {
            spotify_id: spotify_id.to_string(),
            spotify_uri: format!("spotify:track:{spotify_id}"),
            spotify_url: format!("https://open.spotify.com/track/{spotify_id}"),
            name: name.to_string(),
            artist: Some("Server artist".to_string()),
            duration_ms: Some(321),
            ..FavoriteSummary::default()
        };
        let queued = vec![
            queued_track_from_summary(
                &summary("0VjIjW4GlUZAMYd2vXMi3b", "First"),
                &actor,
                Some("batch-1"),
                Some(&playlist),
                99,
            ),
            queued_track_from_summary(
                &summary("3n3Ppam7vgaVa1iaRUc9Lp", "Second"),
                &actor,
                Some("batch-1"),
                Some(&playlist),
                99,
            ),
        ];
        let response = PlaylistQueueResponse {
            schema_version: 1,
            ok: false,
            partial: true,
            request_id: "request_123".to_string(),
            queue_batch_id: "batch-1".to_string(),
            batch_id: "batch-1".to_string(),
            generation: 7,
            playlist,
            queued,
            queued_count: 2,
            skipped: vec![SkippedPlaylistItem {
                position: 2,
                reason: "local_track".to_string(),
            }],
            skipped_count: 1,
            complete: false,
            failure: Some(PlaylistQueueFailure {
                status: 429,
                error: "spotify_rate_limited".to_string(),
                message: "Spotify rate limit reached".to_string(),
                retry_after: Some("12".to_string()),
            }),
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["schema_version"], 1);
        assert_eq!(json["ok"], false);
        assert_eq!(json["partial"], true);
        assert_eq!(json["complete"], false);
        assert_eq!(json["queue_batch_id"], "batch-1");
        assert_eq!(json["batch_id"], "batch-1");
        assert_eq!(json["queued_count"], 2);
        assert_eq!(json["skipped_count"], 1);
        assert_eq!(json["queued"][0]["name"], "First");
        assert_eq!(json["queued"][1]["name"], "Second");
        assert_eq!(json["queued"][0]["added_by_actor_id"], "ea1_actor");
        assert_eq!(json["queued"][0]["added_by"], "Sam");
        assert_eq!(json["queued"][0]["playlist"]["name"], "Server playlist");
        assert_eq!(json["skipped"][0]["position"], 2);
        assert_eq!(json["skipped"][0]["reason"], "local_track");
        assert_eq!(json["failure"]["status"], 429);
        assert_eq!(json["failure"]["error"], "spotify_rate_limited");
        assert_eq!(json["failure"]["retry_after"], "12");
    }

    #[test]
    fn now_playing_identity_is_canonical_and_rejects_mismatches() {
        let item = serde_json::json!({
            "type":"track",
            "id":"0VjIjW4GlUZAMYd2vXMi3b",
            "uri":"spotify:track:0VjIjW4GlUZAMYd2vXMi3b",
        });
        assert_eq!(
            spotify_track_identity(&item),
            (
                "0VjIjW4GlUZAMYd2vXMi3b".to_string(),
                "spotify:track:0VjIjW4GlUZAMYd2vXMi3b".to_string(),
                "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b".to_string(),
            )
        );
        let mismatched = serde_json::json!({
            "type":"track",
            "id":"0VjIjW4GlUZAMYd2vXMi3b",
            "uri":"spotify:track:3n3Ppam7vgaVa1iaRUc9Lp",
        });
        assert_eq!(
            spotify_track_identity(&mismatched),
            (String::new(), String::new(), String::new())
        );
    }

    #[test]
    fn playlist_receipt_cache_is_bounded_and_evicts_oldest() {
        fn response(request_id: String) -> PlaylistQueueResponse {
            PlaylistQueueResponse {
                schema_version: 1,
                ok: true,
                partial: false,
                request_id,
                queue_batch_id: "batch".to_string(),
                batch_id: "batch".to_string(),
                generation: 1,
                playlist: QueuedPlaylistProvenance::default(),
                queued: Vec::new(),
                queued_count: 0,
                skipped: Vec::new(),
                skipped_count: 0,
                complete: true,
                failure: None,
            }
        }
        let mut jam = JamState::default();
        for index in 0..129u64 {
            let request_id = format!("request_{index:03}");
            insert_playlist_queue_receipt(
                &mut jam,
                request_id.clone(),
                PlaylistQueueReceipt {
                    actor_id: "actor".to_string(),
                    playlist_id: "3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
                    generation: 1,
                    created_at_ms: index,
                    response: response(request_id),
                },
            );
        }
        assert_eq!(jam.playlist_queue_receipts.len(), 128);
        assert!(!jam.playlist_queue_receipts.contains_key("request_000"));
        assert!(jam.playlist_queue_receipts.contains_key("request_128"));
        let replay = playlist_queue_receipt_response(
            &jam,
            "request_128",
            "actor",
            "3n3Ppam7vgaVa1iaRUc9Lp",
            1,
        )
        .unwrap()
        .unwrap();
        assert_eq!(replay.request_id, "request_128");
        assert!(playlist_queue_receipt_response(
            &jam,
            "request_128",
            "other-actor",
            "3n3Ppam7vgaVa1iaRUc9Lp",
            1,
        )
        .is_err());
    }
}
