use crate::jam_library::{valid_spotify_id, FavoriteSummary};

use hmac::{Hmac, Mac};
use reqwest::header::{ACCEPT, ORIGIN, REFERER, RETRY_AFTER, USER_AGENT};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use std::fmt;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

pub(crate) const PUBLIC_PLAYLIST_CHUNK_SIZE: usize = 50;
pub(crate) const MAX_PUBLIC_PLAYLIST_POSITIONS: usize = 1_000;

const SERVER_TIME_URL: &str = "https://open.spotify.com/api/server-time";
const TOKEN_URL: &str = "https://open.spotify.com/api/token";
const PARTNER_QUERY_URL: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
const TOKEN_PRODUCT_TYPE: &str = "web-player";
const TOKEN_REASON: &str = "init";
const TOTP_VERSION: &str = "61";
const TOTP_SOURCE_SECRET: &str = ",7/*F(\"rLJ2oxaKL^f+E1xvP@N";
const PLAYLIST_QUERY_OPERATION: &str = "queryPlaylist";
const PLAYLIST_QUERY_HASH: &str =
    "908a5597b4d0af0489a9ad6a2d41bc3b416ff47c0884016d92bbd6822d0eb6d8";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const TOKEN_EXPIRY_MARGIN_MS: u64 = 60_000;
const USER_AGENT_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
    (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

type HmacSha1 = Hmac<Sha1>;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct PublicPlaylistChunk {
    pub(crate) playlist_id: String,
    pub(crate) offset: usize,
    pub(crate) limit: usize,
    pub(crate) total_count: u64,
    pub(crate) next_offset: Option<usize>,
    pub(crate) truncated_at_position_limit: bool,
    pub(crate) positions: Vec<PublicPlaylistPosition>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct PublicPlaylistPosition {
    pub(crate) position: usize,
    pub(crate) outcome: PublicPlaylistPositionOutcome,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PublicPlaylistPositionOutcome {
    Track { summary: FavoriteSummary },
    Skipped { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PublicCatalogError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) retry_after_seconds: Option<u64>,
}

impl PublicCatalogError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_seconds: None,
        }
    }

    fn rate_limited(retry_after_seconds: Option<u64>) -> Self {
        Self {
            code: "spotify_rate_limited",
            message: "Spotify temporarily rate-limited the public playlist request".to_string(),
            retry_after_seconds,
        }
    }

    fn contract_outdated() -> Self {
        Self::new(
            "spotify_public_contract_outdated",
            "Spotify changed its public playlist response; Echo needs an update before retrying",
        )
    }
}

impl fmt::Display for PublicCatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PublicCatalogError {}

struct AnonymousToken {
    access_token: String,
    expires_at_ms: u64,
}

static ANONYMOUS_TOKEN: OnceLock<Mutex<Option<AnonymousToken>>> = OnceLock::new();

fn anonymous_token_cache() -> &'static Mutex<Option<AnonymousToken>> {
    ANONYMOUS_TOKEN.get_or_init(|| Mutex::new(None))
}

/// Fetch exactly one user-requested, ordered 50-position public-playlist chunk.
///
/// The anonymous access token is retained only in process memory. This function
/// never persists it, includes it in an error, or logs it.
pub(crate) async fn fetch_public_playlist_chunk(
    client: &reqwest::Client,
    playlist_id: &str,
    offset: usize,
) -> Result<PublicPlaylistChunk, PublicCatalogError> {
    validate_chunk_request(playlist_id, offset)?;
    let access_token = anonymous_access_token(client).await?;
    let request_body = PlaylistQueryRequest {
        variables: PlaylistQueryVariables {
            uri: format!("spotify:playlist:{playlist_id}"),
            limit: PUBLIC_PLAYLIST_CHUNK_SIZE,
            offset,
        },
        operation_name: PLAYLIST_QUERY_OPERATION,
        extensions: PlaylistQueryExtensions {
            persisted_query: PersistedQuery {
                version: 1,
                sha256_hash: PLAYLIST_QUERY_HASH,
            },
        },
    };

    let response = client
        .post(PARTNER_QUERY_URL)
        .timeout(REQUEST_TIMEOUT)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(ORIGIN, "https://open.spotify.com")
        .header(REFERER, "https://open.spotify.com/")
        .bearer_auth(&access_token)
        .json(&request_body)
        .send()
        .await
        .map_err(|_| {
            PublicCatalogError::new(
                "spotify_public_transport",
                "Spotify's public playlist service could not be reached",
            )
        })?;

    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(PublicCatalogError::rate_limited(retry_after_seconds(
            &response,
        )));
    }
    if status == reqwest::StatusCode::BAD_REQUEST || status == reqwest::StatusCode::UNAUTHORIZED {
        if status == reqwest::StatusCode::UNAUTHORIZED {
            invalidate_anonymous_token(&access_token).await;
        }
        return Err(PublicCatalogError::contract_outdated());
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(PublicCatalogError::new(
            "spotify_public_playlist_not_found",
            "Spotify could not find that public playlist",
        ));
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(PublicCatalogError::new(
            "spotify_public_playlist_unavailable",
            "Spotify is not sharing that playlist publicly",
        ));
    }
    if !status.is_success() {
        return Err(PublicCatalogError::new(
            "spotify_public_upstream",
            "Spotify's public playlist service returned an error",
        ));
    }

    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| PublicCatalogError::contract_outdated())?;
    normalize_playlist_query_response(playlist_id, offset, &body)
}

