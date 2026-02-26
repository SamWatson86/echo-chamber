# Viewer Modularization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split `core/viewer/app.js` (11,254 lines) into ~20 focused files with zero behavioral changes.

**Architecture:** Regular `<script>` tags loaded in dependency order, sharing global scope — identical to how `app.js`, `jam.js`, and `changelog.js` already work. No ES modules (jam.js, changelog.js, and HTML `onclick` attrs all depend on globals). Each file is self-contained and readable. Later, ES modules can be introduced as a separate effort.

**Tech Stack:** Vanilla JS, browser-native script loading, no bundler/build step.

**Constraints:**
- `jam.js` uses globals: `apiUrl`, `adminToken`, `room`, `debugLog`, `showToast`
- `changelog.js` uses global `ECHO_CHANGELOG`
- HTML uses inline `onclick`: `toggleAdminDash()`, `switchAdminTab()`
- Tauri client embeds viewer files — requires `cargo build -p echo-core-client` after migration
- Control plane serves viewer files from `core/viewer/` — no server changes needed
- Cache busting: all `<script>` tags need `?v=` param (control plane stamps at startup)

---

## Task 1: Create shared state file (`viewer/state.js`)

Extract all top-level `var` declarations from `app.js` lines 1-60 (DOM refs) and lines 307-475 (state variables) into `state.js`. This file is loaded first and establishes all global variables that other modules reference.

**Files:**
- Create: `core/viewer/state.js`
- Modify: `core/viewer/app.js` — remove extracted lines
- Modify: `core/viewer/index.html` — add `<script src="state.js?v=...">` before app.js

**Step 1: Create state.js**

Extract these sections from app.js into state.js:
- Lines 1-59: All `const`/`var` DOM element references (`statusEl`, `connectBtn`, `disconnectBtn`, etc.)
- Lines 61-75: Soundboard tooltip creation + helper functions
- Lines 307-475: All state variables (`chatPanel`, `chatInput`, theme keys, `_viewerVersion`, media state flags, participant maps, token cache, reconnection state, room polling state, bitrate caps, audio context, screen share state, dedup tracking)
- Lines 697-717: Soundboard state variables

**Step 2: Remove extracted lines from app.js**

Delete the lines moved to state.js. Leave a comment at top: `/* State variables are in state.js — loaded before this file */`

**Step 3: Add script tag to index.html**

In index.html, before the `app.js` script tag, add:
```html
<script src="state.js?v=0.3.1"></script>
```

**Step 4: Verify app still works**

Open https://127.0.0.1:9443/viewer/ — connect, send chat, toggle mic, switch rooms. Everything should work identically.

**Step 5: Commit**
```bash
git add core/viewer/state.js core/viewer/app.js core/viewer/index.html
git commit -m "refactor: extract shared state into state.js"
```

---

## Task 2: Extract debug & utilities (`viewer/debug.js`)

Extract debug logging, toast notifications, status helpers, and HTML utility functions.

**Files:**
- Create: `core/viewer/debug.js`
- Modify: `core/viewer/app.js` — remove extracted functions
- Modify: `core/viewer/index.html` — add script tag

**Extract these functions from app.js into debug.js:**
- `debugLog()` (~line 729-745)
- `logEvent()` (~line 752-766)
- `showToast()` (~line 769-841)
- `setStatus()` (~line 2771-2775)
- `describeDisconnectReason()` (~line 2776-2785)
- `escapeHtml()` (~line 8484-8492)
- `linkifyText()` (~line 8493-8520)
- `formatTime()` (~line 8522-8528)
- `escAdm()` (~line 10693-10707) — admin HTML escaping

**Script load order in index.html:**
```html
<script src="state.js?v=0.3.1"></script>
<script src="debug.js?v=0.3.1"></script>
<!-- ... existing scripts ... -->
<script src="app.js?v=0.3.1"></script>
```

**Verify:** Connect, check debug panel works, check toasts appear on room switch.

**Commit:** `refactor: extract debug & utility functions into debug.js`

---

## Task 3: Extract URL & settings helpers (`viewer/urls.js`, `viewer/settings.js`)

