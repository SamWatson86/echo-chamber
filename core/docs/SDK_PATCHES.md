# SDK Patch Documentation

Echo Chamber vendors two upstream SDKs and applies local patches to both. This document
describes every modification, why it was made, and what breaks without it.

---

## Vendored SDKs

| SDK | Local Path | Upstream |
|-----|-----------|----------|
| livekit-rust-sdks | `core/livekit-local/` | github.com/livekit/rust-sdks |
| webrtc-sys | `core/webrtc-sys-local/` | github.com/livekit/client-sdk-rust / webrtc-rs |

---

## livekit-local

### Patch 1 — RID Quality Label Fix

**File:** `core/livekit-local/src/room/options.rs` lines 252–255

**Function:** `compute_video_encodings()` (builds `Vec<RtpEncodingParameters>` for a track)

**What changed:**

```rust
// Before (upstream):
let rid = VIDEO_RIDS[i].to_string();

// After:
// For single-layer (non-simulcast), use 'f' (HIGH quality) so the SFU
// allocates full bandwidth. VIDEO_RIDS[0]='q' (LOW) is only correct
// when it's the lowest of multiple simulcast layers.
let rid = if presets.len() == 1 { "f".to_string() } else { VIDEO_RIDS[i].to_string() };
```

**Why:** `VIDEO_RIDS` is `["q", "h", "f"]` — LOW, MEDIUM, HIGH. For simulcast this is
correct: index 0 is the lowest quality layer. For non-simulcast (single preset), index 0
is the *only* layer, but it still gets the `"q"` (LOW) RID. The SFU reads the RID to
determine bandwidth allocation priority and will only allocate ~700 kbps to a LOW-tagged
track, regardless of actual bitrate negotiated.

**Impact:**
- Before: SFU allocates ~700 kbps to the screen share track. Desktop viewer runs at ~5 fps.
- After: SFU allocates full 20 Mbps. Desktop viewer runs at 100+ fps.

**Upstream status:** Bug present in all versions of livekit-rust-sdks as of 2026-04.
Affects every app using non-simulcast video with this SDK.

---

## webrtc-sys-local

### Patch 2 — `is_screencast()` Method

**Files:**
- `core/webrtc-sys-local/include/livekit/video_track.h` lines 91–108, 113–114
- `core/webrtc-sys-local/src/video_track.cpp` lines 107–115, 173–183

**What changed:**

`VideoTrackSource::InternalSource` stores a `bool is_screencast_` member (set in the
constructor) and overrides `AdaptedVideoTrackSource::is_screencast() const`. The outer
`VideoTrackSource` class exposes a matching `is_screencast() const` method that delegates
to the inner source.

```cpp
// Header — InternalSource:
bool is_screencast() const override;
// ...
bool is_screencast_;

// Header — VideoTrackSource public interface:
bool is_screencast() const;

// Implementation:
bool VideoTrackSource::InternalSource::is_screencast() const {
  return is_screencast_;
}
bool VideoTrackSource::is_screencast() const {
  return source_->is_screencast();
}
```

**Why:** WebRTC's degradation preference differs between screenshare and camera/game
content. The `is_screencast()` flag is the mechanism WebRTC uses to apply different
ContentHint defaults. Without this method, the factory (Patch 3) cannot distinguish
content types.

**Dependency:** Required by Patch 3.

---

### Patch 3 — ContentHint=Fluid (MAINTAIN_FRAMERATE)

**File:** `core/webrtc-sys-local/src/peer_connection_factory.cpp` lines 119–126

**Function:** `PeerConnectionFactory::create_video_track()`

**What changed:**

```cpp
// After track creation, set degradation preference for non-screencast sources:
if (!source->is_screencast()) {
    track->set_content_hint(ContentHint::Fluid);
    std::cerr << "[webrtc] set ContentHint=Fluid (MAINTAIN_FRAMERATE) for non-screencast track" << std::endl;
}
```

**Why:** WebRTC's default `DegradationPreference` for video is `BALANCED`, which reduces
*both* resolution and frame rate under bandwidth pressure. For game capture content,
dropping FPS is far more damaging than dropping resolution. `ContentHint::Fluid` maps to
`DegradationPreference::MAINTAIN_FRAMERATE` — WebRTC will reduce resolution before FPS.

Without this patch, WebRTC's bandwidth estimator calls `SetRates` with `fps=10` under
load. The encoder accepts the low rate target and the capture pipeline throttles down
to match, resulting in ~12 fps sustained even when the network has headroom.

**Impact:**
- Before: SetRates fp=10 under any congestion → capture degrades to 12 fps.
- After: fps held at 101 (capture rate), 100 fps sustained in viewer.

**Dependency:** Requires Patch 2 (`is_screencast()`) to identify non-screencast sources.

---

