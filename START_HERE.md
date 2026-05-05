# Start Here

If Sam starts a new Codex thread in this worktree and says `continue`, read:

1. `AGENTS.md`
2. `docs/handovers/2026-05-02-screen-sources-command.md`

Then continue from the handover's **Exact Prompt to Continue With** section.

This worktree is for the screen sharing source-list bug:

- Path: `F:\EC-worktrees\screen-sources-command`
- Branch: `codex/screen-sources-command-investigation`
- Local commit: `e4c25e0 Add fallback for missing native screen source command`
- Status: parked local compatibility fix; not pushed; no PR opened.
- Official `main` worktree should remain clean.

Important context:

- Sam reported Zane later became able to share his screen, so this is not an active live emergency.
- The branch still contains a real server/client compatibility fallback for older desktop shells missing `list_screen_sources`.
- Zane's separate missing-avatar issue was fixed live without a server restart by registering the existing `zane` avatar under the current `z` identity. That avatar fix is server state only; it is not part of this branch's code diff.
- In Codex Desktop, do not try to switch the `Echo Chamber - Main` project to this branch. Open this folder as its own Project instead, because this branch is already checked out by this worktree.

If Sam asks to "start the work", confirm the worktree and branch, review the handover, and wait for a specific instruction before pushing, opening a PR, deploying, or deleting the branch.
