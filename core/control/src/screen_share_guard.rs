//! A native screen publisher is a separate SFU participant. It must never
//! outlive the parent connection that owns it. Use the SFU roster, not browser
//! heartbeats: background WebViews can stop sending heartbeats while connected.
use crate::{rooms::livekit_service_token, AppState};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::json;
use std::{collections::HashMap, time::Duration};
use tracing::{info, warn};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Deserialize)]
struct Participant {
    identity: String,
    sid: String,
}

#[derive(Deserialize)]
struct ParticipantList {
    #[serde(default)]
    participants: Vec<Participant>,
}

#[derive(Deserialize)]
struct RoomInfo {
    name: String,
}

#[derive(Deserialize)]
struct RoomList {
    #[serde(default)]
    rooms: Vec<RoomInfo>,
}

struct ScreenShareGuard {
    client: reqwest::Client,
    url: String,
    api_key: String,
    api_secret: String,
    // (room, screen participant SID) -> owning parent participant SID.
    // Reusing a display identity must not transfer an old share to a new login.
    owners: HashMap<(String, String), String>,
}

impl ScreenShareGuard {
    async fn rpc<T: DeserializeOwned>(
        &self,
        method: &str,
        room: &str,
        body: serde_json::Value,
    ) -> Result<T, String> {
        let token = livekit_service_token(&self.api_key, &self.api_secret, room)
            .map_err(|_| "could not sign SFU request".to_string())?;
        let response = self
            .client
            .post(format!(
                "{}/twirp/livekit.RoomService/{}",
                self.url.trim_end_matches('/'),
                method
            ))
            .timeout(REQUEST_TIMEOUT)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|_| format!("{method} unavailable"))?;
        if !response.status().is_success() {
            return Err(format!("{method} returned {}", response.status()));
        }
        response
            .json()
            .await
            .map_err(|_| format!("invalid {method} response"))
    }

    async fn participants(&self, room: &str) -> Result<Vec<Participant>, String> {
        let list: ParticipantList = self
            .rpc("ListParticipants", room, json!({ "room": room }))
            .await?;
        let mut identities = std::collections::HashSet::new();
        if list.participants.iter().any(|p| {
            p.identity.is_empty() || p.sid.is_empty() || !identities.insert(p.identity.as_str())
        }) {
            return Err("invalid SFU participant roster".to_string());
        }
        Ok(list.participants)
    }

    fn orphaned(&self, room: &str, screen: &Participant, roster: &[Participant]) -> bool {
        let Some(parent_identity) = screen.identity.strip_suffix("$screen") else {
            return false;
        };
        if parent_identity.is_empty() {
            return false;
        }
        let parent = roster.iter().find(|p| p.identity == parent_identity);
        match parent {
            None => true,
            Some(parent) => self
                .owners
                .get(&(room.to_string(), screen.sid.clone()))
                .is_some_and(|owner_sid| owner_sid != &parent.sid),
        }
    }

    async fn reconcile_room(&mut self, room: &str) -> Result<(), String> {
        let roster = self.participants(room).await?;
        self.owners.retain(|(owner_room, screen_sid), _| {
            owner_room != room || roster.iter().any(|p| &p.sid == screen_sid)
        });
        for screen in roster.iter().filter(|p| p.identity.ends_with("$screen")) {
            if !self.orphaned(room, screen, &roster) {
                if let Some(parent) = roster
                    .iter()
                    .find(|p| screen.identity.strip_suffix("$screen") == Some(p.identity.as_str()))
                {
                    self.owners
                        .entry((room.to_string(), screen.sid.clone()))
                        .or_insert_with(|| parent.sid.clone());
                }
                continue;
            }
            // Never remove from a stale snapshot. A replacement screen session
            // or a returning owner without an established old binding wins.
            let fresh = self.participants(room).await?;
            let Some(current) = fresh
                .iter()
                .find(|p| p.identity == screen.identity && p.sid == screen.sid)
            else {
                continue;
            };
            if !self.orphaned(room, current, &fresh) {
                continue;
            }
            let _: serde_json::Value = self
                .rpc(
                    "RemoveParticipant",
                    room,
                    json!({ "room": room, "identity": current.identity }),
                )
                .await?;
            self.owners.remove(&(room.to_string(), screen.sid.clone()));
            info!(
                "privacy guard removed orphan screen publisher room={} identity={}",
                room, screen.identity
            );
        }
        Ok(())
    }

    async fn reconcile(&mut self) -> Result<(), String> {
        let rooms: RoomList = self.rpc("ListRooms", "*", json!({})).await?;
        self.owners
            .retain(|(room, _), _| rooms.rooms.iter().any(|r| &r.name == room));
        for room in rooms.rooms {
            if let Err(error) = self.reconcile_room(&room.name).await {
                warn!("screen privacy guard room={} failed: {}", room.name, error);
            }
        }
        Ok(())
    }
}

