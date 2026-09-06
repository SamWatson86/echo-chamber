# Screen recovery and maximized-window clipping

What broke: A received share could look normal in a smaller Echo window and lose
the bottom of its picture when maximized on an ultrawide. The failure also
affected other viewer/source size combinations after a video was replaced.

Why it broke: Initial subscriptions configured the screen video class, explicit
width/height, contain guard, and source-dimension listeners in `addScreenTile`.
`replaceScreenVideoElement`, used by recovery and changed-track subscriptions,
created a fresh video without that setup. Its unconstrained box grew with the
Stage width, and the Stage clipped the excess height. `object-fit: contain` still
reported correctly, but it fitted the picture inside the oversized video box.

At a 3440x1370 viewer viewport, the reproduction's Stage was 3064x1192, while the
recovered 1920x1080 video occupied 3062x1722.375. The bottom extended roughly
531 pixels beyond the Stage. The local Windows Echo app exhibited the same
maximized clipping; Brad's receiver statistics still showed full 1920x1080
frames at about 30 FPS. This was a presentation failure, not missing source
pixels. Prior layout coverage did not exercise this replacement path.

What changed: Both initial subscriptions and replacement videos now use
`prepareScreenVideo`. Each receives the same bounded sizing, contain guard, and
metadata/resize listeners. Cleanup removes the old listeners, and their handler
also rejects stale elements so delayed events cannot overwrite the new source's
aspect ratio. The existing tile, controls, and underlying media track are
retained through recovery.

How we know it works: The new 16:9 regression failed on the previous code with
the exact oversized bounds above and passes with the fix. Browser tests use
real decoded canvas media rather than just overridden dimensions. They cover
six source ratios, desktop sizes through 5120x1440 and 3840x2160, small and
portrait viewports, maximize/restore sequences, uniform and mixed grids, focus,
fullscreen, repeated recovery, changed source dimensions, and stale metadata
events. Existing volume and stream-description tests also pass. The tests do
not reconnect or alter a live call.

Does this need a desktop update: No. This is a server-served viewer correction.
Capture resolution, FPS, bitrate, encoders, and subscription policy are unchanged;
full native-resolution transmission is not enabled.

What could still go wrong: Differently shaped pictures need letterboxing to
remain fully visible without distortion. The fix constrains the full received
image; it cannot restore content absent from the stream itself. Production
rollout and validation against the live call remain separate from the isolated
browser verification.
