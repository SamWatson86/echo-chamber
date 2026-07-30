use crate::auth::{bounded_jam_actor_display_name, ensure_admin, ensure_jam_actor, JamActor};
use crate::config::{now_ts_ms, urlencoded};
use crate::jam_session::spotify_api_request;
use crate::AppState;

use axum::extract::{Json, Path, Query, State};
use axum::http::{header::RETRY_AFTER, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path as FsPath, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use tracing::warn;

pub(crate) const FAVORITES_SCHEMA_VERSION: u16 = 1;
pub(crate) const CATALOG_SCHEMA_VERSION: u16 = 1;
const MAX_SEARCH_LIMIT: usize = 10;
const MAX_PLAYLIST_ITEMS_LIMIT: usize = 50;
const MAX_CATALOG_OFFSET: usize = 1_000;
const MAX_FAVORITES_LIMIT: usize = 200;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FavoriteKind {
    Track,
    Playlist,
}

impl FavoriteKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Track => "track",
            Self::Playlist => "playlist",
        }
    }
}

impl FromStr for FavoriteKind {
    type Err = (StatusCode, String);

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "track" => Ok(Self::Track),
            "playlist" => Ok(Self::Playlist),
            _ => Err((
                StatusCode::BAD_REQUEST,
                "kind must be track or playlist".to_string(),
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct FavoriteAttribution {
    pub(crate) actor_id: String,
    pub(crate) display_name: String,
    pub(crate) added_at_ms: u64,
    pub(crate) source: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub(crate) struct FavoriteSummary {
    pub(crate) spotify_id: String,
    pub(crate) spotify_uri: String,
    pub(crate) spotify_url: String,
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) artwork_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) track_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) explicit: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct FavoriteItem {
    pub(crate) kind: FavoriteKind,
    #[serde(flatten)]
    pub(crate) summary: FavoriteSummary,
    pub(crate) attributions: Vec<FavoriteAttribution>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct FavoriteFile {
    schema_version: u16,
    items: Vec<FavoriteItem>,
}

impl Default for FavoriteFile {
    fn default() -> Self {
        Self {
            schema_version: FAVORITES_SCHEMA_VERSION,
            items: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct FavoriteView {
    pub(crate) kind: FavoriteKind,
    #[serde(flatten)]
    pub(crate) summary: FavoriteSummary,
    pub(crate) attributions: Vec<FavoriteAttribution>,
    pub(crate) contributor_count: usize,
    pub(crate) favorited_by_me: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FavoriteMutation {
    pub(crate) item_created: bool,
    pub(crate) attribution_added: bool,
}

pub(crate) struct FavoriteStore {
    path: PathBuf,
    writable: bool,
    inner: Mutex<FavoriteFile>,
}

impl FavoriteStore {
    pub(crate) fn open(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let backup = favorite_backup_path(&path);
        let data = if path.exists() {
            load_favorite_file(&path)?
        } else if backup.exists() {
            let recovered = load_favorite_file(&backup)?;
            fs::rename(&backup, &path)?;
            warn!(
                "Recovered Jam favorites from {:?} after an interrupted atomic write",
                backup
            );
            recovered
        } else {
            FavoriteFile::default()
        };
        Ok(Self {
            path,
            writable: true,
            inner: Mutex::new(data),
        })
    }

    #[cfg(test)]
    pub(crate) fn empty(path: PathBuf) -> Self {
        Self {
            path,
            writable: true,
            inner: Mutex::new(FavoriteFile::default()),
        }
    }

    /// Preserve an unreadable primary store and expose a valid backup, if one
    /// exists, without allowing a later mutation to overwrite either file.
    pub(crate) fn recover_read_only(path: PathBuf) -> Self {
        let backup = favorite_backup_path(&path);
        let data = load_favorite_file(&backup).unwrap_or_default();
        Self {
            path,
            writable: false,
            inner: Mutex::new(data),
        }
    }

    pub(crate) fn disabled(path: PathBuf) -> Self {
        Self {
            path,
            writable: false,
            inner: Mutex::new(FavoriteFile::default()),
        }
    }

    pub(crate) fn favorite_state(
        &self,
        kind: FavoriteKind,
        spotify_id: &str,
        actor_id: &str,
    ) -> (bool, usize) {
        let data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        data.items
            .iter()
            .find(|item| item.kind == kind && item.summary.spotify_id == spotify_id)
            .map(|item| {
                (
                    item.attributions
                        .iter()
                        .any(|entry| entry.actor_id == actor_id),
                    item.attributions.len(),
                )
            })
            .unwrap_or((false, 0))
    }

    pub(crate) fn upsert(
        &self,
        kind: FavoriteKind,
        summary: FavoriteSummary,
        actor: &JamActor,
        source: &str,
        added_at_ms: u64,
    ) -> io::Result<(FavoriteItem, FavoriteMutation)> {
        let mut data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mut candidate = data.clone();
        let summary = summary_for_persistence(kind, summary);
        let mut mutation = FavoriteMutation {
            item_created: false,
            attribution_added: false,
        };
        let index = candidate
            .items
            .iter()
            .position(|item| item.kind == kind && item.summary.spotify_id == summary.spotify_id);
        let item = if let Some(index) = index {
            let item = &mut candidate.items[index];
            item.summary = summary;
            if let Some(attribution) = item
                .attributions
                .iter_mut()
                .find(|entry| entry.actor_id == actor.actor_id)
            {
                attribution.display_name = actor.display_name.clone();
            } else {
                item.attributions.push(FavoriteAttribution {
                    actor_id: actor.actor_id.clone(),
                    display_name: actor.display_name.clone(),
                    added_at_ms,
                    source: source.to_string(),
                });
                mutation.attribution_added = true;
            }
            item.clone()
        } else {
            mutation.item_created = true;
            mutation.attribution_added = true;
            let item = FavoriteItem {
                kind,
                summary,
                attributions: vec![FavoriteAttribution {
                    actor_id: actor.actor_id.clone(),
                    display_name: actor.display_name.clone(),
                    added_at_ms,
                    source: source.to_string(),
                }],
            };
            candidate.items.push(item.clone());
            item
        };
        self.persist_locked(&candidate)?;
        *data = candidate;
        Ok((item, mutation))
    }

    pub(crate) fn upsert_many(
        &self,
        entries: Vec<(FavoriteKind, FavoriteSummary, String)>,
        actor: &JamActor,
        added_at_ms: u64,
    ) -> io::Result<(usize, usize)> {
        let mut data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mut candidate = data.clone();
        let mut items_created = 0;
        let mut attributions_added = 0;
        let mut indices = candidate
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| ((item.kind, item.summary.spotify_id.clone()), index))
            .collect::<HashMap<_, _>>();
        for (kind, summary, source) in entries {
            let summary = summary_for_persistence(kind, summary);
            let key = (kind, summary.spotify_id.clone());
            if let Some(index) = indices.get(&key).copied() {
                let item = &mut candidate.items[index];
                item.summary = summary;
                if let Some(attribution) = item
                    .attributions
                    .iter_mut()
                    .find(|entry| entry.actor_id == actor.actor_id)
                {
                    attribution.display_name = actor.display_name.clone();
                } else {
                    item.attributions.push(FavoriteAttribution {
                        actor_id: actor.actor_id.clone(),
                        display_name: actor.display_name.clone(),
                        added_at_ms,
                        source,
                    });
                    attributions_added += 1;
                }
            } else {
                indices.insert(key, candidate.items.len());
                candidate.items.push(FavoriteItem {
                    kind,
                    summary,
                    attributions: vec![FavoriteAttribution {
                        actor_id: actor.actor_id.clone(),
                        display_name: actor.display_name.clone(),
                        added_at_ms,
                        source,
                    }],
                });
                items_created += 1;
                attributions_added += 1;
            }
        }
        self.persist_locked(&candidate)?;
        *data = candidate;
        Ok((items_created, attributions_added))
    }

    pub(crate) fn remove_actor(
        &self,
        kind: FavoriteKind,
        spotify_id: &str,
        actor_id: &str,
    ) -> io::Result<bool> {
        let mut data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mut candidate = data.clone();
        let Some(index) = candidate
            .items
            .iter()
            .position(|item| item.kind == kind && item.summary.spotify_id == spotify_id)
        else {
            return Ok(false);
        };
        let before = candidate.items[index].attributions.len();
        candidate.items[index]
            .attributions
            .retain(|entry| entry.actor_id != actor_id);
        if candidate.items[index].attributions.len() == before {
            return Ok(false);
        }
        if candidate.items[index].attributions.is_empty() {
            candidate.items.remove(index);
        }
        self.persist_locked(&candidate)?;
        *data = candidate;
        Ok(true)
    }

    pub(crate) fn snapshot(&self) -> Vec<FavoriteItem> {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .items
            .clone()
    }

    fn persist_locked(&self, data: &FavoriteFile) -> io::Result<()> {
        if !self.writable {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "favorites store is read-only because its primary file could not be loaded",
            ));
        }
        let bytes = serde_json::to_vec_pretty(data)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        write_atomic(&self.path, &bytes)
    }
}

fn summary_for_persistence(kind: FavoriteKind, mut summary: FavoriteSummary) -> FavoriteSummary {
    if kind == FavoriteKind::Playlist {
        // Spotify playlist image URLs expire quickly. Search/detail responses
        // still carry fresh art, but the durable library never serves a stale URL.
        summary.artwork_url = None;
    }
    summary
}

fn load_favorite_file(path: &FsPath) -> io::Result<FavoriteFile> {
    let bytes = fs::read(path)?;
    let parsed: FavoriteFile = serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if parsed.schema_version != FAVORITES_SCHEMA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported favorites schema {}", parsed.schema_version),
        ));
    }
    validate_favorite_file(parsed)
}

fn favorite_backup_path(path: &FsPath) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| FsPath::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("favorites-v1.json");
    parent.join(format!("{file_name}.bak"))
}