fn validate_chunk_request(playlist_id: &str, offset: usize) -> Result<(), PublicCatalogError> {
    if !valid_spotify_id(playlist_id) {
        return Err(PublicCatalogError::new(
            "invalid_spotify_playlist_id",
            "invalid Spotify playlist ID",
        ));
    }
    if offset % PUBLIC_PLAYLIST_CHUNK_SIZE != 0 || offset >= MAX_PUBLIC_PLAYLIST_POSITIONS {
        return Err(PublicCatalogError::new(
            "invalid_spotify_playlist_offset",
            format!(
                "playlist offset must be a 50-position boundary below {MAX_PUBLIC_PLAYLIST_POSITIONS}"
            ),
        ));
    }
    Ok(())
}

async fn anonymous_access_token(client: &reqwest::Client) -> Result<String, PublicCatalogError> {
    let mut cached = anonymous_token_cache().lock().await;
    let now_ms = unix_time_ms()?;
    if let Some(token) = cached.as_ref() {
        if token.expires_at_ms.saturating_sub(now_ms) > TOKEN_EXPIRY_MARGIN_MS {
            return Ok(token.access_token.clone());
        }
    }

    let token = request_anonymous_token(client, now_ms).await?;
    let access_token = token.access_token.clone();
    *cached = Some(token);
    Ok(access_token)
}

async fn request_anonymous_token(
    client: &reqwest::Client,
    local_time_ms: u64,
) -> Result<AnonymousToken, PublicCatalogError> {
    let server_time_response = client
        .get(SERVER_TIME_URL)
        .timeout(REQUEST_TIMEOUT)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| {
            PublicCatalogError::new(
                "spotify_public_transport",
                "Spotify's public time service could not be reached",
            )
        })?;
    let server_status = server_time_response.status();
    if server_status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(PublicCatalogError::rate_limited(retry_after_seconds(
            &server_time_response,
        )));
    }
    if !server_status.is_success() {
        return Err(PublicCatalogError::new(
            "spotify_public_upstream",
            "Spotify's public time service returned an error",
        ));
    }
    let server_time = server_time_response
        .json::<ServerTimeResponse>()
        .await
        .map_err(|_| PublicCatalogError::contract_outdated())?
        .server_time;
    let server_time_ms = server_time
        .checked_mul(1_000)
        .ok_or_else(PublicCatalogError::contract_outdated)?;
    let local_totp = totp_at_ms(local_time_ms);
    let server_totp = totp_at_ms(server_time_ms);

    let token_response = client
        .get(TOKEN_URL)
        .timeout(REQUEST_TIMEOUT)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, USER_AGENT_VALUE)
        .query(&[
            ("reason", TOKEN_REASON),
            ("productType", TOKEN_PRODUCT_TYPE),
            ("totp", local_totp.as_str()),
            ("totpServer", server_totp.as_str()),
            ("totpVer", TOTP_VERSION),
        ])
        .send()
        .await
        .map_err(|_| {
            PublicCatalogError::new(
                "spotify_public_transport",
                "Spotify's anonymous token service could not be reached",
            )
        })?;
    let token_status = token_response.status();
    if token_status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(PublicCatalogError::rate_limited(retry_after_seconds(
            &token_response,
        )));
    }
    if token_status == reqwest::StatusCode::BAD_REQUEST
        || token_status == reqwest::StatusCode::UNAUTHORIZED
    {
        return Err(PublicCatalogError::contract_outdated());
    }
    if !token_status.is_success() {
        return Err(PublicCatalogError::new(
            "spotify_public_upstream",
            "Spotify's anonymous token service returned an error",
        ));
    }

    let body = token_response
        .json::<TokenResponse>()
        .await
        .map_err(|_| PublicCatalogError::contract_outdated())?;
    if !body.is_anonymous
        || body.access_token.trim().is_empty()
        || body.access_token_expiration_timestamp_ms <= local_time_ms
    {
        return Err(PublicCatalogError::contract_outdated());
    }
    Ok(AnonymousToken {
        access_token: body.access_token,
        expires_at_ms: body.access_token_expiration_timestamp_ms,
    })
}

