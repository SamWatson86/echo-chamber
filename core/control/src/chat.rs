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
use tracing::info;

// ── Structs ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct ChatState {
    pub(crate) dir: PathBuf,
    pub(crate) uploads_dir: PathBuf,
    pub(crate) max_upload_bytes: usize,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ChatMessage {
    #[serde(rename = "type")]
    pub(crate) msg_type: String,
    pub(crate) identity: String,
    pub(crate) name: String,
    pub(crate) text: String,
    pub(crate) timestamp: u64,
    pub(crate) room: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,
    #[serde(rename = "fileUrl", skip_serializing_if = "Option::is_none")]
    pub(crate) file_url: Option<String>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    pub(crate) file_name: Option<String>,
    #[serde(rename = "fileType", skip_serializing_if = "Option::is_none")]
    pub(crate) file_type: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct ChatDeleteRequest {
    pub(crate) id: String,
    pub(crate) identity: String,
    pub(crate) room: String,
}

#[derive(Serialize)]
pub(crate) struct ChatUploadResponse {
    pub(crate) ok: bool,
    pub(crate) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub(crate) struct ChatUploadQuery {
    pub(crate) room: String,
}

#[derive(Deserialize)]
pub(crate) struct AvatarUploadQuery {
    pub(crate) identity: String,
}

#[derive(Clone)]
pub(crate) struct ChimeEntry {
    pub(crate) file_name: String,
    pub(crate) mime: String,
}

#[derive(Deserialize)]
pub(crate) struct ChimeUploadQuery {
    pub(crate) identity: String,
    pub(crate) kind: String,
}

#[derive(Deserialize)]
pub(crate) struct ChimeDeleteRequest {
    pub(crate) identity: String,
    pub(crate) kind: String,
}

// ── Chat helper functions ────────────────────────────────────────────

fn chat_history_path(dir: &PathBuf, room: &str) -> PathBuf {
    let safe = if crate::is_safe_path_component(room) { room } else { "_invalid" };
    dir.join(format!("{}.json", safe))
}

fn load_chat_history(dir: &PathBuf, room: &str) -> Vec<ChatMessage> {
    let path = chat_history_path(dir, room);
    if !path.exists() {
        return Vec::new();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| Vec::new()),
        Err(_) => Vec::new(),
    }
}

fn save_chat_message_to_disk(dir: &PathBuf, message: &ChatMessage) {
    let _ = fs::create_dir_all(dir);
    let mut history = load_chat_history(dir, &message.room);
    history.push(message.clone());
    // Keep only last 1000 messages per room
    if history.len() > 1000 {
        let skip_count = history.len() - 1000;
        history = history.into_iter().skip(skip_count).collect();
    }
    let path = chat_history_path(dir, &message.room);
    if let Ok(json) = serde_json::to_string_pretty(&history) {
        let _ = fs::write(&path, json);
    }
}

fn delete_chat_message_from_disk(dir: &PathBuf, room: &str, message_id: &str, requester: &str) -> bool {
    let mut history = load_chat_history(dir, room);
    let before = history.len();
    history.retain(|msg| {
        if let Some(ref id) = msg.id {
            if id == message_id {
                return msg.identity != requester;
            }
        }
        true
    });
    if history.len() == before {
        return false;
    }
    let path = chat_history_path(dir, room);
    if let Ok(json) = serde_json::to_string_pretty(&history) {
        let _ = fs::write(&path, json);
    }
    true
}

// ── Chime helper ─────────────────────────────────────────────────────

pub(crate) fn chime_mime_from_ext(fname: &str) -> String {
    if fname.ends_with(".mp3") {
        "audio/mpeg".into()
    } else if fname.ends_with(".wav") {
        "audio/wav".into()
    } else if fname.ends_with(".ogg") {
        "audio/ogg".into()
    } else if fname.ends_with(".webm") {
        "audio/webm".into()
    } else if fname.ends_with(".m4a") {
        "audio/mp4".into()
    } else if fname.ends_with(".aac") {
        "audio/aac".into()
    } else if fname.ends_with(".flac") {
        "audio/flac".into()
    } else {
        "application/octet-stream".into()
    }
}

// ── Chat API handlers ────────────────────────────────────────────────

pub(crate) async fn chat_delete_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ChatDeleteRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let chat = state.chat.lock().unwrap_or_else(|e| e.into_inner());
    let deleted = delete_chat_message_from_disk(&chat.dir, &payload.room, &payload.id, &payload.identity);
    if deleted {
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Ok(Json(serde_json::json!({ "ok": false, "error": "Message not found or not yours" })))
    }
}

pub(crate) async fn chat_save_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(message): Json<ChatMessage>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let chat = state.chat.lock().unwrap_or_else(|e| e.into_inner());
    save_chat_message_to_disk(&chat.dir, &message);
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn chat_get_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room): Path<String>,
) -> Result<Json<Vec<ChatMessage>>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let chat = state.chat.lock().unwrap_or_else(|e| e.into_inner());
    let history = load_chat_history(&chat.dir, &room);
    Ok(Json(history))
}