fn validate_favorite_file(mut data: FavoriteFile) -> io::Result<FavoriteFile> {
    let mut keys = HashSet::new();
    for item in &mut data.items {
        item.summary = summary_for_persistence(item.kind, std::mem::take(&mut item.summary));
        if !valid_spotify_id(&item.summary.spotify_id)
            || item.summary.name.trim().is_empty()
            || !keys.insert((item.kind, item.summary.spotify_id.clone()))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "favorites contain an invalid or duplicate item",
            ));
        }
        let mut actors = HashSet::new();
        item.attributions
            .retain(|entry| !entry.actor_id.is_empty() && actors.insert(entry.actor_id.clone()));
        if item.attributions.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "favorite item has no contributors",
            ));
        }
        for attribution in &mut item.attributions {
            attribution.display_name = bounded_jam_actor_display_name(
                Some(&attribution.display_name),
                &attribution.actor_id,
            );
        }
    }
    Ok(data)
}

fn write_atomic(path: &FsPath, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "favorite path has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid favorite filename"))?;
    let temp = parent.join(format!("{file_name}.{suffix}.tmp"));
    let backup = favorite_backup_path(path);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    output.write_all(bytes)?;
    output.sync_all()?;
    drop(output);

    if backup.exists() {
        fs::remove_file(&backup)?;
    }
    let had_original = path.exists();
    if had_original {
        fs::rename(path, &backup)?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if had_original {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    // Retain the last valid primary as a recovery point. The next write
    // replaces it before moving the then-current primary into this slot.
    Ok(())
}

#[derive(Debug)]
pub(crate) struct JamApiError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) retry_after: Option<String>,
}

impl JamApiError {
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: message.into(),
            retry_after: None,
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "storage_error",
            message: message.into(),
            retry_after: None,
        }
    }
}

impl IntoResponse for JamApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(serde_json::json!({
                "error": self.code,
                "message": self.message,
            })),
        )
            .into_response();
        if let Some(retry_after) = self.retry_after {
            if let Ok(value) = HeaderValue::from_str(&retry_after) {
                response.headers_mut().insert(RETRY_AFTER, value);
            }
        }
        response
    }
}

pub(crate) async fn spotify_json_request(
    state: &AppState,
    method: reqwest::Method,
    url: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, JamApiError> {
    let response = spotify_api_request(state, method, url, body)
        .await
        .map_err(|(status, message)| JamApiError {
            status,
            code: if status == StatusCode::TOO_MANY_REQUESTS {
                "spotify_rate_limited"
            } else {
                "spotify_request_failed"
            },
            message,
            retry_after: (status == StatusCode::TOO_MANY_REQUESTS)
                .then(|| crate::jam_session::spotify_retry_after_seconds(state))
                .flatten(),
        })?;
    let upstream = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.unwrap_or_default();
    if !upstream.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value["error"]["message"]
                    .as_str()
                    .or_else(|| value["error_description"].as_str())
                    .map(str::to_string)
            })
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "Spotify request failed".to_string());
        let (status, code) = match upstream {
            reqwest::StatusCode::BAD_REQUEST => (StatusCode::BAD_REQUEST, "spotify_bad_request"),
            reqwest::StatusCode::UNAUTHORIZED => (StatusCode::UNAUTHORIZED, "spotify_unauthorized"),
            reqwest::StatusCode::FORBIDDEN => (StatusCode::FORBIDDEN, "spotify_forbidden"),
            reqwest::StatusCode::NOT_FOUND => (StatusCode::NOT_FOUND, "spotify_not_found"),
            reqwest::StatusCode::TOO_MANY_REQUESTS => {
                (StatusCode::TOO_MANY_REQUESTS, "spotify_rate_limited")
            }
            _ => (StatusCode::BAD_GATEWAY, "spotify_upstream_error"),
        };
        return Err(JamApiError {
            status,
            code,
            message,
            retry_after,
        });
    }
    if body.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&body).map_err(|error| JamApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "spotify_invalid_response",
        message: format!("Spotify returned invalid JSON: {error}"),
        retry_after: None,
    })
}

