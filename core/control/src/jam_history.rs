use crate::auth::{ensure_admin, ensure_jam_actor};
use crate::config::{now_ts_ms, random_secret};
use crate::jam_session::{QueuedPlaylistProvenance, QueuedTrack};
use crate::AppState;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tracing::warn;

pub(crate) const HISTORY_SCHEMA_VERSION: u16 = 1;
pub(crate) const HISTORY_RETENTION_DAYS: u64 = 30;
const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
const RETENTION_MS: u64 = HISTORY_RETENTION_DAYS * DAY_MS;
const MAX_HISTORY_LIMIT: usize = 200;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct JamHistoryEntry {
    pub(crate) schema_version: u16,
    pub(crate) history_entry_id: String,
    pub(crate) played_at_ms: u64,
    pub(crate) queue_entry_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) queue_batch_id: Option<String>,
    pub(crate) spotify_id: String,
    pub(crate) spotify_uri: String,
    pub(crate) spotify_url: String,
    pub(crate) name: String,
    pub(crate) artist: String,
    pub(crate) album_art_url: String,
    pub(crate) duration_ms: u64,
    pub(crate) added_at_ms: u64,
    pub(crate) added_by_actor_id: String,
    pub(crate) added_by_name: String,
    // Compatibility alias matching the existing Jam queue.
    pub(crate) added_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) playlist: Option<QueuedPlaylistProvenance>,
}

impl JamHistoryEntry {
    fn from_track(track: &QueuedTrack, played_at_ms: u64) -> Self {
        Self {
            schema_version: HISTORY_SCHEMA_VERSION,
            history_entry_id: format!("jh1_{}", random_secret()),
            played_at_ms,
            queue_entry_id: track.queue_entry_id.clone(),
            queue_batch_id: track.queue_batch_id.clone(),
            spotify_id: track.spotify_id.clone(),
            spotify_uri: track.spotify_uri.clone(),
            spotify_url: track.spotify_url.clone(),
            name: track.name.clone(),
            artist: track.artist.clone(),
            album_art_url: track.album_art_url.clone(),
            duration_ms: track.duration_ms,
            added_at_ms: track.added_at_ms,
            added_by_actor_id: track.added_by_actor_id.clone(),
            added_by_name: track.added_by_name.clone(),
            added_by: track.added_by.clone(),
            playlist: track.playlist.clone(),
        }
    }
}

pub(crate) struct JamHistoryStore {
    dir: PathBuf,
    enabled: bool,
    lock: Mutex<()>,
}

impl JamHistoryStore {
    pub(crate) fn open(dir: PathBuf, now_ms: u64) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        recover_prune_backups(&dir)?;
        let store = Self {
            dir,
            enabled: true,
            lock: Mutex::new(()),
        };
        store.prune(now_ms)?;
        Ok(store)
    }

    pub(crate) fn disabled(dir: PathBuf) -> Self {
        Self {
            dir,
            enabled: false,
            lock: Mutex::new(()),
        }
    }

    pub(crate) fn append_observation(
        &self,
        track: &QueuedTrack,
        played_at_ms: u64,
    ) -> io::Result<JamHistoryEntry> {
        let entry = JamHistoryEntry::from_track(track, played_at_ms);
        if !self.enabled {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "Jam history storage is unavailable",
            ));
        }
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        self.prune_locked(played_at_ms)?;
        let path = self
            .dir
            .join(format!("history-v1-{}.jsonl", played_at_ms / DAY_MS));
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)?;
        let length = file.metadata()?.len();
        if length > 0 {
            file.seek(SeekFrom::End(-1))?;
            let mut tail = [0u8; 1];
            file.read_exact(&mut tail)?;
            if tail[0] != b'\n' {
                file.write_all(b"\n")?;
            }
        }
        serde_json::to_writer(&mut file, &entry)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(entry)
    }

    pub(crate) fn list(&self, now_ms: u64) -> io::Result<Vec<JamHistoryEntry>> {
        if !self.enabled {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "Jam history storage is unavailable",
            ));
        }
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let cutoff = now_ms.saturating_sub(RETENTION_MS);
        let mut entries = Vec::new();
        for path in history_files(&self.dir)? {
            for line in BufReader::new(fs::File::open(&path)?).lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<JamHistoryEntry>(&line) {
                    Ok(entry)
                        if entry.schema_version == HISTORY_SCHEMA_VERSION
                            && entry.played_at_ms >= cutoff =>
                    {
                        entries.push(entry);
                    }
                    Ok(_) => {}
                    Err(error) => warn!(
                        "Skipping malformed Jam history row in {:?}: {}",
                        path, error
                    ),
                }
            }
        }
        Ok(entries)
    }

    pub(crate) fn prune(&self, now_ms: u64) -> io::Result<()> {
        if !self.enabled {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "Jam history storage is unavailable",
            ));
        }
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        self.prune_locked(now_ms)
    }

    fn prune_locked(&self, now_ms: u64) -> io::Result<()> {
        let cutoff = now_ms.saturating_sub(RETENTION_MS);
        for path in history_files(&self.dir)? {
            let mut retained = Vec::new();
            let mut changed = false;
            for line in BufReader::new(fs::File::open(&path)?).lines() {
                let line = line?;
                if line.trim().is_empty() {
                    changed = true;
                    continue;
                }
                match serde_json::from_str::<JamHistoryEntry>(&line) {
                    Ok(entry)
                        if entry.schema_version == HISTORY_SCHEMA_VERSION
                            && entry.played_at_ms < cutoff =>
                    {
                        changed = true;
                    }
                    // Unknown or malformed rows are preserved rather than
                    // destroyed by a version of Echo that cannot read them.
                    _ => retained.push(line),
                }
            }
            if !changed {
                continue;
            }
            if retained.is_empty() {
                fs::remove_file(&path)?;
            } else {
                replace_jsonl(&path, &retained)?;
            }
        }
        Ok(())
    }
}

