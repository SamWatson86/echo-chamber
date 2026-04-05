# Game Capture Quality & Polish — Implementation Plan

**Date**: 2026-04-03
**Status**: Ready to execute
**Branch**: claude/elastic-gagarin (21 commits ahead of main)
**Context**: Game capture pipeline works end-to-end at 60fps. David confirmed external delivery works but quality is grainy due to publisher BWE capping encoder bitrate.

---

## TASK 0: Fix Publisher Bitrate (CRITICAL — affects ALL users)

### Problem
The Rust SDK's WebRTC publisher connects to the SFU on localhost. TWCC bandwidth estimation on localhost produces bad estimates (~2-5 Mbps actual) regardless of the 50 Mbps max_bitrate ceiling. NVENC encoder is told to encode at low bitrate → everyone sees grainy video.

### Fix Options (try in order)

**Option A: Force high initial bitrate in libwebrtc**
- The `webrtc-sys` crate exposes `RtpParameters` and `RtpEncodingParameters` via cxxbridge
- Check if `sender.set_parameters()` can set `min_bitrate` and `start_bitrate` on the RTP sender AFTER publish
- In `game_capture.rs`, after `publish_track()` + 3s wait, get the `LocalTrackPublication`, access the underlying `RtpSender`, and set encoding parameters with `min_bitrate = 15_000_000`
- This overrides BWE's conservative estimate. On localhost there's no real congestion, so it's safe.

**Option B: Disable TWCC on publisher transport**
- LiveKit SFU config may have `rtc.disable_twcc` or similar
- Check `livekit.yaml` docs for the installed version (v1.9.11)
- Without TWCC feedback, the publisher encoder uses the max_bitrate as target
- Risk: if enabled globally, external publishers also lose congestion control

**Option C: Use LiveKit Ingress API (bypass WebRTC publisher)**
- Instead of `Room::connect()` + `publish_track()`, use LiveKit's WHIP/Ingress endpoint
- Encode with NVENC independently, push H264 RTP directly to the SFU
- The SFU treats it as an ingested stream with no publisher BWE
- Most work but cleanest solution — full control over encoding quality

**Option D: Try VP9 codec**
- VP9 is ~30% more efficient than H264 per bit
- At the same capped bitrate (~5 Mbps), VP9 will look noticeably sharper
- Software VP9 encoder in libwebrtc — no NVENC, but 4090 CPU can handle it
- Quick test: change `VideoCodec::H264` → `VideoCodec::Vp9` in game_capture.rs

### Research Steps
1. Check `webrtc-sys` crate for `RtpSender::set_parameters()` or `RtpParameters` access
2. Check if `LocalTrackPublication` exposes the underlying RTP sender
3. Search LiveKit Rust SDK issues for "bitrate" or "BWE" or "minimum bitrate"
4. Check livekit.yaml docs for TWCC/BWE overrides

### Files
- `core/client/src/game_capture.rs` — publish options, post-publish sender config
- `core/sfu/livekit.yaml` — SFU transport config

---

## TASK 1: Re-enable Simulcast with Quality Tiers

### Problem
Simulcast is currently OFF (workaround for localhost BWE picking LOW layer). Friends need simulcast for adaptive quality based on their connection.

### Plan
Once Task 0 fixes the publisher bitrate, re-enable simulcast with 3 encoding layers:

```
ULTRA/HIGH: Native res (2560x1600) @60fps, 15-30 Mbps
MEDIUM:     1280x800 @60fps, 3-5 Mbps
LOW:        854x533 @30fps, 1-2 Mbps
```

In `game_capture.rs`:
```rust
let publish_options = TrackPublishOptions {
    source: TrackSource::Screenshare,
    video_codec: VideoCodec::H264,
    simulcast: true,
    video_encoding: Some(VideoEncoding {
        max_bitrate: 30_000_000,
        max_framerate: 60.0,
    }),
    ..Default::default()
};
```

The LiveKit SDK auto-generates simulcast layers from the top encoding. The viewer's existing adaptive layer system (screen-share.js) handles quality switching per subscriber.

### Files
- `core/client/src/game_capture.rs` — re-enable simulcast
- `core/viewer/screen-share.js` — localhost bypass already in place

---

## TASK 2: Fix Green Screen on Start

### Problem
First ~1 second shows green (Y=0 in I420 = green). The hook hasn't written to the shared texture yet when the client starts reading.

### Fix
In `game_capture.rs` frame loop, skip frames where data is all zeros:

```rust
// After mapping the staging texture, check if data is valid
let first_pixel_sum: u32 = bgra_data[..16].iter().map(|&b| b as u32).sum();
if first_pixel_sum == 0 && frame_count < 120 {
    context.Unmap(staging_tex, 0);
    continue; // Skip empty frames
}
```

