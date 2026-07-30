use crate::auth::{bounded_jam_actor_display_name, ensure_admin, ensure_jam_actor, JamActor};
use crate::config::{now_ts_ms, urlencoded};
use crate::jam_playlist_cache::PLAYLIST_ITEMS_CACHE_CHUNK_SIZE;
use crate::jam_session::{
    remember_spotify_rate_limit_seconds, spotify_api_request, spotify_library_scope_required_error,
    spotify_library_scopes_authorized, spotify_rate_limit_error, spotify_retry_after_seconds,
};
use crate::spotify_public_catalog::{
    fetch_public_playlist_chunk, PublicCatalogError, PublicPlaylistPositionOutcome,
};
use crate::AppState;

use axum::extract::{Json, Path, Query, State};
use axum::http::{header::RETRY_AFTER, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{stream, StreamExt};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::{self, Write};
use std::path::{Path as FsPath, PathBuf};
use std::str::FromStr;
use std::sync::{
    atomic::{AtomicU64, Ordering as AtomicOrdering},
    Mutex,
};
use std::time::Duration;
use tracing::warn;

pub(crate) const FAVORITES_SCHEMA_VERSION: u16 = 1;
pub(crate) const CATALOG_SCHEMA_VERSION: u16 = 1;
const MAX_SEARCH_LIMIT: usize = 10;
const MAX_PLAYLIST_ITEMS_LIMIT: usize = 50;
const SPOTIFY_PLAYLIST_ITEMS_LIMIT: usize = 50;
const MAX_PLAYLIST_ITEMS_OFFSET: usize = 100_000;
pub(crate) const MAX_PLAYLIST_QUEUE_TRACKS: usize = 1_000;
const MAX_CATALOG_OFFSET: usize = 1_000;
const MAX_FAVORITES_LIMIT: usize = 200;
const PLAYLIST_ARTWORK_CACHE_MAX_ENTRIES: usize = 512;
const PLAYLIST_ARTWORK_CACHE_TTL_MS: u64 = 60 * 60 * 1_000;
const PLAYLIST_ARTWORK_NEGATIVE_TTL_MS: u64 = 5 * 60 * 1_000;
const PLAYLIST_ARTWORK_REFRESH_CONCURRENCY: usize = 4;
const PLAYLIST_ARTWORK_REFRESH_MAX_IDS: usize = 50;
const PLAYLIST_ARTWORK_REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

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
    playlist_artwork: Mutex<HashMap<String, PlaylistArtworkCacheEntry>>,
    playlist_artwork_generation: AtomicU64,
    playlist_artwork_refresh: tokio::sync::Mutex<()>,
}

