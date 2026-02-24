mod audio_capture;
mod jam_bot;

use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::extract::OriginalUri;
use axum::http::HeaderValue;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Json, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect},
    routing::{get, post},
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use rcgen::generate_simple_self_signed;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::Layer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::{error, info, warn};

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    rooms: Arc<Mutex<HashMap<String, RoomInfo>>>,
    participants: Arc<Mutex<HashMap<String, ParticipantEntry>>>,
    soundboard: Arc<Mutex<SoundboardState>>,
    chat: Arc<Mutex<ChatState>>,
    avatars: Arc<Mutex<HashMap<String, String>>>, // identity_base -> filename
    avatars_dir: PathBuf,
    chimes: Arc<Mutex<HashMap<String, ChimeEntry>>>, // key: "identityBase-enter" or "identityBase-exit"
    chimes_dir: PathBuf,
    client_stats: Arc<Mutex<HashMap<String, ClientStats>>>,
    joined_at: Arc<Mutex<HashMap<String, u64>>>, // identity -> join timestamp
    session_log_dir: PathBuf,
    stats_history: Arc<Mutex<Vec<StatsSnapshot>>>,
    bug_reports: Arc<Mutex<Vec<BugReport>>>,
    bug_log_dir: PathBuf,
    // Jam Session (Spotify)
    jam: Arc<Mutex<JamState>>,
    jam_bot: Arc<tokio::sync::Mutex<Option<jam_bot::JamBot>>>,
    spotify_client_id: String,
    spotify_pending: Arc<Mutex<Option<SpotifyPending>>>,
    spotify_token_file: PathBuf,
    http_client: reqwest::Client,
}

