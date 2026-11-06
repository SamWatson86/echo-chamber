# Native black-share recovery

ELI5:

- **What broke:** Sam's native Windows share was black locally and remotely on
  November 5, 2026. WGC supplied about 30 fps, but the sender encoded and sent
  zero video frames. ICE/DTLS were connected and the server preflight passed.
- **Why it broke:** The original encoder startup error was not retained. A
  local client relaunch restored encoding. Failed attempts used High profile;
  a successful fresh attempt used Baseline. Both profiles subsequently passed
  an isolated hardware test, so the profile difference is not a proven cause.
  Inspection found separate concrete CUDA lifecycle defects: initialization
  replaced healthy contexts, later encoder creations trusted a cached context,
  and CUDA failures could be converted into boolean success.
- **What changed:** CUDA initialization now reuses valid contexts, detects and
  replaces stale ones, and returns false on errors. Each new encoder validates
  its context. Invalid context access returns null instead of terminating the
  app. Native startup failures are timestamped in `encoder-factory-debug.log`.
  Capture health reports an encoder that never starts after its startup grace.
- **How we know it works:** A private-context test fails against the prior
  implementation and passes after the fix, including deliberately destroying
  that test's own context and recovering. Synthetic local peer tests exercise
  both H.264 profiles with encoded and decoded frame assertions. Capture-health
  tests cover the observed zero-output pattern, normal startup, missing
  telemetry, and an idle working encoder.
- **Does this need a desktop update:** Yes. This changes the native Windows
  binary; a server/viewer deploy cannot update installed capture code.
- **What could still go wrong:** The initial driver/encoder failure remains
  unconfirmed. These changes repair a demonstrated recovery defect and improve
  evidence for recurrence; they do not establish that every NVENC startup
  failure has the same cause. An unavailable driver or failed NVENC session can
  still prevent sharing and must produce actionable diagnostics.

## Verification commands

November 5 validation: 146 regular client tests passed (three hardware/manual
tests ignored by default); the explicitly run synthetic H.264 test passed for
both profiles with nonzero encoded and decoded frames. The private-context
regression failed against the prior source and passed against the patched
source. A local `0.6.39-local.encoder.1` build was installed for live validation;
this is not a published desktop release.

Run Cargo from `core/` so its Windows static CRT configuration is loaded:

```powershell
cargo test --locked --release -p echo-core-client
cargo test --locked --release -p echo-core-client `
  capture_pipeline::tests::native_h264_profiles_encode_synthetic_frames -- `
  --ignored --exact --nocapture
```

On an NVIDIA Windows PC with Visual Studio C++ tools and the CUDA Toolkit, use
the Windows release libwebrtc directory reported by the `webrtc-sys` build:

```powershell
.\core\webrtc-sys-local\test\test-cuda-context-recovery.ps1 `
  -WebRtcDirectory '<directory containing include/ and lib/webrtc.lib>'
```

The context test uses only its own CUDA context. The media test uses synthetic
frames and two local peers. Neither captures the desktop, joins a production
room, resets the GPU, nor restarts any shared service.
