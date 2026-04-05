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
| `audio_capture` | `audio_capture.rs` | Jam session audio WebSocket endpoint (`/api/jam/audio`) — streams PCM from host to listeners |
| `chat` | `chat.rs` | Chat message save/delete/history, file upload, upload serve |
| `soundboard` | `soundboard.rs` | Sound file upload/list/serve per room, per-room limits |
| `jam_session` | `jam_session.rs` | Spotify OAuth, now-playing state, queue management, join/leave, host controls |
| `jam_bot` | `jam_bot.rs` | Background bot that polls Spotify API and advances the queue |

## AppState

`AppState` is `Clone + Send + Sync`, shared across all request handlers via Axum's `.with_state()`.

| Field | Type | Owner module |
|-------|------|-------------|
| `config` | `Arc<Config>` | config |
| `rooms` | `Arc<Mutex<HashMap<String, RoomInfo>>>` | rooms |
| `participants` | `Arc<Mutex<HashMap<String, ParticipantEntry>>>` | rooms |
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
POST /api/jam/queue-remove        → jam_queue_remove
POST /api/jam/skip                → jam_skip
POST /api/jam/join                → jam_join
POST /api/jam/leave               → jam_leave
GET  /api/jam/audio               → jam_audio_ws (WebSocket)
```

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
- Checks mtime on: `app.js`, `style.css`, `index.html`, `connect.js`, `room-status.js`, `participants.js`, `audio-routing.js`, `media-controls.js`, `chat.js`, `soundboard.js`, `state.js`, `jam.js`
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
| `GITHUB_PAT` | — | GitHub token for release API |
| `GITHUB_REPO` | — | `owner/repo` for releases |
| `CORE_SESSION_LOG_DIR` | `../logs/sessions` | Session event log dir |
