use crate::auth::{
    ensure_admin, ensure_jam_actor, ensure_jam_participant, ensure_jam_participant_token, JamActor,
    RevokedParticipantBinding,
};
use crate::config::*;
use crate::jam_history::{new_history_observation, HistoryObservation};
use crate::jam_library::{
    fetch_favorite_summary, fetch_playlist_expansion, fetch_playlist_selection, valid_spotify_id,
    validate_selected_playlist_positions, FavoriteKind, FavoriteSummary, JamApiError,
    SkippedPlaylistItem,
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
    collections::{HashMap, HashSet},
    fs,
    future::Future,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tracing::{info, warn};

const SPOTIFY_RELEASE_PAUSE_TIMEOUT: Duration = Duration::from_secs(15);
const SPOTIFY_START_BIND_TIMEOUT: Duration = Duration::from_secs(15);
const SPOTIFY_RECOVERY_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const SPOTIFY_CONNECT_REGISTRATION_POLL_INTERVAL: Duration = Duration::from_secs(1);
const SPOTIFY_CONNECT_REGISTRATION_POLL_ATTEMPTS: usize = 4;
const SPOTIFY_CONNECT_REPAIR_DEADLINE: Duration = Duration::from_secs(15);
const SOURCE_START_RECHECK_INTERVAL: Duration = Duration::from_millis(100);
const SPOTIFY_COMMITTED_QUEUE_FRONTIER: usize = 2;
const MAX_QUEUE_REMOVAL_ENTRIES: usize = 1_000;
const SPOTIFY_LIBRARY_SCOPES: [&str; 3] = [
    "user-library-read",
    "playlist-read-private",
    "playlist-read-collaborative",
];
const SPOTIFY_CALLBACK_RECEIVED_HTML: &str = "<html><body><h1>Spotify authorization received</h1><p>Return to Echo Chamber while it verifies the connection. You can close this tab.</p></body></html>";

// ── Structs ──────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct SpotifyToken {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) expires_at: u64, // unix timestamp
    #[serde(default)]
    pub(crate) scope: String,
}

fn spotify_scope_from_token_response(data: &serde_json::Value, fallback: Option<&str>) -> String {
    data.get("scope")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| fallback.unwrap_or_default())
        .to_string()
}

pub(crate) fn spotify_library_scopes_authorized(token: Option<&SpotifyToken>) -> bool {
    token.is_some_and(|token| {
        SPOTIFY_LIBRARY_SCOPES.iter().all(|required_scope| {
            token
                .scope
                .split_ascii_whitespace()
                .any(|granted_scope| granted_scope == *required_scope)
        })
    })
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
    pub(crate) queue: Vec<JamQueueEntry>,
    pub(crate) queue_revision: u64,
    pub(crate) track_queue_receipts: HashMap<String, TrackQueueReceipt>,
    pub(crate) playlist_queue_receipts: HashMap<String, PlaylistQueueReceipt>,
    pub(crate) queue_removal_receipts: HashMap<String, QueueRemovalReceipt>,
    pub(crate) queue_control_epoch: u64,
    // Monotonic admission fence for any transition into a stopped queue. Unlike
    // `queue_control_stopped`, this is not cleared when a later explicit add
    // resumes playback, so work admitted before Stop cannot reappear afterward.
    pub(crate) queue_stop_epoch: u64,
    pub(crate) queue_control_stopped: bool,
    pub(crate) uncertain_skip: Option<UncertainSkipBoundary>,
    pub(crate) last_history_spotify_id: Option<String>,
    pub(crate) last_history_was_echo: bool,
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QueueDeliveryState {
    Pending,
    #[default]
    SpotifyCommitted,
    CommitUnknown,
}

impl QueueDeliveryState {
    fn is_removable(self) -> bool {
        self == Self::Pending
    }

    fn occupies_spotify_frontier(self) -> bool {
        matches!(self, Self::SpotifyCommitted | Self::CommitUnknown)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum QueueCurrentMatchState {
    #[default]
    Eligible,
    AwaitingTransition,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) playlist_position: Option<usize>,
    // Kept for compatibility with the existing viewer during rollout.
    pub(crate) added_by: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct JamQueueEntry {
    #[serde(flatten)]
    pub(crate) track: QueuedTrack,
    #[serde(default)]
    pub(crate) delivery_state: QueueDeliveryState,
    #[serde(default)]
    pub(crate) can_remove: bool,
    // A track placed through Spotify's Add to Queue endpoint is not the current
    // occurrence yet. Keep that distinction internal so an already-playing
    // track with the same URI cannot steal this queue entry's provenance.
    #[serde(skip)]
    current_match_state: QueueCurrentMatchState,
}

fn pending_queue_entry(track: QueuedTrack) -> JamQueueEntry {
    JamQueueEntry {
        track,
        delivery_state: QueueDeliveryState::Pending,
        can_remove: true,
        current_match_state: QueueCurrentMatchState::Eligible,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TrackQueueReceipt {
    actor_id: String,
    spotify_id: String,
    generation: u64,
    created_at_ms: u64,
    track: JamQueueEntry,
}

fn insert_track_queue_receipt(jam: &mut JamState, request_id: String, receipt: TrackQueueReceipt) {
    if jam.track_queue_receipts.len() >= 128 {
        let oldest = jam
            .track_queue_receipts
            .iter()
            .min_by_key(|(_, receipt)| receipt.created_at_ms)
            .map(|(request_id, _)| request_id.clone());
        if let Some(oldest) = oldest {
            jam.track_queue_receipts.remove(&oldest);
        }
    }
    jam.track_queue_receipts.insert(request_id, receipt);
}

fn track_queue_receipt_response(
    jam: &JamState,
    request_id: &str,
    actor_id: &str,
    spotify_id: &str,
    generation: u64,
) -> Result<Option<JamQueueEntry>, ()> {
    let Some(receipt) = jam.track_queue_receipts.get(request_id) else {
        return Ok(None);
    };
    if receipt.actor_id == actor_id
        && receipt.spotify_id == spotify_id
        && receipt.generation == generation
    {
        Ok(Some(receipt.track.clone()))
    } else {
        Err(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PlaylistQueueSelectionFingerprint {
    selected_positions: Option<Vec<usize>>,
    snapshot_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PlaylistQueueReceipt {
    actor_id: String,
    playlist_id: String,
    selection: PlaylistQueueSelectionFingerprint,
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
    selection: &PlaylistQueueSelectionFingerprint,
    generation: u64,
) -> Result<Option<PlaylistQueueResponse>, ()> {
    let Some(receipt) = jam.playlist_queue_receipts.get(request_id) else {
        return Ok(None);
    };
    if receipt.actor_id == actor_id
        && receipt.playlist_id == playlist_id
        && &receipt.selection == selection
        && receipt.generation == generation
    {
        Ok(Some(receipt.response.clone()))
    } else {
        Err(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct QueueRemovalFingerprint {
    expected_queue_revision: u64,
    queue_entry_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum QueueRemovalMutationError {
    QueueChanged,
    NotRemovable,
}

fn remove_pending_queue_entries(
    jam: &mut JamState,
    queue_entry_ids: &[String],
) -> Result<(), QueueRemovalMutationError> {
    for entry_id in queue_entry_ids {
        let Some(entry) = jam
            .queue
            .iter()
            .find(|entry| entry.track.queue_entry_id == *entry_id)
        else {
            return Err(QueueRemovalMutationError::QueueChanged);
        };
        if !entry.delivery_state.is_removable() || !entry.can_remove {
            return Err(QueueRemovalMutationError::NotRemovable);
        }
    }
    let selected = queue_entry_ids.iter().cloned().collect::<HashSet<_>>();
    jam.queue
        .retain(|entry| !selected.contains(&entry.track.queue_entry_id));
    jam.queue_revision = jam.queue_revision.wrapping_add(1);
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) struct QueueRemovalReceipt {
    actor_id: String,
    generation: u64,
    fingerprint: QueueRemovalFingerprint,
    created_at_ms: u64,
    response: JamQueueRemoveResponse,
}

fn insert_queue_removal_receipt(
    jam: &mut JamState,
    request_id: String,
    receipt: QueueRemovalReceipt,
) {
    if jam.queue_removal_receipts.len() >= 128 {
        let oldest = jam
            .queue_removal_receipts
            .iter()
            .min_by_key(|(_, receipt)| receipt.created_at_ms)
            .map(|(request_id, _)| request_id.clone());
        if let Some(oldest) = oldest {
            jam.queue_removal_receipts.remove(&oldest);
        }
    }
    jam.queue_removal_receipts.insert(request_id, receipt);
}

fn queue_removal_receipt_response(
    jam: &JamState,
    request_id: &str,
    actor_id: &str,
    generation: u64,
    fingerprint: &QueueRemovalFingerprint,
) -> Result<Option<JamQueueRemoveResponse>, ()> {
    let Some(receipt) = jam.queue_removal_receipts.get(request_id) else {
        return Ok(None);
    };
    if receipt.actor_id == actor_id
        && receipt.generation == generation
        && &receipt.fingerprint == fingerprint
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
    #[serde(default)]
    request_id: Option<String>,
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
pub(crate) struct JamQueueRemoveRequest {
    generation: u64,
    request_id: String,
    expected_queue_revision: u64,
    queue_entry_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct JamQueueRemoveResponse {
    ok: bool,
    generation: u64,
    queue_revision: u64,
    removed_entry_ids: Vec<String>,
    removed_count: usize,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PlaylistQueueRequest {
    generation: u64,
    playlist_id: String,
    request_id: String,
    #[serde(default)]
    confirmed: bool,
    #[serde(default)]
    selected_positions: Option<Vec<usize>>,
    #[serde(default)]
    snapshot_id: Option<String>,
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
    queued_positions: Vec<usize>,
    remaining_positions: Vec<usize>,
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
    Ok(Html(SPOTIFY_CALLBACK_RECEIVED_HTML.to_string()))
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

fn spotify_upstream_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value["error"]["message"]
                .as_str()
                .or_else(|| value["error_description"].as_str())
                .map(str::to_string)
        })
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| {
            let message = body.chars().take(300).collect::<String>();
            if message.trim().is_empty() {
                "Spotify request failed".to_string()
            } else {
                message
            }
        })
}

pub(crate) fn spotify_library_scope_required_error() -> JamApiError {
    JamApiError {
        status: StatusCode::FORBIDDEN,
        code: "spotify_library_scope_required",
        message: "Spotify Library access is missing. Use Refresh Spotify Access, then try again."
            .to_string(),
        retry_after: None,
    }
}

fn spotify_token_exchange_error(
    upstream: reqwest::StatusCode,
    body: &str,
    retry_after: Option<String>,
) -> JamApiError {
    let upstream_message = spotify_upstream_message(body);
    let (status, code, message) = if upstream == reqwest::StatusCode::FORBIDDEN {
        (
            StatusCode::FORBIDDEN,
            "spotify_account_forbidden",
            format!(
                "Spotify rejected this account for the Echo Chamber app: {upstream_message}. If the app is in Development Mode, add this exact Spotify account under User Management, then reconnect."
            ),
        )
    } else if upstream == reqwest::StatusCode::TOO_MANY_REQUESTS {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "spotify_rate_limited",
            format!("Spotify token exchange was rate limited: {upstream_message}"),
        )
    } else {
        (
            StatusCode::BAD_GATEWAY,
            "spotify_token_exchange_failed",
            format!("Spotify token exchange failed (Spotify {upstream}): {upstream_message}"),
        )
    };
    JamApiError {
        status,
        code,
        message,
        retry_after,
    }
}

fn spotify_access_validation_error(
    upstream: reqwest::StatusCode,
    body: &str,
    retry_after: Option<String>,
) -> JamApiError {
    let upstream_message = spotify_upstream_message(body);
    let (status, code, message) = match upstream {
        reqwest::StatusCode::FORBIDDEN => (
            StatusCode::FORBIDDEN,
            "spotify_account_forbidden",
            format!(
                "Spotify rejected this account for the Echo Chamber app: {upstream_message}. If the app is in Development Mode, add this exact Spotify account under User Management, then reconnect."
            ),
        ),
        reqwest::StatusCode::TOO_MANY_REQUESTS => (
            StatusCode::TOO_MANY_REQUESTS,
            "spotify_rate_limited",
            format!("Spotify could not verify this connection yet: {upstream_message}"),
        ),
        reqwest::StatusCode::UNAUTHORIZED => (
            StatusCode::BAD_GATEWAY,
            "spotify_token_rejected",
            format!("Spotify rejected the new access token: {upstream_message}"),
        ),
        _ => (
            StatusCode::BAD_GATEWAY,
            "spotify_connection_validation_failed",
            format!(
                "Spotify connection validation failed (Spotify {upstream}): {upstream_message}"
            ),
        ),
    };
    JamApiError {
        status,
        code,
        message,
        retry_after,
    }
}

async fn validate_spotify_access_token(
    state: &AppState,
    token: &SpotifyToken,
) -> Result<(), JamApiError> {
    if let Some((status, message)) = spotify_rate_limit_error(state) {
        return Err(JamApiError {
            status,
            code: "spotify_rate_limited",
            message,
            retry_after: spotify_retry_after_seconds(state),
        });
    }
    let response = {
        let _permit = state
            .spotify_request_limit
            .acquire()
            .await
            .map_err(|_| JamApiError {
                status: StatusCode::SERVICE_UNAVAILABLE,
                code: "spotify_request_failed",
                message: "Spotify request gate is unavailable".to_string(),
                retry_after: None,
            })?;
        state
            .http_client
            .get("https://api.spotify.com/v1/me")
            .bearer_auth(&token.access_token)
            .send()
            .await
            .map_err(|error| JamApiError {
                status: StatusCode::BAD_GATEWAY,
                code: "spotify_connection_validation_failed",
                message: format!("Could not validate the Spotify connection: {error}"),
                retry_after: None,
            })?
    };
    remember_spotify_rate_limit(state, &response);
    let upstream = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.unwrap_or_default();
    if !upstream.is_success() {
        return Err(spotify_access_validation_error(
            upstream,
            &body,
            retry_after,
        ));
    }
    serde_json::from_str::<serde_json::Value>(&body).map_err(|error| JamApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "spotify_connection_validation_failed",
        message: format!("Spotify returned an invalid account response: {error}"),
        retry_after: None,
    })?;
    Ok(())
}

pub(crate) async fn jam_spotify_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SpotifyTokenRequest>,
) -> Result<Json<serde_json::Value>, JamApiError> {
    ensure_admin(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "unauthorized",
        message: "Authentication required".to_string(),
        retry_after: None,
    })?;

    let client_id = state.spotify_client_id.clone();
    if client_id.is_empty() {
        return Err(JamApiError::bad_request("Spotify is not configured"));
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
            JamApiError {
                status: StatusCode::BAD_GATEWAY,
                code: "spotify_token_exchange_failed",
                message: format!("Could not exchange the Spotify authorization code: {e}"),
                retry_after: None,
            }
        })?;

    let upstream = resp.status();
    let retry_after = resp
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = resp.text().await.unwrap_or_default();
    if !upstream.is_success() {
        return Err(spotify_token_exchange_error(upstream, &body, retry_after));
    }
    let data: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        warn!("Spotify token response parse failed: {}", e);
        JamApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "spotify_token_exchange_failed",
            message: format!("Spotify returned an invalid token response: {e}"),
            retry_after: None,
        }
    })?;

    let access_token = data["access_token"]
        .as_str()
        .ok_or_else(|| JamApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "spotify_token_exchange_failed",
            message: "Spotify token response did not include an access token".to_string(),
            retry_after: None,
        })?
        .to_string();
    let refresh_token = data["refresh_token"]
        .as_str()
        .ok_or_else(|| JamApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "spotify_token_exchange_failed",
            message: "Spotify token response did not include a refresh token".to_string(),
            retry_after: None,
        })?
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
        scope: spotify_scope_from_token_response(&data, None),
    };

    if !spotify_library_scopes_authorized(Some(&token)) {
        return Err(spotify_library_scope_required_error());
    }
    validate_spotify_access_token(&state, &token).await?;

    // Do not replace a previously working token until the candidate has passed
    // both scope inspection and a real Spotify Web API request.
    {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        jam.spotify_token = Some(token.clone());
    }
    // A new authorization may belong to a different Spotify account. Playlist
    // covers are process-memory-only, but private artwork must not survive that
    // account boundary.
    state.jam_favorites.clear_playlist_artwork_cache();
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

pub(crate) fn spotify_rate_limit_error(state: &AppState) -> Option<(StatusCode, String)> {
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
    remember_spotify_rate_limit_seconds(state, seconds);
}

pub(crate) fn remember_spotify_rate_limit_seconds(state: &AppState, seconds: u64) {
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
        scope: spotify_scope_from_token_response(&data, Some(&old.scope)),
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
    is_restricted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SpotifyDeviceResolveError {
    Unavailable(String),
    Other(StatusCode, String),
}

impl SpotifyDeviceResolveError {
    fn into_response(self) -> (StatusCode, String) {
        match self {
            Self::Unavailable(message) => (StatusCode::SERVICE_UNAVAILABLE, message),
            Self::Other(status, message) => (status, message),
        }
    }
}

fn select_spotify_device(
    candidates: Vec<SpotifyDevice>,
    configured_id: Option<&str>,
    configured_name: Option<&str>,
) -> Result<SpotifyDevice, SpotifyDeviceResolveError> {
    if let Some(configured_id) = configured_id {
        if let Some(device) = candidates.iter().find(|device| device.id == configured_id) {
            return ensure_spotify_device_usable(device.clone());
        }
        if configured_name.is_none() {
            return Err(SpotifyDeviceResolveError::Unavailable(format!(
                "Spotify Connect device ID '{}' is unavailable",
                configured_id
            )));
        }
    }

    let configured_name = configured_name.unwrap_or_default();
    let mut matches = candidates
        .into_iter()
        .filter(|device| device.name.eq_ignore_ascii_case(configured_name));
    let first = matches.next().ok_or_else(|| {
        SpotifyDeviceResolveError::Unavailable(format!(
            "Spotify Connect device '{}' is unavailable",
            configured_name
        ))
    })?;
    if matches.next().is_some() {
        return Err(SpotifyDeviceResolveError::Other(
            StatusCode::CONFLICT,
            format!(
                "More than one Spotify device is named '{}'; configure SPOTIFY_DEVICE_ID",
                configured_name
            ),
        ));
    }
    ensure_spotify_device_usable(first)
}

fn ensure_spotify_device_usable(
    device: SpotifyDevice,
) -> Result<SpotifyDevice, SpotifyDeviceResolveError> {
    if device.is_restricted {
        return Err(SpotifyDeviceResolveError::Other(
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "Spotify Connect device '{}' is present but restricted; Echo did not restart Spotify",
                device.name
            ),
        ));
    }
    Ok(device)
}

async fn resolve_spotify_device(state: &AppState) -> Result<SpotifyDevice, (StatusCode, String)> {
    let deadline = tokio::time::Instant::now() + SPOTIFY_CONNECT_REPAIR_DEADLINE;
    resolve_spotify_device_with_repair(
        || async {
            let source = state.jam_source.snapshot().await;
            jam_source_start_preflight(&source)
                .map_err(|(status, message)| SpotifyDeviceResolveError::Other(status, message))?;
            resolve_spotify_device_once(state).await
        },
        |action| state.jam_source.repair_spotify_connect(action, deadline),
        SPOTIFY_CONNECT_REGISTRATION_POLL_ATTEMPTS,
        SPOTIFY_CONNECT_REGISTRATION_POLL_INTERVAL,
        Some(deadline),
    )
    .await
    .map_err(SpotifyDeviceResolveError::into_response)
}

async fn resolve_spotify_device_once(
    state: &AppState,
) -> Result<SpotifyDevice, SpotifyDeviceResolveError> {
    if state.config.spotify_device_id.is_none() && state.config.spotify_device_name.is_none() {
        return Err(SpotifyDeviceResolveError::Other(
            StatusCode::SERVICE_UNAVAILABLE,
            "Spotify Connect device is not configured (set SPOTIFY_DEVICE_ID or SPOTIFY_DEVICE_NAME)"
                .to_string(),
        ));
    }
    let response = spotify_api_request(
        state,
        reqwest::Method::GET,
        "https://api.spotify.com/v1/me/player/devices",
        None,
    )
    .await
    .map_err(|(status, message)| SpotifyDeviceResolveError::Other(status, message))?;
    if !response.status().is_success() {
        let (status, message) = spotify_response_error(response, "List Spotify devices").await;
        return Err(SpotifyDeviceResolveError::Other(status, message));
    }
    let data: serde_json::Value = response.json().await.map_err(|error| {
        SpotifyDeviceResolveError::Other(
            StatusCode::BAD_GATEWAY,
            format!("Spotify devices response was invalid: {}", error),
        )
    })?;
    let candidates = parse_spotify_devices(&data)?;

    select_spotify_device(
        candidates,
        state.config.spotify_device_id.as_deref(),
        state.config.spotify_device_name.as_deref(),
    )
}

fn parse_spotify_devices(
    data: &serde_json::Value,
) -> Result<Vec<SpotifyDevice>, SpotifyDeviceResolveError> {
    let devices = data
        .get("devices")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            SpotifyDeviceResolveError::Other(
                StatusCode::BAD_GATEWAY,
                "Spotify devices response was invalid: 'devices' was not an array".to_string(),
            )
        })?;
    let mut candidates = Vec::with_capacity(devices.len());
    for device in devices {
        let Some(id_value) = device.get("id") else {
            return Err(SpotifyDeviceResolveError::Other(
                StatusCode::BAD_GATEWAY,
                "Spotify devices response contained an invalid device entry".to_string(),
            ));
        };
        // Spotify documents DeviceObject.id as nullable. Such entries cannot
        // be targeted and must not poison an otherwise valid configured match.
        if id_value.is_null() {
            continue;
        }
        let id = id_value.as_str().ok_or_else(|| {
            SpotifyDeviceResolveError::Other(
                StatusCode::BAD_GATEWAY,
                "Spotify devices response contained a non-string device ID".to_string(),
            )
        })?;
        let name = device
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                SpotifyDeviceResolveError::Other(
                    StatusCode::BAD_GATEWAY,
                    "Spotify devices response contained an invalid device name".to_string(),
                )
            })?;
        let is_restricted = device
            .get("is_restricted")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| {
                SpotifyDeviceResolveError::Other(
                    StatusCode::BAD_GATEWAY,
                    "Spotify devices response contained an invalid restriction state".to_string(),
                )
            })?;
        let id = id.trim();
        let name = name.trim();
        if id.is_empty() || name.is_empty() {
            return Err(SpotifyDeviceResolveError::Other(
                StatusCode::BAD_GATEWAY,
                "Spotify devices response contained an empty device ID or name".to_string(),
            ));
        }
        candidates.push(SpotifyDevice {
            id: id.to_string(),
            name: name.to_string(),
            is_restricted,
        });
    }

    Ok(candidates)
}

