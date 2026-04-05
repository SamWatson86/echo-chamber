# Viewer JS Module Map

All files live in `core/viewer/`. Served as static files by the control plane from `/viewer/*`. No bundler — plain ES5/ES6 globals loaded via `<script>` tags.

## Load Order (from index.html)

Scripts load in this exact order. Dependencies must appear before their consumers.

```
1.  livekit-client.umd.js     — LiveKit browser SDK (UMD bundle, defines LiveKit global)
2.  room-switch-state.js      — State machine for room switching
3.  jam-session-state.js      — Jam session state logic
4.  publish-state-reconcile.js — Pub/sub state reconciliation helpers
5.  state.js                  — Global app state (room, participants, flags)
6.  debug.js                  — Debug log panel + debugLog() helper
7.  urls.js                   — URL helpers (_echoServerUrl, SFU URL derivation)
8.  settings.js               — Persistent settings (localStorage + Tauri IPC)
9.  identity.js               — Identity helpers (identityBase, $screen detection)
10. rnnoise.js                 — RNNoise noise suppression loader + AudioWorklet setup
11. chimes.js                 — Enter/exit chime sounds
12. room-status.js            — Room status polling (/v1/room-status)
13. auth.js                   — Login, token fetch, admin auth
14. theme.js                  — Theme + opacity persistence
15. chat.js                   — Chat panel (messages, uploads, emoji picker)
16. soundboard.js             — Soundboard (quick play + edit panels)
17. screen-share-state.js     — Screen share active/inactive state atom
18. screen-share-config.js    — Share configuration (resolution, fps targets)
19. screen-share-quality.js   — Adaptive quality logic (bitrate/fps adjustments)
20. screen-share-adaptive.js  — Adaptive loop (monitors BWE, applies quality changes)
21. screen-share-native.js    — Capture picker, Tauri IPC, WASAPI audio, WGC/DXGI dispatch
22. participants-grid.js      — Grid layout rendering for participant tiles
23. participants-avatar.js    — Avatar loading + caching
24. participants-fullscreen.js — Fullscreen tile handling
25. participants.js           — Participant orchestration (combines above 3 modules)
26. audio-routing.js          — Audio track routing, per-participant mute/unmute
27. media-controls.js         — Mic/cam toggle, screen share button state
28. admin.js                  — Admin dashboard panel (in-app, not /admin page)
29. connect.js                — LiveKit room connect/disconnect, $screen track merging
30. app.js                    — Main app logic, event wiring, UI event handlers
31. capture-picker.js         — Native capture source picker UI (modal dialog)
32. jam.js                    — Jam Session (Spotify) UI and state sync
33. changelog.js              — "What's New" popup (shows on version change)
```

CSS files loaded in `<head>`:
- `style.css` — main app styles
- `jam.css` — jam session panel styles
- `capture-picker.css` — capture picker modal styles

## Module Purposes

### State / Infrastructure

| File | Purpose |
|------|---------|
| `state.js` | Global mutable state: `room`, `currentRoomName`, `adminToken`, `_echoServerUrl`, participant maps |
| `urls.js` | Derives SFU URL (`https→wss`), constructs API endpoints. Source of truth for all URLs. |
| `settings.js` | Reads/writes settings to localStorage + Tauri `save_settings`/`load_settings` |
| `identity.js` | `identityBase(id)` — strips `$screen` suffix. Used everywhere participants are identified. |
| `debug.js` | `debugLog(msg)` — writes to debug panel. Always-on, no performance cost when panel hidden. |
| `room-switch-state.js` | State machine preventing race conditions during room switches |
| `jam-session-state.js` | Jam session state (active, listeners, track) with deterministic transitions |
| `publish-state-reconcile.js` | Reconciles desired vs actual publish state after reconnects |

### Connection

| File | Purpose |
|------|---------|
| `auth.js` | `login()`, `fetchRoomToken()`, admin password flow |
| `connect.js` | `connectToRoom()`, `disconnectFromRoom()`, LiveKit event handlers, `$screen` track merging under real participant |
| `room-status.js` | Polls `/v1/room-status` every 5s, shows online count, drives room list |

### Participants

| File | Purpose |
|------|---------|
| `participants.js` | Orchestrator: subscribes to LiveKit events, delegates to sub-modules |
| `participants-grid.js` | Renders/updates participant tile grid layout |
| `participants-avatar.js` | Fetches avatars from `/api/avatar/:identity`, caches in memory |
| `participants-fullscreen.js` | Fullscreen tile click, ESC to exit, pip mode |

### Screen Share

| File | Purpose |
|------|---------|
| `screen-share-state.js` | Shared flag: `isScreenSharing`, prevents double-start |
| `screen-share-config.js` | Config constants: target resolution, FPS, bitrate envelope |
| `screen-share-quality.js` | Quality level calculations based on BWE feedback |
| `screen-share-adaptive.js` | Adaptive loop: monitors actual bitrate vs target, calls quality adjustments |
| `screen-share-native.js` | `startScreenShareManual()`: OS detection → WGC or DXGI path → Tauri IPC. Also `startNativeAudioCapture()`. |
| `capture-picker.js` | Modal UI: enumerate monitors/windows, preview thumbnails, confirm selection |

### Media

| File | Purpose |
|------|---------|
| `audio-routing.js` | Attaches audio tracks to `<audio>` elements, per-user mute state |
| `media-controls.js` | Mic/cam enable buttons, toggle handlers, device selection |
| `rnnoise.js` | Loads RNNoise WASM, sets up AudioWorkletNode for noise suppression |

### Features

| File | Purpose |
|------|---------|
| `chat.js` | Message display, input, file upload, emoji picker, polling `/api/chat/history/:room` |
| `soundboard.js` | Quick-play panel + edit panel, upload, playback via `<audio>` |
| `jam.js` | Spotify auth, now-playing, queue, join/leave, audio WebSocket streaming |
| `chimes.js` | Plays enter/exit chimes fetched from `/api/chime/:identity/:kind` |
| `theme.js` | Theme selection (frost/cyberpunk/aurora/ember/matrix/midnight/ultra-instinct), opacity slider |
| `admin.js` | In-app dashboard panel: live participants, session history, metrics, bug reports, deploys |
| `changelog.js` | Compares version string, shows "What's New" modal on first run of new version |

## Key Cross-Module Dependencies

```
connect.js
  ├── uses: state.js (room, currentRoomName, _echoServerUrl)
  ├── uses: auth.js (fetchRoomToken)
  ├── uses: identity.js (identityBase)
  └── calls: participants.js (render), audio-routing.js (attach)

screen-share-native.js
  ├── uses: state.js (_echoServerUrl, room)
  ├── uses: auth.js (fetchRoomToken, adminToken)
  ├── uses: screen-share-state.js (isScreenSharing flag)
  ├── uses: screen-share-config.js (resolution/fps targets)
  ├── calls: capture-picker.js (showCapturePicker)
  └── calls: screen-share-adaptive.js (start adaptive loop)

participants.js
  ├── delegates layout to: participants-grid.js
  ├── delegates avatars to: participants-avatar.js
  └── delegates fullscreen to: participants-fullscreen.js

app.js
  └── wires together all UI event handlers; imports from most other modules
```

## Cache-Busting

The control plane stamps `?v=VERSION.TIMESTAMP` on all script/CSS `src` attributes at startup (via `stamp_viewer_index()` in `file_serving.rs`). A background task re-stamps every 15s if files changed on disk. This triggers the stale-version banner in the client without a server restart.

Screen-share files currently load without `?v=` — they are excluded from the stamp. This is a known gap; refresh manually after editing those files.
