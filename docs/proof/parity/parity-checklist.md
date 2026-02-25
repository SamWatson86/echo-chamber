# Viewer-Next Parity Checklist (PR #62)

Last updated: 2026-02-25 17:01 ET  
Branch: `feat/viewer-next-parity-finish`

> Truth status: **COMPLETE for the previously explicit 6 legacy media/quality parity gaps** (implemented in `core/viewer-next`, with tests and verification runs below).

## Scope criteria status

| Criterion | Status | Evidence |
|---|---:|---|
| 1) Legacy viewer DOM/control parity for required workflows + admin tabs present | ✅ | `e2e/smoke.spec.ts` validates legacy control IDs and admin tabs (`Live/History/Metrics/Bugs/Deploys`). |
| 2) Functional parity for core workflows (connect/disconnect, room switch, media toggles, chat send/upload/delete, soundboard play/edit/upload/update, jam controls, bug report, admin tabs) | ✅ | End-to-end flow validated in `npm run test:e2e` and `PARITY_EVIDENCE=1 npm run test:e2e`. |
| 3) Reliability parity pass for quick toggle/switch drift scenarios | ✅ | `tests/app.reliability.test.tsx` + `tests/connectionMachine.test.ts`. |
| 4) Verification pass (`npm run test`, `npm run build`, `npm run test:e2e`) + evidence artifacts | ✅ | All commands pass (see command log below). |
| 5) Commit + push branch updates and refresh PR #62 status/checklist | ✅ | This checklist + PR body updated in the same push. |

## Legacy media/quality pipeline parity (6 explicit gaps)

| Legacy capability | Status in `viewer-next` | Primary implementation | Test evidence |
|---|---:|---|---|
| 1) Canvas screen-share pipeline (`canvas-pipe`) semantics | ✅ | `src/features/media/screenShareParity.ts` + App manual screen-share path in `src/app/App.tsx` (`createCanvasScreenSharePipeline`, capped resolution, canvas capture publish) | `tests/media.screenShareParity.test.ts` |
| 2) Receiver-side AIMD + publisher bitrate-cap handling | ✅ | `src/features/media/aimdBitrateControl.ts` + App datachannel handling (`bitrate-cap`, `bitrate-cap-ack`) + stats loop in `App.tsx` | `tests/media.aimdParity.test.ts` |
| 3) BWE watchdog/rescue behavior | ✅ | `src/features/media/bweWatchdog.ts` + outbound sender stats watchdog/rescue actions in `App.tsx` | `tests/media.bweParity.test.ts` |
| 4) RNNoise mic noise-cancel path | ✅ | `src/features/media/rnnoiseParity.ts` + App settings/toggle path + sender replaceTrack/restore flow | `tests/media.rnnoiseParity.test.ts` |
| 5) Participant volume boost gain pipeline (>100%) | ✅ | `src/features/media/participantVolumeBoost.ts` + App participant volume controls + audio-bucket binding | `tests/media.volumeBoostParity.test.ts` |
| 6) Explicit screen-share audio publish tuning parity (`dtx`/bitrate behavior) | ✅ | `SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS` (`dtx: false`, `red: false`, `audioBitrate: 128000`) in `screenShareParity.ts` and publish path in `App.tsx` | `tests/media.screenShareParity.test.ts` |

## Latest parity evidence artifacts (`PARITY_EVIDENCE=1`)

- `docs/proof/parity/2026-02-25T22-02-34-532Z-behavior.json`
- `docs/proof/parity/2026-02-25T22-02-34-532Z-01-room-switched-breakout2.png` ... `docs/proof/parity/2026-02-25T22-02-34-532Z-21-admin-deploys-tab.png` (21 screenshots)

## Verification command status (latest run on this branch)

- `npm run test` ✅
- `npm run build` ✅
- `npm run test:e2e` ✅
- `PARITY_EVIDENCE=1 npm run test:e2e` ✅

## Notes

- The parity implementations above are in `viewer-next` only (legacy untouched).
- Existing reliability/e2e checks were kept green and extended with focused parity unit coverage for the 6 explicit gaps.