#[derive(Clone, Debug, PartialEq)]
struct PlaylistArtworkCacheEntry {
    artwork_url: Option<String>,
    expires_at_ms: u64,
    last_accessed_at_ms: u64,
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
            playlist_artwork: Mutex::new(HashMap::new()),
            playlist_artwork_generation: AtomicU64::new(0),
            playlist_artwork_refresh: tokio::sync::Mutex::new(()),
        })
    }

    #[cfg(test)]
    pub(crate) fn empty(path: PathBuf) -> Self {
        Self {
            path,
            writable: true,
            inner: Mutex::new(FavoriteFile::default()),
            playlist_artwork: Mutex::new(HashMap::new()),
            playlist_artwork_generation: AtomicU64::new(0),
            playlist_artwork_refresh: tokio::sync::Mutex::new(()),
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
            playlist_artwork: Mutex::new(HashMap::new()),
            playlist_artwork_generation: AtomicU64::new(0),
            playlist_artwork_refresh: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) fn disabled(path: PathBuf) -> Self {
        Self {
            path,
            writable: false,
            inner: Mutex::new(FavoriteFile::default()),
            playlist_artwork: Mutex::new(HashMap::new()),
            playlist_artwork_generation: AtomicU64::new(0),
            playlist_artwork_refresh: tokio::sync::Mutex::new(()),
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

    fn remember_playlist_artwork(&self, spotify_id: &str, artwork_url: Option<&str>, now_ms: u64) {
        let generation = self.playlist_artwork_generation();
        self.remember_playlist_artwork_if_generation(spotify_id, artwork_url, now_ms, generation);
    }

    fn remember_playlist_artwork_if_generation(
        &self,
        spotify_id: &str,
        artwork_url: Option<&str>,
        now_ms: u64,
        expected_generation: u64,
    ) {
        if !valid_spotify_id(spotify_id) {
            return;
        }
        if self.playlist_artwork_generation() != expected_generation {
            return;
        }
        let artwork_url = artwork_url.and_then(safe_spotify_playlist_artwork_url);
        let ttl_ms = if artwork_url.is_some() {
            PLAYLIST_ARTWORK_CACHE_TTL_MS
        } else {
            PLAYLIST_ARTWORK_NEGATIVE_TTL_MS
        };
        let mut cache = self
            .playlist_artwork
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.playlist_artwork_generation() != expected_generation {
            return;
        }
        if !cache.contains_key(spotify_id) && cache.len() >= PLAYLIST_ARTWORK_CACHE_MAX_ENTRIES {
            if let Some(oldest_id) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.last_accessed_at_ms)
                .map(|(id, _)| id.clone())
            {
                cache.remove(&oldest_id);
            }
        }
        cache.insert(
            spotify_id.to_string(),
            PlaylistArtworkCacheEntry {
                artwork_url,
                expires_at_ms: now_ms.saturating_add(ttl_ms),
                last_accessed_at_ms: now_ms,
            },
        );
    }

    fn playlist_artwork_generation(&self) -> u64 {
        self.playlist_artwork_generation
            .load(AtomicOrdering::SeqCst)
    }

    fn cached_playlist_artwork(&self, spotify_id: &str, now_ms: u64) -> Option<Option<String>> {
        let mut cache = self
            .playlist_artwork
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if cache
            .get(spotify_id)
            .is_some_and(|entry| entry.expires_at_ms <= now_ms)
        {
            cache.remove(spotify_id);
            return None;
        }
        let entry = cache.get_mut(spotify_id)?;
        entry.last_accessed_at_ms = now_ms;
        Some(entry.artwork_url.clone())
    }

    fn apply_cached_playlist_artwork(
        &self,
        views: &mut [FavoriteView],
        now_ms: u64,
    ) -> Vec<String> {
        let mut missing = Vec::new();
        let mut seen = HashSet::new();
        for view in views {
            if view.kind != FavoriteKind::Playlist {
                continue;
            }
            match self.cached_playlist_artwork(&view.summary.spotify_id, now_ms) {
                Some(artwork_url) => view.summary.artwork_url = artwork_url,
                None if seen.insert(view.summary.spotify_id.clone()) => {
                    missing.push(view.summary.spotify_id.clone());
                }
                None => {}
            }
        }
        missing
    }

    pub(crate) fn clear_playlist_artwork_cache(&self) {
        self.playlist_artwork_generation
            .fetch_add(1, AtomicOrdering::SeqCst);
        self.playlist_artwork
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    pub(crate) fn upsert(
        &self,
        kind: FavoriteKind,
        summary: FavoriteSummary,
        actor: &JamActor,
        source: &str,
        added_at_ms: u64,
    ) -> io::Result<(FavoriteItem, FavoriteMutation)> {
        let playlist_artwork = (kind == FavoriteKind::Playlist)
            .then(|| (summary.spotify_id.clone(), summary.artwork_url.clone()));
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
        drop(data);
        if let Some((spotify_id, artwork_url)) = playlist_artwork {
            self.remember_playlist_artwork(&spotify_id, artwork_url.as_deref(), now_ts_ms());
        }
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
        let mut playlist_artwork = Vec::new();
        let mut indices = candidate
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| ((item.kind, item.summary.spotify_id.clone()), index))
            .collect::<HashMap<_, _>>();
        for (kind, summary, source) in entries {
            if kind == FavoriteKind::Playlist {
                playlist_artwork.push((summary.spotify_id.clone(), summary.artwork_url.clone()));
            }
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
        drop(data);
        let now_ms = now_ts_ms();
        for (spotify_id, artwork_url) in playlist_artwork {
            self.remember_playlist_artwork(&spotify_id, artwork_url.as_deref(), now_ms);
        }
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

fn safe_spotify_playlist_artwork_url(value: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(value.trim()).ok()?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let spotify_cdn = host == "scdn.co"
        || host.ends_with(".scdn.co")
        || host == "spotifycdn.com"
        || host.ends_with(".spotifycdn.com");
    spotify_cdn.then(|| parsed.to_string())
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

fn playlist_artwork_from_images_response(value: &serde_json::Value) -> Option<String> {
    value
        .as_array()
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
    if offset > MAX_PLAYLIST_ITEMS_OFFSET {
        return Err(JamApiError::bad_request("offset is too large"));
    }
    Ok(())
}

pub(crate) fn validate_selected_playlist_positions(
    positions: &[usize],
) -> Result<Vec<usize>, JamApiError> {
    if positions.is_empty() {
        return Err(JamApiError::bad_request(
            "selected_positions must contain at least one playlist position",
        ));
    }
    if positions.len() > MAX_PLAYLIST_QUEUE_TRACKS {
        return Err(playlist_batch_too_large_error(positions.len()));
    }
    if positions
        .iter()
        .any(|position| *position > MAX_PLAYLIST_ITEMS_OFFSET)
    {
        return Err(JamApiError::bad_request(format!(
            "selected playlist positions must be at most {MAX_PLAYLIST_ITEMS_OFFSET}"
        )));
    }
    let mut canonical = positions.to_vec();
    canonical.sort_unstable();
    if canonical.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(JamApiError::bad_request(
            "selected_positions must not contain duplicate positions",
        ));
    }
    Ok(canonical)
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
    state.jam_favorites.remember_playlist_artwork(
        &summary.spotify_id,
        summary.artwork_url.as_deref(),
        now_ts_ms(),
    );
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
    pub(crate) items_source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) local_cache: Option<PlaylistItemsCacheView>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PlaylistItemsCacheView {
    pub(crate) chunk_size: usize,
    pub(crate) cached_count: usize,
    pub(crate) cached_chunk_offsets: Vec<usize>,
    pub(crate) next_missing_chunk_offset: Option<usize>,
    pub(crate) total: u64,
    pub(crate) complete: bool,
    pub(crate) position_limit: usize,
    pub(crate) truncated: bool,
    pub(crate) updated_at_ms: u64,
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
    let summary = normalize_playlist(&data).map_err(|reason| JamApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "spotify_invalid_playlist",
        message: format!("Spotify playlist was malformed: {reason}"),
        retry_after: None,
    })?;
    state.jam_favorites.remember_playlist_artwork(
        &summary.spotify_id,
        summary.artwork_url.as_deref(),
        now_ts_ms(),
    );
    Ok(summary)
}

async fn fetch_playlist_artwork_url(
    state: &AppState,
    playlist_id: &str,
) -> Result<Option<String>, JamApiError> {
    if !valid_spotify_id(playlist_id) {
        return Err(JamApiError::bad_request("invalid Spotify playlist ID"));
    }
    let url = format!("https://api.spotify.com/v1/playlists/{playlist_id}/images");
    let data = spotify_json_request(state, reqwest::Method::GET, &url, None).await?;
    Ok(playlist_artwork_from_images_response(&data))
}

async fn fetch_spotify_playlist_items_page(
    state: &AppState,
    playlist_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>, u64), JamApiError> {
    if !(1..=SPOTIFY_PLAYLIST_ITEMS_LIMIT).contains(&limit) {
        return Err(JamApiError::bad_request(format!(
            "Spotify playlist item limit must be between 1 and {SPOTIFY_PLAYLIST_ITEMS_LIMIT}"
        )));
    }
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

async fn fetch_official_playlist_items_window(
    state: &AppState,
    playlist: &FavoriteSummary,
    offset: usize,
    limit: usize,
) -> Result<(Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>, u64), JamApiError> {
    validate_playlist_items_page(offset, limit)?;
    let playlist_id = &playlist.spotify_id;
    let mut tracks = Vec::new();
    let mut skipped = Vec::new();
    let mut observed_total = None;
    let requested_end = offset.saturating_add(limit);
    let mut page_offset = offset;

    while page_offset < requested_end {
        let page_limit = (requested_end - page_offset).min(SPOTIFY_PLAYLIST_ITEMS_LIMIT);
        let (page_tracks, page_skipped, total) =
            fetch_spotify_playlist_items_page(state, playlist_id, page_offset, page_limit).await?;
        if observed_total.is_some_and(|expected| expected != total) {
            return Err(playlist_changed_error());
        }
        observed_total = Some(total);
        let returned = page_tracks.len() + page_skipped.len();
        tracks.extend(page_tracks);
        skipped.extend(page_skipped);
        if returned < page_limit || page_offset.saturating_add(returned) >= total as usize {
            break;
        }
        page_offset = page_offset
            .checked_add(returned)
            .ok_or_else(playlist_changed_error)?;
    }

    Ok((tracks, skipped, observed_total.unwrap_or(0)))
}

fn public_catalog_error(error: PublicCatalogError) -> JamApiError {
    let retry_after = error.retry_after_seconds.map(|seconds| seconds.to_string());
    if error.code == "spotify_rate_limited" {
        return JamApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "spotify_rate_limited",
            message: error.message,
            retry_after,
        };
    }
    let status = match error.code {
        "invalid_spotify_playlist_id" | "invalid_spotify_playlist_offset" => {
            StatusCode::BAD_REQUEST
        }
        "spotify_public_playlist_not_found" => StatusCode::NOT_FOUND,
        "spotify_public_playlist_unavailable" => StatusCode::FORBIDDEN,
        _ => StatusCode::BAD_GATEWAY,
    };
    JamApiError {
        status,
        code: "playlist_catalog_unavailable",
        message: error.message,
        retry_after,
    }
}

fn cached_playlist_window(
    state: &AppState,
    playlist: &FavoriteSummary,
    offset: usize,
    limit: usize,
) -> Option<(Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>, u64)> {
    let snapshot_id = playlist.snapshot_id.as_deref()?;
    state
        .jam_playlist_cache
        .window(&playlist.spotify_id, snapshot_id, offset, limit)
        .map(|window| {
            debug_assert_eq!(window.playlist_id, playlist.spotify_id);
            debug_assert_eq!(window.snapshot_id, snapshot_id);
            debug_assert_eq!(window.offset, offset);
            debug_assert_eq!(window.limit, limit);
            let _ = (window.next_offset, window.complete, window.fetched_at_ms);
            (window.tracks, window.skipped, window.total)
        })
}

async fn fetch_public_playlist_items_window(
    state: &AppState,
    playlist: &FavoriteSummary,
    offset: usize,
    limit: usize,
) -> Result<(Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>, u64), JamApiError> {
    validate_public_playlist_items_window(offset, limit)?;
    let snapshot_id = playlist.snapshot_id.as_deref().ok_or_else(|| JamApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "playlist_catalog_unavailable",
        message:
            "Spotify did not provide a playlist revision, so Echo cannot safely cache its songs"
                .to_string(),
        retry_after: None,
    })?;
    if let Some(window) = cached_playlist_window(state, playlist, offset, limit) {
        return Ok(window);
    }

    let requested_end = offset.saturating_add(limit);
    let mut chunk_offset =
        offset / PLAYLIST_ITEMS_CACHE_CHUNK_SIZE * PLAYLIST_ITEMS_CACHE_CHUNK_SIZE;
    while chunk_offset < requested_end {
        if let Some(coverage) = state
            .jam_playlist_cache
            .coverage(&playlist.spotify_id, snapshot_id)
        {
            if chunk_offset >= coverage.total as usize {
                return Ok((Vec::new(), Vec::new(), coverage.total));
            }
        }
        if !state
            .jam_playlist_cache
            .has_chunk(&playlist.spotify_id, snapshot_id, chunk_offset)
        {
            // Only one bounded catalog chunk may be acquired at a time. Recheck
            // after acquiring the gate so concurrent viewers never fetch the
            // same 50-position chunk twice.
            let _refresh = state.jam_playlist_cache_refresh.lock().await;
            if !state
                .jam_playlist_cache
                .has_chunk(&playlist.spotify_id, snapshot_id, chunk_offset)
            {
                if let Some((status, message)) = spotify_rate_limit_error(state) {
                    return Err(JamApiError {
                        status,
                        code: "spotify_rate_limited",
                        message,
                        retry_after: spotify_retry_after_seconds(state),
                    });
                }
                let _permit =
                    state
                        .spotify_request_limit
                        .acquire()
                        .await
                        .map_err(|_| JamApiError {
                            status: StatusCode::SERVICE_UNAVAILABLE,
                            code: "playlist_catalog_unavailable",
                            message: "Spotify request gate is unavailable".to_string(),
                            retry_after: None,
                        })?;
                let chunk = match fetch_public_playlist_chunk(
                    &state.http_client,
                    &playlist.spotify_id,
                    chunk_offset,
                )
                .await
                {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        if error.code == "spotify_rate_limited" {
                            if let Some(seconds) = error.retry_after_seconds {
                                remember_spotify_rate_limit_seconds(state, seconds);
                            }
                        }
                        return Err(public_catalog_error(error));
                    }
                };
                drop(_permit);
                debug_assert_eq!(
                    chunk.truncated_at_position_limit,
                    chunk.total_count
                        > crate::jam_playlist_cache::MAX_PLAYLIST_ITEMS_CACHE_TOTAL as u64
                );
                verify_playlist_still_matches_snapshot(
                    state,
                    &playlist.spotify_id,
                    Some(snapshot_id),
                )
                .await?;
                verify_public_playlist_total(playlist, chunk.total_count)?;
                if chunk.total_count as usize <= chunk_offset && chunk.positions.is_empty() {
                    return Ok((Vec::new(), Vec::new(), chunk.total_count));
                }
                let mut tracks = Vec::new();
                let mut skipped = Vec::new();
                for position in chunk.positions {
                    match position.outcome {
                        PublicPlaylistPositionOutcome::Track { summary } => {
                            tracks.push((position.position, summary));
                        }
                        PublicPlaylistPositionOutcome::Skipped { reason } => {
                            skipped.push(SkippedPlaylistItem {
                                position: position.position,
                                reason,
                            });
                        }
                    }
                }
                state
                    .jam_playlist_cache
                    .merge_chunk(
                        playlist,
                        chunk.offset,
                        chunk.total_count,
                        tracks,
                        skipped,
                        now_ts_ms(),
                    )
                    .map_err(|error| {
                        JamApiError::internal(format!(
                            "Could not persist the private playlist cache: {error}"
                        ))
                    })?;
            }
        }
        chunk_offset = chunk_offset.saturating_add(PLAYLIST_ITEMS_CACHE_CHUNK_SIZE);
    }

    cached_playlist_window(state, playlist, offset, limit).ok_or_else(|| JamApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "playlist_catalog_unavailable",
        message: "Echo could not assemble the requested 50-song playlist chunk".to_string(),
        retry_after: None,
    })
}