pub(crate) fn valid_spotify_id(value: &str) -> bool {
    value.len() == 22 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn string_at(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_image(value: &serde_json::Value) -> Option<String> {
    value
        .get("images")
        .and_then(serde_json::Value::as_array)
        .and_then(|images| images.first())
        .and_then(|image| string_at(image, &["url"]))
}

fn artists(value: &serde_json::Value) -> Option<String> {
    let names = value
        .get("artists")
        .and_then(serde_json::Value::as_array)?
        .iter()
        .filter_map(|artist| string_at(artist, &["name"]))
        .collect::<Vec<_>>();
    (!names.is_empty()).then(|| names.join(", "))
}

pub(crate) fn normalize_track(value: &serde_json::Value) -> Result<FavoriteSummary, &'static str> {
    if value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| kind != "track")
    {
        return Err("non_track");
    }
    if value.get("is_local").and_then(serde_json::Value::as_bool) == Some(true) {
        return Err("local_track");
    }
    if value
        .get("is_playable")
        .and_then(serde_json::Value::as_bool)
        == Some(false)
    {
        return Err("unplayable");
    }
    let spotify_id = string_at(value, &["id"])
        .filter(|id| valid_spotify_id(id))
        .ok_or("malformed")?;
    let spotify_uri = string_at(value, &["uri"])
        .filter(|uri| uri == &format!("spotify:track:{spotify_id}"))
        .ok_or("malformed")?;
    let name = string_at(value, &["name"]).ok_or("malformed")?;
    let artist = artists(value).ok_or("malformed")?;
    let spotify_url = format!("https://open.spotify.com/track/{spotify_id}");
    Ok(FavoriteSummary {
        spotify_id,
        spotify_uri,
        spotify_url,
        name,
        artist: Some(artist),
        owner: None,
        description: None,
        artwork_url: value.get("album").and_then(first_image),
        duration_ms: value.get("duration_ms").and_then(serde_json::Value::as_u64),
        track_count: None,
        snapshot_id: None,
        explicit: value.get("explicit").and_then(serde_json::Value::as_bool),
    })
}

