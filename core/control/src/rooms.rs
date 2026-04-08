use crate::{AppState, ParticipantEntry, JamState, epoch_days_to_date};
use crate::auth::*;
use crate::config::*;
use crate::jam_bot;

use axum::{
    extract::{Json, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tracing::{error, info, warn};

// ── Structs ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct RoomInfo {
    pub(crate) room_id: String,
    pub(crate) created_at: u64,
}

#[derive(Serialize)]
pub(crate) struct RoomStatusEntry {
    pub(crate) room_id: String,
    pub(crate) participants: Vec<RoomStatusParticipant>,
}

#[derive(Serialize)]
pub(crate) struct RoomStatusParticipant {
    pub(crate) identity: String,
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct ParticipantLeaveRequest {
    pub(crate) identity: String,
}

#[derive(Deserialize)]
pub(crate) struct CreateRoomRequest {
    pub(crate) room_id: String,
}

#[derive(Serialize)]
pub(crate) struct MetricsResponse {
    pub(crate) rooms: u64,
    pub(crate) ts: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct SessionEvent {
    pub(crate) event_type: String, // "join" or "leave"
    pub(crate) identity: String,
    pub(crate) name: String,
    pub(crate) room_id: String,
    pub(crate) timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) duration_secs: Option<u64>,
}

// ── Room CRUD ────────────────────────────────────────────────────────

pub(crate) async fn list_rooms(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RoomInfo>>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    Ok(Json(rooms.values().cloned().collect()))
}

pub(crate) async fn create_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateRoomRequest>,
) -> Result<Json<RoomInfo>, StatusCode> {
    ensure_admin(&state, &headers)?;
    if !crate::is_safe_path_component(&payload.room_id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    let entry = rooms.entry(payload.room_id.clone()).or_insert(RoomInfo {
        room_id: payload.room_id.clone(),
        created_at: now_ts(),
    });
    Ok(Json(entry.clone()))
}

pub(crate) async fn get_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(room_id): axum::extract::Path<String>,
) -> Result<Json<RoomInfo>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    match rooms.get(&room_id) {
        Some(info) => Ok(Json(info.clone())),
        None => Err(StatusCode::NOT_FOUND),
    }
}

pub(crate) async fn delete_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(room_id): axum::extract::Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    ensure_admin(&state, &headers)?;
    let mut rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    rooms.remove(&room_id);
    Ok(StatusCode::NO_CONTENT)
}

// ── Room status ──────────────────────────────────────────────────────

pub(crate) async fn rooms_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RoomStatusEntry>>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
    // Group participants by room
    let mut room_map: HashMap<String, Vec<RoomStatusParticipant>> = HashMap::new();
    for p in participants.values() {
        room_map
            .entry(p.room_id.clone())
            .or_default()
            .push(RoomStatusParticipant {
                identity: p.identity.clone(),
                name: p.name.clone(),
            });
    }
    let result: Vec<RoomStatusEntry> = room_map
        .into_iter()
        .map(|(room_id, participants)| RoomStatusEntry {
            room_id,
            participants,
        })
        .collect();
    Ok(Json(result))
}

// ── Participant heartbeat / leave ────────────────────────────────────

pub(crate) async fn participant_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TokenRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let now = now_ts();
    let mut participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = participants.get_mut(&payload.identity) {
        entry.last_seen = now;
        entry.room_id = payload.room.clone();
        if let Some(name) = &payload.name {
            entry.name = name.clone();
        }
        if payload.viewer_version.is_some() {
            entry.viewer_version = payload.viewer_version.clone();
        }
    } else {
        participants.insert(
            payload.identity.clone(),
            ParticipantEntry {
                identity: payload.identity.clone(),
                name: payload.name.clone().unwrap_or_default(),
                room_id: payload.room.clone(),
                last_seen: now,
                viewer_version: payload.viewer_version.clone(),
            },
        );
    }
    drop(participants);

    // Detect first heartbeat = join event
    {
        let mut ja = state.joined_at.lock().unwrap_or_else(|e| e.into_inner());
        if !ja.contains_key(&payload.identity) {
            ja.insert(payload.identity.clone(), now);
            let event = SessionEvent {
                event_type: "join".to_string(),
                identity: payload.identity.clone(),
                name: payload.name.clone().unwrap_or_default(),
                room_id: payload.room.clone(),
                timestamp: now,
                duration_secs: None,
            };
            append_session_event(&state.session_log_dir, &event);
            info!(
                "session: {} ({}) joined {}",
                payload.identity,
                payload.name.clone().unwrap_or_default(),
                payload.room
            );
        }
    }

    // Tell viewer if its version is stale
    let current_stamp = state.viewer_stamp.read().unwrap_or_else(|e| e.into_inner()).clone();
    let stale = match &payload.viewer_version {
        Some(v) => *v != current_stamp,
        None => true,
    };
    Ok(Json(serde_json::json!({ "stale": stale })))
}

