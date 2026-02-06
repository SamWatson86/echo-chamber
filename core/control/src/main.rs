use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Json, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect},
    routing::{get, post},
    Router,
};
use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::http::HeaderValue;
use axum::extract::OriginalUri;
use axum_server::tls_rustls::RustlsConfig;
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use jsonwebtoken::{encode, decode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tracing::{info, warn};
use tower_http::services::ServeDir;
use tower_http::cors::{CorsLayer, Any};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use rcgen::generate_simple_self_signed;

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    rooms: Arc<Mutex<HashMap<String, RoomInfo>>>,
    participants: Arc<Mutex<HashMap<String, ParticipantEntry>>>,
    soundboard: Arc<Mutex<SoundboardState>>,
    chat: Arc<Mutex<ChatState>>,
}

#[derive(Clone, Serialize)]
struct ParticipantEntry {
    identity: String,
    name: String,
    room_id: String,
    last_seen: u64,
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
    #[serde(rename = "fileUrl", skip_serializing_if = "Option::is_none")]
    file_url: Option<String>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(rename = "fileType", skip_serializing_if = "Option::is_none")]
    file_type: Option<String>,
}

#[derive(Serialize)]
struct ChatUploadResponse {
    ok: bool,
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
struct ChatUploadQuery {
    room: String,
}

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
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    load_dotenv();
    let config = Arc::new(load_config());
    let max_body = config.soundboard_max_bytes.max(config.chat_max_upload_bytes);
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
    let state = AppState {
        config: config.clone(),
        rooms: Arc::new(Mutex::new(HashMap::new())),
        participants: Arc::new(Mutex::new(HashMap::new())),
        soundboard: Arc::new(Mutex::new(soundboard_state)),
        chat: Arc::new(Mutex::new(chat_state)),
    };

    // Background task: clean up stale participants (no heartbeat for 60s)
    {
        let participants = state.participants.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(15)).await;
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                let mut map = participants.lock().unwrap();
                let before = map.len();
                map.retain(|_, p| now.saturating_sub(p.last_seen) < 60);
                let removed = before - map.len();
                if removed > 0 {
                    info!("cleaned up {} stale participant(s)", removed);
                }
            }
        });
    }

    let viewer_dir = resolve_viewer_dir();
    info!("viewer dir: {:?}", viewer_dir);

    let app = Router::new()
        .route("/", get(root_route))
        .nest_service("/viewer", ServeDir::new(viewer_dir))
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
        .route("/api/chat/history/:room", get(chat_get_history))
        .route("/api/chat/upload", post(chat_upload_file))
        .route("/api/chat/uploads/:file_name", get(chat_get_upload))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
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
                    warn!("failed to load TLS cert/key ({}), generating self-signed", err);
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

async fn sfu_proxy(ws: WebSocketUpgrade, uri: OriginalUri, headers: HeaderMap) -> impl IntoResponse {
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
    let upstream_base = std::env::var("CORE_SFU_PROXY")
        .unwrap_or_else(|_| "ws://127.0.0.1:7880".to_string());
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
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", HeaderValue::from_static("livekit"));
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
                    _ => {}
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
    Json(HealthResponse { ok: true, ts: now_ts() })
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
    ).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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
    info!("issue token for room={} identity={}", payload.room, payload.identity);
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
    ).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Track participant in room
    {
        let mut participants = state.participants.lock().unwrap();
        participants.insert(payload.identity.clone(), ParticipantEntry {
            identity: payload.identity.clone(),
            name: payload.name.clone().unwrap_or_default(),
            room_id: payload.room.clone(),
            last_seen: now,
        });
    }

    Ok(Json(TokenResponse {
        token,
        expires_in_seconds: state.config.livekit_token_ttl_secs,
    }))
}

async fn list_rooms(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<RoomInfo>>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let rooms = state.rooms.lock().unwrap();
    Ok(Json(rooms.values().cloned().collect()))
}

async fn create_room(State(state): State<AppState>, headers: HeaderMap, Json(payload): Json<CreateRoomRequest>) -> Result<Json<RoomInfo>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let mut rooms = state.rooms.lock().unwrap();
    let entry = rooms.entry(payload.room_id.clone()).or_insert(RoomInfo {
        room_id: payload.room_id.clone(),
        created_at: now_ts(),
    });
    Ok(Json(entry.clone()))
}