pub(crate) fn normalize_playlist(
    value: &serde_json::Value,
) -> Result<FavoriteSummary, &'static str> {
    if value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| kind != "playlist")
    {
        return Err("non_playlist");
    }
    let spotify_id = string_at(value, &["id"])
        .filter(|id| valid_spotify_id(id))
        .ok_or("malformed")?;
    let spotify_uri = string_at(value, &["uri"])
        .filter(|uri| uri == &format!("spotify:playlist:{spotify_id}"))
        .ok_or("malformed")?;
    let name = string_at(value, &["name"]).ok_or("malformed")?;
    let spotify_url = format!("https://open.spotify.com/playlist/{spotify_id}");
    Ok(FavoriteSummary {
        spotify_id,
        spotify_uri,
        spotify_url,
        name,
        artist: None,
        owner: string_at(value, &["owner", "display_name"])
            .or_else(|| string_at(value, &["owner", "id"])),
        description: string_at(value, &["description"]),
        artwork_url: first_image(value),
        duration_ms: None,
        track_count: value
            .get("items")
            .and_then(|items| items.get("total"))
            .and_then(serde_json::Value::as_u64)
            .or_else(|| {
                value
                    .get("tracks")
                    .and_then(|tracks| tracks.get("total"))
                    .and_then(serde_json::Value::as_u64)
            }),
        snapshot_id: string_at(value, &["snapshot_id"]),
        explicit: None,
    })
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct CatalogTrack {
    pub(crate) kind: FavoriteKind,
    #[serde(flatten)]
    pub(crate) summary: FavoriteSummary,
    pub(crate) favorited_by_me: bool,
    pub(crate) favorite_contributor_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) playlist_position: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct CatalogPlaylist {
    pub(crate) kind: FavoriteKind,
    #[serde(flatten)]
    pub(crate) summary: FavoriteSummary,
    pub(crate) favorited_by_me: bool,
    pub(crate) favorite_contributor_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum CatalogItem {
    Track(CatalogTrack),
    Playlist(CatalogPlaylist),
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogSearchRequest {
    kind: FavoriteKind,
    query: String,
    offset: usize,
    limit: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct CatalogPage {
    schema_version: u16,
    kind: FavoriteKind,
    items: Vec<CatalogItem>,
    offset: usize,
    limit: usize,
    total: u64,
    next_offset: Option<usize>,
}

fn validate_search_page(offset: usize, limit: usize) -> Result<(), JamApiError> {
    if !(1..=MAX_SEARCH_LIMIT).contains(&limit) {
        return Err(JamApiError::bad_request(format!(
            "search limit must be between 1 and {MAX_SEARCH_LIMIT}"
        )));
    }
    if offset > MAX_CATALOG_OFFSET {
        return Err(JamApiError::bad_request(format!(
            "offset must be at most {MAX_CATALOG_OFFSET}"
        )));
    }
    Ok(())
}

fn validate_playlist_items_page(offset: usize, limit: usize) -> Result<(), JamApiError> {
    if !(1..=MAX_PLAYLIST_ITEMS_LIMIT).contains(&limit) {
        return Err(JamApiError::bad_request(format!(
            "playlist item limit must be between 1 and {MAX_PLAYLIST_ITEMS_LIMIT}"
        )));
    }
    if offset > 100_000 {
        return Err(JamApiError::bad_request("offset is too large"));
    }
    Ok(())
}

fn favorite_track(
    state: &AppState,
    actor_id: &str,
    summary: FavoriteSummary,
    position: Option<usize>,
) -> CatalogTrack {
    let (favorited_by_me, favorite_contributor_count) =
        state
            .jam_favorites
            .favorite_state(FavoriteKind::Track, &summary.spotify_id, actor_id);
    CatalogTrack {
        kind: FavoriteKind::Track,
        summary,
        favorited_by_me,
        favorite_contributor_count,
        playlist_position: position,
    }
}

fn favorite_playlist(
    state: &AppState,
    actor_id: &str,
    summary: FavoriteSummary,
) -> CatalogPlaylist {
    let (favorited_by_me, favorite_contributor_count) =
        state
            .jam_favorites
            .favorite_state(FavoriteKind::Playlist, &summary.spotify_id, actor_id);
    CatalogPlaylist {
        kind: FavoriteKind::Playlist,
        summary,
        favorited_by_me,
        favorite_contributor_count,
    }
}

pub(crate) async fn jam_catalog_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CatalogSearchRequest>,
) -> Result<Json<CatalogPage>, JamApiError> {
    ensure_admin(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "unauthorized",
        message: "Authentication required".to_string(),
        retry_after: None,
    })?;
    let actor = ensure_jam_actor(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "actor_required",
        message: "A current Echo participant token is required".to_string(),
        retry_after: None,
    })?;
    validate_search_page(payload.offset, payload.limit)?;
    let query = payload.query.trim();
    if query.is_empty() || query.len() > 250 {
        return Err(JamApiError::bad_request(
            "query must contain between 1 and 250 characters",
        ));
    }
    let url = format!(
        "https://api.spotify.com/v1/search?q={}&type={}&offset={}&limit={}",
        urlencoded(query),
        payload.kind.as_str(),
        payload.offset,
        payload.limit,
    );
    let data = spotify_json_request(&state, reqwest::Method::GET, &url, None).await?;
    let container_name = match payload.kind {
        FavoriteKind::Track => "tracks",
        FavoriteKind::Playlist => "playlists",
    };
    let container = data.get(container_name).unwrap_or(&serde_json::Value::Null);
    let total = container
        .get("total")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let items = container
        .get("items")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| match payload.kind {
            FavoriteKind::Track => normalize_track(value).ok().map(|summary| {
                CatalogItem::Track(favorite_track(&state, &actor.actor_id, summary, None))
            }),
            FavoriteKind::Playlist => normalize_playlist(value).ok().map(|summary| {
                CatalogItem::Playlist(favorite_playlist(&state, &actor.actor_id, summary))
            }),
        })
        .collect::<Vec<_>>();
    let consumed = payload.offset.saturating_add(payload.limit);
    let next_offset =
        (consumed <= MAX_CATALOG_OFFSET && consumed < total as usize).then_some(consumed);
    Ok(Json(CatalogPage {
        schema_version: CATALOG_SCHEMA_VERSION,
        kind: payload.kind,
        items,
        offset: payload.offset,
        limit: payload.limit,
        total,
        next_offset,
    }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct PlaylistItemsQuery {
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_playlist_items_limit")]
    limit: usize,
}

fn default_playlist_items_limit() -> usize {
    MAX_PLAYLIST_ITEMS_LIMIT
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkippedPlaylistItem {
    pub(crate) position: usize,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PlaylistItemsPage {
    pub(crate) schema_version: u16,
    pub(crate) playlist: CatalogPlaylist,
    pub(crate) items: Vec<CatalogTrack>,
    pub(crate) skipped: Vec<SkippedPlaylistItem>,
    pub(crate) offset: usize,
    pub(crate) limit: usize,
    pub(crate) total: u64,
    pub(crate) next_offset: Option<usize>,
}

pub(crate) async fn fetch_playlist_summary(
    state: &AppState,
    playlist_id: &str,
) -> Result<FavoriteSummary, JamApiError> {
    if !valid_spotify_id(playlist_id) {
        return Err(JamApiError::bad_request("invalid Spotify playlist ID"));
    }
    let url = format!("https://api.spotify.com/v1/playlists/{playlist_id}");
    let data = spotify_json_request(state, reqwest::Method::GET, &url, None).await?;
    normalize_playlist(&data).map_err(|reason| JamApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "spotify_invalid_playlist",
        message: format!("Spotify playlist was malformed: {reason}"),
        retry_after: None,
    })
}

async fn fetch_playlist_items_page(
    state: &AppState,
    playlist_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>, u64), JamApiError> {
    validate_playlist_items_page(offset, limit)?;
    if !valid_spotify_id(playlist_id) {
        return Err(JamApiError::bad_request("invalid Spotify playlist ID"));
    }
    let url = format!(
        "https://api.spotify.com/v1/playlists/{playlist_id}/items?offset={offset}&limit={limit}&additional_types=track"
    );
    let data = spotify_json_request(state, reqwest::Method::GET, &url, None)
        .await
        .map_err(map_playlist_items_error)?;
    Ok(normalize_playlist_items_page(&data, offset))
}

fn map_playlist_items_error(error: JamApiError) -> JamApiError {
    if error.status == StatusCode::FORBIDDEN {
        JamApiError {
            status: StatusCode::FORBIDDEN,
            code: "playlist_items_forbidden",
            message: "Spotify only allows this Echo app to expand playlists the connected account owns or collaborates on; other public playlists require Spotify Extended Quota"
                .to_string(),
            retry_after: error.retry_after,
        }
    } else {
        error
    }
}

fn normalize_playlist_items_page(
    data: &serde_json::Value,
    offset: usize,
) -> (Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>, u64) {
    let total = data
        .get("total")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let mut tracks = Vec::new();
    let mut skipped = Vec::new();
    for (index, wrapper) in data
        .get("items")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let position = offset + index;
        if wrapper.get("is_local").and_then(serde_json::Value::as_bool) == Some(true) {
            skipped.push(SkippedPlaylistItem {
                position,
                reason: "local_track".to_string(),
            });
            continue;
        }
        let candidate = wrapper
            .get("track")
            .or_else(|| wrapper.get("item"))
            .unwrap_or(&serde_json::Value::Null);
        match normalize_track(candidate) {
            Ok(track) => tracks.push((position, track)),
            Err(reason) => skipped.push(SkippedPlaylistItem {
                position,
                reason: reason.to_string(),
            }),
        }
    }
    (tracks, skipped, total)
}

pub(crate) async fn jam_playlist_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(playlist_id): Path<String>,
    Query(query): Query<PlaylistItemsQuery>,
) -> Result<Json<PlaylistItemsPage>, JamApiError> {
    ensure_admin(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "unauthorized",
        message: "Authentication required".to_string(),
        retry_after: None,
    })?;
    let actor = ensure_jam_actor(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "actor_required",
        message: "A current Echo participant token is required".to_string(),
        retry_after: None,
    })?;
    let summary = fetch_playlist_summary(&state, &playlist_id).await?;
    let (tracks, skipped, total) =
        fetch_playlist_items_page(&state, &playlist_id, query.offset, query.limit).await?;
    let items = tracks
        .into_iter()
        .map(|(position, summary)| favorite_track(&state, &actor.actor_id, summary, Some(position)))
        .collect();
    let consumed = query.offset.saturating_add(query.limit);
    Ok(Json(PlaylistItemsPage {
        schema_version: CATALOG_SCHEMA_VERSION,
        playlist: favorite_playlist(&state, &actor.actor_id, summary),
        items,
        skipped,
        offset: query.offset,
        limit: query.limit,
        total,
        next_offset: (consumed < total as usize).then_some(consumed),
    }))
}

