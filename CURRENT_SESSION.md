# Echo Chamber - Current Session Notes

**Last Updated**: 2026-04-05 (evening)
**Current Version**: v0.5.0 (client Cargo.toml) / v0.5.1 (last released)
**GitHub**: https://github.com/SamWatson86/echo-chamber

## SESSION SUMMARY — Major Breakthroughs (2026-04-05)

### STATUS: WGC + GPU Pipeline Working — 53fps BF6 4K, SFU Fixed

Three major fixes this session:
1. **SFU BWE fix** — re-enabled `congestion_control: true`, allocation now "optimal"
2. **WGC capture pipeline** — replaces DXGI DD for game capture, MPO-aware, focus-independent
3. **GPU shader integration** — WGC frames processed via D3D11 compute shader on WGC's own device

### WHAT WAS FIXED THIS SESSION

**1. ContentHint=Fluid (MAINTAIN_FRAMERATE)** — CRITICAL FIX
- File: `core/webrtc-sys-local/src/peer_connection_factory.cpp`
- Also: `core/webrtc-sys-local/include/livekit/video_track.h` (added `is_screencast()` to VideoTrackSource)
- Also: `core/webrtc-sys-local/src/video_track.cpp` (implemented `is_screencast()`)
- What: Sets ContentHint::Fluid on non-screencast video tracks at creation time
- Effect: WebRTC uses DegradationPreference::MAINTAIN_FRAMERATE — NEVER drops FPS, only reduces resolution
- Before: SetRates fps=10 → backpressure → capture degraded from 100fps to 12fps
- After: SetRates fps=101 → capture sustained at 100fps indefinitely

**2. RID Quality Label Fix (LOW → HIGH)** — CRITICAL FIX
- File: `core/livekit-local/src/room/options.rs` (in `into_rtp_encodings`)
- What: For non-simulcast single-layer tracks, RID was 'q' (LOW quality) instead of 'f' (HIGH)
- Effect: SFU StreamAllocator now allocates FULL bandwidth instead of minimum
- Before: SFU saw 1080p@20Mbps track labeled "LOW" → allocated ~700kbps
- After: SFU sees "HIGH" → allocates full bandwidth → **100fps on desktop**

**3. TrackSource::Camera (from previous session, kept)**
- File: `core/client/src/desktop_capture.rs` line 641
- What: Changed TrackSource::Screenshare → TrackSource::Camera
- Effect: SFU StreamAllocator treats as motion content (preserve FPS > resolution)

### REMAINING ISSUE — DXGI DD Drops to 5fps When Game Focused (SOLVED: Use WGC)

