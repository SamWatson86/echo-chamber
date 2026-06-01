# Echo Chamber

Self-hosted, password-protected, real-time rooms for microphone, screen sharing,
Jam audio, and desktop-client integrations.

## Current Project Shape

Active product development lives in `core/`:

- `core/control/` - Rust control plane, APIs, auth, room state, and viewer
  serving.
- `core/viewer/` - production browser UI served from `/viewer/`.
- `core/client/` - Windows Tauri desktop shell, updater, and native capture /
  audio integrations.
- `core/sfu/` and `core/turn/` - media transport infrastructure.
- `core/deploy/` - local Windows release tooling.

The old root npm/Electron workspace (`apps/server`, `apps/desktop`) is retired.
Do not use old `apps/*` instructions or scripts as a starting point.

## Start Here

- `AGENTS.md` - repo guardrails for Codex and other agents.
- `docs/INDEX.md` - documentation index.
- `docs/ARCHITECTURE.md` - system boundaries and runtime surfaces.
- `docs/RELEASE-BOUNDARIES.md` - server-only vs desktop-binary release rules.
- `docs/OPERATIONS.md` - production service, restart, and preflight rules.
- `docs/TESTING.md` - verification model.
- `docs/GITHUB.md` - PR and release conventions.

## Local Development

For the active Core stack, work from `core/` and use the docs above for the
specific task. Do not infer production state from a local process; verify the
running service and `/api/version` before live troubleshooting.

Common lightweight checks:

```powershell
bash tools/verify/quick.sh
bash tools/verify/extended.sh
```

## Releases

Echo Chamber is Windows-only unless Sam explicitly asks otherwise. Normal
desktop releases are built and published locally from Sam's PC:

```powershell
powershell -ExecutionPolicy Bypass -File core\deploy\publish-local-release.ps1
```

GitHub Actions should not build installers or macOS artifacts for normal
release work.