#[derive(Clone, Serialize)]
struct ParticipantEntry {
    identity: String,
    name: String,
    room_id: String,
    last_seen: u64,
    viewer_version: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SessionEvent {
    event_type: String, // "join" or "leave"
    identity: String,
    name: String,
    room_id: String,
    timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_secs: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct ClientStats {
    identity: String,
    name: String,
    room: String,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_bitrate_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bwe_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality_limitation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encoder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ice_local_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ice_remote_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    camera_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    camera_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    camera_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    camera_bitrate_kbps: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StatsSnapshot {
    identity: String,
    name: String,
    timestamp: u64,
    screen_fps: Option<f64>,
    screen_bitrate_kbps: Option<u32>,
    quality_limitation: Option<String>,
    encoder: Option<String>,
    ice_local_type: Option<String>,
    ice_remote_type: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct BugReport {
    id: u64,
    identity: String,
    name: String,
    room: String,
    description: String,
    timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_bitrate_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bwe_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality_limitation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encoder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ice_local_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ice_remote_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    screenshot_url: Option<String>,
}

#[derive(Deserialize)]
struct BugReportRequest {
    description: String,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    room: Option<String>,
    #[serde(default)]
    screen_fps: Option<f64>,
    #[serde(default)]
    screen_bitrate_kbps: Option<u32>,
    #[serde(default)]
    bwe_kbps: Option<u32>,
    #[serde(default)]
    quality_limitation: Option<String>,
    #[serde(default)]
    encoder: Option<String>,
    #[serde(default)]
    ice_local_type: Option<String>,
    #[serde(default)]
    ice_remote_type: Option<String>,
    #[serde(default)]
    screenshot_url: Option<String>,
}

#[derive(Clone)]
struct Config {
    host: String,
    port: u16,
    admin_password_hash: Option<String>,
    admin_password: Option<String>,
    admin_jwt_secret: String,
    admin_token_ttl_secs: u64,
    livekit_api_key: String,
    livekit_api_secret: String,
    livekit_token_ttl_secs: u64,
    soundboard_dir: PathBuf,
    soundboard_max_bytes: usize,
    soundboard_max_sounds_per_room: usize,
    chat_dir: PathBuf,
    chat_uploads_dir: PathBuf,
    chat_max_upload_bytes: usize,
}

#[derive(Clone)]
struct SoundboardState {
    dir: PathBuf,
    max_bytes: usize,
    max_sounds_per_room: usize,
    rooms: HashMap<String, HashMap<String, SoundboardSound>>,
    index: HashMap<String, SoundboardSound>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SoundboardSound {
    id: String,
    #[serde(rename = "roomId")]
    room_id: String,
    name: String,
    #[serde(default = "default_soundboard_icon")]
    icon: String,
    #[serde(default = "default_soundboard_volume")]
    volume: u16,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(default)]
    mime: Option<String>,
    #[serde(rename = "uploadedAt", default)]
    uploaded_at: u64,
}

#[derive(Serialize)]
struct SoundboardPublic {
    id: String,
    #[serde(rename = "roomId")]
    room_id: String,
    name: String,
    icon: String,
    volume: u16,
}

#[derive(Clone)]
struct ChatState {
    dir: PathBuf,
    uploads_dir: PathBuf,
    max_upload_bytes: usize,
}

#[derive(Clone, Serialize, Deserialize)]
struct ChatMessage {
    #[serde(rename = "type")]
    msg_type: String,
    identity: String,
    name: String,
    text: String,
    timestamp: u64,
    room: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(rename = "fileUrl", skip_serializing_if = "Option::is_none")]
    file_url: Option<String>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(rename = "fileType", skip_serializing_if = "Option::is_none")]
    file_type: Option<String>,
}

#[derive(Deserialize)]
struct ChatDeleteRequest {
    id: String,
    identity: String,
    room: String,
}

#[derive(Serialize)]
struct ChatUploadResponse {
    ok: bool,
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct ChatUploadQuery {
    room: String,
}

#[derive(Deserialize)]
struct AvatarUploadQuery {
    identity: String,
}

#[derive(Clone)]
struct ChimeEntry {
    file_name: String,
    mime: String,
}

#[derive(Deserialize)]
struct ChimeUploadQuery {
    identity: String,
    kind: String,
}

#[derive(Deserialize)]
struct ChimeDeleteRequest {
    identity: String,
    kind: String,
}

// ── Jam Session (Spotify integration) structs ──────────────────────────

#[derive(Clone, Serialize, Deserialize)]
struct SpotifyToken {
    access_token: String,
    refresh_token: String,
    expires_at: u64, // unix timestamp
}

struct SpotifyPending {
    state: String,
    code: Option<String>,
}

#[derive(Default)]
struct JamState {
    active: bool,
    host_identity: String,
    spotify_token: Option<SpotifyToken>,
    queue: Vec<QueuedTrack>,
    now_playing: Option<NowPlayingInfo>,
    listeners: HashSet<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct QueuedTrack {
    spotify_uri: String,
    name: String,
    artist: String,
    album_art_url: String,
    duration_ms: u64,
    added_by: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct NowPlayingInfo {
    name: String,
    artist: String,
    album_art_url: String,
    duration_ms: u64,
    progress_ms: u64,
    is_playing: bool,
    #[serde(skip)]
    fetched_at: Option<std::time::Instant>,
}

// ────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    ts: u64,
}

#[derive(Deserialize)]
struct LoginRequest {
    password: String,
}

#[derive(Serialize)]
struct LoginResponse {
    ok: bool,
    token: String,
    expires_in_seconds: u64,
}

#[derive(Deserialize)]
struct TokenRequest {
    room: String,
    identity: String,
    name: Option<String>,
    #[serde(default)]
    viewer_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoundboardListQuery {
    room_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoundboardUploadQuery {
    room_id: String,
    name: Option<String>,
    icon: Option<String>,
    volume: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoundboardUpdateRequest {
    room_id: String,
    sound_id: String,
    name: Option<String>,
    icon: Option<String>,
    volume: Option<u16>,
}

#[derive(Serialize)]
struct TokenResponse {
    token: String,
    expires_in_seconds: u64,
}

#[derive(Serialize)]
struct SoundboardListResponse {
    ok: bool,
    sounds: Vec<SoundboardPublic>,
}

#[derive(Serialize)]
struct SoundboardSoundResponse {
    ok: bool,
    sound: Option<SoundboardPublic>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct AdminClaims {
    sub: String,
    role: String,
    exp: usize,
    iat: usize,
}

#[derive(Serialize, Deserialize)]
struct LiveKitClaims {
    iss: String,
    sub: String,
    exp: usize,
    iat: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    video: LiveKitVideoGrant,
}

#[derive(Serialize, Deserialize)]
#[allow(non_snake_case)]
struct LiveKitVideoGrant {
    room: String,
    roomJoin: bool,
    canPublish: bool,
    canSubscribe: bool,
    canPublishData: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct RoomInfo {
    room_id: String,
    created_at: u64,
}

#[derive(Serialize)]
struct RoomStatusEntry {
    room_id: String,
    participants: Vec<RoomStatusParticipant>,
}

#[derive(Serialize)]
struct RoomStatusParticipant {
    identity: String,
    name: String,
}

#[derive(Deserialize)]
struct ParticipantLeaveRequest {
    identity: String,
}

#[tokio::main]
async fn main() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    tracing_subscriber::fmt().with_env_filter("info").init();

    load_dotenv();
    let config = Arc::new(load_config());
    let max_body = config
        .soundboard_max_bytes
        .max(config.chat_max_upload_bytes)
        .max(50 * 1024 * 1024); // avatar upload limit (50 MB for animated GIFs)
    let mut soundboard_state = SoundboardState {
        dir: config.soundboard_dir.clone(),
        max_bytes: config.soundboard_max_bytes,
        max_sounds_per_room: config.soundboard_max_sounds_per_room,
        rooms: HashMap::new(),
        index: HashMap::new(),
    };
    load_soundboard(&mut soundboard_state);
    let chat_state = ChatState {
        dir: config.chat_dir.clone(),
        uploads_dir: config.chat_uploads_dir.clone(),
        max_upload_bytes: config.chat_max_upload_bytes,
    };
    fs::create_dir_all(&chat_state.dir).ok();
    fs::create_dir_all(&chat_state.uploads_dir).ok();
    let avatars_dir = chat_state
        .uploads_dir
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("avatars");
    fs::create_dir_all(&avatars_dir).ok();

    // Scan existing avatar files on startup so GET works after restarts
    let mut existing_avatars = HashMap::new();
    if let Ok(entries) = fs::read_dir(&avatars_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            // Expected format: avatar-{identity_base}.{ext}
            if fname.starts_with("avatar-") {
                if let Some(dot_pos) = fname.rfind('.') {
                    let identity_base = fname[7..dot_pos].to_string(); // skip "avatar-"
                    info!("loaded existing avatar: {} -> {}", identity_base, fname);
                    existing_avatars.insert(identity_base, fname);
                }
            }
        }
    }

    // ── Chimes directory + scan existing files ────────────────────────
    let chimes_dir = avatars_dir
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("chimes");
    fs::create_dir_all(&chimes_dir).ok();
    let mut existing_chimes: HashMap<String, ChimeEntry> = HashMap::new();
    if let Ok(entries) = fs::read_dir(&chimes_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            // Expected format: chime-{identityBase}-{enter|exit}.{ext}
            if fname.starts_with("chime-") {
                if let Some(dot_pos) = fname.rfind('.') {
                    let stem = &fname[6..dot_pos]; // skip "chime-"
                                                   // stem = "identityBase-enter" or "identityBase-exit"
                    if stem.ends_with("-enter") || stem.ends_with("-exit") {
                        let key = stem.to_string();
                        let mime = chime_mime_from_ext(&fname);
                        info!("loaded existing chime: {} -> {}", key, fname);
                        existing_chimes.insert(
                            key,
                            ChimeEntry {
                                file_name: fname,
                                mime,
                            },
                        );
                    }
                }
            }
        }
    }

    let session_log_dir = std::env::var("CORE_SESSION_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let base = avatars_dir.parent().unwrap_or(std::path::Path::new("."));
            base.parent().unwrap_or(base).join("logs").join("sessions")
        });
    fs::create_dir_all(&session_log_dir).ok();
    info!("session log dir: {:?}", session_log_dir);

    let bug_log_dir = session_log_dir
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("bugs");
    fs::create_dir_all(&bug_log_dir).ok();

    // Load persisted Spotify token if available
    let spotify_token_file = session_log_dir
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("spotify-token.json");
    let persisted_spotify_token = if spotify_token_file.exists() {
        match fs::read_to_string(&spotify_token_file) {
            Ok(contents) => match serde_json::from_str::<SpotifyToken>(&contents) {
                Ok(token) => {
                    info!(
                        "Loaded persisted Spotify token (expires_at={})",
                        token.expires_at
                    );
                    Some(token)
                }
                Err(e) => {
                    warn!("Failed to parse spotify-token.json: {}", e);
                    None
                }
            },
            Err(e) => {
                warn!("Failed to read spotify-token.json: {}", e);
                None
            }
        }
    } else {
        None
    };

    let mut initial_jam = JamState::default();
    if let Some(token) = persisted_spotify_token {
        initial_jam.spotify_token = Some(token);
    }

    let state = AppState {
        config: config.clone(),
        rooms: Arc::new(Mutex::new(HashMap::new())),
        participants: Arc::new(Mutex::new(HashMap::new())),
        soundboard: Arc::new(Mutex::new(soundboard_state)),
        chat: Arc::new(Mutex::new(chat_state)),
        avatars: Arc::new(Mutex::new(existing_avatars)),
        avatars_dir,
        chimes: Arc::new(Mutex::new(existing_chimes)),
        chimes_dir,
        client_stats: Arc::new(Mutex::new(HashMap::new())),
        joined_at: Arc::new(Mutex::new(HashMap::new())),
        session_log_dir: session_log_dir.clone(),
        stats_history: Arc::new(Mutex::new(Vec::new())),
        bug_reports: Arc::new(Mutex::new(Vec::new())),
        bug_log_dir,
        // Jam Session (Spotify)
        spotify_client_id: std::env::var("SPOTIFY_CLIENT_ID").unwrap_or_default(),
        spotify_pending: Arc::new(Mutex::new(None)),
        jam: Arc::new(Mutex::new(initial_jam)),
        jam_bot: Arc::new(tokio::sync::Mutex::new(None)),
        spotify_token_file,
        http_client: reqwest::Client::new(),
    };

    // Background task: clean up stale participants (no heartbeat for 20s)
    {
        let participants = state.participants.clone();
        let joined_at = state.joined_at.clone();
        let client_stats = state.client_stats.clone();
        let session_log_dir = state.session_log_dir.clone();
        let jam_for_cleanup = state.jam.clone();
        let jam_bot_for_cleanup = state.jam_bot.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let removed_entries: Vec<ParticipantEntry>;
                {
                    let mut map = participants.lock().unwrap_or_else(|e| e.into_inner());
                    let before = map.len();
                    let mut removed = Vec::new();
                    map.retain(|_, p| {
                        if now.saturating_sub(p.last_seen) >= 20 {
                            removed.push(p.clone());
                            false
                        } else {
                            true
                        }
                    });
                    removed_entries = removed;
                    if before - map.len() > 0 {
                        info!("cleaned up {} stale participant(s)", before - map.len());
                    }
                }
                // Log leave events for cleaned-up participants
                for entry in &removed_entries {
                    let join_time = {
                        let mut ja = joined_at.lock().unwrap_or_else(|e| e.into_inner());
                        ja.remove(&entry.identity)
                    };
                    {
                        let mut cs = client_stats.lock().unwrap_or_else(|e| e.into_inner());
                        cs.remove(&entry.identity);
                    }
                    let duration = join_time.map(|jt| now.saturating_sub(jt));
                    let event = SessionEvent {
                        event_type: "leave".to_string(),
                        identity: entry.identity.clone(),
                        name: entry.name.clone(),
                        room_id: entry.room_id.clone(),
                        timestamp: now,
                        duration_secs: duration,
                    };
                    append_session_event(&session_log_dir, &event);
                }
                // Remove stale participants from jam listeners
                if !removed_entries.is_empty() {
                    let should_auto_end = {
                        let mut jam = jam_for_cleanup.lock().unwrap_or_else(|e| e.into_inner());
                        if jam.active {
                            for entry in &removed_entries {
                                let base = identity_base(&entry.identity);
                                let before = jam.listeners.len();
                                jam.listeners.retain(|l| identity_base(l) != base);
                                if jam.listeners.len() < before {
                                    info!("Jam: removed stale listener {}", entry.identity);
                                }
                            }
                        }
                        jam.active && jam.listeners.is_empty()
                    };
                    if should_auto_end {
                        schedule_jam_auto_end(
                            jam_for_cleanup.clone(),
                            jam_bot_for_cleanup.clone(),
                            "stale cleanup",
                        );
                    }
                }
            }
        });
    }

    let viewer_dir = resolve_viewer_dir();
    info!("viewer dir: {:?}", viewer_dir);

    let admin_dir = resolve_admin_dir();
    info!("admin dir: {:?}", admin_dir);

    // Stamp cache-busting version strings into index.html at startup
    stamp_viewer_index(&viewer_dir);

    let app = Router::new()
        .route("/", get(root_route))
        .nest_service(
            "/viewer",
            SetResponseHeaderLayer::overriding(
                axum::http::header::CACHE_CONTROL,
                HeaderValue::from_static("no-cache, no-store, must-revalidate"),
            )
            .layer(ServeDir::new(viewer_dir)),
        )
        .route("/admin/api/dashboard", get(admin_dashboard))
        .route("/admin/api/sessions", get(admin_sessions))
        .route("/admin/api/stats", post(admin_report_stats))
        .route("/admin/api/metrics", get(admin_metrics))
        .route("/admin/api/bugs", get(admin_bug_reports))
        .route("/admin/api/metrics/dashboard", get(admin_dashboard_metrics))
        .nest_service("/admin", ServeDir::new(admin_dir))
        .route("/rtc", get(sfu_proxy))
        .route("/sfu", get(sfu_proxy))
        .route("/sfu/rtc", get(sfu_proxy))
        .route("/health", get(health))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/token", post(issue_token))
        .route("/v1/rooms", get(list_rooms).post(create_room))
        .route("/v1/rooms/:room_id", get(get_room).delete(delete_room))
        .route("/v1/room-status", get(rooms_status))
        .route("/v1/participants/heartbeat", post(participant_heartbeat))
        .route("/v1/participants/leave", post(participant_leave))
        .route("/v1/metrics", get(metrics))
        .route("/api/soundboard/list", get(soundboard_list))
        .route("/api/soundboard/file/:sound_id", get(soundboard_file))
        .route("/api/soundboard/upload", post(soundboard_upload))
        .route("/api/soundboard/update", post(soundboard_update))
        .route("/api/chat/message", post(chat_save_message))
        .route("/api/chat/delete", post(chat_delete_message))
        .route("/api/chat/history/:room", get(chat_get_history))
        .route("/api/chat/upload", post(chat_upload_file))
        .route("/api/chat/uploads/:file_name", get(chat_get_upload))
        .route("/api/online", get(online_users))
        .route("/api/avatar/upload", post(avatar_upload))
        .route("/api/avatar/:identity", get(avatar_get))
        .route("/api/chime/upload", post(chime_upload))
        .route("/api/chime/:identity/:kind", get(chime_get))
        .route("/api/chime/delete", post(chime_delete))
        .route("/api/bug-report", post(submit_bug_report))
        .route("/api/version", get(api_version))
        .route("/api/update/latest.json", get(api_update_latest))
        .route("/api/open-url", post(open_url))
        // Jam Session (Spotify integration)
        .route("/api/jam/spotify-init", post(jam_spotify_init))
        .route("/api/jam/spotify-callback", get(jam_spotify_callback))
        .route("/api/jam/spotify-code", get(jam_spotify_code))
        .route("/api/jam/spotify-token", post(jam_spotify_token))
        .route("/api/jam/start", post(jam_start))
        .route("/api/jam/stop", post(jam_stop))
        .route("/api/jam/state", get(jam_state))
        .route("/api/jam/search", post(jam_search))
        .route("/api/jam/queue", post(jam_queue_add))
        .route("/api/jam/queue-remove", post(jam_queue_remove))
        .route("/api/jam/skip", post(jam_skip))
        .route("/api/jam/join", post(jam_join))
        .route("/api/jam/leave", post(jam_leave))
        .route("/api/jam/audio", get(jam_audio_ws))
        // Admin: participant management
        .route(
            "/v1/rooms/:room_id/kick/:identity",
            post(admin_kick_participant),
        )
        .route(
            "/v1/rooms/:room_id/mute/:identity",
            post(admin_mute_participant),
        )
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
        .layer(DefaultBodyLimit::max(max_body));

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .expect("invalid bind address");

    let tls_cert = std::env::var("CORE_TLS_CERT").ok();
    let tls_key = std::env::var("CORE_TLS_KEY").ok();
    let tls_self_signed = std::env::var("CORE_TLS_SELF_SIGNED").ok().is_some();

    info!("control plane listening on {}", addr);
    if tls_cert.is_some() || tls_self_signed {
        let tls_config = if let (Some(cert_path), Some(key_path)) = (tls_cert, tls_key) {
            let cert_path = resolve_path(cert_path);
            let key_path = resolve_path(key_path);
            info!("tls enabled with cert {:?} key {:?}", cert_path, key_path);
            match RustlsConfig::from_pem_file(cert_path, key_path).await {
                Ok(config) => config,
                Err(err) => {
                    warn!(
                        "failed to load TLS cert/key ({}), generating self-signed",
                        err
                    );
                    generate_self_signed().await
                }
            }
        } else {
            generate_self_signed().await
        };
        axum_server::bind_rustls(addr, tls_config)
            .serve(app.into_make_service())
            .await
            .unwrap();
    } else {
        axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app)
            .await
            .unwrap();
    }
}

fn load_dotenv() {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("CORE_ENV_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(core_dir) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            candidates.push(core_dir.join("control").join(".env"));
        }
    }
    if let Ok(current) = std::env::current_dir() {
        candidates.push(current.join("control").join(".env"));
        candidates.push(current.join(".env"));
    }

