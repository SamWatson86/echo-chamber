# Screen Share Stop and Performance Investigation

## ELI5

**What broke:** After David selected End Sharing, a newly connected observer
could still receive his live screen. This is a privacy failure, not merely an
old viewer retaining its last frame. Separately, the stream's bottom-right
overlay showed about 6 FPS while he shared The Hunter: Call of the Wild in
borderless mode.

**Why it broke:** Native capture workers shared a single global stop handle.
When an earlier worker finished, it could clear the newer worker's handle,
leaving that newer capture running without a reachable stop handle. Stop also
returned before the native publisher finished closing its SFU room. The
viewer chose which native route to stop using JavaScript flags, which could
be stale after a reload or an overlapping start. Pending asynchronous start
work could also resume after End Sharing. These are confirmed code defects;
David's exact sequence has not been reproduced on his PC.

**What changed:** Native sessions retain ownership of their own stop signal
and completion, including replaced workers. Stop waits for native capture and
publisher cleanup, and reports failures instead of claiming success. WGC
shutdown explicitly stops capture even when a static source produces no new
frames. The viewer stops both native routes, cancels pending startup and
recovery, and stops browser capture tracks before waiting for publication
cleanup. Screen receiver cleanup removes a departing screen companion
immediately while protecting a replacement connection with the same identity.

**How we know it works:** All 509 viewer unit tests pass, including overlapping
starts, delayed shutdown, stale viewer state, canceled startup, browser
publication cleanup failures, and receiver connection replacement. Three
Chromium integration tests pass against the actual viewer with simulated
Windows IPC, including successful End Sharing and a failed stop followed by
retry. Seven native session lifecycle tests pass, and the Windows desktop
compile check includes test targets and two WGC error-classification tests
(compiled, not executed). The PR records the exact commands. The fresh-observer
procedure below is still required to confirm end-to-end Windows/SFU behavior;
no production service or remote client was changed for this investigation.

**Does this need a desktop update:** Yes. Release impact is **both**: a
server-served viewer update and a new Windows desktop binary. Updating viewer
assets alone cannot repair the native worker ownership race in an installed
older desktop app.

**What could still go wrong:** Native capture, driver operations, or SFU
shutdown can fail or stall. The UI must retain a visible failure and allow
retry when stop cannot be confirmed. The 6 FPS performance cause remains
unproven; this privacy fix does not claim to resolve it.

## What the 6 FPS reading means

The bottom-right value measures frames presented by the receiving video
element (`participants-fullscreen.js`, `createVideoFrameRateTracker` and
`attachVideoDiagnostics`). It does not measure David's game FPS. A capture,
encoder, network, decoder, or receiver presentation bottleneck can each reduce
that value.

The current native game profile targets 30 FPS. The software-encoder input
limit is 20 FPS. There is no intentional 6 FPS cap. WGC currently performs
GPU scaling, synchronous staging readback, and an owned BGRA buffer copy
before the publisher discards excess frames. That is a concrete optimization
candidate under GPU load, but it is not evidence that David's PC caused this
incident. Performance tuning is separate from this privacy fix.

Collect contemporaneous samples during active game motion:

| Evidence | What it separates |
| --- | --- |
| David's app version, Windows build, selected capture route, game/window/monitor source, actual sender encoder | The capture and encoding path actually in use |
| Native `[wgc-callback] interval_fps`, `[wgc-publish] pushed_fps`, and heartbeat counters | Fresh captured frames versus publisher pacing or repeated static frames |
| Native `sender-stats`: FPS, frames encoded/sent, encoder, quality limitation, target bitrate; candidate-pair available outgoing bitrate | Capture submission versus encoding and sender transport |
| Each observer's inbound FPS, frame drops, packet loss, jitter, NACKs, and presented FPS | Delivery/decode versus local rendering; whether all receivers suffer |

The admin capture FPS currently mixes interval samples with a lifetime average,
so prefer native interval logs when comparing stages. The health classifier
also only applies its WGC low-FPS threshold to targets of at least 60 FPS;
the present 30 FPS game profile can therefore remain green at low capture
FPS. These diagnostic gaps are follow-up work, not proof of the performance
root cause. Trust the actual sender encoder report over the startup-derived
NVENC label.

A focused performance follow-up should first correct those measurements, then
measure GPU/readback time and test pacing before expensive WGC conversion.
Keep the current output quality and cadence until measurements support a
change. Do not switch to a different capture architecture based on this report.

## Fresh-observer privacy verification

Run the operations preflight before authorized live verification. Record the
server/viewer revision and publisher desktop version. Use test content only.

1. Share a moving counter or animation with a unique visible marker and, when
   available, a distinct audio signal. Connect observer A and verify advancing
   content. Keep observer B disconnected with no earlier screen subscription.
2. Select End Sharing. Record the stop outcome and confirm the publisher no
   longer exposes an active capture or screen publication. Confirm A's screen
   tile disappears and shared audio ends.
3. Change the source to a new marker **after** stopping and keep the counter
   advancing. Only then sign in/connect B from a fresh viewer session.
4. B must receive no screen track, tile, frame, or shared audio. Seeing the
   post-stop marker or advancing counter proves live capture leaked. Seeing
   only a pre-stop still frame is a separate stale-display failure; record it
   separately and still fail the check. A disappearing local tile alone is
   insufficient proof that capture stopped.
5. Leave both observers connected long enough to cover reconnect/heartbeat
   activity, then reconnect B again. Sharing must remain ended until the
   publisher explicitly starts a new share.
6. Repeat with rapid start/stop/start/stop, End Sharing while startup is
   pending, a static window, viewer reload during capture, and the supported
   game/window/monitor routes. Validate an intentional replacement share
   survives delayed events from the previous connection.
7. Exercise stop failure in an isolated test harness: the UI must not report
   sharing ended when native shutdown rejects, and retry must remain possible.
   Browser capture tracks must stop even if unpublish fails.

Record moving-frame and frozen-frame observations separately, with timestamps
and relevant publisher/observer diagnostics. Do not mark this verified solely
from unit tests or a publisher-side UI state change.