async fn resolve_spotify_device_with_repair<Resolve, ResolveFuture, Repair, RepairFuture>(
    mut resolve: Resolve,
    mut repair: Repair,
    poll_attempts: usize,
    poll_interval: Duration,
    deadline: Option<tokio::time::Instant>,
) -> Result<SpotifyDevice, SpotifyDeviceResolveError>
where
    Resolve: FnMut() -> ResolveFuture,
    ResolveFuture: Future<Output = Result<SpotifyDevice, SpotifyDeviceResolveError>>,
    Repair: FnMut(crate::jam_source::SpotifyConnectRepairAction) -> RepairFuture,
    RepairFuture: Future<Output = Result<crate::jam_source::SpotifyConnectRepairResult, String>>,
{
    let unavailable = match await_spotify_deadline(deadline, resolve()).await? {
        Ok(device) => return Ok(device),
        Err(SpotifyDeviceResolveError::Unavailable(message)) => message,
        Err(error) => return Err(error),
    };

    let activated = repair(crate::jam_source::SpotifyConnectRepairAction::Activate)
        .await
        .map_err(|error| {
            SpotifyDeviceResolveError::Other(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("{unavailable}. Echo could not activate Spotify on the source PC: {error}"),
            )
        })?;
    if let Some(device) =
        poll_spotify_connect_registration(&mut resolve, poll_attempts, poll_interval, deadline)
            .await?
    {
        return Ok(device);
    }

    if activated.was_running_before {
        repair(crate::jam_source::SpotifyConnectRepairAction::Restart)
            .await
            .map_err(|error| {
                SpotifyDeviceResolveError::Other(
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!(
                        "{unavailable}. Echo could not restart Spotify on the source PC: {error}"
                    ),
                )
            })?;
        if let Some(device) =
            poll_spotify_connect_registration(&mut resolve, poll_attempts, poll_interval, deadline)
                .await?
        {
            return Ok(device);
        }
    }

    Err(SpotifyDeviceResolveError::Unavailable(format!(
        "{unavailable} after Echo tried to re-register Spotify on the source PC"
    )))
}

async fn poll_spotify_connect_registration<Resolve, ResolveFuture>(
    resolve: &mut Resolve,
    attempts: usize,
    interval: Duration,
    deadline: Option<tokio::time::Instant>,
) -> Result<Option<SpotifyDevice>, SpotifyDeviceResolveError>
where
    Resolve: FnMut() -> ResolveFuture,
    ResolveFuture: Future<Output = Result<SpotifyDevice, SpotifyDeviceResolveError>>,
{
    for attempt in 0..attempts {
        match await_spotify_deadline(deadline, resolve()).await? {
            Ok(device) => return Ok(Some(device)),
            Err(SpotifyDeviceResolveError::Unavailable(_)) => {}
            Err(error) => return Err(error),
        }
        if attempt + 1 < attempts && !interval.is_zero() {
            await_spotify_deadline(deadline, tokio::time::sleep(interval)).await?;
        }
    }
    Ok(None)
}

async fn await_spotify_deadline<T, F>(
    deadline: Option<tokio::time::Instant>,
    future: F,
) -> Result<T, SpotifyDeviceResolveError>
where
    F: Future<Output = T>,
{
    match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, future)
            .await
            .map_err(|_| {
                SpotifyDeviceResolveError::Other(
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!(
                        "Spotify Connect device recovery exceeded the {} second start deadline",
                        SPOTIFY_CONNECT_REPAIR_DEADLINE.as_secs()
                    ),
                )
            }),
        None => Ok(future.await),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SpotifyBoundPlayback {
    is_playing: bool,
    current_uri: Option<String>,
}

async fn bind_spotify_playback_to_device(
    state: &AppState,
    device: &SpotifyDevice,
) -> Result<SpotifyBoundPlayback, (StatusCode, String)> {
    let response = spotify_api_request(
        state,
        reqwest::Method::GET,
        "https://api.spotify.com/v1/me/player",
        None,
    )
    .await?;
    let playback = if response.status() == reqwest::StatusCode::NO_CONTENT {
        SpotifyBoundPlayback {
            is_playing: false,
            current_uri: None,
        }
    } else if response.status().is_success() {
        let playback: serde_json::Value = response.json().await.map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Spotify playback response was invalid: {}", error),
            )
        })?;
        let bound_playback = SpotifyBoundPlayback {
            is_playing: playback["is_playing"].as_bool().unwrap_or(false),
            current_uri: playback["item"]["uri"]
                .as_str()
                .filter(|uri| !uri.trim().is_empty())
                .map(str::to_string),
        };
        if playback["device"]["id"].as_str() == Some(device.id.as_str()) {
            return Ok(bound_playback);
        }
        bound_playback
    } else {
        return Err(spotify_response_error(response, "Read Spotify playback").await);
    };
    let response = spotify_api_request(
        state,
        reqwest::Method::PUT,
        "https://api.spotify.com/v1/me/player",
        Some(serde_json::json!({
            "device_ids": [device.id],
            "play": playback.is_playing,
        })),
    )
    .await?;
    if !response.status().is_success() {
        return Err(spotify_response_error(response, "Transfer Spotify playback").await);
    }
    Ok(playback)
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
    let message = spotify_upstream_message(&body);
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
    jam.queue_revision = jam.queue_revision.wrapping_add(1);
    jam.track_queue_receipts.clear();
    jam.playlist_queue_receipts.clear();
    jam.queue_removal_receipts.clear();
    jam.last_history_spotify_id = None;
    jam.last_history_was_echo = false;
    jam.listeners.clear();
    jam.audio_connections.clear();
    jam.now_playing = None;
    jam.spotify_device_id = None;
    jam.spotify_device_name = None;
    jam.spotify_is_playing = false;
    jam.queue_control_epoch = jam.queue_control_epoch.wrapping_add(1);
    jam.queue_control_stopped = false;
    jam.uncertain_skip = None;
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
        is_restricted: false,
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
        Ok(playback) => playback.is_playing,
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
            pause_and_mark_spotify_safety_stop(state, generation, device, &safety_error.1).await;
            Err(safety_error)
        }
        Ok(operation_result) => match ensure_jam_recovery_controls_ready(state).await {
            Ok(current_generation) if current_generation == generation => operation_result,
            Ok(_) => {
                let message = "Jam generation changed during Spotify control".to_string();
                pause_and_mark_spotify_safety_stop(state, generation, device, &message).await;
                Err((StatusCode::CONFLICT, message))
            }
            Err(error) => {
                pause_and_mark_spotify_safety_stop(state, generation, device, &error.1).await;
                Err(error)
            }
        },
    }
}

async fn pause_and_mark_spotify_safety_stop(
    state: &AppState,
    generation: u64,
    device: &SpotifyDevice,
    error: &str,
) {
    pause_bound_spotify_before_release(state, generation, Some(device)).await;
    let mut jam = state
        .jam
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if apply_spotify_pause_result(&mut jam, generation, device) {
        jam.last_error = Some(error.to_string());
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
    jam.queue_stop_epoch = jam.queue_stop_epoch.wrapping_add(1);
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

fn reconcile_queue_to_current(
    queue: &mut Vec<JamQueueEntry>,
    current_uri: &str,
) -> Vec<QueuedTrack> {
    if current_uri.is_empty() {
        return Vec::new();
    }
    let Some(target_index) = queue.iter().position(|entry| {
        entry.track.spotify_uri == current_uri
            && entry.delivery_state == QueueDeliveryState::SpotifyCommitted
            && entry.current_match_state == QueueCurrentMatchState::Eligible
    }) else {
        return Vec::new();
    };
    if queue[..target_index]
        .iter()
        .any(|entry| entry.delivery_state == QueueDeliveryState::CommitUnknown)
    {
        return Vec::new();
    }
    let mut removed = Vec::new();
    while queue
        .first()
        .map(|entry| entry.track.spotify_uri.as_str() != current_uri)
        .unwrap_or(false)
    {
        removed.push(queue.remove(0).track);
    }
    removed
}

fn committed_queue_track_matching_current(
    queue: &[JamQueueEntry],
    current_uri: &str,
) -> Option<QueuedTrack> {
    queue
        .first()
        .filter(|entry| {
            entry.track.spotify_uri == current_uri
                && entry.delivery_state == QueueDeliveryState::SpotifyCommitted
                && entry.current_match_state == QueueCurrentMatchState::Eligible
        })
        .map(|entry| entry.track.clone())
}

fn observe_queue_current_transition(
    queue: &mut [JamQueueEntry],
    current_uri: &str,
    repeated_occurrence: bool,
) -> bool {
    let mut changed = false;
    for entry in queue.iter_mut().filter(|entry| {
        entry.delivery_state == QueueDeliveryState::SpotifyCommitted
            && entry.current_match_state == QueueCurrentMatchState::AwaitingTransition
            && entry.track.spotify_uri != current_uri
    }) {
        entry.current_match_state = QueueCurrentMatchState::Eligible;
        changed = true;
    }
    let matching_transition = queue.iter().enumerate().find_map(|(index, entry)| {
        (entry.delivery_state == QueueDeliveryState::SpotifyCommitted
            && entry.current_match_state == QueueCurrentMatchState::AwaitingTransition
            && entry.track.spotify_uri == current_uri
            && queue[..index].iter().any(|earlier| {
                earlier.delivery_state.occupies_spotify_frontier()
                    && earlier.track.spotify_uri != current_uri
            }))
        .then_some(index)
    });
    let unlocked_matching_transition = if let Some(index) = matching_transition {
        queue[index].current_match_state = QueueCurrentMatchState::Eligible;
        changed = true;
        true
    } else {
        false
    };
    if repeated_occurrence && !unlocked_matching_transition {
        if let Some(entry) = queue.iter_mut().find(|entry| {
            entry.delivery_state == QueueDeliveryState::SpotifyCommitted
                && entry.current_match_state == QueueCurrentMatchState::AwaitingTransition
                && entry.track.spotify_uri == current_uri
        }) {
            // One observed restart proves exactly one same-URI queue boundary.
            // Leave later identical occurrences blocked for their own boundary.
            entry.current_match_state = QueueCurrentMatchState::Eligible;
            changed = true;
        }
    }
    changed
}

fn same_track_occurrence_restarted(
    previous: Option<&NowPlayingInfo>,
    current: &NowPlayingInfo,
) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    if !previous.is_playing
        || !current.is_playing
        || current.spotify_uri.is_empty()
        || previous.spotify_uri != current.spotify_uri
        || previous.duration_ms == 0
        || current.duration_ms != previous.duration_ms
    {
        return false;
    }
    let edge_window_ms = (previous.duration_ms / 10).clamp(2_000, 15_000);
    previous.progress_ms.saturating_add(edge_window_ms) >= previous.duration_ms
        && current.progress_ms <= edge_window_ms
        && current.progress_ms.saturating_add(edge_window_ms) < previous.progress_ms
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SpotifyQueueObservation {
    current_uri: String,
    next_uri: Option<String>,
}

fn repeated_occurrence_advance_confirmed(
    previous: Option<&NowPlayingInfo>,
    current: &NowPlayingInfo,
    repeat_state: &str,
    queue_observation: Option<&SpotifyQueueObservation>,
) -> bool {
    let Some(queue_observation) = queue_observation else {
        return false;
    };
    matches!(repeat_state, "off" | "context")
        && queue_observation.current_uri == current.spotify_uri
        && queue_observation.next_uri.as_deref() != Some(current.spotify_uri.as_str())
        && same_track_occurrence_restarted(previous, current)
}

async fn spotify_queue_observation_strict(
    state: &AppState,
) -> Result<SpotifyQueueObservation, (StatusCode, String)> {
    let response = spotify_api_request(
        state,
        reqwest::Method::GET,
        "https://api.spotify.com/v1/me/player/queue",
        None,
    )
    .await?;
    if !response.status().is_success() {
        return Err(spotify_response_error(response, "Read Spotify queue").await);
    }
    let data = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Spotify queue response was invalid: {error}"),
            )
        })?;
    let current_uri = data
        .get("currently_playing")
        .and_then(|current| current.get("uri"))
        .and_then(serde_json::Value::as_str)
        .filter(|uri| !uri.trim().is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "Spotify queue response did not identify the current track".to_string(),
            )
        })?
        .to_string();
    let queue = data
        .get("queue")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "Spotify queue response did not contain a queue array".to_string(),
            )
        })?;
    let Some(first) = queue.first() else {
        return Ok(SpotifyQueueObservation {
            current_uri,
            next_uri: None,
        });
    };
    let uri = first
        .get("uri")
        .and_then(serde_json::Value::as_str)
        .filter(|uri| !uri.trim().is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "Spotify queue response did not identify its next track".to_string(),
            )
        })?;
    Ok(SpotifyQueueObservation {
        current_uri,
        next_uri: Some(uri.to_string()),
    })
}

async fn spotify_queue_observation(state: &AppState) -> Option<SpotifyQueueObservation> {
    spotify_queue_observation_strict(state).await.ok()
}

fn advance_repeated_committed_occurrence(
    queue: &mut Vec<JamQueueEntry>,
    current_uri: &str,
) -> Option<QueuedTrack> {
    let front = queue.first()?;
    if front.track.spotify_uri != current_uri
        || front.delivery_state != QueueDeliveryState::SpotifyCommitted
        || front.current_match_state != QueueCurrentMatchState::Eligible
    {
        return None;
    }
    Some(queue.remove(0).track)
}

fn retire_skipped_queue_frontier(
    queue: &mut Vec<JamQueueEntry>,
    current_uri: Option<&str>,
) -> Option<QueuedTrack> {
    let current_uri = current_uri.filter(|uri| !uri.trim().is_empty())?;
    let front = queue.first()?;
    if front.track.spotify_uri != current_uri
        || front.delivery_state != QueueDeliveryState::SpotifyCommitted
        || front.current_match_state != QueueCurrentMatchState::Eligible
    {
        return None;
    }
    Some(queue.remove(0).track)
}

#[derive(Debug, Default)]
struct SuccessfulSkipQueueTransition {
    removed_before_current: Vec<QueuedTrack>,
    removed: Option<QueuedTrack>,
    unlocked_successor: bool,
    pre_skip_changed: bool,
}