Also consider: don't call `source.capture_frame()` until we've seen at least one non-zero frame. This prevents the green flash in the viewer entirely.

### Files
- `core/client/src/game_capture.rs` — frame validation before capture_frame()

---

## TASK 3: Fix DLL Re-injection Race

### Problem
Sharing, stopping, then sharing again into the same game PID fails. The old DLL hasn't fully unloaded (200ms FreeLibraryAndExitThread delay) so LoadLibraryW bumps refcount instead of loading fresh. Hook uses stale control block/event handles.

### Fix
1. In `game_capture.rs` `stop()`, set control block `running=0` (already done)
2. In `game_capture.rs` `start()`, after `stop()`, poll the game process for DLL unload:
   ```rust
   // Wait up to 2 seconds for old DLL to unload
   for _ in 0..20 {
       tokio::time::sleep(Duration::from_millis(100)).await;
       if !is_dll_loaded_in_process(target_pid, "echo_game_hook.dll") {
           break;
       }
   }
   ```
3. Implement `is_dll_loaded_in_process()` using `EnumProcessModules` or `CreateToolhelp32Snapshot` + `Module32First/Next`
4. If DLL is still loaded after 2 seconds, return error "previous capture still running"

### Files
- `core/client/src/game_capture.rs` — stop() cleanup, start() polling
- `core/client/src/injector.rs` — add `is_dll_loaded_in_process()` helper

---

## TASK 4: Replace 3-Second Sleep Hack

### Problem
`publish_track()` returns before SDP negotiation completes. Current fix is a blind 3-second sleep.

### Fix
After `publish_track()`, poll the room's event stream for the negotiation completion:

```rust
let (room, mut events) = Room::connect(sfu_url, token, opts).await?;
// ... publish track ...

// Wait for negotiation to complete (up to 10 seconds)
let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
loop {
    tokio::select! {
        Some(event) = events.recv() => {
            // Look for track publication confirmed or publisher connected events
            match event {
                RoomEvent::LocalTrackPublished { .. } => break,
                _ => continue,
            }
        }
        _ = tokio::time::sleep_until(deadline) => {
            eprintln!("[game-capture] negotiation timeout after 10s");
            break;
        }
    }
}
```

Note: need to check which RoomEvent signals SDP completion. Might be `LocalTrackPublished` or a connection state change.

### Files
- `core/client/src/game_capture.rs` — replace sleep with event-driven wait

---

## TASK 5: Fix "$screen joined" Toast Spam

### Problem
Viewer shows repeated "$screen participant joined" toasts. The $screen identity reconnects during the 3-second negotiation window or when the SFU's publish supervisor times out.

### Fix
In the viewer JS, suppress join/leave toasts for `$screen` identities:

```javascript
// In connect.js participant joined handler
if (identity.endsWith('$screen')) return; // Don't toast $screen companions
```

This may already be partially handled by the $screen filtering in participants.js, but the toast itself might fire before the filter.

### Files
- `core/viewer/connect.js` — suppress $screen toasts

---

## TASK 6: SFU Upgrade for enable_loopback_candidate

### Problem
Currently `use_external_ip: true` with `node_ip: 192.168.5.70`. External users work. Local Rust SDK connects via IPv6 link-local (works but not ideal). Proper fix: `enable_loopback_candidate: true` adds 127.0.0.1 alongside external IP.

### Plan
1. Check latest LiveKit SFU releases for `enable_loopback_candidate` support
2. Download newer binary (must be Windows x64)
3. Test with: `use_external_ip: true` + `enable_loopback_candidate: true` + `node_ip: 192.168.5.70`
4. Verify both local Rust SDK and external users connect

### Files
- `core/sfu/livekit-server.exe` — replace binary
- `core/sfu/livekit.yaml` — add enable_loopback_candidate

---

## Execution Order

1. **Task 0** — Fix publisher bitrate (CRITICAL, do first)
2. **Task 2** — Fix green screen (quick win, 5 min)
3. **Task 5** — Fix toast spam (quick win, 2 min)
4. **Task 3** — Fix re-injection race (moderate, 15 min)
5. **Task 4** — Replace sleep hack (moderate, 15 min)
6. **Task 1** — Re-enable simulcast with tiers (after Task 0 proven)
7. **Task 6** — SFU upgrade (independent, can do anytime)

## Build Notes
- Worktree build is broken (abseil headers). Build from main repo `core/` dir.
- Copy source from elastic-gagarin worktree → main repo → build.
- Hook DLL must be rebuilt separately (`cargo build -p echo-game-hook`) and requires game to be closed.
- Commit changes back to elastic-gagarin worktree after testing.
