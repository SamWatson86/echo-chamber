use crate::jam_library::{valid_spotify_id, FavoriteSummary, SkippedPlaylistItem};

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tracing::warn;

pub(crate) const PLAYLIST_ITEMS_CACHE_SCHEMA_VERSION: u16 = 2;
pub(crate) const PLAYLIST_ITEMS_CACHE_CHUNK_SIZE: usize = 50;
pub(crate) const MAX_PLAYLIST_ITEMS_CACHE_TOTAL: usize = 1_000;
const MAX_PLAYLIST_ITEMS_SOURCE_TOTAL: usize = 100_000;

// Keep this derived cache useful without letting rarely opened playlists grow
// the control-plane data directory forever.
const MAX_CACHE_ENTRIES: usize = 64;
const MAX_CACHE_POSITIONS: usize = 10_000;
const MAX_SNAPSHOT_ID_LEN: usize = 512;
const MAX_SKIP_REASON_LEN: usize = 256;

#[derive(Clone, Debug)]
pub(crate) struct CachedPlaylistWindow {
    pub(crate) playlist_id: String,
    pub(crate) snapshot_id: String,
    pub(crate) tracks: Vec<(usize, FavoriteSummary)>,
    pub(crate) skipped: Vec<SkippedPlaylistItem>,
    pub(crate) offset: usize,
    pub(crate) limit: usize,
    pub(crate) total: u64,
    pub(crate) next_offset: Option<usize>,
    pub(crate) complete: bool,
    pub(crate) fetched_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PlaylistCacheCoverage {
    pub(crate) total: u64,
    pub(crate) cached_count: usize,
    pub(crate) cached_chunk_offsets: Vec<usize>,
    pub(crate) next_missing_chunk_offset: Option<usize>,
    pub(crate) complete: bool,
    pub(crate) updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PlaylistCacheFile {
    schema_version: u16,
    entries: Vec<PlaylistCacheEntry>,
}

impl Default for PlaylistCacheFile {
    fn default() -> Self {
        Self {
            schema_version: PLAYLIST_ITEMS_CACHE_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PlaylistCacheEntry {
    playlist_id: String,
    snapshot_id: String,
    total: usize,
    updated_at_ms: u64,
    chunks: Vec<PersistedChunk>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PersistedChunk {
    offset: usize,
    fetched_at_ms: u64,
    slots: Vec<PersistedSlot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PersistedSlot {
    Track { summary: FavoriteSummary },
    Skipped { reason: String },
}

/// Persistent, process-thread-safe storage for user-requested Spotify playlist
/// pages. The store performs no network I/O; callers provide one complete,
/// aligned chunk and the store validates it before replacing the durable file.
pub(crate) struct PlaylistItemsCache {
    path: PathBuf,
    writable: bool,
    inner: Mutex<PlaylistCacheFile>,
}

impl PlaylistItemsCache {
    pub(crate) fn open(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let backup = backup_path(&path);
        let data = if path.exists() {
            load_file(&path)?
        } else if backup.exists() {
            let recovered = load_file(&backup)?;
            fs::rename(&backup, &path)?;
            warn!(
                "Recovered Jam playlist-items cache from {:?} after an interrupted atomic write",
                backup
            );
            recovered
        } else {
            PlaylistCacheFile::default()
        };
        Ok(Self {
            path,
            writable: true,
            inner: Mutex::new(data),
        })
    }

    /// Preserve an unreadable primary file while exposing its last valid
    /// atomic backup. Mutations remain disabled so neither copy is overwritten.
    pub(crate) fn recover_read_only(path: PathBuf) -> Self {
        let data = load_file(&backup_path(&path)).unwrap_or_default();
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
            inner: Mutex::new(PlaylistCacheFile::default()),
        }
    }

    /// Return a requested window only when every playlist position in that
    /// window is cached. Windows may cross the fixed 50-position chunk
    /// boundary; tracks and skipped positions are returned in playlist order.
    pub(crate) fn window(
        &self,
        playlist_id: &str,
        snapshot_id: &str,
        offset: usize,
        limit: usize,
    ) -> Option<CachedPlaylistWindow> {
        if !valid_key(playlist_id, snapshot_id) || limit > MAX_PLAYLIST_ITEMS_CACHE_TOTAL {
            return None;
        }
        let data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let entry = find_entry(&data, playlist_id, snapshot_id)?;
        let cacheable_total = cacheable_total(entry.total);
        if offset > cacheable_total {
            return None;
        }
        let end = offset.checked_add(limit)?.min(cacheable_total);
        let mut tracks = Vec::new();
        let mut skipped = Vec::new();
        let mut fetched_at_ms = 0;
        for position in offset..end {
            let chunk_offset = aligned_offset(position);
            let chunk = entry
                .chunks
                .iter()
                .find(|chunk| chunk.offset == chunk_offset)?;
            let slot = chunk.slots.get(position - chunk_offset)?;
            fetched_at_ms = fetched_at_ms.max(chunk.fetched_at_ms);
            match slot {
                PersistedSlot::Track { summary } => tracks.push((position, summary.clone())),
                PersistedSlot::Skipped { reason } => skipped.push(SkippedPlaylistItem {
                    position,
                    reason: reason.clone(),
                }),
            }
        }
        let complete = entry_complete(entry);
        Some(CachedPlaylistWindow {
            playlist_id: playlist_id.to_string(),
            snapshot_id: snapshot_id.to_string(),
            tracks,
            skipped,
            offset,
            limit,
            total: entry.total as u64,
            next_offset: (end < cacheable_total).then_some(end),
            complete,
            fetched_at_ms,
        })
    }

    pub(crate) fn has_chunk(&self, playlist_id: &str, snapshot_id: &str, offset: usize) -> bool {
        if !valid_key(playlist_id, snapshot_id) || offset % PLAYLIST_ITEMS_CACHE_CHUNK_SIZE != 0 {
            return false;
        }
        let data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        find_entry(&data, playlist_id, snapshot_id)
            .is_some_and(|entry| entry.chunks.iter().any(|chunk| chunk.offset == offset))
    }

    pub(crate) fn coverage(
        &self,
        playlist_id: &str,
        snapshot_id: &str,
    ) -> Option<PlaylistCacheCoverage> {
        if !valid_key(playlist_id, snapshot_id) {
            return None;
        }
        let data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let entry = find_entry(&data, playlist_id, snapshot_id)?;
        Some(entry_coverage(entry))
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn cached_count(&self, playlist_id: &str, snapshot_id: &str) -> usize {
        self.coverage(playlist_id, snapshot_id)
            .map(|coverage| coverage.cached_count)
            .unwrap_or(0)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn complete(&self, playlist_id: &str, snapshot_id: &str) -> bool {
        self.coverage(playlist_id, snapshot_id)
            .is_some_and(|coverage| coverage.complete)
    }

    /// Validate and merge exactly one aligned chunk. Every expected position
    /// must appear once, as either a track or a skipped item. Duplicate songs
    /// are intentionally retained because positions, not Spotify IDs, are the
    /// cache identity.
    pub(crate) fn merge_chunk(
        &self,
        playlist: &FavoriteSummary,
        offset: usize,
        total: u64,
        tracks: Vec<(usize, FavoriteSummary)>,
        skipped: Vec<SkippedPlaylistItem>,
        fetched_at_ms: u64,
    ) -> io::Result<()> {
        self.ensure_writable()?;
        let snapshot_id = playlist.snapshot_id.as_deref().ok_or_else(|| {
            invalid_input("playlist cache requires a nonempty Spotify snapshot ID")
        })?;
        validate_key(&playlist.spotify_id, snapshot_id)?;
        let total = usize::try_from(total)
            .ok()
            .filter(|total| *total <= MAX_PLAYLIST_ITEMS_SOURCE_TOTAL)
            .ok_or_else(|| {
                invalid_input(format!(
                    "playlist source total must be at most {MAX_PLAYLIST_ITEMS_SOURCE_TOTAL}"
                ))
            })?;
        let chunk = build_chunk(offset, total, tracks, skipped, fetched_at_ms)?;

        let mut data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mut candidate = data.clone();

        // A Spotify snapshot is immutable. Once a newer snapshot for the same
        // playlist is merged, its stale cache can never satisfy a current read.
        candidate.entries.retain(|entry| {
            entry.playlist_id != playlist.spotify_id || entry.snapshot_id == snapshot_id
        });
        let entry = if let Some(entry) = candidate.entries.iter_mut().find(|entry| {
            entry.playlist_id == playlist.spotify_id && entry.snapshot_id == snapshot_id
        }) {
            if entry.total != total {
                return Err(invalid_input(
                    "playlist total changed without a new Spotify snapshot ID",
                ));
            }
            entry
        } else {
            candidate.entries.push(PlaylistCacheEntry {
                playlist_id: playlist.spotify_id.clone(),
                snapshot_id: snapshot_id.to_string(),
                total,
                updated_at_ms: fetched_at_ms,
                chunks: Vec::new(),
            });
            candidate
                .entries
                .last_mut()
                .expect("entry was just inserted")
        };
        entry.updated_at_ms = entry.updated_at_ms.max(fetched_at_ms);
        if let Some(existing) = entry
            .chunks
            .iter_mut()
            .find(|existing| existing.offset == offset)
        {
            *existing = chunk;
        } else {
            entry.chunks.push(chunk);
            entry.chunks.sort_by_key(|chunk| chunk.offset);
        }

        let protected = (playlist.spotify_id.as_str(), snapshot_id);
        prune_to_limits(&mut candidate, protected);
        self.persist_locked(&candidate)?;
        *data = candidate;
        Ok(())
    }

    /// Remove one exact playlist/snapshot cache key.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn invalidate_snapshot(
        &self,
        playlist_id: &str,
        snapshot_id: &str,
    ) -> io::Result<bool> {
        self.ensure_writable()?;
        validate_key(playlist_id, snapshot_id)?;
        let mut data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mut candidate = data.clone();
        let before = candidate.entries.len();
        candidate
            .entries
            .retain(|entry| entry.playlist_id != playlist_id || entry.snapshot_id != snapshot_id);
        if candidate.entries.len() == before {
            return Ok(false);
        }
        self.persist_locked(&candidate)?;
        *data = candidate;
        Ok(true)
    }

    /// Remove cached snapshots for a playlist other than the supplied current
    /// snapshot. This is useful immediately after fetching playlist metadata.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn invalidate_stale_snapshots(
        &self,
        playlist_id: &str,
        current_snapshot_id: &str,
    ) -> io::Result<usize> {
        self.ensure_writable()?;
        validate_key(playlist_id, current_snapshot_id)?;
        let mut data = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mut candidate = data.clone();
        let before = candidate.entries.len();
        candidate.entries.retain(|entry| {
            entry.playlist_id != playlist_id || entry.snapshot_id == current_snapshot_id
        });
        let removed = before - candidate.entries.len();
        if removed == 0 {
            return Ok(0);
        }
        self.persist_locked(&candidate)?;
        *data = candidate;
        Ok(removed)
    }

    fn ensure_writable(&self) -> io::Result<()> {
        if self.writable {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "playlist-items cache is unavailable or read-only",
            ))
        }
    }

    fn persist_locked(&self, data: &PlaylistCacheFile) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(data)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        write_atomic(&self.path, &bytes)
    }
}

fn build_chunk(
    offset: usize,
    total: usize,
    tracks: Vec<(usize, FavoriteSummary)>,
    skipped: Vec<SkippedPlaylistItem>,
    fetched_at_ms: u64,
) -> io::Result<PersistedChunk> {
    if offset % PLAYLIST_ITEMS_CACHE_CHUNK_SIZE != 0 {
        return Err(invalid_input(format!(
            "playlist cache offset must be aligned to {PLAYLIST_ITEMS_CACHE_CHUNK_SIZE}"
        )));
    }
    let cacheable_total = cacheable_total(total);
    if (total == 0 && offset != 0) || (total > 0 && offset >= cacheable_total) {
        return Err(invalid_input(
            "playlist cache offset is outside the playlist",
        ));
    }
    let expected_len = total
        .saturating_sub(offset)
        .min(PLAYLIST_ITEMS_CACHE_CHUNK_SIZE);
    let mut slots = vec![None; expected_len];
    for (position, summary) in tracks {
        validate_position(position, offset, expected_len)?;
        validate_track_summary(&summary)?;
        let index = position - offset;
        if slots[index].is_some() {
            return Err(invalid_input(format!(
                "playlist cache position {position} was supplied more than once"
            )));
        }
        slots[index] = Some(PersistedSlot::Track { summary });
    }
    for item in skipped {
        validate_position(item.position, offset, expected_len)?;
        validate_skip_reason(&item.reason)?;
        let index = item.position - offset;
        if slots[index].is_some() {
            return Err(invalid_input(format!(
                "playlist cache position {} was supplied more than once",
                item.position
            )));
        }
        slots[index] = Some(PersistedSlot::Skipped {
            reason: item.reason,
        });
    }
    let slots = slots
        .into_iter()
        .enumerate()
        .map(|(index, slot)| {
            slot.ok_or_else(|| {
                invalid_input(format!(
                    "playlist cache chunk is missing position {}",
                    offset + index
                ))
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    Ok(PersistedChunk {
        offset,
        fetched_at_ms,
        slots,
    })
}

fn validate_position(position: usize, offset: usize, expected_len: usize) -> io::Result<()> {
    if position < offset || position >= offset.saturating_add(expected_len) {
        Err(invalid_input(format!(
            "playlist cache position {position} is outside this chunk"
        )))
    } else {
        Ok(())
    }
}

fn validate_track_summary(summary: &FavoriteSummary) -> io::Result<()> {
    let expected_uri = format!("spotify:track:{}", summary.spotify_id);
    let expected_url = format!("https://open.spotify.com/track/{}", summary.spotify_id);
    if !valid_spotify_id(&summary.spotify_id)
        || summary.spotify_uri != expected_uri
        || summary.spotify_url != expected_url
        || summary.name.trim().is_empty()
        || summary
            .artist
            .as_deref()
            .is_none_or(|artist| artist.trim().is_empty())
    {
        return Err(invalid_input(
            "playlist cache contains a malformed Spotify track summary",
        ));
    }
    Ok(())
}

fn validate_skip_reason(reason: &str) -> io::Result<()> {
    if reason.trim().is_empty()
        || reason.len() > MAX_SKIP_REASON_LEN
        || reason.chars().any(char::is_control)
    {
        Err(invalid_input(
            "playlist cache contains an invalid skip reason",
        ))
    } else {
        Ok(())
    }
}

fn aligned_offset(position: usize) -> usize {
    position / PLAYLIST_ITEMS_CACHE_CHUNK_SIZE * PLAYLIST_ITEMS_CACHE_CHUNK_SIZE
}

fn cacheable_total(total: usize) -> usize {
    total.min(MAX_PLAYLIST_ITEMS_CACHE_TOTAL)
}

fn find_entry<'a>(
    data: &'a PlaylistCacheFile,
    playlist_id: &str,
    snapshot_id: &str,
) -> Option<&'a PlaylistCacheEntry> {
    data.entries
        .iter()
        .find(|entry| entry.playlist_id == playlist_id && entry.snapshot_id == snapshot_id)
}

fn entry_complete(entry: &PlaylistCacheEntry) -> bool {
    if entry.total > MAX_PLAYLIST_ITEMS_CACHE_TOTAL {
        return false;
    }
    if entry.total == 0 {
        return entry
            .chunks
            .iter()
            .any(|chunk| chunk.offset == 0 && chunk.slots.is_empty());
    }
    (0..entry.total)
        .step_by(PLAYLIST_ITEMS_CACHE_CHUNK_SIZE)
        .all(|offset| entry.chunks.iter().any(|chunk| chunk.offset == offset))
}

fn entry_coverage(entry: &PlaylistCacheEntry) -> PlaylistCacheCoverage {
    let mut cached_chunk_offsets = entry
        .chunks
        .iter()
        .map(|chunk| chunk.offset)
        .collect::<Vec<_>>();
    cached_chunk_offsets.sort_unstable();
    let next_missing_chunk_offset = if entry.total == 0 {
        (!entry_complete(entry)).then_some(0)
    } else {
        (0..cacheable_total(entry.total))
            .step_by(PLAYLIST_ITEMS_CACHE_CHUNK_SIZE)
            .find(|offset| !cached_chunk_offsets.contains(offset))
    };
    PlaylistCacheCoverage {
        total: entry.total as u64,
        cached_count: entry.chunks.iter().map(|chunk| chunk.slots.len()).sum(),
        cached_chunk_offsets,
        next_missing_chunk_offset,
        complete: entry_complete(entry),
        updated_at_ms: entry.updated_at_ms,
    }
}

fn valid_key(playlist_id: &str, snapshot_id: &str) -> bool {
    valid_spotify_id(playlist_id)
        && !snapshot_id.trim().is_empty()
        && snapshot_id.len() <= MAX_SNAPSHOT_ID_LEN
        && !snapshot_id.chars().any(char::is_control)
}

fn validate_key(playlist_id: &str, snapshot_id: &str) -> io::Result<()> {
    if valid_key(playlist_id, snapshot_id) {
        Ok(())
    } else {
        Err(invalid_input(
            "playlist cache requires a valid playlist ID and nonempty snapshot ID",
        ))
    }
}

fn prune_to_limits(data: &mut PlaylistCacheFile, protected: (&str, &str)) {
    while data.entries.len() > MAX_CACHE_ENTRIES
        || data
            .entries
            .iter()
            .map(|entry| {
                entry
                    .chunks
                    .iter()
                    .map(|chunk| chunk.slots.len())
                    .sum::<usize>()
            })
            .sum::<usize>()
            > MAX_CACHE_POSITIONS
    {
        let Some(index) = data
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| {
                entry.playlist_id != protected.0 || entry.snapshot_id != protected.1
            })
            .min_by_key(|(_, entry)| entry.updated_at_ms)
            .map(|(index, _)| index)
        else {
            break;
        };
        data.entries.remove(index);
    }
}

fn load_file(path: &Path) -> io::Result<PlaylistCacheFile> {
    let bytes = fs::read(path)?;
    let parsed: PlaylistCacheFile = serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    validate_file(parsed)
}

fn validate_file(mut data: PlaylistCacheFile) -> io::Result<PlaylistCacheFile> {
    if data.schema_version != PLAYLIST_ITEMS_CACHE_SCHEMA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported playlist-items cache schema {}",
                data.schema_version
            ),
        ));
    }
    if data.entries.len() > MAX_CACHE_ENTRIES {
        return Err(invalid_data("playlist-items cache has too many entries"));
    }
    let mut keys = HashSet::new();
    let mut cached_positions = 0usize;
    for entry in &mut data.entries {
        validate_key(&entry.playlist_id, &entry.snapshot_id)
            .map_err(|error| invalid_data(error.to_string()))?;
        if entry.total > MAX_PLAYLIST_ITEMS_SOURCE_TOTAL
            || !keys.insert((entry.playlist_id.clone(), entry.snapshot_id.clone()))
            || entry.chunks.is_empty()
        {
            return Err(invalid_data(
                "playlist-items cache contains an invalid or duplicate entry",
            ));
        }
        let mut offsets = HashSet::new();
        for chunk in &entry.chunks {
            if chunk.offset % PLAYLIST_ITEMS_CACHE_CHUNK_SIZE != 0
                || !offsets.insert(chunk.offset)
                || (entry.total == 0 && chunk.offset != 0)
                || (entry.total > 0 && chunk.offset >= cacheable_total(entry.total))
            {
                return Err(invalid_data(
                    "playlist-items cache contains an invalid chunk offset",
                ));
            }
            let expected_len = entry
                .total
                .saturating_sub(chunk.offset)
                .min(PLAYLIST_ITEMS_CACHE_CHUNK_SIZE);
            if chunk.slots.len() != expected_len {
                return Err(invalid_data(
                    "playlist-items cache chunk does not cover every expected position",
                ));
            }
            for slot in &chunk.slots {
                match slot {
                    PersistedSlot::Track { summary } => validate_track_summary(summary),
                    PersistedSlot::Skipped { reason } => validate_skip_reason(reason),
                }
                .map_err(|error| invalid_data(error.to_string()))?;
            }
            cached_positions = cached_positions.saturating_add(chunk.slots.len());
        }
        entry.chunks.sort_by_key(|chunk| chunk.offset);
        entry.updated_at_ms = entry
            .chunks
            .iter()
            .map(|chunk| chunk.fetched_at_ms)
            .max()
            .unwrap_or(entry.updated_at_ms)
            .max(entry.updated_at_ms);
    }
    if cached_positions > MAX_CACHE_POSITIONS {
        return Err(invalid_data(
            "playlist-items cache contains too many positions",
        ));
    }
    Ok(data)
}

