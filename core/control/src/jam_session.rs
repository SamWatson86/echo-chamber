use crate::auth::{ensure_admin, AdminClaims};
use crate::config::*;
use crate::rooms::schedule_jam_auto_end;
use crate::AppState;

use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::{
    extract::{Json, Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse},
};
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tracing::{info, warn};

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
    pub(crate) host_identity: String,
    pub(crate) spotify_token: Option<SpotifyToken>,
    pub(crate) queue: Vec<QueuedTrack>,
    pub(crate) now_playing: Option<NowPlayingInfo>,
    pub(crate) listeners: HashSet<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct QueuedTrack {
    pub(crate) spotify_uri: String,
    pub(crate) name: String,
    pub(crate) artist: String,
    pub(crate) album_art_url: String,
    pub(crate) duration_ms: u64,
    pub(crate) added_by: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct NowPlayingInfo {
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
    spotify_uri: String,
    name: String,
    artist: String,
    album_art_url: String,
    duration_ms: u64,
    added_by: String,
}

#[derive(Deserialize)]
pub(crate) struct JamIdentityRequest {
    identity: String,
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
    let scopes = "user-read-private user-modify-playback-state user-read-currently-playing user-read-playback-state";
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

    persist_spotify_token(&state.spotify_token_file, &token);
    info!("Spotify token stored and persisted to disk");
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) fn persist_spotify_token(path: &std::path::Path, token: &SpotifyToken) {
    match serde_json::to_string_pretty(token) {
        Ok(json) => {
            if let Err(e) = fs::write(path, &json) {
                warn!("Failed to persist Spotify token: {}", e);
            } else {
                info!("Spotify token persisted to {:?}", path);
            }
        }
        Err(e) => warn!("Failed to serialize Spotify token: {}", e),
    }
}

// ── Spotify API proxy helper ─────────────────────────────────────────────

async fn spotify_api_request(
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

    let resp = req
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

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
            return retry
                .send()
                .await
                .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()));
        }
    }

    Ok(resp)
}

async fn refresh_spotify_token(state: &AppState, old: &SpotifyToken) -> Option<SpotifyToken> {
    let resp = state
        .http_client
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &old.refresh_token),
            ("client_id", &state.spotify_client_id),
        ])
        .send()
        .await
        .ok()?;

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

    let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
    jam.spotify_token = Some(new_token.clone());
    persist_spotify_token(&state.spotify_token_file, &new_token);
    info!("Spotify token refreshed and persisted");
    Some(new_token)
}

// ── Jam Session endpoints ────────────────────────────────────────────────

/// Stop the jam audio bot if it's running.
pub(crate) async fn stop_jam_bot(state: &AppState) {
    let bot = state.jam_bot.lock().await.take();
    if let Some(bot) = bot {
        bot.stop().await;
    }
}

