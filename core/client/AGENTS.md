# AGENTS

## Scope
Tauri desktop client and native integrations.

## Priorities
- Keep native shell behavior stable (window lifecycle, updater, IPC, OS integration).
- Maintain clear boundary between server-served viewer behavior and binary-required native behavior.

## Change rules
- Any updater/IPC/native shell change should be flagged as likely desktop-binary impact.
- Keep platform-specific behavior explicit (Windows/macOS differences).
- Avoid coupling native logic to fragile UI assumptions; use stable interfaces.