**Files:**
- Create: `core/viewer/urls.js`
- Create: `core/viewer/settings.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**urls.js — extract:**
- `getControlUrl()` (~line 488-492)
- `apiUrl()` (~line 1623-1627)
- `setDefaultUrls()` (~line 2724-2754)
- `normalizeUrls()` (~line 2755-2766)
- `tauriInvoke()` / `tauriListen()` / `hasTauriIPC()` / `isAdminMode()` (~lines 1602-1621)

**settings.js — extract:**
- `echoGet()` / `echoSet()` (~lines 612-627)
- `loadAllSettings()` (~lines 574-610)
- `_debouncedPersist()` / `_persistSettings()` (~lines 629-643)
- Volume prefs: `_getVolumePrefs()`, `_saveVolumePrefs()`, `saveParticipantVolume()`, `getParticipantVolume()` (~lines 646-660)
- `_reapplySettingsAfterLoad()` (~lines 662-677)
- Settings ready promise (~lines 680-686)

**Script load order:**
```html
<script src="state.js?v=0.3.1"></script>
<script src="debug.js?v=0.3.1"></script>
<script src="urls.js?v=0.3.1"></script>
<script src="settings.js?v=0.3.1"></script>
```

**Verify:** Connect, check settings persist after refresh, check URL derivation works for both Tauri and browser.

**Commit:** `refactor: extract URL and settings helpers`

---

## Task 4: Extract identity & track helpers (`viewer/identity.js`)

**Files:**
- Create: `core/viewer/identity.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**identity.js — extract:**
- `ensureIdentitySuffix()` (~line 843-856)
- `ensureDeviceId()` (~line 858-881)
- `getLocalDeviceId()` (~line 883-886)
- `slugifyIdentity()` (~line 887-893)
- `buildIdentity()` (~line 895-899)
- `getIdentityBase()` (~line 3710-3713)
- `getInitials()` (~line 3704-3709)
- `getParticipantPublications()` (~line 900-912)
- `getTrackSource()` (~line 458-460)
- `wasRecentlyHandled()` / `markHandled()` (~lines 914-927)
- `setDeviceStatus()` (~line 971-975)
- `getDisplayName()` (search for definition)

**Verify:** Connect with multiple participants, check names display correctly.

**Commit:** `refactor: extract identity and track helpers`

---

## Task 5: Extract noise cancellation (`viewer/rnnoise.js`)

**Files:**
- Create: `core/viewer/rnnoise.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**rnnoise.js — extract:**
- `detectSimdSupport()` (~line 154-160)
- Mobile device detection: `_isMobileDevice` assignment (~line 164) — NOTE: this var should stay in state.js, just the assignment logic goes here
- `enableNoiseCancellation()` (~lines 165-232)
- `startNoiseGate()` / `stopNoiseGate()` (~lines 238-259)
- `updateNoiseGateLevel()` (~lines 261-269)
- `disableNoiseCancellation()` (~lines 271-297)
- `updateNoiseCancelUI()` (~lines 299-305)
- `NC_GATE_THRESHOLDS` constant (~line 236)

**Verify:** Toggle noise cancellation on/off, check gate level slider works.

**Commit:** `refactor: extract RNNoise noise cancellation module`

---

## Task 6: Extract chime system (`viewer/chimes.js`)

**Files:**
- Create: `core/viewer/chimes.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**chimes.js — extract:**
- `getChimeCtx()` (~line 2891-2895)
- `playJoinChime()` (~line 2896-2917)
- `playLeaveChime()` (~line 2918-2941)
- `playSwitchChime()` (~line 2942-2974)
- `playScreenShareChime()` (~line 2975-3011)
- `fetchChimeBuffer()` (~line 3012-3031)
- `playCustomChime()` (~line 3032-3046)
- `playChimeForIdentities()` / `playChimeForParticipant()` (~lines 3047-3109)
- `getChimeKey()` (~line 3065-3072)
- `prefetchChimeBuffersForRoom()` (~line 3074-3086)

**Verify:** Join/leave a room, check chime sounds play. Test with custom chimes.

**Commit:** `refactor: extract chime system into chimes.js`

---

## Task 7: Extract room status & heartbeat (`viewer/room-status.js`)

