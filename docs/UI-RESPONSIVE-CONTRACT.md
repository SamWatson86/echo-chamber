# Echo Chamber Responsive UI Contract

Status: Clubhouse shell, independent Active Users rail, and Stage modules are
implemented and verified behind the shell flag

Applies to: `core/viewer/` in the browser and Windows desktop shell

This document defines the responsive behavior that future UI work must preserve.
It is intentionally stricter than a visual mockup: it describes layout ownership,
state preservation, accessibility, and the geometry guarantees that make the UI
safe to change while a room is live.

The words **must**, **should**, and **may** are normative. A later PR may revise
this contract deliberately, but implementation work must not silently diverge
from it.

## Principles

1. **State truth outranks visual convenience.** Responsive changes must never
   imply that a microphone, camera, share, Jam, or room connection changed when
   only its presentation changed.
2. **One connected shell, one stable DOM.** The same region and media nodes adapt
   across geometry. Do not build separate desktop and constrained DOM trees.
3. **CSS owns geometry.** JavaScript may select a named layout mode and manage
   interaction state; CSS performs sizing, positioning, wrapping, truncation,
   and container adaptation.
4. **Primary controls do not move.** Mic, camera, share, output, and leave remain
   in the control dock in the same order after connection.
5. **Stage modules and Active Users are independent.** Chat, Jam, Camera Lobby,
   Soundboard, and future workspace modules share the primary Stage one at a
   time. Active Users remains visible by default and changes only through its
   explicit Show/Hide control.
6. **Progressive disclosure beats removal.** Space-constrained layouts collapse
   labels and secondary controls, but do not make essential actions or state
   inaccessible.
7. **A resize is not a lifecycle event.** It must not reconnect a room, republish
   media, recreate a participant card, or reset user input.
8. **The prejoin page may scroll; the connected workspace must compose.** Short
   windows must not clip setup controls, and connected regions must have explicit
   internal scroll owners.

## Canonical Regions

The connected viewer has these canonical regions:

| Region | Purpose | Lifetime |
| --- | --- | --- |
| Shell header | Brand, room switcher, connection state, account/overflow actions | Mounted for the connected session |
| Primary stage | Shared screens or exactly one Stage module such as Chat, Jam, Camera Lobby, or Soundboard | Mounted for the connected session; media nodes remain mounted while a module is open |
| Active Users | Participant presence, controls, and explicit Show/Hide Camera on Stage actions | Visible by default; visibility is independent from the active Stage module |
| Control dock | Mic, camera, share, output, and leave controls | Mounted and visible for the connected session |
| Overlay root | Settings, confirmations, pickers, lightboxes, and other modal surfaces | Mounted once; contains the topmost overlay |
| Notification layer | Toasts, banners, and polite/assertive live regions | Mounted once for the application |

The prejoin portal is a separate route/state, not a compressed version of the
connected shell. It must have a vertical scroll fallback and must not reserve
space for the connected control dock.

The preferred DOM relationship is:

```text
ui-root
|- shell-header
|- workspace
|  |- primary-stage / stage-module-host
|  `- active-users
|- control-dock
|- overlay-root
`- notification-layer
```

Mode changes must restyle these nodes in place. They must not clone them, create
duplicate IDs, or re-register feature listeners.

## Responsive Inputs

Layout decisions use **CSS viewport pixels**, not physical pixels, monitor
resolution, `window.outerWidth`, or a device-name heuristic. Browser zoom and
Windows display scaling therefore participate naturally.

The mode controller reads `document.documentElement.clientWidth` and
`document.documentElement.clientHeight`. Both axes constrain the named mode;
height also exposes pressure flags for density tuning. Safe-area insets and
coarse-pointer queries are CSS inputs and do not alter the named mode.

### Geometry Modes

Mode selection considers both viewport axes. Initial load selects the largest
mode whose minimum width **and** minimum height are satisfied.