#[derive(Clone, Debug)]
pub(crate) struct PlaylistExpansion {
    pub(crate) playlist: FavoriteSummary,
    pub(crate) tracks: Vec<(usize, FavoriteSummary)>,
    pub(crate) skipped: Vec<SkippedPlaylistItem>,
}

pub(crate) async fn fetch_playlist_expansion(
    state: &AppState,
    playlist_id: &str,
) -> Result<PlaylistExpansion, JamApiError> {
    let playlist = fetch_playlist_summary(state, playlist_id).await?;
    let mut offset = 0usize;
    let mut tracks = Vec::new();
    let mut skipped = Vec::new();
    loop {
        let (page_tracks, page_skipped, page_total) =
            fetch_playlist_items_page(state, playlist_id, offset, MAX_PLAYLIST_ITEMS_LIMIT).await?;
        if page_total > 50 {
            return Err(JamApiError {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "playlist_too_large",
                message: format!("Playlist has {page_total} items; Echo queues at most 50"),
                retry_after: None,
            });
        }
        let returned = page_tracks.len() + page_skipped.len();
        tracks.extend(page_tracks);
        skipped.extend(page_skipped);
        offset = offset.saturating_add(returned);
        if returned == 0 || offset >= page_total as usize {
            break;
        }
    }
    Ok(PlaylistExpansion {
        playlist,
        tracks,
        skipped,
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct FavoriteListQuery {
    #[serde(default = "default_favorite_kind_filter")]
    kind: String,
    actor_id: Option<String>,
    #[serde(default = "default_favorite_sort")]
    sort: String,
    #[serde(default = "default_direction")]
    direction: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_favorite_limit")]
    limit: usize,
}

fn default_favorite_kind_filter() -> String {
    "all".to_string()
}

fn default_favorite_sort() -> String {
    "added_at".to_string()
}

fn default_direction() -> String {
    "desc".to_string()
}

fn default_favorite_limit() -> usize {
    50
}

#[derive(Debug, Serialize)]
pub(crate) struct FavoriteCounts {
    tracks: usize,
    playlists: usize,
    contributors: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct FavoriteContributorSummary {
    actor_id: String,
    display_name: String,
    count: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct FavoriteListResponse {
    schema_version: u16,
    items: Vec<FavoriteView>,
    offset: usize,
    limit: usize,
    total: usize,
    counts: FavoriteCounts,
    contributors: Vec<FavoriteContributorSummary>,
}

fn item_added_at(item: &FavoriteItem) -> u64 {
    item.attributions
        .iter()
        .map(|entry| entry.added_at_ms)
        .max()
        .unwrap_or(0)
}

fn item_added_by(item: &FavoriteItem) -> String {
    let mut names = item
        .attributions
        .iter()
        .map(|entry| entry.display_name.to_lowercase())
        .collect::<Vec<_>>();
    names.sort();
    names.join("\0")
}

fn favorite_sort_order(left: &FavoriteItem, right: &FavoriteItem, sort: &str) -> Ordering {
    let primary = match sort {
        "added_at" => item_added_at(left).cmp(&item_added_at(right)),
        "name" => left
            .summary
            .name
            .to_lowercase()
            .cmp(&right.summary.name.to_lowercase()),
        "added_by" => item_added_by(left).cmp(&item_added_by(right)),
        "kind" => left.kind.as_str().cmp(right.kind.as_str()),
        _ => Ordering::Equal,
    };
    primary.then_with(|| left.summary.spotify_id.cmp(&right.summary.spotify_id))
}

fn validate_favorite_query(query: &FavoriteListQuery) -> Result<(), JamApiError> {
    if !matches!(query.kind.as_str(), "all" | "track" | "playlist") {
        return Err(JamApiError::bad_request(
            "kind must be all, track, or playlist",
        ));
    }
    if !matches!(
        query.sort.as_str(),
        "added_at" | "name" | "added_by" | "kind"
    ) {
        return Err(JamApiError::bad_request(
            "sort must be added_at, name, added_by, or kind",
        ));
    }
    if !matches!(query.direction.as_str(), "asc" | "desc") {
        return Err(JamApiError::bad_request("direction must be asc or desc"));
    }
    if !(1..=MAX_FAVORITES_LIMIT).contains(&query.limit) {
        return Err(JamApiError::bad_request(format!(
            "limit must be between 1 and {MAX_FAVORITES_LIMIT}"
        )));
    }
    if query.offset > 100_000 {
        return Err(JamApiError::bad_request("offset is too large"));
    }
    if query
        .actor_id
        .as_deref()
        .is_some_and(|actor_id| actor_id.len() > 128)
    {
        return Err(JamApiError::bad_request("invalid actor_id"));
    }
    Ok(())
}

pub(crate) async fn jam_favorites_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<FavoriteListQuery>,
) -> Result<Json<FavoriteListResponse>, JamApiError> {
    ensure_admin(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "unauthorized",
        message: "Authentication required".to_string(),
        retry_after: None,
    })?;
    let actor = ensure_jam_actor(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "actor_required",
        message: "A current Echo participant token is required".to_string(),
        retry_after: None,
    })?;
    validate_favorite_query(&query)?;
    let facet_items = state
        .jam_favorites
        .snapshot()
        .into_iter()
        .filter(|item| query.kind == "all" || item.kind.as_str() == query.kind)
        .collect::<Vec<_>>();
    // Contributor choices describe the whole selected kind, not the currently
    // selected contributor, so choosing one person never hides everyone else.
    let mut contributor_map: HashMap<String, (String, usize)> = HashMap::new();
    for attribution in facet_items.iter().flat_map(|item| item.attributions.iter()) {
        let entry = contributor_map
            .entry(attribution.actor_id.clone())
            .or_insert_with(|| (attribution.display_name.clone(), 0));
        entry.0 = attribution.display_name.clone();
        entry.1 += 1;
    }
    let mut contributor_summaries = contributor_map
        .into_iter()
        .map(
            |(actor_id, (display_name, count))| FavoriteContributorSummary {
                actor_id,
                display_name,
                count,
            },
        )
        .collect::<Vec<_>>();
    contributor_summaries.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.actor_id.cmp(&right.actor_id))
    });
    let contributor_count = contributor_summaries.len();

    let mut items = facet_items
        .into_iter()
        .filter(|item| {
            query
                .actor_id
                .as_deref()
                .filter(|actor_id| !actor_id.is_empty())
                .is_none_or(|actor_id| {
                    item.attributions
                        .iter()
                        .any(|entry| entry.actor_id == actor_id)
                })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        let ordering = favorite_sort_order(left, right, &query.sort);
        if query.direction == "desc" {
            ordering.reverse()
        } else {
            ordering
        }
    });
    let total = items.len();
    let tracks = items
        .iter()
        .filter(|item| item.kind == FavoriteKind::Track)
        .count();
    let playlists = items
        .iter()
        .filter(|item| item.kind == FavoriteKind::Playlist)
        .count();
    let views = items
        .into_iter()
        .skip(query.offset)
        .take(query.limit)
        .map(|item| FavoriteView {
            kind: item.kind,
            summary: item.summary,
            contributor_count: item.attributions.len(),
            favorited_by_me: item
                .attributions
                .iter()
                .any(|entry| entry.actor_id == actor.actor_id),
            attributions: item.attributions,
        })
        .collect();
    Ok(Json(FavoriteListResponse {
        schema_version: FAVORITES_SCHEMA_VERSION,
        items: views,
        offset: query.offset,
        limit: query.limit,
        total,
        counts: FavoriteCounts {
            tracks,
            playlists,
            contributors: contributor_count,
        },
        contributors: contributor_summaries,
    }))
}