pub(crate) async fn participant_leave(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ParticipantLeaveRequest>,
) -> Result<StatusCode, StatusCode> {
    ensure_admin(&state, &headers)?;

    // Log leave event
    let now = now_ts();
    {
        let participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = participants.get(&payload.identity) {
            let join_time = {
                let mut ja = state.joined_at.lock().unwrap_or_else(|e| e.into_inner());
                ja.remove(&payload.identity)
            };
            let duration = join_time.map(|jt| now.saturating_sub(jt));
            let event = SessionEvent {
                event_type: "leave".to_string(),
                identity: entry.identity.clone(),
                name: entry.name.clone(),
                room_id: entry.room_id.clone(),
                timestamp: now,
                duration_secs: duration,
            };
            append_session_event(&state.session_log_dir, &event);
            info!(
                "session: {} ({}) left {}",
                entry.identity, entry.name, entry.room_id
            );
        }
    }
    // Also remove client stats
    {
        let mut cs = state.client_stats.lock().unwrap_or_else(|e| e.into_inner());
        cs.remove(&payload.identity);
    }

    let mut participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
    participants.remove(&payload.identity);

    // Also remove from jam listeners
    let should_auto_end = {
        let mut jam = state.jam.lock().unwrap_or_else(|e| e.into_inner());
        if jam.active {
            let base = identity_base(&payload.identity);
            let before = jam.listeners.len();
            jam.listeners.retain(|l| identity_base(l) != base);
            if jam.listeners.len() < before {
                info!(
                    "Jam: removed leaving participant {} from listeners",
                    payload.identity
                );
            }
        }
        jam.active && jam.listeners.is_empty()
    };
    if should_auto_end {
        schedule_jam_auto_end(state.jam.clone(), state.jam_bot.clone(), "participant left");
    }

    Ok(StatusCode::NO_CONTENT)
}

// ── Metrics / ICE servers ────────────────────────────────────────────

pub(crate) async fn metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MetricsResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    Ok(Json(MetricsResponse {
        rooms: rooms.len() as u64,
        ts: now_ts(),
    }))
}

pub(crate) async fn ice_servers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let mut servers = vec![
        serde_json::json!({ "urls": "stun:stun.l.google.com:19302" }),
        serde_json::json!({ "urls": "stun:stun1.l.google.com:19302" }),
    ];

    if let (Some(user), Some(pass)) = (&state.config.turn_user, &state.config.turn_pass) {
        let host = state.config.turn_host.as_deref().unwrap_or("127.0.0.1");
        let url = format!("turn:{}:{}?transport=udp", host, state.config.turn_port);
        servers.push(serde_json::json!({
            "urls": url,
            "username": user,
            "credential": pass,
        }));
    }

    Ok(Json(serde_json::json!({ "iceServers": servers })))
}

// ── Admin: kick / mute ───────────────────────────────────────────────

