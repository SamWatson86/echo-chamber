# AGENTS

## Scope
`core/` is the main product stack for Echo Chamber.

## Architecture intent
- `control` is the backend authority for auth, rooms, and API behavior.
- `viewer` is the user-facing web UI.
- `client` is the native Tauri shell.

## Operational rule of thumb
- Many viewer/control changes are server deploys.
- Native client/updater changes usually require desktop binary release.
- Keep this boundary explicit in PR descriptions.

## Working style
- Optimize for stability in room/media state transitions.
- Prefer deterministic, testable state logic over ad-hoc flow coupling.
- Keep code paths observable (clear logging around transition failures).
