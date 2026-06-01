# AGENTS

## Scope

Echo Chamber is a self-hosted real-time communication app. In this repo, active
product development is centered in `core/`.

## Where To Work

- `core/control/` - Rust control plane (API/auth/room state, serves viewer)
- `core/viewer/` - production browser UI/state transitions/media UX
- `core/client/` - Windows Tauri desktop shell/updater/native integrations
- `core/sfu/`, `core/turn/` - media transport infrastructure
- `core/deploy/` - local Windows release tooling
- `docs/` - project operating docs and decision records

## Do Not Start From These

- Root `apps/*` / old npm workspace references are retired.
- `core/viewer-next/` is a staged refactor area, not the served production UI.
- `core/client/src/archive/` and `core/hook/` contain abandoned capture
  experiments (NVFBC, Present-hook, injection-era work). Do not copy or revive
  those patterns unless Sam explicitly asks for a fresh design.
- `docs/plans/`, `docs/handovers/`, and `docs/superpowers/` are historical
  context. Treat them as dated evidence, not current instructions.

## Core Guardrails

- PRs only. Never push directly to `main`/`master`.
- Prefer small, focused diffs over broad rewrites.
- Keep release impact explicit: server-only vs desktop-binary vs both.
- Avoid one-off patterns; prefer conventional, maintainable approaches.
- Windows-only product/release reality: do not add or run macOS build/release
  work unless Sam explicitly asks.
- Normal Windows installer releases are local from Sam's PC; do not add or run
  GitHub-hosted installer builds unless Sam explicitly asks for an emergency
  fallback.
- Before release, reboot validation, or live troubleshooting, run the Echo
  preflight in `docs/OPERATIONS.md`.
- Do not assume the running server is from the repo you are editing. Verify
  `/api/version`, `/health`, `EchoCoreHost`, and
  `C:\ProgramData\Echo Chamber\echo-core-host.json`.
- Do not touch SAM-PC, reload remote clients, or restart shared services unless
  Sam asked for that specific action. Tell Sam before closing/reopening his
  local Echo client.

## Quality Expectations

- Any user-facing behavior change should include verification evidence.
- Add or update regression coverage when touching state/race-prone paths.
- Update docs when behavior or boundaries change.

## Key Context

Use `docs/RELEASE-BOUNDARIES.md` and `docs/TERMINOLOGY.md` to avoid
server/client/binary confusion when planning or describing changes.
Use `docs/OPERATIONS.md` for production service/restart rules and
`docs/GITHUB.md` for release verification.
