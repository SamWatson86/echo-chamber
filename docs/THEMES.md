# Viewer Themes

Echo's production theme system lives in `core/viewer/`. A global theme is the
default for the entire viewer: the stage, participant rail, chat, Jam, camera
lobby, soundboard, settings, and capture picker all follow it. Theme Studio can
optionally override an individual module without changing the rest of Echo.

Theme changes are visual only. They must not recreate media elements, alter room
state, or change module behavior.

## Theme Catalog

Theme IDs are part of the persisted preference contract. The refreshed display
names intentionally retain the original IDs so existing preferences keep
working.

| Display name | Stable ID | Character |
|---|---|---|
| Aero | `frost` | Cobalt and cyan glass; the default |
| Hyperpop | `cyberpunk` | Pink, aqua, and chartreuse |
| Aurora | `aurora` | Emerald light over deep indigo |
| Afterglow | `ember` | Coral, amber, and dark plum |
| Noir | `midnight` | Graphite, silver, and restrained lilac |
| Matrix | `matrix` | Falling code and green phosphor |
| Event Horizon | `event-horizon` | Violet nebulae and cold starlight |
| Tempest | `tempest` | Slate clouds, rain, and distant lightning |
| Abyss | `abyss` | Deep water and bioluminescent currents |
| Neon Wilds | `neon-wilds` | Midnight foliage and wandering fireflies |
| Ultra Instinct | `ultra-instinct` | **It's astounding! This mortal really is something else...Look at that brilliant form...There can be no doubt! This is the true power, complete in all its majesty! This is... AUTONOMOUS ULTRA INSTINCT!!!!** |

Do not rename or remove an ID without an explicit preference migration.

Theme Studio presents the catalog in two collections:

- **Core Looks:** Aero, Hyperpop, Aurora, Afterglow, and Noir.
- **Animated Worlds:** Matrix, Event Horizon, Tempest, Abyss, Neon Wilds, and
  Ultra Instinct.

## Global and Module Scope

An unset module override means **Follow global**. An explicit override changes
that module's palette while shared page chrome, the overall background, and
global effects continue to use the global theme.

| Module | ID | Theme root |
|---|---|---|
| Stage | `stage` | `.room-main` |
| People | `people` | `#room-sidebar` |
| Chat | `chat` | `#chat-panel` |
| Jam | `jam` | `#jam-panel`, `#jam-banner`, `.jam-toast` |
| Camera Lobby | `camera` | `#camera-lobby` |
| Soundboard | `soundboard` | `#soundboard-compact`, `#soundboard` |
| Settings | `settings` | `#settings-panel` |
| Capture Picker | `capture` | `#capture-picker-overlay` |

The controller marks static roots automatically. The capture picker and Jam
toasts are created on demand, so their scripts call
`window.EchoTheme.bindModule(...)` immediately after appending each root and
release the returned binding when that root is removed. Future dynamically
created module roots must use the same bind/unbind pattern.

## Motion

Motion is independent of palette:

- **Still** (`still`) disables decorative animation.
- **Ambient** (`ambient`) enables slow, restrained atmosphere.
- **Full** (`full`) enables the complete treatment, including supported
  full-page canvas effects.

`full` is the compatibility default. When the operating system reports
`prefers-reduced-motion: reduce`, Echo caps the effective level at `still`
without overwriting the user's requested level. The saved choice returns when
the OS restriction is removed.

An Animated World starts a page-wide effect only when it is the **global**
theme and effective motion is `ambient` or `full`. A per-module Animated World
override applies its palette without starting or resynchronizing that renderer.
Ultra Instinct's full-screen GIF remains Full-only.

## Animated World Performance Contract

All Animated Worlds share one `theme-effects.js` Canvas2D host. They do not
create independent loops or canvases.

- Exactly one effect canvas can exist, and it is reused while switching worlds.
- Ambient is capped at 12 draws per second, 480,000 backing pixels, DPR 1, and
  a maximum of 48 scene entities.
- Full is capped at 24 draws per second, 1,050,000 backing pixels, DPR 1.25,
  and a maximum of 96 scene entities.
- A timer-gated paint scheduler wakes near those caps instead of polling every
  refresh on high-Hz displays.