pub(crate) async fn chat_upload_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(_query): Query<ChatUploadQuery>,
    body: Bytes,
) -> Result<Json<ChatUploadResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;

    if body.is_empty() {
        return Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some("Empty file".into()),
        }));
    }

    let chat = state.chat.lock().unwrap_or_else(|e| e.into_inner());
    if body.len() > chat.max_upload_bytes {
        return Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some("File too large (max 10MB)".into()),
        }));
    }

    // Generate unique filename
    let file_id = format!("{}", now_ts_ms());
    let file_name = format!("upload-{}", file_id);

    let _ = fs::create_dir_all(&chat.uploads_dir);
    let file_path = chat.uploads_dir.join(&file_name);

    match fs::write(&file_path, &body) {
        Ok(_) => {
            let url = format!("/api/chat/uploads/{}", file_name);
            Ok(Json(ChatUploadResponse {
                ok: true,
                url: Some(url),
                error: None,
            }))
        }
        Err(err) => Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some(format!("Upload failed: {}", err)),
        })),
    }
}

pub(crate) async fn chat_get_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(file_name): Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    info!(
        "chat_get_upload: file_name={}, auth_header={:?}",
        file_name,
        headers
            .get("authorization")
            .map(|h| h.to_str().unwrap_or("invalid"))
    );

    match ensure_livekit(&state, &headers) {
        Ok(claims) => info!(
            "chat_get_upload: auth successful for identity={}",
            claims.sub
        ),
        Err(e) => {
            info!("chat_get_upload: auth failed with status={}", e.as_u16());
            return Err(e);
        }
    }

    let chat = state.chat.lock().unwrap_or_else(|e| e.into_inner());
    let file_path = chat.uploads_dir.join(&file_name);

    let bytes = fs::read(file_path).map_err(|_| StatusCode::NOT_FOUND)?;
    let mut response = axum::response::Response::new(axum::body::Body::from(bytes));

    // Try to detect content type from file extension
    let content_type = if file_name.ends_with(".png") {
        "image/png"
    } else if file_name.ends_with(".jpg") || file_name.ends_with(".jpeg") {
        "image/jpeg"
    } else if file_name.ends_with(".gif") {
        "image/gif"
    } else if file_name.ends_with(".webp") {
        "image/webp"
    } else if file_name.ends_with(".pdf") {
        "application/pdf"
    } else {
        "application/octet-stream"
    };

    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static(content_type),
    );

    Ok(response)
}

// ── Avatar endpoints ─────────────────────────────────────────────────

pub(crate) async fn avatar_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AvatarUploadQuery>,
    body: Bytes,
) -> Result<Json<ChatUploadResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;

    if body.is_empty() {
        return Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some("Empty file".into()),
        }));
    }

    // 50 MB limit for avatars (animated GIFs can be large)
    if body.len() > 50 * 1024 * 1024 {
        return Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some("Avatar too large (max 50MB)".into()),
        }));
    }

    // Determine extension from content-type
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream");
    let ext = match content_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => {
            return Ok(Json(ChatUploadResponse {
                ok: false,
                url: None,
                error: Some("Unsupported image type (use jpeg, png, webp, or gif)".into()),
            }));
        }
    };

    // Strip -XXXX numeric suffix to get identity base (persists across reconnects)
    let identity_base = query
        .identity
        .rsplitn(2, '-')
        .last()
        .unwrap_or(&query.identity)
        .to_string();

    let file_name = format!("avatar-{}.{}", identity_base, ext);
    let file_path = state.avatars_dir.join(&file_name);

    // Remove any old avatar for this identity base (might have a different extension)
    {
        let avatars = state.avatars.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old_file) = avatars.get(&identity_base) {
            if *old_file != file_name {
                let old_path = state.avatars_dir.join(old_file);
                let _ = fs::remove_file(old_path);
            }
        }
    }

    let _ = fs::create_dir_all(&state.avatars_dir);
    match fs::write(&file_path, &body) {
        Ok(_) => {
            let mut avatars = state.avatars.lock().unwrap_or_else(|e| e.into_inner());
            avatars.insert(identity_base.clone(), file_name);
            let url = format!("/api/avatar/{}", identity_base);
            info!("avatar uploaded for identity_base={}", identity_base);
            Ok(Json(ChatUploadResponse {
                ok: true,
                url: Some(url),
                error: None,
            }))
        }
        Err(err) => Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some(format!("Avatar upload failed: {}", err)),
        })),
    }
}

