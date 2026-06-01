# Release Boundaries: Server vs Desktop Binary

This document removes ambiguity about when Echo Chamber needs a new desktop
binary release.

## Core Rule

A new desktop binary is required only when the installed desktop app itself must
change.

If a change is purely server/runtime and clients consume it from the server, a
binary release is usually not required.

## Echo Chamber Reality

The current Core Tauri client opens a server-hosted viewer URL
(`{server}/viewer/`) rather than hard-loading bundled static UI only.

Practical implication:

- many things Sam may call a "client update" are actually server-served viewer
  updates and can often ship via server deploy
- native shell, updater, and IPC changes still require a new Windows desktop
  binary
- Echo Chamber releases are Windows-only unless Sam explicitly asks otherwise

## Decision Matrix

| Change type | Example | Needs desktop binary release? | Why |
|---|---|---:|---|
| Server/API logic | auth checks, room rules, endpoint behavior | No, usually | Applied by deploying runtime/server code |
| Viewer behavior served from server | UI fixes, client-side state fixes delivered by server | No, usually | Browser/connected clients get updated assets from server |
| Desktop/Tauri/native behavior | tray behavior, native IPC, updater code | Yes | Installed app binaries must be updated |
| Bundled desktop assets/config packaged into app | embedded resources used by installed app | Yes | Existing installs will not change without app update |
| Release metadata only | notes/version docs without shipped behavior change | No | No runtime/app behavior change |

## Deployment Reality

Current operating model is a central shared server. In this model, most server
and viewer changes ship without a desktop binary release.

Local desktop-hosted runtime should be treated as a development/edge case, not
the default production path. If someone is running that mode, packaged-runtime
changes may require a desktop release.

When unsure, answer this question:

> Will existing installed desktop clients get this change without installing
> anything new?

- If yes, no new desktop binary is needed.
- If no, cut a new Windows desktop release.

## Tauri Updater Boundary

The auto-updater does not update server deployments. It updates installed
desktop apps after a proper desktop release is published.

Sequence:

1. Build and publish Windows desktop release artifacts.
2. Desktop app checks for update.
3. Installed clients update.

No published release artifacts means nothing for the updater to apply.

## Practical Release Triggers

Usually server-only:

- `core/viewer` JS/HTML/CSS behavior fixes served by control server
- control-plane API logic fixes
- room/jam/state bugfixes delivered via server-hosted viewer assets

Usually desktop-binary required:

- `core/client` or native shell code changes
- updater behavior, native IPC commands, window/tray/native integration changes
- packaged resource/runtime changes that existing installs cannot fetch
  dynamically

Cut a new desktop release when one or more are true:

- Desktop shell/native behavior changed.
- Tauri IPC contract changed.
- Packaged desktop runtime/resources changed.
- All installed clients need a new desktop version for compatibility.

Do not cut a desktop release just because:

- a server-only bugfix shipped
- a viewer bugfix is served by the shared server
- docs-only or issue-label changes landed

## Suggested PR Labeling

Use one of these labels, or include equivalent wording in the PR body:

- `release-impact:server-only`
- `release-impact:desktop-binary`
- `release-impact:both`

Example:

```md
## Release impact
- [ ] Server-only
- [ ] Desktop binary required
- [ ] Both
```

## Terminology Shortcuts

- **Server deploy**: update runtime on host; no installer required.
- **Desktop release**: publish a new Windows installer/updater artifact for
  installed app update.
- **Updater path**: mechanism desktop app uses to fetch/apply published desktop
  releases.
