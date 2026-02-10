# Echo Chamber - Current Session Notes

**Last Updated**: 2026-02-09
**Working On**: FPS fixes, network audit, screen share improvements
**GitHub**: https://github.com/SamWatson86/echo-chamber

## IMPORTANT CONTEXT
- Sam is **not a software developer** - needs full guidance
- **FULL AUTONOMY**: Claude has full permission to execute everything — git commits, pushes, file changes, builds, all of it. Do NOT prompt Sam for confirmation. Just do the work.
- Focus ONLY on `/core` folder - `/apps` is legacy web version, DO NOT TOUCH
- **Tauri native client is now the primary app** — browser viewer is legacy/debug only
- Core stack: LiveKit SFU (native exe) + Rust control plane + TURN server (native Go) + web viewer + Tauri native client
- **Docker is REMOVED** — all services run as native Windows processes

## What Happened This Session (2026-02-09)

### Who's Online Feature (Pre-Connect)
- **Backend**: New `GET /api/online` endpoint on the Rust control plane — unauthenticated, returns JSON array of `{name, room}` for all connected participants
- **Frontend**: `fetchOnlineUsers()` polls every 10 seconds while user is on the connect page. Stops when user connects, restarts when user disconnects.
- **UI**: Frosted glass card below the status bar showing green-dot user pills with names. Shows "No one is currently online" when empty.
- **Files changed**: `core/control/src/main.rs` (new handler + route), `core/viewer/app.js` (polling functions + lifecycle hooks), `core/viewer/index.html` (new div), `core/viewer/style.css` (pill styles)
- **Restart needed**: Control plane was killed and rebuilt. Run `powershell -ExecutionPolicy Bypass -File core\.tmp-restart-control.ps1` then refresh client.

### Soundboard Favorites & Drag-and-Drop Reordering
- **Favorites**: Each sound tile now has a star button (left side). Click to toggle favorite. Favorites sort to the top of the grid with a gold left-border accent. Stored in `localStorage` as `echo-soundboard-favorites`.
- **Drag-and-drop**: Sound tiles are draggable. Drag within the same group (favorites or non-favorites) to reorder. Visual feedback: dragged tile goes translucent, drop target gets accent border glow. Order stored in `localStorage` as `echo-soundboard-order`.
- **Files changed**: `core/viewer/app.js` (new state vars + 3 helper functions + rewritten `renderSoundboard()`), `core/viewer/style.css` (new `.sound-fav` and drag-drop styles)
- **Restart needed**: Restart control plane + refresh client (app.js changed)

### Chat Panel Repositioned as Grid Column
- Moved `#chat-panel` from fixed overlay (`position: fixed`) to a 3rd column inside `.room-layout` grid
- **index.html**: Moved chat panel div inside `.room-layout`, after `</aside>`
- **style.css**: Removed `position: fixed; right; top; bottom; width; z-index` from `.chat-panel`, added `.room-layout.chat-open` rule with 3-column grid (`minmax(0,1fr) 360px 400px`)
- **app.js**: `openChat()` adds `chat-open` class to `.room-layout`, `closeChat()` removes it
- Sidebar stays visible when chat is open; screen grid shrinks to accommodate

### 1. Screen Share Codec Fix (VP9 → H264)
- `getScreenSharePublishOptions()` was using `videoCodec: "vp9"` which fell back to software VP8 (libvpx)
- SAM-PC's Sandy Bridge CPU couldn't handle software encoding → FPS drops to 13fps
- **Fix**: Changed to `videoCodec: "h264"` → enables NVENC hardware encoding on GPUs
- SAM-PC CPU 100% when moving windows was confirmed as hardware limitation, not software bug

### 2. FPS Fixes from Previous Session (carried over)
- **setTimeout replaces rAF**: `requestAnimationFrame` throttled for occluded windows (behind shared screen). `setTimeout` is NOT throttled.
- **Ghost subscriber removed**: Fake LiveKit participant caused DTLS timeouts → SFU killed ghost → renegotiation reset encoder to 0fps. SDP bandwidth munging handles BWE instead.