fn validate_public_playlist_items_window(offset: usize, limit: usize) -> Result<(), JamApiError> {
    if offset % PLAYLIST_ITEMS_CACHE_CHUNK_SIZE == 0
        && limit == PLAYLIST_ITEMS_CACHE_CHUNK_SIZE
        && offset < crate::jam_playlist_cache::MAX_PLAYLIST_ITEMS_CACHE_TOTAL
    {
        Ok(())
    } else {
        Err(JamApiError::bad_request(
            "restricted public playlists must be loaded in one aligned 50-song chunk within Echo's 1,000-position browse limit",
        ))
    }
}

fn playlist_items_next_offset(items_source: &str, total: u64, consumed: usize) -> Option<usize> {
    let available = if items_source == "local_cache" {
        total.min(crate::jam_playlist_cache::MAX_PLAYLIST_ITEMS_CACHE_TOTAL as u64)
    } else {
        total
    };
    let available = usize::try_from(available).unwrap_or(usize::MAX);
    (consumed < available).then_some(consumed)
}

async fn fetch_playlist_items_page_with_source(
    state: &AppState,
    playlist: &FavoriteSummary,
    offset: usize,
    limit: usize,
) -> Result<
    (
        Vec<(usize, FavoriteSummary)>,
        Vec<SkippedPlaylistItem>,
        u64,
        &'static str,
    ),
    JamApiError,