**Files:**
- Create: `core/viewer/room-status.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**room-status.js — extract:**
- `fetchRoomStatus()` (~line 2875-2889)
- `detectRoomChanges()` (~line 3110-3122)
- `refreshRoomList()` (~line 3123-3168)
- `startRoomStatusPolling()` / `stopRoomStatusPolling()` (~lines 3170-3183)
- `startHeartbeat()` / `stopHeartbeat()` (~lines 3249-3279)
- `sendLeaveNotification()` (~line 3284-3300)
- `fetchOnlineUsers()` / `renderOnlineUsers()` / `startOnlineUsersPolling()` / `stopOnlineUsersPolling()` (~lines 494-537)
- `startUpdateCheckPolling()` / `checkForUpdateNotification()` / `isNewerVersion()` / `showUpdateBanner()` (~lines 3191-3246)

**Verify:** Check room list updates, participant counts, join/leave chimes trigger.

**Commit:** `refactor: extract room status and heartbeat`

---

## Task 8: Extract auth & token management (`viewer/auth.js`)

**Files:**
- Create: `core/viewer/auth.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**auth.js — extract:**
- `getLiveKitClient()` (~line 2767-2770)
- `fetchAdminToken()` (~line 2786-2796)
- `fetchRoomToken()` (~line 2797-2810)
- `ensureRoomExists()` (~line 2812-2822)
- `getCachedOrFetchToken()` (~line 2852-2862)
- `prefetchRoomTokens()` (~line 2824-2850)
- `prewarmRooms()` / `cleanupPrewarmedRooms()` (~lines 3302-3340)

**Verify:** Connect as admin, connect as regular user, switch rooms (tests token caching).

**Commit:** `refactor: extract auth and token management`

---

## Task 9: Extract theme system (`viewer/theme.js`)

**Files:**
- Create: `core/viewer/theme.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**theme.js — extract:**
- `initTheme()` (~line 10359-10390)
- `applyTheme()` (~line 10336-10357)
- `startMatrixRain()` / `stopMatrixRain()` (~lines 10128-10185)
- `startUltraInstinctParticles()` / `stopUltraInstinctParticles()` (~lines 10192-10320)
- `applyUiOpacity()` (~lines 10392-10410)
- Theme button event wiring + settings panel theme section (~lines 10026-10120)
- `buildVersionSection()` (~lines 9996-10004)

**Verify:** Switch all 7 themes, test transparency slider, test Matrix Rain and Ultra Instinct particles.

**Commit:** `refactor: extract theme system`

---

## Task 10: Extract chat system (`viewer/chat.js`)

**Files:**
- Create: `core/viewer/chat.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**chat.js — extract:**
- `EMOJI_LIST` constant (~lines 8462-8482)
- `fetchImageAsBlob()` (~lines 8529-8562)
- `renderChatMessage()` (~lines 8563-8804)
- `addChatMessage()` (~lines 8805-8814)
- `sendChatMessage()` (~lines 8815-8847)
- `handleIncomingChatData()` (~lines 8848-8884)
- `updateChatBadge()` / `incrementUnreadChat()` / `clearUnreadChat()` (~lines 8885-8918)
- `openChat()` / `closeChat()` (~lines 8919-8933)
- `initializeEmojiPicker()` / `toggleEmojiPicker()` (~lines 8934-8958)
- `fixImageOrientation()` (~lines 8959-8987)
- `handleChatImagePaste()` / `handleChatFileUpload()` (~lines 8988-9061)
- `saveChatMessage()` / `loadChatHistory()` / `deleteChatMessage()` (~lines 9062-9135)

**Verify:** Send text messages, send images, send files, test emoji picker, test mobile tap-to-play, load chat history.

**Commit:** `refactor: extract chat system`

---

## Task 11: Extract soundboard (`viewer/soundboard.js`)

