use base64::Engine as _;

use crate::auth::ensure_admin;
use crate::config::*;
use crate::rooms::SessionEvent;
use crate::AppState;

use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tracing::{info, warn};

// ── Structs ──────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize, Default)]
pub(crate) struct ClientStats {
    pub(crate) identity: String,
    pub(crate) name: String,
    pub(crate) room: String,
    pub(crate) updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) screen_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) screen_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) screen_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) screen_bitrate_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bwe_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) quality_limitation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) encoder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ice_local_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ice_remote_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) camera_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) camera_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) camera_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) camera_bitrate_kbps: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct StatsSnapshot {
    pub(crate) identity: String,
    pub(crate) name: String,
    pub(crate) timestamp: u64,
    pub(crate) screen_fps: Option<f64>,
    pub(crate) screen_bitrate_kbps: Option<u32>,
    pub(crate) quality_limitation: Option<String>,
    pub(crate) encoder: Option<String>,
    pub(crate) ice_local_type: Option<String>,
    pub(crate) ice_remote_type: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct BugReport {
    pub(crate) id: u64,
    pub(crate) identity: String,
    pub(crate) name: String,
    pub(crate) room: String,
    pub(crate) description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) feedback_type: Option<String>,
    pub(crate) timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) screen_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) screen_bitrate_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bwe_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) quality_limitation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) encoder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ice_local_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ice_remote_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) screenshot_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) user_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) participant_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) connection_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) github_issue_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) github_issue_url: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct BugReportRequest {
    pub(crate) description: String,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) feedback_type: Option<String>,
    #[serde(default)]
    pub(crate) identity: Option<String>,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) room: Option<String>,
    #[serde(default)]
    pub(crate) screen_fps: Option<f64>,
    #[serde(default)]
    pub(crate) screen_bitrate_kbps: Option<u32>,
    #[serde(default)]
    pub(crate) bwe_kbps: Option<u32>,
    #[serde(default)]
    pub(crate) quality_limitation: Option<String>,
    #[serde(default)]
    pub(crate) encoder: Option<String>,
    #[serde(default)]
    pub(crate) ice_local_type: Option<String>,
    #[serde(default)]
    pub(crate) ice_remote_type: Option<String>,
    #[serde(default)]
    pub(crate) screenshot_url: Option<String>,
    #[serde(default)]
    pub(crate) version: Option<String>,
    #[serde(default)]
    pub(crate) user_agent: Option<String>,
    #[serde(default)]
    pub(crate) participant_count: Option<u32>,
    #[serde(default)]
    pub(crate) connection_state: Option<String>,
}

// ── Response structs ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub(crate) struct AdminDashboardResponse {
    ts: u64,
    rooms: Vec<AdminRoomInfo>,
    total_online: usize,
    server_version: String,
}

#[derive(Serialize)]
pub(crate) struct AdminRoomInfo {
    room_id: String,
    participants: Vec<AdminParticipantInfo>,
}

#[derive(Serialize)]
pub(crate) struct AdminParticipantInfo {
    identity: String,
    name: String,
    online_seconds: u64,
    stats: Option<ClientStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    viewer_version: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct AdminSessionsResponse {
    events: Vec<SessionEvent>,
}

#[derive(Serialize)]
pub(crate) struct AdminMetricsResponse {
    users: Vec<UserMetrics>,
}

#[derive(Serialize)]
pub(crate) struct UserMetrics {
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
pub(crate) struct BugReportsResponse {
    reports: Vec<BugReport>,
}

#[derive(Clone, Serialize)]
pub(crate) struct HeatmapJoin {
    timestamp: u64,
    name: String,
}

#[derive(Serialize)]
pub(crate) struct DashboardMetricsResponse {
    summary: DashboardSummary,
    per_user: Vec<UserSessionStats>,
    heatmap_joins: Vec<HeatmapJoin>,
    timeline_events: Vec<TimelineEvent>,
}

#[derive(Serialize)]
pub(crate) struct DashboardSummary {
    total_sessions: usize,
    unique_users: usize,
    total_hours: f64,
    avg_duration_mins: f64,
}

#[derive(Serialize)]
pub(crate) struct UserSessionStats {
    name: String,
    identity: String,
    session_count: usize,
    total_hours: f64,
}

#[derive(Serialize)]
pub(crate) struct TimelineEvent {
    identity: String,
    name: String,
    event_type: String,
    timestamp: u64,
    duration_secs: Option<u64>,
}

// ── Handlers ─────────────────────────────────────────────────────────────

pub(crate) async fn admin_dashboard(
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

pub(crate) async fn admin_sessions(
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

pub(crate) async fn admin_dashboard_metrics(
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

pub(crate) async fn admin_report_stats(
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

pub(crate) async fn admin_metrics(
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

pub(crate) async fn submit_bug_report(
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

pub(crate) async fn admin_bug_reports(
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

pub(crate) async fn admin_deploys(
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

// ── File logging helpers ─────────────────────────────────────────────────

pub(crate) fn append_stats_snapshot(dir: &std::path::Path, snapshot: &StatsSnapshot) {
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

pub(crate) fn append_bug_report(dir: &std::path::Path, report: &BugReport) {
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
pub(crate) async fn create_github_issue(client: reqwest::Client, pat: String, repo: String, report: BugReport, uploads_dir: PathBuf) -> Option<(u64, String)> {
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