> {
    validate_playlist_items_page(offset, limit)?;
    if let Some((tracks, skipped, total)) = cached_playlist_window(state, playlist, offset, limit) {
        return Ok((tracks, skipped, total, "local_cache"));
    }
    match fetch_official_playlist_items_window(state, playlist, offset, limit).await {
        Ok((tracks, skipped, total)) => Ok((tracks, skipped, total, "spotify")),
        Err(error) if error.code == "playlist_items_forbidden" => {
            let (tracks, skipped, total) =
                fetch_public_playlist_items_window(state, playlist, offset, limit).await?;
            Ok((tracks, skipped, total, "local_cache"))
        }
        Err(error) => Err(error),
    }
}

async fn fetch_playlist_items_page(
    state: &AppState,
    playlist: &FavoriteSummary,
    offset: usize,
    limit: usize,
) -> Result<(Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>, u64), JamApiError> {
    let (tracks, skipped, total, _) =
        fetch_playlist_items_page_with_source(state, playlist, offset, limit).await?;
    Ok((tracks, skipped, total))
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
    let (tracks, skipped, total, items_source) =
        fetch_playlist_items_page_with_source(&state, &summary, query.offset, query.limit).await?;
    let local_cache = (items_source == "local_cache")
        .then(|| {
            summary.snapshot_id.as_deref().and_then(|snapshot_id| {
                state
                    .jam_playlist_cache
                    .coverage(&summary.spotify_id, snapshot_id)
            })
        })
        .flatten()
        .map(|coverage| PlaylistItemsCacheView {
            chunk_size: PLAYLIST_ITEMS_CACHE_CHUNK_SIZE,
            cached_count: coverage.cached_count,
            cached_chunk_offsets: coverage.cached_chunk_offsets,
            next_missing_chunk_offset: coverage.next_missing_chunk_offset,
            total: coverage.total,
            complete: coverage.complete,
            position_limit: crate::jam_playlist_cache::MAX_PLAYLIST_ITEMS_CACHE_TOTAL,
            truncated: coverage.total
                > crate::jam_playlist_cache::MAX_PLAYLIST_ITEMS_CACHE_TOTAL as u64,
            updated_at_ms: coverage.updated_at_ms,
        });
    let items = tracks
        .into_iter()
        .map(|(position, summary)| favorite_track(&state, &actor.actor_id, summary, Some(position)))
        .collect();
    let consumed = query.offset.saturating_add(query.limit);
    let next_offset = playlist_items_next_offset(items_source, total, consumed);
    Ok(Json(PlaylistItemsPage {
        schema_version: CATALOG_SCHEMA_VERSION,
        playlist: favorite_playlist(&state, &actor.actor_id, summary),
        items,
        skipped,
        offset: query.offset,
        limit: query.limit,
        total,
        next_offset,
        items_source,
        local_cache,
    }))
}

