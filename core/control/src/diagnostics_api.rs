use crate::{
    auth::{ensure_livekit_active_participant, AuthenticatedParticipant},
    config::now_ts_ms,
    diagnostics::{
        AppendOutcome, DiagnosticStore, DiagnosticsError, IncidentSummary, RetentionPolicy,
        MAX_REQUEST_BYTES,
    },
    AppState,
};

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Extension, Path, Query, Request, State},
    http::{
        header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, RETRY_AFTER},
        HeaderValue, StatusCode,
    },
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{IpAddr, SocketAddr},
    path::Path as FsPath,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tracing::warn;

const RATE_WINDOW: Duration = Duration::from_secs(60);
const GLOBAL_REQUESTS_PER_WINDOW: usize = 500;
const IP_REQUESTS_PER_WINDOW: usize = 100;
const PARTICIPANT_REQUESTS_PER_WINDOW: usize = 20;
const INSTALL_REQUESTS_PER_WINDOW: usize = 10;
const GLOBAL_IN_FLIGHT_LIMIT: usize = 16;
const MAX_RATE_KEYS: usize = 4_096;

pub(crate) struct DiagnosticsRuntime {
    store: DiagnosticStore,
    retention: RetentionPolicy,
    admission: Arc<Mutex<DiagnosticsAdmissionState>>,
}

impl DiagnosticsRuntime {
    pub(crate) fn open(
        root: impl AsRef<FsPath>,
        retention: RetentionPolicy,
    ) -> Result<Self, DiagnosticsError> {
        let store = DiagnosticStore::open_with_policy(root, now_ts_ms(), &retention)?;
        Ok(Self {
            store,
            retention,
            admission: Arc::new(Mutex::new(DiagnosticsAdmissionState::default())),
        })
    }

    pub(crate) fn prune(&self, now_ms: u64) -> Result<(), DiagnosticsError> {
        self.store.prune(now_ms, &self.retention).map(|_| ())
    }
}

#[derive(Debug, Default)]
struct DiagnosticsAdmissionState {
    coarse_global: VecDeque<Instant>,
    by_ip: HashMap<IpAddr, VecDeque<Instant>>,
    by_participant: HashMap<String, VecDeque<Instant>>,
    by_install: HashMap<(String, String), VecDeque<Instant>>,
    in_flight_global: usize,
    in_flight_bindings: HashSet<String>,
}

impl DiagnosticsAdmissionState {
    fn allow_coarse(&mut self, ip: IpAddr, now: Instant) -> bool {
        trim_window(&mut self.coarse_global, now);
        self.by_ip.retain(|_, requests| {
            trim_window(requests, now);
            !requests.is_empty()
        });

        let new_ip_key = !self.by_ip.contains_key(&ip);
        if self.coarse_global.len() >= GLOBAL_REQUESTS_PER_WINDOW
            || (new_ip_key && self.by_ip.len() >= MAX_RATE_KEYS)
            || self
                .by_ip
                .get(&ip)
                .map(|requests| requests.len() >= IP_REQUESTS_PER_WINDOW)
                .unwrap_or(false)
        {
            return false;
        }

        self.coarse_global.push_back(now);
        self.by_ip.entry(ip).or_default().push_back(now);
        true
    }

    fn allow_incident(
        &mut self,
        participant: &AuthenticatedParticipant,
        install_id: &str,
        now: Instant,
    ) -> bool {
        self.by_participant.retain(|_, requests| {
            trim_window(requests, now);
            !requests.is_empty()
        });
        self.by_install.retain(|_, requests| {
            trim_window(requests, now);
            !requests.is_empty()
        });

        let participant_key = participant.participant_auth_id.clone();
        let install_key = (participant_key.clone(), install_id.to_owned());
        let new_participant_key = !self.by_participant.contains_key(&participant_key);
        let new_install_key = !self.by_install.contains_key(&install_key);
        if (new_participant_key && self.by_participant.len() >= MAX_RATE_KEYS)
            || (new_install_key && self.by_install.len() >= MAX_RATE_KEYS)
            || self
                .by_participant
                .get(&participant_key)
                .map(|requests| requests.len() >= PARTICIPANT_REQUESTS_PER_WINDOW)
                .unwrap_or(false)
            || self
                .by_install
                .get(&install_key)
                .map(|requests| requests.len() >= INSTALL_REQUESTS_PER_WINDOW)
                .unwrap_or(false)
        {
            return false;
        }

        self.by_participant
            .entry(participant_key)
            .or_default()
            .push_back(now);
        self.by_install
            .entry(install_key)
            .or_default()
            .push_back(now);
        true
    }