#[derive(Debug, Serialize)]
pub(crate) struct FavoriteMutationResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    item: Option<FavoriteView>,
}

pub(crate) async fn fetch_favorite_summary(
    state: &AppState,
    kind: FavoriteKind,
    spotify_id: &str,
) -> Result<FavoriteSummary, JamApiError> {
    if !valid_spotify_id(spotify_id) {
        return Err(JamApiError::bad_request("invalid Spotify item ID"));
    }
    let url = format!(
        "https://api.spotify.com/v1/{}/{}",
        match kind {
            FavoriteKind::Track => "tracks",
            FavoriteKind::Playlist => "playlists",
        },
        spotify_id,
    );
    let data = spotify_json_request(state, reqwest::Method::GET, &url, None).await?;
    match kind {
        FavoriteKind::Track => normalize_track(&data),
        FavoriteKind::Playlist => normalize_playlist(&data),
    }
    .map_err(|reason| JamApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "spotify_invalid_item",
        message: format!("Spotify item was malformed: {reason}"),
        retry_after: None,
    })
}

pub(crate) async fn jam_favorite_put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((kind, spotify_id)): Path<(String, String)>,
) -> Result<Json<FavoriteMutationResponse>, JamApiError> {
    ensure_admin(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "unauthorized",
        message: "Authentication required".to_string(),
        retry_after: None,
    })?;
    let actor = ensure_jam_actor(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "actor_required",
        message: "A current Echo participant token is required".to_string(),
        retry_after: None,
    })?;
    let kind =
        FavoriteKind::from_str(&kind).map_err(|(_, message)| JamApiError::bad_request(message))?;
    let summary = fetch_favorite_summary(&state, kind, &spotify_id).await?;
    let store = std::sync::Arc::clone(&state.jam_favorites);
    let (item, _) = tokio::task::spawn_blocking(move || {
        store.upsert(kind, summary, &actor, "echo", now_ts_ms())
    })
    .await
    .map_err(|error| JamApiError::internal(format!("Favorite storage task failed: {error}")))?
    .map_err(|error| JamApiError::internal(format!("Could not persist favorite: {error}")))?;
    Ok(Json(FavoriteMutationResponse {
        ok: true,
        item: Some(FavoriteView {
            kind: item.kind,
            summary: item.summary,
            contributor_count: item.attributions.len(),
            favorited_by_me: true,
            attributions: item.attributions,
        }),
    }))
}

pub(crate) async fn jam_favorite_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((kind, spotify_id)): Path<(String, String)>,
) -> Result<Json<FavoriteMutationResponse>, JamApiError> {
    ensure_admin(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "unauthorized",
        message: "Authentication required".to_string(),
        retry_after: None,
    })?;
    let actor = ensure_jam_actor(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "actor_required",
        message: "A current Echo participant token is required".to_string(),
        retry_after: None,
    })?;
    let kind =
        FavoriteKind::from_str(&kind).map_err(|(_, message)| JamApiError::bad_request(message))?;
    if !valid_spotify_id(&spotify_id) {
        return Err(JamApiError::bad_request("invalid Spotify item ID"));
    }
    let store = std::sync::Arc::clone(&state.jam_favorites);
    tokio::task::spawn_blocking(move || store.remove_actor(kind, &spotify_id, &actor.actor_id))
        .await
        .map_err(|error| JamApiError::internal(format!("Favorite storage task failed: {error}")))?
        .map_err(|error| JamApiError::internal(format!("Could not persist favorite: {error}")))?;
    Ok(Json(FavoriteMutationResponse {
        ok: true,
        item: None,
    }))
}

#[derive(Debug, Serialize)]
pub(crate) struct FavoriteImportResponse {
    ok: bool,
    tracks_seen: usize,
    playlists_seen: usize,
    items_created: usize,
    attributions_added: usize,
    skipped: usize,
}

async fn persist_import_page(
    state: &AppState,
    entries: Vec<(FavoriteKind, FavoriteSummary, String)>,
    actor: &JamActor,
    imported_at_ms: u64,
) -> Result<(usize, usize), JamApiError> {
    if entries.is_empty() {
        return Ok((0, 0));
    }
    let store = std::sync::Arc::clone(&state.jam_favorites);
    let actor = actor.clone();
    tokio::task::spawn_blocking(move || store.upsert_many(entries, &actor, imported_at_ms))
        .await
        .map_err(|error| JamApiError::internal(format!("Favorite storage task failed: {error}")))?
        .map_err(|error| JamApiError::internal(format!("Could not persist favorites: {error}")))
}

