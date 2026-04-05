mod audio_capture;
mod auth;
mod chat;
mod config;
mod jam_bot;
pub mod file_serving;
mod rooms;
pub mod sfu_proxy;
mod soundboard;

use auth::*;
use chat::*;
use config::*;
use file_serving::*;
use rooms::*;
use sfu_proxy::*;
use soundboard::*;

use base64::Engine as _;
use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
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
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tower::Layer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::{error, info, warn};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) config: Arc<Config>,
    pub(crate) rooms: Arc<Mutex<HashMap<String, RoomInfo>>>,
    pub(crate) participants: Arc<Mutex<HashMap<String, ParticipantEntry>>>,
    pub(crate) soundboard: Arc<Mutex<SoundboardState>>,
    pub(crate) chat: Arc<Mutex<ChatState>>,
    pub(crate) avatars: Arc<Mutex<HashMap<String, String>>>, // identity_base -> filename
    pub(crate) avatars_dir: PathBuf,
    pub(crate) chimes: Arc<Mutex<HashMap<String, ChimeEntry>>>, // key: "identityBase-enter" or "identityBase-exit"
    pub(crate) chimes_dir: PathBuf,
    pub(crate) client_stats: Arc<Mutex<HashMap<String, ClientStats>>>,
    pub(crate) joined_at: Arc<Mutex<HashMap<String, u64>>>, // identity -> join timestamp
    pub(crate) session_log_dir: PathBuf,
    pub(crate) stats_history: Arc<Mutex<Vec<StatsSnapshot>>>,
    pub(crate) bug_reports: Arc<Mutex<Vec<BugReport>>>,
    pub(crate) bug_log_dir: PathBuf,
    // Jam Session (Spotify)
    pub(crate) jam: Arc<Mutex<JamState>>,
    pub(crate) jam_bot: Arc<tokio::sync::Mutex<Option<jam_bot::JamBot>>>,
    pub(crate) spotify_client_id: String,
    pub(crate) spotify_pending: Arc<Mutex<Option<SpotifyPending>>>,
    pub(crate) spotify_token_file: PathBuf,
    pub(crate) http_client: reqwest::Client,
    pub(crate) viewer_stamp: Arc<RwLock<String>>,
    pub(crate) login_attempts: Arc<Mutex<HashMap<IpAddr, (u32, Instant)>>>,
}

#[derive(Clone, Serialize)]
pub(crate) struct ParticipantEntry {
    pub(crate) identity: String,
    pub(crate) name: String,
    pub(crate) room_id: String,
    pub(crate) last_seen: u64,
    pub(crate) viewer_version: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default)]
    feedback_type: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    participant_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    connection_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    github_issue_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    github_issue_url: Option<String>,
}

#[derive(Deserialize)]
struct BugReportRequest {
    description: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    feedback_type: Option<String>,
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
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    user_agent: Option<String>,
    #[serde(default)]
    participant_count: Option<u32>,
    #[serde(default)]
    connection_state: Option<String>,
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
pub(crate) struct JamState {
    pub(crate) active: bool,
    pub(crate) host_identity: String,
    pub(crate) spotify_token: Option<SpotifyToken>,
    pub(crate) queue: Vec<QueuedTrack>,
    pub(crate) now_playing: Option<NowPlayingInfo>,
    pub(crate) listeners: HashSet<String>,
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

    // Viewer cache-busting stamp — unique per server start
    let viewer_stamp = format!(
        "{}.{}",
        env!("CARGO_PKG_VERSION"),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    );

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
        viewer_stamp: Arc::new(RwLock::new(viewer_stamp.clone())),
        login_attempts: Arc::new(Mutex::new(HashMap::new())),
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

    // Stamp viewer files with startup-unique cache-busting string
    stamp_viewer_index(&viewer_dir, &viewer_stamp);

    // Background task: watch viewer files for changes and re-stamp automatically.
    // This lets the stale banner fire without a full server restart when viewer
    // JS/CSS/HTML files are edited on disk.
    {
        let stamp = state.viewer_stamp.clone();
        let vdir = viewer_dir.clone();
        let mut startup = SystemTime::now();
        tokio::spawn(async move {
            let watched_files = ["app.js", "style.css", "index.html", "connect.js",
                                 "room-status.js", "participants.js", "audio-routing.js",
                                 "media-controls.js", "chat.js", "soundboard.js",
                                 "state.js", "jam.js"];
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                let changed = watched_files.iter().any(|f| {
                    vdir.join(f)
                        .metadata()
                        .and_then(|m| m.modified())
                        .map(|t| t > startup)
                        .unwrap_or(false)
                });
                if changed {
                    let new_stamp = format!(
                        "{}.{}",
                        env!("CARGO_PKG_VERSION"),
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs()
                    );
                    stamp_viewer_index(&vdir, &new_stamp);
                    if let Ok(mut s) = stamp.write() {
                        *s = new_stamp.clone();
                    }
                    info!("viewer files changed on disk — re-stamped to {}", new_stamp);
                    // Reset baseline so future edits are detected too
                    startup = SystemTime::now();
                }
            }
        });
    }

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
        .route("/admin/api/deploys", get(admin_deploys))
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
        .route("/v1/ice-servers", get(ice_servers))
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
            .serve(app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    } else {
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    }
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
        server_version: state.viewer_stamp.read().unwrap_or_else(|e| e.into_inner()).clone(),
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