#[derive(Clone, Debug)]
pub(crate) struct PlaylistExpansion {
    pub(crate) playlist: FavoriteSummary,
    pub(crate) tracks: Vec<(usize, FavoriteSummary)>,
    pub(crate) skipped: Vec<SkippedPlaylistItem>,
}

fn playlist_changed_error() -> JamApiError {
    JamApiError {
        status: StatusCode::CONFLICT,
        code: "playlist_changed",
        message: "The Spotify playlist changed after it was opened; reload it before queueing"
            .to_string(),
        retry_after: None,
    }
}

fn verify_public_playlist_total(
    playlist: &FavoriteSummary,
    public_total: u64,
) -> Result<(), JamApiError> {
    if playlist
        .track_count
        .is_some_and(|expected| expected != public_total)
    {
        Err(playlist_changed_error())
    } else {
        Ok(())
    }
}

fn playlist_batch_too_large_error(item_count: usize) -> JamApiError {
    JamApiError {
        status: StatusCode::PAYLOAD_TOO_LARGE,
        code: "playlist_batch_too_large",
        message: format!(
            "This playlist operation contains {item_count} items; Echo supports at most {MAX_PLAYLIST_QUEUE_TRACKS} at once. Open the playlist and select a smaller group."
        ),
        retry_after: None,
    }
}

fn verify_playlist_snapshot(
    playlist: &FavoriteSummary,
    expected_snapshot_id: Option<&str>,
) -> Result<(), JamApiError> {
    if expected_snapshot_id.is_some() && playlist.snapshot_id.as_deref() != expected_snapshot_id {
        return Err(playlist_changed_error());
    }
    Ok(())
}

async fn verify_playlist_still_matches_snapshot(
    state: &AppState,
    playlist_id: &str,
    expected_snapshot_id: Option<&str>,
) -> Result<(), JamApiError> {
    let Some(expected_snapshot_id) = expected_snapshot_id else {
        return Ok(());
    };
    let latest = fetch_playlist_summary(state, playlist_id).await?;
    verify_playlist_snapshot(&latest, Some(expected_snapshot_id))
}

pub(crate) async fn fetch_playlist_expansion(
    state: &AppState,
    playlist_id: &str,
    expected_snapshot_id: Option<&str>,
) -> Result<PlaylistExpansion, JamApiError> {
    let playlist = fetch_playlist_summary(state, playlist_id).await?;
    verify_playlist_snapshot(&playlist, expected_snapshot_id)?;
    let consistency_snapshot = expected_snapshot_id.or(playlist.snapshot_id.as_deref());
    let (tracks, skipped) = collect_playlist_item_pages(|offset| {
        fetch_playlist_items_page(state, &playlist, offset, MAX_PLAYLIST_ITEMS_LIMIT)
    })
    .await?;
    verify_playlist_still_matches_snapshot(state, playlist_id, consistency_snapshot).await?;
    Ok(PlaylistExpansion {
        playlist,
        tracks,
        skipped,
    })
}

async fn collect_playlist_item_pages<F, Fut>(
    mut fetch_page: F,
) -> Result<(Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>), JamApiError>
where
    F: FnMut(usize) -> Fut,
    Fut: Future<
        Output = Result<
            (Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>, u64),
            JamApiError,
        >,
    >,
{
    let mut offset = 0usize;
    let mut expected_total = None;
    let mut tracks = Vec::new();
    let mut skipped = Vec::new();
    loop {
        let (page_tracks, page_skipped, page_total) = fetch_page(offset).await?;
        if expected_total.is_some_and(|total| total != page_total) {
            return Err(playlist_changed_error());
        }
        expected_total = Some(page_total);
        let page_total = usize::try_from(page_total).map_err(|_| playlist_changed_error())?;
        if page_total > MAX_PLAYLIST_QUEUE_TRACKS {
            return Err(playlist_batch_too_large_error(page_total));
        }
        let returned = page_tracks.len() + page_skipped.len();
        if returned == 0 {
            if offset < page_total {
                return Err(playlist_changed_error());
            }
            break;
        }
        let next_offset = offset
            .checked_add(returned)
            .filter(|next| *next <= page_total)
            .ok_or_else(playlist_changed_error)?;
        tracks.extend(page_tracks);
        skipped.extend(page_skipped);
        offset = next_offset;
        if offset == page_total {
            break;
        }
    }
    Ok((tracks, skipped))
}

fn selected_playlist_page_offsets(positions: &[usize]) -> Vec<usize> {
    let mut offsets = positions
        .iter()
        .map(|position| position / MAX_PLAYLIST_ITEMS_LIMIT * MAX_PLAYLIST_ITEMS_LIMIT)
        .collect::<Vec<_>>();
    offsets.dedup();
    offsets
}

fn order_selected_playlist_items(
    positions: &[usize],
    tracks: Vec<(usize, FavoriteSummary)>,
    skipped: Vec<SkippedPlaylistItem>,
) -> Result<(Vec<(usize, FavoriteSummary)>, Vec<SkippedPlaylistItem>), JamApiError> {
    let mut tracks_by_position = tracks.into_iter().collect::<HashMap<_, _>>();
    let mut skipped_by_position = skipped
        .into_iter()
        .map(|item| (item.position, item))
        .collect::<HashMap<_, _>>();
    let mut selected_tracks = Vec::with_capacity(positions.len());
    let mut selected_skipped = Vec::new();
    for position in positions {
        if let Some(track) = tracks_by_position.remove(position) {
            selected_tracks.push((*position, track));
        } else if let Some(item) = skipped_by_position.remove(position) {
            selected_skipped.push(item);
        } else {
            return Err(JamApiError {
                status: StatusCode::CONFLICT,
                code: "playlist_changed",
                message: format!(
                    "Playlist position {position} is no longer available; reload the playlist before queueing"
                ),
                retry_after: None,
            });
        }
    }
    Ok((selected_tracks, selected_skipped))
}

