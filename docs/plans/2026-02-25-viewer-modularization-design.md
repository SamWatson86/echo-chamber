# Viewer Modularization Design

**Date**: 2026-02-25
**Status**: Approved
**Decision**: Modularize existing `app.js` into ES modules instead of React rewrite

## Context

`core/viewer/app.js` is 11,254 lines — a single monolithic file handling everything from noise cancellation to chat to screen sharing. It works, but:
- Hard to navigate and maintain
- Risky to edit (changes in one area can break another)
- Difficult for contributors to work on isolated features
- PRs touch the entire file making reviews painful

Spencer's React rewrite (PR #62) was reviewed and closed — it recreated the monolith problem in React (4,483-line single component) and was missing critical features (canvas pipeline, AIMD bitrate, RNNoise, DTX handling, per-participant volume, heatmap). Rather than rewrite from scratch, we modularize what works.

## Approach

Split `app.js` into ~24 focused ES modules using browser-native `import`/`export`. No frameworks, no build tools, no bundlers. Zero behavioral changes.

## Module Map

| Module | ~Lines | Responsibility |
|--------|--------|---------------|
| `state.js` | ~50 | Shared state variables (`currentRoom`, `participantState`, `_isMobileDevice`, etc.) |
| `debug.js` | ~124 | `debugLog()`, log levels, debug panel |
| `urls.js` | ~113 | `apiUrl()`, `sfuUrl()`, server URL derivation |
| `settings.js` | ~139 | `echoGet()`/`echoSet()`, Tauri IPC storage |
| `identity.js` | ~79 | Display name parsing, identity base extraction |
| `rnnoise.js` | ~146 | WASM noise cancellation, mobile skip |
| `chimes.js` | ~222 | Join/leave chime loading, synthesized tones, pre-fetch |
| `track-utils.js` | ~93 | Track naming helpers, dedup logic |
| `room-status.js` | ~173 | Room list fetching, participant counts, room UI |
| `fast-switch.js` | ~110 | Fast room switching without full reconnect |
| `tiles.js` | ~808 | Video tile layout engine, grid sizing, pip mode |
| `participant-cards.js` | ~741 | Participant card rendering, volume sliders, mute indicators |
| `audio-mixer.js` | ~389 | Per-participant volume, AudioContext routing |
| `media-reconciler.js` | ~145 | Track attach/detach synchronization |
| `track-handler.js` | ~312 | LiveKit track subscription/unsubscription events |
| `screen-publish.js` | ~583 | Screen share publish, canvas pipeline, 60fps loop |
| `native-audio.js` | ~1106 | WASAPI capture, Tauri IPC for audio devices |
| `chat.js` | ~629 | Chat messages, image/file upload, tap-to-play mobile |
| `media-controls.js` | ~297 | Mic/camera/screen share toolbar buttons |
| `soundboard.js` | ~665 | Soundboard UI, audio playback, admin management |
| `camera-lobby.js` | ~139 | Pre-join camera preview |
| `theme.js` | ~667 | 7 themes, CSS variable switching, transparency slider |
| `admin.js` | ~662 | Admin panel, stats, heatmap, session management |
| `connect.js` | ~1278 | Room connection, LiveKit client setup, reconnect logic |
| `main.js` | ~glue | App init, event wiring, orchestration |

## Migration Order

**Phase 1 — Leaf modules** (no dependencies on other custom modules)
1. `state.js` — shared state container
2. `debug.js` — logging utilities
3. `urls.js` — URL derivation
4. `settings.js` — persistent storage
5. `identity.js` — name parsing

**Phase 2 — Utility modules** (depend only on Phase 1)
6. `track-utils.js`
7. `chimes.js`
8. `camera-lobby.js`
9. `fast-switch.js`
10. `rnnoise.js`

**Phase 3 — UI modules** (depend on Phase 1+2)
11. `tiles.js`
12. `participant-cards.js`
13. `theme.js`
14. `room-status.js`

**Phase 4 — Feature modules** (depend on Phase 1-3)
15. `audio-mixer.js`
16. `media-reconciler.js`
17. `track-handler.js`
18. `chat.js`
19. `media-controls.js`
20. `soundboard.js`
21. `admin.js`

**Phase 5 — Core modules** (depend on everything)
22. `native-audio.js`
23. `screen-publish.js`
24. `connect.js`
25. `main.js` (final glue)

## Key Decisions

- **No build step**: Browser-native ES modules. Control plane already serves files.
- **Shared state via `state.js`**: Thin module holds shared variables. Modules import from it instead of relying on global `var`.
- **Incremental migration**: Extract one module at a time, test, then proceed. Easy rollback.
- **Zero behavior changes**: Every button, animation, and edge case works identically.
- **`index.html` change**: Swap `<script src="app.js">` for `<script type="module" src="main.js">`.
- **`style.css`, `jam.js`, `jam.css` untouched**.
- **No server-side changes**: All API endpoints remain the same.

## Risk Mitigation

- Each module extraction is independently testable
- If a module breaks something, revert just that file
- `app.js` stays in repo as reference until migration complete
- Tauri client needs rebuild after migration (files embedded at compile time)
