# Start Here

If Sam starts a new Codex thread for Echo Chamber and says `continue`, read:

1. `AGENTS.md`
2. `docs/OPERATIONS.md`
3. `docs/RELEASE-BOUNDARIES.md`
4. the latest relevant file in `docs/handovers/` only if Sam names a parked workstream or bug

Then run the Echo preflight from `docs/OPERATIONS.md` before claiming the machine is ready, before release work, or before live troubleshooting.

Current production baseline after the v0.6.13 screen-share/Jam release:

- Main repo path: `F:\EC-worktrees\main`
- Production branch: `main`
- Expected live version: `0.6.13`
- Production startup owner: `EchoCoreHost` Windows service
- Production control child should launch from `F:\EC-worktrees\main\core\target\release\echo-core-control.exe`

Operational reminders:

- Do not assume a running process came from the repo being edited; verify service config, host log, `/api/version`, and `/health`.
- Do not push, deploy, open a PR, delete a worktree, reload SAM-PC, or restart shared services unless Sam explicitly asks.
- Tell Sam before closing/reopening his local Echo client. For desktop-client tests, always close and reopen so the tested version is unambiguous.
- Keep `F:\EC-worktrees\main` clean unless Sam explicitly asks for local docs/code changes there.