| Mode | Minimum width | Minimum height | Utility / dock | Cameras with active share |
| --- | ---: | ---: | --- | ---: |
| `mini` | `0px` | `0px` | Sheet / essential | One focused camera |
| `compact` | `640px` | `480px` | Sheet / icons | One camera in a reserved strip |
| `lounge` | `900px` | `600px` | Overlay / labeled | Up to four, horizontal |
| `theater` | `1280px` | `720px` | Pinned rail / labeled | Up to four, vertical |

The root exposes the selected mode as
`data-ui-mode="mini|compact|lounge|theater"`. Mode names are behavioral
contracts; component CSS must not invent overlapping breakpoint vocabularies
such as `desktop`, `tablet`, or `small-desktop`.

### Hysteresis

Initial load uses the canonical thresholds above. Once mounted, transitions use
a symmetric `48px` deadband on both axes so window-edge dragging and fractional
zoom do not repeatedly open, close, or reannounce controls.

- An upgrade requires both width and height to reach the next mode's minimum
  plus `48px`.
- A downgrade occurs when either width or height falls below the current mode's
  minimum minus `48px`.
- A large resize may cross more than one mode in one decision.
- Geometry inside the deadband retains the current mode.

Examples:

| Transition | Enter/leave condition after mount |
| --- | --- |
| `mini` to `compact` | width `>= 688px` **and** height `>= 528px` |
| `compact` to `mini` | width `< 592px` **or** height `< 432px` |
| `compact` to `lounge` | width `>= 948px` **and** height `>= 648px` |
| `lounge` to `compact` | width `< 852px` **or** height `< 552px` |
| `lounge` to `theater` | width `>= 1328px` **and** height `>= 768px` |
| `theater` to `lounge` | width `< 1232px` **or** height `< 672px` |

Mode is not persisted across launches; each new document starts from the
canonical initial-load thresholds.

`core/viewer/layout-policy.js` is the executable counterpart to these values.
Any threshold, mode-order, or hysteresis change must update that module, its
deterministic tests, and this contract in the same PR. Runtime JavaScript
consumes only `mode`, `isShort`, and `isVeryShort`; CSS owns how those values
present the Stage, Active Users, dock, and camera tiles.

Resize observations must be coalesced to an animation frame. The controller
must emit at most one mode change for a settled measurement and must not add a
human-visible debounce delay. The transition function must be a pure helper with
deterministic boundary tests.

### Height Pressure Flags

The layout policy additionally exposes `isShort` below `650px` and
`isVeryShort` below `520px`. These flags may reduce nonessential spacing and
increase panel scroll area. They must not choose a different Stage-module
presentation, hide primary actions, or detach media; those decisions belong to
the named geometry mode.

Because these flags only tune CSS density and do not open, close, or move an
interactive surface, they do not have independent hysteresis.

## CSS and JavaScript Ownership

| Concern | Owner |
| --- | --- |
| Region tracks, gaps, padding, fixed/sticky placement | CSS |
| Stage-module and Active Users geometry | CSS keyed by root mode |
| Component adaptation within its allocated width | CSS container queries |
| Text wrapping, ellipsis, icon/label presentation | CSS |
| Safe-area insets, coarse-pointer sizing, reduced motion | CSS media queries |
| Width/height mode selection and hysteresis | One JavaScript mode controller |
| Active Stage module, Active Users visibility, and return focus | JavaScript UI state |
| Modal focus containment and background inertness | JavaScript behavior plus CSS presentation |
| Media tile allocation inside the stage or Camera Lobby | Existing media-grid layout owners |
| Room, publication, subscription, Jam, and participant truth | Existing feature state owners |

JavaScript must not write per-breakpoint pixel widths, move feature nodes between
alternate parents, or decide which text happens to fit. A component that needs
local adaptation declares a containment boundary and uses container queries.

