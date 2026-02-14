# Changelog

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