pub(crate) fn spawn(state: &AppState) {
    let mut guard = ScreenShareGuard {
        client: state.http_client.clone(),
        url: std::env::var("CORE_SFU_HTTP").unwrap_or_else(|_| "http://127.0.0.1:7880".to_string()),
        api_key: state.config.livekit_api_key.clone(),
        api_secret: state.config.livekit_api_secret.clone(),
        owners: HashMap::new(),
    };
    tokio::spawn(async move {
        loop {
            if let Err(error) = guard.reconcile().await {
                warn!("screen privacy guard failed: {}", error);
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, routing::post, Json, Router};
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    #[derive(Default)]
    struct FakeSfu {
        rosters: VecDeque<serde_json::Value>,
        rooms: Vec<String>,
        list_requests: usize,
        fail_list_request: Option<usize>,
        removals: Vec<serde_json::Value>,
        fail_removal: bool,
    }

    fn roster(people: &[(&str, &str)]) -> serde_json::Value {
        json!({ "participants": people.iter().map(|(identity, sid)|
            json!({ "identity": identity, "sid": sid })).collect::<Vec<_>>() })
    }

    async fn fake_sfu(
        rosters: Vec<serde_json::Value>,
    ) -> (
        ScreenShareGuard,
        Arc<Mutex<FakeSfu>>,
        tokio::task::JoinHandle<()>,
    ) {
        let state = Arc::new(Mutex::new(FakeSfu {
            rosters: rosters.into(),
            rooms: vec!["main".into()],
            ..Default::default()
        }));
        let app =
            Router::new()
                .route(
                    "/twirp/livekit.RoomService/ListRooms",
                    post(|State(s): State<Arc<Mutex<FakeSfu>>>| async move {
                        Json(json!({"rooms": s.lock().unwrap().rooms.iter()
                            .map(|name| json!({"name": name})).collect::<Vec<_>>() }))
                    }),
                )
                .route(
                    "/twirp/livekit.RoomService/ListParticipants",
                    post(|State(s): State<Arc<Mutex<FakeSfu>>>| async move {
                        let mut s = s.lock().unwrap();
                        s.list_requests += 1;
                        let body = s.rosters.pop_front().expect("unexpected roster read");
                        (
                            if s.fail_list_request == Some(s.list_requests) {
                                axum::http::StatusCode::SERVICE_UNAVAILABLE
                            } else {
                                axum::http::StatusCode::OK
                            },
                            Json(body),
                        )
                    }),
                )
                .route(
                    "/twirp/livekit.RoomService/RemoveParticipant",
                    post(
                        |State(s): State<Arc<Mutex<FakeSfu>>>,
                         Json(body): Json<serde_json::Value>| async move {
                            let mut s = s.lock().unwrap();
                            s.removals.push(body);
                            (
                                if s.fail_removal {
                                    axum::http::StatusCode::SERVICE_UNAVAILABLE
                                } else {
                                    axum::http::StatusCode::OK
                                },
                                Json(json!({})),
                            )
                        },
                    ),
                )
                .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            ScreenShareGuard {
                client: reqwest::Client::new(),
                url,
                api_key: "test".into(),
                api_secret: "test-secret".into(),
                owners: HashMap::new(),
            },
            state,
            task,
        )
    }

    #[tokio::test]
    async fn removes_only_orphan_screen_after_fresh_sfu_confirmation() {
        let people = roster(&[
            ("sam", "parent-sam"),
            ("zane$screen", "share-zane"),
            ("sam$screen", "share-sam"),
            ("jam-bot", "bot"),
        ]);
        let (mut guard, state, task) = fake_sfu(vec![people.clone(), people]).await;
        guard.reconcile_room("main").await.unwrap();
        assert_eq!(
            state.lock().unwrap().removals,
            vec![json!({"room":"main", "identity":"zane$screen"})]
        );
        task.abort();
    }

    #[tokio::test]
    async fn ignores_control_presence_and_keeps_screens_with_live_sfu_parents() {
        let (mut guard, state, task) = fake_sfu(vec![roster(&[
            ("zane", "parent"),
            ("zane$screen", "share"),
        ])])
        .await;
        guard.reconcile_room("main").await.unwrap();
        assert!(state.lock().unwrap().removals.is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn never_removes_a_replacement_screen_from_a_stale_snapshot() {
        let (mut guard, state, task) = fake_sfu(vec![
            roster(&[("zane$screen", "old")]),
            roster(&[("zane", "parent"), ("zane$screen", "new")]),
        ])
        .await;
        guard.reconcile_room("main").await.unwrap();
        assert!(state.lock().unwrap().removals.is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn returning_owner_prevents_unbound_orphan_removal() {
        let (mut guard, state, task) = fake_sfu(vec![
            roster(&[("zane$screen", "share")]),
            roster(&[("zane", "parent"), ("zane$screen", "share")]),
        ])
        .await;
        guard.reconcile_room("main").await.unwrap();
        assert!(state.lock().unwrap().removals.is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn old_share_is_not_transferred_to_new_login_with_same_identity() {
        let old = roster(&[("zane", "parent-old"), ("zane$screen", "share")]);
        let new = roster(&[("zane", "parent-new"), ("zane$screen", "share")]);
        let (mut guard, state, task) = fake_sfu(vec![old, new.clone(), new]).await;
        guard.reconcile_room("main").await.unwrap();
        guard.reconcile_room("main").await.unwrap();
        assert_eq!(state.lock().unwrap().removals.len(), 1);
        task.abort();
    }

    #[tokio::test]
    async fn malformed_roster_does_not_trigger_removal() {
        let (mut guard, state, task) = fake_sfu(vec![
            json!({"participants":[{"identity":"zane$screen","sid":"share"},{"identity":"zane"}]}),
        ])
        .await;
        assert!(guard.reconcile_room("main").await.is_err());
        assert!(state.lock().unwrap().removals.is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn failed_removal_is_reported_and_retried_next_pass() {
        let orphan = roster(&[("zane$screen", "share")]);
        let (mut guard, state, task) = fake_sfu(vec![orphan.clone(); 4]).await;
        state.lock().unwrap().fail_removal = true;
        assert!(guard.reconcile_room("main").await.is_err());
        state.lock().unwrap().fail_removal = false;
        guard.reconcile_room("main").await.unwrap();
        assert_eq!(state.lock().unwrap().removals.len(), 2);
        task.abort();
    }

    #[tokio::test]
    async fn empty_parent_and_unrelated_companions_are_not_removal_targets() {
        let (mut guard, state, task) = fake_sfu(vec![roster(&[
            ("$screen", "invalid-parent"),
            ("zane$native-presenter", "presenter"),
            ("ordinary-participant", "ordinary"),
        ])])
        .await;
        guard.reconcile_room("main").await.unwrap();
        assert!(state.lock().unwrap().removals.is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn malformed_fresh_roster_does_not_confirm_an_orphan() {
        let (mut guard, state, task) = fake_sfu(vec![
            roster(&[("zane$screen", "share")]),
            json!({"participants":[{"identity":"zane$screen","sid":"share"},{"identity":"zane"}]}),
        ])
        .await;
        assert!(guard.reconcile_room("main").await.is_err());
        assert!(state.lock().unwrap().removals.is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn failed_fresh_roster_does_not_confirm_an_orphan() {
        let orphan = roster(&[("zane$screen", "share")]);
        let (mut guard, state, task) = fake_sfu(vec![orphan.clone(), orphan]).await;
        state.lock().unwrap().fail_list_request = Some(2);
        assert!(guard.reconcile_room("main").await.is_err());
        assert!(state.lock().unwrap().removals.is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn orphan_joining_after_an_empty_pass_is_removed_on_next_pass() {
        let orphan = roster(&[("zane$screen", "late-share")]);
        let (mut guard, state, task) = fake_sfu(vec![json!({}), orphan.clone(), orphan]).await;
        guard.reconcile().await.unwrap();
        assert!(state.lock().unwrap().removals.is_empty());
        guard.reconcile().await.unwrap();
        assert_eq!(
            state.lock().unwrap().removals,
            vec![json!({"room":"main", "identity":"zane$screen"})]
        );
        task.abort();
    }

    #[tokio::test]
    async fn parent_in_another_room_does_not_keep_an_orphan_alive() {
        let orphan = roster(&[("zane$screen", "old-room-share")]);
        let (mut guard, state, task) = fake_sfu(vec![
            roster(&[("zane", "parent"), ("zane$screen", "current-room-share")]),
            orphan.clone(),
            orphan,
        ])
        .await;
        state.lock().unwrap().rooms = vec!["current-room".into(), "old-room".into()];
        guard.reconcile().await.unwrap();
        assert_eq!(
            state.lock().unwrap().removals,
            vec![json!({"room":"old-room", "identity":"zane$screen"})]
        );
        assert_eq!(
            guard
                .owners
                .get(&("current-room".into(), "current-room-share".into())),
            Some(&"parent".to_string())
        );
        task.abort();
    }

    #[tokio::test]
    async fn failed_room_does_not_block_cleanup_in_another_room() {
        let orphan = roster(&[("zane$screen", "share")]);
        let (mut guard, state, task) = fake_sfu(vec![json!({}), orphan.clone(), orphan]).await;
        {
            let mut s = state.lock().unwrap();
            s.rooms = vec!["unavailable-room".into(), "main".into()];
            s.fail_list_request = Some(1);
        }
        guard.reconcile().await.unwrap();
        assert_eq!(
            state.lock().unwrap().removals,
            vec![json!({"room":"main", "identity":"zane$screen"})]
        );
        task.abort();
    }

    #[tokio::test]
    async fn ambiguous_duplicate_parent_identity_does_not_trigger_removal() {
        let (mut guard, state, task) = fake_sfu(vec![roster(&[
            ("zane$screen", "share"),
            ("zane", "old-parent"),
            ("zane", "new-parent"),
        ])])
        .await;
        assert!(guard.reconcile_room("main").await.is_err());
        assert!(state.lock().unwrap().removals.is_empty());
        task.abort();
    }
}
