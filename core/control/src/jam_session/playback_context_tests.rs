use super::*;
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

const SEED: &str = "spotify:track:0123456789ABCDEFGHIJKL";
const PLAYLIST: &str = "abcdefghijklmnopqrstuv";

fn profile() -> Value {
    json!({"id": "owner", "account_id": "stable-account"})
}
fn context() -> SpotifyPlaybackContext {
    SpotifyPlaybackContext {
        owner_id: "owner".into(),
        account_id: Some("stable-account".into()),
        marker: "0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        playlist_id: Some(PLAYLIST.into()),
        create_attempted: true,
    }
}
fn playlist(context: &SpotifyPlaybackContext) -> Value {
    json!({"id": PLAYLIST, "name": HELPER_NAME, "owner": {"id": "owner"},
        "public": false, "collaborative": false, "description": context.description()})
}
fn items() -> Value {
    json!({"total":1, "next":null, "items":[{"item":{"uri":SEED,"type":"track","is_playable":true}}]})
}

enum Reply {
    Value(Value),
    Created,
    CreatedWithoutDescription,
    Error(StatusCode),
    Discover,
    Wait(
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<Value>,
    ),
}
struct Step(Method, &'static str, Reply);
#[derive(Default)]
struct Harness {
    saved: RefCell<Option<SpotifyPlaybackContext>>,
    steps: RefCell<VecDeque<Step>>,
    events: RefCell<Vec<String>>,
    bodies: RefCell<Vec<Value>>,
    fail_save: bool,
}
impl Harness {
    fn new(saved: Option<SpotifyPlaybackContext>, steps: Vec<Step>) -> Rc<Self> {
        Rc::new(Self {
            saved: RefCell::new(saved),
            steps: RefCell::new(steps.into()),
            ..Self::default()
        })
    }
    async fn prepare(self: &Rc<Self>) -> Result<String, ContextError> {
        let saved = self.saved.borrow().clone();
        prepare_with(saved, SEED, |method, url, body| {
            let this = self.clone();
            async move {
                tokio::task::yield_now().await;
                let Step(expected_method, suffix, reply) = this.steps.borrow_mut().pop_front().expect("unexpected Spotify request");
                assert_eq!(method, expected_method);
                assert_eq!(url, format!("{API}{suffix}"));
                this.events.borrow_mut().push(format!("{method} {suffix}"));
                if let Some(body) = body { this.bodies.borrow_mut().push(body); }
                match reply {
                    Reply::Value(value) => Ok(value),
                    Reply::Created | Reply::CreatedWithoutDescription => {
                        let saved = this.saved.borrow();
                        let context = saved.as_ref().expect("create fence must be durable before POST");
                        assert!(context.create_attempted);
                        let mut result = playlist(context);
                        if matches!(reply, Reply::CreatedWithoutDescription) { result["description"] = Value::Null; }
                        Ok(result)
                    }
                    Reply::Discover => Ok(json!({"items":[
                        {"id":"other", "name":HELPER_NAME, "owner":{"id":"owner"}, "public":false, "collaborative":false, "description":"a user's playlist"},
                        playlist(this.saved.borrow().as_ref().unwrap())
                    ], "next":null})),
                    Reply::Error(status) => Err((status, "scripted upstream failure".into())),
                    Reply::Wait(waiting, reply) => {
                        waiting.send(()).unwrap();
                        Ok(reply.await.unwrap())
                    }
                }
            }
        }, |context| {
            let this = self.clone();
            async move {
                tokio::task::yield_now().await;
                this.events.borrow_mut().push("save".into());
                if this.fail_save { return Err(preparation_error("private storage failed")); }
                *this.saved.borrow_mut() = Some(context);
                Ok(())
            }
        }).await
    }
    fn finished(&self) {
        assert!(self.steps.borrow().is_empty(), "missing expected requests");
    }
}
fn existing_steps(metadata: Value, readback: Value) -> Vec<Step> {
    vec![
        Step(Method::GET, "/me", Reply::Value(profile())),
        Step(
            Method::GET,
            "/playlists/abcdefghijklmnopqrstuv",
            Reply::Value(metadata),
        ),
        Step(
            Method::PUT,
            "/playlists/abcdefghijklmnopqrstuv/items",
            Reply::Value(json!({"snapshot_id":"revision"})),
        ),
        Step(
            Method::GET,
            "/playlists/abcdefghijklmnopqrstuv/items?limit=2",
            Reply::Value(readback),
        ),
    ]
}

#[tokio::test]
async fn creates_unlisted_helper_once_and_verifies_one_seed_before_start() {
    let harness = Harness::new(
        None,
        vec![
            Step(Method::GET, "/me", Reply::Value(profile())),
            Step(
                Method::POST,
                "/me/playlists",
                Reply::CreatedWithoutDescription,
            ),
            // The marker is generated during preparation; use the same response
            // factory for the subsequent ownership validation.
            Step(
                Method::GET,
                "/playlists/abcdefghijklmnopqrstuv",
                Reply::Created,
            ),
            Step(
                Method::PUT,
                "/playlists/abcdefghijklmnopqrstuv/items",
                Reply::Value(json!({"snapshot_id":"new"})),
            ),
            Step(
                Method::GET,
                "/playlists/abcdefghijklmnopqrstuv/items?limit=2",
                Reply::Value(items()),
            ),
        ],
    );
    let prepared = harness.prepare().await.unwrap();
    assert_eq!(prepared, format!("spotify:playlist:{PLAYLIST}"));
    assert_eq!(
        harness.events.borrow().as_slice(),
        [
            "GET /me",
            "save",
            "POST /me/playlists",
            "save",
            "GET /playlists/abcdefghijklmnopqrstuv",
            "PUT /playlists/abcdefghijklmnopqrstuv/items",
            "GET /playlists/abcdefghijklmnopqrstuv/items?limit=2"
        ]
    );
    assert_eq!(harness.bodies.borrow()[0]["public"], false);
    assert_eq!(harness.bodies.borrow()[0]["collaborative"], false);
    assert_eq!(harness.bodies.borrow()[1], json!({"uris":[SEED]}));
    let body = start_body(&prepared);
    assert_eq!(
        body,
        json!({"context_uri":prepared,"offset":{"position":0},"position_ms":0})
    );
    assert!(body.get("uris").is_none());
    start_spotify_track_confirmed(
        SEED,
        || async {
            harness.events.borrow_mut().push("play".into());
            Ok(())
        },
        || async {
            tokio::task::yield_now().await;
            Ok(SpotifyPlacementObservation {
                playback_present: true,
                bound_device: true,
                is_playing: true,
                current_uri: Some(SEED.into()),
                ..Default::default()
            })
        },
        || async { panic!("already playing must not resume") },
        1,
        Duration::ZERO,
    )
    .await
    .unwrap();
    harness
        .events
        .borrow_mut()
        .push("successor may queue".into());
    assert_eq!(
        &harness.events.borrow()[7..],
        ["play", "successor may queue"]
    );
    harness.finished();
}

#[tokio::test]
async fn reuses_saved_owned_helper_without_creating_a_playlist() {
    let saved = context();
    let harness = Harness::new(
        Some(saved.clone()),
        existing_steps(playlist(&saved), items()),
    );
    assert!(harness.prepare().await.is_ok());
    assert_eq!(harness.bodies.borrow().as_slice(), [json!({"uris":[SEED]})]);
    assert_eq!(harness.saved.borrow().as_ref(), Some(&saved));
    harness.finished();
}

#[tokio::test]
async fn start_waits_for_single_seed_readback_and_timeout_leaves_create_fenced() {
    let saved = context();
    let (waiting, reached) = tokio::sync::oneshot::channel();
    let (release, reply) = tokio::sync::oneshot::channel();
    let mut steps = existing_steps(playlist(&saved), items());
    steps.last_mut().unwrap().2 = Reply::Wait(waiting, reply);
    let harness = Harness::new(Some(saved), steps);
    let played = std::cell::Cell::new(false);
    let (result, ()) = tokio::join!(
        async {
            let context_uri = harness.prepare().await?;
            assert_eq!(start_body(&context_uri)["offset"]["position"], 0);
            played.set(true);
            Ok::<_, ContextError>(())
        },
        async {
            reached.await.unwrap();
            assert!(
                !played.get(),
                "unverified preparation must never issue Play"
            );
            release.send(items()).unwrap();
        }
    );
    result.unwrap();
    assert!(played.get());
    harness.finished();

    let (waiting, reached) = tokio::sync::oneshot::channel();
    let (_never_release, reply) = tokio::sync::oneshot::channel();
    let harness = Harness::new(
        None,
        vec![
            Step(Method::GET, "/me", Reply::Value(profile())),
            Step(Method::POST, "/me/playlists", Reply::Wait(waiting, reply)),
        ],
    );
    let (result, ()) = tokio::join!(
        tokio::time::timeout(Duration::from_millis(10), harness.prepare()),
        async {
            reached.await.unwrap();
            assert!(harness.saved.borrow().as_ref().unwrap().create_attempted);
        }
    );
    assert!(result.is_err());
    let persisted = harness.saved.borrow();
    assert!(persisted.as_ref().unwrap().create_attempted);
    assert!(persisted.as_ref().unwrap().playlist_id.is_none());
}

#[tokio::test]
async fn malformed_persisted_helper_metadata_never_reaches_spotify() {
    for field in ["marker", "owner", "account", "id", "create_fence"] {
        let mut saved = context();
        match field {
            "marker" => saved.marker = "bad".into(),
            "owner" => saved.owner_id.clear(),
            "account" => saved.account_id = Some(String::new()),
            "id" => saved.playlist_id = Some("../arbitrary".into()),
            "create_fence" => saved.create_attempted = false,
            _ => unreachable!(),
        }
        let harness = Harness::new(Some(saved), vec![]);
        assert!(harness
            .prepare()
            .await
            .unwrap_err()
            .1
            .contains("metadata is invalid"));
        assert!(harness.events.borrow().is_empty());
    }
}

#[tokio::test]
async fn lost_create_response_recovers_by_owner_and_random_marker_without_second_post() {
    let harness = Harness::new(
        None,
        vec![
            Step(Method::GET, "/me", Reply::Value(profile())),
            Step(
                Method::POST,
                "/me/playlists",
                Reply::Error(StatusCode::BAD_GATEWAY),
            ),
        ],
    );
    assert!(harness.prepare().await.is_err());
    let saved = harness.saved.borrow().clone().unwrap();
    assert!(saved.create_attempted);
    assert!(saved.playlist_id.is_none());
    *harness.steps.borrow_mut() = vec![
        Step(Method::GET, "/me", Reply::Value(profile())),
        Step(
            Method::GET,
            "/me/playlists?limit=50&offset=0",
            Reply::Discover,
        ),
        Step(
            Method::GET,
            "/playlists/abcdefghijklmnopqrstuv",
            Reply::Value(playlist(&saved)),
        ),
        Step(
            Method::PUT,
            "/playlists/abcdefghijklmnopqrstuv/items",
            Reply::Value(json!({})),
        ),
        Step(
            Method::GET,
            "/playlists/abcdefghijklmnopqrstuv/items?limit=2",
            Reply::Value(items()),
        ),
    ]
    .into();
    assert!(harness.prepare().await.is_ok());
    assert_eq!(
        harness
            .events
            .borrow()
            .iter()
            .filter(|event| event.starts_with("POST"))
            .count(),
        1
    );
    assert_eq!(
        harness
            .saved
            .borrow()
            .as_ref()
            .unwrap()
            .playlist_id
            .as_deref(),
        Some(PLAYLIST)
    );
    harness.finished();
}

#[tokio::test]
async fn uncertain_creation_without_matching_marker_never_creates_again() {
    let mut saved = context();
    saved.playlist_id = None;
    let harness = Harness::new(
        Some(saved),
        vec![
            Step(Method::GET, "/me", Reply::Value(profile())),
            Step(
                Method::GET,
                "/me/playlists?limit=50&offset=0",
                Reply::Value(json!({"items":[],"next":null})),
            ),
        ],
    );
    assert!(harness
        .prepare()
        .await
        .unwrap_err()
        .1
        .contains("no second playlist"));
    harness.finished();
}

#[tokio::test]
async fn definite_create_rejection_can_retry_but_private_storage_failure_never_creates() {
    let harness = Harness::new(
        None,
        vec![
            Step(Method::GET, "/me", Reply::Value(profile())),
            Step(
                Method::POST,
                "/me/playlists",
                Reply::Error(StatusCode::FORBIDDEN),
            ),
        ],
    );
    assert!(harness.prepare().await.is_err());
    assert!(!harness.saved.borrow().as_ref().unwrap().create_attempted);
    harness.finished();
    let harness = Rc::new(Harness {
        fail_save: true,
        steps: RefCell::new(vec![Step(Method::GET, "/me", Reply::Value(profile()))].into()),
        ..Harness::default()
    });
    assert!(harness
        .prepare()
        .await
        .unwrap_err()
        .1
        .contains("private storage"));
    harness.finished();
}

#[tokio::test]
async fn rejects_changed_account_owner_visibility_collaboration_or_marker_before_replace() {
    for field in [
        "account",
        "owner",
        "public",
        "collaborative",
        "description",
        "id",
    ] {
        let saved = context();
        let mut meta = playlist(&saved);
        match field {
            "owner" => meta["owner"]["id"] = json!("different"),
            "public" | "collaborative" => meta[field] = json!(true),
            "description" => meta[field] = Value::Null,
            "id" => meta[field] = json!("zyxwvutsrqponmlkjihgfe"),
            _ => (),
        }
        let mut account = profile();
        if field == "account" {
            account["account_id"] = json!("another-account");
        }
        let mut steps = vec![Step(Method::GET, "/me", Reply::Value(account))];
        if field != "account" {
            steps.push(Step(
                Method::GET,
                "/playlists/abcdefghijklmnopqrstuv",
                Reply::Value(meta),
            ));
        }
        let harness = Harness::new(Some(saved), steps);
        assert!(harness.prepare().await.is_err(), "{field}");
        assert!(harness.bodies.borrow().is_empty());
        harness.finished();
    }
}

#[tokio::test]
async fn mismatched_extra_unavailable_or_unprovably_relinked_readback_never_reaches_play() {
    for field in ["uri", "total", "next", "empty", "is_playable", "type"] {
        let saved = context();
        let mut readback = items();
        match field {
            "uri" => {
                readback["items"][0]["item"]["uri"] = json!("spotify:track:zyxwvutsrqponmlkjihgfe")
            }
            "total" => readback["total"] = json!(2),
            "next" => readback["next"] = json!("next-page"),
            "empty" => readback["items"] = json!([]),
            "is_playable" => readback["items"][0]["item"][field] = json!(false),
            "type" => readback["items"][0]["item"][field] = json!("episode"),
            _ => unreachable!(),
        }
        let harness = Harness::new(
            Some(saved.clone()),
            existing_steps(playlist(&saved), readback),
        );
        assert!(harness.prepare().await.is_err(), "{field}");
        assert!(!harness
            .events
            .borrow()
            .iter()
            .any(|event| event.contains("/player")));
        harness.finished();
    }
}

#[test]
fn legacy_tokens_and_same_account_reconnect_preserve_scope_and_helper_boundaries() {
    let mut token: SpotifyToken = serde_json::from_value(
        json!({"access_token":"a","refresh_token":"r","expires_at":0,
        "scope":"playlist-read-private user-modify-playback-state"}),
    )
    .unwrap();
    assert!(token.playback_context.is_none());
    assert!(!spotify_start_scopes_authorized(Some(&token)));
    token.scope.push_str(" playlist-modify-private");
    assert!(spotify_start_scopes_authorized(Some(&token)));
    token.scope = "playlist-modify-private".into();
    assert!(!spotify_start_scopes_authorized(Some(&token)));
    assert!(!spotify_start_scopes_authorized(None));
    assert!(context().belongs_to(&profile()));
    assert!(!context().belongs_to(&json!({"id":"other","account_id":"stable-account"})));
    assert!(!context().belongs_to(&json!({"id":"owner","account_id":"other"})));
}

#[test]
fn refresh_preserves_latest_helper_identity_even_when_request_snapshot_predates_creation() {
    let old: SpotifyToken = serde_json::from_value(
        json!({"access_token":"old-access", "refresh_token":"old-refresh",
        "expires_at":1, "scope":"playlist-modify-private playlist-read-private"}),
    )
    .unwrap();
    let mut current = old.clone();
    current.playback_context = Some(context());
    let refreshed = spotify_token_from_refresh_response(
        &current,
        &json!({"access_token":"new-access", "expires_in":3600}),
        100,
    )
    .unwrap();
    assert_eq!(refreshed.playback_context, current.playback_context);
    assert_ne!(refreshed.playback_context, old.playback_context);
    assert_eq!(refreshed.scope, old.scope);
    assert!(spotify_start_scopes_authorized(Some(&refreshed)));
    assert_eq!(refreshed.refresh_token, "old-refresh");
    assert_eq!(refreshed.expires_at, 3700);
    let restricted = spotify_token_from_refresh_response(&refreshed,
        &json!({"access_token":"next-access","refresh_token":"rotated", "scope":"playlist-read-private"}), 200).unwrap();
    assert!(!spotify_start_scopes_authorized(Some(&restricted)));
    assert_eq!(restricted.refresh_token, "rotated");
    assert_eq!(restricted.playback_context, current.playback_context);
}

#[test]
fn preparation_failure_preserves_pending_seed_and_warning_without_unknown_frontier() {
    let track: QueuedTrack = serde_json::from_value(json!({
        "queue_entry_id":"seed", "spotify_uri":SEED, "name":"Seed", "artist":"Artist",
        "album_art_url":"", "duration_ms":1000, "added_by":"Listener"
    }))
    .unwrap();
    let mut jam = JamState {
        active: true,
        generation: 7,
        queue: vec![pending_queue_entry(track)],
        ..JamState::default()
    };
    let (status, message) = preparation_error("test");
    jam.spotify_start_error = Some((status, message.clone()));
    let error = definite_queue_commit_error(status, message.clone());
    record_queue_commit_error(&mut jam, 7, "seed", &error);
    assert_eq!(jam.queue[0].delivery_state, QueueDeliveryState::Pending);
    assert!(jam.queue[0].can_remove);
    assert_eq!(jam.queue_revision, 0);
    assert_eq!(jam.last_error.as_deref(), Some(message.as_str()));
    assert!(!queue_has_commit_unknown(&jam.queue));
    assert!(!playback_error_can_clear(&jam, false));
    remove_pending_queue_entries(&mut jam, &["seed".to_string()]).unwrap();
    assert!(jam.queue.is_empty());
    jam.spotify_start_error = None;
    assert!(playback_error_can_clear(&jam, false));
}