pub(crate) async fn fetch_playlist_selection(
    state: &AppState,
    playlist_id: &str,
    selected_positions: &[usize],
    expected_snapshot_id: Option<&str>,
) -> Result<PlaylistExpansion, JamApiError> {
    let positions = validate_selected_playlist_positions(selected_positions)?;
    let playlist = fetch_playlist_summary(state, playlist_id).await?;
    verify_playlist_snapshot(&playlist, expected_snapshot_id)?;
    let consistency_snapshot = expected_snapshot_id.or(playlist.snapshot_id.as_deref());
    let selected = positions.iter().copied().collect::<HashSet<_>>();
    let mut tracks = Vec::with_capacity(positions.len());
    let mut skipped = Vec::new();
    let mut observed_total = None;

    for offset in selected_playlist_page_offsets(&positions) {
        let (page_tracks, page_skipped, page_total) =
            fetch_playlist_items_page(state, &playlist, offset, MAX_PLAYLIST_ITEMS_LIMIT).await?;
        if observed_total.is_some_and(|total| total != page_total) {
            return Err(playlist_changed_error());
        }
        observed_total = Some(page_total);
        if positions
            .iter()
            .any(|position| *position >= page_total as usize)
        {
            return Err(JamApiError {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "playlist_position_out_of_range",
                message: format!("The playlist currently contains {page_total} items"),
                retry_after: None,
            });
        }
        tracks.extend(
            page_tracks
                .into_iter()
                .filter(|(position, _)| selected.contains(position)),
        );
        skipped.extend(
            page_skipped
                .into_iter()
                .filter(|item| selected.contains(&item.position)),
        );
    }

    verify_playlist_still_matches_snapshot(state, playlist_id, consistency_snapshot).await?;
    let (tracks, skipped) = order_selected_playlist_items(&positions, tracks, skipped)?;
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

fn bounded_playlist_artwork_misses(mut missing: Vec<String>) -> Vec<String> {
    missing.truncate(PLAYLIST_ARTWORK_REFRESH_MAX_IDS);
    missing
}

async fn hydrate_favorite_playlist_artwork(state: &AppState, views: &mut [FavoriteView]) {
    let mut missing = state
        .jam_favorites
        .apply_cached_playlist_artwork(views, now_ts_ms());
    if missing.is_empty() {
        return;
    }
    let spotify_connected = state
        .jam
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .spotify_token
        .is_some();
    if !spotify_connected {
        return;
    }

    let deadline = tokio::time::Instant::now() + PLAYLIST_ARTWORK_REFRESH_TIMEOUT;
    // Multiple viewers can open Library together. Serialize only cache-miss
    // discovery so a burst does not fetch the same visible covers repeatedly.
    // Waiting for that lock shares the same short deadline as the optional
    // Spotify calls, preventing queued viewers from stacking five-second waits.
    let Ok(_refresh) = tokio::time::timeout_at(
        deadline,
        state.jam_favorites.playlist_artwork_refresh.lock(),
    )
    .await
    else {
        return;
    };
    missing = bounded_playlist_artwork_misses(
        state
            .jam_favorites
            .apply_cached_playlist_artwork(views, now_ts_ms()),
    );
    if missing.is_empty() {
        return;
    }

    let artwork_generation = state.jam_favorites.playlist_artwork_generation();
    let mut requests = Box::pin(
        stream::iter(missing.into_iter().map(|spotify_id| async move {
            let result = fetch_playlist_artwork_url(state, &spotify_id).await;
            (spotify_id, result)
        }))
        .buffer_unordered(PLAYLIST_ARTWORK_REFRESH_CONCURRENCY),
    );
    // Covers are optional presentation metadata. Preserve results that arrive
    // promptly, but never let Spotify's per-request timeout multiply across a
    // full Favorites page and hold the Library open.
    loop {
        let next = tokio::time::timeout_at(deadline, requests.next()).await;
        let Ok(Some((spotify_id, result))) = next else {
            break;
        };
        match result {
            Ok(artwork_url) => state.jam_favorites.remember_playlist_artwork_if_generation(
                &spotify_id,
                artwork_url.as_deref(),
                now_ts_ms(),
                artwork_generation,
            ),
            // Cover art is presentation-only. A private/public access change,
            // expired authorization, or Spotify failure must never fail the
            // durable Favorites list. The global 429 cooldown already prevents
            // repeated network requests while Spotify asks Echo to wait.
            Err(error) if error.status == StatusCode::TOO_MANY_REQUESTS => {}
            Err(_) => state.jam_favorites.remember_playlist_artwork_if_generation(
                &spotify_id,
                None,
                now_ts_ms(),
                artwork_generation,
            ),
        }
    }
    state
        .jam_favorites
        .apply_cached_playlist_artwork(views, now_ts_ms());
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
    let mut views = items
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
        .collect::<Vec<_>>();
    hydrate_favorite_playlist_artwork(&state, &mut views).await;
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
    let mut view = FavoriteView {
        kind: item.kind,
        summary: item.summary,
        contributor_count: item.attributions.len(),
        favorited_by_me: true,
        attributions: item.attributions,
    };
    state
        .jam_favorites
        .apply_cached_playlist_artwork(std::slice::from_mut(&mut view), now_ts_ms());
    Ok(Json(FavoriteMutationResponse {
        ok: true,
        item: Some(view),
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
    {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if jam.spotify_token.is_none() {
            return Err(JamApiError {
                status: StatusCode::BAD_REQUEST,
                code: "spotify_not_connected",
                message: "Connect Spotify before importing favorites".to_string(),
                retry_after: None,
            });
        }
        if !spotify_library_scopes_authorized(jam.spotify_token.as_ref()) {
            return Err(spotify_library_scope_required_error());
        }
    }
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
            playlist.artwork_url.as_deref(),
            Some("https://image.example/p.jpg")
        );
        assert_eq!(
            playlist.spotify_url,
            format!("https://open.spotify.com/playlist/{ID_B}")
        );
    }

    #[test]
    fn playlist_artwork_accepts_only_https_spotify_cdn_urls() {
        for value in [
            "https://i.scdn.co/image/cover",
            "https://mosaic.scdn.co/640/cover",
            "https://image-cdn-ak.spotifycdn.com/image/cover?sig=temporary",
        ] {
            assert_eq!(
                safe_spotify_playlist_artwork_url(value).as_deref(),
                Some(value)
            );
        }
        for value in [
            "http://i.scdn.co/image/cover",
            "https://evilscdn.co/image/cover",
            "https://spotifycdn.com.evil.example/image/cover",
            "https://user@i.scdn.co/image/cover",
            "https://i.scdn.co:8443/image/cover",
        ] {
            assert!(safe_spotify_playlist_artwork_url(value).is_none());
        }
        assert_eq!(
            playlist_artwork_from_images_response(&serde_json::json!([
                {"url":"https://i.scdn.co/image/cover"}
            ]))
            .as_deref(),
            Some("https://i.scdn.co/image/cover")
        );
        assert!(playlist_artwork_from_images_response(&serde_json::json!([])).is_none());
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

    #[tokio::test]
    async fn full_playlist_expansion_fetches_every_page_and_preserves_cross_page_occurrences() {
        let seen_offsets = Mutex::new(Vec::new());
        let (tracks, skipped) = collect_playlist_item_pages(|offset| {
            seen_offsets
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(offset);
            let result = match offset {
                0 => {
                    let tracks = (0..50)
                        .filter(|position| *position != 10)
                        .map(|position| {
                            let id = if position == 49 { ID_A } else { ID_B };
                            (position, summary(id, &format!("Song {position}")))
                        })
                        .collect();
                    let skipped = vec![SkippedPlaylistItem {
                        position: 10,
                        reason: "local_track".to_string(),
                    }];
                    Ok((tracks, skipped, 120))
                }
                50 => Ok((
                    (50..100)
                        .map(|position| {
                            let id = if position == 50 { ID_A } else { ID_C };
                            (position, summary(id, &format!("Song {position}")))
                        })
                        .collect(),
                    Vec::new(),
                    120,
                )),
                100 => Ok((
                    (100..119)
                        .map(|position| (position, summary(ID_B, &format!("Song {position}"))))
                        .collect(),
                    vec![SkippedPlaylistItem {
                        position: 119,
                        reason: "unplayable".to_string(),
                    }],
                    120,
                )),
                _ => panic!("unexpected playlist page offset {offset}"),
            };
            std::future::ready(result)
        })
        .await
        .unwrap();

        assert_eq!(
            seen_offsets
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone(),
            vec![0, 50, 100]
        );
        assert_eq!(tracks.len(), 118);
        assert_eq!(
            skipped.iter().map(|item| item.position).collect::<Vec<_>>(),
            vec![10, 119]
        );
        let boundary = tracks
            .iter()
            .filter(|(position, _)| matches!(*position, 49 | 50))
            .map(|(position, track)| (*position, track.spotify_id.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(boundary, vec![(49, ID_A), (50, ID_A)]);
    }

    #[tokio::test]
    async fn full_playlist_expansion_rejects_changing_totals_and_premature_empty_pages() {
        let changing_total = collect_playlist_item_pages(|offset| {
            std::future::ready(match offset {
                0 => Ok((
                    (0..50)
                        .map(|position| (position, summary(ID_A, "Song")))
                        .collect(),
                    Vec::new(),
                    120,
                )),
                50 => Ok((
                    (50..100)
                        .map(|position| (position, summary(ID_B, "Song")))
                        .collect(),
                    Vec::new(),
                    121,
                )),
                _ => panic!("unexpected playlist page offset {offset}"),
            })
        })
        .await
        .unwrap_err();
        assert_eq!(changing_total.status, StatusCode::CONFLICT);
        assert_eq!(changing_total.code, "playlist_changed");

        let premature_empty = collect_playlist_item_pages(|offset| {
            std::future::ready(match offset {
                0 => Ok((
                    (0..50)
                        .map(|position| (position, summary(ID_A, "Song")))
                        .collect(),
                    Vec::new(),
                    120,
                )),
                50 => Ok((Vec::new(), Vec::new(), 120)),
                _ => panic!("unexpected playlist page offset {offset}"),
            })
        })
        .await
        .unwrap_err();
        assert_eq!(premature_empty.status, StatusCode::CONFLICT);
        assert_eq!(premature_empty.code, "playlist_changed");

        let oversized = collect_playlist_item_pages(|offset| {
            assert_eq!(offset, 0);
            std::future::ready(Ok((Vec::new(), Vec::new(), 1_001)))
        })
        .await
        .unwrap_err();
        assert_eq!(oversized.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(oversized.code, "playlist_batch_too_large");
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
        playlist.artwork_url = Some("https://i.scdn.co/image/temporary-cover".to_string());
        store
            .upsert(
                FavoriteKind::Playlist,
                playlist,
                &actor("ea1_sam", "Sam"),
                "echo",
                10,
            )
            .unwrap();
        let item = store.snapshot().remove(0);
        assert!(item.summary.artwork_url.is_none());
        let mut views = vec![FavoriteView {
            kind: item.kind,
            summary: item.summary,
            contributor_count: item.attributions.len(),
            favorited_by_me: true,
            attributions: item.attributions,
        }];
        assert!(store
            .apply_cached_playlist_artwork(&mut views, now_ts_ms())
            .is_empty());
        assert_eq!(
            views[0].summary.artwork_url.as_deref(),
            Some("https://i.scdn.co/image/temporary-cover")
        );
        let persisted = fs::read_to_string(path).unwrap();
        assert!(!persisted.contains("i.scdn.co"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn playlist_artwork_cache_is_bounded_expires_and_clears() {
        let store = FavoriteStore::empty(PathBuf::from("unused-favorites.json"));
        assert_eq!(PLAYLIST_ARTWORK_REFRESH_TIMEOUT, Duration::from_secs(5));
        assert_eq!(PLAYLIST_ARTWORK_REFRESH_MAX_IDS, 50);
        assert_eq!(
            bounded_playlist_artwork_misses((0..200).map(|index| format!("{index:022}")).collect())
                .len(),
            PLAYLIST_ARTWORK_REFRESH_MAX_IDS
        );
        for index in 0..=PLAYLIST_ARTWORK_CACHE_MAX_ENTRIES {
            let spotify_id = format!("{index:022}");
            store.remember_playlist_artwork(
                &spotify_id,
                Some("https://mosaic.scdn.co/640/cover"),
                index as u64,
            );
        }
        assert_eq!(
            store
                .playlist_artwork
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            PLAYLIST_ARTWORK_CACHE_MAX_ENTRIES
        );
        store.remember_playlist_artwork(
            ID_B,
            Some("https://i.scdn.co/image/temporary-cover"),
            1_000,
        );
        assert!(store.cached_playlist_artwork(ID_B, 1_000).is_some());
        assert!(store
            .cached_playlist_artwork(
                ID_B,
                1_000_u64.saturating_add(PLAYLIST_ARTWORK_CACHE_TTL_MS)
            )
            .is_none());
        store.remember_playlist_artwork(
            ID_B,
            Some("https://i.scdn.co/image/temporary-cover"),
            2_000,
        );
        let stale_generation = store.playlist_artwork_generation();
        store.clear_playlist_artwork_cache();
        assert!(store.cached_playlist_artwork(ID_B, 2_000).is_none());
        store.remember_playlist_artwork_if_generation(
            ID_B,
            Some("https://i.scdn.co/image/old-account-cover"),
            2_001,
            stale_generation,
        );
        assert!(store.cached_playlist_artwork(ID_B, 2_001).is_none());
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
    fn restricted_public_windows_are_one_aligned_chunk_within_the_browse_cap() {
        assert!(validate_public_playlist_items_window(0, 50).is_ok());
        assert!(validate_public_playlist_items_window(950, 50).is_ok());
        assert!(validate_public_playlist_items_window(25, 50).is_err());
        assert!(validate_public_playlist_items_window(0, 100).is_err());
        assert!(validate_public_playlist_items_window(1_000, 50).is_err());
    }

    #[test]
    fn restricted_public_paging_stops_at_one_thousand_without_hiding_the_source_total() {
        assert_eq!(
            playlist_items_next_offset("local_cache", 1_200, 900),
            Some(900)
        );
        assert_eq!(
            playlist_items_next_offset("local_cache", 1_200, 1_000),
            None
        );
        assert_eq!(
            playlist_items_next_offset("local_cache", 268, 200),
            Some(200)
        );
        assert_eq!(playlist_items_next_offset("local_cache", 268, 300), None);
        assert_eq!(
            playlist_items_next_offset("spotify", 1_200, 1_000),
            Some(1_000)
        );
    }

    #[test]
    fn selected_playlist_positions_are_nonempty_unique_bounded_and_canonical() {
        assert_eq!(
            validate_selected_playlist_positions(&[50, 0, 49, 100_000]).unwrap(),
            vec![0, 49, 50, 100_000]
        );
        assert!(validate_selected_playlist_positions(&[]).is_err());
        assert!(validate_selected_playlist_positions(&[7, 7]).is_err());
        assert!(validate_selected_playlist_positions(&[100_001]).is_err());
        assert!(validate_selected_playlist_positions(
            &(0..=MAX_PLAYLIST_QUEUE_TRACKS).collect::<Vec<_>>()
        )
        .is_err());
    }

    #[test]
    fn selected_playlist_pages_only_cover_requested_positions() {
        assert_eq!(
            selected_playlist_page_offsets(&[0, 49, 50, 51, 100]),
            vec![0, 50, 100]
        );
    }

    #[test]
    fn selected_playlist_items_preserve_occurrences_and_playlist_order() {
        let tracks = vec![
            (9, summary(ID_A, "Later duplicate")),
            (2, summary(ID_A, "Earlier duplicate")),
            (4, summary(ID_B, "Not selected")),
        ];
        let skipped = vec![
            SkippedPlaylistItem {
                position: 5,
                reason: "local_track".to_string(),
            },
            SkippedPlaylistItem {
                position: 8,
                reason: "unplayable".to_string(),
            },
        ];
        let (selected_tracks, selected_skipped) =
            order_selected_playlist_items(&[2, 5, 9], tracks, skipped).unwrap();
        assert_eq!(
            selected_tracks
                .iter()
                .map(|(position, track)| (*position, track.name.as_str()))
                .collect::<Vec<_>>(),
            vec![(2, "Earlier duplicate"), (9, "Later duplicate")]
        );
        assert_eq!(selected_skipped.len(), 1);
        assert_eq!(selected_skipped[0].position, 5);
    }

    #[test]
    fn selected_playlist_items_reject_a_missing_occurrence() {
        let error = order_selected_playlist_items(
            &[2, 3],
            vec![(2, summary(ID_A, "Available"))],
            Vec::new(),
        )
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "playlist_changed");
    }

    #[test]
    fn playlist_snapshot_validation_rejects_stale_selections() {
        let mut playlist = summary(ID_A, "Mix");
        playlist.snapshot_id = Some("current".to_string());
        assert!(verify_playlist_snapshot(&playlist, Some("current")).is_ok());
        let error = verify_playlist_snapshot(&playlist, Some("stale")).unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "playlist_changed");
    }

    #[test]
    fn public_catalog_total_must_match_the_official_playlist_summary() {
        let mut playlist = summary(ID_A, "Mix");
        playlist.track_count = Some(268);
        assert!(verify_public_playlist_total(&playlist, 268).is_ok());
        let error = verify_public_playlist_total(&playlist, 267).unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "playlist_changed");
        playlist.track_count = None;
        assert!(verify_public_playlist_total(&playlist, 999).is_ok());
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
