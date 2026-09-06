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

Manual resizing exposed a second failure at 3283x737: after dragging through a
shorter window, responsive hysteresis retained lounge mode. People & Tools then
overlaid the right-hand stream even though its video and tile bounds were valid.
The previous containment check did not detect another panel covering the picture.
Visible screen shares now reserve space for open panels using the same responsive
workspace arrangement as Stage modules. Lounge puts panels beside the Stage;
compact/mini stack them, or place them beside it in short landscape windows.
Hiding Users returns that space to the Stage without replacing media elements.

Each viewer can also arrange their own Stage. Drag a tile's six-dot handle onto
another tile to swap places, or focus the handle and use the arrow keys. Clicking
the picture still focuses that stream; clicking again restores the grid. Move
handles are hidden during focus/fullscreen, for a single stream, and where a tile
is too small to fit them alongside the fullscreen button.

The order is local to the current room view: resizing, hiding/restoring a share,
and recovery keep it; new shares append, and leaving/reloading starts fresh. The
renderer changes CSS order and computed positions, never reparents live videos
or changes subscriptions. Mixed-source row scoring balances actual row heights
so putting a portrait last cannot favor two tiny strips above one tall picture.

How we know it works: The new 16:9 regression failed on the previous code with
the exact oversized bounds above and passes with the fix. Browser tests use
real decoded canvas media rather than just overridden dimensions. They cover
six source ratios, desktop sizes through 5120x1440 and 3840x2160, small and
portrait viewports, maximize/restore sequences, uniform and mixed grids, focus,
fullscreen, repeated recovery, changed source dimensions, and stale metadata
events. Existing volume and stream-description tests also pass. The tests do
not reconnect or alter a live call.

Coverage also checks the Stage against the viewport and every stream against
the open utility panel. A regression reproduces Sam's precise 650px-to-737px
height transition, which differs from opening a fresh window directly at 737px,
and exercises panel hide/show through lounge, theater, compact, and mini sizes.
Drag/keyboard coverage checks media continuity, cancellation (Escape, outside
drop, resize, removal), arrivals, hidden shares, recovery, and isolation between
two viewers.

Clicking Zane's 1920x1080 share to enlarge it reproduced the recovery failure
in the still-unpatched live viewer, alongside a second 1920x1080 share and a
1920x804 ultrawide. Replaying those source proportions at 3440x1370 made the
old recovery code produce a 1699px-tall video inside a 994px-tall focused tile.
The shared initializer limits that same video to the tile's 992px content
height and retains the entire picture. Before/after checks also cover 3283x737
and 2376x1176. A dedicated regression clicks the landscape video through the
production focus handler and resizes it across the supported test viewports.

Does this need a desktop update: No. This is a server-served viewer correction.
Capture resolution, FPS, bitrate, encoders, and subscription policy are unchanged;
full native-resolution transmission is not enabled.

What could still go wrong: Differently shaped pictures need letterboxing to
remain fully visible without distortion. The fix constrains the full received
image; it cannot restore content absent from the stream itself. Production
rollout and validation against the live call remain separate from the isolated
browser verification.
