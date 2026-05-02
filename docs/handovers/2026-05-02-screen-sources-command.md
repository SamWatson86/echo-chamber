# Screen Sources Command Investigation Handover

Date: 2026-05-02
Worktree: `F:\EC-worktrees\screen-sources-command`
Branch: `codex/screen-sources-command-investigation`
Base: `origin/main` at `55e0a72`

## How to Resume

If Sam starts a new Codex thread in this worktree and says only `continue`, treat that as:

1. Read `AGENTS.md`.
2. Read this handover.
3. Run `git status --porcelain=v1 -b`.
4. Continue the screen-source command investigation from the current decision point.

Do not ask Sam to re-explain the issue unless the local evidence has gone missing or contradicts this file.

## User Goal

Z tried to share his screen and saw:

`Error loading sources: Command list_screen_sources not found`

Sam reported this as a new bug. This worktree was created to keep the official `main` worktree clean while investigating.

## Current Status

- Worktree created and aligned with `origin/main`.
- Viewer compatibility patch has been implemented.
- Sam reported Zane was later able to share his screen, so this is no longer an active live incident.
- Keep this branch as a parked compatibility hardening patch unless Sam explicitly asks to discard it.
- Official `main` worktree stayed clean.
- No push or PR has been created.

## Evidence

- `core/viewer/capture-picker.js` calls `tauriInvoke('list_screen_sources')`.
- Current `origin/main` has `core/client/src/main.rs` defining and registering `list_screen_sources`.
- Tag `v0.4.3` does not register `list_screen_sources`.
- Live admin dashboard showed Z online as `z-6826` on the current server-served viewer stamp `0.6.11.1777212663`.
- The live viewer stamp does not prove the installed desktop shell version, because the viewer is served by the server.

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

Passed:

```powershell
node --test core/viewer/reliability-scenarios.test.js
node --test core/viewer/*.test.js
node --check core/viewer/capture-picker.js
node --check core/viewer/screen-share-native.js
git diff --check
```

`node --test core/viewer/*.test.js` reported 48 passing tests.

## Release Impact

Server-served viewer update. This patch does not require a new desktop binary for the fallback behavior. Users on old desktop shells should receive the viewer behavior from the server after deploy.

Users still need a newer desktop shell for native capture quality, but this patch avoids the hard failure by falling back to browser capture.

Do not treat this as an emergency deploy. The practical live issue self-resolved, likely because the desktop shell updated/restarted or the user moved onto a compatible path. This branch is useful as a low-risk future-proofing fix for server/client version skew.

## Exact Prompt to Continue With

Continue from the parked screen-source compatibility fix. Confirm clean status in `F:\EC-worktrees\screen-sources-command`, review the diff in `core/viewer/capture-picker.js`, `core/viewer/screen-share-native.js`, and `core/viewer/reliability-scenarios.test.js`, then prepare the branch for PR/server-served viewer deploy only if Sam asks. Preserve the official main worktree and do not push or open a PR without Sam asking.