### 3. ATT BGW320-500 Router Installed
- New ATT gateway, configured in **IP passthrough / bridge mode**
- Eero remains the actual router (DHCP, NAT, port forwarding)
- **All IPs unchanged** (verified):
  - Main PC: `192.168.5.70`
  - SAM-PC: `192.168.5.149`
  - Public: `99.111.153.69`
- BGW320 settings: Packet Filter disabled, SIP ALG off, ESP ALG off, Reflexive ACL on
- No config file changes needed

### 4. Screen Grid Scrollbar Fix
- `.room-main` had `overflow-y: auto` causing scrollbar on ultra-wide with single screen share
- Tile video had `aspect-ratio: 16/9` forcing tall height
- **Fix**: `.room-main` → `grid-template-rows: auto 1fr; overflow: hidden`
- Video → `width: 100%; height: 100%; object-fit: contain` (fills available space, shrinks to fit)

### 5. Screen Share Diagnostics Added
- `[reconcile] remote screens:` log — shows remote screen shares and subscription status
- `[screen-tile] CREATED for` log — confirms when screen tiles are added to DOM
- For debugging SAM-PC not seeing screen shares

### 6. External Streaming Confirmed!
- **Zane connected externally and streamed 1080p@60fps** — full pipeline working end-to-end

### 7. Stop Watching / Start Watching Toggle Button
- Each remote participant with an active screen share now has a "Stop Watching" button in the sidebar
- Clicking it hides the screen tile (`display: none`) and changes to "Start Watching"
- Clicking again restores the tile and reverts to "Stop Watching"
- If hiding a focused tile, the focus state is properly cleared
- When a user stops sharing, they are removed from the hidden set and button resets
- New screen shares always default to visible
- Button only appears while the participant has an active screen share

### 8. Avatar Upload/Retrieval Endpoints
- Added `POST /api/avatar/upload?identity=xxx` — admin-authed, saves avatar image to `avatars/` directory
- Added `GET /api/avatar/{identity}` — no auth required, serves avatar with correct content-type + 5min cache
- Strips `-XXXX` numeric suffix from identity so avatars persist across reconnects
- Supports jpeg, png, webp, gif; overwrites previous avatar for same identity base
- Added `avatars` HashMap + `avatars_dir` to `AppState`; avatars dir created on startup alongside chat uploads

### 9. Guest Avatar Upload & Display System (Web Viewer)
- **Avatar state**: `avatarUrls` Map tracks identity_base -> avatar URL; `getIdentityBase()` strips `-XXXX` suffix
- **Upload UI**: Local user's `.user-avatar` div is clickable (hidden file input), shows "Upload" hover overlay
- **Upload flow**: Client-side resize to 160x160 JPEG via canvas, POST to `/api/avatar/upload`, cache-bust URL
- **Display logic**: `updateAvatarDisplay()` shows `<img class="avatar-img">` in avatar div, replacing initials text
- **Camera integration**: When camera turns off (`updateAvatarVideo` with null track), avatar image replaces initials
- **Data channel broadcast**: `broadcastAvatar()` sends avatar URL via LiveKit reliable data channel
- **Receive handler**: `DataReceived` handler processes `avatar-update` messages, updates all matching cards
- **Persistence**: Avatar URL saved to `localStorage` per identity base, loaded on connect
- **New participant sync**: Own avatar re-broadcast on `ParticipantConnected` so latecomers see it
- **CSS**: `.avatar-img` covers avatar div with `object-fit: cover`; hover overlay shows "Upload" text

### 10. Rustls CryptoProvider Fix
- Control plane crashed on restart: `Could not automatically determine the process-level CryptoProvider`
- `rustls` 0.23+ requires explicit crypto backend selection
- **Fix**: Added `rustls` dependency with `ring` feature to Cargo.toml, called `rustls::crypto::ring::default_provider().install_default()` at start of `main()`
- Control plane now starts and passes health check