Jam's Echo Pulse canvas is a stable child of the session overview rather than
the polling-rebuilt Now Playing metadata node. Its CSS surface owns width and
height, remains within the Stage module's scroll owner, and contracts only
under the existing `data-ui-very-short` pressure flag. Its backing resolution
is device-pixel-ratio and pixel-budget capped; resize and motion changes never
recreate the canvas or alter the Jam audio graph.

The screen-grid allocator calculates media tile geometry inside the stage. It
receives the stage's available rectangle; it must not duplicate shell
breakpoints or control utility-panel behavior. A single visible share owns the
full grid independently of the currently decoded media resolution. Two or more
shares use the canonical grid policy. That policy may use each decoded source's
aspect ratio to choose tracks, but its input rectangle is always the Stage's CSS
viewport geometry rather than physical display pixels. Every video preserves
its complete source frame with `object-fit: contain`; letterboxing and
pillarboxing are preferred to cropping or stretching.

The Camera Lobby uses the same canonical grid policy against the lobby's own
available rectangle. Resizing may change only grid tracks and tile geometry; it
must preserve each mounted camera tile, video element, stream, and track.

A no-JavaScript/failure fallback may use media queries at the canonical
thresholds. The supported runtime, however, uses the named root mode so behavior
and geometry change together.

## Geometry Invariants

### Connected Shell

- The connected root occupies the dynamic viewport (`100dvh`) with a `100vh`
  fallback.
- The root and all grid/flex descendants that own overflow must use
  `min-width: 0` and `min-height: 0` where appropriate.
- The connected document has no horizontal scrollbar at supported widths.
- The document body does not vertically scroll while connected. The stage,
  utility body, and intentional modal bodies are the only scroll owners.
- The prejoin portal is allowed to vertically scroll when its content exceeds
  the viewport.
- Shell padding is `24px` in `theater`, `16px` in `lounge`, `12px` in
  `compact`, and `8px` in `mini`, before safe-area additions.
- While exactly one share is visible, Stage-First presentation may tighten the
  shell padding and inter-region gap for immersion. The empty Stage and
  multi-share layouts retain their normal mode spacing.
- Solo-share labels and media controls overlay the tile instead of
  consuming grid tracks. Overlay controls remain keyboard focusable and must
  not change the video's fitted geometry.
- The ordinary region gap is `16px`. Components may use smaller values from the
  shared spacing scale; they must not introduce arbitrary shell gaps.

### Header and Dock

- The shell header targets a `56px` block size in `theater` and `lounge`,
  `52px` in `compact`, and `48px` in `mini`.
- The dock reserves at least `64px` plus the bottom safe-area inset.
- Stage and panel content must reserve the dock's occupied block size; controls
  and scroll endpoints must never sit underneath it.
- Desktop pointer targets are at least `40px` square. Coarse-pointer targets are
  at least `44px` square.
- The dock remains visually centered and may have a maximum inline size, but it
  must never overflow the viewport or wrap a primary action into a second row.

### Theater Mode

- Workspace columns are `minmax(0, 1fr)` plus an Active Users rail of
  `clamp(320px, 24vw, 360px)` with a `16px` gap.
- Active Users is visible by default. Its explicit Show/Hide action changes only
  the rail; opening, switching, or closing a Stage module never changes it.
- Stage modules fill the primary Stage. Jam uses two internal columns when its
  container is at least `820px` wide; other modules retain their own internal
  layout. Outside clicks do not dismiss a Stage module. Back to Stage and Escape
  are the explicit return paths.
- A participant's camera may be shown on Stage beside that participant's screen.
  Screen and camera use independent tiles and attachments; hiding either never
  unsubscribes, detaches, or reshapes the other.

### Lounge Mode

- The Stage and Active Users rail remain side by side. Stage modules replace the
  screen presentation in the Stage rather than becoming overlays or drawers.
- Jam falls back to one internal column below its `820px` container breakpoint.
- The dock retains labels. A staged camera participates in the same contained
  media grid as screens without changing screen-source geometry.