    for path in candidates {
        if !path.exists() {
            continue;
        }
        if let Ok(contents) = std::fs::read_to_string(&path) {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let mut parts = line.splitn(2, '=');
                let key = parts.next().unwrap_or("").trim();
                let value = parts.next().unwrap_or("").trim();
                if key.is_empty() {
                    continue;
                }
                std::env::set_var(key, value);
            }
            info!("loaded env from {:?}", path);
            break;
        }
    }
}

fn resolve_viewer_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ECHO_CORE_VIEWER_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(current) = std::env::current_dir() {
        if let Some(name) = current.file_name().and_then(|n| n.to_str()) {
            if name.eq_ignore_ascii_case("control") {
                if let Some(parent) = current.parent() {
                    return parent.join("viewer");
                }
            }
            if name.eq_ignore_ascii_case("core") {
                return current.join("viewer");
            }
        }
        return current.join("core").join("viewer");
    }
    PathBuf::from("viewer")
}

/// Stamp cache-busting version query strings into viewer/index.html on disk.
/// Called once at server startup so ServeDir serves the already-stamped file.
/// Idempotent — strips old ?v= params before re-stamping.
fn stamp_viewer_index(viewer_dir: &PathBuf) {
    let index_path = viewer_dir.join("index.html");
    match fs::read_to_string(&index_path) {
        Ok(html) => {
            let v = env!("CARGO_PKG_VERSION");
            let assets = ["style.css", "jam.css", "app.js", "jam.js", "changelog.js", "livekit-client.umd.js"];
            let mut stamped = html;
            for asset in &assets {
                // Remove any existing ?v=... before the closing quote
                let with_param = format!("{}?v=", asset);
                if let Some(pos) = stamped.find(&with_param) {
                    // Find the closing quote after the ?v= param
                    let after = pos + with_param.len();
                    if let Some(q) = stamped[after..].find('"') {
                        stamped = format!("{}{}\"{}",
                            &stamped[..pos],
                            asset,
                            &stamped[after + q + 1..]);
                    }
                }
                // Now stamp the fresh version
                let plain = format!("{}\"", asset);
                let versioned = format!("{}?v={}\"", asset, v);
                stamped = stamped.replace(&plain, &versioned);
            }
            if let Err(e) = fs::write(&index_path, &stamped) {
                eprintln!("WARNING: could not stamp index.html: {}", e);
            } else {
                info!("Stamped viewer/index.html with ?v={}", v);
            }
        }
        Err(e) => eprintln!("WARNING: could not read index.html for stamping: {}", e),
    }
}