pub(crate) fn livekit_service_token(api_key: &str, api_secret: &str, room: &str) -> Result<String, StatusCode> {
    #[derive(Serialize)]
    struct ServiceClaims {
        iss: String,
        sub: String,
        iat: usize,
        exp: usize,
        video: ServiceGrant,
    }
    #[derive(Serialize)]
    #[allow(non_snake_case)]
    struct ServiceGrant {
        roomAdmin: bool,
        roomList: bool,
        roomCreate: bool,
        room: String,
    }
    let now = now_ts();
    let claims = ServiceClaims {
        iss: api_key.to_string(),
        sub: String::new(),
        iat: now as usize,
        exp: (now + 60) as usize,
        video: ServiceGrant {
            roomAdmin: true,
            roomList: true,
            roomCreate: true,
            room: room.to_string(),
        },
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(api_secret.as_bytes()),
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// ── LiveKit twirp RPC helpers ────────────────────────────────────────
//
// Used by admin_kick_participant (single kick) and admin_force_reload (nuclear).
// All call LiveKit's twirp API directly via reqwest with a service token.

fn livekit_sfu_url() -> String {
    std::env::var("CORE_SFU_HTTP").unwrap_or_else(|_| "http://127.0.0.1:7880".to_string())
}

/// Call LiveKit ListRooms. Returns the room names known to the SFU.
/// This is the source of truth — the control plane's tracked room map can drift
/// (e.g. ghost screen-share publishers in a room the control plane forgot about).
pub(crate) async fn livekit_list_rooms(state: &AppState) -> Result<Vec<String>, String> {
    let token = livekit_service_token(
        &state.config.livekit_api_key,
        &state.config.livekit_api_secret,
        "*",
    )
    .map_err(|_| "service token build failed".to_string())?;
    let sfu = livekit_sfu_url();
    let resp = state
        .http_client
        .post(format!("{}/twirp/livekit.RoomService/ListRooms", sfu))
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("ListRooms request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("ListRooms HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("ListRooms parse failed: {}", e))?;
    let rooms = body
        .get("rooms")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| r.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(rooms)
}

/// Call LiveKit ListParticipants for a given room. Returns identity strings
/// (including `$screen` companion publishers, which the control plane filters
/// out of its dashboard but which still hold media tracks in the SFU).
pub(crate) async fn livekit_list_participants(
    state: &AppState,
    room: &str,
) -> Result<Vec<String>, String> {
    let token = livekit_service_token(
        &state.config.livekit_api_key,
        &state.config.livekit_api_secret,
        room,
    )
    .map_err(|_| "service token build failed".to_string())?;
    let sfu = livekit_sfu_url();
    let resp = state
        .http_client
        .post(format!("{}/twirp/livekit.RoomService/ListParticipants", sfu))
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "room": room }))
        .send()
        .await
        .map_err(|e| format!("ListParticipants request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("ListParticipants HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("ListParticipants parse failed: {}", e))?;
    let identities = body
        .get("participants")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    p.get("identity")
                        .and_then(|i| i.as_str())
                        .map(|s| s.to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(identities)
}

/// Call LiveKit RemoveParticipant. Returns Ok(true) on success, Ok(false) if the
/// participant was not in the room (404 — already gone), Err on other failures.
pub(crate) async fn livekit_remove_participant(
    state: &AppState,
    room: &str,
    identity: &str,
) -> Result<bool, String> {
    let token = livekit_service_token(
        &state.config.livekit_api_key,
        &state.config.livekit_api_secret,
        room,
    )
    .map_err(|_| "service token build failed".to_string())?;
    let sfu = livekit_sfu_url();
    let resp = state
        .http_client
        .post(format!(
            "{}/twirp/livekit.RoomService/RemoveParticipant",
            sfu
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "room": room, "identity": identity }))
        .send()
        .await
        .map_err(|e| format!("RemoveParticipant request failed: {}", e))?;
    if resp.status().is_success() {
        return Ok(true);
    }
    if resp.status().as_u16() == 404 {
        return Ok(false); // already gone — not an error
    }
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    Err(format!("RemoveParticipant HTTP {}: {}", status, body))
}

/// POST /v1/rooms/:room_id/kick/:identity — Remove a participant from a room.
///
/// Also kicks `{identity}$screen` if present, since the screen-share companion
/// is a separate LiveKit participant that won't be removed by kicking the parent.
/// Without this, dropped clients leave behind ghost screen-share publishers that
/// keep streaming until LiveKit's idle timeout.
pub(crate) async fn admin_kick_participant(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path((room_id, identity)): axum::extract::Path<(String, String)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    info!("ADMIN KICK: room={} identity={}", room_id, identity);

    // Kick main identity
    let main_kicked = livekit_remove_participant(&state, &room_id, &identity)
        .await
        .map_err(|e| {
            error!("kick {} failed: {}", identity, e);
            StatusCode::BAD_GATEWAY
        })?;

    // Best-effort: also kick the $screen companion. Ignore "not found" since
    // most participants don't have one.
    let screen_identity = format!("{}$screen", identity);
    let screen_kicked = livekit_remove_participant(&state, &room_id, &screen_identity)
        .await
        .unwrap_or(false);
    if screen_kicked {
        info!("ADMIN KICK: also removed companion {}", screen_identity);
    }

    // Remove from our local participant tracking
    {
        let mut participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
        participants.retain(|_, p| p.identity != identity);
    }

    info!(
        "ADMIN KICK success: {} from {} (main_kicked={}, screen_kicked={})",
        identity, room_id, main_kicked, screen_kicked
    );
    Ok(Json(serde_json::json!({
        "ok": true,
        "main_kicked": main_kicked,
        "screen_kicked": screen_kicked,
    })))
}