impl SuccessfulSkipQueueTransition {
    fn changed(&self) -> bool {
        self.pre_skip_changed || self.removed.is_some() || self.unlocked_successor
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum PreSkipSameUriResolution {
    #[default]
    NotNeeded,
    AwaitingStillNext,
    AwaitingIsCurrent,
}

#[derive(Clone, Debug)]
pub(crate) struct UncertainSkipBoundary {
    pre_skip_current_uri: String,
    previous_uri: Option<String>,
    same_uri_resolution: PreSkipSameUriResolution,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UncertainSkipObservationResult {
    Accepted,
    Rejected,
    Pending,
}

impl UncertainSkipBoundary {
    fn queue_observation_required(&self, current_uri: &str) -> bool {
        current_uri == self.pre_skip_current_uri
            && self.same_uri_resolution == PreSkipSameUriResolution::AwaitingStillNext
    }

    fn resolve_observation(
        &self,
        current_uri: Option<&str>,
        queue_observation: Option<&SpotifyQueueObservation>,
    ) -> UncertainSkipObservationResult {
        let Some(current_uri) = current_uri.filter(|uri| !uri.trim().is_empty()) else {
            // Player 204 is not proof that /next was accepted: the device or
            // session may have disappeared after the ambiguous transport
            // result. Preserve the fence until a bound-device item is seen.
            return UncertainSkipObservationResult::Pending;
        };
        if current_uri != self.pre_skip_current_uri {
            return UncertainSkipObservationResult::Accepted;
        }
        if !self.queue_observation_required(current_uri) {
            return UncertainSkipObservationResult::Rejected;
        }
        let Some(queue_observation) = queue_observation
            .filter(|observation| observation.current_uri == self.pre_skip_current_uri)
        else {
            return UncertainSkipObservationResult::Pending;
        };
        if queue_observation.next_uri.as_deref() == Some(self.pre_skip_current_uri.as_str()) {
            UncertainSkipObservationResult::Rejected
        } else {
            UncertainSkipObservationResult::Accepted
        }
    }
}

fn same_uri_skip_observation_required(
    queue: &[JamQueueEntry],
    current_uri: Option<&str>,
    previous_uri: Option<&str>,
) -> bool {
    let Some(current_uri) = current_uri.filter(|uri| !uri.trim().is_empty()) else {
        return false;
    };
    let Some(awaiting_index) = queue.iter().position(|entry| {
        entry.track.spotify_uri == current_uri
            && entry.delivery_state.occupies_spotify_frontier()
            && entry.current_match_state == QueueCurrentMatchState::AwaitingTransition
    }) else {
        return false;
    };
    let earlier_frontier = queue[..awaiting_index]
        .iter()
        .filter(|entry| entry.delivery_state.occupies_spotify_frontier())
        .collect::<Vec<_>>();
    if earlier_frontier
        .iter()
        .any(|entry| entry.track.spotify_uri == current_uri)
    {
        // [A eligible, A awaiting] cannot identify the current occurrence from
        // the player URI alone. Spotify's next item is the discriminator.
        return true;
    }
    if !earlier_frontier.is_empty() {
        // A different Echo predecessor proves that the matching awaiting entry
        // is the occurrence Spotify advanced to between Echo observations.
        return false;
    }
    // When the first Echo occurrence is still awaiting behind an external
    // track with the same URI, the URI alone cannot distinguish them. A prior
    // different bound-device observation proves the transition; otherwise the
    // Spotify queue must show whether Echo's occurrence is still next.
    previous_uri
        .filter(|uri| !uri.trim().is_empty())
        .is_none_or(|previous_uri| previous_uri == current_uri)
}

fn resolve_same_uri_skip_observation(
    queue: &[JamQueueEntry],
    observation: &SpotifyQueueObservation,
    current_uri: &str,
    previous_uri: Option<&str>,
) -> Result<PreSkipSameUriResolution, SameUriSkipObservationError> {
    if observation.current_uri != current_uri {
        return Err(SameUriSkipObservationError::PlaybackChanged);
    }
    let resolution = if observation.next_uri.as_deref() == Some(current_uri) {
        PreSkipSameUriResolution::AwaitingStillNext
    } else {
        PreSkipSameUriResolution::AwaitingIsCurrent
    };
    reject_commit_unknown_pre_skip_target(queue, current_uri, previous_uri, resolution)?;
    Ok(resolution)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SameUriSkipObservationError {
    PlaybackChanged,
    CommitUnknown,
}

fn authoritative_pre_skip_target_index(
    queue: &[JamQueueEntry],
    current_uri: &str,
    previous_uri: Option<&str>,
    resolution: PreSkipSameUriResolution,
) -> Option<usize> {
    let matching = |entry: &JamQueueEntry| {
        entry.track.spotify_uri == current_uri && entry.delivery_state.occupies_spotify_frontier()
    };
    match resolution {
        PreSkipSameUriResolution::AwaitingStillNext => queue.iter().position(|entry| {
            matching(entry) && entry.current_match_state == QueueCurrentMatchState::Eligible
        }),
        PreSkipSameUriResolution::AwaitingIsCurrent => queue.iter().rposition(|entry| {
            matching(entry)
                && entry.current_match_state == QueueCurrentMatchState::AwaitingTransition
        }),
        PreSkipSameUriResolution::NotNeeded => {
            let awaiting_current = queue.iter().enumerate().find_map(|(index, entry)| {
                if !matching(entry)
                    || entry.current_match_state != QueueCurrentMatchState::AwaitingTransition
                {
                    return None;
                }
                let earlier_frontier = queue[..index]
                    .iter()
                    .filter(|earlier| earlier.delivery_state.occupies_spotify_frontier())
                    .collect::<Vec<_>>();
                let preceded_by_different_echo = !earlier_frontier.is_empty()
                    && earlier_frontier
                        .iter()
                        .all(|earlier| earlier.track.spotify_uri != current_uri);
                let preceded_by_different_observation = earlier_frontier.is_empty()
                    && previous_uri
                        .filter(|uri| !uri.trim().is_empty())
                        .is_some_and(|previous_uri| previous_uri != current_uri);
                (preceded_by_different_echo || preceded_by_different_observation).then_some(index)
            });
            awaiting_current.or_else(|| {
                queue.iter().position(|entry| {
                    matching(entry) && entry.current_match_state == QueueCurrentMatchState::Eligible
                })
            })
        }
    }
}

fn reject_commit_unknown_pre_skip_target(
    queue: &[JamQueueEntry],
    current_uri: &str,
    previous_uri: Option<&str>,
    resolution: PreSkipSameUriResolution,
) -> Result<(), SameUriSkipObservationError> {
    if authoritative_pre_skip_target_index(queue, current_uri, previous_uri, resolution)
        .is_some_and(|index| {
            queue[..=index]
                .iter()
                .any(|entry| entry.delivery_state == QueueDeliveryState::CommitUnknown)
        })
    {
        Err(SameUriSkipObservationError::CommitUnknown)
    } else {
        Ok(())
    }
}

#[derive(Debug, Default)]
struct PreSkipQueueReconciliation {
    removed_before_current: Vec<QueuedTrack>,
    changed: bool,
}

fn reconcile_authoritative_pre_skip_current(
    queue: &mut Vec<JamQueueEntry>,
    current_uri: Option<&str>,
    previous_uri: Option<&str>,
    same_uri_resolution: PreSkipSameUriResolution,
) -> PreSkipQueueReconciliation {
    let Some(current_uri) = current_uri.filter(|uri| !uri.trim().is_empty()) else {
        return PreSkipQueueReconciliation::default();
    };
    let target_index =
        authoritative_pre_skip_target_index(queue, current_uri, previous_uri, same_uri_resolution);
    let Some(target_index) = target_index else {
        return PreSkipQueueReconciliation::default();
    };
    if queue[..=target_index]
        .iter()
        .any(|entry| entry.delivery_state == QueueDeliveryState::CommitUnknown)
    {
        return PreSkipQueueReconciliation::default();
    }

    let mut changed = false;
    if queue[target_index].current_match_state == QueueCurrentMatchState::AwaitingTransition {
        queue[target_index].current_match_state = QueueCurrentMatchState::Eligible;
        changed = true;
    }
    let removed_before_current = queue
        .drain(..target_index)
        .map(|entry| entry.track)
        .collect::<Vec<_>>();
    changed |= !removed_before_current.is_empty();
    PreSkipQueueReconciliation {
        removed_before_current,
        changed,
    }
}

fn authoritative_pre_skip_echo_track(
    queue: &[JamQueueEntry],
    current_uri: Option<&str>,
    previous_uri: Option<&str>,
    same_uri_resolution: PreSkipSameUriResolution,
) -> Option<QueuedTrack> {
    let current_uri = current_uri.filter(|uri| !uri.trim().is_empty())?;
    reject_commit_unknown_pre_skip_target(queue, current_uri, previous_uri, same_uri_resolution)
        .ok()?;
    let mut aligned = queue.to_vec();
    reconcile_authoritative_pre_skip_current(
        &mut aligned,
        Some(current_uri),
        previous_uri,
        same_uri_resolution,
    );
    committed_queue_track_matching_current(&aligned, current_uri)
}

fn apply_successful_skip_to_queue(
    queue: &mut Vec<JamQueueEntry>,
    current_uri: Option<&str>,
    previous_uri: Option<&str>,
    same_uri_resolution: PreSkipSameUriResolution,
) -> SuccessfulSkipQueueTransition {
    if let Some(current_uri) = current_uri.filter(|uri| !uri.trim().is_empty()) {
        if reject_commit_unknown_pre_skip_target(
            queue,
            current_uri,
            previous_uri,
            same_uri_resolution,
        )
        .is_err()
        {
            return SuccessfulSkipQueueTransition::default();
        }
    }
    let reconciliation = reconcile_authoritative_pre_skip_current(
        queue,
        current_uri,
        previous_uri,
        same_uri_resolution,
    );
    let removed = retire_skipped_queue_frontier(queue, current_uri);
    let unlocked_successor = queue.first_mut().is_some_and(|successor| {
        if successor.delivery_state == QueueDeliveryState::SpotifyCommitted
            && successor.current_match_state == QueueCurrentMatchState::AwaitingTransition
        {
            // A successful Spotify /next proves exactly one queued-next
            // occurrence boundary for an accepted Spotify entry. An ambiguous
            // entry remains locked for the rest of the Jam generation.
            successor.current_match_state = QueueCurrentMatchState::Eligible;
            true
        } else {
            false
        }
    });
    SuccessfulSkipQueueTransition {
        removed_before_current: reconciliation.removed_before_current,
        removed,
        unlocked_successor,
        pre_skip_changed: reconciliation.changed,
    }
}

fn reconcile_uncertain_skip_boundary(
    jam: &mut JamState,
    observed_current_uri: Option<&str>,
    queue_observation: Option<&SpotifyQueueObservation>,
) -> Option<UncertainSkipObservationResult> {
    let boundary = jam.uncertain_skip.clone()?;
    let result = boundary.resolve_observation(observed_current_uri, queue_observation);
    let changed = match result {
        UncertainSkipObservationResult::Accepted => apply_successful_skip_to_queue(
            &mut jam.queue,
            Some(&boundary.pre_skip_current_uri),
            boundary.previous_uri.as_deref(),
            boundary.same_uri_resolution,
        )
        .changed(),
        UncertainSkipObservationResult::Rejected => {
            reconcile_authoritative_pre_skip_current(
                &mut jam.queue,
                Some(&boundary.pre_skip_current_uri),
                boundary.previous_uri.as_deref(),
                boundary.same_uri_resolution,
            )
            .changed
        }
        UncertainSkipObservationResult::Pending => return Some(result),
    };
    if changed {
        jam.queue_revision = jam.queue_revision.wrapping_add(1);
    }
    jam.uncertain_skip = None;
    Some(result)
}

fn uncertain_skip_blocks_ordinary_queue_update(
    result: Option<UncertainSkipObservationResult>,
) -> bool {
    result.is_some()
}

#[derive(Debug, Default)]
struct NoContentQueueReconciliation {
    uncertain_skip: Option<UncertainSkipObservationResult>,
    naturally_finished: Option<QueuedTrack>,
}

fn reconcile_queue_after_no_content(jam: &mut JamState) -> NoContentQueueReconciliation {
    let uncertain_skip = reconcile_uncertain_skip_boundary(jam, None, None);
    if uncertain_skip.is_some() {
        return NoContentQueueReconciliation {
            uncertain_skip,
            naturally_finished: None,
        };
    }
    let finished_uri = jam.now_playing.as_ref().and_then(|now_playing| {
        let elapsed = now_playing.fetched_at.map(|at| at.elapsed())?;
        prior_playback_finished_before_no_content(now_playing, elapsed)
            .then(|| now_playing.spotify_uri.clone())
    });
    let naturally_finished = finished_uri
        .as_deref()
        .and_then(|uri| retire_finished_queue_frontier(&mut jam.queue, uri));
    if naturally_finished.is_some() {
        jam.queue_revision = jam.queue_revision.wrapping_add(1);
    }
    NoContentQueueReconciliation {
        uncertain_skip: None,
        naturally_finished,
    }
}

fn stopped_playback_reached_track_end(now_playing: &NowPlayingInfo) -> bool {
    !now_playing.is_playing
        && now_playing.duration_ms > 0
        && now_playing.progress_ms >= now_playing.duration_ms
}

fn prior_playback_finished_before_no_content(
    now_playing: &NowPlayingInfo,
    elapsed: Duration,
) -> bool {
    now_playing.is_playing
        && now_playing.duration_ms > 0
        && now_playing
            .progress_ms
            .saturating_add(elapsed.as_millis().min(u64::MAX as u128) as u64)
            >= now_playing.duration_ms
}

fn prior_playback_corroborates_track_end(previous: &NowPlayingInfo, current_uri: &str) -> bool {
    previous.spotify_uri == current_uri
        && previous
            .fetched_at
            .is_some_and(|at| prior_playback_finished_before_no_content(previous, at.elapsed()))
}

fn retire_finished_queue_frontier(
    queue: &mut Vec<JamQueueEntry>,
    current_uri: &str,
) -> Option<QueuedTrack> {
    let front = queue.first()?;
    if current_uri.is_empty()
        || front.track.spotify_uri != current_uri
        || front.delivery_state != QueueDeliveryState::SpotifyCommitted
        || front.current_match_state != QueueCurrentMatchState::Eligible
    {
        return None;
    }
    Some(queue.remove(0).track)
}

fn mark_observed_queue_stopped(jam: &mut JamState) -> bool {
    if jam.queue_control_stopped
        || !jam
            .queue
            .iter()
            .any(|entry| entry.delivery_state.occupies_spotify_frontier())
    {
        return false;
    }
    jam.queue_control_epoch = jam.queue_control_epoch.wrapping_add(1);
    jam.queue_stop_epoch = jam.queue_stop_epoch.wrapping_add(1);
    jam.queue_control_stopped = true;
    true
}

fn retire_stale_frontier_for_queue_placement(
    jam: &mut JamState,
    observation: &SpotifyPlacementObservation,
) -> Option<QueuedTrack> {
    // An intentional Stop or safety stop is an explicit fence. A queue add may
    // resume that preserved frontier, but it must never reinterpret it as a
    // naturally completed occurrence and delete its provenance.
    if jam.queue_control_stopped {
        return None;
    }
    let finished_uri = if observation.bound_playback_stopped_at_end() {
        observation.current_uri.as_ref().and_then(|current_uri| {
            jam.now_playing
                .as_ref()
                .filter(|previous| prior_playback_corroborates_track_end(previous, current_uri))
                .map(|_| current_uri.clone())
        })
    } else if !observation.playback_present {
        jam.now_playing.as_ref().and_then(|now_playing| {
            let elapsed = now_playing.fetched_at.map(|at| at.elapsed())?;
            prior_playback_finished_before_no_content(now_playing, elapsed)
                .then(|| now_playing.spotify_uri.clone())
        })
    } else {
        None
    }?;
    let removed = retire_finished_queue_frontier(&mut jam.queue, &finished_uri)?;
    jam.queue_revision = jam.queue_revision.wrapping_add(1);
    jam.now_playing = None;
    Some(removed)
}

async fn persist_jam_history_observation(
    state: &AppState,
    observation_generation: u64,
    observation: HistoryObservation,
) {
    if let Some(track) = observation.queued_track {
        let history = std::sync::Arc::clone(&state.jam_history);
        let jam_state = std::sync::Arc::clone(&state.jam);
        let observed_spotify_id = observation.spotify_id;
        let observed_echo_run = observation.echo_run;
        let played_at_ms = now_ts_ms();
        match tokio::task::spawn_blocking(move || {
            let entry = history.append_observation(&track, played_at_ms)?;
            let mut jam = jam_state.lock().unwrap_or_else(|error| error.into_inner());
            if active_generation_matches(&jam, observation_generation) {
                jam.last_history_spotify_id = Some(observed_spotify_id);
                jam.last_history_was_echo = observed_echo_run;
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
        // External Spotify playback and intentionally deduped same-song Echo
        // occurrences advance run provenance without appending.
        let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if active_generation_matches(&jam, observation_generation) {
            jam.last_history_spotify_id = Some(observation.spotify_id);
            jam.last_history_was_echo = observation.echo_run;
        }
    }
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
            let due = jam.uncertain_skip.is_some()
                || match &jam.now_playing {
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
                    let reconciliation = reconcile_queue_after_no_content(&mut jam);
                    if let Some(result) = reconciliation.uncertain_skip {
                        info!("Jam: reconciled uncertain Spotify Skip as {:?}", result);
                    }
                    if let Some(removed) = reconciliation.naturally_finished {
                        info!(
                            "Jam: retired naturally finished queue track '{}'",
                            removed.name
                        );
                    }
                    jam.spotify_is_playing = false;
                    jam.audio_expected_since = None;
                    jam.now_playing = None;
                    mark_observed_queue_stopped(&mut jam);
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
                    let repeat_state = data["repeat_state"].as_str().unwrap_or("").to_string();
                    let should_observe_next_queue = {
                        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
                        playback_fetch_matches(&jam, fetch_generation, &fetch_device_id)
                            && ((matches!(repeat_state.as_str(), "off" | "context")
                                && same_track_occurrence_restarted(jam.now_playing.as_ref(), &np))
                                || jam.uncertain_skip.as_ref().is_some_and(|boundary| {
                                    boundary.queue_observation_required(&current_uri)
                                }))
                    };
                    let queue_observation = if should_observe_next_queue {
                        spotify_queue_observation(&state).await
                    } else {
                        None
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
                        let repeated_occurrence = repeated_occurrence_advance_confirmed(
                            jam.now_playing.as_ref(),
                            &np,
                            &repeat_state,
                            queue_observation.as_ref(),
                        );
                        let uncertain_skip_result = reconcile_uncertain_skip_boundary(
                            &mut jam,
                            Some(&current_uri),
                            queue_observation.as_ref(),
                        );
                        let uncertain_skip_pending = matches!(
                            uncertain_skip_result,
                            Some(UncertainSkipObservationResult::Pending)
                        );
                        let uncertain_skip_observed =
                            uncertain_skip_blocks_ordinary_queue_update(uncertain_skip_result);
                        if let Some(result) = uncertain_skip_result {
                            info!("Jam: uncertain Spotify Skip observation is {:?}", result);
                        }
                        if uncertain_skip_observed && !uncertain_skip_pending {
                            jam.last_error = None;
                        }
                        jam.spotify_is_playing = np.is_playing;
                        if np.is_playing {
                            jam.audio_expected_since
                                .get_or_insert_with(std::time::Instant::now);
                            if !uncertain_skip_pending {
                                jam.last_error = None;
                            }
                        } else {
                            jam.audio_expected_since = None;
                        }
                        // Only observed playback on the bound device can advance Echo's
                        // display queue. External items never drain queued Echo tracks.
                        if repeated_occurrence && !uncertain_skip_observed {
                            if let Some(removed) =
                                advance_repeated_committed_occurrence(&mut jam.queue, &current_uri)
                            {
                                jam.queue_revision = jam.queue_revision.wrapping_add(1);
                                info!("Jam: advanced repeated queue occurrence '{}'", removed.name);
                            }
                        }
                        if !uncertain_skip_observed
                            && observe_queue_current_transition(
                                &mut jam.queue,
                                &current_uri,
                                repeated_occurrence,
                            )
                        {
                            jam.queue_revision = jam.queue_revision.wrapping_add(1);
                        }
                        let removed_tracks = if uncertain_skip_observed {
                            Vec::new()
                        } else {
                            reconcile_queue_to_current(&mut jam.queue, &current_uri)
                        };
                        if !removed_tracks.is_empty() {
                            jam.queue_revision = jam.queue_revision.wrapping_add(1);
                        }
                        for removed in removed_tracks {
                            info!(
                                "Jam: auto-removed finished track '{}' from queue",
                                removed.name
                            );
                        }
                        let stopped_at_track_end = !uncertain_skip_observed
                            && stopped_playback_reached_track_end(&np)
                            && jam.now_playing.as_ref().is_some_and(|previous| {
                                prior_playback_corroborates_track_end(previous, &current_uri)
                            });
                        if stopped_at_track_end {
                            if let Some(removed) =
                                retire_finished_queue_frontier(&mut jam.queue, &current_uri)
                            {
                                jam.queue_revision = jam.queue_revision.wrapping_add(1);
                                info!(
                                    "Jam: retired naturally finished queue track '{}'",
                                    removed.name
                                );
                            }
                        }
                        if stopped_at_track_end {
                            mark_observed_queue_stopped(&mut jam);
                        }
                        let observed_spotify_id =
                            (!np.spotify_id.is_empty()).then_some(np.spotify_id.as_str());
                        let queued_track = (!uncertain_skip_pending)
                            .then(|| {
                                committed_queue_track_matching_current(&jam.queue, &current_uri)
                            })
                            .flatten();
                        history_observation = (!uncertain_skip_pending)
                            .then(|| {
                                new_history_observation(
                                    jam.last_history_spotify_id.as_deref(),
                                    jam.last_history_was_echo,
                                    observed_spotify_id,
                                    queued_track.as_ref(),
                                    np.is_playing,
                                    repeated_occurrence && !uncertain_skip_observed,
                                )
                            })
                            .flatten()
                            .map(|observation| (fetch_generation, observation));
                        jam.now_playing = Some(np);
                    }
                }
            }
        }
    }
    if let Some((observation_generation, observation)) = history_observation {
        persist_jam_history_observation(&state, observation_generation, observation).await;
    }
    drop(refresh_guard);

    let pump_generation = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        jam.active.then_some(jam.generation)
    };
    if let Some(pump_generation) = pump_generation {
        pump_queue_frontier(&state, pump_generation).await;
    }

    // Build response (extract all data from std::sync::Mutex before awaiting)
    let (
        active,
        starting,
        generation,
        host_identity,
        queue,
        queue_revision,
        history_revision,
        now_playing,
        listeners,
        spotify_connected,
        spotify_library_authorized,
        spotify_device_id,
        spotify_device_name,
        last_error,
        skip_reconciliation_pending,
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
            jam.queue_revision,
            state.jam_history.revision(),
            jam.now_playing.clone(),
            jam.listeners.keys().cloned().collect::<Vec<String>>(),
            jam.spotify_token.is_some(),
            spotify_library_scopes_authorized(jam.spotify_token.as_ref()),
            jam.spotify_device_id.clone(),
            jam.spotify_device_name.clone(),
            jam.last_error.clone(),
            jam.uncertain_skip.is_some(),
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
        "queue_revision": queue_revision,
        "history_revision": history_revision,
        "queue_removal_supported": true,
        "track_queue_request_id_supported": true,
        "now_playing": now_playing,
        "listeners": listeners,
        "listener_count": listener_count,
        "spotify_connected": spotify_connected,
        "spotify_library_authorized": spotify_library_authorized,
        "spotify_device_id": spotify_device_id,
        "spotify_device_name": spotify_device_name,
        "spotify_is_playing": spotify_is_playing,
        "playback_stop_supported": true,
        "playlist_selection_supported": true,
        "bot_connected": bot_connected,
        "last_error": last_error,
        "skip_reconciliation_pending": skip_reconciliation_pending,
        "jam_protocol_version": crate::jam_source::JAM_SOURCE_PROTOCOL_VERSION,
        "source_status": source_status,
        "source_error": source_error,
        "source_availability_known": source.availability_known,
        "source_enabled": source.enabled,
        "source_last_frame_ms": source.last_frame_ms,
        "source_peak": source.peak,
        "source_ready": source.ready,
        "spotify_connect_repair_supported": source.spotify_connect_repair_supported,
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

fn enqueue_admission_cancelled_by_stop(admitted_stop_epoch: u64, current_stop_epoch: u64) -> bool {
    current_stop_epoch != admitted_stop_epoch
}

fn queue_control_stopped_after_skip(spotify_was_playing: bool) -> bool {
    !spotify_was_playing
}

fn playlist_queue_request_id_valid(request_id: &str) -> bool {
    (8..=128).contains(&request_id.len())
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn playlist_queue_selection_fingerprint(
    payload: &PlaylistQueueRequest,
) -> Result<PlaylistQueueSelectionFingerprint, Response> {
    if payload
        .snapshot_id
        .as_deref()
        .is_some_and(|snapshot_id| snapshot_id.trim().is_empty() || snapshot_id.len() > 512)
    {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "invalid_snapshot_id",
            "snapshot_id must be 1-512 non-whitespace characters when supplied",
        ));
    }
    let selected_positions = payload
        .selected_positions
        .as_deref()
        .map(validate_selected_playlist_positions)
        .transpose()
        .map_err(JamApiError::into_response)?;
    if selected_positions.is_some() && payload.snapshot_id.is_none() {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "playlist_snapshot_required",
            "snapshot_id is required when queueing selected playlist positions",
        ));
    }
    Ok(PlaylistQueueSelectionFingerprint {
        selected_positions,
        snapshot_id: payload.snapshot_id.clone(),
    })
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
    playlist_position: Option<usize>,
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
        playlist_position,
        added_by: actor.display_name.clone(),
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct SpotifyPlacementObservation {
    playback_present: bool,
    bound_device: bool,
    is_playing: bool,
    current_uri: Option<String>,
    progress_ms: u64,
    duration_ms: u64,
}

impl SpotifyPlacementObservation {
    fn should_queue(&self) -> bool {
        self.playback_present && self.bound_device && self.is_playing
    }

    fn bound_playback_stopped_at_end(&self) -> bool {
        self.playback_present
            && self.bound_device
            && !self.is_playing
            && self.duration_ms > 0
            && self.progress_ms >= self.duration_ms
    }
}

async fn spotify_queue_placement_observation(
    state: &AppState,
    device: &SpotifyDevice,
) -> Result<SpotifyPlacementObservation, (StatusCode, String)> {
    let response = spotify_api_request(
        state,
        reqwest::Method::GET,
        "https://api.spotify.com/v1/me/player",
        None,
    )
    .await?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(SpotifyPlacementObservation::default());
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
    Ok(SpotifyPlacementObservation {
        playback_present: true,
        bound_device: playback["device"]["id"].as_str() == Some(device.id.as_str()),
        is_playing: playback["is_playing"].as_bool().unwrap_or(false),
        current_uri: playback["item"]["uri"]
            .as_str()
            .filter(|uri| !uri.trim().is_empty())
            .map(str::to_string),
        progress_ms: playback["progress_ms"].as_u64().unwrap_or(0),
        duration_ms: playback["item"]["duration_ms"].as_u64().unwrap_or(0),
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SpotifyTrackPlacement {
    StartedCurrent,
    QueuedNext,
}

impl SpotifyTrackPlacement {
    fn current_match_state(self) -> QueueCurrentMatchState {
        match self {
            Self::StartedCurrent => QueueCurrentMatchState::Eligible,
            Self::QueuedNext => QueueCurrentMatchState::AwaitingTransition,
        }
    }
}

fn spotify_track_placement(should_queue: bool) -> SpotifyTrackPlacement {
    if should_queue {
        SpotifyTrackPlacement::QueuedNext
    } else {
        SpotifyTrackPlacement::StartedCurrent
    }
}

async fn place_spotify_track(
    state: &AppState,
    device: &SpotifyDevice,
    spotify_uri: &str,
    placement: SpotifyTrackPlacement,
) -> Result<SpotifyTrackPlacement, QueueCommitError> {
    if placement == SpotifyTrackPlacement::QueuedNext {
        let queue_url = format!(
            "https://api.spotify.com/v1/me/player/queue?uri={}&device_id={}",
            urlencoded(spotify_uri),
            urlencoded(&device.id),
        );
        let response = spotify_api_request(state, reqwest::Method::POST, &queue_url, None)
            .await
            .map_err(|(status, message)| {
                queue_mutation_request_error(status, message, placement)
            })?;
        if !response.status().is_success() {
            return Err(spotify_queue_mutation_response_error(
                response,
                "Queue Spotify track",
                placement,
            )
            .await);
        }
        info!("Track queued on configured Spotify device: {spotify_uri}");
    } else {
        let play_url = format!(
            "https://api.spotify.com/v1/me/player/play?device_id={}",
            urlencoded(&device.id)
        );
        let play_body = serde_json::json!({ "uris": [spotify_uri] });
        let response = spotify_api_request(state, reqwest::Method::PUT, &play_url, Some(play_body))
            .await
            .map_err(|(status, message)| {
                queue_mutation_request_error(status, message, placement)
            })?;
        if !response.status().is_success() {
            return Err(spotify_queue_mutation_response_error(
                response,
                "Start Spotify track",
                placement,
            )
            .await);
        }
        info!("Track started on configured Spotify device: {spotify_uri}");
    }
    Ok(placement)
}

async fn resume_spotify_playback_on_device(
    state: &AppState,
    device: &SpotifyDevice,
) -> Result<(), (StatusCode, String)> {
    let play_url = format!(
        "https://api.spotify.com/v1/me/player/play?device_id={}",
        urlencoded(&device.id)
    );
    let response = spotify_api_request(state, reqwest::Method::PUT, &play_url, None).await?;
    if !response.status().is_success() {
        return Err(spotify_response_error(response, "Resume Spotify playback").await);
    }
    Ok(())
}

#[derive(Debug)]
struct QueueCommitError {
    status: StatusCode,
    message: String,
    acceptance_ambiguous: bool,
    intended_placement: Option<SpotifyTrackPlacement>,
}

fn definite_queue_commit_error(status: StatusCode, message: String) -> QueueCommitError {
    QueueCommitError {
        status,
        message,
        acceptance_ambiguous: false,
        intended_placement: None,
    }
}

fn queue_mutation_request_error(
    status: StatusCode,
    message: String,
    placement: SpotifyTrackPlacement,
) -> QueueCommitError {
    QueueCommitError {
        status,
        message,
        // BAD_GATEWAY is the transport-error channel from reqwest::send. The
        // request may have reached Spotify. Rate-limit/gate/auth errors happen
        // before a mutation can be accepted and remain definite.
        acceptance_ambiguous: status == StatusCode::BAD_GATEWAY,
        intended_placement: Some(placement),
    }
}

fn spotify_mutation_response_is_ambiguous(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
}

#[derive(Debug)]
struct SkipMutationError {
    status: StatusCode,
    message: String,
    acceptance_ambiguous: bool,
}

fn skip_mutation_request_error(status: StatusCode, message: String) -> SkipMutationError {
    SkipMutationError {
        status,
        message,
        // BAD_GATEWAY is spotify_api_request's transport-error channel. Gate,
        // rate-limit, and authentication failures happen before acceptance.
        acceptance_ambiguous: status == StatusCode::BAD_GATEWAY,
    }
}

async fn spotify_skip_mutation_response_error(response: reqwest::Response) -> SkipMutationError {
    let upstream_status = response.status();
    let (status, message) = spotify_response_error(response, "Skip Spotify track").await;
    SkipMutationError {
        status,
        message,
        acceptance_ambiguous: spotify_mutation_response_is_ambiguous(upstream_status),
    }
}

async fn run_guarded_spotify_skip_mutation<T, F>(
    state: &AppState,
    generation: u64,
    device: &SpotifyDevice,
    operation: F,
) -> Result<T, SkipMutationError>
where
    F: Future<Output = Result<T, SkipMutationError>>,
{
    let guarded_result: Result<Result<T, SkipMutationError>, SkipMutationError> = tokio::select! {
        result = tokio::time::timeout(SPOTIFY_RECOVERY_OPERATION_TIMEOUT, operation) => {
            match result {
                Ok(result) => Ok(result),
                Err(_) => Err(SkipMutationError {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    message: format!(
                        "Skipping a Spotify track exceeded the {}s source-safety deadline",
                        SPOTIFY_RECOVERY_OPERATION_TIMEOUT.as_secs(),
                    ),
                    acceptance_ambiguous: true,
                }),
            }
        }
        (status, message) = wait_for_jam_recovery_controls_loss(state, generation) => {
            Err(SkipMutationError {
                status,
                message,
                acceptance_ambiguous: true,
            })
        },
    };

    if let Ok(Err(error)) = &guarded_result {
        if !error.acceptance_ambiguous {
            return Err(SkipMutationError {
                status: error.status,
                message: error.message.clone(),
                acceptance_ambiguous: false,
            });
        }
    }
    let operation_result = match guarded_result {
        Err(error) => Err(error),
        Ok(operation_result) => match ensure_jam_recovery_controls_ready(state).await {
            Ok(current_generation) if current_generation == generation => operation_result,
            Ok(_) => Err(SkipMutationError {
                status: StatusCode::CONFLICT,
                message: "Jam generation changed during Spotify Skip".to_string(),
                acceptance_ambiguous: true,
            }),
            Err((status, message)) => Err(SkipMutationError {
                status,
                message,
                acceptance_ambiguous: true,
            }),
        },
    };
    if let Err(error) = &operation_result {
        if error.acceptance_ambiguous {
            pause_and_mark_spotify_safety_stop(state, generation, device, &error.message).await;
        }
    }
    operation_result
}

async fn spotify_queue_mutation_response_error(
    response: reqwest::Response,
    operation: &str,
    placement: SpotifyTrackPlacement,
) -> QueueCommitError {
    let upstream_status = response.status();
    let (status, message) = spotify_response_error(response, operation).await;
    QueueCommitError {
        status,
        message,
        acceptance_ambiguous: spotify_mutation_response_is_ambiguous(upstream_status),
        intended_placement: Some(placement),
    }
}

async fn run_guarded_spotify_recovery_read<T, F>(
    state: &AppState,
    generation: u64,
    operation_name: &str,
    operation: F,
) -> Result<T, (StatusCode, String)>
where
    F: Future<Output = Result<T, (StatusCode, String)>>,
{
    let result = tokio::select! {
        result = tokio::time::timeout(SPOTIFY_RECOVERY_OPERATION_TIMEOUT, operation) => {
            result.map_err(|_| (
                StatusCode::SERVICE_UNAVAILABLE,
                format!(
                    "{} exceeded the {}s source-safety deadline",
                    operation_name,
                    SPOTIFY_RECOVERY_OPERATION_TIMEOUT.as_secs(),
                ),
            ))?
        }
        error = wait_for_jam_recovery_controls_loss(state, generation) => return Err(error),
    };
    match ensure_jam_recovery_controls_ready(state).await {
        Ok(current_generation) if current_generation == generation => result,
        Ok(_) => Err((
            StatusCode::CONFLICT,
            "Jam generation changed during Spotify observation".to_string(),
        )),
        Err(error) => Err(error),
    }
}

async fn run_guarded_spotify_queue_mutation<T, F>(
    state: &AppState,
    generation: u64,
    device: &SpotifyDevice,
    operation_name: &str,
    placement: SpotifyTrackPlacement,
    operation: F,
) -> Result<T, QueueCommitError>
where
    F: Future<Output = Result<T, QueueCommitError>>,
{
    let guarded_result = tokio::select! {
        result = tokio::time::timeout(SPOTIFY_RECOVERY_OPERATION_TIMEOUT, operation) => {
            match result {
                Ok(result) => Ok(result),
                Err(_) => Err(QueueCommitError {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    message: format!(
                        "{} exceeded the {}s source-safety deadline",
                        operation_name,
                        SPOTIFY_RECOVERY_OPERATION_TIMEOUT.as_secs(),
                    ),
                    acceptance_ambiguous: true,
                    intended_placement: Some(placement),
                }),
            }
        }
        (status, message) = wait_for_jam_recovery_controls_loss(state, generation) => {
            Err(QueueCommitError {
                status,
                message,
                acceptance_ambiguous: true,
                intended_placement: Some(placement),
            })
        },
    };

    if let Ok(Err(error)) = &guarded_result {
        if !error.acceptance_ambiguous {
            return Err(QueueCommitError {
                status: error.status,
                message: error.message.clone(),
                acceptance_ambiguous: false,
                intended_placement: error.intended_placement,
            });
        }
    }
    match guarded_result {
        Err(error) => {
            pause_and_mark_spotify_safety_stop(state, generation, device, &error.message).await;
            Err(error)
        }
        Ok(operation_result) => match ensure_jam_recovery_controls_ready(state).await {
            Ok(current_generation) if current_generation == generation => operation_result,
            Ok(_) => {
                let error = QueueCommitError {
                    status: StatusCode::CONFLICT,
                    message: "Jam generation changed during Spotify queue control".to_string(),
                    acceptance_ambiguous: true,
                    intended_placement: Some(placement),
                };
                pause_and_mark_spotify_safety_stop(state, generation, device, &error.message).await;
                Err(error)
            }
            Err((status, message)) => {
                let error = QueueCommitError {
                    status,
                    message,
                    acceptance_ambiguous: true,
                    intended_placement: Some(placement),
                };
                pause_and_mark_spotify_safety_stop(state, generation, device, &error.message).await;
                Err(error)
            }
        },
    }
}

fn queue_frontier_candidate(queue: &[JamQueueEntry]) -> Option<JamQueueEntry> {
    let frontier_count = queue
        .iter()
        .filter(|entry| entry.delivery_state.occupies_spotify_frontier())
        .count();
    if frontier_count >= SPOTIFY_COMMITTED_QUEUE_FRONTIER || queue_has_commit_unknown(queue) {
        return None;
    }
    queue
        .iter()
        .find(|entry| entry.delivery_state == QueueDeliveryState::Pending)
        .cloned()
}

fn queue_has_commit_unknown(queue: &[JamQueueEntry]) -> bool {
    queue
        .iter()
        .any(|entry| entry.delivery_state == QueueDeliveryState::CommitUnknown)
}

fn commit_unknown_queue_add_response() -> Response {
    playlist_queue_error_response(
        StatusCode::CONFLICT,
        "queue_commit_unknown",
        "Spotify acceptance of an earlier queue entry is unknown. End and restart the Jam before adding more songs",
    )
}

fn has_existing_spotify_frontier(queue: &[JamQueueEntry], candidate_entry_id: &str) -> bool {
    queue.iter().any(|queued| {
        queued.track.queue_entry_id != candidate_entry_id
            && queued.delivery_state.occupies_spotify_frontier()
    })
}

async fn commit_pending_queue_track_guarded(
    state: &AppState,
    generation: u64,
    entry: &JamQueueEntry,
    should_queue: Option<bool>,
    expected_control_epoch: u64,
    allow_resume_stopped: bool,
) -> Result<u64, QueueCommitError> {
    // Keep the global lifecycle fence to one Spotify mutation. Stop, skip, and
    // teardown may run between batch entries and the next entry revalidates.
    let _refresh = state.jam_state_refresh.lock().await;
    let _lifecycle = state.jam_lifecycle.lock().await;
    let current_generation = ensure_jam_recovery_controls_ready(state)
        .await
        .map_err(|(status, message)| definite_queue_commit_error(status, message))?;
    if current_generation != generation {
        return Err(definite_queue_commit_error(
            StatusCode::CONFLICT,
            "Jam generation changed".to_string(),
        ));
    }
    let (device, control_epoch, control_stopped, mut has_existing_frontier) = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if jam.uncertain_skip.is_some() {
            return Err(definite_queue_commit_error(
                StatusCode::CONFLICT,
                "Echo is reconciling an uncertain Spotify Skip".to_string(),
            ));
        }
        (
            bound_spotify_device(&jam, generation).ok_or_else(|| {
                definite_queue_commit_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "The active Jam has no bound Spotify device".to_string(),
                )
            })?,
            jam.queue_control_epoch,
            jam.queue_control_stopped,
            has_existing_spotify_frontier(&jam.queue, &entry.track.queue_entry_id),
        )
    };
    if enqueue_interrupted_by_stop(expected_control_epoch, control_epoch, control_stopped) {
        return Err(definite_queue_commit_error(
            StatusCode::CONFLICT,
            "Playlist enqueue was interrupted by Stop Music".to_string(),
        ));
    }
    let cached_should_queue =
        cached_queue_mode(expected_control_epoch, control_epoch, should_queue);
    let should_queue = match cached_should_queue {
        Some(should_queue) => should_queue,
        None => {
            let observation = run_guarded_spotify_recovery_read(
                state,
                generation,
                "Reading Spotify playback before queue placement",
                spotify_queue_placement_observation(state, &device),
            )
            .await
            .map_err(|(status, message)| definite_queue_commit_error(status, message))?;
            let retired = {
                let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
                if !active_generation_matches(&jam, generation)
                    || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
                    || jam.queue_control_epoch != control_epoch
                {
                    None
                } else {
                    let retired = retire_stale_frontier_for_queue_placement(&mut jam, &observation);
                    has_existing_frontier =
                        has_existing_spotify_frontier(&jam.queue, &entry.track.queue_entry_id);
                    retired
                }
            };
            if let Some(retired) = retired {
                info!(
                    "Jam: retired stale terminal queue track '{}' before placing a new entry",
                    retired.name
                );
            }

            let mut should_queue = observation.should_queue();
            if has_existing_frontier && !should_queue {
                if !allow_resume_stopped {
                    let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
                    if active_generation_matches(&jam, generation)
                        && jam.spotify_device_id.as_deref() == Some(device.id.as_str())
                        && jam.queue_control_epoch == control_epoch
                    {
                        mark_observed_queue_stopped(&mut jam);
                    }
                    return Err(definite_queue_commit_error(
                        StatusCode::CONFLICT,
                        "Spotify playback is paused; waiting for an explicit queue action"
                            .to_string(),
                    ));
                }
                run_guarded_spotify_recovery_operation(
                    state,
                    generation,
                    &device,
                    "Resuming Spotify before queue placement",
                    resume_spotify_playback_on_device(state, &device),
                )
                .await
                .map_err(|(status, message)| definite_queue_commit_error(status, message))?;
                let resumed = {
                    let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
                    if !active_generation_matches(&jam, generation)
                        || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
                        || jam.queue_control_epoch != control_epoch
                        || jam.queue_control_stopped
                    {
                        false
                    } else {
                        jam.spotify_device_name = Some(device.name.clone());
                        jam.spotify_is_playing = true;
                        jam.audio_expected_since = Some(std::time::Instant::now());
                        jam.last_error = None;
                        jam.now_playing = None;
                        true
                    }
                };
                if !resumed {
                    let message =
                        "Jam changed after Spotify resumed before queue placement".to_string();
                    pause_and_mark_spotify_safety_stop(state, generation, &device, &message).await;
                    return Err(definite_queue_commit_error(StatusCode::CONFLICT, message));
                }
                should_queue = true;
            }
            should_queue
        }
    };
    let intended_placement = spotify_track_placement(should_queue);
    let placement = run_guarded_spotify_queue_mutation(
        state,
        generation,
        &device,
        "Queueing a Spotify playlist track",
        intended_placement,
        place_spotify_track(state, &device, &entry.track.spotify_uri, intended_placement),
    )
    .await?;

    let applied = {
        let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if !active_generation_matches(&jam, generation)
            || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
        {
            false
        } else {
            let queue_track = jam
                .queue
                .iter_mut()
                .find(|queued| queued.track.queue_entry_id == entry.track.queue_entry_id);
            match queue_track {
                Some(queue_track) if queue_track.delivery_state == QueueDeliveryState::Pending => {
                    queue_track.delivery_state = QueueDeliveryState::SpotifyCommitted;
                    queue_track.can_remove = false;
                    queue_track.current_match_state = placement.current_match_state();
                    jam.spotify_device_name = Some(device.name.clone());
                    jam.last_error = None;
                    jam.queue_revision = jam.queue_revision.wrapping_add(1);
                    if placement == SpotifyTrackPlacement::StartedCurrent {
                        jam.spotify_is_playing = true;
                        jam.audio_expected_since = Some(std::time::Instant::now());
                        jam.queue_control_stopped = false;
                        jam.now_playing = None;
                    }
                    true
                }
                _ => false,
            }
        }
    };
    if !applied {
        let message = "Jam changed after Spotify accepted a queue track".to_string();
        pause_and_mark_spotify_safety_stop(state, generation, &device, &message).await;
        return Err(QueueCommitError {
            status: StatusCode::CONFLICT,
            message,
            acceptance_ambiguous: true,
            intended_placement: Some(placement),
        });
    }
    Ok(control_epoch)
}

fn stopped_frontier_should_resume(
    queue: &[JamQueueEntry],
    control_stopped: bool,
    allow_resume_stopped: bool,
) -> bool {
    control_stopped
        && allow_resume_stopped
        && queue
            .iter()
            .any(|entry| entry.delivery_state.occupies_spotify_frontier())
}

async fn resume_stopped_queue_frontier_guarded(
    state: &AppState,
    generation: u64,
    expected_control_epoch: u64,
) -> Result<u64, (StatusCode, String)> {
    let _refresh = state.jam_state_refresh.lock().await;
    let _lifecycle = state.jam_lifecycle.lock().await;
    let current_generation = ensure_jam_recovery_controls_ready(state).await?;
    if current_generation != generation {
        return Err((StatusCode::CONFLICT, "Jam generation changed".to_string()));
    }
    let (device, control_epoch, control_stopped) = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if jam.uncertain_skip.is_some() {
            return Err((
                StatusCode::CONFLICT,
                "Echo is reconciling an uncertain Spotify Skip".to_string(),
            ));
        }
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
            "Queue resume was interrupted by a newer Stop Music action".to_string(),
        ));
    }
    if !control_stopped {
        return Ok(control_epoch);
    }
    run_guarded_spotify_recovery_operation(
        state,
        generation,
        &device,
        "Resuming the stopped Spotify queue",
        resume_spotify_playback_on_device(state, &device),
    )
    .await?;

    let applied = {
        let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if !active_generation_matches(&jam, generation)
            || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
            || jam.queue_control_epoch != control_epoch
        {
            false
        } else {
            jam.spotify_device_name = Some(device.name.clone());
            jam.spotify_is_playing = true;
            jam.audio_expected_since = Some(std::time::Instant::now());
            jam.last_error = None;
            jam.queue_control_stopped = false;
            jam.now_playing = None;
            true
        }
    };
    if !applied {
        pause_bound_spotify_before_release(state, generation, Some(&device)).await;
        return Err((
            StatusCode::CONFLICT,
            "Jam changed after Spotify resumed the queue".to_string(),
        ));
    }
    Ok(control_epoch)
}

async fn pump_queue_frontier_locked(
    state: &AppState,
    generation: u64,
    expected_control_epoch: u64,
    allow_resume_stopped: bool,
) {
    let mut should_queue = None;
    let mut control_epoch = expected_control_epoch;
    loop {
        let (control_stopped, should_resume, track) = {
            let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
            if !active_generation_matches(&jam, generation) {
                return;
            }
            (
                jam.queue_control_stopped,
                stopped_frontier_should_resume(
                    &jam.queue,
                    jam.queue_control_stopped,
                    allow_resume_stopped,
                ),
                queue_frontier_candidate(&jam.queue),
            )
        };
        if should_resume {
            match resume_stopped_queue_frontier_guarded(state, generation, control_epoch).await {
                Ok(observed_control_epoch) => {
                    control_epoch = observed_control_epoch;
                    should_queue = Some(true);
                    continue;
                }
                Err((status, message)) => {
                    let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
                    if active_generation_matches(&jam, generation) {
                        jam.last_error = Some(message.clone());
                    }
                    warn!(
                        "Jam stopped queue resume failed status={}: {}",
                        status, message
                    );
                    return;
                }
            }
        }
        if control_stopped && !allow_resume_stopped {
            return;
        }
        let Some(track) = track else {
            return;
        };
        match commit_pending_queue_track_guarded(
            state,
            generation,
            &track,
            should_queue,
            control_epoch,
            allow_resume_stopped,
        )
        .await
        {
            Ok(observed_control_epoch) => {
                should_queue = Some(true);
                control_epoch = observed_control_epoch;
            }
            Err(error) => {
                let mut jam = state
                    .jam
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                if active_generation_matches(&jam, generation) {
                    if error.acceptance_ambiguous {
                        if let Some(queue_track) = jam.queue.iter_mut().find(|queued| {
                            queued.track.queue_entry_id == track.track.queue_entry_id
                        }) {
                            if queue_track.delivery_state == QueueDeliveryState::Pending {
                                queue_track.delivery_state = QueueDeliveryState::CommitUnknown;
                                queue_track.can_remove = false;
                                if let Some(placement) = error.intended_placement {
                                    queue_track.current_match_state =
                                        placement.current_match_state();
                                }
                                jam.queue_revision = jam.queue_revision.wrapping_add(1);
                            }
                        }
                    }
                    jam.last_error = Some(error.message.clone());
                }
                warn!(
                    "Jam queue frontier delivery failed status={} ambiguous={}: {}",
                    error.status, error.acceptance_ambiguous, error.message
                );
                return;
            }
        }
    }
}

async fn pump_queue_frontier(state: &AppState, generation: u64) {
    let _queue_lifecycle = state.jam_queue_lifecycle.lock().await;
    let expected_control_epoch = state
        .jam
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .queue_control_epoch;
    pump_queue_frontier_locked(state, generation, expected_control_epoch, false).await;
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
    if let Some(request_id) = payload.request_id.as_deref() {
        if !playlist_queue_request_id_valid(request_id) {
            return Err(playlist_queue_error_response(
                StatusCode::BAD_REQUEST,
                "invalid_request_id",
                "request_id must be 8-128 ASCII letters, digits, dashes, or underscores",
            ));
        }
    }
    let spotify_id = spotify_track_id_from_uri(&payload.spotify_uri)
        .ok_or_else(|| {
            playlist_queue_error_response(
                StatusCode::BAD_REQUEST,
                "invalid_track_uri",
                "Invalid Spotify track URI",
            )
        })?
        .to_string();
    if let Some(request_id) = payload.request_id.as_deref() {
        let replay = {
            let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
            track_queue_receipt_response(
                &jam,
                request_id,
                &actor.actor_id,
                &spotify_id,
                payload.generation,
            )
        };
        match replay {
            Ok(Some(track)) => {
                return Ok(Json(serde_json::json!({
                    "ok": true,
                    "request_id": request_id,
                    "track": track,
                })));
            }
            Ok(None) => {}
            Err(()) => {
                return Err(playlist_queue_error_response(
                    StatusCode::CONFLICT,
                    "request_id_conflict",
                    "request_id was already used for a different track queue operation",
                ));
            }
        }
    }
    if {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        active_generation_matches(&jam, payload.generation) && queue_has_commit_unknown(&jam.queue)
    } {
        return Err(commit_unknown_queue_add_response());
    }
    let (request_control_epoch, request_stop_epoch) = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        (jam.queue_control_epoch, jam.queue_stop_epoch)
    };
    let summary = fetch_favorite_summary(&state, FavoriteKind::Track, &spotify_id)
        .await
        .map_err(JamApiError::into_response)?;
    let _queue_lifecycle = state.jam_queue_lifecycle.lock().await;
    if let Some(request_id) = payload.request_id.as_deref() {
        let replay = {
            let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
            track_queue_receipt_response(
                &jam,
                request_id,
                &actor.actor_id,
                &spotify_id,
                payload.generation,
            )
        };
        match replay {
            Ok(Some(track)) => {
                return Ok(Json(serde_json::json!({
                    "ok": true,
                    "request_id": request_id,
                    "track": track,
                })));
            }
            Ok(None) => {}
            Err(()) => {
                return Err(playlist_queue_error_response(
                    StatusCode::CONFLICT,
                    "request_id_conflict",
                    "request_id was already used for a different track queue operation",
                ));
            }
        }
    }
    let track = queued_track_from_summary(&summary, &actor, None, None, None, now_ts_ms());
    let generation = {
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
        let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if jam.uncertain_skip.is_some() {
            return Err(playlist_queue_error_response(
                StatusCode::CONFLICT,
                "skip_reconciliation_required",
                "Echo is reconciling the previous Spotify Skip; wait for fresh playback state",
            ));
        }
        if queue_has_commit_unknown(&jam.queue) {
            return Err(commit_unknown_queue_add_response());
        }
        if enqueue_admission_cancelled_by_stop(request_stop_epoch, jam.queue_stop_epoch)
            || enqueue_interrupted_by_stop(
                request_control_epoch,
                jam.queue_control_epoch,
                jam.queue_control_stopped,
            )
        {
            return Err(playlist_queue_error_response(
                StatusCode::CONFLICT,
                "queue_interrupted",
                "Track enqueue was interrupted by Stop Music",
            ));
        }
        if bound_spotify_device(&jam, generation).is_none() {
            return Err(playlist_queue_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "spotify_device_unavailable",
                "The active Jam has no bound Spotify device",
            ));
        }
        jam.queue.push(pending_queue_entry(track.clone()));
        jam.queue_revision = jam.queue_revision.wrapping_add(1);
        generation
    };
    pump_queue_frontier_locked(&state, generation, request_control_epoch, true).await;
    let response_track = {
        let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        let response_track = jam
            .queue
            .iter()
            .find(|queued| queued.track.queue_entry_id == track.queue_entry_id)
            .cloned()
            .ok_or_else(|| {
                playlist_queue_error_response(
                    StatusCode::CONFLICT,
                    "generation_changed",
                    "Jam changed while adding the track to Echo's queue",
                )
            })?;
        if let Some(request_id) = payload.request_id.clone() {
            insert_track_queue_receipt(
                &mut jam,
                request_id,
                TrackQueueReceipt {
                    actor_id: actor.actor_id.clone(),
                    spotify_id: spotify_id.clone(),
                    generation,
                    created_at_ms: now_ts_ms(),
                    track: response_track.clone(),
                },
            );
        }
        response_track
    };
    let mut response = serde_json::json!({ "ok": true, "track": response_track });
    if let Some(request_id) = payload.request_id {
        response["request_id"] = serde_json::Value::String(request_id);
    }
    Ok(Json(response))
}