### Patch 4 — AdaptFrame Bypass

**File:** `core/webrtc-sys-local/src/video_track.cpp` lines 150–168

**Function:** `VideoTrackSource::InternalSource::on_captured_frame()`

**What changed:**

```cpp
// Before (upstream):
// Called AdaptFrame() which runs WebRTC's software adaptation heuristics:
// if (!AdaptFrame(buffer->width(), buffer->height(), ...)) return false;
// OnFrame(adapted_frame);

// After:
// Bypass AdaptFrame() — the hardware encoder (NVENC) handles rate control.
// AdaptFrame() drops frames based on WebRTC's adaptation layer which uses
// incorrect heuristics for hardware encoders (e.g., dropping to 8fps when
// NVENC can handle full capture rate). We send every frame to the encoder
// and let NVENC's CBR rate control manage quality within the BWE budget.
//
// Resolution adaptation is also unnecessary — the GPU compute shader
// already downscales 4K→1080p before encoding.
OnFrame(webrtc::VideoFrame::Builder()
            .set_video_frame_buffer(buffer)
            .set_rotation(rotation)
            .set_timestamp_us(aligned_timestamp_us)
            .build());
```

**Why:** `AdaptFrame()` is designed for software encoders that can't control their own
bitrate. It uses heuristics (frame interval, resolution step) to limit the frame rate
presented to the encoder. With NVENC in CBR mode (Patch 5), frame-level rate control
is done inside the GPU encoder — `AdaptFrame()` only causes unnecessary drops.
Additionally, the GPU compute shader in `gpu_converter.rs` already performs 4K→1080p
downscaling before frames reach this path, so resolution adaptation is redundant.

**Impact:** Without this patch, `AdaptFrame()` drops to ~8 fps when NVENC is encoding
at full rate. With bypass, all captured frames reach NVENC.

---

### Patch 5 — CBR Rate Control

**File:** `core/webrtc-sys-local/src/nvidia/h264_encoder_impl.cpp` line 247

**Function:** `NvidiaH264EncoderImpl::InitEncode()`

**What changed:**

```cpp
// Before: VBR or preset default (typically NV_ENC_PARAMS_RC_VBR)
// After:
nv_encode_config_.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
```

