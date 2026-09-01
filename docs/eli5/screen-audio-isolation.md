# Screen Audio Isolation

## ELI5

**What broke:** A Battlefield 6 or full-monitor share could include Echo's
speaker output, sending other people's voices back into the room. Separately,
a listener's screen-audio volume control could stay hidden when audio arrived
before video, and showing a hidden stream could overwrite a saved zero, mute,
or boosted level.

**Why it broke:** The exact reason Spencer's captured PCM contained Echo voices
cannot be proven without his native capture log. The audit did find two concrete
trust failures in that route: Rust built the Windows activation `PROPVARIANT`
inside an under-aligned byte array (undefined behavior), and the viewer
published a track labeled as excluded without native proof of the target PID or
that capture had actually started. On the listener, screen audio and video are
separate publications that can arrive in either order, while two Stage show
paths bypassed the authoritative saved-volume logic.

**What changed:** Browser and compatibility-fallback shares remain video-only.
Native window and ordinary game shares still use process-only audio. Full
monitor and exact Battlefield 6 shares can use system audio again, but only
after the latest Windows app uses an ABI-correct activation value, gets the
authoritative browser PID from CoreWebView2, validates the live
`msedgewebview2.exe` process in Echo's Windows session, and confirms Windows
audio capture started for that exclusion target. A missing or malformed
attestation stops native capture, cleans the partial viewer audio pipeline, and
publishes no audio. A Windows app that lacks the new command gets update
guidance, while real WebView2/WASAPI failures retain their native diagnostic
after the same cleanup. Native command generations and a shared gate fence
starts and stops across both ordinary operation and viewer reloads; the viewer
also gives each JavaScript pipeline its own generation and ordered IPC queue.
Listener controls derive from attached screen-audio state in either arrival
order, hide again when the last audio track leaves, and reapply saved volume and
mute state through one authoritative Stage path.

**How we know it works:** Regression tests prove browsers never publish display
audio, unexpected browser audio tracks are stopped, monitor and real
picker-shaped Battlefield 6 sources request only the Echo-excluding route, and
LiveKit publication happens only after all native attestation fields validate
exactly. Missing, malformed, inactive, and old-client results stop capture and
clean partial JavaScript resources. Deferred-attestation, replacement-start,
and rejected-publication tests prove stale operations publish nothing and clean
their Rust and JavaScript resources. Ordinary process-only game/window audio
remains available, and the video source object (including ultrawide geometry)
is unchanged. Receiver tests cover audio-before-video, 0%, per-screen mute,
room mute, and 180% boost across Stage hide/show. These tests prove the route
and fail-closed behavior; the two-device spoken sentinel is still required to
prove the captured PCM excludes Echo speech before release.

**Does this need a desktop update:** Yes. The server-served viewer enforces the
fail-closed gate, but system audio requires the Windows app version that returns
the isolation attestation. Older apps continue sharing video without system
audio and receive the update warning.

**What could still go wrong:** Windows can accept the requested exclusion and
start capture without proving the resulting PCM is clean. The release therefore
stays blocked until a two-device spoken sentinel proves the receiver hears
game/system audio but never their own Echo speech. If that test fails, monitor
and Battlefield 6 audio stay video-only; do not add DSP, virtual drivers, or a
new capture architecture inside this fix.