pub(crate) async fn avatar_get(
    State(state): State<AppState>,
    Path(identity): Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    // Strip -XXXX suffix in case caller passes full identity
    let identity_base = identity
        .rsplitn(2, '-')
        .last()
        .unwrap_or(&identity)
        .to_string();

    let file_name = {
        let avatars = state.avatars.lock().unwrap_or_else(|e| e.into_inner());
        avatars.get(&identity_base).cloned()
    };

    let file_name = file_name.ok_or(StatusCode::NOT_FOUND)?;
    let file_path = state.avatars_dir.join(&file_name);
    let bytes = fs::read(&file_path).map_err(|_| StatusCode::NOT_FOUND)?;

    let content_type = if file_name.ends_with(".png") {
        "image/png"
    } else if file_name.ends_with(".jpg") || file_name.ends_with(".jpeg") {
        "image/jpeg"
    } else if file_name.ends_with(".gif") {
        "image/gif"
    } else if file_name.ends_with(".webp") {
        "image/webp"
    } else {
        "application/octet-stream"
    };

    let mut response = axum::response::Response::new(axum::body::Body::from(bytes));
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    // Cache avatars for 5 minutes
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );

    Ok(response)
}

// ── Chime endpoints ──────────────────────────────────────────────────

pub(crate) async fn chime_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ChimeUploadQuery>,
    body: Bytes,
) -> Result<Json<ChatUploadResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;

    if body.is_empty() {
        return Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some("Empty file".into()),
        }));
    }

    // 2 MB limit for chimes
    if body.len() > 2 * 1024 * 1024 {
        return Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some("Chime too large (max 2MB)".into()),
        }));
    }

    // Validate kind
    if query.kind != "enter" && query.kind != "exit" {
        return Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some("kind must be 'enter' or 'exit'".into()),
        }));
    }

    // Determine extension from content-type
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream");
    let ext = match content_type {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/ogg" | "audio/vorbis" => "ogg",
        "audio/webm" => "webm",
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" | "audio/aac" => "m4a",
        "audio/flac" | "audio/x-flac" => "flac",
        ct if ct.starts_with("audio/") => {
            // Accept any audio/* type, guess extension from the content-type
            ct.strip_prefix("audio/").unwrap_or("bin")
        }
        _ => {
            return Ok(Json(ChatUploadResponse {
                ok: false,
                url: None,
                error: Some(format!(
                    "Unsupported type: {}. Upload an audio file (mp3, wav, ogg, m4a, etc.)",
                    content_type
                )),
            }));
        }
    };

    // Strip -XXXX numeric suffix to get identity base
    let identity_base = query
        .identity
        .rsplitn(2, '-')
        .last()
        .unwrap_or(&query.identity)
        .to_string();

    let key = format!("{}-{}", identity_base, query.kind);
    let file_name = format!("chime-{}.{}", key, ext);
    let file_path = state.chimes_dir.join(&file_name);

    // Remove any old chime for this key (might have a different extension)
    {
        let chimes = state.chimes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old_entry) = chimes.get(&key) {
            if old_entry.file_name != file_name {
                let old_path = state.chimes_dir.join(&old_entry.file_name);
                let _ = fs::remove_file(old_path);
            }
        }
    }

    let _ = fs::create_dir_all(&state.chimes_dir);
    match fs::write(&file_path, &body) {
        Ok(_) => {
            let mime = chime_mime_from_ext(&file_name);
            let mut chimes = state.chimes.lock().unwrap_or_else(|e| e.into_inner());
            chimes.insert(key.clone(), ChimeEntry { file_name, mime });
            let url = format!("/api/chime/{}/{}", identity_base, query.kind);
            info!("chime uploaded: key={}", key);
            Ok(Json(ChatUploadResponse {
                ok: true,
                url: Some(url),
                error: None,
            }))
        }
        Err(err) => Ok(Json(ChatUploadResponse {
            ok: false,
            url: None,
            error: Some(format!("Chime upload failed: {}", err)),
        })),
    }
}

pub(crate) async fn chime_get(
    State(state): State<AppState>,
    Path((identity, kind)): Path<(String, String)>,
) -> Result<impl IntoResponse, StatusCode> {
    // Strip -XXXX suffix in case caller passes full identity
    let identity_base = identity
        .rsplitn(2, '-')
        .last()
        .unwrap_or(&identity)
        .to_string();

    let key = format!("{}-{}", identity_base, kind);

    let entry = {
        let chimes = state.chimes.lock().unwrap_or_else(|e| e.into_inner());
        chimes.get(&key).cloned()
    };

    let entry = entry.ok_or(StatusCode::NOT_FOUND)?;
    let file_path = state.chimes_dir.join(&entry.file_name);
    let bytes = fs::read(&file_path).map_err(|_| StatusCode::NOT_FOUND)?;

    let mut response = axum::response::Response::new(axum::body::Body::from(bytes));
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(&entry.mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    // Don't cache chimes — users can update them at any time
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );

    Ok(response)
}

pub(crate) async fn chime_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ChimeDeleteRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    // Strip -XXXX suffix
    let identity_base = body
        .identity
        .rsplitn(2, '-')
        .last()
        .unwrap_or(&body.identity)
        .to_string();

    let key = format!("{}-{}", identity_base, body.kind);

    let removed = {
        let mut chimes = state.chimes.lock().unwrap_or_else(|e| e.into_inner());
        chimes.remove(&key)
    };

    if let Some(entry) = removed {
        let file_path = state.chimes_dir.join(&entry.file_name);
        let _ = fs::remove_file(file_path);
        info!("chime deleted: key={}", key);
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}