    fn try_acquire_in_flight(&mut self, binding_key: &str) -> bool {
        if self.in_flight_global >= GLOBAL_IN_FLIGHT_LIMIT
            || self.in_flight_bindings.contains(binding_key)
        {
            return false;
        }
        self.in_flight_global += 1;
        self.in_flight_bindings.insert(binding_key.to_owned());
        true
    }

    fn release_in_flight(&mut self, binding_key: &str) {
        if self.in_flight_bindings.remove(binding_key) {
            self.in_flight_global = self.in_flight_global.saturating_sub(1);
        }
    }
}

#[derive(Debug)]
pub(crate) struct DiagnosticsInFlightGuard {
    admission: Arc<Mutex<DiagnosticsAdmissionState>>,
    binding_key: String,
}

impl Drop for DiagnosticsInFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut admission) = self.admission.lock() {
            admission.release_in_flight(&self.binding_key);
        }
    }
}

fn try_acquire_in_flight(
    admission: &Arc<Mutex<DiagnosticsAdmissionState>>,
    binding_key: &str,
) -> Option<Arc<DiagnosticsInFlightGuard>> {
    let mut state = admission.lock().ok()?;
    if !state.try_acquire_in_flight(binding_key) {
        return None;
    }
    Some(Arc::new(DiagnosticsInFlightGuard {
        admission: Arc::clone(admission),
        binding_key: binding_key.to_owned(),
    }))
}

fn trim_window(requests: &mut VecDeque<Instant>, now: Instant) {
    while requests
        .front()
        .map(|request| now.saturating_duration_since(*request) >= RATE_WINDOW)
        .unwrap_or(false)
    {
        requests.pop_front();
    }
}