fn queue_removal_fingerprint(
    payload: &JamQueueRemoveRequest,
) -> Result<QueueRemovalFingerprint, Response> {
    if payload.queue_entry_ids.is_empty()
        || payload.queue_entry_ids.len() > MAX_QUEUE_REMOVAL_ENTRIES
    {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "invalid_queue_entry_ids",
            format!("queue_entry_ids must contain 1-{MAX_QUEUE_REMOVAL_ENTRIES} entries"),
        ));
    }
    let mut canonical_ids = payload.queue_entry_ids.clone();
    if canonical_ids.iter().any(|entry_id| {
        !(8..=128).contains(&entry_id.len())
            || !entry_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }) {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "invalid_queue_entry_ids",
            "queue_entry_ids contains an invalid Echo queue entry ID",
        ));
    }
    canonical_ids.sort_unstable();
    if canonical_ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "invalid_queue_entry_ids",
            "queue_entry_ids must not contain duplicates",
        ));
    }
    Ok(QueueRemovalFingerprint {
        expected_queue_revision: payload.expected_queue_revision,
        queue_entry_ids: canonical_ids,
    })
}

fn queue_removal_conflict_response(
    code: &'static str,
    message: impl Into<String>,
    queue_revision: u64,
) -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "error": code,
            "message": message.into(),
            "queue_revision": queue_revision,
        })),
    )
        .into_response()
}

