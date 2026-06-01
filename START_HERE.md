# Start Here

This file is a repo orientation checkpoint only. It is not a session handover,
and it must not override the current user request, `AGENTS.md`, or the docs
under `docs/`.

## Current Baseline

- Current good live baseline: Echo Chamber v0.6.28.
- Active production branch: `main`, changed through PRs only.
- Active product code lives under `core/`.
- Normal desktop releases are Windows-only and are published locally from Sam's
  PC with `core/deploy/publish-local-release.ps1` after the release commit has
  landed on `main`.
- GitHub Actions should not build installers or macOS artifacts unless Sam
  explicitly asks for a one-off emergency path.

## Start A New Thread

If Sam starts a new Codex thread for Echo Chamber, read these first:

1. `AGENTS.md`
2. `docs/INDEX.md`
3. `docs/CODEX.md`
4. `docs/ARCHITECTURE.md`
5. `docs/RELEASE-BOUNDARIES.md`
6. `docs/OPERATIONS.md`
7. `docs/TESTING.md`

Only read `docs/handovers/` if Sam names a parked workstream or bug. Historical
plans and handovers are evidence, not current instructions.

Codex operating rule: **Echo Chamber - Main** is the canonical project. For real
bugs, start a new thread there and use a new worktree branch from `main` if code
may change. Do not create another Echo project unless Sam explicitly asks.

## Active Runtime Areas

- `core/control/` - Rust control plane, API/auth/room state, viewer serving.
- `core/viewer/` - production browser UI served from `/viewer/`.
- `core/client/` - Tauri desktop shell, updater, and native integrations.
- `core/sfu/`, `core/turn/` - media transport infrastructure.
- `docs/` - operating docs and decision records.

## Do Not Start From These

- Root `apps/*` / old npm workspace references are retired.
- `core/viewer-next/` is a staged refactor area, not the served production UI.
- `core/client/src/archive/` and `core/hook/` contain abandoned capture
  experiments. Do not copy or revive those patterns unless Sam explicitly asks
  for a fresh design.
- `docs/plans/`, `docs/handovers/`, and `docs/superpowers/` can contain stale
  historical instructions. Treat them as dated context only.

## Operational Reminders

- Do not assume a running process came from the repo being edited; verify
  service config, host log, `/api/version`, and `/health`.
- Do not deploy, release, reload SAM-PC, restart shared services, or close and
  reopen Sam's local Echo client unless Sam explicitly asks.
- Run the Echo preflight from `docs/OPERATIONS.md` before release work, reboot
  validation, or live troubleshooting.
