use super::*;
use std::cell::RefCell;
use std::collections::VecDeque;

const SEED: &str = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA";
const OTHER: &str = "spotify:track:BBBBBBBBBBBBBBBBBBBBBB";

type PlaybackRead = Result<SpotifyPlacementObservation, (StatusCode, String)>;

fn selected(is_playing: bool) -> SpotifyPlacementObservation {
    SpotifyPlacementObservation {
        playback_present: true,
        bound_device: true,
        is_playing,
        current_uri: Some(SEED.to_string()),
        ..SpotifyPlacementObservation::default()
    }
}

fn empty_player() -> SpotifyPlacementObservation {
    SpotifyPlacementObservation {
        playback_present: true,
        bound_device: true,
        ..SpotifyPlacementObservation::default()
    }
}

struct ScriptResult {
    result: Result<(), QueueCommitError>,
    events: Vec<&'static str>,
    unread: usize,
}

async fn run_script(
    start_result: Result<(), QueueCommitError>,
    observations: Vec<(&'static str, PlaybackRead)>,
    resume_result: Result<(), (StatusCode, String)>,
    attempts: usize,
) -> ScriptResult {
    let events = RefCell::new(Vec::new());
    let reads = RefCell::new(VecDeque::from(observations));
    let resume_result = RefCell::new(Some(resume_result));
    let result = start_spotify_track_confirmed(
        SEED,
        || async {
            events.borrow_mut().push("start");
            tokio::task::yield_now().await;
            start_result
        },
        || {
            let (label, result) = reads.borrow_mut().pop_front().expect("unexpected read");
            let events = &events;
            async move {
                tokio::task::yield_now().await;
                events.borrow_mut().push(label);
                result
            }
        },
        || {
            let result = resume_result
                .borrow_mut()
                .take()
                .expect("resume must never be replayed");
            let events = &events;
            async move {
                events.borrow_mut().push("resume");
                tokio::task::yield_now().await;
                result
            }
        },
        attempts,
        Duration::ZERO,
    )
    .await;
    ScriptResult {
        result,
        events: events.into_inner(),
        unread: reads.into_inner().len(),
    }
}

fn assert_ambiguous_start(error: &QueueCommitError) {
    assert!(error.acceptance_ambiguous);
    assert_eq!(
        error.intended_placement,
        Some(SpotifyTrackPlacement::StartedCurrent)
    );
    assert!(error.message.contains("queue is preserved"));
}

#[tokio::test]
async fn acknowledged_start_waits_through_empty_playback_before_successor_can_run() {
    let events = RefCell::new(Vec::new());
    let reads = RefCell::new(VecDeque::from([
        ("read:204", SpotifyPlacementObservation::default()),
        ("read:200-null", empty_player()),
        ("read:playing", selected(true)),
    ]));
    let (confirm_tx, confirm_rx) = tokio::sync::oneshot::channel();
    let confirmation_gate = RefCell::new(Some(confirm_rx));
    let waiting_for_confirmation = tokio::sync::Notify::new();

    let enqueue_then_successor = async {
        start_spotify_track_confirmed(
            SEED,
            || async {
                events.borrow_mut().push("start");
                tokio::task::yield_now().await;
                Ok(())
            },
            || {
                let (label, observation) = reads.borrow_mut().pop_front().unwrap();
                let gate = if observation.is_playing {
                    confirmation_gate.borrow_mut().take()
                } else {
                    None
                };
                let events = &events;
                let waiting = &waiting_for_confirmation;
                async move {
                    tokio::task::yield_now().await;
                    if let Some(gate) = gate {
                        waiting.notify_one();
                        gate.await.expect("confirmation released");
                    }
                    events.borrow_mut().push(label);
                    Ok(observation)
                }
            },
            || async {
                panic!("empty playback must never be resumed");
                #[allow(unreachable_code)]
                Ok(())
            },
            3,
            Duration::ZERO,
        )
        .await?;
        // The queue pump can submit its successor only after placement returns.
        events.borrow_mut().push("queue:successor");
        Ok::<(), QueueCommitError>(())
    };
    tokio::pin!(enqueue_then_successor);
    tokio::select! {
        _ = waiting_for_confirmation.notified() => {},
        result = &mut enqueue_then_successor => panic!("start returned before confirmation: {result:?}"),
    }
    assert_eq!(*events.borrow(), ["start", "read:204", "read:200-null"]);
    confirm_tx.send(()).unwrap();
    enqueue_then_successor.await.unwrap();
    assert_eq!(
        *events.borrow(),
        [
            "start",
            "read:204",
            "read:200-null",
            "read:playing",
            "queue:successor"
        ]
    );
    assert!(reads.borrow().is_empty());
}

#[tokio::test]
async fn selected_paused_seed_is_resumed_once_and_then_confirmed() {
    let script = run_script(
        Ok(()),
        vec![
            ("paused", Ok(selected(false))),
            ("playing", Ok(selected(true))),
        ],
        Ok(()),
        2,
    )
    .await;
    script.result.unwrap();
    assert_eq!(script.events, ["start", "paused", "resume", "playing"]);
    assert_eq!(script.unread, 0);
}

#[tokio::test]
async fn accepted_start_with_persistently_empty_player_is_ambiguous_and_never_resumed() {
    let script = run_script(Ok(()), vec![("empty", Ok(empty_player())); 3], Ok(()), 3).await;
    let error = script.result.unwrap_err();
    assert_ambiguous_start(&error);
    assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(script.events, ["start", "empty", "empty", "empty"]);
    assert_eq!(script.unread, 0);
}

#[tokio::test]
async fn paused_seed_with_resume_disallowed_is_only_observed() {
    let mut paused = selected(false);
    paused.resume_disallowed = true;
    let script = run_script(Ok(()), vec![("paused", Ok(paused)); 3], Ok(()), 3).await;
    assert_ambiguous_start(&script.result.unwrap_err());
    assert_eq!(script.events, ["start", "paused", "paused", "paused"]);
    assert_eq!(script.unread, 0);
}

#[tokio::test]
async fn persistent_different_device_or_song_is_never_resumed() {
    let mut wrong_device = selected(false);
    wrong_device.bound_device = false;
    let mut wrong_song = selected(false);
    wrong_song.current_uri = Some(OTHER.to_string());
    for observation in [wrong_device, wrong_song] {
        let script = run_script(Ok(()), vec![("mismatch", Ok(observation)); 3], Ok(()), 3).await;
        assert_ambiguous_start(&script.result.unwrap_err());
        assert_eq!(script.events, ["start", "mismatch", "mismatch", "mismatch"]);
        assert_eq!(script.unread, 0);
    }
}

#[tokio::test]
async fn stale_device_and_song_observations_can_settle_without_resume() {
    let mut wrong_device = selected(true);
    wrong_device.bound_device = false;
    let mut wrong_song = selected(false);
    wrong_song.current_uri = Some(OTHER.to_string());
    let script = run_script(
        Ok(()),
        vec![
            ("old-device", Ok(wrong_device)),
            ("old-song", Ok(wrong_song)),
            ("playing", Ok(selected(true))),
        ],
        Ok(()),
        3,
    )
    .await;
    script.result.unwrap();
    assert_eq!(
        script.events,
        ["start", "old-device", "old-song", "playing"]
    );
    assert_eq!(script.unread, 0);
}

#[tokio::test]
async fn read_rate_limit_after_acceptance_is_immediately_ambiguous() {
    let script = run_script(
        Ok(()),
        vec![
            (
                "rate-limit",
                Err((StatusCode::TOO_MANY_REQUESTS, "rate limited".to_string())),
            ),
            ("unexpected", Ok(selected(true))),
        ],
        Ok(()),
        3,
    )
    .await;
    let error = script.result.unwrap_err();
    assert_ambiguous_start(&error);
    assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(script.events, ["start", "rate-limit"]);
    assert_eq!(script.unread, 1);
}

#[tokio::test]
async fn rejected_start_remains_definite_without_observation_or_resume() {
    let script = run_script(
        Err(definite_queue_commit_error(
            StatusCode::FORBIDDEN,
            "start forbidden".to_string(),
        )),
        vec![("unexpected", Ok(selected(true)))],
        Ok(()),
        3,
    )
    .await;
    let error = script.result.unwrap_err();
    assert!(!error.acceptance_ambiguous);
    assert_eq!(error.status, StatusCode::FORBIDDEN);
    assert_eq!(error.message, "start forbidden");
    assert_eq!(script.events, ["start"]);
    assert_eq!(script.unread, 1);
}

#[tokio::test]
async fn persistent_paused_seed_never_replays_start_or_resume() {
    let script = run_script(Ok(()), vec![("paused", Ok(selected(false))); 4], Ok(()), 4).await;
    assert_ambiguous_start(&script.result.unwrap_err());
    assert_eq!(
        script.events,
        ["start", "paused", "resume", "paused", "paused", "paused"]
    );
    assert_eq!(script.unread, 0);
}

#[tokio::test]
async fn rejected_resume_can_race_with_successful_initial_start() {
    for status in [StatusCode::FORBIDDEN, StatusCode::BAD_GATEWAY] {
        let script = run_script(
            Ok(()),
            vec![
                ("paused", Ok(selected(false))),
                ("playing", Ok(selected(true))),
            ],
            Err((status, "resume failed".to_string())),
            3,
        )
        .await;
        script.result.unwrap();
        assert_eq!(script.events, ["start", "paused", "resume", "playing"]);
        assert_eq!(script.unread, 0);
    }
}

#[tokio::test]
async fn rejected_resume_with_persistently_paused_seed_remains_ambiguous() {
    let script = run_script(
        Ok(()),
        vec![("paused", Ok(selected(false))); 3],
        Err((StatusCode::FORBIDDEN, "resume forbidden".to_string())),
        3,
    )
    .await;
    let error = script.result.unwrap_err();
    assert_ambiguous_start(&error);
    assert_eq!(error.status, StatusCode::FORBIDDEN);
    assert_eq!(
        script.events,
        ["start", "paused", "resume", "paused", "paused"]
    );
    assert_eq!(script.unread, 0);
}

#[tokio::test]
async fn rate_limited_resume_stops_reading_immediately() {
    let script = run_script(
        Ok(()),
        vec![
            ("paused", Ok(selected(false))),
            ("unexpected", Ok(selected(true))),
        ],
        Err((
            StatusCode::TOO_MANY_REQUESTS,
            "resume rate limited".to_string(),
        )),
        3,
    )
    .await;
    let error = script.result.unwrap_err();
    assert_ambiguous_start(&error);
    assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(script.events, ["start", "paused", "resume"]);
    assert_eq!(script.unread, 1);
}

#[test]
fn late_playback_cannot_clear_unknown_queue_error_or_unblock_successor() {
    let make_entry = |uri: &str| {
        pending_queue_entry(QueuedTrack {
            queue_entry_id: format!("entry-{uri}"),
            queue_batch_id: None,
            spotify_id: String::new(),
            spotify_uri: uri.to_string(),
            spotify_url: String::new(),
            name: uri.to_string(),
            artist: String::new(),
            album_art_url: String::new(),
            duration_ms: 120_000,
            added_at_ms: 1,
            added_by_actor_id: "actor".to_string(),
            added_by_name: "Sam".to_string(),
            playlist: None,
            playlist_position: None,
            added_by: "Sam".to_string(),
        })
    };
    let mut seed = make_entry(SEED);
    seed.delivery_state = QueueDeliveryState::CommitUnknown;
    seed.can_remove = false;
    let mut jam = JamState {
        active: true,
        spotify_is_playing: true,
        queue: vec![seed, make_entry(OTHER)],
        last_error: Some("Spotify start remains uncertain".to_string()),
        ..JamState::default()
    };

    assert!(!playback_error_can_clear(&jam, false));
    assert!(!playback_error_can_clear(&jam, true));
    assert!(queue_frontier_candidate(&jam.queue).is_none());

    // Only resolving the uncertain occurrence permits normal delivery again.
    jam.queue[0].delivery_state = QueueDeliveryState::SpotifyCommitted;
    assert!(playback_error_can_clear(&jam, false));
    assert!(!playback_error_can_clear(&jam, true));
    assert_eq!(
        queue_frontier_candidate(&jam.queue)
            .unwrap()
            .track
            .spotify_uri,
        OTHER
    );
}

#[tokio::test]
async fn relinked_seed_is_confirmed_using_its_original_uri() {
    let mut relinked = selected(true);
    relinked.current_uri = Some(OTHER.to_string());
    relinked.original_uri = Some(SEED.to_string());
    let script = run_script(Ok(()), vec![("relinked", Ok(relinked))], Ok(()), 2).await;
    script.result.unwrap();
    assert_eq!(script.events, ["start", "relinked"]);
}

#[tokio::test]
async fn original_uri_without_an_actual_current_track_cannot_confirm_or_resume() {
    for uri in [None, Some(""), Some(" ")] {
        for is_playing in [false, true] {
            let mut malformed = selected(is_playing);
            malformed.current_uri = uri.map(str::to_string);
            malformed.original_uri = Some(SEED.to_string());
            let script = run_script(Ok(()), vec![("malformed", Ok(malformed)); 2], Ok(()), 2).await;
            assert_ambiguous_start(&script.result.unwrap_err());
            assert_eq!(script.events, ["start", "malformed", "malformed"]);
        }
    }
}