pub(crate) async fn jam_queue_remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamQueueRemoveRequest>,
) -> Result<Json<JamQueueRemoveResponse>, Response> {
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
    if !playlist_queue_request_id_valid(&payload.request_id) {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request_id",
            "request_id must be 8-128 ASCII letters, digits, dashes, or underscores",
        ));
    }
    let fingerprint = queue_removal_fingerprint(&payload)?;
    let _queue_lifecycle = state.jam_queue_lifecycle.lock().await;
    let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());

    match queue_removal_receipt_response(
        &jam,
        &payload.request_id,
        &actor.actor_id,
        payload.generation,
        &fingerprint,
    ) {
        Ok(Some(response)) => return Ok(Json(response)),
        Ok(None) => {}
        Err(()) => {
            return Err(queue_removal_conflict_response(
                "request_id_conflict",
                "request_id was already used for a different queue removal",
                jam.queue_revision,
            ));
        }
    }

    if !active_generation_matches(&jam, payload.generation) {
        return Err(queue_removal_conflict_response(
            "generation_changed",
            "Jam generation changed",
            jam.queue_revision,
        ));
    }
    if jam.queue_revision != payload.expected_queue_revision {
        return Err(queue_removal_conflict_response(
            "queue_changed",
            "The Jam queue changed; refresh it before removing songs",
            jam.queue_revision,
        ));
    }

    match remove_pending_queue_entries(&mut jam, &fingerprint.queue_entry_ids) {
        Ok(()) => {}
        Err(QueueRemovalMutationError::QueueChanged) => {
            return Err(queue_removal_conflict_response(
                "queue_changed",
                "One or more selected songs are no longer in the Jam queue",
                jam.queue_revision,
            ));
        }
        Err(QueueRemovalMutationError::NotRemovable) => {
            return Err(queue_removal_conflict_response(
                "queue_entries_not_removable",
                "One or more selected songs were already handed to Spotify and cannot be removed",
                jam.queue_revision,
            ));
        }
    }
    let response = JamQueueRemoveResponse {
        ok: true,
        generation: payload.generation,
        queue_revision: jam.queue_revision,
        removed_entry_ids: payload.queue_entry_ids.clone(),
        removed_count: payload.queue_entry_ids.len(),
    };
    insert_queue_removal_receipt(
        &mut jam,
        payload.request_id,
        QueueRemovalReceipt {
            actor_id: actor.actor_id,
            generation: payload.generation,
            fingerprint,
            created_at_ms: now_ts_ms(),
            response: response.clone(),
        },
    );
    Ok(Json(response))
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

pub(crate) async fn jam_queue_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PlaylistQueueRequest>,
) -> Result<Json<PlaylistQueueResponse>, Response> {
    if payload.selected_positions.is_some() {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "playlist_selection_endpoint_required",
            "Queue selected playlist songs through the playlist selection endpoint",
        ));
    }
    jam_queue_playlist_impl(state, headers, payload).await
}

pub(crate) async fn jam_queue_playlist_selection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PlaylistQueueRequest>,
) -> Result<Json<PlaylistQueueResponse>, Response> {
    if payload.selected_positions.is_none() {
        return Err(playlist_queue_error_response(
            StatusCode::BAD_REQUEST,
            "selected_positions_required",
            "selected_positions is required for the playlist selection endpoint",
        ));
    }
    jam_queue_playlist_impl(state, headers, payload).await
}