/// POST /v1/rooms/:room_id/mute/:identity — Mute all published tracks for a participant
pub(crate) async fn admin_mute_participant(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path((room_id, identity)): axum::extract::Path<(String, String)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    info!("ADMIN MUTE: room={} identity={}", room_id, identity);

    let sfu_url =
        std::env::var("CORE_SFU_HTTP").unwrap_or_else(|_| "http://127.0.0.1:7880".to_string());
    let token = livekit_service_token(
        &state.config.livekit_api_key,
        &state.config.livekit_api_secret,
        &room_id,
    )?;

    // First, get participant info to find their track SIDs
    let resp = state
        .http_client
        .post(format!(
            "{}/twirp/livekit.RoomService/GetParticipant",
            sfu_url
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "room": room_id,
            "identity": identity,
        }))
        .send()
        .await
        .map_err(|e| {
            error!("get participant SFU call failed: {}", e);
            StatusCode::BAD_GATEWAY
        })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        error!("SFU GetParticipant failed ({}): {}", status, body);
        return Err(StatusCode::BAD_GATEWAY);
    }

    let participant_data: serde_json::Value = resp.json().await.map_err(|e| {
        error!("parse participant response: {}", e);
        StatusCode::BAD_GATEWAY
    })?;

    // Mute each published track (audio tracks)
    let tracks = participant_data["tracks"].as_array();
    let mut muted_count = 0u32;
    if let Some(tracks) = tracks {
        for track in tracks {
            let track_sid = track["sid"].as_str().unwrap_or("");
            let track_type = track["type"].as_str().unwrap_or("");
            // Mute audio tracks (AUDIO = mic)
            if track_type == "AUDIO" && !track_sid.is_empty() {
                let mute_token = livekit_service_token(
                    &state.config.livekit_api_key,
                    &state.config.livekit_api_secret,
                    &room_id,
                )?;
                let mute_resp = state
                    .http_client
                    .post(format!(
                        "{}/twirp/livekit.RoomService/MutePublishedTrack",
                        sfu_url
                    ))
                    .header("Authorization", format!("Bearer {}", mute_token))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "room": room_id,
                        "identity": identity,
                        "track_sid": track_sid,
                        "muted": true,
                    }))
                    .send()
                    .await;
                match mute_resp {
                    Ok(r) if r.status().is_success() => muted_count += 1,
                    Ok(r) => {
                        error!("mute track {} failed: {}", track_sid, r.status());
                    }
                    Err(e) => {
                        error!("mute track {} error: {}", track_sid, e);
                    }
                }
            }
        }
    }

    info!(
        "ADMIN MUTE success: {} in {} — muted {} tracks",
        identity, room_id, muted_count
    );
    Ok(Json(
        serde_json::json!({ "ok": true, "muted_tracks": muted_count }),
    ))
}

// ── Session event logging ────────────────────────────────────────────

pub(crate) fn append_session_event(dir: &std::path::Path, event: &SessionEvent) {
    // File per day: sessions-YYYY-MM-DD.json
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days_since_epoch = now / 86400;
    // Calculate date from epoch days
    let (year, month, day) = epoch_days_to_date(days_since_epoch);
    let file_name = format!("sessions-{:04}-{:02}-{:02}.json", year, month, day);
    let file_path = dir.join(&file_name);

    // Read existing events, append, write back
    let mut events: Vec<SessionEvent> = if let Ok(data) = fs::read_to_string(&file_path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };
    events.push(event.clone());

    if let Ok(json) = serde_json::to_string_pretty(&events) {
        let _ = fs::write(&file_path, json);
    }
}

// ── Jam auto-end helper (used by participant_leave and cleanup task) ──

pub(crate) fn schedule_jam_auto_end(
    jam_state: Arc<Mutex<JamState>>,
    jam_bot: Arc<tokio::sync::Mutex<Option<jam_bot::JamBot>>>,
    reason: &'static str,
) {
    tokio::spawn(async move {
        info!("Jam auto-end ({}): no listeners, waiting 30s...", reason);
        tokio::time::sleep(Duration::from_secs(30)).await;
        let should_stop = {
            let mut jam = jam_state.lock().unwrap_or_else(|e| e.into_inner());
            if jam.active && jam.listeners.is_empty() {
                jam.active = false;
                jam.queue.clear();
                jam.listeners.clear();
                jam.now_playing = None;
                info!("Jam auto-ended ({}): no listeners for 30s", reason);
                true
            } else {
                info!(
                    "Jam auto-end cancelled: {} listeners now",
                    jam.listeners.len()
                );
                false
            }
        };
        if should_stop {
            if let Some(bot) = jam_bot.lock().await.take() {
                bot.stop().await;
            }
        }
    });
}
