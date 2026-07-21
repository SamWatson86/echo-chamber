mod admin;
mod auth;
mod chat;
mod config;
mod diagnostics;
mod diagnostics_api;
mod diagnostics_auth;
pub mod file_serving;
mod jam_bot;
mod jam_session;
mod jam_source;
mod rooms;
pub mod sfu_proxy;
mod soundboard;

use admin::*;
use auth::*;
use chat::*;
use config::*;
use diagnostics_api::*;
use diagnostics_auth::*;
use file_serving::*;
use jam_session::*;
use jam_source::*;
use rooms::*;
use sfu_proxy::*;
use soundboard::*;

use axum::http::HeaderValue;
use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post},
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use serde::Serialize;
use std::{
    collections::HashMap,
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
use tracing::{info, warn};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) config: Arc<Config>,
    pub(crate) rooms: Arc<Mutex<HashMap<String, RoomInfo>>>,
    pub(crate) participants: Arc<Mutex<HashMap<String, ParticipantEntry>>>,
    pub(crate) participant_bindings: Arc<Mutex<HashMap<String, ParticipantBinding>>>,
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
    pub(crate) jam_source: jam_source::JamSourceRegistry,
    pub(crate) jam_lifecycle: Arc<tokio::sync::Mutex<()>>,
    pub(crate) jam_state_refresh: Arc<tokio::sync::Mutex<()>>,
    pub(crate) spotify_client_id: String,
    pub(crate) spotify_pending: Arc<Mutex<Option<SpotifyPending>>>,
    pub(crate) spotify_token_file: PathBuf,
    pub(crate) http_client: reqwest::Client,
    pub(crate) viewer_stamp: Arc<RwLock<String>>,
    pub(crate) login_attempts: Arc<Mutex<HashMap<IpAddr, (u32, Instant)>>>,
    pub(crate) owner_login_attempts: Arc<Mutex<OwnerLoginLimiter>>,
    pub(crate) diagnostics: Option<Arc<DiagnosticsRuntime>>,
}

#[derive(Clone, Serialize)]
pub(crate) struct ParticipantEntry {
    pub(crate) identity: String,
    pub(crate) name: String,
    pub(crate) room_id: String,
    pub(crate) last_seen: u64,
    /// Proof that this participant completed an authenticated heartbeat. Token
    /// issuance may seed presence, but it must not count as a live connection.
    #[serde(skip_serializing)]
    pub(crate) last_heartbeat_at: Option<u64>,
    pub(crate) viewer_version: Option<String>,
}

#[derive(Clone)]
pub(crate) struct ParticipantBinding {
    // Private browser-install capability. This registry is memory-only and is
    // never serialized into participant/status responses or logs.
    pub(crate) auth_key: String,
    pub(crate) auth_id: String,
}

fn remove_stale_participants_exact(
    participants: &mut HashMap<String, ParticipantEntry>,
    bindings: &HashMap<String, ParticipantBinding>,
    jam: &mut JamState,
    now: u64,
) -> (Vec<ParticipantEntry>, Option<u64>) {
    let stale_identities: Vec<String> = participants
        .iter()
        .filter(|(_, participant)| now.saturating_sub(participant.last_seen) >= 20)
        .map(|(identity, _)| identity.clone())
        .collect();
    let mut removed = Vec::new();

    for identity in stale_identities {
        let Some(binding_auth_id) = bindings
            .get(&identity)
            .map(|binding| binding.auth_id.clone())
        else {
            continue;
        };
        let has_current_audio = jam.active
            && jam.listeners.get(&identity) == Some(&binding_auth_id)
            && jam
                .audio_connections
                .get(&identity)
                .map(|connection| {
                    connection.participant_auth_id == binding_auth_id
                        && connection.generation == jam.generation
                })
                .unwrap_or(false);
        if has_current_audio {
            continue;
        }

        if let Some(entry) = participants.remove(&identity) {
            removed.push(entry);
        }
        if jam.listeners.get(&identity) == Some(&binding_auth_id) {
            jam.listeners.remove(&identity);
            info!("Jam: removed stale listener {}", identity);
        }
        let remove_audio = jam
            .audio_connections
            .get(&identity)
            .map(|connection| connection.participant_auth_id == binding_auth_id)
            .unwrap_or(false);
        if remove_audio {
            jam.audio_connections.remove(&identity);
        }
    }

    let auto_end_generation = (jam.active && jam.listeners.is_empty()).then_some(jam.generation);
    (removed, auto_end_generation)
}

