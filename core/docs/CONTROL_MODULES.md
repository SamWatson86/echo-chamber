# Control Plane Module Map

Source: `core/control/src/`

The control plane is an Axum HTTPS server. It handles auth, room management, participant tracking, file serving, WebSocket proxy to the SFU, chat, soundboard, jam session, and admin APIs.

## Module List

| Module | File | Responsibility |
|--------|------|---------------|
| (main) | `main.rs` | AppState definition, route tree, background tasks, startup |
| `auth` | `auth.rs` | Login, JWT issue/validate, LiveKit token generation, rate limiting |
| `rooms` | `rooms.rs` | Room CRUD, participant heartbeat/leave, session event logging, stats reporting, online users |
| `sfu_proxy` | `sfu_proxy.rs` | WebSocket proxy from `/rtc` and `/sfu` to LiveKit SFU; injects Bearer token as query param; negotiates `livekit` subprotocol |
| `file_serving` | `file_serving.rs` | Viewer/admin dir resolution, `stamp_viewer_index()` (cache-busting), chime MIME detection, path utilities |
| `config` | `config.rs` | `Config` struct, `load_dotenv()`, `resolve_path()`, TLS setup (`generate_self_signed()`) |
| `admin` | `admin.rs` | Admin dashboard API: live participants, session history, metrics, bug reports, deploy history, kick/mute |
| `chat` | `chat.rs` | Chat message save/delete/history, file upload, upload serve |
| `soundboard` | `soundboard.rs` | Sound file upload/list/serve per room, per-room limits |
| `jam_session` | `jam_session.rs` | Spotify OAuth, now-playing state, queue management, join/leave, host controls |
| `jam_source` | `jam_source.rs` | Authenticated protocol-v3 WebSocket source, generation fencing, takeover availability, and source health |
| `jam_bot` | `jam_bot.rs` | Normalizes source PCM and relays 48 kHz stereo frames to Jam listeners |

## AppState

`AppState` is `Clone + Send + Sync`, shared across all request handlers via Axum's `.with_state()`.

| Field | Type | Owner module |
|-------|------|-------------|
| `config` | `Arc<Config>` | config |
| `rooms` | `Arc<Mutex<HashMap<String, RoomInfo>>>` | rooms |
| `participants` | `Arc<Mutex<HashMap<String, ParticipantEntry>>>` | rooms |
| `participant_bindings` | `Arc<Mutex<HashMap<String, ParticipantBinding>>>` | auth/rooms/jam_session |
| `client_stats` | `Arc<Mutex<HashMap<String, ClientStats>>>` | rooms/admin |
| `joined_at` | `Arc<Mutex<HashMap<String, u64>>>` | rooms |
| `stats_history` | `Arc<Mutex<Vec<StatsSnapshot>>>` | rooms/admin |
| `bug_reports` | `Arc<Mutex<Vec<BugReport>>>` | admin |
| `soundboard` | `Arc<Mutex<SoundboardState>>` | soundboard |
| `chat` | `Arc<Mutex<ChatState>>` | chat |
| `avatars` | `Arc<Mutex<HashMap<String, String>>>` | rooms (avatar upload/get) |
| `chimes` | `Arc<Mutex<HashMap<String, ChimeEntry>>>` | file_serving |
| `jam` | `Arc<Mutex<JamState>>` | jam_session |
| `jam_bot` | `Arc<tokio::sync::Mutex<Option<JamBot>>>` | jam_bot |
| `jam_source` | `JamSourceRegistry` | jam_source |
| `jam_lifecycle` | `Arc<tokio::sync::Mutex<()>>` | jam_session/rooms |
| `jam_state_refresh` | `Arc<tokio::sync::Mutex<()>>` | jam_session |
| `spotify_pending` | `Arc<Mutex<Option<SpotifyPending>>>` | jam_session |
| `viewer_stamp` | `Arc<RwLock<String>>` | file_serving |
| `login_attempts` | `Arc<Mutex<HashMap<IpAddr, (u32, Instant)>>>` | auth |
| `http_client` | `reqwest::Client` | jam_session |
| Path fields | `PathBuf` | various |

## Route Tree

### Static file serving
```
GET  /                    → root_route (redirect to /viewer/)
GET  /viewer/*            → ServeDir (viewer_dir) with no-cache headers
GET  /admin/*             → ServeDir (admin_dir)
```

### Auth
```
POST /v1/auth/login       → login (rate-limited, issues JWT)
POST /v1/auth/token       → issue_token (issues LiveKit access token)
```

