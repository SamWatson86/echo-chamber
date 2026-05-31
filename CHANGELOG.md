# Changelog

## 0.6.19

- Fix: H264 SDP bitrate hints now use the publish profile's real minimum bitrate and full target start bitrate, so game streams start/ramp at the intended budget instead of falling back to a low allocator hint.
- Diagnostics: Desktop Duplication sender stats now emit once per 60 published frames instead of repeating when publisher pacing holds the frame counter steady.
- Diagnostics: Windows client startup logs now include the desktop binary version.
- Release: Desktop and control package versions are bumped to 0.6.19.

## 0.6.18

- Fix: Native screen shares now force WebRTC's framerate-preserving `ContentHint=Fluid` even when the track is labeled as a screenshare, preventing DXGI Desktop Duplication monitor/game streams from collapsing to single-digit FPS under CPU/backpressure adaptation.
- Release: Desktop and control package versions are bumped to 0.6.18 for the required native binary update.

## 0.6.17

- Change: Game sharing now defaults to Desktop Duplication with the game publish profile instead of silently falling through WGC.
- Diagnostics: WGC remains available as an explicit game capture mode for A/B testing.
- Admin: Capture health now reports sender FPS, target bitrate, available outgoing bitrate, quality limitation, and encoder so live stream collapses are visible from the dashboard.
- Release: Desktop and control versions are bumped to 0.6.17.

## 0.6.16

- Improve: Native screen sharing now publishes desktop and game captures with higher bitrate budgets for sharper streams.
- Admin: Add receiver-side stream bitrate diagnostics so live sessions can show who sees whose stream, at what resolution/FPS/bitrate, with loss and jitter counters.

## 0.6.15

- Fix: Native screen-share audio now adapts WASAPI mono, multichannel, and sample-rate-mismatched formats to browser stereo before publishing, eliminating robotic or garbled shared audio.

## 0.6.14

- Fix: Native screen sharing now starts audio for window shares and full-monitor shares, including system loopback for entire-screen captures.
- Fix: WASAPI process-loopback fallback now uses PCM16 44.1 kHz with autoconvert, matching Microsoft's ApplicationLoopback sample and avoiding silent fallback frames.
- Fix: Jam Spotify capture finds the root Spotify process across sessions and logs frame levels for live verification.

## 0.6.13

- Fix: Native full-monitor screen sharing keeps publishing heartbeat frames when Windows Graphics Capture stops delivering repaint callbacks, preventing connected screen publishers from sitting at `0fps/0kbps`.
- Fix: Jam start now fails cleanly if the Spotify audio bot cannot start, instead of leaving an active Jam with no bot and causing reconnect loops.

## 0.6.11

- Fix: Windows 10 native Entire Screen sharing now auto-falls back to software H264 on the native DXGI Desktop Duplication path when no encoder override is configured, eliminating the blank `0fps` viewer tile on Win10 publishers like `SAM-PC`
- Fix: Native Win10 software H264 screen publishers now negotiate the browser-friendly H264 packetization path that actually renders for viewers instead of stalling on a dead hardware/adapter route
- Fix: New remote screen shares auto-watch on first publish, so already-connected viewers no longer miss startup keyframes behind a manual watch prompt
- Fix: Remote screen tiles prefer the SDK attach path for screen video, reducing blank first-attach edge cases on live screen shares
- Maintenance: Windows release packaging is explicitly NSIS-only again; no macOS artifact or updater manifest baggage in the release path

## 0.4.1

- Fix: "Update available" banner no longer shows after updating (version sync between Cargo.toml and tauri.conf.json)
- Fix: Camera card no longer glitches after stopping camera on macOS (guard against dead track re-attach)
- Fix: Jam queue no longer empties when searching for new songs (server was draining queue when Spotify played non-queued tracks)
- Chat: Clicking images now opens a fullscreen lightbox overlay (ESC or click to close)

## 0.4.0

- macOS Apple Silicon (aarch64) DMG now included in releases
- macOS auto-updater support via unified latest.json manifest
- Viewer refactored into modular JS files (auth, chat, media, participants, etc.)
- Fix camera desync under rapid toggling
- Fix camera state tracking to use SDK isCameraEnabled

## 0.3.1

- Security: Fixed links in chat opening on the server's desktop instead of the user's machine
- Identity: Prevent name impersonation — server rejects duplicate names while original user is connected
- Chat: Video and audio files now play inline instead of showing a generic file icon
- Chat: Textarea is no longer smushed — placeholder text is now visible
- Soundboard: Toast notification shows who played which sound
- Jam: Join/Leave buttons respond immediately, error shown if audio connection fails
- Jam: Queue auto-clears songs when they finish playing
- Bug reports: Attach screenshots to bug reports
- Updates: Auto-notification banner when a new version is available on GitHub
- Updates: Check for Updates now queries GitHub releases instead of only Tauri IPC
- Room switching: Instant visual feedback when clicking a room
- Avatars: Error toast shown when upload exceeds 50MB limit

## 0.3.0

- Jam Session: Listen to Spotify together in real-time with everyone in the room
- Now Playing banner shows the current track at the top of the screen
- Search for songs, queue them up, and skip tracks
- Audio streams automatically to all connected listeners
- Jam ends automatically when everyone leaves
- Bug report system: report issues directly from the app
- Performance: average streaming metrics displayed in settings
- Removed legacy app code and cleaned up project structure

## 0.2.9

- macOS support: platform guards and audio stub for Apple Silicon
- Screen share improvements and adaptive quality tuning
- Various bug fixes and stability improvements