fn resolve_deploy_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ECHO_CORE_DEPLOY_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(current) = std::env::current_dir() {
        if let Some(name) = current.file_name().and_then(|n| n.to_str()) {
            if name.eq_ignore_ascii_case("control") {
                if let Some(parent) = current.parent() {
                    return parent.join("deploy");
                }
            }
            if name.eq_ignore_ascii_case("core") {
                return current.join("deploy");
            }
        }
        return current.join("core").join("deploy");
    }
    PathBuf::from("deploy")
}

fn resolve_admin_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ECHO_CORE_ADMIN_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(current) = std::env::current_dir() {
        if let Some(name) = current.file_name().and_then(|n| n.to_str()) {
            if name.eq_ignore_ascii_case("control") {
                if let Some(parent) = current.parent() {
                    return parent.join("admin");
                }
            }
            if name.eq_ignore_ascii_case("core") {
                return current.join("admin");
            }
        }
        return current.join("core").join("admin");
    }
    PathBuf::from("admin")
}

async fn sfu_proxy(
    ws: WebSocketUpgrade,
    uri: OriginalUri,
    headers: HeaderMap,
) -> impl IntoResponse {
    let subprotocol = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<none>");
    let token_len = uri
        .query()
        .and_then(|q| q.split('&').find(|p| p.starts_with("access_token=")))
        .map(|p| p.trim_start_matches("access_token=").len())
        .unwrap_or(0);
    info!(
        "sfu proxy request: {} (subprotocol: {}, access_token_len: {})",
        uri.0, subprotocol, token_len
    );
    ws.on_upgrade(move |socket| handle_sfu_socket(socket, uri.0))
}

async fn handle_sfu_socket(socket: WebSocket, uri: axum::http::Uri) {
    let upstream_base =
        std::env::var("CORE_SFU_PROXY").unwrap_or_else(|_| "ws://127.0.0.1:7880".to_string());
    let query = uri.query().unwrap_or("");
    let trimmed = upstream_base.trim_end_matches('/');
    let needs_rtc = !trimmed.ends_with("/rtc");
    let base_with_path = if needs_rtc {
        format!("{}/rtc", trimmed)
    } else {
        trimmed.to_string()
    };
    let upstream = if query.is_empty() {
        base_with_path
    } else {
        format!("{}?{}", base_with_path, query)
    };
    info!("sfu proxy upstream: {} (path: {})", upstream, uri.path());
    let mut request = match upstream.clone().into_client_request() {
        Ok(req) => req,
        Err(_) => {
            warn!("failed to build ws request for {}", upstream);
            return;
        }
    };
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static("livekit"),
    );
    let (upstream_ws, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(pair) => pair,
        Err(err) => {
            warn!("failed to connect to livekit via proxy: {}", err);
            return;
        }
    };
    info!("sfu proxy connected to livekit");
    let (mut up_tx, mut up_rx) = upstream_ws.split();
    let (mut client_tx, mut client_rx) = socket.split();

    loop {
        tokio::select! {
            Some(msg) = client_rx.next() => {
                match msg {
                    Ok(AxumMessage::Text(text)) => { let _ = up_tx.send(WsMessage::Text(text)).await; }
                    Ok(AxumMessage::Binary(bin)) => { let _ = up_tx.send(WsMessage::Binary(bin)).await; }
                    Ok(AxumMessage::Ping(payload)) => { let _ = up_tx.send(WsMessage::Ping(payload)).await; }
                    Ok(AxumMessage::Pong(payload)) => { let _ = up_tx.send(WsMessage::Pong(payload)).await; }
                    Ok(AxumMessage::Close(_)) | Err(_) => { let _ = up_tx.send(WsMessage::Close(None)).await; break; }
                }
            }
            Some(msg) = up_rx.next() => {
                match msg {
                    Ok(WsMessage::Text(text)) => { let _ = client_tx.send(AxumMessage::Text(text)).await; }
                    Ok(WsMessage::Binary(bin)) => { let _ = client_tx.send(AxumMessage::Binary(bin)).await; }
                    Ok(WsMessage::Ping(payload)) => { let _ = client_tx.send(AxumMessage::Ping(payload)).await; }
                    Ok(WsMessage::Pong(payload)) => { let _ = client_tx.send(AxumMessage::Pong(payload)).await; }
                    Ok(WsMessage::Close(_)) | Err(_) => { let _ = client_tx.send(AxumMessage::Close(None)).await; break; }
                    _ => {}
                }
            }
            else => break,
        }
    }
    info!("sfu proxy closed");
}

fn resolve_path(value: String) -> PathBuf {
    let path = PathBuf::from(&value);
    if path.is_absolute() {
        return path;
    }
    if let Ok(current) = std::env::current_dir() {
        return current.join(path);
    }
    PathBuf::from(value)
}

async fn generate_self_signed() -> RustlsConfig {
    let rcgen::CertifiedKey { cert, key_pair } = generate_simple_self_signed(vec![
        "echo.fellowshipoftheboatrace.party".into(),
        "echo-core.local".into(),
        "localhost".into(),
        "127.0.0.1".into(),
    ])
    .expect("failed to generate self-signed cert");
    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    RustlsConfig::from_pem(cert_pem.into_bytes(), key_pem.into_bytes())
        .await
        .expect("failed to load generated TLS cert")
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        ts: now_ts(),
    })
}

/// Returns server version and latest available client version from deploy/latest.json.
async fn api_version() -> Json<serde_json::Value> {
    let server_version = env!("CARGO_PKG_VERSION");
    let mut latest_client = String::new();
    if let Ok(data) = fs::read_to_string(resolve_deploy_dir().join("latest.json")) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(v) = parsed.get("version").and_then(|v| v.as_str()) {
                latest_client = v.to_string();
            }
        }
    }
    Json(serde_json::json!({
        "version": server_version,
        "latest_client": latest_client,
    }))
}

/// Serves the Tauri updater manifest (latest.json) from deploy dir.
/// This lets the Tauri auto-updater check the server directly instead of GitHub.
async fn api_update_latest() -> axum::response::Response {
    let path = resolve_deploy_dir().join("latest.json");
    match fs::read_to_string(&path) {
        Ok(data) => (
            StatusCode::OK,
            [("content-type", "application/json")],
            data,
        )
            .into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            "latest.json not found — no update available",
        )
            .into_response(),
    }
}