async fn invalidate_anonymous_token(rejected_token: &str) {
    let mut cached = anonymous_token_cache().lock().await;
    if cached
        .as_ref()
        .is_some_and(|token| token.access_token == rejected_token)
    {
        *cached = None;
    }
}

fn retry_after_seconds(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn unix_time_ms() -> Result<u64, PublicCatalogError> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            PublicCatalogError::new(
                "system_clock_invalid",
                "the system clock is earlier than the Unix epoch",
            )
        })?
        .as_millis();
    u64::try_from(milliseconds).map_err(|_| {
        PublicCatalogError::new("system_clock_invalid", "the system clock is out of range")
    })
}

fn totp_secret() -> Vec<u8> {
    TOTP_SOURCE_SECRET
        .encode_utf16()
        .enumerate()
        .map(|(index, code_unit)| u32::from(code_unit) ^ u32::try_from(index % 33 + 9).unwrap())
        .map(|value| value.to_string())
        .collect::<String>()
        .into_bytes()
}

fn totp_at_ms(timestamp_ms: u64) -> String {
    let counter = timestamp_ms / 1_000 / 30;
    let mut mac = HmacSha1::new_from_slice(&totp_secret())
        .expect("Spotify's public TOTP secret has a valid HMAC key length");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[digest.len() - 1] & 0x0f);
    let binary = (u32::from(digest[offset]) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    format!("{:06}", (binary & 0x7fff_ffff) % 1_000_000)
}

fn normalize_playlist_query_response(
    playlist_id: &str,
    offset: usize,
    body: &serde_json::Value,
) -> Result<PublicPlaylistChunk, PublicCatalogError> {
    if graphql_reports_persisted_query_failure(body) {
        return Err(PublicCatalogError::contract_outdated());
    }
    let playlist = body
        .get("data")
        .and_then(|value| value.get("playlistV2"))
        .ok_or_else(|| graphql_response_error(body))?;
    match playlist
        .get("__typename")
        .and_then(serde_json::Value::as_str)
    {
        Some("NotFound") => {
            return Err(PublicCatalogError::new(
                "spotify_public_playlist_not_found",
                "Spotify could not find that public playlist",
            ));
        }
        Some("GenericError") => {
            return Err(PublicCatalogError::new(
                "spotify_public_playlist_unavailable",
                "Spotify could not load that public playlist",
            ));
        }
        _ => {}
    }
    let content = playlist
        .get("content")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(PublicCatalogError::contract_outdated)?;
    let total_count = content
        .get("totalCount")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(PublicCatalogError::contract_outdated)?;
    let items = content
        .get("items")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(PublicCatalogError::contract_outdated)?;
    if items.len() > PUBLIC_PLAYLIST_CHUNK_SIZE {
        return Err(PublicCatalogError::contract_outdated());
    }

    let raw_next_offset = content
        .get("pagingInfo")
        .and_then(|value| value.get("nextOffset"))
        .map(|value| {
            if value.is_null() {
                Ok(None)
            } else {
                value
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .map(Some)
                    .ok_or_else(PublicCatalogError::contract_outdated)
            }
        })
        .transpose()?
        .flatten();
    if let Some(next_offset) = raw_next_offset {
        if next_offset != offset + PUBLIC_PLAYLIST_CHUNK_SIZE
            || items.len() != PUBLIC_PLAYLIST_CHUNK_SIZE
        {
            return Err(PublicCatalogError::contract_outdated());
        }
    }

    let positions = items
        .iter()
        .enumerate()
        .map(|(index, wrapper)| PublicPlaylistPosition {
            position: offset + index,
            outcome: normalize_public_track(wrapper),
        })
        .collect();
    let next_offset = raw_next_offset.filter(|value| *value < MAX_PUBLIC_PLAYLIST_POSITIONS);
    Ok(PublicPlaylistChunk {
        playlist_id: playlist_id.to_string(),
        offset,
        limit: PUBLIC_PLAYLIST_CHUNK_SIZE,
        total_count,
        next_offset,
        truncated_at_position_limit: total_count > MAX_PUBLIC_PLAYLIST_POSITIONS as u64,
        positions,
    })
}

