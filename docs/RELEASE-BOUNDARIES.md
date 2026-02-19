# Release Boundaries: Server vs Desktop Binary

This document exists to remove ambiguity about when we need to cut new EXE/DMG releases.

## Core rule

A new desktop binary is required **only** when the installed desktop app itself must change.

If a change is purely server/runtime and clients consume it from the server, a binary release is usually **not** required.

## Echo Chamber-specific reality (important)

In the current Core Tauri client, the app window is explicitly opened against a **server-hosted viewer URL** (`{server}/viewer/`) rather than hard-loading bundled static UI only.

Practical implication:
- many things Sam may call a "client update" are actually **server-served viewer updates** and can often ship via server deploy,
- while native shell/updater/IPC changes still require a new EXE/DMG.

---

## Decision matrix

| Change type | Example | Needs EXE/DMG release? | Why |
|---|---|---:|---|
| Server/API logic | auth checks, room rules, endpoint behavior | No (usually) | Applied by deploying runtime/server code |
| Viewer behavior served from server | UI fixes, client-side state fixes delivered by server | No (usually) | Browser/connected clients get updated assets from server |
| Desktop/Tauri/native behavior | tray behavior, native IPC, updater code, packaged runtime internals | **Yes** | Installed app binaries must be updated |
| Bundled desktop assets/config packaged into app | embedded resources used by installed app | **Yes** | Existing installs won’t change without app update |
| Release metadata only | notes/version docs without shipped behavior change | No | No runtime/app behavior change |

> “Usually” matters because deployment mode affects delivery. See below.

---

## Deployment mode caveat

### If users connect to a central shared server
Most server + viewer changes can ship without desktop binary updates.

### If users run local desktop-hosted runtime
Changes to that locally packaged runtime may require a new desktop release.

When unsure, answer this question:

> **Will existing installed desktop clients get this change without installing anything new?**

- If **yes** → no new EXE/DMG needed.
- If **no** → cut a new desktop release.

---

## Tauri updater boundary (important)

The auto-updater does **not** magically update server deployments.
It updates installed desktop apps **after** a proper desktop release is published.

So the sequence is:
1. Build/publish desktop release artifacts.
2. Desktop app checks for update.
3. Installed clients update.

No published release artifacts = nothing for updater to apply.

---

## Practical release triggers

### Usually server-only (no new EXE/DMG)
- `core/viewer` JS/HTML/CSS behavior fixes served by control server
- control-plane API logic fixes
- room/jam/state bugfixes that are delivered via server-hosted viewer assets

### Usually desktop-binary required
- `core/client` (or native shell) code changes
- updater behavior, native IPC commands, window/tray/native integration changes
- packaged resource/runtime changes that existing installs cannot fetch dynamically

Cut a new desktop release when one or more are true:

- Desktop shell/native behavior changed
- Tauri IPC contract changed
- Packaged desktop runtime/resources changed
- You need all installed clients on a new desktop version for compatibility

Do **not** cut desktop release just because:

- server-only bugfix shipped
- viewer bugfix is served by shared server
- docs-only or issue-label changes

---

## Suggested PR labeling

Use one of these labels (or equivalent) to make release impact explicit:

- `release-impact:server-only`
- `release-impact:desktop-binary`
- `release-impact:both`

If adding labels is not desired, include an equivalent section in PR body:

```md
## Release impact
- [ ] Server-only
- [ ] Desktop binary required
- [ ] Both
```

---

## Terminology shortcuts

- **Server deploy**: update runtime on host; no installer required.
- **Desktop release**: publish new EXE/DMG artifacts for installed app update.
- **Updater path**: mechanism desktop app uses to fetch/apply published desktop releases.
