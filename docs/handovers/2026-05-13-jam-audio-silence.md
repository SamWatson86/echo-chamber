# 2026-05-13 Jam Audio Silence Handover

## Active Worktree

- Path: `F:\EC-worktrees\jam-audio-silence`
- Branch: `codex/jam-audio-silence-investigation`
- Base: `main` at `ad8fd6d7` (`v0.6.13`)

## Problem

Sam reported that the Jam session had no audio even though Spotify looked active. Restarting the Jam bot and changing Spotify output did not restore audio.

Sam later reported that Echo also could not receive screen-share audio, making this look like a broader process-loopback audio problem rather than a Jam-only problem.

## Evidence Gathered

- Live server reported `0.6.13` and was running from `F:\EC-worktrees\main\core\target\release\echo-core-control.exe`.
- Jam bot connected and broadcast frames, but frame-level logs stayed at `peak=0.000000 rms=0.000000`.
- A WebSocket sample from `/api/jam/audio` received 7680-byte binary frames, but decoded f32 samples were all zero.
- Spotify playback was active after a Spotify API resume call.
- Windows audio-session probing showed Spotify producing nonzero audio on an output endpoint in the earlier capture, so the silence was isolated to Echo's process-loopback capture path.
- Microsoft's official ApplicationLoopback sample initializes process loopback with fixed PCM16 44.1 kHz format plus `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`; Echo's fallback path was using 48 kHz float32 without autoconvert after `GetMixFormat` returned `E_NOTIMPL`.
- Native screen-share audio uses duplicated process-loopback code in `core/client/src/audio_capture.rs`; that copy still had the same old 48 kHz float32 fallback. `core/admin-client/src/audio_capture.rs` had the same stale local-admin copy.

## Code Changes In This Worktree

- `core/control/src/audio_capture.rs`
  - Keeps the cross-session Spotify process snapshot lookup and root PID selection.
  - Adds a tested process-loopback fallback format: stereo PCM16, 44.1 kHz, 16-bit, 4-byte block align.
  - Adds `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` when using the fallback format.
  - Converts fallback PCM16 samples to f32 through the existing int16 conversion path.
- `core/client/src/audio_capture.rs`
  - Applies the same tested PCM16 44.1 kHz fallback and `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` to native screen-share audio capture.
- `core/admin-client/src/audio_capture.rs`
  - Applies the same fallback fix to the local admin shell copy.
- `core/control/src/jam_bot.rs`
  - Keeps frame-level peak/RMS logging at frame 1 and every 250 frames.
- `core/control/Cargo.toml`
  - Enables `Win32_System_Diagnostics_ToolHelp` for process snapshot lookup.
- `core/docs/AUDIO_PIPELINE.md`
  - Documents the shared process-loopback fallback and current `audio-capture-data` / `audio-capture-format` Tauri events.

## Verification

Run from `F:\EC-worktrees\jam-audio-silence\core`:

```powershell
cargo test -p echo-core-control audio_capture
cargo test -p echo-core-client audio_capture
cargo test -p echo-core-admin audio_capture
cargo check -p echo-core-control
cargo check -p echo-core-client
cargo check -p echo-core-admin
```

Current results:

- `cargo test -p echo-core-control audio_capture`: 4 passed, 0 failed.
- `cargo test -p echo-core-client audio_capture`: 2 passed, 0 failed.
- `cargo test -p echo-core-admin audio_capture`: 2 passed, 0 failed.
- `cargo check -p echo-core-control`: exit 0.
- `cargo check -p echo-core-client`: exit 0.
- `cargo check -p echo-core-admin`: exit 0.
- Existing warnings remain in unrelated files: unused imports in `chat.rs`, `rooms.rs`, generated dependency/local SDK warnings, and client capture/screen capture dead-code warnings.

## Deployment Boundary

This fix is not live yet. It changes the server/control binary and the desktop/admin client binaries. To test Jam live, build `echo-core-control.exe` from this worktree and restart the control service or EchoCoreHost-managed control child. To test native screen-share audio live, rebuild/relaunch the desktop client from this worktree. Those actions can disrupt connected users or Sam's local Echo client, so do not do them without Sam explicitly approving a restart/deploy/relaunch window.

## Resume Prompt

If Sam starts a fresh thread in this worktree and says `continue`, load `AGENTS.md`, `START_HERE.md`, `docs/OPERATIONS.md`, `docs/RELEASE-BOUNDARIES.md`, and this handover. Then:

1. Confirm git status and live service state.
2. Re-run `cargo test -p echo-core-control audio_capture`, `cargo test -p echo-core-client audio_capture`, and `cargo test -p echo-core-admin audio_capture`.
3. Ask Sam before any build/deploy/restart/relaunch.
4. If Sam approves Jam live testing, build the control binary, deploy it to the configured live path, restart the control service/host, restart the Jam bot, and confirm nonzero `[jam-bot] frame level` peak/RMS.
5. If Sam approves screen-share audio live testing, rebuild/relaunch the desktop client, start a native game/window share with audio, and confirm `[native-audio] FIRST NON-SILENT chunk` plus remote screen-audio analyser activity.