fn graphql_reports_persisted_query_failure(body: &serde_json::Value) -> bool {
    body.get("errors")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|error| error.get("message"))
        .filter_map(serde_json::Value::as_str)
        .any(|message| {
            let normalized = message.to_ascii_lowercase();
            normalized.contains("persistedquery") || normalized.contains("persisted query")
        })
}

fn graphql_response_error(body: &serde_json::Value) -> PublicCatalogError {
    if body
        .get("errors")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|errors| !errors.is_empty())
    {
        PublicCatalogError::new(
            "spotify_public_upstream",
            "Spotify's public playlist query returned an error",
        )
    } else {
        PublicCatalogError::contract_outdated()
    }
}

fn normalize_public_track(wrapper: &serde_json::Value) -> PublicPlaylistPositionOutcome {
    let item = match wrapper.get("itemV2") {
        Some(item) => item,
        None => return skipped("malformed"),
    };
    if item
        .get("__typename")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| kind != "TrackResponseWrapper")
    {
        return skipped("non_track");
    }
    let track = match item.get("data") {
        Some(track) if !track.is_null() => track,
        _ => return skipped("malformed"),
    };
    if track
        .get("__typename")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| kind != "Track")
    {
        return skipped("non_track");
    }
    if track
        .get("playability")
        .and_then(|value| value.get("playable"))
        .and_then(serde_json::Value::as_bool)
        == Some(false)
    {
        return skipped("unplayable");
    }
    let spotify_uri = match trimmed_string(track.get("uri")) {
        Some(uri) if uri.starts_with("spotify:local:") => return skipped("local_track"),
        Some(uri) => uri,
        None => return skipped("malformed"),
    };
    let spotify_id = match spotify_uri.strip_prefix("spotify:track:") {
        Some(id) if valid_spotify_id(id) => id.to_string(),
        _ => return skipped("malformed"),
    };
    let name = match trimmed_string(track.get("name")) {
        Some(name) => name,
        None => return skipped("malformed"),
    };
    let artist_names = track
        .get("artists")
        .and_then(|value| value.get("items"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|artist| artist.get("profile"))
        .filter_map(|profile| trimmed_string(profile.get("name")))
        .collect::<Vec<_>>();
    if artist_names.is_empty() {
        return skipped("malformed");
    }
    let artwork_url = track
        .get("albumOfTrack")
        .and_then(|album| album.get("coverArt"))
        .and_then(|cover_art| cover_art.get("sources"))
        .and_then(serde_json::Value::as_array)
        .and_then(|sources| {
            sources
                .iter()
                .find_map(|source| trimmed_string(source.get("url")))
        });
    let duration_ms = track
        .get("duration")
        .and_then(|duration| duration.get("totalMilliseconds"))
        .and_then(serde_json::Value::as_u64);
    let explicit = track
        .get("contentRating")
        .and_then(|rating| trimmed_string(rating.get("label")))
        .and_then(|label| match label.as_str() {
            "EXPLICIT" => Some(true),
            "NONE" => Some(false),
            _ => None,
        });

    PublicPlaylistPositionOutcome::Track {
        summary: FavoriteSummary {
            spotify_uri,
            spotify_url: format!("https://open.spotify.com/track/{spotify_id}"),
            spotify_id,
            name,
            artist: Some(artist_names.join(", ")),
            owner: None,
            description: None,
            artwork_url,
            duration_ms,
            track_count: None,
            snapshot_id: None,
            explicit,
        },
    }
}

