use crate::{config::now_ts, AppState};

use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum::{
    extract::{rejection::JsonRejection, ConnectInfo, Json, Request, State},
    http::{header::CACHE_CONTROL, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};
use tracing::{info, warn};

const DIAGNOSTICS_OWNER_ISSUER: &str = "echo-core-control";
const DIAGNOSTICS_OWNER_AUDIENCE: &str = "echo-diagnostics";
const DIAGNOSTICS_OWNER_SUBJECT: &str = "diagnostics-owner";
const DIAGNOSTICS_OWNER_SCOPE: &str = "diagnostics:owner";
pub(crate) const DIAGNOSTICS_OWNER_TOKEN_TTL_SECS: u64 = 60 * 60;

const OWNER_LOGIN_MAX_FAILURES: u32 = 5;
const OWNER_LOGIN_GLOBAL_MAX_FAILURES: usize = 100;
const OWNER_LOGIN_MAX_RATE_KEYS: usize = 64;
const OWNER_LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);
const OWNER_SECRET_MIN_BYTES: usize = 32;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DiagnosticsOwnerLoginRequest {
    pub(crate) secret: String,
}

#[derive(Serialize)]
pub(crate) struct DiagnosticsOwnerLoginResponse {
    pub(crate) ok: bool,
    pub(crate) token: String,
    pub(crate) expires_in_seconds: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) struct DiagnosticsOwnerClaims {
    pub(crate) iss: String,
    pub(crate) sub: String,
    pub(crate) aud: String,
    pub(crate) scope: String,
    pub(crate) iat: usize,
    pub(crate) exp: usize,
}

#[derive(Debug, Default)]
pub(crate) struct OwnerLoginLimiter {
    global_failures: VecDeque<Instant>,
    by_ip: HashMap<IpAddr, VecDeque<Instant>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OwnerLoginDecision {
    Authorized,
    Rejected,
    RateLimited,
}

/// Validate the configured owner secret once, before placing `Config` in the
/// application `Arc`. A false result must disable owner authentication by
/// replacing `diagnostics_owner_secret` with `None`; it must never fall back to
/// the room password or another server credential.
pub(crate) fn diagnostics_owner_secret_is_safe(config: &crate::config::Config) -> bool {
    let Some(candidate) = config.diagnostics_owner_secret.as_deref() else {
        return false;
    };

    let mut other_secrets = vec![
        config.admin_jwt_secret.as_str(),
        config.livekit_api_secret.as_str(),
    ];
    other_secrets.extend(config.turn_pass.as_deref());
    other_secrets.extend(config.jam_source_token.as_deref());
    other_secrets.extend(config.github_pat.as_deref());

    owner_secret_is_safe(
        candidate,
        config.admin_password_hash.as_deref(),
        config.admin_password.as_deref(),
        &other_secrets,
    )
}

fn owner_secret_is_safe(
    candidate: &str,
    admin_password_hash: Option<&str>,
    admin_password: Option<&str>,
    other_secrets: &[&str],
) -> bool {
    if candidate.len() < OWNER_SECRET_MIN_BYTES || !owner_secret_has_minimum_diversity(candidate) {
        return false;
    }

    if admin_password
        .map(|password| secrets_equal(candidate, password))
        .unwrap_or(false)
    {
        return false;
    }

    if admin_password_hash
        .and_then(|hash| PasswordHash::new(hash).ok())
        .map(|hash| {
            Argon2::default()
                .verify_password(candidate.as_bytes(), &hash)
                .is_ok()
        })
        .unwrap_or(false)
    {
        return false;
    }

    !other_secrets
        .iter()
        .any(|secret| secrets_equal(candidate, secret))
}

fn owner_secret_has_minimum_diversity(candidate: &str) -> bool {
    let bytes = candidate.as_bytes();
    let distinct = bytes.iter().copied().collect::<HashSet<_>>().len();
    let classes = [
        bytes.iter().any(u8::is_ascii_lowercase),
        bytes.iter().any(u8::is_ascii_uppercase),
        bytes.iter().any(u8::is_ascii_digit),
        bytes.iter().any(|byte| !byte.is_ascii_alphanumeric()),
    ]
    .into_iter()
    .filter(|present| *present)
    .count();
    distinct >= 8 && classes >= 2
}

pub(crate) async fn diagnostics_owner_login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    payload: Result<Json<DiagnosticsOwnerLoginRequest>, JsonRejection>,
) -> Response {
    let configured_secret = match configured_owner_secret(&state) {
        Ok(secret) => secret,
        Err(status) => return no_store_status(status),
    };
    let Json(payload) = match payload {
        Ok(payload) => payload,
        Err(rejection) => return no_store_status(rejection.status()),
    };
    let ip = peer.ip();
    info!("diagnostics owner login request ip={}", ip);

    let decision = state
        .owner_login_attempts
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .evaluate(ip, Instant::now(), || {
            secrets_equal(configured_secret, &payload.secret)
        });
    match decision {
        OwnerLoginDecision::Authorized => {}
        OwnerLoginDecision::Rejected => {
            warn!("diagnostics owner login failed ip={}", ip);
            return no_store_status(StatusCode::UNAUTHORIZED);
        }
        OwnerLoginDecision::RateLimited => {
            warn!("diagnostics owner login rate-limited ip={}", ip);
            return no_store_retry_after(
                StatusCode::TOO_MANY_REQUESTS,
                OWNER_LOGIN_WINDOW.as_secs(),
            );
        }
    }

    let now = now_ts();
    let token = match issue_diagnostics_owner_token(configured_secret, now) {
        Ok(token) => token,
        Err(_) => return no_store_status(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let mut headers = HeaderMap::new();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));

    (
        headers,
        Json(DiagnosticsOwnerLoginResponse {
            ok: true,
            token,
            expires_in_seconds: DIAGNOSTICS_OWNER_TOKEN_TTL_SECS,
        }),
    )
        .into_response()
}

