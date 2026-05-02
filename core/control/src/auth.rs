use crate::config::{now_ts, Config};
use crate::AppState;

use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};
use tracing::{info, warn};

// ── Structs ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub ok: bool,
    pub token: String,
    pub expires_in_seconds: u64,
}

#[derive(Deserialize)]
pub struct TokenRequest {
    pub room: String,
    pub identity: String,
    pub name: Option<String>,
    #[serde(default)]
    pub viewer_version: Option<String>,
}

#[derive(Serialize)]
pub struct TokenResponse {
    pub token: String,
    pub expires_in_seconds: u64,
}

#[derive(Serialize, Deserialize)]
pub struct AdminClaims {
    pub sub: String,
    pub role: String,
    pub exp: usize,
    pub iat: usize,
}

#[derive(Serialize, Deserialize)]
pub struct LiveKitClaims {
    pub iss: String,
    pub sub: String,
    pub exp: usize,
    pub iat: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub video: LiveKitVideoGrant,
}

#[derive(Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct LiveKitVideoGrant {
    pub room: String,
    pub roomJoin: bool,
    pub canPublish: bool,
    pub canSubscribe: bool,
    pub canPublishData: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CompanionIdentityKind {
    ScreenPublisher,
    NativePresenter,
}

pub(crate) fn companion_identity_kind(identity: &str) -> Option<CompanionIdentityKind> {
    if identity.ends_with("$screen") {
        Some(CompanionIdentityKind::ScreenPublisher)
    } else if identity.ends_with("$native-presenter") {
        Some(CompanionIdentityKind::NativePresenter)
    } else {
        None
    }
}

pub(crate) fn livekit_video_grant(
    room: String,
    kind: Option<CompanionIdentityKind>,
) -> LiveKitVideoGrant {
    match kind {
        Some(CompanionIdentityKind::ScreenPublisher) => LiveKitVideoGrant {
            room,
            roomJoin: true,
            canPublish: true,
            canSubscribe: false,
            canPublishData: true,
        },
        Some(CompanionIdentityKind::NativePresenter) => LiveKitVideoGrant {
            room,
            roomJoin: true,
            canPublish: false,
            canSubscribe: true,
            canPublishData: false,
        },
        None => LiveKitVideoGrant {
            room,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        },
    }
}

pub(crate) fn skip_participant_tracking(kind: Option<CompanionIdentityKind>) -> bool {
    kind.is_some()
}

// ── Handlers ──────────────────────────────────────────────────────────────

pub async fn login(
    State(state): State<AppState>,
    connect_info: axum::extract::ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    let ua = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    info!("login request (ua: {})", ua);

    // Rate limit: 5 failed attempts per 15 minutes per IP
    let ip = connect_info.0.ip();
    {
        let mut attempts = state.login_attempts.lock().unwrap_or_else(|e| e.into_inner());
        // Clean up expired entries while we have the lock
        let window = Duration::from_secs(15 * 60);
        attempts.retain(|_, (_, first)| first.elapsed() < window);
        if let Some((count, first)) = attempts.get(&ip) {
            if *count >= 5 && first.elapsed() < window {
                warn!("login rate-limited ip={}", ip);
                return Err(StatusCode::TOO_MANY_REQUESTS);
            }
        }
    }

    if !verify_password(&state.config, &payload.password) {
        warn!("login failed (bad password) ip={}", ip);
        // Record failed attempt
        let mut attempts = state.login_attempts.lock().unwrap_or_else(|e| e.into_inner());
        let entry = attempts.entry(ip).or_insert((0, Instant::now()));
        entry.0 += 1;
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Successful login — clear any failed attempts for this IP
    {
        let mut attempts = state.login_attempts.lock().unwrap_or_else(|e| e.into_inner());
        attempts.remove(&ip);
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

pub async fn issue_token(
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

    // Companion identities are system connections, not visible people.
    let companion_kind = companion_identity_kind(&payload.identity);

    let claims = LiveKitClaims {
        iss: state.config.livekit_api_key.clone(),
        sub: payload.identity.clone(),
        iat: now as usize,
        exp: exp as usize,
        name: payload.name.clone(),
        video: livekit_video_grant(payload.room.clone(), companion_kind),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.livekit_api_secret.as_bytes()),
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Companion identities skip participant tracking because they are not real users.
    if skip_participant_tracking(companion_kind) {
        info!(
            "issued companion token for room={} identity={} kind={:?}",
            payload.room, payload.identity, companion_kind
        );
        return Ok(Json(TokenResponse {
            token,
            expires_in_seconds: state.config.livekit_token_ttl_secs,
        }));
    }

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
                crate::ParticipantEntry {
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

// ── Auth helpers ──────────────────────────────────────────────────────────

pub fn ensure_admin(state: &AppState, headers: &HeaderMap) -> Result<(), StatusCode> {
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

pub fn ensure_livekit(state: &AppState, headers: &HeaderMap) -> Result<LiveKitClaims, StatusCode> {
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

pub fn verify_password(config: &Config, password: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_companion_identity_gets_publish_only_grant() {
        let kind = companion_identity_kind("Sam-1234$screen");
        let grant = livekit_video_grant("main".to_string(), kind);

        assert_eq!(kind, Some(CompanionIdentityKind::ScreenPublisher));
        assert!(grant.canPublish);
        assert!(!grant.canSubscribe);
        assert!(grant.canPublishData);
        assert!(skip_participant_tracking(kind));
    }

    #[test]
    fn native_presenter_identity_gets_receive_only_grant() {
        let kind = companion_identity_kind("Sam-1234$native-presenter");
        let grant = livekit_video_grant("main".to_string(), kind);

        assert_eq!(kind, Some(CompanionIdentityKind::NativePresenter));
        assert!(!grant.canPublish);
        assert!(grant.canSubscribe);
        assert!(!grant.canPublishData);
        assert!(skip_participant_tracking(kind));
    }

    #[test]
    fn normal_identity_gets_normal_viewer_grant() {
        let kind = companion_identity_kind("Sam-1234");
        let grant = livekit_video_grant("main".to_string(), kind);

        assert_eq!(kind, None);
        assert!(grant.canPublish);
        assert!(grant.canSubscribe);
        assert!(grant.canPublishData);
        assert!(!skip_participant_tracking(kind));
    }
}
