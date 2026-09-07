# Voice volume after rejoining

## ELI5

**What broke:** A person's Voice slider and mute button could appear ineffective
after they left and rejoined. A previous audio connection kept playing alongside
the connection controlled by their current card.

**Why it broke:** LiveKit removes a disconnected participant from its registry
before emitting track-unsubscribe events. Echo's generation guard correctly
rejects events that no longer belong to a current participant, but the fallback
participant-disconnect cleanup only retired screen audio. Microphone elements
and their boost graphs survived the later deletion of the person's card/state.
Same-identity rejoin cleanup also covered only screen audio.

The September 7 live debug log showed the skipped unsubscribe events, completed
card cleanup for Jeff and another participant, and three audio elements when
Jeff rejoined a room whose only remote publication was Jeff's microphone. Old
microphone unmute callbacks also fired during the new subscription. Jeff's new
Voice control was at 137%; the old gain graphs had lost their controls.

**What changed:** Authoritative participant disconnect now immediately detaches
that exact participant's audio elements, clears their streams, and disconnects
their boost graphs. The existing card grace period remains. Rejoin also retires
old microphone and screen-audio attachments while preserving replacement tracks,
including when a track SID or HTML element is reused. Old-room and late
old-participant callbacks cannot remove current playback.

**How we know it works:** Deterministic tests execute the production room-event
callbacks. Before the fix they retain one microphone after disconnect and two
after rejoin; after the fix they remove the old graph and retain only current
audio. An isolated Chromium test uses the bundled LiveKit RemoteAudioTrack,
real MediaStreams, production controls and GainNodes, and a silent synthetic
tone. Measured output is silent after disconnect, then follows 0%, 25%, 100%,
300%, mute and unmute after rejoin. The SDK may recycle detached HTML elements;
the test checks track ownership and actual output rather than object novelty.

**Does this need a desktop update:** No installer or native code change. This is
a server-served viewer update with its own Updates entry.

**What could still go wrong:** Existing open viewers need to load the fix; a
viewer refresh clears graphs already orphaned by the old code. The browser test
simulates signaling events and measures synthetic audio, so it does not replace
a listening check in Sam and Jeff's call. Production service changes must follow
the Operations runbook and the authorized restart window.