### Compact Mode

- In portrait, the Stage and Active Users compose as two rows. In short
  landscape they switch to side-by-side columns so the Stage module retains a
  usable height.
- Active Users remains visible by default and may be explicitly hidden to return
  the full workspace to the Stage.
- Stage modules and Active Users may not cover the control dock. Their maximum
  block size is the dynamic viewport minus the header, dock, and safe areas.
- The dock uses icon variants with accessible names.
- With a share active, one selected camera uses a reserved horizontal strip.
  It remains in normal layout flow and may not overlap the share, controls, or
  status.

### Mini Mode

- The workspace is one column and the dock shows only essential connected-
  session actions; secondary actions move to overflow.
- The Stage and Active Users follow the compact portrait/short-landscape split,
  with tighter safe-area-aware geometry and coarse-pointer targets.
- With a share active, at most one selected camera receives focused placement.
  Other cameras remain available through Active Users.
- Mini mode must not depend on hover to reveal any action.

### Layering

Components use semantic layer tokens rather than one-off `z-index` values:

| Layer | Token intent |
| --- | --- |
| Base regions | `0` |
| Sticky header and dock | `20` |
| Stage module and Active Users region overlays | `30` |
| True modal scrim | `40` |
| Modal/picker/lightbox | `50` |
| Toasts and critical banners | `60` |

Nested component overlays must remain inside their region's stacking context.
Only the overlay root and notification layer may escape the shell layer system.

## Control Dock Contract

The dock is the single home for connected-session actions. From start edge to
end edge, the stable primary order is:

1. Microphone
2. Camera
3. Screen share
4. Output/audio device entry point
5. Leave room, visually separated as destructive

The foundation may reserve one contextual slot, but a feature may not displace
or reorder the primary controls. Secondary features such as Theme, Feedback,
Updates, Debug, and administrative tools belong in the shell overflow or their
own authorized surface.

Each control must expose actual state (`on`, `off`, `muted`, `starting`,
`failed`) rather than only optimistic intent. Resizing or changing mode must not
clear a pending state. Icon-only presentations retain an accessible name and a
mouse/keyboard tooltip.

The dock appears only after a room connection has reached the UI's connected
state. Reconnecting may annotate or temporarily disable affected actions, but
must not remove the dock and cause the workspace to jump.

## Stage Module and Active Users Contract

- There is one Stage-module host and at most one active Stage module.
- Module selection and Active Users visibility are orthogonal states that
  survive geometry-mode transitions.
- Each Stage module owns its scrollable body. Wide Jam may split that ownership
  into independent session-overview and music-browser scrollers so a long
  catalog does not push playback controls away. Its header remains visible.
- A Stage module is not a true modal dialog. It makes only the hidden screen-grid
  presentation inert; Active Users and the call dock remain keyboard-operable.
  Escape and Back to Stage close it and restore focus. Confirmations, pickers,
  and other true dialogs use the overlay root and may contain focus normally.
- Switching modules preserves tool-local state such as an unsent chat draft,
  Jam search text, queue position, and participant scroll.
- Opening a Stage module never changes Active Users visibility. Opening Settings
  never competes with a still-interactive Stage module at the same layer.

## Cards, Labels, and Truncation

Cards adapt to their own inline size rather than the global viewport. The shared
card contract uses these container bands:

| Container width | Presentation |
| --- | --- |
| `>= 304px` | Full identity, status, and labeled primary action |
| `240px` through `303px` | Condensed spacing; secondary labels collapse |
| `< 240px` | Minimal/icon presentation; identity and primary state remain |

Feature-specific thresholds may vary only when backed by a documented content
requirement and visual tests.

Content priority is:

1. Identity/title and primary state
2. Primary action
3. Critical warning or error
4. Status badges
5. Descriptive copy and secondary controls

Rules:

- Participant names, room names, track titles, and song titles use
  `min-width: 0` and a single-line ellipsis in dense headers. The full value
  remains in the accessible name and is available on focus/hover.