### Key Files Modified This Session
- `core/control/src/main.rs` — Avatar upload/retrieval endpoints, rustls CryptoProvider fix
- `core/control/Cargo.toml` — Added `rustls` with `ring` feature
- `core/viewer/app.js` — H264 codec, diagnostics, setTimeout fix, ghost removal, stop watching toggle, avatar upload/display system
- `core/viewer/style.css` — Screen grid scrollbar fix, watch toggle button styling, avatar image + upload hover styles, chat panel grid layout, screen share cropping fix, focus mode thumbnail strip
- `core/viewer/index.html` — Chat panel moved into grid layout, soundboard icons hidden by default
- `memory/MEMORY.md` — Network topology, SAM-PC CPU limitation, verified IPs
- `memory/debugging.md` — BGW320 settings, port forwarding, verified IPs
- `CURRENT_SESSION.md` — This file

### 11. Soundboard Drag-and-Drop Fix
- Child elements (favBtn, editBtn, main, iconEl, nameEl) inside `.sound-tile` were intercepting drag events, preventing tile drag from initiating
- **Fix**: Added `draggable = false` to all child elements, plus `dragstart` event prevention on favBtn and editBtn
- Drag-and-drop reordering should now work correctly

### 12. Device Selection Enabled Before Connecting
- Device dropdowns (mic, cam, speaker) were disabled by default and only enabled after connecting
- **Fix**: Removed device select disabling from `setPublishButtonsEnabled()`, explicitly enable selects after `refreshDevices()` on page init
- Users can now choose devices before connecting to a room

### 13. Device Selection Persistence (localStorage)
- Device selections were lost on page reload
- **Fix**: `switchMic`, `switchCam`, `switchSpeaker` now save to localStorage (`echo-device-mic`, `echo-device-cam`, `echo-device-speaker`)
- `refreshDevices()` restores saved selections from localStorage if the device still exists in the enumerated list
- If a saved device is no longer available (unplugged), it gracefully falls back to default

### 14. Soundboard Redesign — Compact Quick Play + Edit Mode
- **Splitboards into two views**: Quick Play (compact icon panel) and Edit Mode (full-screen overlay)
- **Quick Play (compact)**: Small 210px-wide panel anchored bottom-right, shows icons in 4-column grid, favorites have gold border glow, tooltips on hover, drag-and-drop reorder
- **Edit Mode**: Full-screen overlay (original view) with search, full tiles, upload section, icon picker
- **Buttons**: "Edit Soundboard" opens edit mode from compact, "Back to Soundboard" returns to compact
- **Drag-and-drop**: Unrestricted — any sound can be dragged to any position (removed favorites/non-favorites boundary restriction)
- **Volume synced**: Both views share the same volume slider state, changes in one sync to the other
- **Files changed**:
  - `core/viewer/index.html` — Split `#soundboard` into `#soundboard-compact` (quick play) and `#soundboard` (edit, with `.soundboard-edit` class)
  - `core/viewer/app.js` — New DOM refs, `renderSoundboardCompact()`, `renderAllSoundboardViews()`, `getSoundboardSoundsFiltered()`, `attachSoundboardDragDrop()` (shared helper), `openSoundboardEdit()`, `closeSoundboardEdit()`, updated `openSoundboard()` to show compact, updated `closeSoundboard()` to close both, synced volume between both sliders
  - `core/viewer/style.css` — New `.soundboard-compact` styles (narrow panel, compact grid, icon buttons with tooltips, favorite gold glow, drag feedback)
- **Restart needed**: Restart control plane + refresh client (app.js + index.html changed)

