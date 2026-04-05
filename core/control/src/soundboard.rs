use crate::AppState;
use crate::auth::*;
use crate::config::*;

use axum::{
    body::Bytes,
    extract::{Json, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
};
use tracing::{info, warn};

// ── Structs ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct SoundboardState {
    pub(crate) dir: PathBuf,
    pub(crate) max_bytes: usize,
    pub(crate) max_sounds_per_room: usize,
    pub(crate) rooms: HashMap<String, HashMap<String, SoundboardSound>>,
    pub(crate) index: HashMap<String, SoundboardSound>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct SoundboardSound {
    pub(crate) id: String,
    #[serde(rename = "roomId")]
    pub(crate) room_id: String,
    pub(crate) name: String,
    #[serde(default = "default_soundboard_icon")]
    pub(crate) icon: String,
    #[serde(default = "default_soundboard_volume")]
    pub(crate) volume: u16,
    #[serde(rename = "fileName")]
    pub(crate) file_name: String,
    #[serde(default)]
    pub(crate) mime: Option<String>,
    #[serde(rename = "uploadedAt", default)]
    pub(crate) uploaded_at: u64,
}

#[derive(Serialize)]
pub(crate) struct SoundboardPublic {
    pub(crate) id: String,
    #[serde(rename = "roomId")]
    pub(crate) room_id: String,
    pub(crate) name: String,
    pub(crate) icon: String,
    pub(crate) volume: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SoundboardListQuery {
    pub(crate) room_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SoundboardUploadQuery {
    pub(crate) room_id: String,
    pub(crate) name: Option<String>,
    pub(crate) icon: Option<String>,
    pub(crate) volume: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SoundboardUpdateRequest {
    pub(crate) room_id: String,
    pub(crate) sound_id: String,
    pub(crate) name: Option<String>,
    pub(crate) icon: Option<String>,
    pub(crate) volume: Option<u16>,
}

#[derive(Serialize)]
pub(crate) struct SoundboardListResponse {
    pub(crate) ok: bool,
    pub(crate) sounds: Vec<SoundboardPublic>,
}

#[derive(Serialize)]
pub(crate) struct SoundboardSoundResponse {
    pub(crate) ok: bool,
    pub(crate) sound: Option<SoundboardPublic>,
    pub(crate) error: Option<String>,
}

// ── Defaults (used by serde) ─────────────────────────────────────────

pub(crate) fn default_soundboard_icon() -> String {
    "\u{1F50A}".to_string()
}

pub(crate) fn default_soundboard_volume() -> u16 {
    100
}

// ── Helper functions ─────────────────────────────────────────────────

pub(crate) fn soundboard_public(sound: &SoundboardSound) -> SoundboardPublic {
    SoundboardPublic {
        id: sound.id.clone(),
        room_id: sound.room_id.clone(),
        name: sound.name.clone(),
        icon: sound.icon.clone(),
        volume: sound.volume,
    }
}

fn soundboard_meta_path(dir: &PathBuf) -> PathBuf {
    dir.join("soundboard.json")
}

fn soundboard_room_dir(dir: &PathBuf, room_id: &str) -> PathBuf {
    let safe = if crate::is_safe_path_component(room_id) { room_id } else { "_invalid" };
    dir.join(safe)
}

fn soundboard_file_path(dir: &PathBuf, room_id: &str, file_name: &str) -> PathBuf {
    let safe_name = if crate::is_safe_path_component(file_name) { file_name } else { "_invalid" };
    soundboard_room_dir(dir, room_id).join(safe_name)
}

pub(crate) fn load_soundboard(state: &mut SoundboardState) {
    let _ = fs::create_dir_all(&state.dir);
    let meta = soundboard_meta_path(&state.dir);
    if !meta.exists() {
        return;
    }
    let contents = match fs::read_to_string(&meta) {
        Ok(text) => text,
        Err(err) => {
            warn!("soundboard load failed: {}", err);
            return;
        }
    };
    let sounds: Vec<SoundboardSound> = match serde_json::from_str(&contents) {
        Ok(list) => list,
        Err(err) => {
            warn!("soundboard parse failed: {}", err);
            return;
        }
    };
    for mut sound in sounds {
        if sound.icon.trim().is_empty() {
            sound.icon = default_soundboard_icon();
        }
        let file_path = soundboard_file_path(&state.dir, &sound.room_id, &sound.file_name);
        if !file_path.exists() {
            continue;
        }
        state
            .rooms
            .entry(sound.room_id.clone())
            .or_insert_with(HashMap::new)
            .insert(sound.id.clone(), sound.clone());
        state.index.insert(sound.id.clone(), sound);
    }
    info!("soundboard loaded ({} sounds)", state.index.len());
}

fn persist_soundboard(state: &SoundboardState) {
    let sounds: Vec<SoundboardSound> = state.index.values().cloned().collect();
    let meta = soundboard_meta_path(&state.dir);
    match serde_json::to_string_pretty(&sounds) {
        Ok(payload) => {
            if let Err(err) = fs::write(&meta, payload) {
                warn!("soundboard persist failed: {}", err);
            }
        }
        Err(err) => {
            warn!("soundboard persist failed: {}", err);
        }
    }
}

// ── API handlers ─────────────────────────────────────────────────────

pub(crate) async fn soundboard_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SoundboardListQuery>,
) -> Result<Json<SoundboardListResponse>, StatusCode> {
    ensure_livekit(&state, &headers)?;
    let board = state.soundboard.lock().unwrap_or_else(|e| e.into_inner());
    let sounds = board
        .rooms
        .get(&query.room_id)
        .map(|room| room.values().cloned().collect::<Vec<_>>())
        .unwrap_or_else(Vec::new);
    let payload = SoundboardListResponse {
        ok: true,
        sounds: sounds.iter().map(soundboard_public).collect(),
    };
    Ok(Json(payload))
}

pub(crate) async fn soundboard_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(sound_id): Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    ensure_livekit(&state, &headers)?;
    let board = state.soundboard.lock().unwrap_or_else(|e| e.into_inner());
    let Some(sound) = board.index.get(&sound_id) else {
        return Err(StatusCode::NOT_FOUND);
    };
    let path = soundboard_file_path(&board.dir, &sound.room_id, &sound.file_name);
    let bytes = fs::read(path).map_err(|_| StatusCode::NOT_FOUND)?;
    let mut response = axum::response::Response::new(axum::body::Body::from(bytes));
    let mime = sound
        .mime
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    Ok(response)
}

pub(crate) async fn soundboard_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SoundboardUploadQuery>,
    body: Bytes,
) -> Result<Json<SoundboardSoundResponse>, StatusCode> {
    ensure_livekit(&state, &headers)?;
    if query.room_id.trim().is_empty() {
        return Ok(Json(SoundboardSoundResponse {
            ok: false,
            sound: None,
            error: Some("Missing roomId".into()),
        }));
    }
    if body.is_empty() {
        return Ok(Json(SoundboardSoundResponse {
            ok: false,
            sound: None,
            error: Some("Empty audio payload".into()),
        }));
    }
    let mut board = state.soundboard.lock().unwrap_or_else(|e| e.into_inner());
    if body.len() > board.max_bytes {
        return Ok(Json(SoundboardSoundResponse {
            ok: false,
            sound: None,
            error: Some("Audio file too large".into()),
        }));
    }
    let max_sounds = board.max_sounds_per_room;
    let room_id = query.room_id.clone();
    let board_dir = board.dir.clone();
    let room = board
        .rooms
        .entry(room_id.clone())
        .or_insert_with(HashMap::new);
    if room.len() >= max_sounds {
        return Ok(Json(SoundboardSoundResponse {
            ok: false,
            sound: None,
            error: Some("Soundboard is full for this room".into()),
        }));
    }

    let id = random_secret();
    let name = query.name.unwrap_or_else(|| "Sound".to_string());
    let icon = query.icon.unwrap_or_else(default_soundboard_icon);
    let volume = query.volume.unwrap_or(default_soundboard_volume());
    let mime = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let ext = match mime.as_deref().unwrap_or("") {
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/webm" => "webm",
        "audio/mp4" => "mp4",
        _ => "bin",
    };
    let file_name = format!("{}.{}", id, ext);
    let room_dir = soundboard_room_dir(&board_dir, &room_id);
    let _ = fs::create_dir_all(&room_dir);
    let file_path = room_dir.join(&file_name);
    if let Err(err) = fs::write(&file_path, &body) {
        warn!("soundboard upload failed: {}", err);
        return Ok(Json(SoundboardSoundResponse {
            ok: false,
            sound: None,
            error: Some("Unable to save audio".into()),
        }));
    }
    let sound = SoundboardSound {
        id: id.clone(),
        room_id: query.room_id.clone(),
        name: name.trim().chars().take(60).collect(),
        icon,
        volume: volume.min(200),
        file_name,
        mime,
        uploaded_at: now_ts_ms(),
    };
    room.insert(id.clone(), sound.clone());
    board.index.insert(id.clone(), sound.clone());
    persist_soundboard(&board);
    Ok(Json(SoundboardSoundResponse {
        ok: true,
        sound: Some(soundboard_public(&sound)),
        error: None,
    }))
}

pub(crate) async fn soundboard_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SoundboardUpdateRequest>,
) -> Result<Json<SoundboardSoundResponse>, StatusCode> {
    ensure_livekit(&state, &headers)?;
    let mut board = state.soundboard.lock().unwrap_or_else(|e| e.into_inner());
    let sound_id = payload.sound_id.clone();
    let sound = match board.index.get_mut(&sound_id) {
        Some(sound) => sound,
        None => {
            return Ok(Json(SoundboardSoundResponse {
                ok: false,
                sound: None,
                error: Some("Sound not found".into()),
            }))
        }
    };
    if sound.room_id != payload.room_id {
        return Ok(Json(SoundboardSoundResponse {
            ok: false,
            sound: None,
            error: Some("Room mismatch".into()),
        }));
    }
    if let Some(name) = payload.name {
        sound.name = name.trim().chars().take(60).collect();
    }
    if let Some(icon) = payload.icon {
        sound.icon = icon;
    }
    if let Some(volume) = payload.volume {
        sound.volume = volume.min(200);
    }
    sound.uploaded_at = now_ts_ms();
    let updated = sound.clone();
    if let Some(room) = board.rooms.get_mut(&updated.room_id) {
        room.insert(updated.id.clone(), updated.clone());
    }
    persist_soundboard(&board);
    Ok(Json(SoundboardSoundResponse {
        ok: true,
        sound: Some(soundboard_public(&updated)),
        error: None,
    }))
}