- Descriptive and status copy may wrap to two lines before truncating. Errors
  that require action must not be ellipsized without an expansion path.
- Buttons do not truncate ambiguous text. They switch to a known icon-only
  variant with an accessible label.
- Badges do not shrink into unreadable fragments; lower-priority badges move
  into the overflow menu.
- Unbounded user content uses `overflow-wrap: anywhere` in a scroll owner; it
  must not widen a region.
- Camera state must not relocate participant identity or audio controls.
- Set-and-forget controls, including per-participant chime volume, belong in an
  audio/settings popover. A non-default override may expose a compact state
  indicator on the card.
- Hover may enhance a card but must not be the only route to mute, volume,
  fullscreen, or overflow actions.

## Media Nodes and State Preservation

Responsive behavior must preserve media and application state by identity, not
merely reproduce a similar-looking result.

During a geometry-mode or height-pressure change, implementations must not:

- call LiveKit `attach`, `detach`, publish, unpublish, subscribe, or unsubscribe
  solely because geometry changed;
- replace or clone an active `<video>` or `<audio>` element;
- reconstruct participant cards or screen tiles;
- disconnect/reconnect the room or its data channels;
- reset microphone, screen, chime, Jam, or per-participant volume;
- clear selected room/tool state, focused share, chat draft, or queue/search
  state;
- toggle an active media container to `display: none` as a breakpoint shortcut,
  because that can affect adaptive-stream visibility and decode behavior.

The same media element must remain connected to the same track across a resize.
CSS may change its containing geometry and `object-fit`. The media-grid owner may
recalculate tile tracks after its container changes size.

Browser fullscreen must target the existing stable media tile (or another
existing stable media host). It must not reparent, clone, or replace the live
video. The fullscreen host keeps an explicit, keyboard-reachable exit control,
preserves source aspect ratio, and restores focus, focused-share state, and the
pre-fullscreen responsive hysteresis history after exit. Resize and display
changes while fullscreen may update the temporary presentation, but must not
leave stale tracks or geometry after exit. The Windows desktop shell inherits
this HTML fullscreen path through its WebView runtime; responsive code must not
also invoke an independent native fullscreen toggle.

If an intentional user action hides or stops watching media, that feature's
existing state machine remains the owner. Responsive code must not impersonate
that action.

Acceptance tests for the shell must retain references to representative media
nodes, cross every hysteresis boundary in both directions, exercise repeated
fullscreen enter/exit cycles, and assert object identity, track identity,
publication state, volume, focused-share state, responsive mode restoration,
and selected UI state.

## Accessibility and Input Contract

- All interactive controls must be reachable and operable by keyboard.
- Every interactive element has a visible `:focus-visible` treatment with at
  least a `2px` indicator that is not color-confusable with the background.
- Icon-only controls have an accessible name. Tooltips supplement but do not
  replace that name.
- Theater's Active Users rail follows normal document focus order. Stage modules
  keep Active Users and the call dock in the keyboard order while only the
  screen-grid presentation is inert; Escape closes them and restores focus to
  their invoker. True modal confirmations, pickers, and dialogs contain focus,
  make their background inert, and close on Escape when safe.
- Stage-module selectors use the tabs pattern only if they behave as tabs;
  otherwise they use ordinary toggle buttons with `aria-expanded` and
  `aria-controls`.
- State is never communicated by color alone. Muted, disconnected, warning,
  active, and destructive states include text or an icon with an accessible
  label.
- Polite status changes use an appropriate live region. Connection loss and
  destructive failures may use assertive announcement; routine resize and mode
  changes are not announced.
- Coarse-pointer targets are at least `44px` by `44px`, with at least `8px`
  separation where adjacent destructive and non-destructive actions could be
  confused.
- At 200% text zoom, primary controls remain available, no horizontal page
  scroll appears, and clipped text has an accessible expansion route.