### 15. Screen Share Video Cropping Fix (Maximized Window)
- Video was cropped (tops/bottoms cut off) when app window was maximized
- **Root cause**: `.screens-grid` had `align-content: start` which packed tiles at top, preventing them from stretching to fill available height. Tiles' implicit `grid-auto-rows: auto` sized to content, not available space.
- **Fix**: Changed `.screens-grid` to `align-content: stretch; grid-auto-rows: 1fr` so tiles expand to fill available height. Added `grid-template-rows: auto 1fr` to `.screens-grid .tile` so the video element (2nd row) fills the tile height.
- `object-fit: contain` unchanged — video scales correctly within the now-properly-sized container.

### 16. Focus Mode Hides Other Screen Shares Fix
- When Sam focused his own screen tile, Spencer's screen tile became completely invisible (`display: none`)
- **Root cause**: `.screens-grid.is-focused .tile { display: none }` hid ALL non-focused tiles — no way to see or switch to other participants' screen shares
- **Fix**: Replaced `display: none` with a thumbnail strip approach:
  - Focused tile takes full width and `1fr` height (fills available space)
  - Non-focused tiles appear below as smaller thumbnails (`max-height: 120px`, `opacity: 0.7`)
  - Non-focused tiles are clickable to switch focus (existing JS click handler works unchanged)
  - Hover on non-focused tile raises opacity to 1.0 for discoverability
- **No JS changes needed** — CSS-only fix, existing focus toggle logic in `addScreenTile()` click handler works correctly

### 17. Screen Share Audio Not Playing Fix
- Screen share audio tracks were subscribed but not audible to viewers
- **Root cause**: Multiple issues — `track.attach()` may not set `srcObject` immediately in some SDK versions, new audio elements didn't inherit the user's selected speaker device (`sinkId`), and no `onunmute` handler was set for the mediaStreamTrack to re-trigger playback when first data arrives
- **Fix**: After `track.attach()`:
  - Verify `srcObject` is set, manually create `MediaStream` from `mediaStreamTrack` if missing
  - Set `element.volume = 1.0` explicitly
  - Apply `selectedSpeakerId` via `setSinkId()` on newly created audio elements
  - Add `onunmute` handler on `mediaStreamTrack` to re-trigger `ensureAudioPlays` when first data arrives
  - Added debug logging showing srcObject status, mediaStreamTrack enabled/muted state

### 18. Soundboard Drag-and-Drop Fix (Real Fix)
- Drag-and-drop was still not working despite previous child element fixes
- **Root causes**:
  1. Compact view used `<button>` elements which have special browser handling that interferes with HTML5 drag-and-drop
  2. Edit view's `.sound-tile-main` div intercepted mouse events, preventing the parent tile from receiving drag start
  3. `:hover` and `:active` CSS transforms (`translateY`, `scale`) fired during drag initiation, causing element repositioning
- **Fix**:
  - Changed compact icons from `<button>` to `<div role="button" tabindex="0">` for proper drag support
  - Added `setAttribute("draggable", "true")` alongside JS property for explicit HTML attribute
  - CSS: Added `pointer-events: none` on `.sound-tile-main`, `.sound-icon`, `.sound-name` (non-interactive children)
  - CSS: Added `pointer-events: auto` on `.sound-fav`, `.sound-edit` (keep buttons clickable)
  - CSS: Added `user-select: none` and `-webkit-user-drag: element` on draggable elements
  - CSS: `:hover` and `:active` transforms now exclude `.is-dragging` state via `:not(.is-dragging)`

### 19. Local User Stop Watching Own Screen Share
- Sam couldn't hide his own screen tile — "Stop Watching" button wasn't shown for local user
- **Root cause**: `watchToggleBtn: isLocal ? null : ...` explicitly excluded local users
- **Fix**: Removed `isLocal` exclusion, added show/hide logic in `LocalTrackPublished`/`LocalTrackUnpublished` handlers

### 20. Spencer's Mic Audio Fix (Reordered Setup)
- Spencer joined but mic audio wasn't coming through for other users
- **Root causes**: Audio element `play()` called before DOM attachment; `onunmute` property assignment could overwrite SDK handlers
- **Fix**: Reordered audio element setup — DOM append before play(), sinkId before play(), `addEventListener("unmute")` instead of property assignment

