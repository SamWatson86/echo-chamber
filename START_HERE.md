# Start Here

## Active Handover

If Sam says `continue` in this worktree, load `docs/handovers/2026-05-13-jam-audio-silence.md` first. This worktree is for the broader Echo audio silence bug where Jam Spotify capture and native screen-share audio can both produce silent process-loopback frames.

Current active fix lane:

- Worktree: `F:\EC-worktrees\jam-audio-silence`
- Branch: `codex/jam-audio-silence-investigation`
- Status: control, desktop client, and admin-client process-loopback fallback code patched; targeted tests passed; not deployed live.
- Deployment boundary: server/control restart plus desktop/admin client rebuild/relaunch required to test live, so ask Sam before deploying, restarting shared services, or closing/reopening Sam's local Echo client.

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