#[tokio::main]
async fn main() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    tracing_subscriber::fmt().with_env_filter("info").init();

    load_dotenv();
    let mut loaded_config = load_config();
    let diagnostics_owner_requested = loaded_config.diagnostics_owner_secret.is_some();
    if !diagnostics_owner_secret_is_safe(&loaded_config) {
        loaded_config.diagnostics_owner_secret = None;
        if diagnostics_owner_requested {
            warn!(
                "owner diagnostics disabled: CORE_DIAGNOSTICS_OWNER_SECRET is weak or reuses another credential"
            );
        }
    }
    let config = Arc::new(loaded_config);
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

    let viewer_dir = resolve_viewer_dir();
    info!("viewer dir: {:?}", viewer_dir);
    let admin_dir = resolve_admin_dir();
    info!("admin dir: {:?}", admin_dir);

    let diagnostics_dir = std::env::var("CORE_DIAGNOSTICS_DIR")
        .map(resolve_path)
        .unwrap_or_else(|_| {
            session_log_dir
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("diagnostics")
        });
    let retention_days = std::env::var("CORE_DIAGNOSTICS_RETENTION_DAYS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(diagnostics::DEFAULT_RETENTION.as_secs() / (24 * 60 * 60))
        .clamp(1, 30);
    let max_megabytes = std::env::var("CORE_DIAGNOSTICS_MAX_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(diagnostics::DEFAULT_DISK_CAP_BYTES / (1024 * 1024))
        .clamp(1, 1_024);
    let retention = diagnostics::RetentionPolicy {
        max_age: Duration::from_secs(retention_days * 24 * 60 * 60),
        max_total_bytes: max_megabytes * 1024 * 1024,
    };
    let diagnostics_owner_enabled = config.diagnostics_owner_secret.is_some();
    let should_open_diagnostics = diagnostics_owner_enabled || diagnostics_dir.exists();
    let diagnostics_runtime = if should_open_diagnostics {
        match diagnostics::storage_path_overlaps(
            &diagnostics_dir,
            &[
                &viewer_dir,
                &admin_dir,
                &config.chat_dir,
                &config.chat_uploads_dir,
                &config.soundboard_dir,
                &avatars_dir,
                &chimes_dir,
            ],
        ) {
            Ok(true) => {
                if diagnostics_dir.exists() {
                    panic!(
                        "refusing to start: existing diagnostics storage is not isolated from web-readable roots"
                    );
                }
                warn!(
                    "private diagnostics disabled: storage is not isolated from web-readable roots"
                );
                None
            }
            Ok(false) => match DiagnosticsRuntime::open(&diagnostics_dir, retention) {
                Ok(runtime) => Some(Arc::new(runtime)),
                Err(error) => {
                    warn!(
                        "private diagnostics disabled: storage unavailable: {}",
                        error
                    );
                    None
                }
            },
            Err(error) => {
                if diagnostics_dir.exists() {
                    panic!(
                        "refusing to start: existing diagnostics storage isolation could not be validated: {}",
                        error
                    );
                }
                warn!(
                    "private diagnostics disabled: storage path validation failed: {}",
                    error
                );
                None
            }
        }
    } else {
        None
    };
    let diagnostics = if diagnostics_owner_enabled {
        if diagnostics_runtime.is_some() {
            info!("private diagnostics enabled at {:?}", diagnostics_dir);
        }
        diagnostics_runtime.clone()
    } else {
        info!("private diagnostics disabled (owner credential not configured)");
        None
    };
    // Keep an already-existing store under retention even when collection and
    // owner access are disabled by removing the owner credential.
    let diagnostics_pruner = diagnostics_runtime;

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

    let jam_source_configured = config.jam_source_id.is_some() && config.jam_source_token.is_some();
    let http_client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .expect("build bounded HTTP client");
    let state = AppState {
        config: config.clone(),
        rooms: Arc::new(Mutex::new(HashMap::new())),
        participants: Arc::new(Mutex::new(HashMap::new())),
        participant_bindings: Arc::new(Mutex::new(HashMap::new())),
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
        jam_source: jam_source::JamSourceRegistry::new(jam_source_configured),
        jam_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
        jam_state_refresh: Arc::new(tokio::sync::Mutex::new(())),
        spotify_token_file,
        http_client,
        viewer_stamp: Arc::new(RwLock::new(viewer_stamp.clone())),
        login_attempts: Arc::new(Mutex::new(HashMap::new())),
        owner_login_attempts: Arc::new(Mutex::new(OwnerLoginLimiter::default())),
        diagnostics,
    };

    // Enforce age retention even when the service is idle or receives only
    // duplicate uploads. Store locking serializes this with ingest and owner
    // reads, and diagnostics remain disabled when no private owner secret is
    // configured.
    if let Some(runtime) = diagnostics_pruner {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
                let runtime_for_prune = Arc::clone(&runtime);
                let result =
                    tokio::task::spawn_blocking(move || runtime_for_prune.prune(now_ts_ms())).await;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => warn!("diagnostics retention pruning failed: {}", error),
                    Err(error) => warn!("diagnostics retention task failed: {}", error),
                }
            }
        });
    }

    // Local source consent is authoritative. Turning Jam sharing off on the
    // source PC pauses the bound Spotify device, ends only the current
    // generation, and then releases the native per-app output route. A source
    // disconnect fails closed immediately: the desktop deliberately delays
    // local route release long enough for this pause-first teardown to run.
    {
        let source_event_state = state.clone();
        let mut source_events = state.jam_source.subscribe();
        tokio::spawn(async move {
            let mut health_watchdog = tokio::time::interval(Duration::from_secs(5));
            health_watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    event = source_events.recv() => match event {
                        Ok(SourceEvent::AvailabilityChanged {
                            enabled: false,
                            generation: Some(generation),
                            error,
                        }) => {
                            let reason = error.unwrap_or_else(|| {
                                "Jam sharing was turned off on the source PC".to_string()
                            });
                            end_jam_for_source_unavailable(&source_event_state, generation, reason)
                                .await;
                        }
                        Ok(SourceEvent::Error {
                            generation,
                            message,
                        }) => {
                            end_jam_for_source_unavailable(
                                &source_event_state,
                                generation,
                                format!("Jam source failed: {message}"),
                            )
                            .await;
                        }
                        Ok(SourceEvent::Disconnected {
                            generation: Some(generation),
                        }) => {
                            end_jam_for_source_unavailable(
                                &source_event_state,
                                generation,
                                "Jam source disconnected from the source PC".to_string(),
                            )
                            .await;
                        }
                        Ok(SourceEvent::ConnectionReplaced {
                            generation: Some(generation),
                        }) => {
                            end_jam_for_source_unavailable(
                                &source_event_state,
                                generation,
                                "Jam source connection was replaced".to_string(),
                            )
                            .await;
                        }
                        Ok(_) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                            warn!("Jam source lifecycle watcher lagged by {} event(s)", count);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    },
                    _ = health_watchdog.tick() => {
                        end_active_jam_if_source_unhealthy(&source_event_state).await;
                    }
                }
            }
        });
    }

    // Background task: clean up stale participants (no heartbeat for 20s)
    {
        let participants = state.participants.clone();
        let participant_bindings = state.participant_bindings.clone();
        let joined_at = state.joined_at.clone();
        let client_stats = state.client_stats.clone();
        let session_log_dir = state.session_log_dir.clone();
        let jam_for_cleanup = state.jam.clone();
        let state_for_cleanup = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                // Final presence, binding, listener, and audio checks are one
                // critical section. A live audio socket fences a throttled
                // browser from stale-heartbeat eviction.
                let (removed_entries, auto_end_generation) = {
                    let mut participants = participants.lock().unwrap_or_else(|e| e.into_inner());
                    let bindings = participant_bindings
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    let mut jam = jam_for_cleanup.lock().unwrap_or_else(|e| e.into_inner());
                    remove_stale_participants_exact(&mut participants, &bindings, &mut jam, now)
                };
                if !removed_entries.is_empty() {
                    info!("cleaned up {} stale participant(s)", removed_entries.len());
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
                if let Some(generation) = auto_end_generation {
                    schedule_jam_auto_end(state_for_cleanup.clone(), generation, "stale cleanup");
                }
            }
        });
    }

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
            let watched_files = [
                "app.js",
                "style.css",
                "clubhouse-shell.css",
                "layout-policy.js",
                "ui-shell.js",
                "diagnostics-client.js",
                "grid-layout.js",
                "index.html",
                "connect.js",
                "room-status.js",
                "participants.js",
                "audio-routing.js",
                "media-controls.js",
                "chat.js",
                "soundboard.js",
                "state.js",
                "jam.js",
                "jam-session-state.js",
                "jam.css",
            ];
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

    let diagnostics_owner_routes = Router::new()
        .route("/", get(diagnostics_list))
        .route(
            "/:incident_id",
            get(diagnostics_get).delete(diagnostics_delete),
        )
        .route("/:incident_id/download", get(diagnostics_download))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_diagnostics_owner,
        ));

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
        .route("/api/client-stats-report", post(client_stats_report))
        .route(
            "/api/diagnostics/v1/envelopes",
            post(diagnostics_ingest)
                .layer(DefaultBodyLimit::max(diagnostics::MAX_REQUEST_BYTES))
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    diagnostics_ingest_admission,
                )),
        )
        .route("/admin/api/metrics", get(admin_metrics))
        .route("/admin/api/bugs", get(admin_bug_reports))
        .route("/admin/api/metrics/dashboard", get(admin_dashboard_metrics))
        .route("/admin/api/deploys", get(admin_deploys))
        .route("/admin/api/force-reload", post(admin_force_reload))
        .nest("/admin/api/diagnostics", diagnostics_owner_routes)
        .nest_service("/admin", ServeDir::new(admin_dir))
        .route("/rtc", get(sfu_proxy))
        .route("/sfu", get(sfu_proxy))
        .route("/sfu/rtc", get(sfu_proxy))
        .route("/health", get(health))
        .route("/v1/auth/login", post(login))
        .route(
            "/v1/auth/diagnostics/login",
            post(diagnostics_owner_login).layer(DefaultBodyLimit::max(4 * 1024)),
        )
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
        .route("/api/jam/playback/stop", post(jam_stop_playback))
        .route("/api/jam/skip", post(jam_skip))
        .route("/api/jam/join", post(jam_join))
        .route("/api/jam/leave", post(jam_leave))
        .route("/api/jam/audio", get(jam_audio_ws))
        .route("/api/jam/source", get(jam_source_ws))
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
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    }
}

