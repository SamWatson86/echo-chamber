use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use jsonwebtoken::{encode, decode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::SocketAddr, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tracing::{info, warn};

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    rooms: Arc<Mutex<HashMap<String, RoomInfo>>>,
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

#[derive(Serialize)]
struct TokenResponse {
    token: String,
    expires_in_seconds: u64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct RoomInfo {
    room_id: String,
    created_at: u64,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    let config = Arc::new(load_config());
    let state = AppState {
        config: config.clone(),
        rooms: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/token", post(issue_token))
        .route("/v1/rooms", get(list_rooms).post(create_room))
        .route("/v1/rooms/:room_id", get(get_room).delete(delete_room))
        .route("/v1/metrics", get(metrics))
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .expect("invalid bind address");

    info!("control plane listening on {}", addr);
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app)
        .await
        .unwrap();
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true, ts: now_ts() })
}

async fn login(State(state): State<AppState>, Json(payload): Json<LoginRequest>) -> Result<Json<LoginResponse>, StatusCode> {
    if !verify_password(&state.config, &payload.password) {
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

async fn issue_token(State(state): State<AppState>, headers: HeaderMap, Json(payload): Json<TokenRequest>) -> Result<Json<TokenResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;

    let now = now_ts();
    let exp = now + state.config.livekit_token_ttl_secs;
    let claims = LiveKitClaims {
        iss: state.config.livekit_api_key.clone(),
        sub: payload.identity.clone(),
        iat: now as usize,
        exp: exp as usize,
        video: LiveKitVideoGrant {
            room: payload.room.clone(),
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
            name: payload.name.clone(),
        },
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.livekit_api_secret.as_bytes()),
    ).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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

async fn metrics(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<MetricsResponse>, StatusCode> {
    ensure_admin(&state, &headers)?;
    let rooms = state.rooms.lock().unwrap();
    Ok(Json(MetricsResponse {
        rooms: rooms.len() as u64,
        ts: now_ts(),
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