**Files:**
- Create: `core/viewer/soundboard.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**soundboard.js — extract:**
- `SOUNDBOARD_ICONS` constant (~lines 4240-4372)
- `setSoundboardHint()` / `updateSoundboardEditControls()` / `updateSoundboardVolumeUi()` / `updateSoundClipVolumeUi()` / `updateSoundboardMasterGain()` / `applySoundboardOutputDevice()` (~lines 6440-6503)
- `getSoundboardContext()` / `stopSoundboardPlayback()` / `primeSoundboardAudio()` / `fetchSoundboardBuffer()` / `playSoundboardSound()` (~lines 6505-6588)
- `upsertSoundboardSound()` / `renderSoundboardIconPicker()` / `toggleSoundboardFavorite()` / `saveSoundboardOrder()` / `sortSoundboardSounds()` / `getSoundboardSoundsFiltered()` (~lines 6590-6663)
- `attachSoundboardDragDrop()` (~lines 6665-6705)
- `renderSoundboardCompact()` / `renderSoundboard()` / `renderAllSoundboardViews()` / `enterSoundboardEditMode()` / `exitSoundboardEditMode()` (~lines 6706-6859)
- `openSoundboard()` / `closeSoundboard()` / `openSoundboardEdit()` / `closeSoundboardEdit()` (~lines 6861-6925)
- `clearSoundboardState()` / `loadSoundboardList()` / `uploadSoundboardSound()` / `updateSoundboardSound()` / `sendSoundboardMessage()` (~lines 7046-7204)
- Soundboard event listeners (~lines 9504-9745)

**Verify:** Open soundboard, play sounds, upload a sound, edit name/icon, drag to reorder, test favorites.

**Commit:** `refactor: extract soundboard system`

---

## Task 12: Extract screen share & canvas pipeline (`viewer/screen-share.js`)

**Files:**
- Create: `core/viewer/screen-share.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**screen-share.js — extract:**
- `getScreenSharePublishOptions()` (~lines 1008-1058)
- `startInboundScreenStatsMonitor()` / `stopInboundScreenStatsMonitor()` (~lines 1059-1601)
- `startScreenShareManual()` (~lines 1630-2310) — includes canvas pipeline
- `stopScreenShareManual()` (~lines 2311-2369)
- Native audio WASAPI worklet processor definition (~lines 2372-2399)
- `autoDetectNativeAudio()` (~lines 2402-2512)
- `startNativeAudioCapture()` (~lines 2513-2650)
- `stopNativeAudioCapture()` (~lines 2651-2707)
- Adaptive bitrate publisher: `handleBitrateCapRequest()`, `cleanupAndApplyBitrateCaps()`, `applyMostRestrictiveCap()`, `applyBitrateToSender()` (~lines 9238-9326)

**Verify:** Share screen, check 60fps canvas pipeline works, check WASAPI audio capture, test adaptive bitrate.

**Commit:** `refactor: extract screen share and canvas pipeline`

---

## Task 13: Extract participant cards & video management (`viewer/participants.js`)

**Files:**
- Create: `core/viewer/participants.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**participants.js — extract:**
- `enterVideoFullscreen()` (~lines 78-122)
- `openImageLightbox()` (~lines 125-150)
- `createLockedVideoElement()` / `configureVideoElement()` / `configureAudioElement()` (~lines 3727-3887)
- `ensureVideoPlays()` / `ensureAudioPlays()` (~lines 3888-3944)
- `replaceScreenVideoElement()` / `kickStartScreenVideo()` (~lines 3946-3997)
- `scheduleScreenRecovery()` (~lines 3998-4024)
- `requestVideoKeyFrame()` / `forceVideoLayer()` / `ensureVideoSubscribed()` / `getTrackSid()` (~lines 4025-4122)
- `attachVideoDiagnostics()` / `cleanupVideoDiagnostics()` (~lines 4123-4215)
- `ensureParticipantCard()` (~lines 4368-5118)
- `resubscribeParticipantTracks()` / `attachParticipantTracks()` (~lines 5119-5139)
- Avatar functions: `updateAvatarVideo()`, `uploadAvatar()`, `updateAvatarDisplay()`, `broadcastAvatar()` (~lines 5140-5292)
- Camera recovery: `scheduleCameraRecovery()` / `ensureCameraVideo()` (~lines 5307-5377)
- Screen tile management: `addTile()`, `addScreenTile()`, `registerScreenTrack()`, `unregisterScreenTrack()`, `clearScreenTracksForIdentity()`, `removeScreenTile()`, `startScreenWatchdog()`, `clearMedia()` (~lines 3406-3703)
- Tile helpers: `isUnwatchedScreenShare()` (~lines 443-455)

**Verify:** Connect multiple participants, check video tiles render, test volume sliders, test fullscreen, test avatar display.

**Commit:** `refactor: extract participant cards and video management`

---

## Task 14: Extract audio routing & track subscription (`viewer/audio-routing.js`)

**Files:**
- Create: `core/viewer/audio-routing.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**audio-routing.js — extract:**
- `getParticipantAudioCtx()` (~lines 408-420)
- `setRoomAudioMutedState()` (~lines 2709-2723)
- `ensureGainNode()` / `cleanupGainNode()` (~lines 5506-5542)
- `startAudioMonitor()` / `stopAudioMonitor()` (~lines 5553-5688)
- `applyParticipantAudioVolumes()` (~lines 5559-5587)
- `updateActiveSpeakerUi()` (~lines 5588-5625)
- `handleTrackSubscribed()` (~lines 5689-6010)
- `handleTrackUnsubscribed()` (~lines 6011-6217)
- Media reconciler: `runFullReconcile()`, `scheduleReconcileWaves()`, `scheduleReconcileWavesFast()`, `resetRemoteSubscriptions()`, `startMediaReconciler()`, `stopMediaReconciler()` (~lines 5416-5558)