/// Open a URL in the system's default browser — DISABLED.
/// This endpoint was a security hole: remote users could open URLs on the
/// server's desktop. Links now open locally via Tauri IPC (open_external_url)
/// or window.open in the browser.
async fn open_url(
    State(_state): State<AppState>,
    headers: HeaderMap,
    _body: axum::body::Bytes,
) -> StatusCode {
    warn!("/api/open-url called but is disabled for security — use Tauri IPC instead");
    StatusCode::GONE
}

async fn online_users(State(state): State<AppState>) -> Json<serde_json::Value> {
    let participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
    let users: Vec<serde_json::Value> = participants
        .values()
        .map(|p| serde_json::json!({ "name": p.name, "room": p.room_id }))
        .collect();
    Json(serde_json::json!(users))
}

async fn root_route(
    headers: HeaderMap,
    uri: OriginalUri,
    ws: Option<WebSocketUpgrade>,
) -> axum::response::Response {
    if let Some(ws) = ws {
        return sfu_proxy(ws, uri, headers).await.into_response();
    }
    Redirect::temporary("/viewer/").into_response()
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    let ua = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    info!("login request (ua: {})", ua);
    if !verify_password(&state.config, &payload.password) {
        warn!("login failed (bad password)");
        return Err(StatusCode::UNAUTHORIZED);
    }

    let now = now_ts();
    let exp = now + state.config.admin_token_ttl_secs;
    let claims = AdminClaims {
        sub: "admin".to_string(),
        role: "admin".to_string(),
        iat: now as usize,
        exp: exp as usize,
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.admin_jwt_secret.as_bytes()),
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(LoginResponse {
        ok: true,
        token,
        expires_in_seconds: state.config.admin_token_ttl_secs,
    }))
}

async fn issue_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TokenRequest>,
) -> Result<Json<TokenResponse>, StatusCode> {
    info!(
        "issue token for room={} identity={}",
        payload.room, payload.identity
    );
    ensure_admin(&state, &headers)?;

    let now = now_ts();
    let exp = now + state.config.livekit_token_ttl_secs;
    let claims = LiveKitClaims {
        iss: state.config.livekit_api_key.clone(),
        sub: payload.identity.clone(),
        iat: now as usize,
        exp: exp as usize,
        name: payload.name.clone(),
        video: LiveKitVideoGrant {
            room: payload.room.clone(),
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        },
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.livekit_api_secret.as_bytes()),
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Track participant in room (dedup old sessions, reject active name conflicts)
    {
        let mut participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
        let name_base = payload
            .identity
            .rsplitn(2, '-')
            .last()
            .unwrap_or(&payload.identity)
            .to_string();
        let same_name_entries: Vec<(String, u64)> = participants
            .iter()
            .filter(|(k, _)| {
                *k != &payload.identity && k.rsplitn(2, '-').last().unwrap_or(k) == name_base
            })
            .map(|(k, v)| (k.clone(), v.last_seen))
            .collect();
        for (key, last_seen) in &same_name_entries {
            if now.saturating_sub(*last_seen) < 20 {
                // Another user with this name is currently connected — reject
                info!(
                    "name conflict: {} is active, rejecting {}",
                    key, payload.identity
                );
                return Err(StatusCode::CONFLICT);
            }
        }
        // Remove stale entries with same name base (old sessions)
        for (key, _) in same_name_entries {
            info!(
                "dedup: removing stale identity {} (replaced by {})",
                key, payload.identity
            );
            participants.remove(&key);
        }
        // Only update room_id if the participant is NEW or STALE (>20s since last seen).
        // Prefetching tokens for breakout rooms (fast room switching) should NOT overwrite
        // the participant's actual current room — that's the heartbeat's job.
        if let Some(existing) = participants.get_mut(&payload.identity) {
            if now.saturating_sub(existing.last_seen) >= 20 {
                // Stale entry — treat as new join, update everything
                existing.room_id = payload.room.clone();
                existing.last_seen = now;
                if let Some(ref name) = payload.name {
                    existing.name = name.clone();
                }
            }
            // Active entry: DON'T overwrite room_id (prefetch tokens shouldn't move them)
            // Just refresh last_seen so dedup logic considers them active
        } else {
            // Brand new participant — register them
            participants.insert(
                payload.identity.clone(),
                ParticipantEntry {
                    identity: payload.identity.clone(),
                    name: payload.name.clone().unwrap_or_default(),
                    room_id: payload.room.clone(),
                    last_seen: now,
                    viewer_version: None,
                },
            );
        }
    }

    Ok(Json(TokenResponse {
        token,
        expires_in_seconds: state.config.livekit_token_ttl_secs,
    }))
}

async fn list_rooms(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RoomInfo>>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    Ok(Json(rooms.values().cloned().collect()))
}

async fn create_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateRoomRequest>,
) -> Result<Json<RoomInfo>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let mut rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    let entry = rooms.entry(payload.room_id.clone()).or_insert(RoomInfo {
        room_id: payload.room_id.clone(),
        created_at: now_ts(),
    });
    Ok(Json(entry.clone()))
}

async fn get_room(
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

async fn delete_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(room_id): axum::extract::Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    ensure_admin(&state, &headers)?;
    let mut rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    rooms.remove(&room_id);
    Ok(StatusCode::NO_CONTENT)
}

async fn rooms_status(
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

async fn participant_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TokenRequest>,
) -> Result<StatusCode, StatusCode> {
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

    Ok(StatusCode::NO_CONTENT)
}

