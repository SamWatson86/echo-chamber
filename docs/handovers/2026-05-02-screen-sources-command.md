# Screen Sources Command Investigation Handover

Date: 2026-05-02
Worktree: `F:\EC-worktrees\screen-sources-command`
Branch: `codex/screen-sources-command-investigation`
Base: `origin/main` at `55e0a72`
Local commit: `e4c25e0 Add fallback for missing native screen source command`

## How to Resume

If Sam starts a new Codex thread in this worktree and says only `continue`, treat that as:

1. Read `AGENTS.md`.
2. Read this handover.
3. Run `git status --porcelain=v1 -b`.
4. Confirm the current folder is `F:\EC-worktrees\screen-sources-command`, not `F:\EC-worktrees\main`.
5. Continue the screen-source command investigation from the current decision point.

Do not ask Sam to re-explain the issue unless the local evidence has gone missing or contradicts this file.

In Codex Desktop, this work should be opened as its own Project pointed at `F:\EC-worktrees\screen-sources-command`. Do not try to switch the `Echo Chamber - Main` project to this branch; Git will block that because this branch is already checked out by this worktree.

## User Goal

Z tried to share his screen and saw:

`Error loading sources: Command list_screen_sources not found`

Sam reported this as a new bug. This worktree was created to keep the official `main` worktree clean while investigating.

## Current Status

- Worktree created and aligned with `origin/main`.
- Viewer compatibility patch has been implemented.
- Sam reported Zane was later able to share his screen, so this is no longer an active live incident.
- Keep this branch as a parked compatibility hardening patch unless Sam explicitly asks to discard it.
- The patch has been committed locally as `e4c25e0`.
- Official `main` worktree stayed clean.
- No push or PR has been created.

## Evidence

- `core/viewer/capture-picker.js` calls `tauriInvoke('list_screen_sources')`.
- Current `origin/main` has `core/client/src/main.rs` defining and registering `list_screen_sources`.
- Tag `v0.4.3` does not register `list_screen_sources`.
- Live admin dashboard showed Z online as `z-6826` on the current server-served viewer stamp `0.6.11.1777212663`.
- The live viewer stamp does not prove the installed desktop shell version, because the viewer is served by the server.
- After the initial report, Sam said Zane was suddenly able to share his screen. That suggests the live symptom resolved through a client restart/update or compatible path, but the fallback remains valid hardening for future version skew.
- A separate Zane avatar issue was investigated during the same live session. `/api/avatar/zane` returned 200 while `/api/avatar/z` and `/api/avatar/z-6826` returned 404, showing an identity-key mismatch. The existing avatar was re-registered under `z` through the app's avatar API; afterward `zane`, `z`, and `z-6826` all returned 200. No server restart was needed, and this branch does not include avatar code changes.

## Root Cause

This is a compatibility boundary bug.

The server-served viewer can be newer than a user's installed desktop shell. If that older shell exposes Tauri IPC but does not register `list_screen_sources`, the native picker displays:

`Error loading sources: Command list_screen_sources not found`

Before this patch, the picker only rendered that error inside the modal and never rejected/resolved the picker promise, so the screen-share flow stalled instead of falling back.

## Patch Implemented

- Added `isTauriCommandMissingError` in `core/viewer/capture-picker.js`.
- When `list_screen_sources` is missing, the picker now rejects instead of trapping the user in the modal.
- `core/viewer/screen-share-native.js` catches that compatibility failure and falls back to the browser `getDisplayMedia` screen picker.
- Added regression coverage in `core/viewer/reliability-scenarios.test.js`.

## Verification

Passed before local commit:

```powershell
node --test core/viewer/reliability-scenarios.test.js
node --test core/viewer/*.test.js
node --check core/viewer/capture-picker.js
node --check core/viewer/screen-share-native.js
git diff --check
```

`node --test core/viewer/*.test.js` reported 48 passing tests.

Fresh verification after the branch was parked:

```powershell
node --test core/viewer/*.test.js
node --check core/viewer/capture-picker.js
node --check core/viewer/screen-share-native.js
git diff --check
```

Result: 48 passing viewer tests, both touched JS files parsed successfully, and `git diff --check` only reported normal CRLF warnings.

## Release Impact

Server-served viewer update. This patch does not require a new desktop binary for the fallback behavior. Users on old desktop shells should receive the viewer behavior from the server after deploy.

Users still need a newer desktop shell for native capture quality, but this patch avoids the hard failure by falling back to browser capture.

Do not treat this as an emergency deploy. The practical live issue self-resolved, likely because the desktop shell updated/restarted or the user moved onto a compatible path. This branch is useful as a low-risk future-proofing fix for server/client version skew.

## Current Decision Point

Sam needs to choose one of these paths:

1. Leave the branch parked locally as a known compatibility fix.
2. Push it and open a PR when he wants the fallback reviewed.
3. Delete/discard it only if he explicitly decides the compatibility fallback is not worth keeping.

Do not push, deploy, open a PR, or delete the worktree unless Sam asks.

## Exact Prompt to Continue With

Continue from the parked screen-source compatibility fix in `F:\EC-worktrees\screen-sources-command` on branch `codex/screen-sources-command-investigation`. Confirm status, review commit `e4c25e0`, and summarize the current decision point: leave parked, prepare PR, or discard only if Sam explicitly asks. Preserve the official main worktree and do not push, deploy, open a PR, or delete the worktree without Sam asking.