async fn get_room(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(room_id): axum::extract::Path<String>) -> Result<Json<RoomInfo>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let rooms = state.rooms.lock().unwrap();
    match rooms.get(&room_id) {
        Some(info) => Ok(Json(info.clone())),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn delete_room(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(room_id): axum::extract::Path<String>) -> Result<impl IntoResponse, StatusCode> {
    ensure_admin(&state, &headers)?;
    let mut rooms = state.rooms.lock().unwrap();
    rooms.remove(&room_id);
    Ok(StatusCode::NO_CONTENT)
}

async fn rooms_status(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<RoomStatusEntry>>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let participants = state.participants.lock().unwrap();
    // Group participants by room
    let mut room_map: HashMap<String, Vec<RoomStatusParticipant>> = HashMap::new();
    for p in participants.values() {
        room_map.entry(p.room_id.clone()).or_default().push(RoomStatusParticipant {
            identity: p.identity.clone(),
            name: p.name.clone(),
        });
    }
    let result: Vec<RoomStatusEntry> = room_map.into_iter().map(|(room_id, participants)| {
        RoomStatusEntry { room_id, participants }
    }).collect();
    Ok(Json(result))
}

async fn participant_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TokenRequest>,
) -> Result<StatusCode, StatusCode> {
    ensure_admin(&state, &headers)?;
    let now = now_ts();
    let mut participants = state.participants.lock().unwrap();
    if let Some(entry) = participants.get_mut(&payload.identity) {
        entry.last_seen = now;
        entry.room_id = payload.room.clone();
        if let Some(name) = &payload.name {
            entry.name = name.clone();
        }
    } else {
        participants.insert(payload.identity.clone(), ParticipantEntry {
            identity: payload.identity.clone(),
            name: payload.name.clone().unwrap_or_default(),
            room_id: payload.room.clone(),
            last_seen: now,
        });
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn participant_leave(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ParticipantLeaveRequest>,
) -> Result<StatusCode, StatusCode> {
    ensure_admin(&state, &headers)?;
    let mut participants = state.participants.lock().unwrap();
    participants.remove(&payload.identity);
    Ok(StatusCode::NO_CONTENT)
}

async fn metrics(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<MetricsResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let rooms = state.rooms.lock().unwrap();
    Ok(Json(MetricsResponse {
        rooms: rooms.len() as u64,
        ts: now_ts(),
    }))
}

async fn soundboard_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SoundboardListQuery>,
) -> Result<Json<SoundboardListResponse>, StatusCode> {
    ensure_livekit(&state, &headers)?;
    let board = state.soundboard.lock().unwrap();
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
    let board = state.soundboard.lock().unwrap();
    let Some(sound) = board.index.get(&sound_id) else {
        return Err(StatusCode::NOT_FOUND);
    };
    let path = soundboard_file_path(&board.dir, &sound.room_id, &sound.file_name);
    let bytes = fs::read(path).map_err(|_| StatusCode::NOT_FOUND)?;
    let mut response = axum::response::Response::new(axum::body::Body::from(bytes));
    let mime = sound.mime.clone().unwrap_or_else(|| "application/octet-stream".to_string());
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(&mime).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
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
        return Ok(Json(SoundboardSoundResponse { ok: false, sound: None, error: Some("Missing roomId".into()) }));
    }
    if body.is_empty() {
        return Ok(Json(SoundboardSoundResponse { ok: false, sound: None, error: Some("Empty audio payload".into()) }));
    }
    let mut board = state.soundboard.lock().unwrap();
    if body.len() > board.max_bytes {
        return Ok(Json(SoundboardSoundResponse { ok: false, sound: None, error: Some("Audio file too large".into()) }));
    }
    let max_sounds = board.max_sounds_per_room;
    let room_id = query.room_id.clone();
    let board_dir = board.dir.clone();
    let room = board.rooms.entry(room_id.clone()).or_insert_with(HashMap::new);
    if room.len() >= max_sounds {
        return Ok(Json(SoundboardSoundResponse { ok: false, sound: None, error: Some("Soundboard is full for this room".into()) }));
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
        return Ok(Json(SoundboardSoundResponse { ok: false, sound: None, error: Some("Unable to save audio".into()) }));
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
    Ok(Json(SoundboardSoundResponse { ok: true, sound: Some(soundboard_public(&sound)), error: None }))
}

async fn soundboard_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SoundboardUpdateRequest>,
) -> Result<Json<SoundboardSoundResponse>, StatusCode> {
    ensure_livekit(&state, &headers)?;
    let mut board = state.soundboard.lock().unwrap();
    let sound_id = payload.sound_id.clone();
    let mut updated: Option<SoundboardSound> = None;
    if let Some(sound) = board.index.get_mut(&sound_id) {
        if sound.room_id != payload.room_id {
            return Ok(Json(SoundboardSoundResponse { ok: false, sound: None, error: Some("Room mismatch".into()) }));
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
        updated = Some(sound.clone());
    } else {
        return Ok(Json(SoundboardSoundResponse { ok: false, sound: None, error: Some("Sound not found".into()) }));
    }
    if let Some(sound) = updated.clone() {
        if let Some(room) = board.rooms.get_mut(&sound.room_id) {
            room.insert(sound.id.clone(), sound.clone());
        }
        persist_soundboard(&board);
        return Ok(Json(SoundboardSoundResponse { ok: true, sound: Some(soundboard_public(&sound)), error: None }));
    }
    Ok(Json(SoundboardSoundResponse { ok: false, sound: None, error: Some("Update failed".into()) }))
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

fn ensure_admin(state: &AppState, headers: &HeaderMap) -> Result<(), StatusCode> {
    let Some(auth) = headers.get("authorization") else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let auth = auth.to_str().map_err(|_| StatusCode::UNAUTHORIZED)?;
    let token = auth.strip_prefix("Bearer ").ok_or(StatusCode::UNAUTHORIZED)?;
    let validation = Validation::default();
    let decoded = decode::<AdminClaims>(
        token,
        &DecodingKey::from_secret(state.config.admin_jwt_secret.as_bytes()),
        &validation,
    ).map_err(|_| StatusCode::UNAUTHORIZED)?;
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
    let token = auth.strip_prefix("Bearer ").ok_or(StatusCode::UNAUTHORIZED)?;
    let validation = Validation::default();
    let decoded = decode::<LiveKitClaims>(
        token,
        &DecodingKey::from_secret(state.config.livekit_api_secret.as_bytes()),
        &validation,
    ).map_err(|_| StatusCode::UNAUTHORIZED)?;
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

// ==================== CHAT API HANDLERS ====================

async fn chat_save_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(message): Json<ChatMessage>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let chat = state.chat.lock().unwrap();
    save_chat_message(&chat.dir, &message);
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn chat_get_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room): Path<String>,
) -> Result<Json<Vec<ChatMessage>>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let chat = state.chat.lock().unwrap();
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

    let chat = state.chat.lock().unwrap();
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
    info!("chat_get_upload: file_name={}, auth_header={:?}", file_name, headers.get("authorization").map(|h| h.to_str().unwrap_or("invalid")));

    match ensure_livekit(&state, &headers) {
        Ok(claims) => info!("chat_get_upload: auth successful for identity={}", claims.sub),
        Err(e) => {
            info!("chat_get_upload: auth failed with status={}", e.as_u16());
            return Err(e);
        }
    }

    let chat = state.chat.lock().unwrap();
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

fn load_config() -> Config {
    let host = std::env::var("CORE_BIND").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port = std::env::var("CORE_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(9090);
    let admin_password_hash = std::env::var("CORE_ADMIN_PASSWORD_HASH").ok();
    let admin_password = std::env::var("CORE_ADMIN_PASSWORD").ok();
    let admin_jwt_secret = std::env::var("CORE_ADMIN_JWT_SECRET").unwrap_or_else(|_| random_secret());
    let admin_token_ttl_secs = std::env::var("CORE_ADMIN_TOKEN_TTL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(43200);

    let livekit_api_key = std::env::var("LK_API_KEY").unwrap_or_else(|_| "LK_API_KEY".to_string());
    let livekit_api_secret = std::env::var("LK_API_SECRET").unwrap_or_else(|_| "LK_API_SECRET".to_string());
    let livekit_token_ttl_secs = std::env::var("LK_TOKEN_TTL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(14400);
    let soundboard_dir = std::env::var("CORE_SOUNDBOARD_DIR").unwrap_or_else(|_| "../logs/soundboard".to_string());
    let soundboard_max_mb = std::env::var("CORE_SOUNDBOARD_MAX_MB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(8);
    let soundboard_max_bytes = soundboard_max_mb.max(1) * 1024 * 1024;
    let soundboard_max_sounds_per_room = std::env::var("CORE_SOUNDBOARD_MAX_SOUNDS_PER_ROOM").ok().and_then(|v| v.parse().ok()).unwrap_or(60);

    let chat_dir = std::env::var("CORE_CHAT_DIR").unwrap_or_else(|_| "../logs/chat".to_string());
    let chat_uploads_dir = std::env::var("CORE_CHAT_UPLOADS_DIR").unwrap_or_else(|_| "../logs/chat-uploads".to_string());
    let chat_max_upload_mb = std::env::var("CORE_CHAT_MAX_UPLOAD_MB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(10);
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
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::from_secs(0)).as_secs()
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
