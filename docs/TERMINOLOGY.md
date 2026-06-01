# Terminology

Use these terms consistently when discussing work with contributors and agents.

## Runtime Terms

- **Control plane**: backend/runtime logic for auth, rooms, and API behavior.
- **Viewer**: user-facing web/client UI behavior served from `/viewer/`.
- **Desktop shell**: native installed app wrapper/runtime integration (Tauri).

## Delivery Terms

- **Server deploy**: rollout of runtime/server changes.
- **Server-served viewer update**: frontend behavior change delivered by
  server-hosted viewer assets.
- **Desktop release**: publishing a new Windows installer/updater artifact for
  installed desktop apps.
- **Auto-updater**: desktop mechanism that applies published desktop releases.

## Change-Scope Terms

- **Server-side change**: behavior changed by deploying backend/runtime code.
- **Client-side change**: user-facing logic/UI behavior change.
- **Binary-required change**: change that requires users to receive a new
  installed app build.

## Process Terms

- **Verification gate**: automated checks required before merge.
- **Regression test**: test proving a previously broken behavior remains fixed.
- **Foundation PR**: prerequisite infrastructure/testing PR that must land
  before high-volume fix work.

## Avoid Ambiguous Phrasing

Prefer:

- "server deploy required"
- "server-served viewer update"
- "desktop binary release required"
- "server-only fix"

Avoid:

- "needs an update" without saying what kind
- "client update" without saying browser-served vs desktop binary