    // Sort by timestamp descending (most recent first), limit to 1000
    all_events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    all_events.truncate(1000);

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

    // --- Heatmap: send raw join timestamps (last 30 days), let frontend group by local timezone ---
    let seven_days_ago = now.saturating_sub(30 * 86400);
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
        history.push(snapshot.clone());
        if history.len() > 1000 {
            let excess = history.len() - 1000;
            history.drain(0..excess);
        }
    }

    // Persist to disk
    append_stats_snapshot(&state.session_log_dir, &snapshot);

    Ok(StatusCode::NO_CONTENT)
}

async fn admin_metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminMetricsResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;

    // Load persisted stats from last 30 days of files
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let today_days = now / 86400;
    let mut all_snapshots: Vec<StatsSnapshot> = Vec::new();

    for offset in 0..30 {
        let days = today_days - offset;
        let (year, month, day) = epoch_days_to_date(days);
        let file_name = format!("stats-{:04}-{:02}-{:02}.json", year, month, day);
        let file_path = state.session_log_dir.join(&file_name);
        if let Ok(data) = fs::read_to_string(&file_path) {
            if let Ok(snapshots) = serde_json::from_str::<Vec<StatsSnapshot>>(&data) {
                all_snapshots.extend(snapshots);
            }
        }
    }

    // Also include any in-memory snapshots not yet written to today's file
    {
        let history = state
            .stats_history
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for snap in history.iter() {
            all_snapshots.push(snap.clone());
        }
    }

    // Dedup by timestamp+identity (in-memory may overlap with file)
    let mut seen = std::collections::HashSet::new();
    all_snapshots.retain(|s| seen.insert((s.timestamp, s.identity.clone())));

    let mut grouped: HashMap<String, Vec<&StatsSnapshot>> = HashMap::new();
    for snap in all_snapshots.iter() {
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

    let mut report = BugReport {
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
        title: payload.title,
        feedback_type: payload.feedback_type,
        timestamp: now,
        screen_fps: payload.screen_fps,
        screen_bitrate_kbps: payload.screen_bitrate_kbps,
        bwe_kbps: payload.bwe_kbps,
        quality_limitation: payload.quality_limitation,
        encoder: payload.encoder,
        ice_local_type: payload.ice_local_type,
        ice_remote_type: payload.ice_remote_type,
        screenshot_url: payload.screenshot_url,
        version: payload.version,
        user_agent: payload.user_agent,
        participant_count: payload.participant_count,
        connection_state: payload.connection_state,
        github_issue_number: None,
        github_issue_url: None,
    };

    // Create GitHub Issue if configured (10s timeout so we don't block the user)
    if let (Some(pat), Some(repo)) = (
        state.config.github_pat.clone(),
        state.config.github_repo.clone(),
    ) {
        let client = state.http_client.clone();
        let gh_report = report.clone();
        let uploads_dir = {
            let chat = state.chat.lock().unwrap_or_else(|e| e.into_inner());
            chat.uploads_dir.clone()
        };
        if let Ok(Some((number, url))) = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            create_github_issue(client, pat, repo, gh_report, uploads_dir),
        ).await {
            report.github_issue_number = Some(number);
            report.github_issue_url = Some(url);
        }
    }

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