**Verify:** Connect, check audio plays from other participants, test per-participant volume sliders, test room audio mute.

**Commit:** `refactor: extract audio routing and track subscription`

---

## Task 15: Extract device management & media controls (`viewer/media-controls.js`)

**Files:**
- Create: `core/viewer/media-controls.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**media-controls.js — extract:**
- `refreshDevices()` / `setSelectOptions()` / `switchMic()` / `switchCam()` / `switchSpeaker()` / `ensureDevicePermissions()` (~lines 6265-6438)
- `toggleMic()` / `reduceCameraForScreenShare()` / `restoreCameraQuality()` (~lines 9159-9237)
- `toggleCam()` (~lines 9347-9388)
- `toggleScreen()` / `restartScreenShare()` (~lines 9390-9428)
- `toggleMicOn()` / `toggleCamOn()` / `toggleScreenOn()` / `enableAllMedia()` (~lines 9433-9451)
- Camera lobby: `openCameraLobby()` / `closeCameraLobby()` / `populateCameraLobby()` / `createCameraTile()` / `toggleEnlargeTile()` / `updateCameraLobbySpeakingIndicators()` (~lines 6933-7045)

**Verify:** Toggle mic/cam/screen, switch devices, open camera lobby.

**Commit:** `refactor: extract device management and media controls`

---

## Task 16: Extract admin dashboard (`viewer/admin.js`)

**Files:**
- Create: `core/viewer/admin.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**admin.js — extract:**
- `adminKickParticipant()` / `adminMuteParticipant()` (~lines 10578-10623)
- `toggleAdminDash()` (~line 10626-10651) — NOTE: must remain global (used in HTML onclick)
- `switchAdminTab()` (~line 10684-10691) — NOTE: must remain global (used in HTML onclick)
- `fetchAdminDashboard()` / `renderAdminDashboard()` (~lines 10713-11040)
- `fetchAdminHistory()` (~lines 10755-10791)
- `fetchAdminMetrics()` / `renderAdminQuality()` (~lines 11041-11151)
- `fetchAdminBugs()` (~lines 11152-11177)
- `fetchAdminDeploys()` / `renderAdminDeploys()` (~lines 11178-11237)
- Admin helpers: `_admUserColor()`, `_admSelectUser()`, `_admHeatCellClick()`, `fmtDur()`, `fmtTime()` (~lines 10792-10813)
- Bug report: `openBugReport()` / `sendBugReport()` / `closeBugReportModal()` (~lines 10416-10570)

**Verify:** Open admin dashboard, check all 5 tabs (Live, History, Metrics, Bugs, Deploys), test kick/mute, submit bug report.

**Commit:** `refactor: extract admin dashboard`

---

## Task 17: Extract connect/disconnect lifecycle (`viewer/connect.js`)

This is the biggest and most critical extraction — the room connection lifecycle.

**Files:**
- Create: `core/viewer/connect.js`
- Modify: `core/viewer/app.js`
- Modify: `core/viewer/index.html`

**connect.js — extract:**
- `connectToRoom()` (~lines 7206-8269) — the main connection function
- Room switching: `switchRoom()` (~lines 3342-3405)
- Room list rendering + click handlers (~lines 8274-8391)
- `disconnect()` (~lines 8395-8458)
- Identity migration code (~lines 8196-8260)
- Connect/disconnect button event listeners (~lines 9147-9156)

**Verify:** This is the most critical test. Must verify:
1. Connect as admin
2. Connect as regular user
3. Disconnect and reconnect
4. Switch rooms
5. Check reconnection after network drop (disconnect WiFi briefly)

**Commit:** `refactor: extract connect/disconnect lifecycle`