async fn participant_leave(
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

async fn metrics(
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

// ---- Admin Dashboard API ----

#[derive(Serialize)]
struct AdminDashboardResponse {
    ts: u64,
    rooms: Vec<AdminRoomInfo>,
    total_online: usize,
    server_version: String,
}

#[derive(Serialize)]
struct AdminRoomInfo {
    room_id: String,
    participants: Vec<AdminParticipantInfo>,
}

#[derive(Serialize)]
struct AdminParticipantInfo {
    identity: String,
    name: String,
    online_seconds: u64,
    stats: Option<ClientStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    viewer_version: Option<String>,
}

async fn admin_dashboard(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminDashboardResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let now = now_ts();
    let participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
    let joined_at = state.joined_at.lock().unwrap_or_else(|e| e.into_inner());
    let client_stats = state.client_stats.lock().unwrap_or_else(|e| e.into_inner());

    // Group participants by room
    let mut room_map: HashMap<String, Vec<AdminParticipantInfo>> = HashMap::new();
    for (_, p) in participants.iter() {
        let join_time = joined_at.get(&p.identity).copied().unwrap_or(p.last_seen);
        let online_secs = now.saturating_sub(join_time);
        let stats = client_stats.get(&p.identity).cloned();
        let info = AdminParticipantInfo {
            identity: p.identity.clone(),
            name: p.name.clone(),
            online_seconds: online_secs,
            stats,
            viewer_version: p.viewer_version.clone(),
        };
        room_map.entry(p.room_id.clone()).or_default().push(info);
    }

    let total = participants.len();
    let rooms: Vec<AdminRoomInfo> = room_map
        .into_iter()
        .map(|(room_id, participants)| AdminRoomInfo {
            room_id,
            participants,
        })
        .collect();

    Ok(Json(AdminDashboardResponse {
        ts: now,
        rooms,
        total_online: total,
        server_version: env!("CARGO_PKG_VERSION").to_string(),
    }))
}

#[derive(Serialize)]
struct AdminSessionsResponse {
    events: Vec<SessionEvent>,
}

#[derive(Serialize)]
struct AdminMetricsResponse {
    users: Vec<UserMetrics>,
}

#[derive(Serialize)]
struct UserMetrics {
    identity: String,
    name: String,
    sample_count: usize,
    avg_fps: f64,
    avg_bitrate_kbps: f64,
    pct_bandwidth_limited: f64,
    pct_cpu_limited: f64,
    total_minutes: f64,
    encoder: Option<String>,
    ice_local_type: Option<String>,
    ice_remote_type: Option<String>,
}

#[derive(Serialize)]
struct BugReportsResponse {
    reports: Vec<BugReport>,
}

#[derive(Clone, Serialize)]
struct HeatmapJoin {
    timestamp: u64,
    name: String,
}

#[derive(Serialize)]
struct DashboardMetricsResponse {
    summary: DashboardSummary,
    per_user: Vec<UserSessionStats>,
    heatmap_joins: Vec<HeatmapJoin>,
    timeline_events: Vec<TimelineEvent>,
}

#[derive(Serialize)]
struct DashboardSummary {
    total_sessions: usize,
    unique_users: usize,
    total_hours: f64,
    avg_duration_mins: f64,
}

#[derive(Serialize)]
struct UserSessionStats {
    name: String,
    identity: String,
    session_count: usize,
    total_hours: f64,
}

#[derive(Serialize)]
struct TimelineEvent {
    identity: String,
    name: String,
    event_type: String,
    timestamp: u64,
    duration_secs: Option<u64>,
}

async fn admin_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminSessionsResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;

    // Read today's and yesterday's session logs
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let today_days = now / 86400;
    let mut all_events = Vec::new();

    for offset in [0, 1] {
        let days = today_days - offset;
        let (year, month, day) = epoch_days_to_date(days);
        let file_name = format!("sessions-{:04}-{:02}-{:02}.json", year, month, day);
        let file_path = state.session_log_dir.join(&file_name);
        if let Ok(data) = fs::read_to_string(&file_path) {
            if let Ok(events) = serde_json::from_str::<Vec<SessionEvent>>(&data) {
                all_events.extend(events);
            }
        }
    }

    // Sort by timestamp descending (most recent first), limit to 200
    all_events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    all_events.truncate(200);

    Ok(Json(AdminSessionsResponse { events: all_events }))
}

async fn admin_dashboard_metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DashboardMetricsResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let today_days = now / 86400;
    let mut all_events = Vec::new();

    // Read last 30 days of session logs
    for offset in 0..30 {
        let days = today_days - offset;
        let (year, month, day) = epoch_days_to_date(days);
        let file_name = format!("sessions-{:04}-{:02}-{:02}.json", year, month, day);
        let file_path = state.session_log_dir.join(&file_name);
        if let Ok(data) = fs::read_to_string(&file_path) {
            if let Ok(events) = serde_json::from_str::<Vec<SessionEvent>>(&data) {
                all_events.extend(events);
            }
        }
    }

    // --- Summary ---
    let leaves: Vec<&SessionEvent> = all_events
        .iter()
        .filter(|e| e.event_type == "leave")
        .collect();
    let total_sessions = leaves.len();
    // Count unique users by display name (not identity, which has random suffixes)
    let mut unique_names: HashSet<String> = HashSet::new();
    for ev in &all_events {
        let key = if ev.name.is_empty() { ev.identity.clone() } else { ev.name.clone() };
        unique_names.insert(key);
    }
    let unique_users = unique_names.len();
    let total_secs: u64 = leaves.iter().filter_map(|e| e.duration_secs).sum();
    let total_hours = (total_secs as f64 / 3600.0 * 10.0).round() / 10.0;
    let avg_duration_mins = if total_sessions > 0 {
        ((total_secs as f64 / total_sessions as f64) / 60.0 * 10.0).round() / 10.0
    } else {
        0.0
    };

    // --- Per-user stats (grouped by display name, not identity) ---
    let mut user_map: HashMap<String, (usize, u64)> = HashMap::new();
    for ev in &leaves {
        let key = if ev.name.is_empty() { ev.identity.clone() } else { ev.name.clone() };
        let entry = user_map.entry(key).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += ev.duration_secs.unwrap_or(0);
    }
    let mut per_user: Vec<UserSessionStats> = user_map
        .into_iter()
        .map(|(name, (count, secs))| UserSessionStats {
            identity: name.clone(),
            name,
            session_count: count,
            total_hours: (secs as f64 / 3600.0 * 10.0).round() / 10.0,
        })
        .collect();
    per_user.sort_by(|a, b| b.session_count.cmp(&a.session_count));

    // --- Heatmap: send raw join timestamps (last 7 days), let frontend group by local timezone ---
    let seven_days_ago = now.saturating_sub(7 * 86400);
    let heatmap_joins: Vec<HeatmapJoin> = all_events
        .iter()
        .filter(|e| e.event_type == "join" && e.timestamp >= seven_days_ago)
        .map(|e| HeatmapJoin {
            timestamp: e.timestamp,
            name: e.name.clone(),
        })
        .collect();

    // --- Timeline: send raw events for last 24h, let frontend compute local "today" ---
    let day_ago = now.saturating_sub(86400);
    let timeline_events: Vec<TimelineEvent> = all_events
        .iter()
        .filter(|e| e.timestamp >= day_ago)
        .map(|e| TimelineEvent {
            identity: e.identity.clone(),
            name: e.name.clone(),
            event_type: e.event_type.clone(),
            timestamp: e.timestamp,
            duration_secs: e.duration_secs,
        })
        .collect();

    Ok(Json(DashboardMetricsResponse {
        summary: DashboardSummary {
            total_sessions,
            unique_users,
            total_hours,
            avg_duration_mins,
        },
        per_user,
        heatmap_joins,
        timeline_events,
    }))
}