fn backup_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("playlist-items-cache-v2.json");
    parent.join(format!("{file_name}.bak"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "playlist-items cache path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid_input("invalid playlist-items cache filename"))?;
    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temp = parent.join(format!("{file_name}.{suffix}.tmp"));
    let backup = backup_path(path);
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
    Ok(())
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const PLAYLIST_A: &str = "2a514BsnnFkgMBxVrCAOEj";
    const PLAYLIST_B: &str = "37i9dQZF1DXcBWIGoYBM5M";
    const TRACK_A: &str = "0VjIjW4GlUZAMYd2vXMi3b";
    const TRACK_B: &str = "4cOdK2wGLETKBW3PvgPWqT";

    fn temp_path(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "echo-playlist-cache-{label}-{}",
            crate::config::random_secret()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("playlist-items-cache-v2.json")
    }

    fn playlist(id: &str, snapshot_id: &str) -> FavoriteSummary {
        FavoriteSummary {
            spotify_id: id.to_string(),
            spotify_uri: format!("spotify:playlist:{id}"),
            spotify_url: format!("https://open.spotify.com/playlist/{id}"),
            name: "Test playlist".to_string(),
            snapshot_id: Some(snapshot_id.to_string()),
            ..FavoriteSummary::default()
        }
    }

    fn track(id: &str, name: &str) -> FavoriteSummary {
        FavoriteSummary {
            spotify_id: id.to_string(),
            spotify_uri: format!("spotify:track:{id}"),
            spotify_url: format!("https://open.spotify.com/track/{id}"),
            name: name.to_string(),
            artist: Some("Test Artist".to_string()),
            duration_ms: Some(180_000),
            ..FavoriteSummary::default()
        }
    }

    fn full_tracks(offset: usize, count: usize) -> Vec<(usize, FavoriteSummary)> {
        (offset..offset + count)
            .map(|position| {
                let id = if position % 2 == 0 { TRACK_A } else { TRACK_B };
                (position, track(id, &format!("Track {position}")))
            })
            .collect()
    }

    #[test]
    fn persists_order_duplicates_and_skipped_positions() {
        let path = temp_path("roundtrip");
        let cache = PlaylistItemsCache::open(path.clone()).unwrap();
        let mut tracks = full_tracks(0, 50);
        tracks.retain(|(position, _)| *position != 17);
        cache
            .merge_chunk(
                &playlist(PLAYLIST_A, "snapshot-a"),
                0,
                50,
                tracks,
                vec![SkippedPlaylistItem {
                    position: 17,
                    reason: "local_track".to_string(),
                }],
                111,
            )
            .unwrap();
        drop(cache);

        let reopened = PlaylistItemsCache::open(path).unwrap();
        let window = reopened.window(PLAYLIST_A, "snapshot-a", 15, 5).unwrap();
        assert_eq!(
            window.tracks.iter().map(|item| item.0).collect::<Vec<_>>(),
            vec![15, 16, 18, 19]
        );
        assert_eq!(window.tracks[0].1.spotify_id, TRACK_B);
        assert_eq!(window.tracks[2].1.spotify_id, TRACK_A);
        assert_eq!(window.skipped.len(), 1);
        assert_eq!(window.skipped[0].position, 17);
        assert_eq!(window.total, 50);
        assert!(window.complete);
        assert_eq!(window.fetched_at_ms, 111);
    }

    #[test]
    fn partial_cache_reports_coverage_and_only_serves_covered_windows() {
        let path = temp_path("coverage");
        let cache = PlaylistItemsCache::open(path).unwrap();
        let summary = playlist(PLAYLIST_A, "snapshot-a");
        cache
            .merge_chunk(&summary, 100, 268, full_tracks(100, 50), vec![], 200)
            .unwrap();

        assert!(cache.window(PLAYLIST_A, "snapshot-a", 100, 50).is_some());
        assert!(cache.window(PLAYLIST_A, "snapshot-a", 90, 20).is_none());
        assert!(cache.has_chunk(PLAYLIST_A, "snapshot-a", 100));
        assert!(!cache.has_chunk(PLAYLIST_A, "snapshot-a", 0));
        let coverage = cache.coverage(PLAYLIST_A, "snapshot-a").unwrap();
        assert_eq!(coverage.total, 268);
        assert_eq!(coverage.cached_count, 50);
        assert_eq!(coverage.cached_chunk_offsets, vec![100]);
        assert_eq!(coverage.next_missing_chunk_offset, Some(0));
        assert!(!coverage.complete);
    }

    #[test]
    fn six_chunks_complete_a_268_position_playlist() {
        let path = temp_path("complete");
        let cache = PlaylistItemsCache::open(path).unwrap();
        let summary = playlist(PLAYLIST_A, "snapshot-a");
        cache
            .merge_chunk(&summary, 0, 268, full_tracks(0, 50), vec![], 100)
            .unwrap();
        cache
            .merge_chunk(&summary, 50, 268, full_tracks(50, 50), vec![], 150)
            .unwrap();
        cache
            .merge_chunk(&summary, 100, 268, full_tracks(100, 50), vec![], 200)
            .unwrap();
        cache
            .merge_chunk(&summary, 150, 268, full_tracks(150, 50), vec![], 250)
            .unwrap();
        cache
            .merge_chunk(&summary, 200, 268, full_tracks(200, 50), vec![], 300)
            .unwrap();
        cache
            .merge_chunk(&summary, 250, 268, full_tracks(250, 18), vec![], 350)
            .unwrap();

        assert!(cache.complete(PLAYLIST_A, "snapshot-a"));
        assert_eq!(cache.cached_count(PLAYLIST_A, "snapshot-a"), 268);
        let coverage = cache.coverage(PLAYLIST_A, "snapshot-a").unwrap();
        assert_eq!(
            coverage.cached_chunk_offsets,
            vec![0, 50, 100, 150, 200, 250]
        );
        assert_eq!(coverage.next_missing_chunk_offset, None);
        let window = cache.window(PLAYLIST_A, "snapshot-a", 190, 50).unwrap();
        assert_eq!(window.tracks.len(), 50);
        assert_eq!(window.next_offset, Some(240));
    }

    #[test]
    fn oversized_playlist_caches_only_the_first_thousand_positions() {
        let path = temp_path("position-limit");
        let cache = PlaylistItemsCache::open(path).unwrap();
        let summary = playlist(PLAYLIST_A, "snapshot-large");
        for offset in (0..MAX_PLAYLIST_ITEMS_CACHE_TOTAL).step_by(PLAYLIST_ITEMS_CACHE_CHUNK_SIZE) {
            cache
                .merge_chunk(
                    &summary,
                    offset,
                    1_200,
                    full_tracks(offset, PLAYLIST_ITEMS_CACHE_CHUNK_SIZE),
                    vec![],
                    offset as u64,
                )
                .unwrap();
        }

        let coverage = cache.coverage(PLAYLIST_A, "snapshot-large").unwrap();
        assert_eq!(coverage.total, 1_200);
        assert_eq!(coverage.cached_count, 1_000);
        assert_eq!(coverage.next_missing_chunk_offset, None);
        assert!(!coverage.complete);
        let last = cache.window(PLAYLIST_A, "snapshot-large", 950, 50).unwrap();
        assert_eq!(last.tracks.len(), 50);
        assert_eq!(last.next_offset, None);
        assert!(cache
            .merge_chunk(
                &summary,
                1_000,
                1_200,
                full_tracks(1_000, 50),
                vec![],
                1_000,
            )
            .is_err());
    }

    #[test]
    fn merge_rejects_unaligned_incomplete_duplicate_and_oversized_chunks() {
        let path = temp_path("validation");
        let cache = PlaylistItemsCache::open(path).unwrap();
        let summary = playlist(PLAYLIST_A, "snapshot-a");
        assert_eq!(
            cache
                .merge_chunk(&summary, 1, 100, full_tracks(1, 49), vec![], 1)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(cache
            .merge_chunk(&summary, 0, 100, full_tracks(0, 49), vec![], 1)
            .is_err());
        let mut duplicate = full_tracks(0, 50);
        duplicate.push((0, track(TRACK_A, "Duplicate position")));
        assert!(cache
            .merge_chunk(&summary, 0, 100, duplicate, vec![], 1)
            .is_err());
        assert!(cache
            .merge_chunk(&summary, 0, 100_001, full_tracks(0, 50), vec![], 1)
            .is_err());
        assert!(cache.coverage(PLAYLIST_A, "snapshot-a").is_none());
    }

    #[test]
    fn final_chunk_must_cover_exact_remaining_positions() {
        let path = temp_path("final-chunk");
        let cache = PlaylistItemsCache::open(path).unwrap();
        let summary = playlist(PLAYLIST_A, "snapshot-a");
        assert!(cache
            .merge_chunk(&summary, 250, 268, full_tracks(250, 17), vec![], 1)
            .is_err());
        assert!(cache
            .merge_chunk(&summary, 250, 268, full_tracks(250, 19), vec![], 1)
            .is_err());
        cache
            .merge_chunk(&summary, 250, 268, full_tracks(250, 18), vec![], 1)
            .unwrap();
        assert!(cache.has_chunk(PLAYLIST_A, "snapshot-a", 250));
    }

    #[test]
    fn empty_playlist_has_a_complete_zero_length_chunk() {
        let path = temp_path("empty");
        let cache = PlaylistItemsCache::open(path).unwrap();
        cache
            .merge_chunk(
                &playlist(PLAYLIST_A, "snapshot-empty"),
                0,
                0,
                vec![],
                vec![],
                5,
            )
            .unwrap();
        assert!(cache.complete(PLAYLIST_A, "snapshot-empty"));
        let window = cache.window(PLAYLIST_A, "snapshot-empty", 0, 50).unwrap();
        assert!(window.tracks.is_empty());
        assert!(window.skipped.is_empty());
        assert_eq!(window.next_offset, None);
    }

    #[test]
    fn snapshot_is_required_and_new_snapshot_prunes_old_snapshot() {
        let path = temp_path("snapshots");
        let cache = PlaylistItemsCache::open(path).unwrap();
        let mut missing = playlist(PLAYLIST_A, "unused");
        missing.snapshot_id = None;
        assert!(cache
            .merge_chunk(&missing, 0, 1, full_tracks(0, 1), vec![], 1)
            .is_err());

        cache
            .merge_chunk(
                &playlist(PLAYLIST_A, "snapshot-a"),
                0,
                1,
                full_tracks(0, 1),
                vec![],
                1,
            )
            .unwrap();
        cache
            .merge_chunk(
                &playlist(PLAYLIST_A, "snapshot-b"),
                0,
                1,
                full_tracks(0, 1),
                vec![],
                2,
            )
            .unwrap();
        assert!(cache.coverage(PLAYLIST_A, "snapshot-a").is_none());
        assert!(cache.coverage(PLAYLIST_A, "snapshot-b").is_some());
    }

    #[test]
    fn total_mismatch_does_not_mutate_existing_snapshot() {
        let path = temp_path("total-mismatch");
        let cache = PlaylistItemsCache::open(path.clone()).unwrap();
        let summary = playlist(PLAYLIST_A, "snapshot-a");
        cache
            .merge_chunk(&summary, 0, 100, full_tracks(0, 50), vec![], 1)
            .unwrap();
        let error = cache
            .merge_chunk(&summary, 0, 99, full_tracks(0, 50), vec![], 2)
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "playlist total changed without a new Spotify snapshot ID"
        );
        assert_eq!(cache.coverage(PLAYLIST_A, "snapshot-a").unwrap().total, 100);
        drop(cache);
        assert_eq!(
            PlaylistItemsCache::open(path)
                .unwrap()
                .coverage(PLAYLIST_A, "snapshot-a")
                .unwrap()
                .total,
            100
        );
    }

    #[test]
    fn exact_and_stale_snapshot_invalidation_are_durable() {
        let path = temp_path("invalidate");
        let cache = PlaylistItemsCache::open(path.clone()).unwrap();
        cache
            .merge_chunk(
                &playlist(PLAYLIST_A, "snapshot-a"),
                0,
                1,
                full_tracks(0, 1),
                vec![],
                1,
            )
            .unwrap();
        cache
            .merge_chunk(
                &playlist(PLAYLIST_B, "snapshot-b"),
                0,
                1,
                full_tracks(0, 1),
                vec![],
                2,
            )
            .unwrap();
        assert_eq!(
            cache
                .invalidate_stale_snapshots(PLAYLIST_A, "snapshot-current")
                .unwrap(),
            1
        );
        assert!(cache.invalidate_snapshot(PLAYLIST_B, "snapshot-b").unwrap());
        assert!(!cache.invalidate_snapshot(PLAYLIST_B, "snapshot-b").unwrap());
        drop(cache);
        let reopened = PlaylistItemsCache::open(path).unwrap();
        assert!(reopened.coverage(PLAYLIST_A, "snapshot-a").is_none());
        assert!(reopened.coverage(PLAYLIST_B, "snapshot-b").is_none());
    }

    #[test]
    fn missing_primary_recovers_last_atomic_backup() {
        let path = temp_path("backup-recovery");
        let cache = PlaylistItemsCache::open(path.clone()).unwrap();
        let summary = playlist(PLAYLIST_A, "snapshot-a");
        cache
            .merge_chunk(&summary, 0, 100, full_tracks(0, 50), vec![], 1)
            .unwrap();
        cache
            .merge_chunk(&summary, 50, 100, full_tracks(50, 50), vec![], 2)
            .unwrap();
        drop(cache);
        fs::remove_file(&path).unwrap();
        assert!(backup_path(&path).exists());

        let recovered = PlaylistItemsCache::open(path.clone()).unwrap();
        assert!(path.exists());
        assert!(!backup_path(&path).exists());
        assert!(recovered.has_chunk(PLAYLIST_A, "snapshot-a", 0));
        assert!(!recovered.has_chunk(PLAYLIST_A, "snapshot-a", 50));
    }

    #[test]
    fn corrupt_primary_can_use_valid_backup_read_only() {
        let path = temp_path("readonly-recovery");
        let cache = PlaylistItemsCache::open(path.clone()).unwrap();
        let summary = playlist(PLAYLIST_A, "snapshot-a");
        cache
            .merge_chunk(&summary, 0, 100, full_tracks(0, 50), vec![], 1)
            .unwrap();
        cache
            .merge_chunk(&summary, 50, 100, full_tracks(50, 50), vec![], 2)
            .unwrap();
        drop(cache);
        fs::write(&path, b"not json").unwrap();
        assert_eq!(
            PlaylistItemsCache::open(path.clone()).err().unwrap().kind(),
            io::ErrorKind::InvalidData
        );

        let recovered = PlaylistItemsCache::recover_read_only(path.clone());
        assert!(recovered.has_chunk(PLAYLIST_A, "snapshot-a", 0));
        assert!(!recovered.has_chunk(PLAYLIST_A, "snapshot-a", 50));
        assert_eq!(
            recovered
                .merge_chunk(&summary, 50, 100, full_tracks(50, 50), vec![], 3)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(fs::read(&path).unwrap(), b"not json");
    }

    #[test]
    fn unsupported_schema_is_rejected() {
        let path = temp_path("schema");
        fs::write(&path, br#"{"schema_version":3,"entries":[]}"#).unwrap();
        assert_eq!(
            PlaylistItemsCache::open(path).err().unwrap().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn disabled_cache_serves_no_data_and_rejects_mutation() {
        let path = temp_path("disabled");
        let cache = PlaylistItemsCache::disabled(path);
        assert!(cache.window(PLAYLIST_A, "snapshot-a", 0, 50).is_none());
        assert_eq!(
            cache
                .merge_chunk(
                    &playlist(PLAYLIST_A, "snapshot-a"),
                    0,
                    1,
                    full_tracks(0, 1),
                    vec![],
                    1,
                )
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn concurrent_chunk_merges_are_serialized_without_lost_updates() {
        let path = temp_path("concurrent");
        let cache = Arc::new(PlaylistItemsCache::open(path).unwrap());
        let summary = Arc::new(playlist(PLAYLIST_A, "snapshot-a"));
        let mut workers = Vec::new();
        for chunk_index in 0..(MAX_PLAYLIST_ITEMS_CACHE_TOTAL / PLAYLIST_ITEMS_CACHE_CHUNK_SIZE) {
            let cache = Arc::clone(&cache);
            let summary = Arc::clone(&summary);
            workers.push(std::thread::spawn(move || {
                let offset = chunk_index * PLAYLIST_ITEMS_CACHE_CHUNK_SIZE;
                cache
                    .merge_chunk(
                        &summary,
                        offset,
                        1_000,
                        full_tracks(offset, PLAYLIST_ITEMS_CACHE_CHUNK_SIZE),
                        vec![],
                        chunk_index as u64,
                    )
                    .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(cache.complete(PLAYLIST_A, "snapshot-a"));
        assert_eq!(cache.cached_count(PLAYLIST_A, "snapshot-a"), 1_000);
    }

    #[test]
    fn cache_prunes_least_recently_used_entries_at_its_bound() {
        let path = temp_path("bounded");
        let cache = PlaylistItemsCache::open(path).unwrap();
        for index in 0..=MAX_CACHE_ENTRIES {
            let id = format!("{:022}", index);
            cache
                .merge_chunk(
                    &playlist(&id, &format!("snapshot-{index}")),
                    0,
                    1,
                    full_tracks(0, 1),
                    vec![],
                    index as u64,
                )
                .unwrap();
        }
        assert!(cache
            .coverage(&format!("{:022}", 0), "snapshot-0")
            .is_none());
        assert!(cache
            .coverage(
                &format!("{:022}", MAX_CACHE_ENTRIES),
                &format!("snapshot-{MAX_CACHE_ENTRIES}")
            )
            .is_some());
    }
}