#[derive(Debug, Serialize)]
struct IngestResponse {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    incident_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InstallIdProbe {
    install_id: String,
}

pub(crate) async fn diagnostics_ingest_admission(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(runtime) = state.diagnostics.clone() else {
        return opaque_ingest_response(StatusCode::NOT_FOUND, None);
    };

    let coarse_allowed = runtime
        .admission
        .lock()
        .map(|mut admission| admission.allow_coarse(peer.ip(), Instant::now()))
        .unwrap_or(false);
    if !coarse_allowed {
        return opaque_ingest_response(StatusCode::TOO_MANY_REQUESTS, Some("60"));
    }

    let participant = match ensure_livekit_active_participant(&state, request.headers()) {
        Ok(participant) => participant,
        Err(status) => return opaque_ingest_response(status, None),
    };
    let Some(in_flight_guard) =
        try_acquire_in_flight(&runtime.admission, &participant.participant_auth_id)
    else {
        return opaque_ingest_response(StatusCode::TOO_MANY_REQUESTS, Some("1"));
    };

    request.extensions_mut().insert(participant);
    request
        .extensions_mut()
        .insert(Arc::clone(&in_flight_guard));
    // Also covers responses produced by inner extractors/body limits before the
    // handler runs (for example an oversized-body 413).
    add_no_store(next.run(request).await)
}

pub(crate) async fn diagnostics_ingest(
    State(state): State<AppState>,
    participant: Option<Extension<AuthenticatedParticipant>>,
    in_flight_guard: Option<Extension<Arc<DiagnosticsInFlightGuard>>>,
    body: Bytes,
) -> Response {
    let Some(Extension(participant)) = participant else {
        return opaque_ingest_response(StatusCode::SERVICE_UNAVAILABLE, None);
    };
    let Some(runtime) = state.diagnostics.clone() else {
        return opaque_ingest_response(StatusCode::NOT_FOUND, None);
    };
    let Some(Extension(in_flight_guard)) = in_flight_guard else {
        return opaque_ingest_response(StatusCode::SERVICE_UNAVAILABLE, None);
    };

    if body.len() > MAX_REQUEST_BYTES {
        return opaque_ingest_response(StatusCode::PAYLOAD_TOO_LARGE, None);
    }
    let install_id = match probe_install_id(&body) {
        Ok(install_id) => install_id,
        Err(status) => return opaque_ingest_response(status, None),
    };
    let allowed = runtime
        .admission
        .lock()
        .map(|mut admission| admission.allow_incident(&participant, &install_id, Instant::now()))
        .unwrap_or(false);
    if !allowed {
        return opaque_ingest_response(StatusCode::TOO_MANY_REQUESTS, Some("60"));
    }

    let identity = participant.identity;
    let received_at_ms = now_ts_ms();
    let raw_body = body.to_vec();
    let runtime_for_store = Arc::clone(&runtime);
    let outcome = tokio::task::spawn_blocking(move || {
        // Keep admission owned by the disk task. If the request future is
        // cancelled after spawning, detached blocking work must still count
        // against the per-binding and global concurrency ceilings.
        let _in_flight_guard = in_flight_guard;
        runtime_for_store.store.ingest_with_policy(
            &identity,
            &raw_body,
            received_at_ms,
            &runtime_for_store.retention,
        )
    })
    .await;

    let response = match outcome {
        Ok(Ok(AppendOutcome::Stored { incident_id })) => (
            StatusCode::ACCEPTED,
            Json(IngestResponse {
                status: "accepted",
                incident_id: Some(incident_id),
            }),
        )
            .into_response(),
        Ok(Ok(AppendOutcome::Duplicate { incident_id })) => (
            StatusCode::OK,
            Json(IngestResponse {
                status: "duplicate",
                incident_id: Some(incident_id),
            }),
        )
            .into_response(),
        Ok(Ok(AppendOutcome::Conflict { .. })) => (
            StatusCode::CONFLICT,
            Json(IngestResponse {
                status: "conflict",
                incident_id: None,
            }),
        )
            .into_response(),
        Ok(Err(error)) => diagnostics_error_response(error),
        Err(error) => {
            warn!("diagnostics storage task failed: {}", error);
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    };
    add_no_store(response)
}

fn probe_install_id(body: &[u8]) -> Result<String, StatusCode> {
    let probe: InstallIdProbe =
        serde_json::from_slice(body).map_err(|_| StatusCode::BAD_REQUEST)?;
    if !is_uuid(&probe.install_id) {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    Ok(probe.install_id)
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                matches!(byte, b'0'..=b'9' | b'a'..=b'f')
            }
        })
}

fn opaque_ingest_response(status: StatusCode, retry_after: Option<&'static str>) -> Response {
    let mut response = status.into_response();
    if let Some(retry_after) = retry_after {
        response
            .headers_mut()
            .insert(RETRY_AFTER, HeaderValue::from_static(retry_after));
    }
    add_no_store(response)
}

#[derive(Debug, Deserialize)]
pub(crate) struct DiagnosticsListQuery {
    #[serde(default = "default_list_limit")]
    limit: usize,
    before_received_at_ms: Option<u64>,
    before_incident_id: Option<String>,
}

fn default_list_limit() -> usize {
    50
}

fn diagnostics_list_cursor(
    query: &DiagnosticsListQuery,
) -> Result<Option<(u64, String)>, StatusCode> {
    match (
        query.before_received_at_ms,
        query.before_incident_id.as_ref(),
    ) {
        (None, None) => Ok(None),
        (Some(received_at_ms), Some(incident_id)) => {
            Ok(Some((received_at_ms, incident_id.clone())))
        }
        _ => Err(StatusCode::BAD_REQUEST),
    }
}

#[derive(Debug, Serialize)]
struct DiagnosticsListResponse {
    incidents: Vec<IncidentSummary>,
}