pub(crate) async fn jam_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamStartRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if jam.spotify_token.is_none() {
            return Err(StatusCode::BAD_REQUEST);
        }
        jam.active = true;
        jam.host_identity = payload.identity.clone();
        jam.listeners.insert(payload.identity);
        info!(
            "Jam session started by {} (auto-joined as listener)",
            jam.host_identity
        );
    }

    // Spawn the audio bot in background (don't block the response)
    let bot_state = state.clone();
    tokio::spawn(async move {
        match crate::jam_bot::JamBot::start().await {
            Ok(bot) => {
                info!("Jam audio bot started successfully");
                *bot_state.jam_bot.lock().await = Some(bot);
            }
            Err(e) => {
                warn!("Jam audio bot failed to start: {}", e);
            }
        }
    });

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn jam_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamIdentityRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());

        // Only the host (or auto-end) can stop the jam
        // Compare base identities (strip -XXXX suffix) since reconnects change the suffix
        if !payload.identity.is_empty()
            && identity_base(&payload.identity) != identity_base(&jam.host_identity)
        {
            info!(
                "Jam stop denied: {} is not host {}",
                payload.identity, jam.host_identity
            );
            return Err(StatusCode::FORBIDDEN);
        }

        jam.active = false;
        jam.queue.clear();
        jam.listeners.clear();
        jam.now_playing = None;
        info!(
            "Jam session stopped by {}",
            if payload.identity.is_empty() {
                "auto-end"
            } else {
                &payload.identity
            }
        );
    }

    // Stop the audio bot
    stop_jam_bot(&state).await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn jam_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    // Check if we need to refresh now_playing from Spotify
    let should_fetch = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !jam.active || jam.spotify_token.is_none() {
            false
        } else {
            match &jam.now_playing {
                None => true,
                Some(np) => match np.fetched_at {
                    None => true,
                    Some(t) => t.elapsed() > Duration::from_secs(5),
                },
            }
        }
    };

    if should_fetch {
        let resp_result = spotify_api_request(
            &state,
            reqwest::Method::GET,
            "https://api.spotify.com/v1/me/player/currently-playing",
            None,
        )
        .await;

        if let Ok(resp) = resp_result {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    let item = &data["item"];
                    let current_uri = item["uri"].as_str().unwrap_or("").to_string();
                    let np = NowPlayingInfo {
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
                    // Auto-remove played songs from queue: if the currently playing
                    // track doesn't match the front of the queue, that song has
                    // finished and should be removed.
                    if !current_uri.is_empty() && !jam.queue.is_empty() {
                        // Only auto-remove queue[0] if the currently playing
                        // track exists later in the queue — that means queue[0]
                        // has finished and Spotify advanced. Without this guard
                        // the while-loop would drain the ENTIRE queue whenever
                        // Spotify plays something not in the queue at all.
                        let current_in_queue = jam.queue.iter().any(|t| t.spotify_uri == current_uri);
                        if current_in_queue {
                            while !jam.queue.is_empty()
                                && jam.queue[0].spotify_uri != current_uri
                            {
                                let removed = jam.queue.remove(0);
                                info!(
                                    "Jam: auto-removed finished track '{}' from queue",
                                    removed.name
                                );
                            }
                        }
                    }
                    jam.now_playing = Some(np);
                }
            }
        }
    }

    // Build response (extract all data from std::sync::Mutex before awaiting)
    let (active, host_identity, queue, now_playing, listeners, spotify_connected) = {
        let jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        (
            jam.active,
            jam.host_identity.clone(),
            jam.queue.clone(),
            jam.now_playing.clone(),
            jam.listeners.iter().cloned().collect::<Vec<String>>(),
            jam.spotify_token.is_some(),
        )
    };
    let listener_count = listeners.len();
    let bot_connected = state.jam_bot.lock().await.is_some();

    Ok(Json(serde_json::json!({
        "active": active,
        "host_identity": host_identity,
        "queue": queue,
        "now_playing": now_playing,
        "listeners": listeners,
        "listener_count": listener_count,
        "spotify_connected": spotify_connected,
        "bot_connected": bot_connected,
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

pub(crate) async fn jam_queue_add(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamQueueRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let track = QueuedTrack {
        spotify_uri: payload.spotify_uri.clone(),
        name: payload.name,
        artist: payload.artist,
        album_art_url: payload.album_art_url,
        duration_ms: payload.duration_ms,
        added_by: payload.added_by,
    };

    {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        jam.queue.push(track);
    }

    // Check if Spotify is currently playing
    let is_playing = {
        let resp = spotify_api_request(
            &state,
            reqwest::Method::GET,
            "https://api.spotify.com/v1/me/player/currently-playing",
            None,
        )
        .await;
        match resp {
            Ok(r) if r.status().is_success() => {
                if let Ok(data) = r.json::<serde_json::Value>().await {
                    data["is_playing"].as_bool().unwrap_or(false)
                } else {
                    false
                }
            }
            _ => false,
        }
    };

    if is_playing {
        // Already playing — add to Spotify's queue so it auto-plays after current track
        let queue_url = format!(
            "https://api.spotify.com/v1/me/player/queue?uri={}",
            urlencoded(&payload.spotify_uri)
        );
        match spotify_api_request(&state, reqwest::Method::POST, &queue_url, None).await {
            Ok(r) => {
                let status = r.status();
                if status.is_success() || status.as_u16() == 204 {
                    info!(
                        "Track queued to Spotify ({}): {}",
                        status, payload.spotify_uri
                    );
                } else {
                    let body = r.text().await.unwrap_or_default();
                    warn!(
                        "Queue to Spotify failed ({}) {}: {}",
                        status, payload.spotify_uri, body
                    );
                }
            }
            Err(e) => warn!("Queue request failed: {:?}", e),
        }
    } else {
        // Nothing playing — find an active device first
        info!("Spotify not playing — finding device to start playback");
        let device_id = match spotify_api_request(
            &state,
            reqwest::Method::GET,
            "https://api.spotify.com/v1/me/player/devices",
            None,
        )
        .await
        {
            Ok(r) if r.status().is_success() => {
                if let Ok(data) = r.json::<serde_json::Value>().await {
                    info!("Spotify devices response: {}", data);
                    data["devices"]
                        .as_array()
                        .and_then(|devs| {
                            devs.iter()
                                .find(|d| d["is_active"].as_bool().unwrap_or(false))
                        })
                        .or_else(|| data["devices"].as_array().and_then(|devs| devs.first()))
                        .and_then(|d| d["id"].as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            }
            Ok(r) => {
                warn!("Spotify devices request failed: {}", r.status());
                None
            }
            Err(e) => {
                warn!("Spotify devices error: {:?}", e);
                None
            }
        };

        let play_url = if let Some(ref did) = device_id {
            format!(
                "https://api.spotify.com/v1/me/player/play?device_id={}",
                did
            )
        } else {
            "https://api.spotify.com/v1/me/player/play".to_string()
        };

        let play_body = serde_json::json!({ "uris": [payload.spotify_uri] });
        match spotify_api_request(&state, reqwest::Method::PUT, &play_url, Some(play_body)).await {
            Ok(r) => {
                let status = r.status();
                if status.is_success() || status.as_u16() == 204 {
                    info!("Track started playing: {}", payload.spotify_uri);
                } else {
                    let body = r.text().await.unwrap_or_default();
                    warn!("Play failed ({}): {}", status, body);
                }
            }
            Err(e) => warn!("Play request failed: {:?}", e),
        }
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn jam_queue_remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let index = payload["index"].as_u64().ok_or(StatusCode::BAD_REQUEST)? as usize;
    let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
    if index < jam.queue.len() {
        let removed = jam.queue.remove(index);
        info!(
            "Removed from queue: {} by {}",
            removed.name, removed.added_by
        );
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

pub(crate) async fn jam_skip(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    // Skip on Spotify
    match spotify_api_request(
        &state,
        reqwest::Method::POST,
        "https://api.spotify.com/v1/me/player/next",
        None,
    )
    .await
    {
        Ok(r) => {
            let status = r.status();
            if status.is_success() || status.as_u16() == 204 {
                info!("Jam: skip succeeded ({})", status);
            } else {
                let body = r.text().await.unwrap_or_default();
                warn!("Jam: skip failed ({}) {}", status, body);
            }
        }
        Err(e) => warn!("Jam: skip request error: {:?}", e),
    }

    // Remove first item from our queue
    {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if !jam.queue.is_empty() {
            let removed = jam.queue.remove(0);
            info!("Jam: removed '{}' from queue", removed.name);
        }
        // Clear now_playing so it gets re-fetched
        jam.now_playing = None;
    }

    info!("Jam: skipped track");
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn jam_join(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamIdentityRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
    jam.listeners.insert(payload.identity.clone());
    info!("Jam: {} joined", payload.identity);
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn jam_leave(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<JamIdentityRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let should_auto_end = {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        jam.listeners.remove(&payload.identity);
        info!(
            "Jam: {} left ({} listeners remain)",
            payload.identity,
            jam.listeners.len()
        );
        jam.active && jam.listeners.is_empty()
    };

    if should_auto_end {
        schedule_jam_auto_end(state.jam.clone(), state.jam_bot.clone(), "listener left");
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── WebSocket audio streaming ────────────────────────────────────────────

/// WebSocket endpoint for streaming jam audio to viewers.
/// Clients connect to wss://host:9443/api/jam/audio?token=JWT and receive
/// binary messages containing raw f32 PCM (48 kHz stereo, 20 ms frames).
pub(crate) async fn jam_audio_ws(
    ws: WebSocketUpgrade,
    Query(params): Query<std::collections::HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, StatusCode> {
    // Validate JWT from query param (WebSocket API doesn't support custom headers)
    let token = params.get("token").ok_or(StatusCode::UNAUTHORIZED)?;
    let validation = Validation::default();
    let decoded = decode::<AdminClaims>(
        token,
        &DecodingKey::from_secret(state.config.admin_jwt_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| StatusCode::UNAUTHORIZED)?;
    if decoded.claims.role != "admin" {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(ws.on_upgrade(move |socket| jam_audio_ws_handler(socket, state)))
}

async fn jam_audio_ws_handler(mut socket: WebSocket, state: AppState) {
    use axum::extract::ws::Message;

    info!("[jam-audio-ws] client connected");

    // Get a broadcast receiver from the running bot
    let mut rx = {
        let bot_guard = state.jam_bot.lock().await;
        match &*bot_guard {
            Some(bot) => bot.subscribe(),
            None => {
                // No bot running — close with a message
                let _ = socket.send(Message::Close(None)).await;
                info!("[jam-audio-ws] no jam bot running, closing");
                return;
            }
        }
    };

    // Stream frames to the WebSocket client
    loop {
        tokio::select! {
            // Receive audio frame from broadcast channel
            frame_result = rx.recv() => {
                match frame_result {
                    Ok(frame) => {
                        // Convert Vec<f32> to raw little-endian bytes
                        let bytes: Vec<u8> = frame.data.iter()
                            .flat_map(|s| s.to_le_bytes())
                            .collect();
                        if socket.send(Message::Binary(bytes.into())).await.is_err() {
                            break; // Client disconnected
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        // Client too slow, skip old frames
                        warn!("[jam-audio-ws] client lagged, dropped {} frames", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // Bot stopped — send close
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
            // Check for incoming messages (client close, etc.)
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {} // Ignore other messages
                }
            }
        }
    }

    info!("[jam-audio-ws] client disconnected");
}
