use crate::config::*;
use crate::sfu_proxy::sfu_proxy;
use crate::AppState;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Redirect};
use serde::Serialize;
use std::fs;
use tracing::warn;

#[derive(Serialize)]
pub(crate) struct HealthResponse {
    ok: bool,
    ts: u64,
}

pub(crate) async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        ts: now_ts(),
    })
}

/// Returns server version and latest available client version from deploy/latest.json.
pub(crate) async fn api_version() -> Json<serde_json::Value> {
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
pub(crate) async fn api_update_latest() -> axum::response::Response {
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
pub(crate) async fn open_url(
    State(_state): State<AppState>,
    _headers: HeaderMap,
    _body: axum::body::Bytes,
) -> StatusCode {
    warn!("/api/open-url called but is disabled for security — use Tauri IPC instead");
    StatusCode::GONE
}

pub(crate) async fn online_users(State(state): State<AppState>) -> Json<serde_json::Value> {
    let participants = state.participants.lock().unwrap_or_else(|e| e.into_inner());
    let users: Vec<serde_json::Value> = participants
        .values()
        .map(|p| serde_json::json!({ "name": p.name, "room": p.room_id }))
        .collect();
    Json(serde_json::json!(users))
}

pub(crate) async fn root_route(
    headers: HeaderMap,
    uri: OriginalUri,
    ws: Option<WebSocketUpgrade>,
) -> axum::response::Response {
    if let Some(ws) = ws {
        return sfu_proxy(ws, uri, headers).await.into_response();
    }
    Redirect::temporary("/viewer/").into_response()
}
