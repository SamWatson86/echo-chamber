//! A dedicated, single-song context for Spotify's Windows player. Preparation
//! never sends a Player command and must finish before the playback guard starts.
use super::*;
use rand::{rngs::OsRng, RngCore};
use reqwest::Method;
use serde_json::{json, Value};

const API: &str = "https://api.spotify.com/v1";
const HELPER_NAME: &str = "Echo Jam Playback";
pub(super) const START_SCOPES: [&str; 2] = ["playlist-modify-private", "playlist-read-private"];
type ContextError = (StatusCode, String);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct SpotifyPlaybackContext {
    owner_id: String,
    #[serde(default)]
    account_id: Option<String>,
    marker: String,
    playlist_id: Option<String>,
    // Persisted BEFORE POST. An uncertain create may only be recovered by its
    // random marker, never by sending another create on the next state poll.
    create_attempted: bool,
}

impl SpotifyPlaybackContext {
    fn new(profile: &Value) -> Result<Self, ContextError> {
        let mut random = [0u8; 24];
        OsRng.fill_bytes(&mut random);
        Ok(Self {
            owner_id: account_owner(profile)?.to_string(),
            account_id: profile["account_id"].as_str().map(str::to_string),
            marker: random.iter().map(|byte| format!("{byte:02x}")).collect(),
            playlist_id: None,
            create_attempted: false,
        })
    }

    pub(super) fn belongs_to(&self, profile: &Value) -> bool {
        profile["id"].as_str() == Some(self.owner_id.as_str())
            && self
                .account_id
                .as_deref()
                .is_none_or(|account| profile["account_id"].as_str() == Some(account))
    }

    fn description(&self) -> String {
        format!(
            "Echo Chamber playback helper [{}]. Its contents are replaced when a Jam starts.",
            self.marker
        )
    }

    fn owns_playlist(&self, playlist: &Value) -> bool {
        // Spotify can report `public: true` after accepting public:false. That
        // visibility field is not an ownership/identity signal; the saved ID,
        // owner and management marker are verified before replacing any items.
        playlist["owner"]["id"].as_str() == Some(self.owner_id.as_str())
            && playlist["collaborative"].as_bool() == Some(false)
            && playlist["id"].as_str().is_some_and(valid_spotify_id)
    }

    fn valid(&self) -> bool {
        !self.owner_id.is_empty()
            && self.account_id.as_deref().is_none_or(|id| !id.is_empty())
            && self.marker.len() == 48
            && self.marker.bytes().all(|byte| byte.is_ascii_hexdigit())
            && self.playlist_id.as_deref().is_none_or(valid_spotify_id)
            && (self.playlist_id.is_none() || self.create_attempted)
    }
}

fn preparation_error(message: &str) -> ContextError {
    (StatusCode::SERVICE_UNAVAILABLE, format!("Spotify playback helper is not ready: {message}. No playback was submitted; the song is still waiting. Fix the Spotify connection, then reconnect Spotify or add a song to retry"))
}