fn history_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    if !dir.exists() {
        return Ok(files);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name.starts_with("history-v1-") && name.ends_with(".jsonl") {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn recover_prune_backups(dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let backup = entry?.path();
        let Some(name) = backup.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(original_name) = name.strip_suffix(".prune.bak") else {
            continue;
        };
        let original = dir.join(original_name);
        if original.exists() {
            fs::remove_file(backup)?;
        } else {
            fs::rename(backup, original)?;
        }
    }
    Ok(())
}

fn replace_jsonl(path: &Path, lines: &[String]) -> io::Result<()> {
    let temp = path.with_extension(format!("{}.tmp", random_secret()));
    let backup = path.with_extension("jsonl.prune.bak");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    for line in lines {
        output.write_all(line.as_bytes())?;
        output.write_all(b"\n")?;
    }
    output.sync_all()?;
    drop(output);
    if backup.exists() {
        fs::remove_file(&backup)?;
    }
    fs::rename(path, &backup)?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::rename(&backup, path);
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) struct HistoryObservation {
    pub(crate) spotify_id: String,
    pub(crate) queued_track: Option<QueuedTrack>,
}

/// Decide whether a bound-device observation starts a new Spotify run. Every
/// playing Spotify ID advances the run, but only matching Echo entries persist.
pub(crate) fn new_history_observation(
    last_spotify_id: Option<&str>,
    observed_spotify_id: Option<&str>,
    queued_track: Option<&QueuedTrack>,
    is_playing: bool,
) -> Option<HistoryObservation> {
    if !is_playing {
        return None;
    }
    let spotify_id = observed_spotify_id.filter(|id| !id.is_empty())?;
    if last_spotify_id == Some(spotify_id) {
        return None;
    }
    Some(HistoryObservation {
        spotify_id: spotify_id.to_string(),
        queued_track: queued_track
            .filter(|track| track.spotify_id == spotify_id)
            .cloned(),
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct HistoryQuery {
    #[serde(default = "default_history_sort")]
    sort: String,
    #[serde(default = "default_history_direction")]
    direction: String,
    #[serde(default)]
    actor_id: Option<String>,
    #[serde(default)]
    playlist_id: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_history_limit")]
    limit: usize,
}

fn default_history_sort() -> String {
    "played_at".to_string()
}

fn default_history_direction() -> String {
    "desc".to_string()
}

fn default_history_limit() -> usize {
    50
}

#[derive(Debug, Serialize)]
pub(crate) struct HistoryResponse {
    schema_version: u16,
    retention_days: u64,
    items: Vec<JamHistoryEntry>,
    offset: usize,
    limit: usize,
    total: usize,
}

fn history_order(left: &JamHistoryEntry, right: &JamHistoryEntry, sort: &str) -> Ordering {
    let primary = match sort {
        "played_at" => left.played_at_ms.cmp(&right.played_at_ms),
        "added_at" => left.added_at_ms.cmp(&right.added_at_ms),
        "track" => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        "artist" => left.artist.to_lowercase().cmp(&right.artist.to_lowercase()),
        "added_by" => left
            .added_by_name
            .to_lowercase()
            .cmp(&right.added_by_name.to_lowercase()),
        "playlist" => left
            .playlist
            .as_ref()
            .map(|playlist| playlist.name.to_lowercase())
            .cmp(
                &right
                    .playlist
                    .as_ref()
                    .map(|playlist| playlist.name.to_lowercase()),
            ),
        _ => Ordering::Equal,
    };
    primary.then_with(|| left.history_entry_id.cmp(&right.history_entry_id))
}

pub(crate) async fn jam_history_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HistoryQuery>,
) -> impl IntoResponse {
    if let Err(status) = ensure_admin(&state, &headers) {
        return (status, Json(serde_json::json!({"error":"unauthorized"}))).into_response();
    }
    if let Err(status) = ensure_jam_actor(&state, &headers) {
        return (status, Json(serde_json::json!({"error":"actor_required"}))).into_response();
    }
    if !matches!(
        query.sort.as_str(),
        "played_at" | "added_at" | "track" | "artist" | "added_by" | "playlist"
    ) || !matches!(query.direction.as_str(), "asc" | "desc")
        || !(1..=MAX_HISTORY_LIMIT).contains(&query.limit)
        || query.offset > 100_000
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error":"bad_request",
                "message":"Invalid history filter, sort, or page",
            })),
        )
            .into_response();
    }
    let history = std::sync::Arc::clone(&state.jam_history);
    let mut entries = match tokio::task::spawn_blocking(move || history.list(now_ts_ms())).await {
        Ok(Ok(entries)) => entries,
        Ok(Err(error)) => {
            warn!("Could not read Jam history: {}", error);
            let status = if error.kind() == io::ErrorKind::NotConnected {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            return (
                status,
                Json(serde_json::json!({
                    "error":"history_storage_error",
                    "message":"Could not read Jam history",
                })),
            )
                .into_response();
        }
        Err(error) => {
            warn!("Jam history read task failed: {}", error);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error":"history_storage_error",
                    "message":"Could not read Jam history",
                })),
            )
                .into_response();
        }
    };
    entries.retain(|entry| {
        query
            .actor_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .is_none_or(|actor_id| entry.added_by_actor_id == actor_id)
            && query
                .playlist_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .is_none_or(|playlist_id| {
                    entry
                        .playlist
                        .as_ref()
                        .map(|playlist| playlist.spotify_id.as_str())
                        == Some(playlist_id)
                })
    });
    entries.sort_by(|left, right| {
        let ordering = history_order(left, right, &query.sort);
        if query.direction == "desc" {
            ordering.reverse()
        } else {
            ordering
        }
    });
    let total = entries.len();
    let items = entries
        .into_iter()
        .skip(query.offset)
        .take(query.limit)
        .collect();
    Json(HistoryResponse {
        schema_version: HISTORY_SCHEMA_VERSION,
        retention_days: HISTORY_RETENTION_DAYS,
        items,
        offset: query.offset,
        limit: query.limit,
        total,
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str) -> QueuedTrack {
        QueuedTrack {
            queue_entry_id: format!("queue-{id}"),
            queue_batch_id: None,
            spotify_id: id.to_string(),
            spotify_uri: format!("spotify:track:{id}"),
            spotify_url: format!("https://open.spotify.com/track/{id}"),
            name: id.to_string(),
            artist: "Artist".to_string(),
            album_art_url: String::new(),
            duration_ms: 100,
            added_at_ms: 10,
            added_by_actor_id: "ea1_actor".to_string(),
            added_by_name: "Sam".to_string(),
            playlist: None,
            added_by: "Sam".to_string(),
        }
    }

    #[test]
    fn history_runs_dedupe_consecutive_tracks_but_not_a_b_a() {
        let a = track("AAAAAAAAAAAAAAAAAAAAAA");
        let b = track("BBBBBBBBBBBBBBBBBBBBBB");
        let mut last = None::<String>;
        let mut recorded = Vec::new();
        for current in [&a, &a, &a, &b, &a] {
            if let Some(observed) = new_history_observation(
                last.as_deref(),
                Some(&current.spotify_id),
                Some(current),
                true,
            ) {
                last = Some(observed.spotify_id.clone());
                recorded.push(observed.spotify_id);
            }
        }
        assert_eq!(
            recorded,
            vec![
                "AAAAAAAAAAAAAAAAAAAAAA",
                "BBBBBBBBBBBBBBBBBBBBBB",
                "AAAAAAAAAAAAAAAAAAAAAA"
            ]
        );
    }

    #[test]
    fn pause_and_resume_do_not_create_a_second_history_row() {
        let a = track("AAAAAAAAAAAAAAAAAAAAAA");
        let first = new_history_observation(None, Some(&a.spotify_id), Some(&a), true).unwrap();
        let last = Some(first.spotify_id);
        assert!(
            new_history_observation(last.as_deref(), Some(&a.spotify_id), Some(&a), false)
                .is_none()
        );
        assert!(
            new_history_observation(last.as_deref(), Some(&a.spotify_id), Some(&a), true).is_none()
        );
        assert!(new_history_observation(last.as_deref(), None, None, true).is_none());
    }

    #[test]
    fn external_track_breaks_an_echo_track_run_without_being_persisted() {
        let a = track("AAAAAAAAAAAAAAAAAAAAAA");
        let first = new_history_observation(None, Some(&a.spotify_id), Some(&a), true).unwrap();
        assert!(first.queued_track.is_some());
        let external = new_history_observation(
            Some(&first.spotify_id),
            Some("BBBBBBBBBBBBBBBBBBBBBB"),
            None,
            true,
        )
        .unwrap();
        assert!(external.queued_track.is_none());
        let repeated_a = new_history_observation(
            Some(&external.spotify_id),
            Some(&a.spotify_id),
            Some(&a),
            true,
        )
        .unwrap();
        assert!(repeated_a.queued_track.is_some());
    }

    #[test]
    fn store_applies_exact_thirty_day_retention() {
        let dir = std::env::temp_dir().join(format!("echo-jam-history-{}", random_secret()));
        let now = 50 * DAY_MS + 123;
        let store = JamHistoryStore::open(dir.clone(), now).unwrap();
        store
            .append_observation(&track("AAAAAAAAAAAAAAAAAAAAAA"), now - RETENTION_MS)
            .unwrap();
        store
            .append_observation(&track("BBBBBBBBBBBBBBBBBBBBBB"), now - RETENTION_MS - 1)
            .unwrap();
        let entries = store.list(now).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].spotify_id, "AAAAAAAAAAAAAAAAAAAAAA");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn append_separates_a_torn_tail_from_the_next_valid_row() {
        let dir = std::env::temp_dir().join(format!("echo-jam-history-{}", random_secret()));
        fs::create_dir_all(&dir).unwrap();
        let now = 50 * DAY_MS;
        let path = dir.join(format!("history-v1-{}.jsonl", now / DAY_MS));
        fs::write(&path, b"{torn").unwrap();
        let store = JamHistoryStore::open(dir.clone(), now).unwrap();
        store
            .append_observation(&track("AAAAAAAAAAAAAAAAAAAAAA"), now)
            .unwrap();
        let lines = fs::read_to_string(path).unwrap();
        let rows = lines.lines().collect::<Vec<_>>();
        assert_eq!(rows[0], "{torn");
        assert!(serde_json::from_str::<JamHistoryEntry>(rows[1]).is_ok());
        assert_eq!(store.list(now).unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn open_recovers_prune_backup_when_primary_is_missing() {
        let dir = std::env::temp_dir().join(format!("echo-jam-history-{}", random_secret()));
        fs::create_dir_all(&dir).unwrap();
        let now = 50 * DAY_MS;
        let original = dir.join(format!("history-v1-{}.jsonl", now / DAY_MS));
        let backup = PathBuf::from(format!("{}.prune.bak", original.display()));
        let entry = JamHistoryEntry::from_track(&track("AAAAAAAAAAAAAAAAAAAAAA"), now);
        fs::write(
            &backup,
            format!("{}\n", serde_json::to_string(&entry).unwrap()),
        )
        .unwrap();
        let store = JamHistoryStore::open(dir.clone(), now).unwrap();
        assert!(original.exists());
        assert!(!backup.exists());
        assert_eq!(store.list(now).unwrap(), vec![entry]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn disabled_store_reports_unavailable_instead_of_dropping_history() {
        let store = JamHistoryStore::disabled(PathBuf::from("disabled"));
        assert_eq!(
            store
                .append_observation(&track("AAAAAAAAAAAAAAAAAAAAAA"), DAY_MS)
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotConnected
        );
        assert_eq!(
            store.list(DAY_MS).unwrap_err().kind(),
            io::ErrorKind::NotConnected
        );
    }
}