async fn admin_deploys(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    // Read deploy history JSON written by deploy-watcher.ps1
    let history_file = std::path::Path::new("core/deploy/deploy-history.json");
    let deploy_events: Vec<serde_json::Value> = if history_file.exists() {
        match fs::read_to_string(history_file) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => vec![],
        }
    } else {
        vec![]
    };

    // Build SHA -> deploy event map (short SHA keys)
    let mut deploy_map: std::collections::HashMap<String, &serde_json::Value> =
        std::collections::HashMap::new();
    for event in &deploy_events {
        if let Some(sha) = event.get("sha").and_then(|v| v.as_str()) {
            deploy_map.entry(sha.to_string()).or_insert(event);
        }
    }

    // Run git log for recent commits on origin/main
    // Use ||| as field delimiter and %x00 as record separator (body can contain newlines)
    let git_output = std::process::Command::new("git")
        .args(["log", "--format=%H|||%an|||%s|||%aI|||%b%x00", "-30", "origin/main"])
        .output();

    let mut commits = vec![];
    if let Ok(output) = git_output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for record in stdout.split('\0') {
            let record = record.trim();
            if record.is_empty() {
                continue;
            }
            let parts: Vec<&str> = record.splitn(5, "|||").collect();
            if parts.len() < 4 {
                continue;
            }
            let sha = parts[0];
            let short_sha = &sha[..7.min(sha.len())];
            let author = parts[1];
            let message = parts[2];
            let timestamp = parts[3];
            let body = if parts.len() >= 5 { parts[4].trim() } else { "" };

            // Extract PR number from merge commit subjects like "Merge pull request #61 from ..."
            let pr_number: Option<u64> = if message.starts_with("Merge pull request #") {
                message
                    .strip_prefix("Merge pull request #")
                    .and_then(|rest| rest.split_whitespace().next())
                    .and_then(|num| num.parse().ok())
            } else {
                None
            };

            let (deploy_status, deploy_ts, deploy_error, deploy_duration) =
                if let Some(event) = deploy_map.get(short_sha) {
                    let status = event
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let ts = event
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let err = event
                        .get("error")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let dur = event
                        .get("duration_seconds")
                        .and_then(|v| v.as_i64());
                    (Some(status.to_string()), ts, err, dur)
                } else {
                    (None, None, None, None)
                };

            commits.push(serde_json::json!({
                "sha": sha,
                "short_sha": short_sha,
                "author": author,
                "message": message,
                "timestamp": timestamp,
                "pr_number": pr_number,
                "body": if body.is_empty() { None } else { Some(body) },
                "deploy_status": deploy_status,
                "deploy_timestamp": deploy_ts,
                "deploy_error": deploy_error,
                "deploy_duration": deploy_duration,
            }));
        }
    }

    Ok(Json(serde_json::json!({ "commits": commits })))
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


// ── End Jam Session endpoints ──────────────────────────────────────────

// ── Admin: kick / mute participants via LiveKit SFU REST API ─────────

/// Generate a short-lived LiveKit service JWT for SFU admin API calls.


pub(crate) fn is_safe_path_component(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains("..")
        && s != "."
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

    let turn_user = std::env::var("TURN_USER").ok().filter(|s| !s.is_empty());
    let turn_pass = std::env::var("TURN_PASS").ok().filter(|s| !s.is_empty());
    let turn_host = std::env::var("TURN_PUBLIC_IP").ok().filter(|s| !s.is_empty());
    let turn_port = std::env::var("TURN_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3478);

    let github_pat = std::env::var("GITHUB_PAT").ok().filter(|s| !s.is_empty());
    let github_repo = std::env::var("GITHUB_REPO").ok().filter(|s| !s.is_empty());

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
        turn_user,
        turn_pass,
        turn_host,
        turn_port,
        github_pat,
        github_repo,
    }
}




