use crate::config::{now_ts, Config};
use crate::AppState;

use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
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
    #[serde(default, rename = "participantAuthKey")]
    pub participant_auth_key: Option<String>,
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
    #[serde(
        rename = "echoParticipantAuthId",
        skip_serializing_if = "Option::is_none"
    )]
    pub echo_participant_auth_id: Option<String>,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthenticatedParticipant {
    pub(crate) identity: String,
    pub(crate) name: String,
    pub(crate) room: String,
    pub(crate) participant_auth_id: String,
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

const PARTICIPANT_ACTIVE_SECS: u64 = 20;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RevokedParticipantBinding {
    pub(crate) identity: String,
    pub(crate) auth_id: String,
}

struct ParticipantBindResult {
    auth_id: String,
    revoked: Vec<RevokedParticipantBinding>,
}

fn participant_auth_key_is_valid(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn participant_auth_keys_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |different, (a, b)| different | (a ^ b))
        == 0
}

fn new_participant_auth_id() -> String {
    let mut rng = OsRng;
    format!("{:016x}{:016x}", rng.next_u64(), rng.next_u64())
}

fn bind_participant_identity(
    participants: &mut HashMap<String, crate::ParticipantEntry>,
    bindings: &mut HashMap<String, crate::ParticipantBinding>,
    payload: &TokenRequest,
    now: u64,
    replacement_auth_id: String,
) -> Result<ParticipantBindResult, StatusCode> {
    let auth_key = payload
        .participant_auth_key
        .as_deref()
        .filter(|key| participant_auth_key_is_valid(key))
        .ok_or(StatusCode::BAD_REQUEST)?;

    let existing_binding = bindings.get(&payload.identity).cloned();
    let same_installation = existing_binding
        .as_ref()
        .map(|binding| participant_auth_keys_equal(&binding.auth_key, auth_key))
        .unwrap_or(false);
    // A binding is a tombstone as well as a capability. A different browser
    // installation cannot take over the exact identity merely by waiting for
    // its heartbeat to expire. An explicit admin kick removes the tombstone.
    if existing_binding.is_some() && !same_installation {
        info!("bound identity conflict: {}", payload.identity);
        return Err(StatusCode::CONFLICT);
    }

    let name_base = payload
        .identity
        .rsplitn(2, '-')
        .last()
        .unwrap_or(&payload.identity)
        .to_string();
    let same_name_identities: HashSet<String> = participants
        .keys()
        .chain(bindings.keys())
        .filter(|key| {
            *key != &payload.identity && key.rsplitn(2, '-').last().unwrap_or(key) == name_base
        })
        .cloned()
        .collect();

    for key in &same_name_identities {
        if participants
            .get(key)
            .map(|entry| now.saturating_sub(entry.last_seen) < PARTICIPANT_ACTIVE_SECS)
            .unwrap_or(false)
        {
            info!(
                "name conflict: {} is active, rejecting {}",
                key, payload.identity
            );
            return Err(StatusCode::CONFLICT);
        }
    }
    let mut revoked = Vec::new();
    for key in same_name_identities {
        info!(
            "dedup: removing stale identity {} (replaced by {})",
            key, payload.identity
        );
        participants.remove(&key);
        if let Some(binding) = bindings.remove(&key) {
            revoked.push(RevokedParticipantBinding {
                identity: key,
                auth_id: binding.auth_id,
            });
        }
    }

    let participant_auth_id = if same_installation {
        existing_binding
            .expect("same installation has binding")
            .auth_id
    } else {
        bindings.insert(
            payload.identity.clone(),
            crate::ParticipantBinding {
                auth_key: auth_key.to_string(),
                auth_id: replacement_auth_id.clone(),
            },
        );
        replacement_auth_id
    };

    if let Some(existing) = participants.get_mut(&payload.identity) {
        if now.saturating_sub(existing.last_seen) >= PARTICIPANT_ACTIVE_SECS {
            existing.room_id = payload.room.clone();
            if let Some(name) = &payload.name {
                existing.name = name.clone();
            }
        }
        existing.last_seen = now;
    } else {
        participants.insert(
            payload.identity.clone(),
            crate::ParticipantEntry {
                identity: payload.identity.clone(),
                name: payload.name.clone().unwrap_or_default(),
                room_id: payload.room.clone(),
                last_seen: now,
                last_heartbeat_at: None,
                viewer_version: None,
            },
        );
    }

    Ok(ParticipantBindResult {
        auth_id: participant_auth_id,
        revoked,
    })
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
        let mut attempts = state
            .login_attempts
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
        let mut attempts = state
            .login_attempts
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = attempts.entry(ip).or_insert((0, Instant::now()));
        entry.0 += 1;
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Successful login — clear any failed attempts for this IP
    {
        let mut attempts = state
            .login_attempts
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
    let (participant_auth_id, revoked_bindings) = if skip_participant_tracking(companion_kind) {
        (None, Vec::new())
    } else {
        let replacement_auth_id = new_participant_auth_id();
        let mut participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
        let mut bindings = state
            .participant_bindings
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let result = bind_participant_identity(
            &mut participants,
            &mut bindings,
            &payload,
            now,
            replacement_auth_id,
        )?;
        (Some(result.auth_id), result.revoked)
    };

    if !revoked_bindings.is_empty() {
        crate::jam_session::reconcile_revoked_participant_bindings(
            &state,
            &revoked_bindings,
            "identity replacement",
        )
        .await;
    }

    let claims = LiveKitClaims {
        iss: state.config.livekit_api_key.clone(),
        sub: payload.identity.clone(),
        iat: now as usize,
        exp: exp as usize,
        echo_participant_auth_id: participant_auth_id,
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
    decode_livekit_token(state, token)
}

pub(crate) fn decode_livekit_token(
    state: &AppState,
    token: &str,
) -> Result<LiveKitClaims, StatusCode> {
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

fn participant_claims_match(
    claims: &LiveKitClaims,
    claimed_identity: &str,
    binding: &crate::ParticipantBinding,
) -> bool {
    !claimed_identity.trim().is_empty()
        && claims.sub == claimed_identity
        && companion_identity_kind(&claims.sub).is_none()
        && claims.video.roomJoin
        && claims.echo_participant_auth_id.is_some()
        && claims.echo_participant_auth_id.as_deref() == Some(binding.auth_id.as_str())
}

fn ensure_current_participant_claims(
    state: &AppState,
    claims: LiveKitClaims,
    claimed_identity: &str,
) -> Result<LiveKitClaims, StatusCode> {
    let bindings = state
        .participant_bindings
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let binding = bindings
        .get(claimed_identity)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !participant_claims_match(&claims, claimed_identity, binding) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    drop(bindings);
    Ok(claims)
}

pub(crate) fn ensure_livekit_participant(
    state: &AppState,
    headers: &HeaderMap,
    claimed_identity: &str,
) -> Result<LiveKitClaims, StatusCode> {
    let claims = ensure_livekit(state, headers)?;
    ensure_current_participant_claims(state, claims, claimed_identity)
}

/// Authenticate a route that must be tied to a participant who is both the
/// current installation binding and actively heartbeating in the JWT's room.
/// This is deliberately stricter than `ensure_livekit_participant`: heartbeat
/// itself needs the looser helper so it can establish or recover presence.
pub(crate) fn ensure_livekit_active_participant(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedParticipant, StatusCode> {
    let claims = ensure_livekit(state, headers)?;
    let now = now_ts();
    let participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
    let bindings = state
        .participant_bindings
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    active_participant_from_maps(&claims, &participants, &bindings, now)
        .ok_or(StatusCode::UNAUTHORIZED)
}

fn active_participant_from_maps(
    claims: &LiveKitClaims,
    participants: &HashMap<String, crate::ParticipantEntry>,
    bindings: &HashMap<String, crate::ParticipantBinding>,
    now: u64,
) -> Option<AuthenticatedParticipant> {
    if claims.sub.trim().is_empty()
        || claims.video.room.trim().is_empty()
        || claims.exp <= now as usize
        || claims.iat > now.saturating_add(30) as usize
        || claims.iat > claims.exp
    {
        return None;
    }

    let entry = participants.get(&claims.sub)?;
    let binding = bindings.get(&claims.sub)?;
    if !participant_claims_match(claims, &claims.sub, binding)
        || entry.room_id != claims.video.room
        || entry
            .last_heartbeat_at
            .map(|heartbeat| now.saturating_sub(heartbeat) >= PARTICIPANT_ACTIVE_SECS)
            .unwrap_or(true)
    {
        return None;
    }

    Some(AuthenticatedParticipant {
        identity: entry.identity.clone(),
        name: entry.name.clone(),
        room: entry.room_id.clone(),
        participant_auth_id: binding.auth_id.clone(),
    })
}

pub(crate) fn ensure_jam_participant(
    state: &AppState,
    headers: &HeaderMap,
    claimed_identity: Option<&str>,
) -> Result<LiveKitClaims, StatusCode> {
    let token = headers
        .get("x-echo-participant-token")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let claims = decode_livekit_token(state, token)?;
    let identity = claimed_identity.unwrap_or(&claims.sub).to_string();
    ensure_current_participant_claims(state, claims, &identity)
}

pub(crate) fn ensure_jam_participant_token(
    state: &AppState,
    token: &str,
) -> Result<LiveKitClaims, StatusCode> {
    let claims = decode_livekit_token(state, token)?;
    let identity = claims.sub.clone();
    ensure_current_participant_claims(state, claims, &identity)
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

    fn token_request(room: &str, identity: &str, key: &str) -> TokenRequest {
        TokenRequest {
            room: room.to_string(),
            identity: identity.to_string(),
            name: Some("Sam".to_string()),
            viewer_version: None,
            participant_auth_key: Some(key.to_string()),
        }
    }

    fn participant_claims(identity: &str, auth_id: &str) -> LiveKitClaims {
        LiveKitClaims {
            iss: "livekit-key".to_string(),
            sub: identity.to_string(),
            exp: usize::MAX,
            iat: 1,
            echo_participant_auth_id: Some(auth_id.to_string()),
            name: Some("Sam".to_string()),
            video: livekit_video_grant("main".to_string(), None),
        }
    }

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

    #[test]
    fn token_prefetch_reuses_the_installation_binding_without_moving_presence() {
        let key = "a".repeat(64);
        let mut participants = HashMap::new();
        let mut bindings = HashMap::new();

        let first = bind_participant_identity(
            &mut participants,
            &mut bindings,
            &token_request("main", "sam-7475", &key),
            100,
            "epoch-a".to_string(),
        )
        .expect("first bind");
        let prefetched = bind_participant_identity(
            &mut participants,
            &mut bindings,
            &token_request("games", "sam-7475", &key),
            101,
            "must-not-rotate".to_string(),
        )
        .expect("same installation prefetch");

        assert_eq!(first.auth_id, "epoch-a");
        assert_eq!(prefetched.auth_id, "epoch-a");
        assert!(prefetched.revoked.is_empty());
        assert_eq!(participants["sam-7475"].room_id, "main");
        assert_eq!(bindings["sam-7475"].auth_id, "epoch-a");
    }

    #[test]
    fn active_identity_rejects_a_different_installation_key() {
        let key_a = "a".repeat(64);
        let key_b = "b".repeat(64);
        let mut participants = HashMap::new();
        let mut bindings = HashMap::new();
        bind_participant_identity(
            &mut participants,
            &mut bindings,
            &token_request("main", "sam-7475", &key_a),
            100,
            "epoch-a".to_string(),
        )
        .expect("first bind");

        let result = bind_participant_identity(
            &mut participants,
            &mut bindings,
            &token_request("main", "sam-7475", &key_b),
            101,
            "epoch-b".to_string(),
        );

        assert!(matches!(result, Err(StatusCode::CONFLICT)));
        assert_eq!(bindings["sam-7475"].auth_id, "epoch-a");
    }

    #[test]
    fn binding_tombstone_recovers_same_installation_and_rejects_a_new_one() {
        let key_a = "a".repeat(64);
        let key_b = "b".repeat(64);
        let mut participants = HashMap::new();
        let mut bindings = HashMap::new();
        bind_participant_identity(
            &mut participants,
            &mut bindings,
            &token_request("main", "sam-7475", &key_a),
            100,
            "epoch-a".to_string(),
        )
        .expect("first bind");

        participants.clear();
        let recovered = bind_participant_identity(
            &mut participants,
            &mut bindings,
            &token_request("games", "sam-7475", &key_a),
            200,
            "must-not-rotate".to_string(),
        )
        .expect("same installation recovery");
        assert_eq!(recovered.auth_id, "epoch-a");
        assert_eq!(participants["sam-7475"].room_id, "games");

        participants.clear();
        let rebound = bind_participant_identity(
            &mut participants,
            &mut bindings,
            &token_request("main", "sam-7475", &key_b),
            300,
            "epoch-b".to_string(),
        );
        assert!(matches!(rebound, Err(StatusCode::CONFLICT)));
        assert_eq!(bindings["sam-7475"].auth_id, "epoch-a");
    }

    #[test]
    fn stale_same_name_replacement_reports_the_revoked_binding() {
        let key_a = "a".repeat(64);
        let key_b = "b".repeat(64);
        let mut participants = HashMap::new();
        let mut bindings = HashMap::new();
        bind_participant_identity(
            &mut participants,
            &mut bindings,
            &token_request("main", "sam-1111", &key_a),
            100,
            "epoch-a".to_string(),
        )
        .expect("first bind");

        participants.clear();
        let replacement = bind_participant_identity(
            &mut participants,
            &mut bindings,
            &token_request("main", "sam-2222", &key_b),
            200,
            "epoch-b".to_string(),
        )
        .expect("stale same-name replacement");

        assert_eq!(replacement.auth_id, "epoch-b");
        assert_eq!(
            replacement.revoked,
            vec![RevokedParticipantBinding {
                identity: "sam-1111".to_string(),
                auth_id: "epoch-a".to_string(),
            }]
        );
    }

    #[test]
    fn signed_participant_claim_requires_exact_identity_and_current_binding() {
        let binding = crate::ParticipantBinding {
            auth_key: "a".repeat(64),
            auth_id: "epoch-a".to_string(),
        };
        let claims = participant_claims("sam-7475", "epoch-a");

        assert!(participant_claims_match(&claims, "sam-7475", &binding));
        assert!(!participant_claims_match(&claims, "other-1234", &binding));
        assert!(!participant_claims_match(
            &participant_claims("sam-7475", "epoch-old"),
            "sam-7475",
            &binding
        ));
    }

    fn active_participant_maps(
        room: &str,
        heartbeat: Option<u64>,
    ) -> (
        HashMap<String, crate::ParticipantEntry>,
        HashMap<String, crate::ParticipantBinding>,
    ) {
        (
            HashMap::from([(
                "sam-7475".to_string(),
                crate::ParticipantEntry {
                    identity: "sam-7475".to_string(),
                    name: "Sam".to_string(),
                    room_id: room.to_string(),
                    last_seen: 100,
                    last_heartbeat_at: heartbeat,
                    viewer_version: None,
                },
            )]),
            HashMap::from([(
                "sam-7475".to_string(),
                crate::ParticipantBinding {
                    auth_key: "a".repeat(64),
                    auth_id: "epoch-a".to_string(),
                },
            )]),
        )
    }

    #[test]
    fn active_participant_requires_recent_heartbeat_and_authoritative_room() {
        let claims = participant_claims("sam-7475", "epoch-a");
        let (participants, bindings) = active_participant_maps("main", Some(100));
        let authenticated =
            active_participant_from_maps(&claims, &participants, &bindings, 110).unwrap();
        assert_eq!(authenticated.identity, "sam-7475");
        assert_eq!(authenticated.name, "Sam");
        assert_eq!(authenticated.room, "main");

        let (never_heartbeat, bindings) = active_participant_maps("main", None);
        assert!(active_participant_from_maps(&claims, &never_heartbeat, &bindings, 110).is_none());

        let (stale_heartbeat, bindings) = active_participant_maps("main", Some(90));
        assert!(active_participant_from_maps(&claims, &stale_heartbeat, &bindings, 110).is_none());

        let (wrong_room, bindings) = active_participant_maps("games", Some(100));
        assert!(active_participant_from_maps(&claims, &wrong_room, &bindings, 110).is_none());
    }

    #[test]
    fn active_participant_rejects_companion_stale_and_time_invalid_tokens() {
        let (participants, mut bindings) = active_participant_maps("main", Some(100));

        let mut companion = participant_claims("sam-7475$screen", "epoch-a");
        companion.video = livekit_video_grant(
            "main".to_string(),
            Some(CompanionIdentityKind::ScreenPublisher),
        );
        assert!(active_participant_from_maps(&companion, &participants, &bindings, 110).is_none());

        bindings.get_mut("sam-7475").unwrap().auth_id = "epoch-new".to_string();
        let claims = participant_claims("sam-7475", "epoch-a");
        assert!(active_participant_from_maps(&claims, &participants, &bindings, 110).is_none());

        let (_, current_bindings) = active_participant_maps("main", Some(100));
        let mut expired = participant_claims("sam-7475", "epoch-a");
        expired.exp = 110;
        assert!(
            active_participant_from_maps(&expired, &participants, &current_bindings, 110).is_none()
        );

        let mut future = participant_claims("sam-7475", "epoch-a");
        future.iat = 141;
        assert!(
            active_participant_from_maps(&future, &participants, &current_bindings, 110).is_none()
        );
    }
}