- Particle storage is preallocated. Render loops do not create gradients,
  images, videos, DOM nodes, or growing arrays per frame.
- Resize work is coalesced into the existing animation loop.
- `visibilitychange` cancels the loop while Echo is hidden and resumes exactly
  one loop when visible.
- Still, system reduced motion, Core Looks, `pagehide`, and controller teardown
  remove the active canvas and schedule no frames.
- Animated global themes use authored translucent surfaces without live
  backdrop-blur resampling over the moving canvas.
- The four procedural worlds add no image, video, remote, or audio payloads.
  Ultra Instinct's existing GIF is the explicit retained exception, and its
  preview stays lazy until Theme Studio is opened. Still and system reduced
  motion use a static CSS preview instead.

The renderer exposes bounded read-only metrics through
`window.EchoThemeEffectDiagnostics.getMetrics()` for regression and performance
verification.

## Persistence

Theme preferences use the normal `echoGet`/`echoSet` settings path. The native
desktop shell persists them in its settings JSON through Tauri IPC; browsers
use `localStorage`. The native settings load re-applies the controller state
after startup.

| Key | Value |
|---|---|
| `echo-core-theme` | One stable theme ID |
| `echo-core-theme-overrides` | JSON object of valid module IDs to theme IDs |
| `echo-core-theme-motion` | `still`, `ambient`, or `full` |
| `echo-core-ui-opacity` | Existing UI opacity preference, managed alongside Theme Studio |

Unknown themes, modules, malformed override JSON, and invalid motion values are
ignored safely. Loading settings must not write defaults back over saved native
settings.

## DOM and Token Contract

The runtime publishes state through these attributes:

- `<html data-echo-theme="theme-id">` mirrors the global theme for first paint.
- `<body data-theme="theme-id">` retains the global legacy selector contract.
- `<html data-theme-motion-requested="level">` records the saved user choice.
- `<html data-theme-motion-effective="level">` records the OS-capped level in
  use.
- Module roots always receive `data-echo-module="module-id"`.
- Module roots receive `data-module-theme="theme-id"` only for an explicit
  override; absence means inherit global.

`--ec-*` custom properties are the canonical visual contract. Every theme must
define the complete semantic set:

- Foundations: `--ec-canvas`, `--ec-workspace`, `--ec-surface`,
  `--ec-surface-raised`, `--ec-surface-hover`, `--ec-overlay`
- Type: `--ec-text`, `--ec-text-muted`, `--ec-text-faint`
- Accent and state: `--ec-accent`, `--ec-accent-bright`, `--ec-accent-soft`,
  `--ec-live`, `--ec-success`, `--ec-warning`, `--ec-danger`
- Structure: `--ec-border`, `--ec-border-strong`, `--ec-shadow`
- Composition: `--ec-body-background`, `--ec-panel-background`,
  `--ec-pattern`, `--ec-ambient`

`themes.css` bridges these semantics to the existing viewer and `--club-*`
aliases. New theme-aware CSS should consume semantic `--ec-*` tokens instead of
adding theme-specific colors to module rules.

## Verification and Release Boundary

Every user-facing theme change requires viewer unit coverage and browser
regression coverage. At minimum, verify:

- global propagation through every module root, including the dynamic capture
  picker;
- module override isolation, reset behavior, persistence, and malformed data;
- requested versus effective motion and global-effect cleanup;
- no recreation of room, media, or shared-state DOM;
- Theme Studio keyboard behavior and narrow-viewport containment.

Run `npm run verify:viewer` and `npm run verify:viewer:layout` before merge.

For a human visual pass, run
`npm --prefix core/viewer-tests run preview:themes` and open
`http://127.0.0.1:4188/?echo-ui-shell-v2=1`. This localhost-only harness serves
fixture participants and media, forces motion available, and displays a
persistent **ISOLATED THEME PREVIEW — NOT LIVE ECHO** banner. It does not
connect to or restart the production runtime.

Changes confined to `core/viewer/` are a **server-served viewer update** and are
normally `release-impact:server-only`. They do not require a Windows desktop
binary unless native shell or packaged desktop resources also change. A deploy
or runtime restart is a separate production operation governed by
`docs/OPERATIONS.md`.