**Why:** Variable bitrate mode allows NVENC to burst far above the average bitrate for
complex frames (e.g., fast motion in 4K). These bursts overwhelm the WebRTC pacer and
cause the bandwidth estimator to declare congestion, which feeds back into SetRates
(Patch 7's concern). CBR keeps every frame at a predictable size relative to the target
bitrate, making the pacer's job trivial and preventing spurious congestion signals.

**Impact:** Eliminates frame-to-frame bitrate spikes that previously caused pacer
congestion and cascading quality drops.

---

### Patch 6 — Trusted Rate Controller

**File:** `core/webrtc-sys-local/src/nvidia/h264_encoder_impl.cpp` lines 465–468

**Function:** `NvidiaH264EncoderImpl::GetEncoderInfo()`

**What changed:**

```cpp
// Tell WebRTC that NVENC handles rate control itself — bypass frame dropper
info.has_trusted_rate_controller = true;
info.is_qp_trusted = true;
```

**Why:** When `has_trusted_rate_controller = false` (the default), WebRTC's
`VideoStreamEncoder` runs an additional frame dropper on top of the encoder's own rate
control — dropping frames before they even reach `Encode()`. Since NVENC in CBR mode
is already managing bitrate accurately, this external frame dropper only reduces quality.
`is_qp_trusted = true` tells WebRTC to trust the QP values NVENC reports rather than
re-estimating them, which improves the accuracy of quality metrics.

**Impact:** Removes WebRTC's redundant frame dropper. All frames captured by the GPU
pipeline reach NVENC; NVENC handles any necessary quality trade-offs internally.

---

### Patch 7 — Force 60fps to NVENC

**File:** `core/webrtc-sys-local/src/nvidia/h264_encoder_impl.cpp` lines 499–533

**Function:** `NvidiaH264EncoderImpl::SetRates()`

**What changed:**

```cpp
// Before: accepted parameters.framerate_fps directly, which WebRTC BWE can set to 9.
// After: ignore the BWE fps target, always configure NVENC for 60fps:

// Don't let WebRTC's BWE reduce our codec max framerate — NVENC handles
// rate control via CBR. Accepting a low fps target (e.g., 9fps) creates
// huge per-frame bursts that trigger pacer congestion and more fps drops.
// Keep NVENC configured for high fps so it produces small, smooth frames.
codec_.maxBitrate = parameters.bitrate.GetSpatialLayerSum(0);
float nvenc_fps = 60.0f;

// ... reconfigure NVENC with nvenc_fps (60) regardless of parameters.framerate_fps
nv_initialize_params_.frameRateNum = static_cast<uint32_t>(nvenc_fps);
```

**Why:** WebRTC's bandwidth estimator can call `SetRates` with a very low fps target
(e.g., 9 fps) during congestion. If NVENC accepts this, it reconfigures its internal
VBV buffer assuming 9 fps — each frame can be up to `bitrate / 9` bytes. A 20 Mbps
stream at 9 fps produces ~277 KB per frame. The WebRTC pacer, sized for 60 fps
(~42 KB per frame), cannot absorb these bursts, which triggers congestion detection,
which sets fps even lower, creating a death spiral. Forcing 60 fps to NVENC keeps
per-frame sizes predictable at ~42 KB regardless of what BWE estimates.

**Impact:**
- Before: BWE sets fps=9 → NVENC produces 277 KB frames → pacer congestion → fps
  stays at 9 → viewer sees ~9 fps.
- After: NVENC always produces ~42 KB frames → pacer flows freely → viewer sees
  capture rate (45–55 fps for 4K games, 100+ fps desktop).

---

### Patch 8 — Multi-Profile H264 + HEVC

**File:** `core/webrtc-sys-local/src/nvidia/nvidia_encoder_factory.cpp` lines 12–48

**Function:** `NvidiaVideoEncoderFactory` constructor (`GetSupportedFormats()`)

**What changed:**

```cpp
// Before (upstream): single format registered, typically Constrained Baseline only.
// After: four H264 profiles + HEVC/H265:

// Constrained Baseline (42e0) — broadest compatibility
{ "profile-level-id": "42e01f", ... }

// High profile (6400) level 5.1 — matches SDP munging for 4K@60fps
{ "profile-level-id": "640033", ... }

// Constrained High (640c) — some decoders negotiate this variant
{ "profile-level-id": "640c33", ... }

// Main profile (4d00) level 5.1 — intermediate compatibility
{ "profile-level-id": "4d0033", ... }

SdpVideoFormat("H265")
SdpVideoFormat("HEVC")
```

**Why:** SDP negotiation picks the *best matching* format from the encoder's advertised
list. If the remote decoder advertises High profile (level 5.1, required for 4K@60fps)
and the encoder only offers Constrained Baseline, negotiation falls back to Baseline.
Baseline is capped at level 3.1 (720p@30fps equivalent) and cannot carry 4K streams.
By advertising all profiles, NVENC negotiates High or Constrained High when the remote
supports it, enabling full 4K@60fps throughput. HEVC entries are registered for future
use (the H265 encoder impl exists but is not currently activated in the capture pipeline).

**Impact:** Without High profile registration, SDP negotiation caps at Constrained
Baseline → 4K frames are negotiated but decoded incorrectly or refused by the SFU.
With all profiles registered, 4K@60fps SDP succeeds for all decoder variants in use
(Tauri client, browser viewer, SAM-PC).

---

## Patch Interaction Map

The patches form a cooperative system. Removing any one degrades the whole pipeline:

```
Patch 1 (RID 'f')
  └── Ensures SFU gives the track full bandwidth budget

Patch 2 (is_screencast)
  └── Required by Patch 3 to classify content type

Patch 3 (ContentHint=Fluid)
  └── Prevents WebRTC from reducing FPS under bandwidth pressure
  └── Works with Patch 7 to keep fps high end-to-end

Patch 4 (AdaptFrame bypass)
  └── Ensures all captured frames reach NVENC
  └── Effective only because Patch 5 (CBR) makes NVENC safe to feed at full rate

Patch 5 (CBR)
  └── Produces predictable per-frame sizes
  └── Required for Patch 7 (fixed fps VBV sizing) to be effective

Patch 6 (trusted rate controller)
  └── Removes WebRTC's external frame dropper
  └── Lets Patches 4+5 deliver all frames without interference

Patch 7 (force 60fps)
  └── Prevents pacer congestion from large VBV-sized bursts
  └── Closes the feedback loop that would otherwise cascade into 9fps

Patch 8 (multi-profile)
  └── Independent — ensures correct SDP negotiation at session setup
  └── Required for 4K streams to be accepted by all decoder variants
```

---

## Keeping Patches in Sync

When pulling upstream changes into either fork:

1. `livekit-local`: check `src/room/options.rs` — the `compute_video_encodings` function
   may be renamed or restructured. Re-apply the single-layer RID guard at the same logic
   point (where `rid` is assigned from `VIDEO_RIDS`).

2. `webrtc-sys-local`: the NVIDIA encoder files (`h264_encoder_impl.cpp`,
   `nvidia_encoder_factory.cpp`) are custom additions with no upstream counterpart —
   they are unlikely to conflict. The `video_track.cpp` AdaptFrame bypass and
   `peer_connection_factory.cpp` ContentHint block may need rebasing if upstream refactors
   the frame delivery or track creation paths.