async fn admin_report_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ClientStats>,
) -> Result<StatusCode, StatusCode> {
    ensure_admin(&state, &headers)?;
    let mut stats = state.client_stats.lock().unwrap_or_else(|e| e.into_inner());
    let mut entry = payload;
    entry.updated_at = now_ts();

    // Capture snapshot before insert moves entry
    let snapshot = StatsSnapshot {
        identity: entry.identity.clone(),
        name: entry.name.clone(),
        timestamp: entry.updated_at,
        screen_fps: entry.screen_fps,
        screen_bitrate_kbps: entry.screen_bitrate_kbps,
        quality_limitation: entry.quality_limitation.clone(),
        encoder: entry.encoder.clone(),
        ice_local_type: entry.ice_local_type.clone(),
        ice_remote_type: entry.ice_remote_type.clone(),
    };

    stats.insert(entry.identity.clone(), entry);

    {
        let mut history = state
            .stats_history
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        history.push(snapshot);
        if history.len() > 1000 {
            let excess = history.len() - 1000;
            history.drain(0..excess);
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn admin_metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminMetricsResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let history = state
        .stats_history
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let mut grouped: HashMap<String, Vec<&StatsSnapshot>> = HashMap::new();
    for snap in history.iter() {
        grouped.entry(snap.identity.clone()).or_default().push(snap);
    }

    let mut users: Vec<UserMetrics> = Vec::new();
    for (identity, snaps) in &grouped {
        let name = snaps.last().map(|s| s.name.clone()).unwrap_or_default();
        let count = snaps.len();
        let fps_vals: Vec<f64> = snaps.iter().filter_map(|s| s.screen_fps).collect();
        let bitrate_vals: Vec<f64> = snaps
            .iter()
            .filter_map(|s| s.screen_bitrate_kbps.map(|v| v as f64))
            .collect();
        let avg_fps = if fps_vals.is_empty() {
            0.0
        } else {
            fps_vals.iter().sum::<f64>() / fps_vals.len() as f64
        };
        let avg_bitrate = if bitrate_vals.is_empty() {
            0.0
        } else {
            bitrate_vals.iter().sum::<f64>() / bitrate_vals.len() as f64
        };
        let bw_limited = snaps
            .iter()
            .filter(|s| s.quality_limitation.as_deref() == Some("bandwidth"))
            .count();
        let cpu_limited = snaps
            .iter()
            .filter(|s| s.quality_limitation.as_deref() == Some("cpu"))
            .count();
        let pct_bw = if count > 0 {
            (bw_limited as f64 / count as f64) * 100.0
        } else {
            0.0
        };
        let pct_cpu = if count > 0 {
            (cpu_limited as f64 / count as f64) * 100.0
        } else {
            0.0
        };
        let total_minutes = (count as f64 * 2.0) / 60.0;

        // Most common encoder
        let mut enc_counts: HashMap<String, usize> = HashMap::new();
        for s in snaps.iter() {
            if let Some(ref e) = s.encoder {
                *enc_counts.entry(e.clone()).or_default() += 1;
            }
        }
        let encoder = enc_counts.into_iter().max_by_key(|(_, c)| *c).map(|(e, _)| e);

        // Most common ICE types
        let mut ice_local_counts: HashMap<String, usize> = HashMap::new();
        let mut ice_remote_counts: HashMap<String, usize> = HashMap::new();
        for s in snaps.iter() {
            if let Some(ref t) = s.ice_local_type {
                *ice_local_counts.entry(t.clone()).or_default() += 1;
            }
            if let Some(ref t) = s.ice_remote_type {
                *ice_remote_counts.entry(t.clone()).or_default() += 1;
            }
        }
        let ice_local_type = ice_local_counts
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(t, _)| t);
        let ice_remote_type = ice_remote_counts
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(t, _)| t);

        users.push(UserMetrics {
            identity: identity.clone(),
            name,
            sample_count: count,
            avg_fps: (avg_fps * 10.0).round() / 10.0,
            avg_bitrate_kbps: avg_bitrate.round(),
            pct_bandwidth_limited: (pct_bw * 10.0).round() / 10.0,
            pct_cpu_limited: (pct_cpu * 10.0).round() / 10.0,
            total_minutes: (total_minutes * 10.0).round() / 10.0,
            encoder,
            ice_local_type,
            ice_remote_type,
        });
    }

    users.sort_by(|a, b| {
        b.total_minutes
            .partial_cmp(&a.total_minutes)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(Json(AdminMetricsResponse { users }))
}

async fn submit_bug_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BugReportRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let now = now_ts();
    info!("Bug report received (len={})", payload.description.len());

    let report = BugReport {
        id: now,
        identity: payload
            .identity
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
        name: payload
            .name
            .clone()
            .unwrap_or_else(|| "Unknown".to_string()),
        room: payload.room.unwrap_or_default(),
        description: payload.description,
        timestamp: now,
        screen_fps: payload.screen_fps,
        screen_bitrate_kbps: payload.screen_bitrate_kbps,
        bwe_kbps: payload.bwe_kbps,
        quality_limitation: payload.quality_limitation,
        encoder: payload.encoder,
        ice_local_type: payload.ice_local_type,
        ice_remote_type: payload.ice_remote_type,
        screenshot_url: payload.screenshot_url,
    };

    append_bug_report(&state.bug_log_dir, &report);

    {
        let mut reports = state.bug_reports.lock().unwrap_or_else(|e| e.into_inner());
        reports.push(report);
        if reports.len() > 200 {
            let excess = reports.len() - 200;
            reports.drain(0..excess);
        }
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn admin_bug_reports(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<BugReportsResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let in_mem = state.bug_reports.lock().unwrap_or_else(|e| e.into_inner());
    let mut all: Vec<BugReport> = in_mem.clone();
    drop(in_mem);

    // Load all bug report files from disk for persistence across restarts
    if let Ok(entries) = fs::read_dir(&state.bug_log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json")
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("bugs-"))
                    .unwrap_or(false)
            {
                if let Ok(data) = fs::read_to_string(&path) {
                    if let Ok(disk_reports) = serde_json::from_str::<Vec<BugReport>>(&data) {
                        for dr in disk_reports {
                            if !all.iter().any(|r| r.id == dr.id) {
                                all.push(dr);
                            }
                        }
                    }
                }
            }
        }
    }

    all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    all.truncate(200);

    Ok(Json(BugReportsResponse { reports: all }))
}

async fn soundboard_list(
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

async fn soundboard_file(
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

async fn soundboard_upload(
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

async fn soundboard_update(
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

#[derive(Deserialize)]
struct CreateRoomRequest {
    room_id: String,
}

#[derive(Serialize)]
struct MetricsResponse {
    rooms: u64,
    ts: u64,
}

// ── Jam Session (Spotify integration) endpoints ────────────────────────

#[derive(Deserialize)]
struct SpotifyInitRequest {
    state: String,
    challenge: String,
}

#[derive(Deserialize)]
struct SpotifyCallbackQuery {
    code: String,
    state: String,
}

#[derive(Deserialize)]
struct SpotifyCodeQuery {
    state: String,
}

#[derive(Deserialize)]
struct SpotifyTokenRequest {
    code: String,
    verifier: String,
}

#[derive(Deserialize)]
struct JamStartRequest {
    identity: String,
}

#[derive(Deserialize)]
struct JamSearchRequest {
    query: String,
}

#[derive(Deserialize)]
struct JamQueueRequest {
    spotify_uri: String,
    name: String,
    artist: String,
    album_art_url: String,
    duration_ms: u64,
    added_by: String,
}

#[derive(Deserialize)]
struct JamIdentityRequest {
    identity: String,
}

async fn jam_spotify_init(
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

async fn jam_spotify_callback(
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

async fn jam_spotify_code(
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

async fn jam_spotify_token(
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

fn persist_spotify_token(path: &std::path::Path, token: &SpotifyToken) {
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

// ── Spotify API proxy helper ───────────────────────────────────────────

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

// ── Jam Session endpoints ──────────────────────────────────────────────

/// Stop the jam audio bot if it's running.
async fn stop_jam_bot(state: &AppState) {
    let bot = state.jam_bot.lock().await.take();
    if let Some(bot) = bot {
        bot.stop().await;
    }
}

/// Schedule a jam auto-end: if no listeners remain after 30 seconds, stop the jam.
/// Called from jam_leave, participant disconnect, and stale participant cleanup.
fn schedule_jam_auto_end(
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

async fn jam_start(
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
        match jam_bot::JamBot::start().await {
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

async fn jam_stop(
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

async fn jam_state(
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

async fn jam_search(
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

async fn jam_queue_add(
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

async fn jam_queue_remove(
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

async fn jam_skip(
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

async fn jam_join(
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

async fn jam_leave(
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

/// WebSocket endpoint for streaming jam audio to viewers.
/// Clients connect to wss://host:9443/api/jam/audio?token=JWT and receive
/// binary messages containing raw f32 PCM (48 kHz stereo, 20 ms frames).
async fn jam_audio_ws(
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

/// Simple URL encoding for query parameters
fn urlencoded(s: &str) -> String {
    let mut result = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}

/// Strip the -XXXX numeric suffix from identities like "sam-1234" -> "sam"
/// Reconnects change the suffix, so compare base identities for host checks.
fn identity_base(identity: &str) -> &str {
    if let Some(pos) = identity.rfind('-') {
        let suffix = &identity[pos + 1..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
            return &identity[..pos];
        }
    }
    identity
}

// ── End Jam Session endpoints ──────────────────────────────────────────

// ── Admin: kick / mute participants via LiveKit SFU REST API ─────────

/// Generate a short-lived LiveKit service JWT for SFU admin API calls.
fn livekit_service_token(api_key: &str, api_secret: &str, room: &str) -> Result<String, StatusCode> {
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

/// POST /v1/rooms/:room_id/kick/:identity — Remove a participant from a room
async fn admin_kick_participant(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path((room_id, identity)): axum::extract::Path<(String, String)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    info!("ADMIN KICK: room={} identity={}", room_id, identity);

    let sfu_url =
        std::env::var("CORE_SFU_HTTP").unwrap_or_else(|_| "http://127.0.0.1:7880".to_string());
    let token = livekit_service_token(
        &state.config.livekit_api_key,
        &state.config.livekit_api_secret,
        &room_id,
    )?;

    // Call LiveKit RemoveParticipant API
    let resp = state
        .http_client
        .post(format!(
            "{}/twirp/livekit.RoomService/RemoveParticipant",
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
            error!("kick SFU call failed: {}", e);
            StatusCode::BAD_GATEWAY
        })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        error!("SFU RemoveParticipant failed ({}): {}", status, body);
        return Err(StatusCode::BAD_GATEWAY);
    }

    // Also remove from our local participant tracking
    {
        let mut participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
        participants.retain(|_, p| p.identity != identity);
    }

    info!("ADMIN KICK success: {} from {}", identity, room_id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// POST /v1/rooms/:room_id/mute/:identity — Mute all published tracks for a participant
async fn admin_mute_participant(
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

fn ensure_admin(state: &AppState, headers: &HeaderMap) -> Result<(), StatusCode> {
    let Some(auth) = headers.get("authorization") else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let auth = auth.to_str().map_err(|_| StatusCode::UNAUTHORIZED)?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;
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
    Ok(())
}

fn verify_password(config: &Config, password: &str) -> bool {
    if let Some(hash) = &config.admin_password_hash {
        if let Ok(parsed) = PasswordHash::new(hash) {
            return Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok();
        }
    }
    if let Some(plain) = &config.admin_password {
        return plain == password;
    }
    warn!("admin password not configured");
    false
}

fn ensure_livekit(state: &AppState, headers: &HeaderMap) -> Result<LiveKitClaims, StatusCode> {
    let Some(auth) = headers.get("authorization") else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let auth = auth.to_str().map_err(|_| StatusCode::UNAUTHORIZED)?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let validation = Validation::default();
    let decoded = decode::<LiveKitClaims>(
        token,
        &DecodingKey::from_secret(state.config.livekit_api_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| StatusCode::UNAUTHORIZED)?;
    if decoded.claims.iss != state.config.livekit_api_key {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(decoded.claims)
}

fn soundboard_public(sound: &SoundboardSound) -> SoundboardPublic {
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
    dir.join(room_id)
}

fn soundboard_file_path(dir: &PathBuf, room_id: &str, file_name: &str) -> PathBuf {
    soundboard_room_dir(dir, room_id).join(file_name)
}

fn load_soundboard(state: &mut SoundboardState) {
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

// ==================== CHAT HELPERS ====================

fn chat_history_path(dir: &PathBuf, room: &str) -> PathBuf {
    dir.join(format!("{}.json", room))
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

fn save_chat_message(dir: &PathBuf, message: &ChatMessage) {
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

fn delete_chat_message(dir: &PathBuf, room: &str, message_id: &str, requester: &str) -> bool {
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

// ==================== CHAT API HANDLERS ====================

async fn chat_delete_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ChatDeleteRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let chat = state.chat.lock().unwrap_or_else(|e| e.into_inner());
    let deleted = delete_chat_message(&chat.dir, &payload.room, &payload.id, &payload.identity);
    if deleted {
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Ok(Json(serde_json::json!({ "ok": false, "error": "Message not found or not yours" })))
    }
}

async fn chat_save_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(message): Json<ChatMessage>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let chat = state.chat.lock().unwrap_or_else(|e| e.into_inner());
    save_chat_message(&chat.dir, &message);
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn chat_get_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room): Path<String>,
) -> Result<Json<Vec<ChatMessage>>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let chat = state.chat.lock().unwrap_or_else(|e| e.into_inner());
    let history = load_chat_history(&chat.dir, &room);
    Ok(Json(history))
}

async fn chat_upload_file(
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

async fn chat_get_upload(
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

// ── Avatar endpoints ────────────────────────────────────────────────

async fn avatar_upload(
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

async fn avatar_get(
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

// ── Chime endpoints ─────────────────────────────────────────────────

fn chime_mime_from_ext(fname: &str) -> String {
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

async fn chime_upload(
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

async fn chime_get(
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

async fn chime_delete(
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

fn load_config() -> Config {
    let host = std::env::var("CORE_BIND").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port = std::env::var("CORE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9090);
    let admin_password_hash = std::env::var("CORE_ADMIN_PASSWORD_HASH").ok();
    let admin_password = std::env::var("CORE_ADMIN_PASSWORD").ok();
    let admin_jwt_secret =
        std::env::var("CORE_ADMIN_JWT_SECRET").unwrap_or_else(|_| random_secret());
    let admin_token_ttl_secs = std::env::var("CORE_ADMIN_TOKEN_TTL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(43200);

    let livekit_api_key = std::env::var("LK_API_KEY").unwrap_or_else(|_| "LK_API_KEY".to_string());
    let livekit_api_secret =
        std::env::var("LK_API_SECRET").unwrap_or_else(|_| "LK_API_SECRET".to_string());
    let livekit_token_ttl_secs = std::env::var("LK_TOKEN_TTL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(14400);
    let soundboard_dir =
        std::env::var("CORE_SOUNDBOARD_DIR").unwrap_or_else(|_| "../logs/soundboard".to_string());
    let soundboard_max_mb = std::env::var("CORE_SOUNDBOARD_MAX_MB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(8);
    let soundboard_max_bytes = soundboard_max_mb.max(1) * 1024 * 1024;
    let soundboard_max_sounds_per_room = std::env::var("CORE_SOUNDBOARD_MAX_SOUNDS_PER_ROOM")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);

    let chat_dir = std::env::var("CORE_CHAT_DIR").unwrap_or_else(|_| "../logs/chat".to_string());
    let chat_uploads_dir = std::env::var("CORE_CHAT_UPLOADS_DIR")
        .unwrap_or_else(|_| "../logs/chat-uploads".to_string());
    let chat_max_upload_mb = std::env::var("CORE_CHAT_MAX_UPLOAD_MB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(10);
    let chat_max_upload_bytes = chat_max_upload_mb.max(1) * 1024 * 1024;

    Config {
        host,
        port,
        admin_password_hash,
        admin_password,
        admin_jwt_secret,
        admin_token_ttl_secs,
        livekit_api_key,
        livekit_api_secret,
        livekit_token_ttl_secs,
        soundboard_dir: resolve_path(soundboard_dir),
        soundboard_max_bytes,
        soundboard_max_sounds_per_room,
        chat_dir: resolve_path(chat_dir),
        chat_uploads_dir: resolve_path(chat_uploads_dir),
        chat_max_upload_bytes,
    }
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}

fn now_ts_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis() as u64
}

fn default_soundboard_icon() -> String {
    "\u{1F50A}".to_string()
}

fn default_soundboard_volume() -> u16 {
    100
}

fn append_session_event(dir: &std::path::Path, event: &SessionEvent) {
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

fn append_bug_report(dir: &std::path::Path, report: &BugReport) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days_since_epoch = now / 86400;
    let (year, month, day) = epoch_days_to_date(days_since_epoch);
    let file_name = format!("bugs-{:04}-{:02}-{:02}.json", year, month, day);
    let file_path = dir.join(&file_name);

    let mut reports: Vec<BugReport> = if let Ok(data) = fs::read_to_string(&file_path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };
    reports.push(report.clone());

    if let Ok(json) = serde_json::to_string_pretty(&reports) {
        let _ = fs::write(&file_path, json);
    }
}

fn epoch_days_to_date(days: u64) -> (u64, u64, u64) {
    // Simplified date calculation from Unix epoch days
    let mut y: i64 = 1970;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap_year(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let month_days = if is_leap_year(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 0;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining < md as i64 {
            m = i;
            break;
        }
        remaining -= md as i64;
    }
    (y as u64, (m + 1) as u64, (remaining + 1) as u64)
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