pub(crate) async fn diagnostics_list(
    State(state): State<AppState>,
    Query(query): Query<DiagnosticsListQuery>,
) -> Response {
    let Some(runtime) = state.diagnostics.clone() else {
        return no_store_status(StatusCode::SERVICE_UNAVAILABLE);
    };
    let before = match diagnostics_list_cursor(&query) {
        Ok(before) => before,
        Err(status) => return no_store_status(status),
    };
    let result =
        tokio::task::spawn_blocking(move || runtime.store.list_summaries(query.limit, before))
            .await;
    match result {
        Ok(Ok(incidents)) => no_store_json(StatusCode::OK, &DiagnosticsListResponse { incidents }),
        Ok(Err(error)) => no_store_diagnostics_error(error),
        Err(error) => {
            warn!("diagnostics list task failed: {}", error);
            no_store_status(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

pub(crate) async fn diagnostics_get(
    State(state): State<AppState>,
    Path(incident_id): Path<String>,
) -> Response {
    let Some(runtime) = state.diagnostics.clone() else {
        return no_store_status(StatusCode::SERVICE_UNAVAILABLE);
    };
    let result =
        tokio::task::spawn_blocking(move || runtime.store.get_incident(&incident_id)).await;
    match result {
        Ok(Ok(Some(incident))) => no_store_json(StatusCode::OK, &incident),
        Ok(Ok(None)) => no_store_status(StatusCode::NOT_FOUND),
        Ok(Err(error)) => no_store_diagnostics_error(error),
        Err(error) => {
            warn!("diagnostics get task failed: {}", error);
            no_store_status(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

pub(crate) async fn diagnostics_download(
    State(state): State<AppState>,
    Path(incident_id): Path<String>,
) -> Response {
    let Some(runtime) = state.diagnostics.clone() else {
        return no_store_status(StatusCode::SERVICE_UNAVAILABLE);
    };
    let download_id = incident_id.clone();
    let result =
        tokio::task::spawn_blocking(move || runtime.store.redacted_download_json(&incident_id))
            .await;
    match result {
        Ok(Ok(Some(download))) => {
            let mut response = (StatusCode::OK, download).into_response();
            response.headers_mut().insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
            response
                .headers_mut()
                .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            let disposition = format!(
                "attachment; filename=\"echo-diagnostic-{}.json\"",
                download_id
            );
            if let Ok(value) = HeaderValue::from_str(&disposition) {
                response.headers_mut().insert(CONTENT_DISPOSITION, value);
            }
            response
        }
        Ok(Ok(None)) => no_store_status(StatusCode::NOT_FOUND),
        Ok(Err(error)) => no_store_diagnostics_error(error),
        Err(error) => {
            warn!("diagnostics download task failed: {}", error);
            no_store_status(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

pub(crate) async fn diagnostics_delete(
    State(state): State<AppState>,
    Path(incident_id): Path<String>,
) -> Response {
    let Some(runtime) = state.diagnostics.clone() else {
        return no_store_status(StatusCode::SERVICE_UNAVAILABLE);
    };
    let result =
        tokio::task::spawn_blocking(move || runtime.store.delete_incident(&incident_id)).await;
    match result {
        Ok(Ok(true)) => no_store_status(StatusCode::NO_CONTENT),
        Ok(Ok(false)) => no_store_status(StatusCode::NOT_FOUND),
        Ok(Err(error)) => no_store_diagnostics_error(error),
        Err(error) => {
            warn!("diagnostics delete task failed: {}", error);
            no_store_status(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

fn diagnostics_error_response(error: DiagnosticsError) -> Response {
    match error {
        DiagnosticsError::BodyTooLarge => StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        DiagnosticsError::CapacityExceeded => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        DiagnosticsError::InvalidJson => StatusCode::BAD_REQUEST.into_response(),
        DiagnosticsError::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY.into_response(),
        DiagnosticsError::Serialization
        | DiagnosticsError::Io(_)
        | DiagnosticsError::LockPoisoned => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

fn no_store_diagnostics_error(error: DiagnosticsError) -> Response {
    let response = diagnostics_error_response(error);
    add_no_store(response)
}

fn no_store_status(status: StatusCode) -> Response {
    add_no_store(status.into_response())
}

fn no_store_json<T: Serialize>(status: StatusCode, value: &T) -> Response {
    add_no_store((status, Json(value)).into_response())
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
    use crate::diagnostics::StoredIncident;

    fn participant(identity: &str, auth_id: &str) -> AuthenticatedParticipant {
        AuthenticatedParticipant {
            identity: identity.to_string(),
            name: identity.to_string(),
            room: "main".to_string(),
            participant_auth_id: auth_id.to_string(),
        }
    }

    #[test]
    fn coarse_rate_limit_is_bounded_per_ip_and_globally() {
        let mut admission = DiagnosticsAdmissionState::default();
        let now = Instant::now();

        for host in 1..=5 {
            let ip: IpAddr = format!("192.0.2.{host}").parse().unwrap();
            for _ in 0..IP_REQUESTS_PER_WINDOW {
                assert!(admission.allow_coarse(ip, now));
            }
            assert!(!admission.allow_coarse(ip, now));
        }

        let new_ip: IpAddr = "198.51.100.1".parse().unwrap();
        assert_eq!(admission.coarse_global.len(), GLOBAL_REQUESTS_PER_WINDOW);
        assert!(!admission.allow_coarse(new_ip, now));
        assert!(admission.allow_coarse(new_ip, now + RATE_WINDOW));
    }

    #[test]
    fn incident_rate_limit_covers_install_rotation_and_current_binding() {
        let mut admission = DiagnosticsAdmissionState::default();
        let now = Instant::now();
        let current = participant("sam-7475", "binding-a");
        let install_a = "00000000-0000-4000-8000-000000000001";
        let install_b = "00000000-0000-4000-8000-000000000002";
        let install_c = "00000000-0000-4000-8000-000000000003";

        for _ in 0..INSTALL_REQUESTS_PER_WINDOW {
            assert!(admission.allow_incident(&current, install_a, now));
        }
        assert!(!admission.allow_incident(&current, install_a, now));

        for _ in 0..INSTALL_REQUESTS_PER_WINDOW {
            assert!(admission.allow_incident(&current, install_b, now));
        }
        assert!(!admission.allow_incident(&current, install_c, now));

        let replacement = participant("sam-7475", "binding-b");
        assert!(admission.allow_incident(&replacement, install_a, now));
        assert!(admission.allow_incident(&current, install_a, now + RATE_WINDOW));
    }

    #[test]
    fn incident_rate_key_maps_fail_closed_at_the_cap_and_expire() {
        let mut admission = DiagnosticsAdmissionState::default();
        let now = Instant::now();
        let install_id = "00000000-0000-4000-8000-000000000001";

        for index in 0..MAX_RATE_KEYS {
            let current = participant("sam-7475", &format!("binding-{index}"));
            assert!(admission.allow_incident(&current, install_id, now));
        }
        let one_too_many = participant("sam-7475", "one-too-many");
        assert!(!admission.allow_incident(&one_too_many, install_id, now));
        assert_eq!(admission.by_participant.len(), MAX_RATE_KEYS);
        assert_eq!(admission.by_install.len(), MAX_RATE_KEYS);

        assert!(admission.allow_incident(&one_too_many, install_id, now + RATE_WINDOW));
        assert_eq!(admission.by_participant.len(), 1);
        assert_eq!(admission.by_install.len(), 1);
    }

    #[test]
    fn in_flight_guard_is_per_binding_globally_bounded_and_raii_released() {
        let admission = Arc::new(Mutex::new(DiagnosticsAdmissionState::default()));
        let first = try_acquire_in_flight(&admission, "binding-a").unwrap();
        assert!(try_acquire_in_flight(&admission, "binding-a").is_none());

        let mut guards = vec![first];
        for index in 1..GLOBAL_IN_FLIGHT_LIMIT {
            guards.push(
                try_acquire_in_flight(&admission, &format!("binding-{index}"))
                    .expect("a distinct binding should fit under the global cap"),
            );
        }
        assert!(try_acquire_in_flight(&admission, "one-too-many").is_none());

        drop(guards);
        assert!(try_acquire_in_flight(&admission, "binding-a").is_some());
        let state = admission.lock().unwrap();
        assert_eq!(state.in_flight_global, 0);
        assert!(state.in_flight_bindings.is_empty());
    }

    #[test]
    fn in_flight_permit_survives_request_side_cancellation() {
        let admission = Arc::new(Mutex::new(DiagnosticsAdmissionState::default()));
        let request_permit = try_acquire_in_flight(&admission, "binding-a").unwrap();
        let disk_task_permit = Arc::clone(&request_permit);

        drop(request_permit);
        assert_eq!(admission.lock().unwrap().in_flight_global, 1);
        assert!(try_acquire_in_flight(&admission, "binding-a").is_none());

        drop(disk_task_permit);
        let state = admission.lock().unwrap();
        assert_eq!(state.in_flight_global, 0);
        assert!(state.in_flight_bindings.is_empty());
    }

    #[test]
    fn install_id_probe_accepts_only_a_top_level_uuid() {
        let valid = serde_json::to_vec(&serde_json::json!({
            "install_id": "00000000-0000-4000-8000-000000000001",
            "events": []
        }))
        .unwrap();
        assert_eq!(
            probe_install_id(&valid).unwrap(),
            "00000000-0000-4000-8000-000000000001"
        );

        assert_eq!(
            probe_install_id(br#"{"events":[]}"#),
            Err(StatusCode::BAD_REQUEST)
        );
        assert_eq!(
            probe_install_id(br#"{"install_id":"not-a-uuid"}"#),
            Err(StatusCode::UNPROCESSABLE_ENTITY)
        );
        assert_eq!(
            probe_install_id(br#"{"install_id":"00000000-0000-4000-8000-00000000000A"}"#,),
            Err(StatusCode::UNPROCESSABLE_ENTITY)
        );
        assert_eq!(
            probe_install_id(
                br#"{"install_id":"00000000-0000-4000-8000-000000000001","install_id":"00000000-0000-4000-8000-000000000002"}"#,
            ),
            Err(StatusCode::BAD_REQUEST)
        );
    }

    #[test]
    fn list_pagination_requires_a_compound_cursor() {
        let base = DiagnosticsListQuery {
            limit: 1,
            before_received_at_ms: None,
            before_incident_id: None,
        };
        assert_eq!(diagnostics_list_cursor(&base), Ok(None));

        let timestamp_only = DiagnosticsListQuery {
            before_received_at_ms: Some(123),
            ..base
        };
        assert_eq!(
            diagnostics_list_cursor(&timestamp_only),
            Err(StatusCode::BAD_REQUEST)
        );

        let paired = DiagnosticsListQuery {
            limit: 1,
            before_received_at_ms: Some(123),
            before_incident_id: Some("inc_00000000000000000000000000000000".to_string()),
        };
        assert!(matches!(
            diagnostics_list_cursor(&paired),
            Ok(Some((123, incident_id))) if incident_id == paired.before_incident_id.clone().unwrap()
        ));
    }

    #[test]
    fn diagnostics_error_statuses_do_not_expose_storage_details() {
        assert_eq!(
            diagnostics_error_response(DiagnosticsError::InvalidJson).status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            diagnostics_error_response(DiagnosticsError::Io(std::io::Error::other(
                "sensitive path",
            )))
            .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn admission_throttle_response_is_opaque_non_cacheable_and_retryable() {
        let response = opaque_ingest_response(StatusCode::TOO_MANY_REQUESTS, Some("60"));
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[RETRY_AFTER], "60");
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    }

    #[test]
    fn owner_json_responses_are_not_cacheable() {
        let incident = StoredIncident {
            record_version: 1,
            incident_id: "inc_00000000000000000000000000000000".to_string(),
            received_at_ms: 1,
            authenticated_identity: "sam-7475".to_string(),
            authenticated_identity_digest:
                "hmac-sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_string(),
            payload_digest: "digest".to_string(),
            envelope: serde_json::from_value(serde_json::json!({
                "schema_version": 1,
                "envelope_id": "00000000-0000-4000-8000-000000000001",
                "install_id": "00000000-0000-4000-8000-000000000002",
                "session_id": "00000000-0000-4000-8000-000000000003",
                "captured_at_ms": 1,
                "sent_at_ms": 1,
                "app": {
                    "version": "0.6.33",
                    "git_sha": "d6191a5f",
                    "channel": "test",
                    "runtimes": {}
                },
                "platform": {
                    "client_kind": "browser",
                    "operating_system": "macos",
                    "architecture": "aarch64"
                },
                "events": [{
                    "sequence": 1,
                    "timestamp_ms": 1,
                    "event_type": "session_start",
                    "severity": "info",
                    "code": "session.start"
                }]
            }))
            .unwrap(),
        };
        let response = no_store_json(StatusCode::OK, &incident);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    }
}