---

## Task 18: Finalize main.js and clean up app.js

**Files:**
- Rename: `core/viewer/app.js` → `core/viewer/main.js` (or keep as app.js with just init code)
- Modify: `core/viewer/index.html` — update script tag order

**What remains in app.js/main.js:**
- DOMContentLoaded / initialization sequence
- Event listener wiring for remaining UI (settings panel open/close, room create button, etc.)
- `beforeunload` handler
- Any remaining glue code that ties modules together
- Window resize handlers

**Final script load order in index.html:**
```html
<script src="livekit-client.umd.js?v=0.3.2"></script>
<script src="room-switch-state.js?v=0.3.2"></script>
<script src="jam-session-state.js?v=0.3.2"></script>
<script src="publish-state-reconcile.js?v=0.3.2"></script>
<script src="state.js?v=0.3.2"></script>
<script src="debug.js?v=0.3.2"></script>
<script src="urls.js?v=0.3.2"></script>
<script src="settings.js?v=0.3.2"></script>
<script src="identity.js?v=0.3.2"></script>
<script src="rnnoise.js?v=0.3.2"></script>
<script src="chimes.js?v=0.3.2"></script>
<script src="room-status.js?v=0.3.2"></script>
<script src="auth.js?v=0.3.2"></script>
<script src="theme.js?v=0.3.2"></script>
<script src="chat.js?v=0.3.2"></script>
<script src="soundboard.js?v=0.3.2"></script>
<script src="screen-share.js?v=0.3.2"></script>
<script src="participants.js?v=0.3.2"></script>
<script src="audio-routing.js?v=0.3.2"></script>
<script src="media-controls.js?v=0.3.2"></script>
<script src="admin.js?v=0.3.2"></script>
<script src="connect.js?v=0.3.2"></script>
<script src="app.js?v=0.3.2"></script>
<script src="jam.js?v=0.3.2"></script>
<script src="changelog.js?v=0.3.2"></script>
```

**Step 1:** Update all script tags in index.html with final load order
**Step 2:** Verify app.js is now only initialization + event wiring (~200-400 lines)
**Step 3:** Full regression test — connect, chat, soundboard, screen share, room switch, admin, themes
**Step 4:** Commit: `refactor: finalize modularization — app.js is now init-only`

---

## Task 19: Update Rust control plane to serve new files

The control plane may need to serve the new JS files. Check if it uses a static file server (serves entire `viewer/` directory) or explicitly lists files.

**Files:**
- Check: `core/control/src/main.rs` — look for viewer file serving
- Modify if needed: add new file routes

**Step 1:** Read the viewer serving code in main.rs
**Step 2:** If it serves the entire `viewer/` directory (likely), no changes needed
**Step 3:** If it explicitly lists files, add all new `.js` files
**Step 4:** If changes were needed, rebuild: `cd core && cargo build -p echo-core-control`
**Step 5:** Commit if modified: `fix: serve new viewer module files`

---

## Task 20: Rebuild Tauri client & final verification

Since Tauri embeds viewer files at compile time, rebuild the client.

**Step 1:** Rebuild client: `cd core && cargo build -p echo-core-client`
**Step 2:** Launch rebuilt client, verify all features work
**Step 3:** Deploy to SAM-PC for second-device testing
**Step 4:** Bump version in index.html to `0.3.2`
**Step 5:** Update CURRENT_SESSION.md with modularization completion
**Step 6:** Final commit: `feat: viewer modularization complete — app.js split into 20 focused modules`

---

## Risk Notes

1. **Circular function references**: Some functions call each other across what will be module boundaries. Since all files share global scope, this works as long as the calling function is invoked AFTER both files are loaded (which is always true — functions are defined at parse time, called at runtime).

2. **Variable hoisting**: `var` declarations are hoisted to function/global scope. Moving `var` declarations to `state.js` loaded first ensures they exist when other files reference them. `const`/`let` are block-scoped but since they're at top level, they behave similarly.

3. **DOM readiness**: DOM element refs (`document.getElementById(...)`) must run after DOM is parsed. Currently they're at the top of app.js which runs at the bottom of `<body>`. Moving them to `state.js` (also loaded at bottom of body) preserves this.

4. **Fallback plan**: If any module extraction breaks something, the fix is to move the problematic code back into app.js and try again with a different boundary. Each task is independently reversible.