fn account_owner(profile: &Value) -> Result<&str, ContextError> {
    profile["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| preparation_error("Spotify did not identify the connected account"))
}

fn verified_single_seed(items: &Value, seed: &str) -> bool {
    let Some(entries) = items["items"].as_array() else {
        return false;
    };
    if entries.len() != 1
        || items["total"].as_u64() != Some(1)
        || items.get("next").is_none_or(|next| !next.is_null())
    {
        return false;
    }
    // Current API uses `item`; older extended-quota accounts may use `track`.
    let entry = &entries[0];
    let track = entry
        .get("item")
        .or_else(|| entry.get("track"))
        .unwrap_or(&Value::Null);
    entry["is_local"].as_bool() != Some(true)
        && track["type"].as_str() == Some("track")
        && track["is_playable"].as_bool() != Some(false)
        && track["uri"].as_str() == Some(seed)
}

fn start_body(context_uri: &str) -> Value {
    json!({"context_uri": context_uri, "offset": {"position": 0}, "position_ms": 0})
}

// Injected I/O keeps the actual create/recovery/replace/readback ordering under
// async regression coverage without calling a real Spotify account.
async fn prepare_with<Request, RequestFuture, Save, SaveFuture>(
    saved: Option<SpotifyPlaybackContext>,
    seed: &str,
    mut request: Request,
    mut save: Save,
) -> Result<String, ContextError>
where
    Request: FnMut(Method, String, Option<Value>) -> RequestFuture,
    RequestFuture: Future<Output = Result<Value, ContextError>>,
    Save: FnMut(SpotifyPlaybackContext) -> SaveFuture,
    SaveFuture: Future<Output = Result<(), ContextError>>,
{
    if !seed
        .strip_prefix("spotify:track:")
        .is_some_and(valid_spotify_id)
    {
        return Err(preparation_error("the requested song URI is invalid"));
    }
    if saved.as_ref().is_some_and(|context| !context.valid()) {
        return Err(preparation_error("the saved helper metadata is invalid"));
    }
    let profile = request(Method::GET, format!("{API}/me"), None).await?;
    account_owner(&profile)?;
    let mut context = match saved {
        Some(context) if context.belongs_to(&profile) => context,
        Some(_) => {
            return Err(preparation_error(
                "the saved helper belongs to another Spotify account; reconnect Spotify",
            ))
        }
        None => SpotifyPlaybackContext::new(&profile)?,
    };
    if context.playlist_id.is_none() && context.create_attempted {
        // Recover a lost create response by an unguessable, previously persisted
        // marker AND owner. A same-name user playlist is never adopted.
        let mut offset = 0;
        for _ in 0..20 {
            let page = request(
                Method::GET,
                format!("{API}/me/playlists?limit=50&offset={offset}"),
                None,
            )
            .await?;
            let playlists = page["items"]
                .as_array()
                .ok_or_else(|| preparation_error("Spotify returned an invalid helper listing"))?;
            for playlist in playlists {
                if context.owns_playlist(playlist)
                    && playlist["description"].as_str() == Some(context.description().as_str())
                {
                    let id = playlist["id"].as_str().unwrap().to_string();
                    if context
                        .playlist_id
                        .as_ref()
                        .is_some_and(|found| *found != id)
                    {
                        return Err(preparation_error(
                            "multiple playlists have the saved helper marker",
                        ));
                    }
                    context.playlist_id = Some(id);
                }
            }
            if page["next"].is_null() {
                break;
            }
            offset += 50;
            if offset == 1000 {
                return Err(preparation_error(
                    "helper discovery exceeded its bounded playlist scan",
                ));
            }
        }
        if context.playlist_id.is_none() {
            return Err(preparation_error("a previous helper creation is unconfirmed; no second playlist will be created automatically"));
        }
        save(context.clone()).await?;
    }
    if context.playlist_id.is_none() {
        context.create_attempted = true;
        save(context.clone()).await?;
        let created = request(
            Method::POST,
            format!("{API}/me/playlists"),
            Some(json!({
                "name": HELPER_NAME, "public": false, "collaborative": false,
                "description": context.description(),
            })),
        )
        .await;
        let created = match created {
            Ok(created) => created,
            Err(error) => {
                if matches!(
                    error.0,
                    StatusCode::BAD_REQUEST
                        | StatusCode::UNAUTHORIZED
                        | StatusCode::FORBIDDEN
                        | StatusCode::NOT_FOUND
                        | StatusCode::TOO_MANY_REQUESTS
                ) {
                    context.create_attempted = false;
                    save(context.clone()).await?;
                }
                return Err(error);
            }
        };
        if !context.owns_playlist(&created) {
            return Err(preparation_error(
                "Spotify did not confirm the created helper's ownership and settings",
            ));
        }
        context.playlist_id = created["id"].as_str().map(str::to_string);
        save(context.clone()).await?;
    }
    let id = context.playlist_id.as_deref().unwrap();
    if !valid_spotify_id(id) {
        return Err(preparation_error("the saved helper ID is invalid"));
    }
    let playlist = request(Method::GET, format!("{API}/playlists/{id}"), None).await?;
    if playlist["id"].as_str() != Some(id)
        || !context.owns_playlist(&playlist)
        || playlist["description"].as_str() != Some(context.description().as_str())
    {
        return Err(preparation_error(
            "the saved helper's owner or settings changed; it was not modified",
        ));
    }
    request(
        Method::PUT,
        format!("{API}/playlists/{id}/items"),
        Some(json!({"uris": [seed]})),
    )
    .await?;
    let items = request(
        Method::GET,
        format!("{API}/playlists/{id}/items?limit=2"),
        None,
    )
    .await?;
    if !verified_single_seed(&items, seed) {
        return Err(preparation_error(
            "the requested song is unavailable or its exact single-song identity could not be verified",
        ));
    }
    Ok(format!("spotify:playlist:{id}"))
}

pub(super) async fn prepare(state: &AppState, seed: &str) -> Result<Value, ContextError> {
    let saved = {
        let jam = state.jam.lock().unwrap_or_else(|error| error.into_inner());
        if !spotify_start_scopes_authorized(jam.spotify_token.as_ref()) {
            return Err((StatusCode::FORBIDDEN,
                "The host must Reconnect Spotify to allow automatic song startup. The song is still waiting in the Jam queue".to_string()));
        }
        jam.spotify_token
            .as_ref()
            .and_then(|token| token.playback_context.clone())
    };
    let context_uri = prepare_with(saved, seed,
        |method, url, body| async move {
            crate::jam_library::spotify_json_request(state, method, &url, body).await
                .map_err(|error| (error.status, format!("Could not prepare Spotify playback: {}. No playback was submitted; reconnect Spotify or add a song to retry", error.message)))
        },
        |context| async move {
            // Caller holds jam_lifecycle. Match token replacement's lock order;
            // refresh cannot overwrite a newly saved create fence/helper ID.
            let _refresh = state.spotify_refresh_lock.lock().await;
            let mut token = state.jam.lock().unwrap_or_else(|error| error.into_inner())
                .spotify_token.clone().ok_or_else(|| preparation_error("Spotify was disconnected"))?;
            token.playback_context = Some(context);
            if !persist_spotify_token(&state.spotify_token_file, &token, state.spotify_token_storage_enabled) {
                return Err(preparation_error("the helper identity could not be saved privately"));
            }
            state.jam.lock().unwrap_or_else(|error| error.into_inner()).spotify_token = Some(token);
            Ok(())
        },
    ).await?;
    Ok(start_body(&context_uri))
}

#[cfg(test)]
#[path = "playback_context_tests.rs"]
mod tests;