pub(crate) async fn jam_favorites_import_spotify(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<FavoriteImportResponse>, JamApiError> {
    ensure_admin(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "unauthorized",
        message: "Authentication required".to_string(),
        retry_after: None,
    })?;
    let actor = ensure_jam_actor(&state, &headers).map_err(|status| JamApiError {
        status,
        code: "actor_required",
        message: "A current Echo participant token is required".to_string(),
        retry_after: None,
    })?;
    let imported_at_ms = now_ts_ms();
    let mut tracks_seen = 0;
    let mut playlists_seen = 0;
    let mut skipped = 0;
    let mut items_created = 0;
    let mut attributions_added = 0;

    let mut offset = 0usize;
    loop {
        let url = format!("https://api.spotify.com/v1/me/tracks?offset={offset}&limit=50");
        let data = spotify_json_request(&state, reqwest::Method::GET, &url, None).await?;
        let items = data
            .get("items")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let returned = items.len();
        tracks_seen += returned;
        let mut page_entries = Vec::new();
        for wrapper in items {
            match wrapper
                .get("track")
                .and_then(|track| normalize_track(track).ok())
            {
                Some(summary) => page_entries.push((
                    FavoriteKind::Track,
                    summary,
                    "spotify_saved_tracks".to_string(),
                )),
                None => skipped += 1,
            }
        }
        let (page_created, page_attributions) =
            persist_import_page(&state, page_entries, &actor, imported_at_ms).await?;
        items_created += page_created;
        attributions_added += page_attributions;
        let total = data
            .get("total")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize;
        offset = offset.saturating_add(returned);
        if returned == 0 || offset >= total {
            break;
        }
    }

    offset = 0;
    loop {
        let url = format!("https://api.spotify.com/v1/me/playlists?offset={offset}&limit=50");
        let data = spotify_json_request(&state, reqwest::Method::GET, &url, None).await?;
        let items = data
            .get("items")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let returned = items.len();
        playlists_seen += returned;
        let mut page_entries = Vec::new();
        for value in items {
            match normalize_playlist(&value) {
                Ok(summary) => page_entries.push((
                    FavoriteKind::Playlist,
                    summary,
                    "spotify_playlists".to_string(),
                )),
                Err(_) => skipped += 1,
            }
        }
        let (page_created, page_attributions) =
            persist_import_page(&state, page_entries, &actor, imported_at_ms).await?;
        items_created += page_created;
        attributions_added += page_attributions;
        let total = data
            .get("total")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize;
        offset = offset.saturating_add(returned);
        if returned == 0 || offset >= total {
            break;
        }
    }

    Ok(Json(FavoriteImportResponse {
        ok: true,
        tracks_seen,
        playlists_seen,
        items_created,
        attributions_added,
        skipped,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID_A: &str = "0VjIjW4GlUZAMYd2vXMi3b";
    const ID_B: &str = "3n3Ppam7vgaVa1iaRUc9Lp";
    const ID_C: &str = "7ouMYWpwJ422jRcDASZB7P";

    fn temp_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("echo-{label}-{}", crate::config::random_secret()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn actor(id: &str, name: &str) -> JamActor {
        JamActor {
            actor_id: id.to_string(),
            display_name: name.to_string(),
        }
    }

    fn summary(id: &str, name: &str) -> FavoriteSummary {
        FavoriteSummary {
            spotify_id: id.to_string(),
            spotify_uri: format!("spotify:track:{id}"),
            spotify_url: format!("https://open.spotify.com/track/{id}"),
            name: name.to_string(),
            artist: Some("Artist".to_string()),
            artwork_url: Some("https://image.example/art.jpg".to_string()),
            duration_ms: Some(123),
            explicit: Some(false),
            ..FavoriteSummary::default()
        }
    }

    fn track_json(id: &str, name: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "track",
            "id": id,
            "uri": format!("spotify:track:{id}"),
            "name": name,
            "artists": [{"name":"One"}, {"name":"Two"}],
            "album": {"images":[{"url":"https://image.example/a.jpg"}]},
            "duration_ms": 321,
            "explicit": true,
            "is_playable": true,
            "is_local": false,
        })
    }

    #[test]
    fn spotify_ids_are_exact_base62_identifiers() {
        assert!(valid_spotify_id(ID_A));
        assert!(!valid_spotify_id("short"));
        assert!(!valid_spotify_id("0VjIjW4GlUZAMYd2vXMi3!"));
        assert!(!valid_spotify_id("0VjIjW4GlUZAMYd2vXMi3bb"));
    }

    #[test]
    fn playlist_and_track_normalization_use_canonical_fields() {
        let track = normalize_track(&track_json(ID_A, "Song")).unwrap();
        assert_eq!(
            track.spotify_url,
            format!("https://open.spotify.com/track/{ID_A}")
        );
        assert_eq!(track.artist.as_deref(), Some("One, Two"));
        assert_eq!(track.duration_ms, Some(321));
        assert_eq!(track.explicit, Some(true));

        let playlist = normalize_playlist(&serde_json::json!({
            "type":"playlist",
            "id":ID_B,
            "uri":format!("spotify:playlist:{ID_B}"),
            "name":"Mix",
            "owner":{"display_name":"Sam"},
            "description":"Description",
            "images":[{"url":"https://image.example/p.jpg"}],
            "items":{"total":42},
            "tracks":{"total":99},
            "snapshot_id":"snapshot",
        }))
        .unwrap();
        assert_eq!(playlist.track_count, Some(42));
        assert_eq!(playlist.owner.as_deref(), Some("Sam"));
        assert_eq!(
            playlist.spotify_url,
            format!("https://open.spotify.com/playlist/{ID_B}")
        );
    }

    #[test]
    fn playlist_page_preserves_order_and_duplicates_while_reporting_skips() {
        let mut unavailable = track_json(ID_B, "Unavailable");
        unavailable["is_playable"] = serde_json::Value::Bool(false);
        let data = serde_json::json!({
            "total": 5,
            "items": [
                {"track": track_json(ID_A, "First")},
                {"track": unavailable},
                {"is_local":true,"track":track_json(ID_C,"Local")},
                {"track": track_json(ID_A, "Duplicate")},
                {"track": null}
            ]
        });
        let (tracks, skipped, total) = normalize_playlist_items_page(&data, 10);
        assert_eq!(total, 5);
        assert_eq!(
            tracks
                .iter()
                .map(|(position, _)| *position)
                .collect::<Vec<_>>(),
            vec![10, 13]
        );
        assert_eq!(tracks[0].1.spotify_id, ID_A);
        assert_eq!(tracks[1].1.spotify_id, ID_A);
        assert_eq!(
            skipped
                .iter()
                .map(|item| (item.position, item.reason.as_str()))
                .collect::<Vec<_>>(),
            vec![(11, "unplayable"), (12, "local_track"), (14, "malformed")]
        );
    }

    #[test]
    fn favorite_mutations_are_idempotent_multi_contributor_and_name_refreshing() {
        let dir = temp_dir("favorites");
        let path = dir.join("favorites-v1.json");
        let store = FavoriteStore::open(path).unwrap();
        let sam = actor("ea1_sam", "Sam");
        let renamed = actor("ea1_sam", "Samuel");
        let alex = actor("ea1_alex", "Alex");

        let (_, first) = store
            .upsert(FavoriteKind::Track, summary(ID_A, "Song"), &sam, "echo", 10)
            .unwrap();
        let (_, repeat) = store
            .upsert(
                FavoriteKind::Track,
                summary(ID_A, "Song"),
                &renamed,
                "echo",
                20,
            )
            .unwrap();
        store
            .upsert(
                FavoriteKind::Track,
                summary(ID_A, "Song"),
                &alex,
                "echo",
                30,
            )
            .unwrap();
        assert_eq!(
            first,
            FavoriteMutation {
                item_created: true,
                attribution_added: true
            }
        );
        assert_eq!(
            repeat,
            FavoriteMutation {
                item_created: false,
                attribution_added: false
            }
        );
        let snapshot = store.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].attributions.len(), 2);
        assert_eq!(snapshot[0].attributions[0].display_name, "Samuel");
        assert!(store
            .remove_actor(FavoriteKind::Track, ID_A, "ea1_sam")
            .unwrap());
        assert_eq!(store.snapshot()[0].attributions[0].actor_id, "ea1_alex");
        assert!(store
            .remove_actor(FavoriteKind::Track, ID_A, "ea1_alex")
            .unwrap());
        assert!(store.snapshot().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn loaded_favorite_attribution_names_are_bounded() {
        let data = FavoriteFile {
            schema_version: FAVORITES_SCHEMA_VERSION,
            items: vec![FavoriteItem {
                kind: FavoriteKind::Track,
                summary: summary(ID_A, "Song"),
                attributions: vec![FavoriteAttribution {
                    actor_id: "ea1_sam".to_string(),
                    display_name: format!("  {}  ", "x".repeat(256)),
                    added_at_ms: 10,
                    source: "echo".to_string(),
                }],
            }],
        };

        let loaded = validate_favorite_file(data).unwrap();
        let name = &loaded.items[0].attributions[0].display_name;
        assert_eq!(
            name.chars().count(),
            crate::auth::MAX_JAM_ACTOR_DISPLAY_NAME_CHARS
        );
        assert!(!name.starts_with(' '));
        assert!(!name.ends_with(' '));
    }

    #[test]
    fn playlist_favorites_never_persist_expiring_artwork_urls() {
        let dir = temp_dir("playlist-art");
        let path = dir.join("favorites-v1.json");
        let store = FavoriteStore::open(path.clone()).unwrap();
        let mut playlist = summary(ID_B, "Mix");
        playlist.spotify_uri = format!("spotify:playlist:{ID_B}");
        playlist.spotify_url = format!("https://open.spotify.com/playlist/{ID_B}");
        store
            .upsert(
                FavoriteKind::Playlist,
                playlist,
                &actor("ea1_sam", "Sam"),
                "echo",
                10,
            )
            .unwrap();
        assert!(store.snapshot()[0].summary.artwork_url.is_none());
        let persisted = fs::read_to_string(path).unwrap();
        assert!(!persisted.contains("image.example"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_persistence_does_not_mutate_memory() {
        let dir = temp_dir("favorites-rollback");
        let blocker = dir.join("not-a-directory");
        fs::write(&blocker, b"block").unwrap();
        let store = FavoriteStore::empty(blocker.join("favorites-v1.json"));
        let error = store
            .upsert(
                FavoriteKind::Track,
                summary(ID_A, "Song"),
                &actor("ea1_sam", "Sam"),
                "echo",
                10,
            )
            .unwrap_err();
        assert!(matches!(
            error.kind(),
            io::ErrorKind::AlreadyExists | io::ErrorKind::NotADirectory
        ));
        assert!(store.snapshot().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_primary_recovers_the_valid_atomic_backup() {
        let dir = temp_dir("favorites-recovery");
        let path = dir.join("favorites-v1.json");
        let store = FavoriteStore::open(path.clone()).unwrap();
        store
            .upsert(
                FavoriteKind::Track,
                summary(ID_A, "Song"),
                &actor("ea1_sam", "Sam"),
                "echo",
                10,
            )
            .unwrap();
        drop(store);
        let backup = favorite_backup_path(&path);
        fs::rename(&path, &backup).unwrap();

        let recovered = FavoriteStore::open(path.clone()).unwrap();
        assert_eq!(recovered.snapshot().len(), 1);
        assert!(path.exists());
        assert!(!backup.exists());
        recovered
            .upsert(
                FavoriteKind::Track,
                summary(ID_B, "Second"),
                &actor("ea1_sam", "Sam"),
                "echo",
                20,
            )
            .unwrap();
        assert_eq!(recovered.snapshot().len(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_primary_uses_backup_read_only_without_overwriting_user_data() {
        let dir = temp_dir("favorites-read-only");
        let path = dir.join("favorites-v1.json");
        let store = FavoriteStore::open(path.clone()).unwrap();
        let sam = actor("ea1_sam", "Sam");
        store
            .upsert(
                FavoriteKind::Track,
                summary(ID_A, "First"),
                &sam,
                "echo",
                10,
            )
            .unwrap();
        store
            .upsert(
                FavoriteKind::Track,
                summary(ID_B, "Second"),
                &sam,
                "echo",
                20,
            )
            .unwrap();
        drop(store);
        assert!(favorite_backup_path(&path).exists());
        fs::write(&path, b"{broken").unwrap();
        assert!(FavoriteStore::open(path.clone()).is_err());
        let recovered = FavoriteStore::recover_read_only(path.clone());
        assert_eq!(recovered.snapshot().len(), 1);
        let error = recovered
            .upsert(
                FavoriteKind::Track,
                summary(ID_C, "Third"),
                &sam,
                "echo",
                30,
            )
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn paging_validation_enforces_spotify_bounds() {
        assert!(validate_search_page(1_000, 10).is_ok());
        assert!(validate_search_page(1_001, 10).is_err());
        assert!(validate_search_page(0, 11).is_err());
        assert!(validate_playlist_items_page(0, 50).is_ok());
        assert!(validate_playlist_items_page(0, 51).is_err());
    }

    #[test]
    fn playlist_item_forbidden_error_explains_spotify_app_mode() {
        let mapped = map_playlist_items_error(JamApiError {
            status: StatusCode::FORBIDDEN,
            code: "spotify_forbidden",
            message: "Forbidden".to_string(),
            retry_after: Some("12".to_string()),
        });
        assert_eq!(mapped.status, StatusCode::FORBIDDEN);
        assert_eq!(mapped.code, "playlist_items_forbidden");
        assert!(mapped.message.contains("owns or collaborates"));
        assert_eq!(mapped.retry_after.as_deref(), Some("12"));
    }

    #[test]
    fn rate_limit_errors_preserve_status_and_retry_after_header() {
        let response = JamApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "spotify_rate_limited",
            message: "Slow down".to_string(),
            retry_after: Some("17".to_string()),
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("17")
        );
    }
}
