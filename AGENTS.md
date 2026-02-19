# AGENTS

## Scope
Echo Chamber is a self-hosted real-time communication app. In this repo, active product development is centered in `core/`.

## Where to work
- `core/control/` — Rust control plane (API/auth/room state, serves viewer)
- `core/viewer/` — browser UI/state transitions/media UX
- `core/client/` — Tauri desktop shell/updater/native integrations
- `core/sfu/`, `core/turn/` — media transport infrastructure
- `docs/` — project operating docs and decision records

## Core guardrails
- PRs only. Never push directly to `main`/`master`.
- Prefer small, focused diffs over broad rewrites.
- Keep release impact explicit: server-only vs desktop-binary vs both.
- Avoid one-off patterns; prefer conventional, maintainable approaches.

## Quality expectations
- Any user-facing behavior change should include verification evidence.
- Add or update regression coverage when touching state/race-prone paths.
- Update docs when behavior or boundaries change.

## Key context
Use `docs/RELEASE-BOUNDARIES.md` and `docs/TERMINOLOGY.md` to avoid server/client/binary confusion when planning or describing changes.