Normal viewer token requests include a private, random per-install `participantAuthKey`.
The key remains only in the server's in-memory binding registry and is never returned,
serialized, logged, or broadcast. Signed LiveKit tokens carry a stable custom binding ID.
Prefetched room tokens for the same installation share that ID, and binding tombstones
outlive the 20-second presence row so a throttled browser can recover securely.

### Rooms & Participants
```
GET  /v1/rooms            → list_rooms
POST /v1/rooms            → create_room
GET  /v1/rooms/:id        → get_room
DEL  /v1/rooms/:id        → delete_room
GET  /v1/room-status      → rooms_status (SSE or polling endpoint for all rooms)
POST /v1/participants/heartbeat → participant_heartbeat
POST /v1/participants/leave     → participant_leave
GET  /v1/metrics          → metrics
GET  /v1/ice-servers      → ice_servers (returns TURN config)
GET  /api/online          → online_users
```

### SFU Proxy
```
GET  /rtc                 → sfu_proxy (WebSocket upgrade → LiveKit)
GET  /sfu                 → sfu_proxy
GET  /sfu/rtc             → sfu_proxy
```

### Media (Avatar / Chime)
```
POST /api/avatar/upload   → avatar_upload
GET  /api/avatar/:identity → avatar_get
POST /api/chime/upload    → chime_upload
GET  /api/chime/:identity/:kind → chime_get
POST /api/chime/delete    → chime_delete
```

### Chat
```
POST /api/chat/message    → chat_save_message
POST /api/chat/delete     → chat_delete_message
GET  /api/chat/history/:room → chat_get_history
POST /api/chat/upload     → chat_upload_file
GET  /api/chat/uploads/:file → chat_get_upload
```

### Soundboard
```
GET  /api/soundboard/list         → soundboard_list
GET  /api/soundboard/file/:id     → soundboard_file
POST /api/soundboard/upload       → soundboard_upload
POST /api/soundboard/update       → soundboard_update
```

### Jam Session
```
POST /api/jam/spotify-init        → jam_spotify_init
GET  /api/jam/spotify-callback    → jam_spotify_callback
GET  /api/jam/spotify-code        → jam_spotify_code
POST /api/jam/spotify-token       → jam_spotify_token
POST /api/jam/start               → jam_start
POST /api/jam/stop                → jam_stop
GET  /api/jam/state               → jam_state
POST /api/jam/search              → jam_search
POST /api/jam/queue               → jam_queue_add
POST /api/jam/playback/stop       → jam_stop_playback
POST /api/jam/skip                → jam_skip
POST /api/jam/join                → jam_join
POST /api/jam/leave               → jam_leave
GET  /api/jam/audio               → jam_audio_ws (WebSocket)
GET  /api/jam/source              → jam_source_ws (authenticated protocol-v3 WebSocket)
```

Spotify configuration and Jam state reads use the shared admin token. Jam mutations also
require the caller's bound LiveKit token in `X-Echo-Participant-Token`; host and listener
rights store both the exact identity and binding ID. The Jam audio WebSocket query contains
only `jam_protocol_version=3` and the active `generation`; it rejects extra query fields.
Its first frame (within five seconds) must be
`{"type":"auth","token":"<bound LiveKit JWT>"}`. The server derives the identity and
binding from that token, verifies active Jam membership, replies `{"type":"ready"}`, and
continues rechecking membership while it sends PCM. Participant heartbeat/leave use the
bound LiveKit token instead of the shared admin identity.

There is one control-plane-wide Echo Jam, not one Jam per user, link, or room. Any
authenticated Echo participant can start it, join it, search, add tracks, and skip through
Echo's Jam UI. Listener accounts do not need Spotify accounts; the only Spotify login is the
configured Premium host account used by Echo OAuth and Spotify desktop on the source PC.

Jam state protocol v3 exposes `source_enabled` and
`source_availability_known` in addition to source health. `disabled` means the
source PC's local takeover preference is off; `negotiating` means the desktop
source is preparing the Spotify route/capture boundary. The viewer requires
availability to be explicitly known, enabled, and capture-ready before Start
Jam is enabled. Missing fields fail closed instead of guessing that the source
is usable.

The configured source PC exposes **Allow Echo Jam to use Spotify on this PC**
on the login portal before Echo Connect and in the Jam panel. Enabling it while
idle changes only the stored native preference: Spotify and all Windows routes
remain untouched. During an active Jam, Echo Desktop temporarily routes only
Microsoft Store Spotify to the exact `CABLE Input (VB-Audio Virtual Cable)` endpoint as a silent
local sink, captures Spotify independently through Windows process loopback,
and relays that PCM to the control plane. It never changes
the system-default output. **Hear Jam on this PC** enables the synchronized
local relay through Echo's normal selected output and independent Jam Volume.

