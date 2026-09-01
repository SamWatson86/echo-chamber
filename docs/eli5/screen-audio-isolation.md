# Screen Audio Isolation

## ELI5

**What broke:** A Battlefield 6 or full-monitor share could include Echo's
speaker output, sending other people's voices back into the room. Separately,
a listener's screen-audio volume control could stay hidden when audio arrived
before video, and showing a hidden stream could overwrite a saved zero, mute,
or boosted level.

**Why it broke:** The Windows system-audio route requested process-tree
exclusion, but the viewer published a track labeled as excluded before native
capture reported that it had started. More importantly, that route name could
not prove Windows had attributed Echo's WebView2 audio processes to the
excluded tree. The exact Windows process-attribution failure is not proven
without a capture trace from the publishing PC. On the listener, screen audio
and video are separate publications that can arrive in either order, while two
Stage show paths bypassed the authoritative saved-volume logic.

**What changed:** Browser and compatibility-fallback shares remain video-only.
Native window and ordinary game shares can still use process-only audio. Full
monitor audio and Battlefield 6's system-audio route now fail closed to
video-only, with a clear warning, because Echo voice isolation is not yet
attested. Starting one of those blocked shares, or stopping a share, also tells
Rust to stop a prior native capture even when viewer state was reset by a
reload. Listener controls now derive from attached screen-audio state in either
arrival order, hide again when the last audio track leaves, and reapply saved
volume and mute state through one authoritative Stage path.

**How we know it works:** Regression tests prove browsers never publish display
audio, unexpected browser audio tracks are stopped, monitor and real
picker-shaped Battlefield 6 sources never invoke or publish system audio,
ordinary process-only game/window audio remains available, and the video source
object (including ultrawide geometry) is unchanged. Receiver tests cover
audio-before-video, 0%, per-screen mute, room mute, and 180% boost across
Stage hide/show.

**Does this need a desktop update:** The fail-closed containment is delivered by
the server-served viewer. A future, evidence-backed native exclusion repair
would require a Windows desktop update.

**What could still go wrong:** Process-only capture can fail on a specific game,
and its pre-existing asynchronous start/stop path still needs generation
ownership before rapid stop/restart is guaranteed race-free. That path cannot
re-enable the blocked system-audio route. Restoring system-wide audio requires a
two-PC spoken sentinel plus proof of the actual WebView2 playback process
ownership. Do not change WASAPI, add DSP, or add another capture architecture
without that evidence.
