# Terminology

Use these terms consistently when discussing work with contributors/agents.

## Runtime terms

- **Control plane**: backend/runtime logic for auth, rooms, and API behavior.
- **Viewer**: user-facing web/client UI behavior.
- **Desktop shell**: native app wrapper/runtime integration (Tauri).

## Delivery terms

- **Server deploy**: rollout of runtime/server changes.
- **Desktop release**: publishing new EXE/DMG artifacts.
- **Auto-updater**: desktop mechanism that applies published desktop releases.

## Change-scope terms

- **Server-side change**: behavior changed by deploying backend/runtime code.
- **Client-side change**: user-facing logic/UI behavior change.
- **Binary-required change**: change that requires users to receive a new installed app build.

## Process terms

- **Verification gate**: automated checks required before merge.
- **Regression test**: test proving a previously broken behavior remains fixed.
- **Foundation PR**: prerequisite infrastructure/testing PR that must land before high-volume fix work.

## Avoid ambiguous phrasing

Prefer:
- “server deploy required”
- “desktop binary release required”
- “server-only fix”

Avoid:
- “needs an update” (without saying *what kind*)
- “client update” (without saying browser-served vs desktop binary)