- `prefers-reduced-motion: reduce` disables decorative drift, pulse, shimmer,
  and large panel transitions. Essential state changes remain immediate.
- Safe-area insets are honored on every edge used by the dock, Stage module, or
  Active Users region.

## Viewport and Content Matrix

All dimensions below are CSS pixels. These are minimum required validation
fixtures, not device sniffing rules. Unless a row names a prior mode, its
expected mode is the fresh-document classification without hysteresis history.

| Viewport / condition | Expected mode | Required content case | Expected behavior |
| --- | --- | --- | --- |
| `1920 x 1080` | `theater` | Four shares, twelve people, Chat open | Active Users remains within `320-360px`; the Stage module has no horizontal overflow |
| `1920 x 1080` | `theater` | Populated Jam open | Jam fills the Stage, uses two internal columns, leaves Active Users visible by default, and leaves the dock interactive |
| `1366 x 768` | `theater` | Two shares, eight long participant names | Dock stays one row; names truncate; stage remains usable |
| `1280 x 720` | `theater` on initial load | One ultrawide share, Active Users visible | Rail uses its minimum range; share preserves aspect ratio |
| `1024 x 768` | `lounge` | Two shares, Chat open with draft | Chat owns the Stage; Active Users remains independent; draft survives close/reopen |
| `900 x 700` | `lounge` | Jam populated with long song titles | Internal Jam scrolls; dock and destructive actions remain visible |
| `900 x 540` | `compact`, `isShort` | One share plus one camera | Stage and Active Users fit; camera and screen remain independent without overlap |
| `768 x 1024` | `compact` | Camera tiles plus Active Users | Both rows fit inside safe area; no hover-only controls |
| `640 x 360` | `mini`, short landscape | Jam or Camera Lobby plus Active Users | Side-by-side layout keeps Back to Stage usable; no overlap with dock or Users |
| `640 x 480` | `compact` on initial load, `isShort`, `isVeryShort` | Connected empty stage | Essential empty-state action and dock remain reachable |
| `600 x 900` | `mini` | Chat history, attachment, software keyboard | Stage-module content scrolls above dock; composer remains reachable |
| `360 x 640` | `mini`, `isShort` | Prejoin error; connected empty stage | Prejoin scrolls; connected dock uses essential controls; no horizontal scroll |
| 200% zoom at `1920 x 1080` | Approximately `compact` by CSS geometry | Active Users and status copy | Mode follows CSS viewport; controls do not clip or overlap |
| Resize `compact` from `768 x 1024` to `600 x 900` | `compact` retained | Connected shell with Stage module open | Hysteresis prevents a presentation jump inside the lower deadband |
| Continue that resize to `591 x 900` | `mini` | Same mounted nodes and state | Mode changes once; no media or feature node is recreated |

Every viewport is also checked with:

- no active share and a useful empty-state action;
- one and four simultaneous shares;
- one, eight, and twenty participants;
- a 60-character unbroken display name and long localized-style labels;
- screens visible and each registered Stage module open, with Active Users shown
  and hidden independently;
- reconnecting, disabled, error, and destructive-confirmation states;
- mouse, keyboard-only, and coarse-pointer emulation.

## Verification Requirements

Foundation and migration PRs must include proportionate evidence:

1. Deterministic mode-transition tests covering every threshold and deadband.
2. DOM-identity tests proving representative media elements survive mode
   changes.
3. State-preservation tests for active Stage module, Active Users visibility,
   participant volume, focused share, and at least one unsaved text input.
4. Geometry assertions or screenshots for the viewport/content matrix.
5. Keyboard checks for dock, module selection, Back/Escape, modal focus,
   and focus restoration.
6. No-horizontal-overflow checks at each required viewport and 200% zoom.
7. Reduced-motion and coarse-pointer checks.

Visual snapshots may verify geometry, but they do not replace state and media
identity assertions.

## Migration and Feature-Flag Phases