fn trimmed_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn skipped(reason: &str) -> PublicPlaylistPositionOutcome {
    PublicPlaylistPositionOutcome::Skipped {
        reason: reason.to_string(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerTimeResponse {
    server_time: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    access_token_expiration_timestamp_ms: u64,
    is_anonymous: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistQueryRequest<'a> {
    variables: PlaylistQueryVariables,
    operation_name: &'a str,
    extensions: PlaylistQueryExtensions<'a>,
}

#[derive(Serialize)]
struct PlaylistQueryVariables {
    uri: String,
    limit: usize,
    offset: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistQueryExtensions<'a> {
    persisted_query: PersistedQuery<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedQuery<'a> {
    version: u8,
    sha256_hash: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn track(id: &str, name: &str) -> serde_json::Value {
        json!({
            "itemV2": {
                "__typename": "TrackResponseWrapper",
                "data": {
                    "__typename": "Track",
                    "uri": format!("spotify:track:{id}"),
                    "name": name,
                    "artists": {"items": [
                        {"profile": {"name": "Artist One"}},
                        {"profile": {"name": "Artist Two"}}
                    ]},
                    "albumOfTrack": {"coverArt": {"sources": [
                        {"url": "https://i.scdn.co/image/test"}
                    ]}},
                    "duration": {"totalMilliseconds": 123456},
                    "playability": {"playable": true},
                    "contentRating": {"label": "EXPLICIT"}
                }
            }
        })
    }

    #[test]
    fn spotify_totp_v61_is_deterministic() {
        assert_eq!(totp_at_ms(0), "204513");
        assert_eq!(totp_at_ms(30_000), "332823");
        assert_eq!(totp_at_ms(1_700_000_000_000), "371599");
        assert_eq!(totp_at_ms(1_753_891_200_000), "659962");
    }

    #[test]
    fn graphql_normalization_preserves_positions_duplicates_and_skips() {
        let duplicate_id = "0123456789ABCDEFGHIJKL";
        let mut unplayable = track("ABCDEFGHIJKLMNOPQRSTUV", "Unavailable");
        unplayable["itemV2"]["data"]["playability"]["playable"] = json!(false);
        let body = json!({
            "data": {"playlistV2": {
                "__typename": "Playlist",
                "content": {
                    "totalCount": 204,
                    "pagingInfo": {"nextOffset": null},
                    "items": [
                        track(duplicate_id, "First Copy"),
                        {"itemV2": {"__typename": "EpisodeResponseWrapper", "data": {}}},
                        track(duplicate_id, "Second Copy"),
                        unplayable
                    ]
                }
            }}
        });

        let chunk =
            normalize_playlist_query_response("2a514BsnnFkgMBxVrCAOEj", 200, &body).unwrap();
        assert_eq!(chunk.total_count, 204);
        assert_eq!(chunk.next_offset, None);
        assert_eq!(chunk.positions.len(), 4);
        assert_eq!(chunk.positions[0].position, 200);
        assert_eq!(chunk.positions[1].position, 201);
        assert_eq!(chunk.positions[2].position, 202);
        assert_eq!(chunk.positions[3].position, 203);

        let ids = chunk
            .positions
            .iter()
            .filter_map(|position| match &position.outcome {
                PublicPlaylistPositionOutcome::Track { summary } => {
                    Some(summary.spotify_id.as_str())
                }
                PublicPlaylistPositionOutcome::Skipped { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![duplicate_id, duplicate_id]);
        assert!(matches!(
            &chunk.positions[1].outcome,
            PublicPlaylistPositionOutcome::Skipped { reason } if reason == "non_track"
        ));
        assert!(matches!(
            &chunk.positions[3].outcome,
            PublicPlaylistPositionOutcome::Skipped { reason } if reason == "unplayable"
        ));

        let PublicPlaylistPositionOutcome::Track { summary } = &chunk.positions[0].outcome else {
            panic!("expected normalized track")
        };
        assert_eq!(summary.artist.as_deref(), Some("Artist One, Artist Two"));
        assert_eq!(summary.duration_ms, Some(123456));
        assert_eq!(summary.explicit, Some(true));
        assert_eq!(
            summary.artwork_url.as_deref(),
            Some("https://i.scdn.co/image/test")
        );
    }

    #[test]
    fn graphql_contract_failures_are_stable() {
        let persisted_query_error = json!({
            "errors": [{"message": "PersistedQueryNotFound"}]
        });
        let error =
            normalize_playlist_query_response("2a514BsnnFkgMBxVrCAOEj", 0, &persisted_query_error)
                .unwrap_err();
        assert_eq!(error.code, "spotify_public_contract_outdated");

        let oversized_page = json!({
            "data": {"playlistV2": {"content": {
                "totalCount": 51,
                "pagingInfo": {"nextOffset": 50},
                "items": (0..51).map(|_| track("0123456789ABCDEFGHIJKL", "Track")).collect::<Vec<_>>()
            }}}
        });
        let error = normalize_playlist_query_response("2a514BsnnFkgMBxVrCAOEj", 0, &oversized_page)
            .unwrap_err();
        assert_eq!(error.code, "spotify_public_contract_outdated");
    }

    #[test]
    fn public_playlist_requests_use_fifty_position_boundaries() {
        assert!(validate_chunk_request("2a514BsnnFkgMBxVrCAOEj", 0).is_ok());
        assert!(validate_chunk_request("2a514BsnnFkgMBxVrCAOEj", 50).is_ok());
        assert!(validate_chunk_request("2a514BsnnFkgMBxVrCAOEj", 25).is_err());
        assert!(validate_chunk_request("2a514BsnnFkgMBxVrCAOEj", 1_000).is_err());
    }
}