// ── Admin: kick / mute participants via LiveKit SFU REST API ─────────

pub(crate) fn is_safe_path_component(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains(':')
        && !s.contains("..")
        && !s.chars().any(char::is_control)
        && s != "."
}

pub(crate) fn is_generated_chat_upload_name(file_name: &str) -> bool {
    is_safe_path_component(file_name)
        && file_name
            .strip_prefix("upload-")
            .map(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
            .unwrap_or(false)
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
    let diagnostics_owner_secret = std::env::var("CORE_DIAGNOSTICS_OWNER_SECRET")
        .ok()
        .filter(|secret| !secret.trim().is_empty());

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
    let turn_host = std::env::var("TURN_PUBLIC_IP")
        .ok()
        .filter(|s| !s.is_empty());
    let turn_port = std::env::var("TURN_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3478);

    let github_pat = std::env::var("GITHUB_PAT").ok().filter(|s| !s.is_empty());
    let github_repo = std::env::var("GITHUB_REPO").ok().filter(|s| !s.is_empty());
    let jam_source_id = std::env::var("JAM_SOURCE_ID")
        .ok()
        .filter(|s| !s.is_empty());
    let jam_source_token = std::env::var("JAM_SOURCE_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    let spotify_device_id = std::env::var("SPOTIFY_DEVICE_ID")
        .ok()
        .filter(|s| !s.is_empty());
    let spotify_device_name = std::env::var("SPOTIFY_DEVICE_NAME")
        .ok()
        .filter(|s| !s.is_empty());

    Config {
        host,
        port,
        admin_password_hash,
        admin_password,
        admin_jwt_secret,
        admin_token_ttl_secs,
        diagnostics_owner_secret,
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
        jam_source_id,
        jam_source_token,
        spotify_device_id,
        spotify_device_name,
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    fn participant(identity: &str, last_seen: u64) -> ParticipantEntry {
        ParticipantEntry {
            identity: identity.to_string(),
            name: identity.to_string(),
            room_id: "main".to_string(),
            last_seen,
            last_heartbeat_at: None,
            viewer_version: None,
        }
    }

    fn binding(auth_id: &str) -> ParticipantBinding {
        ParticipantBinding {
            auth_key: "a".repeat(64),
            auth_id: auth_id.to_string(),
        }
    }

    #[test]
    fn web_file_components_reject_decoded_traversal() {
        for unsafe_component in [
            "..",
            "../secret",
            "..\\secret",
            "folder/secret",
            "C:secret",
            "file:stream",
            ".",
        ] {
            assert!(!is_safe_path_component(unsafe_component));
        }
        assert!(is_safe_path_component("upload-1785000000000"));
        assert!(is_generated_chat_upload_name("upload-1785000000000"));
        assert!(!is_generated_chat_upload_name(
            "diagnostics-2026-07-21.jsonl"
        ));
    }

    #[test]
    fn active_audio_fences_stale_presence_cleanup() {
        let mut participants = HashMap::from([
            ("sam-7475".to_string(), participant("sam-7475", 1)),
            ("alex-2222".to_string(), participant("alex-2222", 1)),
        ]);
        let bindings = HashMap::from([
            ("sam-7475".to_string(), binding("binding-a")),
            ("alex-2222".to_string(), binding("binding-b")),
        ]);
        let mut jam = JamState {
            active: true,
            generation: 9,
            ..JamState::default()
        };
        jam.listeners
            .insert("sam-7475".to_string(), "binding-a".to_string());
        jam.listeners
            .insert("alex-2222".to_string(), "binding-b".to_string());
        jam.audio_connections.insert(
            "sam-7475".to_string(),
            jam_session::JamAudioConnection {
                participant_auth_id: "binding-a".to_string(),
                generation: 9,
                connection_id: 1,
            },
        );

        let (removed, auto_end) =
            remove_stale_participants_exact(&mut participants, &bindings, &mut jam, 30);

        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].identity, "alex-2222");
        assert!(participants.contains_key("sam-7475"));
        assert!(jam.listeners.contains_key("sam-7475"));
        assert!(!jam.listeners.contains_key("alex-2222"));
        assert_eq!(auto_end, None);
    }

    #[test]
    fn stale_cleanup_never_removes_a_newer_listener_binding() {
        let mut participants =
            HashMap::from([("sam-7475".to_string(), participant("sam-7475", 1))]);
        let bindings = HashMap::from([("sam-7475".to_string(), binding("binding-new"))]);
        let mut jam = JamState {
            active: true,
            generation: 9,
            ..JamState::default()
        };
        jam.listeners
            .insert("sam-7475".to_string(), "binding-old".to_string());

        let (removed, auto_end) =
            remove_stale_participants_exact(&mut participants, &bindings, &mut jam, 30);

        assert_eq!(removed.len(), 1);
        assert_eq!(
            jam.listeners.get("sam-7475").map(String::as_str),
            Some("binding-old")
        );
        assert_eq!(auto_end, None);
    }
}