### 21. Soundboard Not Heard by Remote Users
- Sam played soundboard but Spencer and Jeff didn't hear anything
- **Root cause**: `soundboardSounds` Map only populated when user opens soundboard panel (`loadSoundboardList()`). Remote users who never opened it had empty map, so `playSoundboardSound()` silently returned
- **Fix**: Added `loadSoundboardList().catch(() => {})` right after `room.connect()` succeeds — all clients now pre-load sounds on join

## Current Status

**Everything working.** External streaming confirmed at 1080p@60fps with real user (Zane).

**Control plane running.** Health check passes. All services up on native Windows processes.

**All 4 friend-requested features implemented:**
1. Stop/Start Watching toggle for screen shares
2. Chat panel as grid column (doesn't cover sidebar)
3. Soundboard icon picker hidden by default
4. Guest avatar upload with persistence

**6 additional fixes/features applied (this session):**
5. Soundboard drag-and-drop now works (pointer-events, div elements, CSS fixes)
6. Device selection dropdowns enabled before connecting
7. Device selections persist across page reloads via localStorage
8. Soundboard redesigned: compact Quick Play panel + full Edit Mode

**5 screen share/audio fixes:**
9. Screen share video no longer cropped when window is maximized
10. Focus mode now shows non-focused tiles as thumbnails instead of hiding them
11. Screen share audio now plays (srcObject safety, sinkId, onunmute handler)
12. Soundboard drag-and-drop actually works now (CSS pointer-events + div elements)
13. Local user can now Stop/Start Watching their own screen share

**2 audio fixes:**
14. Spencer's mic audio fix — reordered DOM append before play, sinkId before play, addEventListener instead of onunmute property
15. Soundboard sounds now heard by all users — `loadSoundboardList()` auto-called on room connect so remote clients have sounds ready

**Network verified.** All IPs unchanged after ATT gateway swap. Port forwarding working through Eero.

## Next Steps
1. **Restart control plane + refresh Tauri client** — app.js changed (soundboard remote playback fix)
2. **Test screen share cropping fix** — maximize window, verify video fills space without cropping
3. **Test focus mode fix** — click a screen tile to focus, verify other tiles appear as thumbnails below
4. **Git commit all changes** — significant work done across sessions
5. **Split app.js into modules** — currently ~5000+ lines, needs splitting for token optimization
6. **Dynamic DNS** — Public IP 99.111.153.69 may change in future

## Network Setup
- **ATT BGW320-500**: IP passthrough / bridge mode (does nothing, just passes traffic)
- **Eero**: Real router — DHCP, NAT, port forwarding, Wi-Fi
- **Public IP**: `99.111.153.69` (verified 2026-02-09)
- **Port forwards** (on Eero): 9443 TCP, 3478 UDP, 40000-40099 UDP, 7881 TCP
- **Firewall**: `core/allow-firewall.ps1`

## Architecture Reference

### Core Components
- **SFU**: LiveKit server (native Windows exe) — handles media routing
- **Control**: Rust control plane — auth, rooms, admin (`core/control`)
- **Client**: Tauri hybrid native app — web UI + Rust backend (`core/client`) **PRIMARY APP**
- **Viewer**: Web viewer — legacy/debug only (`core/viewer`)
- **Deploy**: HTTP deploy agent for test PC (`core/deploy`)
- **TURN**: Native Go TURN server (`core/turn`)

### How Core Starts
- Run script: `F:\Codex AI\The Echo Chamber\core\run-core.ps1`
- Stop script: `F:\Codex AI\The Echo Chamber\core\stop-core.ps1`
- Health: `https://127.0.0.1:9443/health`
- Viewer: `https://127.0.0.1:9443/viewer`
- Native client: `core/target/debug/echo-core-client.exe`

---

**When resuming this chat:**
1. Read this file first
2. Check git log for any commits after this document was last updated
3. External streaming confirmed working — Zane at 1080p@60fps
4. Next priority: git commit + split app.js into modules