`Stop Music` is a shared playback control with the same participant authorization as queue and
skip. It calls Spotify's pause endpoint for the exact device ID already bound to the active Jam without
transferring playback, then marks playback paused while preserving the active Jam generation,
listeners, queue, source capture/route, and audio sockets. It remains available when capture
health is degraded because Spotify playback control is independent of PCM delivery. Turning
the source PC's Allow switch off, the empty-listener timeout, and full teardown instead pause
that exact device first, then release the temporary Spotify-only route. The older
`POST /api/jam/stop` lifecycle endpoint remains exact-host-binding-only: it ends the Jam and
clears listeners/queue, and drives the source teardown that pauses playback and releases capture
and routing. It is not the shared Stop Music action.

Protocol v3 has a coordinated release boundary. The control plane and complete
server-served viewer snapshot are deployed together; the configured source PC
also needs the matching Echo Desktop Windows binary, Microsoft Store Spotify
Desktop in the same interactive session, VB-CABLE, matching source credentials, and the same
Premium account authorized by Echo OAuth. Ordinary listeners need neither a
Spotify account nor Jam-source credentials.

### Admin API
```
GET  /admin/api/dashboard         → admin_dashboard
GET  /admin/api/sessions          → admin_sessions
POST /admin/api/stats             → admin_report_stats
GET  /admin/api/metrics           → admin_metrics
GET  /admin/api/bugs              → admin_bug_reports
GET  /admin/api/metrics/dashboard → admin_dashboard_metrics
GET  /admin/api/deploys           → admin_deploys
POST /v1/rooms/:id/kick/:identity → admin_kick_participant
POST /v1/rooms/:id/mute/:identity → admin_mute_participant
```

### Misc
```
GET  /health              → health
POST /api/bug-report      → submit_bug_report
GET  /api/version         → api_version
GET  /api/update/latest.json → api_update_latest (GitHub release proxy)
POST /api/open-url        → open_url (server-side URL open, Sam-only)
```

## Background Tasks

### Stale Participant Cleanup
- Runs every 10 seconds
- Removes participants with no heartbeat for ≥20 seconds
- Writes `leave` event to session log
- Removes stale listeners from active Jam sessions
- Auto-ends Jam if last listener leaves

### Viewer File Watcher
- Runs every 15 seconds
- Checks mtime on: `app.js`, `style.css`, `index.html`, `connect.js`, `room-status.js`, `participants.js`, `audio-routing.js`, `media-controls.js`, `chat.js`, `soundboard.js`, `state.js`, `jam.js`, `jam-session-state.js`, `jam.css`
- On any change: re-runs `stamp_viewer_index()` with new timestamp
- Updates `viewer_stamp` RwLock → stale-version banner fires in connected clients

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `CORE_BIND` | `0.0.0.0` | Bind address |
| `CORE_PORT` | `9090` | Bind port |
| `CORE_TLS_CERT` | — | Path to PEM cert file |
| `CORE_TLS_KEY` | — | Path to PEM key file |
| `CORE_TLS_SELF_SIGNED` | — | If set, generate self-signed cert |
| `CORE_ADMIN_PASSWORD` | — | Plain-text admin password |
| `CORE_ADMIN_PASSWORD_HASH` | — | bcrypt hash (preferred) |
| `CORE_ADMIN_JWT_SECRET` | random | JWT signing secret |
| `CORE_ADMIN_TOKEN_TTL_SECS` | 43200 | Admin JWT TTL (12h) |
| `LK_API_KEY` | — | LiveKit API key |
| `LK_API_SECRET` | — | LiveKit API secret |
| `LK_TOKEN_TTL_SECS` | 14400 | LiveKit token TTL (4h) |
| `TURN_PUBLIC_IP` | — | TURN server public IP |
| `TURN_PORT` | 3478 | TURN port |
| `TURN_USER` | — | TURN credentials |
| `TURN_PASS` | — | TURN credentials |
| `SPOTIFY_CLIENT_ID` | — | Spotify OAuth client ID |
| `JAM_SOURCE_ID` | — | ID of the one configured desktop Jam source |
| `JAM_SOURCE_TOKEN` | — | Separate bearer secret for that source |
| `SPOTIFY_DEVICE_ID` | — | Optional exact Spotify Connect device ID; may rotate |
| `SPOTIFY_DEVICE_NAME` | — | Preferred exact unique device name for long-lived configuration |
| `GITHUB_PAT` | — | GitHub token for release API |
| `GITHUB_REPO` | — | `owner/repo` for releases |
| `CORE_SESSION_LOG_DIR` | `../logs/sessions` | Session event log dir |