The rollout flag is named `echo-ui-shell-v2`. It controls presentation only and
must not select alternate room, media, participant, or Jam state machines.

The flag should be resolved before first paint and exposed as a root attribute.
The new and legacy presentation must use the same feature nodes; do not create a
second hidden connected UI. A development/test override may force either value,
but production default changes require an explicit release decision.

### Phase 0 - Contract and Measurements

- Land this contract and document baseline viewport evidence.
- Add no production behavior and keep the flag absent/off.
- Identify current scroll owners, media-node owners, and overlay collisions.

### Phase 1 - Foundation Behind Flag

- Add semantic shell regions, shared geometry/layer tokens, and the tested mode
  controller.
- Keep the flag off by default.
- Preserve current feature placement unless moving it is required to establish
  a single stable region.
- Verify that toggling the flag never duplicates media or feature listeners.

The Phase 1 implementation also establishes the first real connected-shell
presentation for the existing primary controls and participant/Chat surfaces. It
reuses the original buttons, panels, participant cards, media elements, and
state owners; resize and live flag changes only alter CSS presentation. Phase 2
migrates feature panels into the Stage-module host.

### Phase 2 - Dock, Active Users, and Stage Modules

- Active Users is a persistent, independently controlled region. It is visible
  on a fresh connected session and only its explicit Show/Hide action changes
  that preference.
- Chat, Jam, Camera Lobby, and Soundboard are the registered Stage modules. One
  shell controller owns module selection, Back to Stage, Escape, inertness, and
  focus restoration. Feature modules retain ownership of drafts, camera media,
  Jam queue/playback, Soundboard state, and other feature truth.
- Opening a module hides but does not destroy the screen grid. Closing it
  recalculates the existing grid without recreating, detaching, subscribing, or
  replacing screen media nodes. Camera-on-Stage uses a second muted attachment
  and independent tile state, so a user's screen and camera can coexist.
- Resize and live flag changes restyle and portal the mounted nodes in place.
  Legacy rollback remains a one-switch presentation fallback with no duplicate
  IDs, listeners, or feature state machines.
- Verification covers node and input-state preservation, Active Users
  independence, 32:9 screen geometry at desktop and ultrawide viewports,
  simultaneous screen/camera tiles, short-landscape composition, keyboard and
  focus restoration, and Jam Stop Music versus End Jam behavior.

### Phase 3 - Canary Default-On

- Enable the flag by default for Sam's explicit canary/test build.
- Validate the full viewport/content matrix and real room transitions.
- Keep a one-switch rollback that restores legacy presentation without stored-
  state conversion or a server restart.

### Phase 4 - General Default and Cleanup

- Make the new shell the production default only after canary evidence is clean.
- Keep forced legacy presentation for at least one normal release unless an
  urgent defect requires longer.
- Remove legacy layout CSS, the flag, and dual-path tests in a focused cleanup
  PR after the rollback window closes.

The general rollout now defaults clients with no stored preference to the V2
shell. Explicit query or stored `0` values continue to select the legacy shell
for rollback validation during the normal-release safety window.

## Foundation PR Non-Goals

The foundation PR must not:

- redesign every feature panel or restyle all themes;
- change room, auth, control-plane, SFU, TURN, or LiveKit protocol behavior;
- change microphone, camera, screen-share, participant, Chat, Soundboard, or Jam
  state machines;
- introduce a new frontend framework or revive `core/viewer-next/`;
- replace the existing media-grid allocation algorithm;
- add mobile-only product features or claim native-mobile parity;
- migrate persisted settings or require a new server schema;
- remove the legacy layout before the feature-flag rollback window;
- treat hover effects, animation, or theme polish as acceptance criteria for
  responsive correctness;
- perform a production deploy or desktop release merely because the contract
  and inert foundation land.

The foundation is successful when it creates a safe, testable responsive shell
that later PRs can populate without moving state ownership or risking live media.