async fn jam_queue_playlist_impl(
    state: AppState,
    headers: HeaderMap,
    payload: PlaylistQueueRequest,
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
    let selection = playlist_queue_selection_fingerprint(&payload)?;

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
            &selection,
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
                "request_id was already used for a different playlist queue operation",
            ));
        }
    }
    if {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        queue_has_commit_unknown(&jam.queue)
    } {
        return Err(commit_unknown_queue_add_response());
    }
    let (request_control_epoch, request_stop_epoch) = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        (jam.queue_control_epoch, jam.queue_stop_epoch)
    };

    let expansion = match selection.selected_positions.as_deref() {
        Some(selected_positions) => {
            fetch_playlist_selection(
                &state,
                &payload.playlist_id,
                selected_positions,
                selection.snapshot_id.as_deref(),
            )
            .await
        }
        None => {
            fetch_playlist_expansion(
                &state,
                &payload.playlist_id,
                selection.snapshot_id.as_deref(),
            )
            .await
        }
    }
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

    // Playlist metadata can take several Spotify requests. Serialize only the
    // short Echo queue mutation and frontier delivery so queue reads/removals
    // are not blocked while the catalog is loading.
    let _queue_lifecycle = state.jam_queue_lifecycle.lock().await;
    let cached_receipt = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        playlist_queue_receipt_response(
            &jam,
            &payload.request_id,
            &actor.actor_id,
            &payload.playlist_id,
            &selection,
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
                "request_id was already used for a different playlist queue operation",
            ));
        }
    }

    let batch_id = format!("qb1_{}", random_secret());
    let batch_added_at_ms = now_ts_ms();
    let provenance = playlist_provenance(&expansion.playlist);
    let queued_positions = expansion
        .tracks
        .iter()
        .map(|(position, _)| *position)
        .collect::<Vec<_>>();
    let tracks = expansion
        .tracks
        .iter()
        .map(|(position, summary)| {
            pending_queue_entry(queued_track_from_summary(
                summary,
                &actor,
                Some(&batch_id),
                Some(&provenance),
                Some(*position),
                batch_added_at_ms,
            ))
        })
        .collect::<Vec<_>>();
    {
        let _refresh = state.jam_state_refresh.lock().await;
        let _lifecycle = state.jam_lifecycle.lock().await;
        let current_generation =
            ensure_jam_recovery_controls_ready(&state)
                .await
                .map_err(|(status, message)| {
                    spotify_queue_error_response(&state, status, "jam_unavailable", message)
                })?;
        if current_generation != generation {
            return Err(playlist_queue_error_response(
                StatusCode::CONFLICT,
                "generation_changed",
                "Jam generation changed while the playlist was loading",
            ));
        }
        let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if jam.uncertain_skip.is_some() {
            return Err(playlist_queue_error_response(
                StatusCode::CONFLICT,
                "skip_reconciliation_required",
                "Echo is reconciling the previous Spotify Skip; wait for fresh playback state",
            ));
        }
        if queue_has_commit_unknown(&jam.queue) {
            return Err(commit_unknown_queue_add_response());
        }
        if enqueue_admission_cancelled_by_stop(request_stop_epoch, jam.queue_stop_epoch)
            || enqueue_interrupted_by_stop(
                request_control_epoch,
                jam.queue_control_epoch,
                jam.queue_control_stopped,
            )
        {
            return Err(playlist_queue_error_response(
                StatusCode::CONFLICT,
                "queue_interrupted",
                "Playlist enqueue was interrupted by Stop Music",
            ));
        }
        if bound_spotify_device(&jam, generation).is_none() {
            return Err(playlist_queue_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "spotify_device_unavailable",
                "The active Jam has no bound Spotify device",
            ));
        }
        jam.queue.extend(tracks);
        jam.queue_revision = jam.queue_revision.wrapping_add(1);
    }
    pump_queue_frontier_locked(&state, generation, request_control_epoch, true).await;

    let _receipt_lifecycle = state.jam_lifecycle.lock().await;
    let can_store_receipt = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        active_generation_matches(&jam, generation)
    };
    if !can_store_receipt {
        return Err(playlist_queue_error_response(
            StatusCode::CONFLICT,
            "generation_changed",
            "Jam ended before the playlist enqueue receipt was committed",
        ));
    }
    let skipped = expansion.skipped;
    let queued_count = queued_positions.len();
    let response = PlaylistQueueResponse {
        schema_version: 1,
        ok: true,
        partial: false,
        request_id: payload.request_id.clone(),
        queue_batch_id: batch_id.clone(),
        batch_id,
        generation,
        playlist: provenance,
        queued_positions,
        remaining_positions: Vec::new(),
        queued_count,
        skipped_count: skipped.len(),
        skipped,
        complete: true,
        failure: None,
    };
    let mut jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
    insert_playlist_queue_receipt(
        &mut jam,
        payload.request_id,
        PlaylistQueueReceipt {
            actor_id: actor.actor_id,
            playlist_id: payload.playlist_id,
            selection,
            generation,
            created_at_ms: now_ts_ms(),
            response: response.clone(),
        },
    );
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
    let _queue_lifecycle = state.jam_queue_lifecycle.lock().await;
    let (generation, next_control_epoch) = {
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
        let device = {
            let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
            if jam.uncertain_skip.is_some() {
                return Err(playlist_queue_error_response(
                    StatusCode::CONFLICT,
                    "skip_reconciliation_required",
                    "Echo is reconciling the previous Spotify Skip; wait for fresh playback state",
                ));
            }
            bound_spotify_device(&jam, generation).ok_or_else(|| {
                playlist_queue_error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "spotify_device_unavailable",
                    "The active Jam has no bound Spotify device",
                )
            })?
        };
        let (spotify_playback, previous_uri, same_uri_resolution) =
            run_guarded_spotify_recovery_operation(
                &state,
                generation,
                &device,
                "Skipping a Spotify track",
                async {
                    let spotify_playback = bind_spotify_playback_to_device(&state, &device).await?;
                    if spotify_playback.current_uri.is_none() {
                        return Err((
                            StatusCode::CONFLICT,
                            "Spotify has no current track to skip".to_string(),
                        ));
                    }
                    let (previous_uri, same_uri_observation_required) = {
                        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
                        if !active_generation_matches(&jam, generation)
                            || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
                        {
                            return Err((
                                StatusCode::CONFLICT,
                                "Jam changed while preparing to skip the Spotify track".to_string(),
                            ));
                        }
                        let previous_uri = jam
                            .now_playing
                            .as_ref()
                            .map(|playing| playing.spotify_uri.clone());
                        let observation_required = same_uri_skip_observation_required(
                            &jam.queue,
                            spotify_playback.current_uri.as_deref(),
                            previous_uri.as_deref(),
                        );
                        (previous_uri, observation_required)
                    };
                    let same_uri_resolution = if same_uri_observation_required {
                        let current_uri =
                            spotify_playback.current_uri.as_deref().ok_or_else(|| {
                                (
                            StatusCode::CONFLICT,
                            "Spotify playback changed while resolving the queued occurrence"
                                .to_string(),
                        )
                            })?;
                        let queue_observation = spotify_queue_observation_strict(&state).await?;
                        let resolution = {
                            let jam =
                                state.jam.lock().unwrap_or_else(|error| error.into_inner());
                            if !active_generation_matches(&jam, generation)
                                || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
                            {
                                return Err((
                                    StatusCode::CONFLICT,
                                    "Jam changed while resolving the queued occurrence".to_string(),
                                ));
                            }
                            resolve_same_uri_skip_observation(
                                &jam.queue,
                                &queue_observation,
                                current_uri,
                                previous_uri.as_deref(),
                            )
                        };
                        resolution.map_err(|error| match error {
                            SameUriSkipObservationError::PlaybackChanged => (
                                StatusCode::CONFLICT,
                                "Spotify playback changed while resolving the queued occurrence"
                                    .to_string(),
                            ),
                            SameUriSkipObservationError::CommitUnknown => (
                                StatusCode::CONFLICT,
                                "Echo cannot safely Skip because Spotify acceptance of this same-song queue entry is unknown"
                                    .to_string(),
                            ),
                        })?
                    } else {
                        PreSkipSameUriResolution::NotNeeded
                    };
                    let current_uri = spotify_playback.current_uri.as_deref().ok_or_else(|| {
                        (
                            StatusCode::CONFLICT,
                            "Spotify playback changed while resolving the queued occurrence"
                                .to_string(),
                        )
                    })?;
                    {
                        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
                        if !active_generation_matches(&jam, generation)
                            || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
                        {
                            return Err((
                                StatusCode::CONFLICT,
                                "Jam changed while resolving the queued occurrence".to_string(),
                            ));
                        }
                        reject_commit_unknown_pre_skip_target(
                            &jam.queue,
                            current_uri,
                            previous_uri.as_deref(),
                            same_uri_resolution,
                        )
                        .map_err(|error| match error {
                            SameUriSkipObservationError::PlaybackChanged => (
                                StatusCode::CONFLICT,
                                "Spotify playback changed while resolving the queued occurrence"
                                    .to_string(),
                            ),
                            SameUriSkipObservationError::CommitUnknown => (
                                StatusCode::CONFLICT,
                                "Echo cannot safely Skip because Spotify acceptance of this queue entry is unknown"
                                    .to_string(),
                            ),
                        })?;
                    }
                    Ok((spotify_playback, previous_uri, same_uri_resolution))
                },
            )
            .await
            .map_err(|(status, message)| {
                spotify_queue_error_response(&state, status, "spotify_skip_failed", message)
            })?;

        let pre_skip_history = {
            let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
            let current_uri = spotify_playback.current_uri.as_deref();
            let queued_track = authoritative_pre_skip_echo_track(
                &jam.queue,
                current_uri,
                previous_uri.as_deref(),
                same_uri_resolution,
            );
            new_history_observation(
                jam.last_history_spotify_id.as_deref(),
                jam.last_history_was_echo,
                current_uri.and_then(spotify_track_id_from_uri),
                queued_track.as_ref(),
                spotify_playback.is_playing,
                same_uri_resolution == PreSkipSameUriResolution::AwaitingIsCurrent,
            )
        };
        if let Some(observation) = pre_skip_history {
            // The bound-device preflight definitively observed this occurrence
            // playing even if the following /next response becomes ambiguous.
            persist_jam_history_observation(&state, generation, observation).await;
        }

        let next_url = format!(
            "https://api.spotify.com/v1/me/player/next?device_id={}",
            urlencoded(&device.id)
        );
        let skip_result = run_guarded_spotify_skip_mutation(&state, generation, &device, async {
            let response = spotify_api_request(&state, reqwest::Method::POST, &next_url, None)
                .await
                .map_err(|(status, message)| skip_mutation_request_error(status, message))?;
            if !response.status().is_success() {
                return Err(spotify_skip_mutation_response_error(response).await);
            }
            Ok(())
        })
        .await;
        if let Err(error) = skip_result {
            if error.acceptance_ambiguous {
                let mut jam = state
                    .jam
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                if active_generation_matches(&jam, generation)
                    && jam.spotify_device_id.as_deref() == Some(device.id.as_str())
                {
                    jam.uncertain_skip = Some(UncertainSkipBoundary {
                        pre_skip_current_uri: spotify_playback
                            .current_uri
                            .clone()
                            .expect("Skip preflight requires a current URI"),
                        previous_uri: previous_uri.clone(),
                        same_uri_resolution,
                    });
                    jam.last_error = Some(error.message.clone());
                }
            }
            let code = if error.acceptance_ambiguous {
                "spotify_skip_unknown"
            } else {
                "spotify_skip_failed"
            };
            return Err(spotify_queue_error_response(
                &state,
                error.status,
                code,
                error.message,
            ));
        }

        let next_control_epoch = {
            let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
            if !active_generation_matches(&jam, generation)
                || jam.spotify_device_id.as_deref() != Some(device.id.as_str())
            {
                None
            } else {
                let queue_transition = apply_successful_skip_to_queue(
                    &mut jam.queue,
                    spotify_playback.current_uri.as_deref(),
                    previous_uri.as_deref(),
                    same_uri_resolution,
                );
                if queue_transition.changed() {
                    jam.queue_revision = jam.queue_revision.wrapping_add(1);
                }
                for removed in queue_transition.removed_before_current {
                    info!(
                        "Jam: reconciled naturally advanced queue track '{}' before Skip",
                        removed.name
                    );
                }
                if let Some(removed) = queue_transition.removed {
                    info!(
                        "Jam: retired explicitly skipped queue track '{}'",
                        removed.name
                    );
                }
                jam.spotify_device_name = Some(device.name.clone());
                jam.spotify_is_playing = spotify_playback.is_playing;
                jam.audio_expected_since =
                    spotify_playback.is_playing.then(std::time::Instant::now);
                jam.last_error = None;
                jam.queue_control_epoch = jam.queue_control_epoch.wrapping_add(1);
                jam.queue_control_stopped =
                    queue_control_stopped_after_skip(spotify_playback.is_playing);
                if jam.queue_control_stopped {
                    jam.queue_stop_epoch = jam.queue_stop_epoch.wrapping_add(1);
                }
                jam.now_playing = None;
                Some(jam.queue_control_epoch)
            }
        };
        let Some(next_control_epoch) = next_control_epoch else {
            pause_and_mark_spotify_safety_stop(
                &state,
                generation,
                &device,
                "Jam changed while skipping the Spotify track",
            )
            .await;
            return Err(playlist_queue_error_response(
                StatusCode::CONFLICT,
                "generation_changed",
                "Jam changed while skipping the Spotify track",
            ));
        };
        (generation, next_control_epoch)
    };
    // Refill before releasing the queue lifecycle so two rapid Skip requests
    // cannot outrun Echo's two-track Spotify frontier.
    pump_queue_frontier_locked(&state, generation, next_control_epoch, false).await;
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
            scope: "user-read-private user-modify-playback-state user-read-currently-playing user-read-playback-state user-library-read playlist-read-private playlist-read-collaborative".to_string(),
        }
    }

    #[test]
    fn spotify_token_deserializes_legacy_payload_without_scope() {
        let token: SpotifyToken = serde_json::from_value(serde_json::json!({
            "access_token": "legacy-access",
            "refresh_token": "legacy-refresh",
            "expires_at": 1234
        }))
        .expect("legacy Spotify token should deserialize");

        assert!(token.scope.is_empty());
        assert!(!spotify_library_scopes_authorized(Some(&token)));
    }

    #[test]
    fn spotify_callback_does_not_claim_connection_before_validation() {
        assert!(SPOTIFY_CALLBACK_RECEIVED_HTML.contains("Spotify authorization received"));
        assert!(!SPOTIFY_CALLBACK_RECEIVED_HTML.contains("Spotify Connected"));
        assert!(SPOTIFY_CALLBACK_RECEIVED_HTML.contains("verifies the connection"));
    }

    #[test]
    fn spotify_library_authorization_requires_every_library_scope() {
        let mut token = spotify_token();
        assert!(spotify_library_scopes_authorized(Some(&token)));

        token.scope = "user-library-read playlist-read-private".to_string();
        assert!(!spotify_library_scopes_authorized(Some(&token)));
        assert!(!spotify_library_scopes_authorized(None));
    }

    #[test]
    fn spotify_library_scope_error_has_a_stable_machine_code() {
        let error = spotify_library_scope_required_error();
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.code, "spotify_library_scope_required");
        assert!(error.message.contains("Refresh Spotify Access"));
    }

    #[test]
    fn spotify_account_validation_distinguishes_forbidden_and_rate_limited() {
        let forbidden = spotify_access_validation_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":{"status":403,"message":"User is not registered for this application"}}"#,
            None,
        );
        assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
        assert_eq!(forbidden.code, "spotify_account_forbidden");
        assert!(forbidden
            .message
            .contains("not registered for this application"));
        assert!(forbidden.message.contains("User Management"));

        let rate_limited = spotify_access_validation_error(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            r#"{"error":{"status":429,"message":"Slow down"}}"#,
            Some("17".to_string()),
        );
        assert_eq!(rate_limited.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(rate_limited.code, "spotify_rate_limited");
        assert_eq!(rate_limited.retry_after.as_deref(), Some("17"));
    }

    #[test]
    fn spotify_token_exchange_forbidden_preserves_account_allowlist_guidance() {
        let forbidden = spotify_token_exchange_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":"access_denied","error_description":"User is not registered for this application"}"#,
            None,
        );

        assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
        assert_eq!(forbidden.code, "spotify_account_forbidden");
        assert!(forbidden
            .message
            .contains("User is not registered for this application"));
        assert!(forbidden.message.contains("User Management"));
    }

    #[test]
    fn spotify_refresh_scope_is_preserved_or_updated_from_response() {
        let old_scope = "user-library-read playlist-read-private";
        let omitted = serde_json::json!({
            "access_token": "new-access",
            "expires_in": 3600
        });
        assert_eq!(
            spotify_scope_from_token_response(&omitted, Some(old_scope)),
            old_scope
        );

        let updated = serde_json::json!({
            "access_token": "new-access",
            "expires_in": 3600,
            "scope": "user-library-read playlist-read-private playlist-read-collaborative"
        });
        assert_eq!(
            spotify_scope_from_token_response(&updated, Some(old_scope)),
            "user-library-read playlist-read-private playlist-read-collaborative"
        );
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
            playlist_position: None,
            added_by: "sam-7475".to_string(),
        }
    }

    fn committed_queue_entry(uri: &str) -> JamQueueEntry {
        JamQueueEntry {
            track: queued_track(uri),
            delivery_state: QueueDeliveryState::SpotifyCommitted,
            can_remove: false,
            current_match_state: QueueCurrentMatchState::Eligible,
        }
    }

    fn pending_queue_entry_with_id(uri: &str, entry_id: &str) -> JamQueueEntry {
        let mut track = queued_track(uri);
        track.queue_entry_id = entry_id.to_string();
        pending_queue_entry(track)
    }

    fn spotify_device(id: &str, name: &str) -> SpotifyDevice {
        SpotifyDevice {
            id: id.to_string(),
            name: name.to_string(),
            is_restricted: false,
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
            spotify_connect_repair_supported: false,
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
            queue: vec![committed_queue_entry("spotify:track:one")],
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
        assert_eq!(jam.queue[0].track.spotify_uri, "spotify:track:one");
        assert_eq!(jam.spotify_device_id.as_deref(), Some("device-a"));
        assert_eq!(jam.spotify_device_name.as_deref(), Some("Echo PC"));
        assert!(!jam.spotify_is_playing);
        assert_eq!(jam.queue_stop_epoch, 1);
        assert!(jam.queue_control_stopped);
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
    fn rotated_spotify_device_id_uses_one_exact_name_match() {
        let selected = select_spotify_device(
            vec![spotify_device("new-id", "Echo PC")],
            Some("stale-id"),
            Some("Echo PC"),
        )
        .expect("unique configured name should repair a rotated device ID");
        assert_eq!(selected.id, "new-id");
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
        assert_eq!(error.into_response().0, StatusCode::CONFLICT);
    }

    #[test]
    fn configured_restricted_spotify_device_never_triggers_repair() {
        let mut restricted = spotify_device("id-a", "Echo PC");
        restricted.is_restricted = true;
        let error =
            select_spotify_device(vec![restricted], Some("id-a"), Some("Echo PC")).unwrap_err();
        assert!(matches!(&error, SpotifyDeviceResolveError::Other(_, _)));
        assert!(error.into_response().1.contains("restricted"));
    }

    #[test]
    fn malformed_spotify_devices_schema_is_not_missing_device() {
        for data in [
            serde_json::json!({}),
            serde_json::json!({"devices": {}}),
            serde_json::json!({"devices": [{"id":"id-a","name":"Echo PC","is_restricted":"no"}]}),
        ] {
            let error = parse_spotify_devices(&data).unwrap_err();
            assert_eq!(error.into_response().0, StatusCode::BAD_GATEWAY);
        }
    }

    #[test]
    fn documented_null_spotify_device_id_does_not_hide_valid_target() {
        let devices = parse_spotify_devices(&serde_json::json!({
            "devices": [
                {"id": null, "name": "Untargetable", "is_restricted": false},
                {"id": "id-a", "name": "Echo PC", "is_restricted": false}
            ]
        }))
        .expect("nullable non-targetable neighbor is skipped");
        let selected = select_spotify_device(devices, Some("id-a"), Some("Echo PC"))
            .expect("valid configured target remains selectable");
        assert_eq!(selected.id, "id-a");
    }

    fn spotify_connect_unavailable() -> SpotifyDeviceResolveError {
        SpotifyDeviceResolveError::Unavailable(
            "Spotify Connect device 'Echo PC' is unavailable".to_string(),
        )
    }

    fn repair_result(was_running_before: bool) -> crate::jam_source::SpotifyConnectRepairResult {
        crate::jam_source::SpotifyConnectRepairResult {
            outcome: "ok".to_string(),
            was_running_before,
        }
    }

    #[tokio::test]
    async fn healthy_spotify_connect_device_takes_no_repair_action() {
        let actions = std::cell::RefCell::new(Vec::new());
        let result = resolve_spotify_device_with_repair(
            || std::future::ready(Ok(spotify_device("device-a", "Echo PC"))),
            |action| {
                actions.borrow_mut().push(action);
                std::future::ready(Ok(repair_result(true)))
            },
            2,
            Duration::ZERO,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.id, "device-a");
        assert!(actions.borrow().is_empty());
    }

    #[tokio::test]
    async fn delayed_spotify_registration_recovers_without_restart() {
        let resolutions = std::cell::RefCell::new(std::collections::VecDeque::from([
            Err(spotify_connect_unavailable()),
            Err(spotify_connect_unavailable()),
            Ok(spotify_device("device-a", "Echo PC")),
        ]));
        let actions = std::cell::RefCell::new(Vec::new());
        let result = resolve_spotify_device_with_repair(
            || std::future::ready(resolutions.borrow_mut().pop_front().unwrap()),
            |action| {
                actions.borrow_mut().push(action);
                std::future::ready(Ok(repair_result(true)))
            },
            3,
            Duration::ZERO,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.id, "device-a");
        assert_eq!(
            *actions.borrow(),
            vec![crate::jam_source::SpotifyConnectRepairAction::Activate]
        );
    }

    #[tokio::test]
    async fn stale_running_spotify_restarts_only_after_activation_poll_expires() {
        let resolutions = std::cell::RefCell::new(std::collections::VecDeque::from([
            Err(spotify_connect_unavailable()),
            Err(spotify_connect_unavailable()),
            Err(spotify_connect_unavailable()),
            Ok(spotify_device("device-a", "Echo PC")),
        ]));
        let actions = std::cell::RefCell::new(Vec::new());
        let result = resolve_spotify_device_with_repair(
            || std::future::ready(resolutions.borrow_mut().pop_front().unwrap()),
            |action| {
                actions.borrow_mut().push(action);
                std::future::ready(Ok(repair_result(true)))
            },
            2,
            Duration::ZERO,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.id, "device-a");
        assert_eq!(
            *actions.borrow(),
            vec![
                crate::jam_source::SpotifyConnectRepairAction::Activate,
                crate::jam_source::SpotifyConnectRepairAction::Restart,
            ]
        );
    }

    #[tokio::test]
    async fn freshly_activated_spotify_is_never_restarted_in_the_same_start() {
        let actions = std::cell::RefCell::new(Vec::new());
        let error = resolve_spotify_device_with_repair(
            || std::future::ready(Err(spotify_connect_unavailable())),
            |action| {
                actions.borrow_mut().push(action);
                std::future::ready(Ok(repair_result(false)))
            },
            1,
            Duration::ZERO,
            None,
        )
        .await
        .unwrap_err();

        assert!(matches!(&error, SpotifyDeviceResolveError::Unavailable(_)));
        assert_eq!(
            *actions.borrow(),
            vec![crate::jam_source::SpotifyConnectRepairAction::Activate]
        );
    }

    #[tokio::test]
    async fn non_missing_spotify_errors_never_request_local_repair() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::BAD_GATEWAY,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            let actions = std::cell::RefCell::new(Vec::new());
            let error = resolve_spotify_device_with_repair(
                || {
                    std::future::ready(Err(SpotifyDeviceResolveError::Other(
                        status,
                        "upstream failure".to_string(),
                    )))
                },
                |action| {
                    actions.borrow_mut().push(action);
                    std::future::ready(Ok(repair_result(true)))
                },
                1,
                Duration::ZERO,
                None,
            )
            .await
            .unwrap_err();
            assert_eq!(error.into_response().0, status);
            assert!(actions.borrow().is_empty());
        }
    }

    #[tokio::test]
    async fn missing_spotify_install_has_connect_specific_failure_wording() {
        let error = resolve_spotify_device_with_repair(
            || std::future::ready(Err(spotify_connect_unavailable())),
            |_| {
                std::future::ready(Err(
                    "Spotify may not be installed or its app registration is damaged".to_string(),
                ))
            },
            1,
            Duration::ZERO,
            None,
        )
        .await
        .unwrap_err()
        .into_response();

        assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE);
        assert!(error.1.contains("Spotify Connect device"));
        assert!(error.1.contains("may not be installed"));
        assert!(!error.1.contains("Echo Jam source is offline"));
    }

    #[tokio::test]
    async fn exhausted_repair_never_reports_the_echo_source_offline() {
        let error = resolve_spotify_device_with_repair(
            || std::future::ready(Err(spotify_connect_unavailable())),
            |_| std::future::ready(Ok(repair_result(false))),
            1,
            Duration::ZERO,
            None,
        )
        .await
        .unwrap_err()
        .into_response();

        assert!(error.1.contains("Spotify Connect device"));
        assert!(error.1.contains("tried to re-register Spotify"));
        assert!(!error.1.to_ascii_lowercase().contains("source is offline"));
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
        let mut queue = vec![committed_queue_entry("one"), committed_queue_entry("two")];

        assert!(reconcile_queue_to_current(&mut queue, "external").is_empty());
        assert_eq!(queue.len(), 2);

        let removed = reconcile_queue_to_current(&mut queue, "two");
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].spotify_uri, "one");
        assert_eq!(queue[0].track.spotify_uri, "two");
    }

    #[test]
    fn pending_track_matching_external_playback_does_not_advance_queue() {
        let mut queue = vec![
            committed_queue_entry("one"),
            pending_queue_entry_with_id("pending", "qe_pending_track"),
        ];

        assert!(reconcile_queue_to_current(&mut queue, "pending").is_empty());
        assert_eq!(queue.len(), 2);
        assert_eq!(queue[0].track.spotify_uri, "one");
    }

    #[test]
    fn commit_unknown_started_current_never_adopts_matching_paused_external_playback() {
        let mut paused = now_playing(false);
        paused.spotify_uri = "one".to_string();
        let mut entry = committed_queue_entry("one");
        entry.delivery_state = QueueDeliveryState::CommitUnknown;
        let mut queue = vec![entry];

        assert!(reconcile_queue_to_current(&mut queue, &paused.spotify_uri).is_empty());
        assert!(committed_queue_track_matching_current(&queue, &paused.spotify_uri).is_none());
        assert!(advance_repeated_committed_occurrence(&mut queue, &paused.spotify_uri).is_none());
        assert!(retire_skipped_queue_frontier(&mut queue, Some(&paused.spotify_uri)).is_none());
        assert!(retire_finished_queue_frontier(&mut queue, &paused.spotify_uri).is_none());
        assert_eq!(queue[0].delivery_state, QueueDeliveryState::CommitUnknown);
        assert!(!queue[0].can_remove);
    }

    #[test]
    fn repeated_committed_occurrences_advance_on_a_near_end_progress_wrap() {
        let mut previous = now_playing(true);
        previous.progress_ms = 115_000;
        let mut current = previous.clone();
        current.progress_ms = 2_000;
        let next_observation = SpotifyQueueObservation {
            current_uri: current.spotify_uri.clone(),
            next_uri: Some("spotify:track:next".to_string()),
        };
        let same_next_observation = SpotifyQueueObservation {
            current_uri: current.spotify_uri.clone(),
            next_uri: Some(current.spotify_uri.clone()),
        };
        assert!(same_track_occurrence_restarted(Some(&previous), &current));
        assert!(!repeated_occurrence_advance_confirmed(
            Some(&previous),
            &current,
            "track",
            Some(&next_observation),
        ));
        assert!(!repeated_occurrence_advance_confirmed(
            Some(&previous),
            &current,
            "",
            Some(&next_observation),
        ));
        assert!(!repeated_occurrence_advance_confirmed(
            Some(&previous),
            &current,
            "off",
            Some(&same_next_observation),
        ));
        assert!(!repeated_occurrence_advance_confirmed(
            Some(&previous),
            &current,
            "off",
            None,
        ));
        assert!(repeated_occurrence_advance_confirmed(
            Some(&previous),
            &current,
            "off",
            Some(&next_observation),
        ));

        let mut queue = vec![
            committed_queue_entry(&previous.spotify_uri),
            committed_queue_entry(&previous.spotify_uri),
            pending_queue_entry_with_id("later", "qe_later_track"),
        ];
        let removed = advance_repeated_committed_occurrence(&mut queue, &current.spotify_uri)
            .expect("the first duplicate occurrence should advance");
        assert_eq!(removed.spotify_uri, current.spotify_uri);
        assert_eq!(queue.len(), 2);
        assert_eq!(queue[0].track.spotify_uri, current.spotify_uri);
        assert_eq!(
            queue_frontier_candidate(&queue)
                .expect("the pending successor should enter the frontier")
                .track
                .queue_entry_id,
            "qe_later_track"
        );

        let mut seek = previous;
        seek.progress_ms = 60_000;
        assert!(!same_track_occurrence_restarted(Some(&seek), &current));
    }

    #[test]
    fn queued_next_same_uri_waits_for_a_real_occurrence_boundary() {
        let uri = "spotify:track:same";
        let mut first = committed_queue_entry(uri);
        first.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut second = committed_queue_entry(uri);
        second.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut queue = vec![first, second];

        assert!(reconcile_queue_to_current(&mut queue, uri).is_empty());
        assert!(!observe_queue_current_transition(&mut queue, uri, false));
        assert_eq!(
            queue[0].current_match_state,
            QueueCurrentMatchState::AwaitingTransition
        );
        assert!(advance_repeated_committed_occurrence(&mut queue, uri).is_none());

        assert!(observe_queue_current_transition(&mut queue, uri, true));
        assert_eq!(
            queue[0].current_match_state,
            QueueCurrentMatchState::Eligible
        );
        assert_eq!(
            queue[1].current_match_state,
            QueueCurrentMatchState::AwaitingTransition
        );

        let removed = advance_repeated_committed_occurrence(&mut queue, uri)
            .expect("the first observed Echo occurrence should advance");
        assert_eq!(removed.spotify_uri, uri);
        assert!(observe_queue_current_transition(&mut queue, uri, true));
        assert_eq!(
            queue[0].current_match_state,
            QueueCurrentMatchState::Eligible
        );
    }

    #[test]
    fn confirmed_same_uri_restart_retires_a_finished_echo_frontier_occurrence() {
        let uri = "spotify:track:same";
        let mut queue = vec![committed_queue_entry(uri)];

        let removed = advance_repeated_committed_occurrence(&mut queue, uri)
            .expect("the prior Echo occurrence finished at the confirmed restart");
        assert_eq!(removed.spotify_uri, uri);
        assert!(queue.is_empty());
    }

    #[test]
    fn sole_naturally_finished_frontier_is_retired_so_the_next_add_starts() {
        let uri = "spotify:track:finished";
        let mut finished = now_playing(false);
        finished.spotify_uri = uri.to_string();
        finished.progress_ms = finished.duration_ms;
        let mut queue = vec![committed_queue_entry(uri)];

        assert!(stopped_playback_reached_track_end(&finished));
        let removed = retire_finished_queue_frontier(&mut queue, &finished.spotify_uri)
            .expect("the terminal committed occurrence must not remain stale");
        assert_eq!(removed.spotify_uri, uri);

        queue.push(pending_queue_entry_with_id(
            "spotify:track:new",
            "qe_new_after_end",
        ));
        let candidate = queue_frontier_candidate(&queue).expect("the new add must be selectable");
        let spotify_reports_active_playback = false;
        let should_queue = has_existing_spotify_frontier(&queue, &candidate.track.queue_entry_id)
            || spotify_reports_active_playback;
        assert!(!should_queue);
        assert_eq!(
            spotify_track_placement(should_queue),
            SpotifyTrackPlacement::StartedCurrent,
        );
    }

    #[test]
    fn unobserved_natural_end_is_retired_atomically_during_the_first_add() {
        let finished_uri = "spotify:track:finished";
        let mut previous = now_playing(true);
        previous.spotify_uri = finished_uri.to_string();
        previous.progress_ms = 117_000;
        previous.fetched_at = Some(std::time::Instant::now() - Duration::from_secs(4));
        let observation = SpotifyPlacementObservation {
            playback_present: true,
            bound_device: true,
            is_playing: false,
            current_uri: Some(finished_uri.to_string()),
            progress_ms: 120_000,
            duration_ms: 120_000,
        };
        let mut jam = JamState {
            active: true,
            generation: 9,
            queue_revision: 4,
            now_playing: Some(previous),
            queue: vec![
                committed_queue_entry(finished_uri),
                pending_queue_entry_with_id("spotify:track:new", "qe_new_after_end"),
            ],
            ..JamState::default()
        };

        let removed = retire_stale_frontier_for_queue_placement(&mut jam, &observation)
            .expect("the corroborated terminal front should retire during add preflight");
        assert_eq!(removed.spotify_uri, finished_uri);
        assert_eq!(jam.queue_revision, 5);
        assert!(jam.now_playing.is_none());
        let candidate = queue_frontier_candidate(&jam.queue).unwrap();
        assert!(!has_existing_spotify_frontier(
            &jam.queue,
            &candidate.track.queue_entry_id,
        ));
        assert_eq!(
            spotify_track_placement(observation.should_queue()),
            SpotifyTrackPlacement::StartedCurrent,
        );
    }

    #[test]
    fn paused_near_end_frontier_is_preserved_for_resume_then_queue() {
        let paused_uri = "spotify:track:paused";
        let mut previous = now_playing(true);
        previous.spotify_uri = paused_uri.to_string();
        previous.progress_ms = 117_000;
        previous.fetched_at = Some(std::time::Instant::now() - Duration::from_secs(4));
        let observation = SpotifyPlacementObservation {
            playback_present: true,
            bound_device: true,
            is_playing: false,
            current_uri: Some(paused_uri.to_string()),
            progress_ms: 119_000,
            duration_ms: 120_000,
        };
        let mut jam = JamState {
            active: true,
            generation: 9,
            queue_revision: 4,
            now_playing: Some(previous),
            queue: vec![
                committed_queue_entry(paused_uri),
                pending_queue_entry_with_id("spotify:track:new", "qe_new_after_pause"),
            ],
            ..JamState::default()
        };

        assert!(retire_stale_frontier_for_queue_placement(&mut jam, &observation).is_none());
        assert_eq!(jam.queue_revision, 4);
        assert_eq!(jam.queue[0].track.spotify_uri, paused_uri);
        assert_eq!(
            jam.queue[0].current_match_state,
            QueueCurrentMatchState::Eligible,
        );
        assert!(has_existing_spotify_frontier(
            &jam.queue,
            "qe_new_after_pause",
        ));
        // The explicit add path resumes this preserved occurrence, then uses
        // Add to Queue for the new item; it never replaces the paused track.
        assert_eq!(
            spotify_track_placement(true),
            SpotifyTrackPlacement::QueuedNext,
        );
    }

    #[test]
    fn intentional_stop_blocks_stale_retirement_and_automatic_resume() {
        let stopped_uri = "spotify:track:stopped";
        let mut previous = now_playing(true);
        previous.spotify_uri = stopped_uri.to_string();
        previous.progress_ms = 117_000;
        previous.fetched_at = Some(std::time::Instant::now() - Duration::from_secs(4));
        let observation = SpotifyPlacementObservation {
            playback_present: true,
            bound_device: true,
            is_playing: false,
            current_uri: Some(stopped_uri.to_string()),
            progress_ms: 120_000,
            duration_ms: 120_000,
        };
        let mut jam = JamState {
            active: true,
            generation: 9,
            queue_revision: 4,
            queue_control_stopped: true,
            now_playing: Some(previous),
            queue: vec![committed_queue_entry(stopped_uri)],
            ..JamState::default()
        };

        assert!(retire_stale_frontier_for_queue_placement(&mut jam, &observation).is_none());
        assert_eq!(jam.queue_revision, 4);
        assert_eq!(jam.queue[0].track.spotify_uri, stopped_uri);
        assert!(!stopped_frontier_should_resume(&jam.queue, true, false));
        assert!(stopped_frontier_should_resume(&jam.queue, true, true));
    }

    #[test]
    fn no_content_only_retires_a_prior_track_when_elapsed_time_reaches_its_end() {
        let mut previous = now_playing(true);
        previous.progress_ms = 117_000;
        assert!(!prior_playback_finished_before_no_content(
            &previous,
            Duration::from_secs(1),
        ));
        assert!(prior_playback_finished_before_no_content(
            &previous,
            Duration::from_secs(3),
        ));
    }

    #[test]
    fn queued_next_with_a_different_predecessor_can_become_current() {
        let first = committed_queue_entry("spotify:track:first");
        let mut second = committed_queue_entry("spotify:track:second");
        second.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut queue = vec![first, second];

        assert!(observe_queue_current_transition(
            &mut queue,
            "spotify:track:second",
            false,
        ));
        let removed = reconcile_queue_to_current(&mut queue, "spotify:track:second");
        assert_eq!(removed.len(), 1);
        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue[0].current_match_state,
            QueueCurrentMatchState::Eligible
        );
    }

    #[test]
    fn rapid_skips_retire_each_observed_front_and_expose_the_next_refill() {
        let mut queue = vec![
            committed_queue_entry("a"),
            committed_queue_entry("b"),
            pending_queue_entry_with_id("c", "qe_c"),
            pending_queue_entry_with_id("d", "qe_d"),
        ];

        assert_eq!(
            retire_skipped_queue_frontier(&mut queue, Some("a"))
                .expect("A should retire")
                .spotify_uri,
            "a"
        );
        let c_id = queue_frontier_candidate(&queue)
            .expect("C should immediately enter the frontier")
            .track
            .queue_entry_id;
        let c = queue
            .iter_mut()
            .find(|entry| entry.track.queue_entry_id == c_id)
            .unwrap();
        c.delivery_state = QueueDeliveryState::SpotifyCommitted;
        c.can_remove = false;
        c.current_match_state = QueueCurrentMatchState::AwaitingTransition;

        assert_eq!(
            retire_skipped_queue_frontier(&mut queue, Some("b"))
                .expect("B should retire")
                .spotify_uri,
            "b"
        );
        assert_eq!(
            queue_frontier_candidate(&queue)
                .expect("D should be available for the second refill")
                .track
                .queue_entry_id,
            "qe_d"
        );
    }

    #[test]
    fn skip_unlocks_same_uri_successor_without_duplicating_echo_history() {
        let id = "AAAAAAAAAAAAAAAAAAAAAA";
        let uri = format!("spotify:track:{id}");
        let mut first = committed_queue_entry(&uri);
        first.track.spotify_id = id.to_string();
        let mut second = committed_queue_entry(&uri);
        second.track.spotify_id = id.to_string();
        second.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut queue = vec![first, second];

        let transition = apply_successful_skip_to_queue(
            &mut queue,
            Some(&uri),
            Some(&uri),
            PreSkipSameUriResolution::AwaitingStillNext,
        );
        assert!(transition.removed.is_some());
        assert!(transition.unlocked_successor);
        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue[0].current_match_state,
            QueueCurrentMatchState::Eligible,
        );
        assert!(new_history_observation(
            Some(id),
            true,
            Some(id),
            Some(&queue[0].track),
            true,
            false,
        )
        .is_none());
    }

    #[test]
    fn skip_unlocks_different_uri_successor_for_immediate_history() {
        let first_id = "AAAAAAAAAAAAAAAAAAAAAA";
        let second_id = "BBBBBBBBBBBBBBBBBBBBBB";
        let first_uri = format!("spotify:track:{first_id}");
        let second_uri = format!("spotify:track:{second_id}");
        let mut first = committed_queue_entry(&first_uri);
        first.track.spotify_id = first_id.to_string();
        let mut second = committed_queue_entry(&second_uri);
        second.track.spotify_id = second_id.to_string();
        second.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut queue = vec![first, second];

        let transition = apply_successful_skip_to_queue(
            &mut queue,
            Some(&first_uri),
            Some(&first_uri),
            PreSkipSameUriResolution::NotNeeded,
        );
        assert!(transition.removed.is_some());
        assert!(transition.unlocked_successor);
        let observation = new_history_observation(
            Some(first_id),
            true,
            Some(second_id),
            Some(&queue[0].track),
            true,
            false,
        )
        .expect("the different successor should be immediately attributable");
        assert_eq!(
            observation
                .queued_track
                .as_ref()
                .map(|track| track.spotify_id.as_str()),
            Some(second_id),
        );
    }

    #[test]
    fn skip_reconciles_a_missed_different_uri_transition_before_retiring_current() {
        let mut second = committed_queue_entry("b");
        second.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut queue = vec![
            committed_queue_entry("a"),
            second,
            pending_queue_entry_with_id("c", "qe_c_after_missed_transition"),
        ];

        assert!(!same_uri_skip_observation_required(
            &queue,
            Some("b"),
            Some("a"),
        ));
        let transition = apply_successful_skip_to_queue(
            &mut queue,
            Some("b"),
            Some("a"),
            PreSkipSameUriResolution::NotNeeded,
        );
        let mut queue_revision = 41_u64;
        if transition.changed() {
            queue_revision = queue_revision.wrapping_add(1);
        }

        assert_eq!(
            queue_revision, 42,
            "the compound transition is one revision"
        );
        assert_eq!(transition.removed_before_current.len(), 1);
        assert_eq!(transition.removed_before_current[0].spotify_uri, "a");
        assert_eq!(
            transition
                .removed
                .as_ref()
                .map(|track| track.spotify_uri.as_str()),
            Some("b"),
        );
        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue[0].track.queue_entry_id,
            "qe_c_after_missed_transition"
        );
        assert_eq!(queue[0].delivery_state, QueueDeliveryState::Pending);
    }

    #[test]
    fn pre_skip_observation_attributes_a_missed_transition_to_history() {
        let first_id = "AAAAAAAAAAAAAAAAAAAAAA";
        let second_id = "BBBBBBBBBBBBBBBBBBBBBB";
        let first_uri = format!("spotify:track:{first_id}");
        let second_uri = format!("spotify:track:{second_id}");
        let mut first = committed_queue_entry(&first_uri);
        first.track.spotify_id = first_id.to_string();
        let mut second = committed_queue_entry(&second_uri);
        second.track.spotify_id = second_id.to_string();
        second.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let queue = vec![first, second];

        let observed = authoritative_pre_skip_echo_track(
            &queue,
            Some(&second_uri),
            Some(&first_uri),
            PreSkipSameUriResolution::NotNeeded,
        )
        .expect("the authoritative pre-skip current should align to the queued successor");
        let history = new_history_observation(
            Some(first_id),
            true,
            Some(second_id),
            Some(&observed),
            true,
            false,
        )
        .expect("the newly observed Echo occurrence should start a history run");
        assert_eq!(
            history
                .queued_track
                .as_ref()
                .map(|track| track.spotify_id.as_str()),
            Some(second_id),
        );
    }

    #[test]
    fn skip_reconciles_external_to_echo_transition_observed_only_by_preflight() {
        let mut queued_echo = committed_queue_entry("b");
        queued_echo.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut queue = vec![queued_echo];

        assert!(!same_uri_skip_observation_required(
            &queue,
            Some("b"),
            Some("external-a"),
        ));
        let transition = apply_successful_skip_to_queue(
            &mut queue,
            Some("b"),
            Some("external-a"),
            PreSkipSameUriResolution::NotNeeded,
        );

        assert!(transition.removed_before_current.is_empty());
        assert_eq!(
            transition
                .removed
                .as_ref()
                .map(|track| track.spotify_uri.as_str()),
            Some("b"),
        );
        assert!(queue.is_empty());
    }

    #[test]
    fn same_uri_skip_uses_spotify_next_item_to_select_the_exact_occurrence() {
        let uri = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA";
        let mut second = committed_queue_entry(uri);
        second.track.queue_entry_id = "qe_same_second".to_string();
        second.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let first = committed_queue_entry(uri);
        let first_id = first.track.queue_entry_id.clone();
        let queue = vec![first, second];

        assert!(same_uri_skip_observation_required(
            &queue,
            Some(uri),
            Some(uri),
        ));
        let still_next = resolve_same_uri_skip_observation(
            &queue,
            &SpotifyQueueObservation {
                current_uri: uri.to_string(),
                next_uri: Some(uri.to_string()),
            },
            uri,
            Some(uri),
        )
        .expect("the exact current/next observation should resolve the occurrence");
        assert_eq!(still_next, PreSkipSameUriResolution::AwaitingStillNext,);
        let mut first_is_current = queue.clone();
        let transition =
            apply_successful_skip_to_queue(&mut first_is_current, Some(uri), Some(uri), still_next);
        assert!(transition.removed_before_current.is_empty());
        assert_eq!(
            transition
                .removed
                .as_ref()
                .map(|track| track.queue_entry_id.as_str()),
            Some(first_id.as_str()),
        );
        assert_eq!(first_is_current.len(), 1);
        assert_eq!(first_is_current[0].track.queue_entry_id, "qe_same_second");
        assert_eq!(
            first_is_current[0].current_match_state,
            QueueCurrentMatchState::Eligible,
        );

        let already_current = resolve_same_uri_skip_observation(
            &queue,
            &SpotifyQueueObservation {
                current_uri: uri.to_string(),
                next_uri: Some("spotify:track:BBBBBBBBBBBBBBBBBBBBBB".to_string()),
            },
            uri,
            Some(uri),
        )
        .expect("a different next URI proves the queued duplicate is current");
        assert_eq!(already_current, PreSkipSameUriResolution::AwaitingIsCurrent,);
        let mut second_is_current = queue;
        let transition = apply_successful_skip_to_queue(
            &mut second_is_current,
            Some(uri),
            Some(uri),
            already_current,
        );
        assert_eq!(transition.removed_before_current.len(), 1);
        assert_eq!(
            transition.removed_before_current[0].queue_entry_id,
            first_id,
        );
        assert_eq!(
            transition
                .removed
                .as_ref()
                .map(|track| track.queue_entry_id.as_str()),
            Some("qe_same_second"),
        );
        assert!(second_is_current.is_empty());
    }

    #[test]
    fn same_uri_skip_fails_closed_when_spotify_current_does_not_match() {
        let queue = Vec::new();
        let observation = SpotifyQueueObservation {
            current_uri: "spotify:track:BBBBBBBBBBBBBBBBBBBBBB".to_string(),
            next_uri: None,
        };
        assert_eq!(
            resolve_same_uri_skip_observation(
                &queue,
                &observation,
                "spotify:track:AAAAAAAAAAAAAAAAAAAAAA",
                None,
            ),
            Err(SameUriSkipObservationError::PlaybackChanged),
        );
    }

    #[test]
    fn commit_unknown_same_uri_skip_fails_closed_for_different_or_missing_next() {
        let uri = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA";
        let mut unknown = committed_queue_entry(uri);
        unknown.delivery_state = QueueDeliveryState::CommitUnknown;
        unknown.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let queue = vec![unknown];

        for next_uri in [
            Some("spotify:track:BBBBBBBBBBBBBBBBBBBBBB".to_string()),
            None,
        ] {
            let observation = SpotifyQueueObservation {
                current_uri: uri.to_string(),
                next_uri,
            };
            assert_eq!(
                resolve_same_uri_skip_observation(&queue, &observation, uri, Some(uri),),
                Err(SameUriSkipObservationError::CommitUnknown),
            );
        }

        assert!(authoritative_pre_skip_echo_track(
            &queue,
            Some(uri),
            Some(uri),
            PreSkipSameUriResolution::AwaitingIsCurrent,
        )
        .is_none());
        let mut attempted = queue.clone();
        let transition = apply_successful_skip_to_queue(
            &mut attempted,
            Some(uri),
            Some(uri),
            PreSkipSameUriResolution::AwaitingIsCurrent,
        );
        assert!(!transition.changed());
        assert_eq!(attempted.len(), 1);
        assert_eq!(
            attempted[0].delivery_state,
            QueueDeliveryState::CommitUnknown,
        );
        assert_eq!(
            attempted[0].current_match_state,
            QueueCurrentMatchState::AwaitingTransition,
        );
    }

    #[test]
    fn commit_unknown_skip_fails_closed_with_a_stale_different_predecessor() {
        let mut unknown = committed_queue_entry("a");
        unknown.delivery_state = QueueDeliveryState::CommitUnknown;
        unknown.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let queue = vec![committed_queue_entry("b"), unknown];

        assert!(!same_uri_skip_observation_required(
            &queue,
            Some("a"),
            Some("b"),
        ));
        assert_eq!(
            reject_commit_unknown_pre_skip_target(
                &queue,
                "a",
                Some("b"),
                PreSkipSameUriResolution::NotNeeded,
            ),
            Err(SameUriSkipObservationError::CommitUnknown),
        );
        assert!(authoritative_pre_skip_echo_track(
            &queue,
            Some("a"),
            Some("b"),
            PreSkipSameUriResolution::NotNeeded,
        )
        .is_none());
        let mut attempted = queue.clone();
        let transition = apply_successful_skip_to_queue(
            &mut attempted,
            Some("a"),
            Some("b"),
            PreSkipSameUriResolution::NotNeeded,
        );
        assert!(!transition.changed());
        assert_eq!(attempted.len(), 2);
        assert_eq!(attempted[0].track.spotify_uri, "b");
        assert_eq!(attempted[1].track.spotify_uri, "a");
        assert_eq!(
            attempted[1].delivery_state,
            QueueDeliveryState::CommitUnknown,
        );
        assert_eq!(
            attempted[1].current_match_state,
            QueueCurrentMatchState::AwaitingTransition,
        );
    }

    #[test]
    fn uncertain_skip_reconciles_accepted_and_rejected_different_uri_results() {
        let make_jam = || {
            let mut successor = committed_queue_entry("b");
            successor.current_match_state = QueueCurrentMatchState::AwaitingTransition;
            JamState {
                active: true,
                generation: 9,
                queue: vec![committed_queue_entry("a"), successor],
                queue_revision: 12,
                queue_control_stopped: true,
                uncertain_skip: Some(UncertainSkipBoundary {
                    pre_skip_current_uri: "a".to_string(),
                    previous_uri: Some("a".to_string()),
                    same_uri_resolution: PreSkipSameUriResolution::NotNeeded,
                }),
                ..JamState::default()
            }
        };

        let mut accepted = make_jam();
        assert_eq!(
            reconcile_uncertain_skip_boundary(&mut accepted, Some("b"), None),
            Some(UncertainSkipObservationResult::Accepted),
        );
        assert!(accepted.uncertain_skip.is_none());
        assert!(accepted.queue_control_stopped);
        assert_eq!(accepted.queue_revision, 13);
        assert_eq!(accepted.queue.len(), 1);
        assert_eq!(accepted.queue[0].track.spotify_uri, "b");
        assert_eq!(
            accepted.queue[0].current_match_state,
            QueueCurrentMatchState::Eligible,
        );

        let mut rejected = make_jam();
        assert_eq!(
            reconcile_uncertain_skip_boundary(&mut rejected, Some("a"), None),
            Some(UncertainSkipObservationResult::Rejected),
        );
        assert!(rejected.uncertain_skip.is_none());
        assert!(rejected.queue_control_stopped);
        assert_eq!(rejected.queue_revision, 12);
        assert_eq!(rejected.queue.len(), 2);
        assert_eq!(rejected.queue[0].track.spotify_uri, "a");
        assert_eq!(
            rejected.queue[1].current_match_state,
            QueueCurrentMatchState::AwaitingTransition,
        );
    }

    #[test]
    fn uncertain_same_uri_skip_waits_for_queue_evidence_then_recovers_exactly_once() {
        let uri = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA";
        let make_jam = || {
            let mut successor = committed_queue_entry(uri);
            successor.track.queue_entry_id = "qe_same_successor".to_string();
            successor.current_match_state = QueueCurrentMatchState::AwaitingTransition;
            JamState {
                active: true,
                generation: 9,
                queue: vec![committed_queue_entry(uri), successor],
                queue_revision: 20,
                queue_control_stopped: true,
                uncertain_skip: Some(UncertainSkipBoundary {
                    pre_skip_current_uri: uri.to_string(),
                    previous_uri: Some(uri.to_string()),
                    same_uri_resolution: PreSkipSameUriResolution::AwaitingStillNext,
                }),
                ..JamState::default()
            }
        };

        let mut pending = make_jam();
        assert_eq!(
            reconcile_uncertain_skip_boundary(&mut pending, Some(uri), None),
            Some(UncertainSkipObservationResult::Pending),
        );
        assert!(pending.uncertain_skip.is_some());
        assert_eq!(pending.queue_revision, 20);
        assert_eq!(pending.queue.len(), 2);

        let mut rejected = make_jam();
        assert_eq!(
            reconcile_uncertain_skip_boundary(
                &mut rejected,
                Some(uri),
                Some(&SpotifyQueueObservation {
                    current_uri: uri.to_string(),
                    next_uri: Some(uri.to_string()),
                }),
            ),
            Some(UncertainSkipObservationResult::Rejected),
        );
        assert!(rejected.uncertain_skip.is_none());
        assert_eq!(rejected.queue_revision, 20);
        assert_eq!(rejected.queue.len(), 2);

        let mut accepted = make_jam();
        let result = reconcile_uncertain_skip_boundary(
            &mut accepted,
            Some(uri),
            Some(&SpotifyQueueObservation {
                current_uri: uri.to_string(),
                next_uri: Some("spotify:track:BBBBBBBBBBBBBBBBBBBBBB".to_string()),
            }),
        );
        assert_eq!(result, Some(UncertainSkipObservationResult::Accepted));
        if !uncertain_skip_blocks_ordinary_queue_update(result) {
            let _ = advance_repeated_committed_occurrence(&mut accepted.queue, uri);
        }
        assert!(accepted.uncertain_skip.is_none());
        assert!(accepted.queue_control_stopped);
        assert_eq!(accepted.queue_revision, 21);
        assert_eq!(accepted.queue.len(), 1);
        assert_eq!(accepted.queue[0].track.queue_entry_id, "qe_same_successor");
        assert_eq!(
            accepted.queue[0].current_match_state,
            QueueCurrentMatchState::Eligible,
        );
    }

    #[test]
    fn uncertain_skip_no_content_keeps_the_queue_fenced_without_retirement() {
        let uri = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA";
        let mut successor = committed_queue_entry(uri);
        successor.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut previous = now_playing(true);
        previous.spotify_uri = uri.to_string();
        previous.progress_ms = previous.duration_ms;
        previous.fetched_at = Some(std::time::Instant::now() - Duration::from_secs(2));
        let mut jam = JamState {
            active: true,
            generation: 9,
            queue: vec![committed_queue_entry(uri), successor],
            queue_revision: 30,
            queue_control_stopped: true,
            uncertain_skip: Some(UncertainSkipBoundary {
                pre_skip_current_uri: uri.to_string(),
                previous_uri: Some(uri.to_string()),
                same_uri_resolution: PreSkipSameUriResolution::AwaitingStillNext,
            }),
            now_playing: Some(previous),
            ..JamState::default()
        };

        let reconciliation = reconcile_queue_after_no_content(&mut jam);
        assert_eq!(
            reconciliation.uncertain_skip,
            Some(UncertainSkipObservationResult::Pending),
        );
        assert!(reconciliation.naturally_finished.is_none());
        assert!(jam.uncertain_skip.is_some());
        assert_eq!(jam.queue_revision, 30);
        assert_eq!(jam.queue.len(), 2);
        assert_eq!(
            jam.queue[1].current_match_state,
            QueueCurrentMatchState::AwaitingTransition,
        );
    }

    #[test]
    fn ambiguous_skip_error_fences_without_mutating_the_queue() {
        let mut successor = committed_queue_entry("b");
        successor.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let queue = vec![committed_queue_entry("a"), successor];
        let mut jam = JamState {
            active: true,
            generation: 5,
            queue: queue.clone(),
            queue_revision: 7,
            queue_control_stopped: true,
            uncertain_skip: Some(UncertainSkipBoundary {
                pre_skip_current_uri: "a".to_string(),
                previous_uri: Some("a".to_string()),
                same_uri_resolution: PreSkipSameUriResolution::NotNeeded,
            }),
            ..JamState::default()
        };

        assert_eq!(jam.queue_revision, 7);
        assert_eq!(jam.queue.len(), queue.len());
        assert_eq!(
            jam.queue[0].track.queue_entry_id,
            queue[0].track.queue_entry_id
        );
        assert_eq!(
            jam.queue[1].track.queue_entry_id,
            queue[1].track.queue_entry_id
        );
        assert!(jam.uncertain_skip.is_some());
        assert!(jam.queue_control_stopped);

        clear_active_jam_state(&mut jam);
        assert!(jam.uncertain_skip.is_none());
    }

    #[test]
    fn skip_from_external_same_uri_unlocks_echo_provenance() {
        let id = "AAAAAAAAAAAAAAAAAAAAAA";
        let uri = format!("spotify:track:{id}");
        let mut queued_echo = committed_queue_entry(&uri);
        queued_echo.track.spotify_id = id.to_string();
        queued_echo.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut queue = vec![queued_echo];

        assert!(same_uri_skip_observation_required(
            &queue,
            Some(&uri),
            Some(&uri),
        ));
        let transition = apply_successful_skip_to_queue(
            &mut queue,
            Some(&uri),
            Some(&uri),
            PreSkipSameUriResolution::AwaitingStillNext,
        );
        assert!(transition.removed.is_none());
        assert!(transition.unlocked_successor);
        let observation = new_history_observation(
            Some(id),
            false,
            Some(id),
            Some(&queue[0].track),
            true,
            false,
        )
        .expect("external-to-Echo same-track skip should become attributable");
        assert!(observation.queued_track.is_some());
    }

    #[test]
    fn unknown_successor_remains_locked_after_observation_and_skip_boundary() {
        let uri = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA";
        let mut unknown = committed_queue_entry(uri);
        unknown.delivery_state = QueueDeliveryState::CommitUnknown;
        unknown.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut queue = vec![unknown];

        assert!(!observe_queue_current_transition(&mut queue, uri, true));
        let transition = apply_successful_skip_to_queue(
            &mut queue,
            Some("external"),
            Some("external"),
            PreSkipSameUriResolution::NotNeeded,
        );
        assert!(transition.removed.is_none());
        assert!(!transition.unlocked_successor);
        assert_eq!(queue[0].delivery_state, QueueDeliveryState::CommitUnknown,);
        assert_eq!(
            queue[0].current_match_state,
            QueueCurrentMatchState::AwaitingTransition,
        );
        assert!(!queue[0].can_remove);
        assert!(committed_queue_track_matching_current(&queue, uri).is_none());
    }

    #[test]
    fn stopped_skip_unlocks_successor_but_keeps_playback_stopped() {
        let mut successor = committed_queue_entry("b");
        successor.current_match_state = QueueCurrentMatchState::AwaitingTransition;
        let mut queue = vec![committed_queue_entry("a"), successor];

        let transition = apply_successful_skip_to_queue(
            &mut queue,
            Some("a"),
            Some("a"),
            PreSkipSameUriResolution::NotNeeded,
        );
        assert!(transition.changed());
        assert_eq!(
            queue[0].current_match_state,
            QueueCurrentMatchState::Eligible,
        );
        assert!(queue_control_stopped_after_skip(false));
    }

    #[test]
    fn queue_mutation_errors_distinguish_definite_rejections_from_ambiguity() {
        assert!(!spotify_mutation_response_is_ambiguous(
            reqwest::StatusCode::BAD_REQUEST
        ));
        assert!(!spotify_mutation_response_is_ambiguous(
            reqwest::StatusCode::UNAUTHORIZED
        ));
        assert!(!spotify_mutation_response_is_ambiguous(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(spotify_mutation_response_is_ambiguous(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ));

        let transport = queue_mutation_request_error(
            StatusCode::BAD_GATEWAY,
            "transport lost".to_string(),
            SpotifyTrackPlacement::QueuedNext,
        );
        assert!(transport.acceptance_ambiguous);
        let pre_send_gate = queue_mutation_request_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "gate unavailable".to_string(),
            SpotifyTrackPlacement::QueuedNext,
        );
        assert!(!pre_send_gate.acceptance_ambiguous);

        let skip_transport =
            skip_mutation_request_error(StatusCode::BAD_GATEWAY, "response lost".to_string());
        assert!(skip_transport.acceptance_ambiguous);
        let skip_rate_limit = skip_mutation_request_error(
            StatusCode::TOO_MANY_REQUESTS,
            "pre-send rate limit".to_string(),
        );
        assert!(!skip_rate_limit.acceptance_ambiguous);
    }

    #[tokio::test]
    async fn required_queue_preflight_preserves_spotify_rate_limit_status() {
        let response = reqwest::Response::from(
            axum::http::Response::builder()
                .status(reqwest::StatusCode::TOO_MANY_REQUESTS)
                .header(reqwest::header::RETRY_AFTER, "17")
                .body("{\"error\":{\"message\":\"slow down\"}}")
                .unwrap(),
        );

        let (status, message) = spotify_response_error(response, "Read Spotify queue").await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert!(message.contains("Spotify 429 Too Many Requests"));
        assert!(message.contains("slow down"));
    }

    #[tokio::test]
    async fn skip_response_classifies_server_failure_as_ambiguous_and_4xx_as_definite() {
        let server_error = reqwest::Response::from(
            axum::http::Response::builder()
                .status(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
                .body("{\"error\":{\"message\":\"uncertain\"}}")
                .unwrap(),
        );
        assert!(
            spotify_skip_mutation_response_error(server_error)
                .await
                .acceptance_ambiguous
        );

        let forbidden = reqwest::Response::from(
            axum::http::Response::builder()
                .status(reqwest::StatusCode::FORBIDDEN)
                .body("{\"error\":{\"message\":\"definite\"}}")
                .unwrap(),
        );
        let forbidden = spotify_skip_mutation_response_error(forbidden).await;
        assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
        assert!(!forbidden.acceptance_ambiguous);
    }

    #[test]
    fn stopped_frontier_resumes_only_for_an_explicit_add() {
        let queue = vec![committed_queue_entry("one"), committed_queue_entry("two")];
        assert!(queue_frontier_candidate(&queue).is_none());
        assert!(stopped_frontier_should_resume(&queue, true, true));
        assert!(!stopped_frontier_should_resume(&queue, true, false));
        assert!(!stopped_frontier_should_resume(&queue, false, true));
        assert!(!stopped_frontier_should_resume(&[], true, true));
    }

    #[test]
    fn queue_entries_serialize_flat_delivery_state_and_removability() {
        let entry = pending_queue_entry_with_id("spotify:track:one", "qe_pending_one");
        let json = serde_json::to_value(entry).unwrap();

        assert_eq!(json["spotify_uri"], "spotify:track:one");
        assert_eq!(json["queue_entry_id"], "qe_pending_one");
        assert_eq!(json["delivery_state"], "pending");
        assert_eq!(json["can_remove"], true);
    }

    #[test]
    fn spotify_queue_frontier_never_selects_more_than_two_or_passes_unknown() {
        let first = committed_queue_entry("one");
        let second = pending_queue_entry_with_id("two", "qe_pending_two");
        let third = pending_queue_entry_with_id("three", "qe_pending_three");
        let queue = vec![first.clone(), second.clone(), third.clone()];
        assert_eq!(
            queue_frontier_candidate(&queue).map(|entry| entry.track.queue_entry_id),
            Some("qe_pending_two".to_string())
        );

        let mut two_committed = queue;
        two_committed[1].delivery_state = QueueDeliveryState::SpotifyCommitted;
        two_committed[1].can_remove = false;
        assert!(queue_frontier_candidate(&two_committed).is_none());

        let mut unknown = vec![first, second, third];
        unknown[0].delivery_state = QueueDeliveryState::CommitUnknown;
        assert!(queue_frontier_candidate(&unknown).is_none());
    }

    #[test]
    fn commit_unknown_blocks_new_admission_but_pending_tail_stays_removable() {
        let mut unknown = committed_queue_entry("one");
        unknown.delivery_state = QueueDeliveryState::CommitUnknown;
        let pending = pending_queue_entry_with_id("two", "qe_pending_behind_unknown");
        let mut jam = JamState {
            queue_revision: 8,
            queue: vec![unknown, pending],
            ..JamState::default()
        };

        assert!(queue_has_commit_unknown(&jam.queue));
        assert!(queue_frontier_candidate(&jam.queue).is_none());
        remove_pending_queue_entries(&mut jam, &["qe_pending_behind_unknown".to_string()])
            .expect("pending tail removal remains available behind the unknown frontier");
        assert_eq!(jam.queue_revision, 9);
        assert_eq!(jam.queue.len(), 1);
        assert_eq!(
            jam.queue[0].delivery_state,
            QueueDeliveryState::CommitUnknown,
        );
    }

    #[test]
    fn bulk_queue_removal_uses_entry_ids_and_preserves_duplicate_occurrences() {
        let mut jam = JamState {
            active: true,
            generation: 7,
            queue_revision: 9,
            queue: vec![
                pending_queue_entry_with_id("same", "qe_duplicate_one"),
                pending_queue_entry_with_id("same", "qe_duplicate_two"),
                pending_queue_entry_with_id("later", "qe_later_three"),
            ],
            ..JamState::default()
        };

        remove_pending_queue_entries(&mut jam, &["qe_duplicate_two".to_string()]).unwrap();

        assert_eq!(jam.queue_revision, 10);
        assert_eq!(jam.queue.len(), 2);
        assert_eq!(jam.queue[0].track.queue_entry_id, "qe_duplicate_one");
        assert_eq!(jam.queue[1].track.queue_entry_id, "qe_later_three");
    }

    #[test]
    fn bulk_queue_removal_is_atomic_when_any_entry_is_committed_or_missing() {
        let pending = pending_queue_entry_with_id("one", "qe_pending_one");
        let mut committed = committed_queue_entry("two");
        committed.track.queue_entry_id = "qe_committed_two".to_string();
        let mut jam = JamState {
            queue_revision: 4,
            queue: vec![pending, committed],
            ..JamState::default()
        };

        assert_eq!(
            remove_pending_queue_entries(
                &mut jam,
                &["qe_pending_one".to_string(), "qe_committed_two".to_string(),],
            ),
            Err(QueueRemovalMutationError::NotRemovable)
        );
        assert_eq!(jam.queue.len(), 2);
        assert_eq!(jam.queue_revision, 4);

        assert_eq!(
            remove_pending_queue_entries(&mut jam, &["qe_missing_three".to_string()]),
            Err(QueueRemovalMutationError::QueueChanged)
        );
        assert_eq!(jam.queue.len(), 2);
        assert_eq!(jam.queue_revision, 4);
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
    fn track_queue_request_id_is_optional_for_legacy_viewers() {
        let legacy: JamQueueRequest = serde_json::from_value(serde_json::json!({
            "generation": 7,
            "spotify_uri": "spotify:track:0VjIjW4GlUZAMYd2vXMi3b",
            "name": "Legacy",
            "artist": "Viewer",
            "album_art_url": "",
            "duration_ms": 123,
        }))
        .unwrap();
        assert_eq!(legacy.request_id, None);

        let modern: JamQueueRequest = serde_json::from_value(serde_json::json!({
            "generation": 7,
            "request_id": "track_request_123",
            "spotify_uri": "spotify:track:0VjIjW4GlUZAMYd2vXMi3b",
            "name": "Modern",
            "artist": "Viewer",
            "album_art_url": "",
            "duration_ms": 123,
        }))
        .unwrap();
        assert_eq!(modern.request_id.as_deref(), Some("track_request_123"));
    }

    #[test]
    fn playlist_queue_selection_is_optional_and_canonical() {
        let all: PlaylistQueueRequest = serde_json::from_value(serde_json::json!({
            "generation": 7,
            "playlist_id": "3n3Ppam7vgaVa1iaRUc9Lp",
            "request_id": "request_123",
        }))
        .unwrap();
        let all_fingerprint = playlist_queue_selection_fingerprint(&all).unwrap();
        assert_eq!(all_fingerprint.selected_positions, None);
        assert_eq!(all_fingerprint.snapshot_id, None);

        let selected: PlaylistQueueRequest = serde_json::from_value(serde_json::json!({
            "generation": 7,
            "playlist_id": "3n3Ppam7vgaVa1iaRUc9Lp",
            "request_id": "request_456",
            "selected_positions": [9, 2, 5],
            "snapshot_id": "snapshot",
        }))
        .unwrap();
        let selected_fingerprint = playlist_queue_selection_fingerprint(&selected).unwrap();
        assert_eq!(selected_fingerprint.selected_positions, Some(vec![2, 5, 9]));
        assert_eq!(
            selected_fingerprint.snapshot_id.as_deref(),
            Some("snapshot")
        );

        let missing_snapshot: PlaylistQueueRequest = serde_json::from_value(serde_json::json!({
            "generation": 7,
            "playlist_id": "3n3Ppam7vgaVa1iaRUc9Lp",
            "request_id": "request_missing_snapshot",
            "selected_positions": [2],
        }))
        .unwrap();
        assert!(playlist_queue_selection_fingerprint(&missing_snapshot).is_err());

        let blank_snapshot: PlaylistQueueRequest = serde_json::from_value(serde_json::json!({
            "generation": 7,
            "playlist_id": "3n3Ppam7vgaVa1iaRUc9Lp",
            "request_id": "request_blank_snapshot",
            "selected_positions": [2],
            "snapshot_id": "   ",
        }))
        .unwrap();
        assert!(playlist_queue_selection_fingerprint(&blank_snapshot).is_err());

        let empty: PlaylistQueueRequest = serde_json::from_value(serde_json::json!({
            "generation": 7,
            "playlist_id": "3n3Ppam7vgaVa1iaRUc9Lp",
            "request_id": "request_789",
            "selected_positions": [],
        }))
        .unwrap();
        assert!(playlist_queue_selection_fingerprint(&empty).is_err());

        let duplicate: PlaylistQueueRequest = serde_json::from_value(serde_json::json!({
            "generation": 7,
            "playlist_id": "3n3Ppam7vgaVa1iaRUc9Lp",
            "request_id": "request_dup",
            "selected_positions": [2, 2],
        }))
        .unwrap();
        assert!(playlist_queue_selection_fingerprint(&duplicate).is_err());
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
        let queued = queued_track_from_summary(
            &summary,
            &actor,
            Some("batch"),
            Some(&playlist),
            Some(12),
            99,
        );
        assert_eq!(queued.name, "Server name");
        assert_eq!(queued.artist, "Server artist");
        assert_eq!(queued.added_by_actor_id, "ea1_actor");
        assert_eq!(queued.added_at_ms, 99);
        assert_eq!(queued.queue_batch_id.as_deref(), Some("batch"));
        assert_eq!(queued.playlist, Some(playlist));
        assert_eq!(queued.playlist_position, Some(12));
    }

    #[test]
    fn queue_control_change_invalidates_cached_playback_mode() {
        assert_eq!(cached_queue_mode(4, 4, Some(true)), Some(true));
        assert_eq!(cached_queue_mode(4, 5, Some(true)), None);
        assert!(enqueue_interrupted_by_stop(4, 5, true));
        assert!(!enqueue_interrupted_by_stop(4, 5, false));
        assert!(!enqueue_interrupted_by_stop(5, 5, true));
        assert!(!queue_control_stopped_after_skip(true));
        assert!(queue_control_stopped_after_skip(false));
    }

    #[test]
    fn stop_admission_fence_survives_a_later_queue_resume() {
        let mut jam = JamState {
            active: true,
            generation: 42,
            spotify_device_id: Some("device-a".to_string()),
            spotify_is_playing: true,
            queue_control_epoch: 7,
            queue_stop_epoch: 11,
            ..JamState::default()
        };
        let slow_add_admission = jam.queue_stop_epoch;

        assert!(apply_spotify_pause_result(
            &mut jam,
            42,
            &spotify_device("device-a", "Echo PC")
        ));
        let post_stop_add_admission = jam.queue_stop_epoch;
        assert!(enqueue_admission_cancelled_by_stop(
            slow_add_admission,
            jam.queue_stop_epoch
        ));

        // A newer explicit add may resume playback, but that must not erase the
        // Stop boundary seen by an older, still-loading playlist expansion.
        jam.queue_control_stopped = false;
        jam.spotify_is_playing = true;
        assert!(enqueue_admission_cancelled_by_stop(
            slow_add_admission,
            jam.queue_stop_epoch
        ));
        assert!(!enqueue_admission_cancelled_by_stop(
            post_stop_add_admission,
            jam.queue_stop_epoch
        ));
    }

    #[test]
    fn playlist_queue_response_serializes_ordered_partial_results_and_failure() {
        let playlist = QueuedPlaylistProvenance {
            spotify_id: "3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
            spotify_uri: "spotify:playlist:3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
            spotify_url: "https://open.spotify.com/playlist/3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
            name: "Server playlist".to_string(),
        };
        let response = PlaylistQueueResponse {
            schema_version: 1,
            ok: false,
            partial: true,
            request_id: "request_123".to_string(),
            queue_batch_id: "batch-1".to_string(),
            batch_id: "batch-1".to_string(),
            generation: 7,
            playlist,
            queued_positions: vec![4, 9],
            remaining_positions: vec![12, 15],
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
        assert_eq!(json["queued_positions"], serde_json::json!([4, 9]));
        assert_eq!(json["remaining_positions"], serde_json::json!([12, 15]));
        assert_eq!(json["skipped_count"], 1);
        assert!(json.get("queued").is_none());
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
                queued_positions: Vec::new(),
                remaining_positions: Vec::new(),
                queued_count: 0,
                skipped: Vec::new(),
                skipped_count: 0,
                complete: true,
                failure: None,
            }
        }
        let mut jam = JamState::default();
        let selection = PlaylistQueueSelectionFingerprint {
            selected_positions: Some(vec![2, 8]),
            snapshot_id: Some("snapshot".to_string()),
        };
        for index in 0..129u64 {
            let request_id = format!("request_{index:03}");
            insert_playlist_queue_receipt(
                &mut jam,
                request_id.clone(),
                PlaylistQueueReceipt {
                    actor_id: "actor".to_string(),
                    playlist_id: "3n3Ppam7vgaVa1iaRUc9Lp".to_string(),
                    selection: selection.clone(),
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
            &selection,
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
            &selection,
            1,
        )
        .is_err());
        let different_selection = PlaylistQueueSelectionFingerprint {
            selected_positions: Some(vec![2, 9]),
            snapshot_id: Some("snapshot".to_string()),
        };
        assert!(playlist_queue_receipt_response(
            &jam,
            "request_128",
            "actor",
            "3n3Ppam7vgaVa1iaRUc9Lp",
            &different_selection,
            1,
        )
        .is_err());
    }

    #[test]
    fn track_receipt_replays_only_the_same_actor_generation_and_track() {
        let mut jam = JamState::default();
        let track =
            pending_queue_entry_with_id("spotify:track:0VjIjW4GlUZAMYd2vXMi3b", "qe_track_receipt");
        insert_track_queue_receipt(
            &mut jam,
            "track_request_123".to_string(),
            TrackQueueReceipt {
                actor_id: "actor".to_string(),
                spotify_id: "0VjIjW4GlUZAMYd2vXMi3b".to_string(),
                generation: 7,
                created_at_ms: 1,
                track: track.clone(),
            },
        );

        assert_eq!(
            track_queue_receipt_response(
                &jam,
                "track_request_123",
                "actor",
                "0VjIjW4GlUZAMYd2vXMi3b",
                7,
            )
            .unwrap()
            .unwrap()
            .track
            .queue_entry_id,
            track.track.queue_entry_id
        );
        assert!(track_queue_receipt_response(
            &jam,
            "track_request_123",
            "other-actor",
            "0VjIjW4GlUZAMYd2vXMi3b",
            7,
        )
        .is_err());
        assert!(track_queue_receipt_response(
            &jam,
            "track_request_123",
            "actor",
            "different-track",
            7,
        )
        .is_err());
        assert!(track_queue_receipt_response(
            &jam,
            "track_request_123",
            "actor",
            "0VjIjW4GlUZAMYd2vXMi3b",
            8,
        )
        .is_err());
    }

    #[test]
    fn queue_removal_receipt_replays_only_the_same_actor_and_fingerprint() {
        let fingerprint = QueueRemovalFingerprint {
            expected_queue_revision: 11,
            queue_entry_ids: vec!["qe_pending_one".to_string(), "qe_pending_two".to_string()],
        };
        let response = JamQueueRemoveResponse {
            ok: true,
            generation: 3,
            queue_revision: 12,
            removed_entry_ids: fingerprint.queue_entry_ids.clone(),
            removed_count: 2,
        };
        let mut jam = JamState::default();
        insert_queue_removal_receipt(
            &mut jam,
            "remove_request_1".to_string(),
            QueueRemovalReceipt {
                actor_id: "actor".to_string(),
                generation: 3,
                fingerprint: fingerprint.clone(),
                created_at_ms: 1,
                response: response.clone(),
            },
        );

        assert_eq!(
            queue_removal_receipt_response(&jam, "remove_request_1", "actor", 3, &fingerprint,)
                .unwrap()
                .unwrap()
                .removed_entry_ids,
            response.removed_entry_ids
        );
        assert!(queue_removal_receipt_response(
            &jam,
            "remove_request_1",
            "other-actor",
            3,
            &fingerprint,
        )
        .is_err());
        let different_revision = QueueRemovalFingerprint {
            expected_queue_revision: 12,
            queue_entry_ids: fingerprint.queue_entry_ids,
        };
        assert!(queue_removal_receipt_response(
            &jam,
            "remove_request_1",
            "actor",
            3,
            &different_revision,
        )
        .is_err());
    }
}
