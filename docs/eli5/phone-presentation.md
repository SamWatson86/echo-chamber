# Phone Presentation and Fullscreen Recovery

## ELI5

**What broke:** On a phone, People & Tools occupied a fixed portion of the
screen with no way to resize it. Entering and leaving fullscreen could also
race Android's changing browser viewport and leave an otherwise-live video
visually frozen.

**Why it broke:** The responsive desktop utility rail was only given a fixed
phone-height override. Fullscreen restored layout after a fixed two-frame delay
without waiting for the mobile browser chrome and visual viewport to settle.

**What changed:** Exact non-native phone browsers get a presentation-only
bottom sheet with peek, half, and full positions. It reuses the existing People,
module, participant, and media nodes. Phone fullscreen exit waits briefly for a
stable viewport, measures once, and—only if the exact same live generation has
not advanced—requests one play/keyframe recovery.

**How we know it works:** Tests cover phone-versus-desktop classification,
supported phone sizes, drag and button snaps, show/hide state preservation,
zero-size first connect, ten fullscreen cycles, stale-generation rejection,
and the absence of attach, subscription, reconnect, or unscoped desktop CSS.

**Does this need a desktop update:** No. It is a server-served viewer change.

**What could still go wrong:** A real phone/browser may have a presentation
failure outside the bounded play/keyframe recovery. If the phone canary still
freezes, capture the exact transition and frame counters and stop; do not add a
generic reconnect or subscription-recovery ladder.
