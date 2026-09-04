# Responsive screen shares and streaming descriptions

ELI5:

What broke: An ultrawide share received the same column width as a normal
16:9 share, leaving it shorter with conspicuous empty space. Volume controls
appeared on any tile hover/focus, including simply selecting a stream. People
showed that someone was sharing but did not describe the selected game/window.

Why it broke: Mixed-aspect grid candidates fitted each video into equal cells.
The controls inherited tile-wide reveal rules, and tile geometry transitions
could temporarily leave controls attached to the previous box. Capture source
details were available locally and in admin diagnostics, but not in room
participants' public presentation.

What changed:

- Mixed shares use rows whose widths reflect their source aspect ratios. The
  layout scores row arrangements against the current Stage dimensions and
  rescales on window resize, drawer changes, visibility changes, and source-size
  changes. Each row has a common height and fixed gaps. Existing uniform-source,
  focused, solo, and fullscreen behavior keeps its own sizing rules.
- The volume strip is explicitly anchored to the bottom of every screen tile.
  It appears when hovering the bottom strip or focusing its controls, including
  tapping the strip on touch devices. Moving away hides it unless a volume
  control still has keyboard focus. Escape releases that focus. Clicking the
  image or its fullscreen control does not reveal the volume strip.
- People & Tools shows `Playing <selected game title>`, `Sharing <selected
  window title>`, or a generic desktop/browser/screen description below the
  name. The text supports avatar and camera cards, truncates long titles, and
  retains the complete bounded label as a tooltip. Hiding someone's share from
  your Stage does not hide what they are sharing. Ending publication clears it.

How we know it works: Unit coverage exercises mixed ratios across 150
window/count combinations, bounded source labels, native companion tracks,
start/stop/replacement, stale room/participant messages, retry failures, and
late-join synchronization. Browser coverage verifies resizing with unchanged
video/MediaStreamTrack objects, volume position and reveal rules in grid,
focus, fullscreen, and touch, plus title placement, truncation, and replacement.
The existing shell/fullscreen regression suites also pass. Verification uses
isolated synthetic media; it does not modify the live call.

Does this need a desktop update: No. This is a server-served viewer change.
Native capture resolution, FPS, bitrate budgets, encoder settings, and media
subscriptions remain unchanged. In particular, full native-resolution capture
is not enabled. CSS scales the received image while preserving its aspect.

What could still go wrong: Differently shaped screens cannot fill every
rectangular Stage without cropping or distortion, so some surrounding space
is expected. A selected monitor does not identify a particular game inside that
desktop; it says `Sharing desktop`. Browser captures use the reported surface
category, and older viewers without activity messages show `Sharing screen`.
Game/window names come from the capture selection, not ongoing OCR or desktop
surveillance, and do not change with every subsequent window-title update.

The room-local data contract is `stream-activity` version 1 with `trackSid` and
`source: { source_type, source_title }`, or null to clear that track's description.
Only `game`, `window`, `monitor`, and `browser` types are accepted; titles are
plain text capped at 160 characters with control/bidi formatting characters
removed. Handles, PIDs, monitor identifiers, and capture routes are not sent.
Receivers bind messages to the authenticated sending participant object and
match the current screen publication SID before rendering. Native `$screen`
tracks use the parent participant's description. Data arriving before its
publication is held in a bounded map; unrelated or replaced publications cannot
inherit the label. The source is never persisted to local storage. New joiners
receive a targeted reliable update; connection/reconnection also sends a
`stream-activity-query` version 1 to request the current descriptions.