**DXGI DD is compositor-bound:** When a focused game is rendering heavily, DWM reduces its composition rate → DXGI DD capture drops from 90fps to 4-5fps. This is NOT MPO/Independent Flip (tested: disabling MPO via OverlayTestMode=5 made it WORSE — 1fps + system freeze because GPU can't handle forced DWM compositing + 4K game rendering simultaneously).

**Solution: Windows Graphics Capture (WGC) window capture** — tested and confirmed:
- WGC captures at **30-34fps with game focused** (vs DXGI DD's 4-5fps)
- WGC captures at **69fps unfocused** (fresh session) / **34fps** (during active gameplay)
- WGC is MPO-aware, captures directly from the window's swap chain presentation
- Requires `MinimumUpdateIntervalSettings::Custom(Duration::from_millis(1))` — default (0ms) has a Windows bug that caps at ~50fps
- Requires Windows 11 24H2+ (build 26200) — Sam has this
- Uses `windows-capture` crate v1.5, `frame.as_raw_texture()` for GPU texture access

**Implementation plan (NOT YET DONE):**
1. Extract `GpuConverter` from `desktop_capture.rs` into shared module
2. In WGC `on_frame_arrived`: extract device via `as_raw_texture().GetDevice()` → create GpuConverter on WGC's device (once) → CopyResource → compute shader (downscale 4K→1080p + HDR→SDR) → staging → CPU buffer → channel
3. Main loop: receive 1080p BGRA → libyuv I420 → NativeVideoSource → NVENC → SFU
4. Key: all GPU work inside callback (WGC serializes callbacks, thread-safe), send only 8MB CPU buffer through channel (not 33MB 4K)
5. NVENC fails at 4K input — must downscale to 1080p first (GPU shader handles this)
6. Need 3-second negotiation wait after publish_track (missing this = no SFU track)

**Research confirmed:**
- WGC's internal D3D11 device is fully functional — supports compute shaders, CopyResource, staging textures
- `frame.as_raw_texture()` texture is only valid during callback — must CopyResource before returning
- No cross-device sharing needed — build entire GPU pipeline on WGC's device
- WGC callback serialized — no thread safety concerns for immediate context

### KNOWN ISSUE — Screen Share Monitor Fallback

When sharing a game via DXGI DD and the game closes, the stream doesn't stop — it falls back to sharing the entire monitor where the game was. Expected DXGI DD behavior but should be handled better.

### PICKER CRASH — RESOLVED (Was CD Game Crash)

The screen picker freeze/crash during this session was caused by Crimson Desert crashing (GPU resources invalidated → DXGI handles fail → GetMonitorInfoW/GetClientRect errors in logs). NOT caused by our code changes. Confirmed by:
- Picker worked fine after game restart
- Client logs showed `GetMonitorInfoW failed` and `GetClientRect failed` during freeze
- Sam confirmed "the game crashed too"

### CURRENT STATE OF FILES

**Modified in worktree `modest-leakey` (branch `claude/modest-leakey`):**

Rust client:
- `core/client/src/desktop_capture.rs` — TrackSource::Camera (line 641)

webrtc-sys-local (C++ encoder fixes — ALL from previous session PLUS new):
- `src/peer_connection_factory.cpp` — **NEW**: ContentHint=Fluid for non-screencast + `#include "livekit/video_track.h"`
- `include/livekit/video_track.h` — **NEW**: Added `bool is_screencast() const;` to VideoTrackSource
- `src/video_track.cpp` — **NEW**: Implemented `VideoTrackSource::is_screencast()`
- `src/nvidia/nvidia_encoder_factory.cpp` — Multi-profile H264 (previous session)
- `src/nvidia/h264_encoder_impl.cpp` — Profile GUID, SetRates, trusted rate controller (previous session)
- `src/video_encoder_factory.cpp` — Creation tracing (previous session)
- `src/video_track.cpp` — AdaptFrame bypass (previous session) + is_screencast (new)

LiveKit SDK fork:
- `core/livekit-local/src/room/options.rs` — **NEW**: RID 'q'→'f' for single-layer non-simulcast

SFU config:
- `core/sfu/livekit.yaml` — Currently `congestion_control.enabled: false` (NEEDS to be changed to `true`)

**NOT modified (important — viewer JS changes were NOT needed):**
- No viewer JS changes were made. The $screen companion source remapping (identity.js/connect.js/participants.js) was planned but NOT implemented because the viewer already handles $screen via identity detection, independent of TrackSource.

### KEY RESEARCH SOURCES (This Session)

**WebRTC Internals:**
- VideoStreamEncoder encoder queue: single-frame buffer, drops if `posted_frames_waiting_for_encode > 1`
- BUT: NVENC reports 0 skipped = encoder queue is NOT the bottleneck (frames match capture count)
- ContentHint::Fluid → DegradationPreference::MAINTAIN_FRAMERATE (confirmed in video_stream_encoder.cc)
- FrameCadenceAdapter: Fluid → PassthroughAdapter (not ZeroHertzAdapter)

**LiveKit SFU Internals:**
- `congestion_control.enabled: false` does NOT disable BWE state machine, only `allocateAllTracks()`
- StreamAllocator's `committedChannelCapacity` still gets reduced before the `!enabled` check
- Initial capacity: 100Mbps. Degrades over time from TWCC/REMB feedback.
- Subscriber pacer: PassThrough (no rate limiting) — SFU is NOT pacing
- `AllocateOptimal()` called on initial track add — uses current `committedChannelCapacity`
- Undocumented config: `min_channel_capacity`, `use_send_side_bwe`, `use_send_side_bwe_interceptor`

**LiveKit RID/Layer Bug:**
- `VIDEO_RIDS = ['q', 'h', 'f']` — index 0 is 'q' (LOW)
- Non-simulcast: 1 encoding at index 0 → gets RID 'q' → SFU sees "LOW" quality
- Fix: single-layer uses 'f' (HIGH) → SFU allocates full bandwidth
- Upstream bug in livekit-rust-sdks (affects all non-simulcast tracks)

### PERFORMANCE NUMBERS (WGC + GPU Pipeline)

| Game | Capture FPS | Viewer FPS (self) | NVENC | Bitrate |
|------|------------|-------------------|-------|---------|
| Desktop (no game) | 90-100fps | 90-96fps | 0 skip | 7-8Mbps |
| BF6 4K (focused) | **53-54fps** | ~40fps | 0 skip | **20Mbps** |
| CD 4K (focused) | ~15fps | ~6fps | 0 skip | 5.9Mbps |
| CD 4K (unfocused) | 33fps | — | 0 skip | 5.7Mbps |

**Key insight:** Viewer FPS on the publisher's machine is WORSE than what remote viewers see. Publisher's GPU is doing game + capture + encode + decode. Remote viewers only decode — they should see the full capture FPS.

**GPU contention determines capture FPS:** BF6 leaves enough GPU headroom → 53fps. CD maxes out the GPU → 15fps. This is a Windows GPU scheduler limitation, not Echo Chamber.

### NEXT SESSION PRIORITIES

1. **Stream quality warning UI** — Monitor WGC callback FPS in real-time. When <30fps sustained, show dismissable banner: "Your game is impacting stream quality." Must be dismissable so it doesn't annoy users. Already have the data in the callback.
2. **Test with friends externally** — Confirm remote viewers see full capture FPS (not degraded like self-view).
3. **Screen share doesn't stop when game closes** — WGC captures window HWND, so this should auto-stop. Verify.
4. **Optimize WGC unfocused FPS** — Currently 33fps unfocused vs DXGI DD's 90fps. Investigate if channel backpressure or libyuv is the bottleneck.

### ACCEPTED LIMITATIONS

- **Extremely GPU-heavy games (CD 4K + DLSS FG) cap at ~15fps capture.** This is a Windows GPU scheduler issue — no software fix exists. Present() hooks don't work with DLSS Frame Generation (proxy swap chain sends garbled data). NVFBC blocked on consumer GeForce. Disabling MPO makes it worse. Every streaming tool (OBS Display Capture, Discord, Sunshine) hits the same wall.
- **Most games work fine.** BF6 4K = 53fps. The GPU contention only matters when the game maxes out the GPU.

### IMPORTANT NOTES

1. **SFU CC fix is DONE** — `congestion_control.enabled: true` in livekit.yaml. Stable.
2. **WGC is now the primary capture method** — JS fallback chain: NVFBC → WGC → DXGI DD → Present hook. Changed in `screen-share.js`.
3. **GpuConverter extracted to shared module** — `gpu_converter.rs` used by both `desktop_capture.rs` and `screen_capture.rs`.
4. **WGC requires MinUpdateInterval >= 1ms** — Windows bug caps at 50fps with default (0ms).
5. **WGC + GPU pipeline uses WGC's own D3D11 device** — No cross-device sharing. Extracted via `frame.as_raw_texture().GetDevice()`. COM pointer cast via `std::mem::transmute` (windows 0.61 → 0.58).
6. **NVENC fails at 4K** — Must downscale to 1080p before encoding. GPU shader handles this.
7. **3-second negotiation wait required** — After `publish_track`, wait before starting capture. Without it, NVENC never initializes.
8. **config.json** must exist next to the release exe: `{"server": "https://echo.fellowshipoftheboatrace.party:9443"}`
9. **Anti-MPO overlay code exists but doesn't help** — Left in desktop_capture.rs, harmless. MPO disable via registry made things WORSE (1fps + system freeze).