pub(crate) fn issue_diagnostics_owner_token(
    secret: &str,
    now: u64,
) -> Result<String, jsonwebtoken::errors::Error> {
    let claims = DiagnosticsOwnerClaims {
        iss: DIAGNOSTICS_OWNER_ISSUER.to_string(),
        sub: DIAGNOSTICS_OWNER_SUBJECT.to_string(),
        aud: DIAGNOSTICS_OWNER_AUDIENCE.to_string(),
        scope: DIAGNOSTICS_OWNER_SCOPE.to_string(),
        iat: now as usize,
        exp: now.saturating_add(DIAGNOSTICS_OWNER_TOKEN_TTL_SECS) as usize,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

pub(crate) fn decode_diagnostics_owner_token(
    secret: &str,
    token: &str,
) -> Result<DiagnosticsOwnerClaims, StatusCode> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.set_audience(&[DIAGNOSTICS_OWNER_AUDIENCE]);
    validation.set_issuer(&[DIAGNOSTICS_OWNER_ISSUER]);
    validation.set_required_spec_claims(&["exp", "iat", "iss", "sub", "aud"]);

    let claims = decode::<DiagnosticsOwnerClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .claims;

    let now = now_ts() as usize;
    let maximum_future_iat = now.saturating_add(60);
    let maximum_ttl = DIAGNOSTICS_OWNER_TOKEN_TTL_SECS as usize;
    if claims.sub != DIAGNOSTICS_OWNER_SUBJECT
        || claims.scope != DIAGNOSTICS_OWNER_SCOPE
        || claims.iat > maximum_future_iat
        || claims.exp <= claims.iat
        || claims.exp.saturating_sub(claims.iat) > maximum_ttl
    {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(claims)
}

pub(crate) fn ensure_diagnostics_owner(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<DiagnosticsOwnerClaims, StatusCode> {
    let secret = configured_owner_secret(state)?;
    let token = bearer_token(headers)?;
    decode_diagnostics_owner_token(secret, token)
}

/// Route-layer guard for owner-only diagnostics browse, download, deletion, and
/// issue-promotion APIs. Participant-authenticated ingestion must live outside
/// the router carrying this layer.
pub(crate) async fn require_diagnostics_owner(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let claims = match ensure_diagnostics_owner(&state, request.headers()) {
        Ok(claims) => claims,
        Err(status) => return no_store_status(status),
    };
    request.extensions_mut().insert(claims);
    // Covers framework-generated query/method rejections as well as handler
    // responses so no owner diagnostics response is cacheable.
    add_no_store(next.run(request).await)
}

fn configured_owner_secret(state: &AppState) -> Result<&str, StatusCode> {
    if state.diagnostics.is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    state
        .config
        .diagnostics_owner_secret
        .as_deref()
        .filter(|secret| secret.len() >= OWNER_SECRET_MIN_BYTES)
        .ok_or(StatusCode::NOT_FOUND)
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, StatusCode> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
        .ok_or(StatusCode::UNAUTHORIZED)
}

fn secrets_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |different, (a, b)| different | (a ^ b))
        == 0
}

impl OwnerLoginLimiter {
    fn evaluate(
        &mut self,
        ip: IpAddr,
        now: Instant,
        secret_matches: impl FnOnce() -> bool,
    ) -> OwnerLoginDecision {
        self.prune(now);

        let new_ip = !self.by_ip.contains_key(&ip);
        let ip_failures = self.by_ip.get(&ip).map(VecDeque::len).unwrap_or_default();
        if self.global_failures.len() >= OWNER_LOGIN_GLOBAL_MAX_FAILURES
            || ip_failures >= OWNER_LOGIN_MAX_FAILURES as usize
            || (new_ip && self.by_ip.len() >= OWNER_LOGIN_MAX_RATE_KEYS)
        {
            return OwnerLoginDecision::RateLimited;
        }

        // Secret comparison is deliberately after the fail-closed limiter
        // check and inside this same mutex transaction. A throttled caller does
        // not receive unlimited offline-equivalent guesses, and concurrent
        // failures cannot burst past the bucket.
        if secret_matches() {
            self.by_ip.remove(&ip);
            return OwnerLoginDecision::Authorized;
        }

        self.global_failures.push_back(now);
        self.by_ip.entry(ip).or_default().push_back(now);
        OwnerLoginDecision::Rejected
    }

    fn prune(&mut self, now: Instant) {
        trim_failures(&mut self.global_failures, now);
        self.by_ip.retain(|_, failures| {
            trim_failures(failures, now);
            !failures.is_empty()
        });
    }
}

fn trim_failures(failures: &mut VecDeque<Instant>, now: Instant) {
    while failures
        .front()
        .map(|failure| now.saturating_duration_since(*failure) >= OWNER_LOGIN_WINDOW)
        .unwrap_or(false)
    {
        failures.pop_front();
    }
}

fn no_store_status(status: StatusCode) -> Response {
    add_no_store(status.into_response())
}

fn no_store_retry_after(status: StatusCode, retry_after_seconds: u64) -> Response {
    let mut response = no_store_status(status);
    if let Ok(value) = HeaderValue::from_str(&retry_after_seconds.to_string()) {
        response.headers_mut().insert("retry-after", value);
    }
    response
}

fn add_no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::{password_hash::SaltString, PasswordHasher};
    use jsonwebtoken::{DecodingKey, EncodingKey};
    use rand::rngs::OsRng;

    fn test_secret() -> String {
        "11d5482918c25782ed693fca335148166ec607d26119b4a7c236f638651e1363".to_string()
    }

    fn encode_test_claims(secret: &str, claims: &DiagnosticsOwnerClaims) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("encode test claims")
    }

    fn valid_claims() -> DiagnosticsOwnerClaims {
        let now = now_ts() as usize;
        DiagnosticsOwnerClaims {
            iss: DIAGNOSTICS_OWNER_ISSUER.to_string(),
            sub: DIAGNOSTICS_OWNER_SUBJECT.to_string(),
            aud: DIAGNOSTICS_OWNER_AUDIENCE.to_string(),
            scope: DIAGNOSTICS_OWNER_SCOPE.to_string(),
            iat: now,
            exp: now + DIAGNOSTICS_OWNER_TOKEN_TTL_SECS as usize,
        }
    }

    #[test]
    fn owner_token_round_trips_with_required_boundary_claims() {
        let secret = test_secret();
        let token = issue_diagnostics_owner_token(&secret, now_ts()).expect("issue token");
        let claims = decode_diagnostics_owner_token(&secret, &token).expect("decode token");

        assert_eq!(claims.iss, DIAGNOSTICS_OWNER_ISSUER);
        assert_eq!(claims.sub, DIAGNOSTICS_OWNER_SUBJECT);
        assert_eq!(claims.aud, DIAGNOSTICS_OWNER_AUDIENCE);
        assert_eq!(claims.scope, DIAGNOSTICS_OWNER_SCOPE);
        assert_eq!(
            claims.exp - claims.iat,
            DIAGNOSTICS_OWNER_TOKEN_TTL_SECS as usize
        );
    }

    #[test]
    fn owner_token_rejects_wrong_key_audience_scope_and_expiry() {
        let secret = test_secret();
        let other_secret = "a".repeat(64);
        let token = issue_diagnostics_owner_token(&secret, now_ts()).expect("issue token");
        assert_eq!(
            decode_diagnostics_owner_token(&other_secret, &token),
            Err(StatusCode::UNAUTHORIZED)
        );

        let mut wrong_audience = valid_claims();
        wrong_audience.aud = "echo-room".to_string();
        assert_eq!(
            decode_diagnostics_owner_token(&secret, &encode_test_claims(&secret, &wrong_audience)),
            Err(StatusCode::UNAUTHORIZED)
        );

        let mut wrong_scope = valid_claims();
        wrong_scope.scope = "admin".to_string();
        assert_eq!(
            decode_diagnostics_owner_token(&secret, &encode_test_claims(&secret, &wrong_scope)),
            Err(StatusCode::UNAUTHORIZED)
        );

        let mut expired = valid_claims();
        expired.iat = (now_ts() - 7_200) as usize;
        expired.exp = (now_ts() - 3_600) as usize;
        assert_eq!(
            decode_diagnostics_owner_token(&secret, &encode_test_claims(&secret, &expired)),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn ordinary_admin_claims_cannot_cross_owner_boundary() {
        #[derive(Serialize)]
        struct OrdinaryAdminClaims {
            sub: String,
            role: String,
            iat: usize,
            exp: usize,
        }

        let secret = test_secret();
        let now = now_ts() as usize;
        let token = encode(
            &Header::new(Algorithm::HS256),
            &OrdinaryAdminClaims {
                sub: "admin".to_string(),
                role: "admin".to_string(),
                iat: now,
                exp: now + 3_600,
            },
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("encode ordinary admin token");

        assert_eq!(
            decode_diagnostics_owner_token(&secret, &token),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn owner_claims_are_not_valid_admin_claims_even_if_a_key_is_reused() {
        let secret = test_secret();
        let token = issue_diagnostics_owner_token(&secret, now_ts()).expect("issue token");

        assert!(decode::<crate::auth::AdminClaims>(
            &token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &Validation::new(Algorithm::HS256),
        )
        .is_err());
    }

    #[test]
    fn owner_secret_must_be_long_unique_and_not_the_room_password() {
        let candidate = test_secret();
        assert!(!owner_secret_is_safe("short", None, None, &[]));
        assert!(!owner_secret_is_safe(&"a".repeat(64), None, None, &[]));
        assert!(!owner_secret_is_safe(&"ab".repeat(32), None, None, &[]));
        assert!(!owner_secret_is_safe(
            &candidate,
            None,
            Some(&candidate),
            &[]
        ));
        assert!(!owner_secret_is_safe(
            &candidate,
            None,
            None,
            &[candidate.as_str()]
        ));
        assert!(owner_secret_is_safe(
            &candidate,
            None,
            Some("ordinary-room-password"),
            &["different-server-secret"]
        ));
    }

    #[test]
    fn owner_secret_rejects_an_argon2_room_password_match() {
        let candidate = test_secret();
        let mut rng = OsRng;
        let salt = SaltString::generate(&mut rng);
        let hash = Argon2::default()
            .hash_password(candidate.as_bytes(), &salt)
            .expect("hash room password")
            .to_string();

        assert!(!owner_secret_is_safe(&candidate, Some(&hash), None, &[]));
    }

    #[test]
    fn owner_login_limiter_records_and_limits_each_ip_atomically() {
        let ip: IpAddr = "192.0.2.10".parse().unwrap();
        let other_ip: IpAddr = "192.0.2.11".parse().unwrap();
        let now = Instant::now();
        let mut limiter = OwnerLoginLimiter::default();

        assert_eq!(
            limiter.evaluate(other_ip, now, || true),
            OwnerLoginDecision::Authorized
        );

        for _ in 0..OWNER_LOGIN_MAX_FAILURES {
            assert_eq!(
                limiter.evaluate(ip, now, || false),
                OwnerLoginDecision::Rejected
            );
        }
        assert_eq!(
            limiter.evaluate(ip, now, || false),
            OwnerLoginDecision::RateLimited
        );
        assert_eq!(
            limiter.evaluate(other_ip, now, || false),
            OwnerLoginDecision::Rejected
        );

        // Fail closed without even evaluating another guess once the bucket is
        // exhausted.
        assert_eq!(
            limiter.evaluate(ip, now, || panic!("limited guess was compared")),
            OwnerLoginDecision::RateLimited
        );
    }

    #[test]
    fn concurrent_owner_login_failures_cannot_burst_past_the_ip_limit() {
        const ATTEMPTS: usize = 32;
        let ip: IpAddr = "192.0.2.10".parse().unwrap();
        let limiter = std::sync::Arc::new(std::sync::Mutex::new(OwnerLoginLimiter::default()));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(ATTEMPTS));
        let handles: Vec<_> = (0..ATTEMPTS)
            .map(|_| {
                let limiter = std::sync::Arc::clone(&limiter);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    limiter
                        .lock()
                        .unwrap()
                        .evaluate(ip, Instant::now(), || false)
                })
            })
            .collect();
        let decisions: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();

        assert_eq!(
            decisions
                .iter()
                .filter(|decision| **decision == OwnerLoginDecision::Rejected)
                .count(),
            OWNER_LOGIN_MAX_FAILURES as usize
        );
        assert_eq!(
            decisions
                .iter()
                .filter(|decision| **decision == OwnerLoginDecision::RateLimited)
                .count(),
            ATTEMPTS - OWNER_LOGIN_MAX_FAILURES as usize
        );
    }

    #[test]
    fn owner_login_limiter_caps_global_failures_and_active_ip_keys() {
        let now = Instant::now();
        let mut key_limiter = OwnerLoginLimiter::default();
        for index in 0..OWNER_LOGIN_MAX_RATE_KEYS {
            let ip = IpAddr::V6(std::net::Ipv6Addr::from(index as u128 + 1));
            assert_eq!(
                key_limiter.evaluate(ip, now, || false),
                OwnerLoginDecision::Rejected
            );
        }
        assert_eq!(key_limiter.by_ip.len(), OWNER_LOGIN_MAX_RATE_KEYS);
        assert_eq!(
            key_limiter.evaluate(
                IpAddr::V6(std::net::Ipv6Addr::from(
                    OWNER_LOGIN_MAX_RATE_KEYS as u128 + 1
                )),
                now,
                || false
            ),
            OwnerLoginDecision::RateLimited
        );

        let mut global_limiter = OwnerLoginLimiter::default();
        let distinct_ips = OWNER_LOGIN_GLOBAL_MAX_FAILURES / 2;
        for _ in 0..2 {
            for index in 0..distinct_ips {
                let ip = IpAddr::V6(std::net::Ipv6Addr::from(index as u128 + 1));
                assert_eq!(
                    global_limiter.evaluate(ip, now, || false),
                    OwnerLoginDecision::Rejected
                );
            }
        }
        assert_eq!(
            global_limiter.global_failures.len(),
            OWNER_LOGIN_GLOBAL_MAX_FAILURES
        );
        assert_eq!(
            global_limiter.evaluate(IpAddr::V6(std::net::Ipv6Addr::from(1_u128)), now, || false),
            OwnerLoginDecision::RateLimited
        );
    }

    #[test]
    fn owner_login_limiter_recovers_after_the_window() {
        let ip: IpAddr = "192.0.2.10".parse().unwrap();
        let now = Instant::now();
        let mut limiter = OwnerLoginLimiter::default();
        for _ in 0..OWNER_LOGIN_MAX_FAILURES {
            assert_eq!(
                limiter.evaluate(ip, now, || false),
                OwnerLoginDecision::Rejected
            );
        }
        assert_eq!(
            limiter.evaluate(ip, now, || false),
            OwnerLoginDecision::RateLimited
        );
        assert_eq!(
            limiter.evaluate(ip, now + OWNER_LOGIN_WINDOW, || false),
            OwnerLoginDecision::Rejected
        );
    }

    #[test]
    fn owner_auth_failure_responses_are_not_cacheable() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::NOT_FOUND,
            StatusCode::BAD_REQUEST,
            StatusCode::PAYLOAD_TOO_LARGE,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            let response = no_store_status(status);
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        }

        let response =
            no_store_retry_after(StatusCode::TOO_MANY_REQUESTS, OWNER_LOGIN_WINDOW.as_secs());
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()["retry-after"], "900");
    }

    #[test]
    fn bearer_parser_rejects_missing_malformed_and_empty_tokens() {
        let mut headers = HeaderMap::new();
        assert_eq!(bearer_token(&headers), Err(StatusCode::UNAUTHORIZED));

        headers.insert("authorization", HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer_token(&headers), Err(StatusCode::UNAUTHORIZED));

        headers.insert("authorization", HeaderValue::from_static("Bearer "));
        assert_eq!(bearer_token(&headers), Err(StatusCode::UNAUTHORIZED));

        headers.insert("authorization", HeaderValue::from_static("Bearer token"));
        assert_eq!(bearer_token(&headers), Ok("token"));
    }
}
