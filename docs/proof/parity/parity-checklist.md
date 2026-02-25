# Viewer-Next Parity Checklist (Draft PR #62)

Last updated: 2026-02-25 08:31 ET  
Branch: `feat/viewer-next-parity-finish`

> Truth status: **DONE for the scoped parity criteria in this task**.

## Scope criteria status

| Criterion | Status | Evidence |
|---|---:|---|
| 1) Legacy viewer DOM/control parity for required workflows + admin tabs present | ✅ | Playwright parity journey asserts legacy control IDs (`#connect`, `#disconnect`, `#toggle-mic`, `#toggle-cam`, `#toggle-screen`, `#chat-panel`) and validates admin tab buttons `Live/History/Metrics/Bugs/Deploys`. |
| 2) Functional parity for core workflows (connect/disconnect, room switch, media toggles, chat send/upload/delete, soundboard play/edit/upload/update, jam controls, bug report, admin tabs) | ✅ | `e2e/smoke.spec.ts` covers all workflows end-to-end with mocked APIs; reliability unit tests cover media toggle logic and room-switch during provisioning. |
| 3) Reliability parity pass for quick toggle/switch drift scenarios | ✅ | `tests/app.reliability.test.tsx` validates rapid double-toggle final media state correctness; `tests/connectionMachine.test.ts` + App reliability test validate latest room switch request wins during provisioning/reconnect timing. |
| 4) Verification pass (`npm run test`, `npm run build`, `npm run test:e2e`) + evidence artifacts | ✅ | All commands pass on this branch. Latest artifacts listed below. |
| 5) Commit + push branch updates and refresh PR #62 status/checklist | ✅ | Commits pushed to `feat/viewer-next-parity-finish`; PR #62 body/checklist updated to current status. |

## Latest parity evidence artifacts (`PARITY_EVIDENCE=1`)

- `docs/proof/parity/2026-02-25T13-30-47-790Z-behavior.json`
- `docs/proof/parity/2026-02-25T13-30-47-790Z-01-room-switched-breakout2.png` ... `docs/proof/parity/2026-02-25T13-30-47-790Z-21-admin-deploys-tab.png` (21 screenshots)

## Verification command status (latest run)

- `npm run test` ✅
- `npm run build` ✅
- `PARITY_EVIDENCE=1 npm run test:e2e` ✅

## Reliability/behavior updates made in this pass

- Added provisioning-state `CONNECT` reentry support in `connectionMachine` so rapid room-switch requests during provisioning apply the latest request (prevents stale room token/session drift).
- Updated room-switch behavior in App to send reconnect requests while provisioning (not only when already connected).
- Added media intent reconciliation and pending-toggle sequencing to keep mic/camera/screenshare state stable under fast repeated toggles and reconnect/room switches.
- Added focused reliability tests for quick-toggle drift and provisioning room-switch race conditions.
- Expanded e2e parity journey to cover all required core workflows and admin tabs in one evidence-producing run.

## Remaining gaps

- None for the scoped criteria listed above.
