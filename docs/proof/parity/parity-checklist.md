# Viewer-Next Parity Checklist (PR #62)

Last updated: 2026-02-25 17:31 ET  
Branch: `feat/viewer-next-parity-finish`

> Truth status: **COMPLETE for the previously explicit 6 media/quality gaps plus the newly confirmed 5 parity gaps below** (implemented in `core/viewer-next` only, with tests and validation runs listed).

## Scope criteria status

| Criterion | Status | Evidence |
|---|---:|---|
| Legacy shell/workflow parity remains intact | ✅ | `e2e/smoke.spec.ts` passed in both normal and `PARITY_EVIDENCE=1` runs. |
| New parity gap closure (5 confirmed items) implemented in viewer-next | ✅ | App + media modules updated; focused tests added (see matrix below). |
| Full verification pass (`test`, `build`, `test:e2e`, `PARITY_EVIDENCE=1 test:e2e`) | ✅ | All commands passed on this branch (latest command log below). |
| Branch updates + checklist refresh | ✅ | This checklist updated in same branch push. |

## Newly confirmed parity gaps (this update)

| Gap | Status | Implementation | Test evidence |
|---|---:|---|---|
| 1) Remote soundboard playback parity (`sound-play` + `soundboard-play`) | ✅ | `src/app/App.tsx` now parses both message types, resolves sound id/name, plays remote clip via WebAudio (`playSoundById`), preserves sender metadata for hint text, and dual-broadcasts both wire formats for mixed-client compatibility. Helpers in `src/features/media/soundboardParity.ts`. | `tests/media.soundboardParity.test.ts` |
| 2) `device-id` data-message compatibility for device-profile/chime mapping | ✅ | `src/app/App.tsx` now broadcasts local `device-id` on connect/participant join and connected-state refresh; consumes incoming `device-id` to map `identityBase -> deviceId`; chime lookups/prefetch now use mapped device IDs via `resolveChimeIdentity`. Helpers in `src/features/media/deviceProfileParity.ts`. | `tests/media.deviceProfileParity.test.ts` |
| 3) Preference key migration compatibility | ✅ | Added non-destructive legacy->current key migration at app boot: `echo-noise-cancel`, `echo-nc-level`, `echo-volume-prefs`, `echo-core-soundboard-clip-volume`, `echo-soundboard-order` into current keys. Also wired current clip-volume/order reads in App. Migration helper: `src/features/media/legacyPreferenceMigration.ts`. | `tests/media.legacyPreferenceMigration.test.ts` |
| 4) SDP/codec hint parity path with guardrails | ✅ | Added safe SDP hint munging + guarded PC method patching (`createOffer`, `setLocalDescription`, `setRemoteDescription`) for bitrate hints and H264 profile/level handling parity behavior with bounds/guards in `src/features/media/sdpCodecHintParity.ts`; installed at app boot. | `tests/media.sdpCodecHintParity.test.ts` |
| 5) Black-frame camera recovery parity | ✅ | Added camera stall/black-frame detection + throttled keyframe/resubscribe recovery monitor (`CameraRecoveryMonitor`) and wired it to remote camera tiles in App (`attachCameraRecovery`/`detachCameraRecovery`). Includes cooldown/attempt safeguards. | `tests/media.cameraRecoveryParity.test.ts` |

## Prior explicit media/quality gaps (already complete, still passing)

| Legacy capability | Status | Primary implementation | Test evidence |
|---|---:|---|---|
| Canvas screen-share pipeline semantics | ✅ | `src/features/media/screenShareParity.ts` + App screen-share flow | `tests/media.screenShareParity.test.ts` |
| Receiver AIMD + publisher bitrate-cap handling | ✅ | `src/features/media/aimdBitrateControl.ts` + App datachannel/stats loop | `tests/media.aimdParity.test.ts` |
| BWE watchdog/rescue behavior | ✅ | `src/features/media/bweWatchdog.ts` + App watchdog integration | `tests/media.bweParity.test.ts` |
| RNNoise mic noise-cancel path | ✅ | `src/features/media/rnnoiseParity.ts` + App settings/toggle/replaceTrack | `tests/media.rnnoiseParity.test.ts` |
| Participant volume boost gain pipeline (>100%) | ✅ | `src/features/media/participantVolumeBoost.ts` + App participant volume controls | `tests/media.volumeBoostParity.test.ts` |
| Explicit screen-share audio publish tuning parity | ✅ | `SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS` + App publish path | `tests/media.screenShareParity.test.ts` |

## Latest parity evidence artifacts (`PARITY_EVIDENCE=1`)

- `docs/proof/parity/2026-02-25T22-30-04-735Z-behavior.json`
- `docs/proof/parity/2026-02-25T22-30-04-735Z-01-room-switched-breakout2.png` … `docs/proof/parity/2026-02-25T22-30-04-735Z-21-admin-deploys-tab.png` (21 screenshots)

## Verification command status (latest run)

- `npm run test` ✅
- `npm run build` ✅
- `npm run test:e2e` ✅
- `PARITY_EVIDENCE=1 npm run test:e2e` ✅

## Notes

- All parity updates were implemented in `core/viewer-next` only (legacy viewer untouched).
- No merge/close/revert actions performed; branch remains `feat/viewer-next-parity-finish`.