fn append_stats_snapshot(dir: &std::path::Path, snapshot: &StatsSnapshot) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days_since_epoch = now / 86400;
    let (year, month, day) = epoch_days_to_date(days_since_epoch);
    let file_name = format!("stats-{:04}-{:02}-{:02}.json", year, month, day);
    let file_path = dir.join(&file_name);

    let mut snapshots: Vec<StatsSnapshot> = if let Ok(data) = fs::read_to_string(&file_path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };
    snapshots.push(snapshot.clone());

    if let Ok(json) = serde_json::to_string(&snapshots) {
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

/// Create a GitHub Issue from a bug report.
/// Returns (issue_number, html_url) on success.
/// Silently returns None if creation fails.
async fn create_github_issue(client: reqwest::Client, pat: String, repo: String, report: BugReport, uploads_dir: PathBuf) -> Option<(u64, String)> {
    let feedback_type = report.feedback_type.as_deref().unwrap_or("bug");
    let prefix = match feedback_type {
        "enhancement" => "Enhancement",
        "idea" => "Idea",
        _ => "Bug",
    };
    let title = if let Some(ref t) = report.title {
        if !t.is_empty() {
            format!("{}: {}", prefix, t)
        } else if report.description.len() > 80 {
            format!("{}: {}...", prefix, &report.description[..77])
        } else {
            format!("{}: {}", prefix, report.description)
        }
    } else if report.description.len() > 80 {
        format!("{}: {}...", prefix, &report.description[..77])
    } else {
        format!("{}: {}", prefix, report.description)
    };

    let version_str = report.version.as_deref().unwrap_or("unknown");
    let mut body = format!(
        "**Reporter:** {}\n**Room:** {}\n**Version:** {}\n\n{}\n",
        report.name, report.room, version_str, report.description
    );

    // Add WebRTC stats table if any stats are present
    let has_stats = report.screen_fps.is_some()
        || report.screen_bitrate_kbps.is_some()
        || report.bwe_kbps.is_some()
        || report.quality_limitation.is_some()
        || report.encoder.is_some()
        || report.ice_local_type.is_some();

    if has_stats {
        body.push_str("\n### WebRTC Stats\n| Metric | Value |\n|--------|-------|\n");
        if let Some(fps) = report.screen_fps {
            body.push_str(&format!("| FPS | {:.1} |\n", fps));
        }
        if let Some(kbps) = report.screen_bitrate_kbps {
            body.push_str(&format!("| Bitrate | {} kbps |\n", kbps));
        }
        if let Some(bwe) = report.bwe_kbps {
            body.push_str(&format!("| Bandwidth Est. | {} kbps |\n", bwe));
        }
        if let Some(ref ql) = report.quality_limitation {
            body.push_str(&format!("| Quality Limit | {} |\n", ql));
        }
        if let Some(ref enc) = report.encoder {
            body.push_str(&format!("| Encoder | {} |\n", enc));
        }
        if let Some(ref ice) = report.ice_local_type {
            body.push_str(&format!("| ICE Local | {} |\n", ice));
        }
        if let Some(ref ice) = report.ice_remote_type {
            body.push_str(&format!("| ICE Remote | {} |\n", ice));
        }
    }

    if let Some(ref url) = report.screenshot_url {
        // Extract filename from upload URL (e.g. "/api/chat/uploads/upload-123" -> "upload-123")
        let file_name = url.rsplit('/').next().unwrap_or("");
        let file_path = uploads_dir.join(file_name);
        if !file_name.is_empty() {
            match fs::read(&file_path) {
                Ok(bytes) => {
                    // GitHub renders HTML in issue bodies; embed as base64 data URI.
                    // Cap at ~48KB raw (~64KB base64) to stay within GitHub's body limits.
                    if bytes.len() <= 48_000 {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        body.push_str(&format!(
                            "\n### Screenshot\n<details><summary>View screenshot</summary>\n\n<img src=\"data:image/png;base64,{}\" />\n\n</details>\n",
                            b64
                        ));
                    } else {
                        body.push_str(&format!(
                            "\n### Screenshot\nScreenshot attached locally ({}, {:.0} KB). File: `{}`\n",
                            file_name,
                            bytes.len() as f64 / 1024.0,
                            file_path.display()
                        ));
                    }
                }
                Err(_) => {
                    body.push_str(&format!("\n### Screenshot\nScreenshot referenced but file not found: `{}`\n", file_name));
                }
            }
        }
    }

    // Client diagnostics
    let has_diag = report.participant_count.is_some()
        || report.connection_state.is_some()
        || report.user_agent.is_some();
    if has_diag {
        body.push_str("\n### Client Info\n");
        if let Some(count) = report.participant_count {
            body.push_str(&format!("- **Participants in room:** {}\n", count));
        }
        if let Some(ref cs) = report.connection_state {
            body.push_str(&format!("- **Connection state:** {}\n", cs));
        }
        if let Some(ref ua) = report.user_agent {
            body.push_str(&format!("- **User agent:** {}\n", ua));
        }
    }

    body.push_str(&format!("\n---\n*Auto-created from in-app feedback ({})*", feedback_type));

    let url = format!("https://api.github.com/repos/{}/issues", repo);
    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "labels": [match feedback_type {
            "enhancement" => "enhancement",
            "idea" => "idea",
            _ => "bug-report",
        }],
    });

    match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", pat))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "echo-chamber-server")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) => {
            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.unwrap_or_default();
                let number = body["number"].as_u64();
                let html_url = body["html_url"].as_str().map(|s| s.to_string());
                if let (Some(n), Some(u)) = (number, html_url) {
                    info!("GitHub Issue #{} created for bug report from {}", n, report.name);
                    return Some((n, u));
                }
                info!("GitHub Issue created for bug report from {} (could not parse response)", report.name);
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                warn!("GitHub Issue creation failed ({}): {}", status, body);
            }
        }
        Err(e) => {
            warn!("GitHub Issue creation request failed: {}", e);
        }
    }
    None
}

pub(crate) fn epoch_days_to_date(days: u64) -> (u64, u64, u64) {
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
