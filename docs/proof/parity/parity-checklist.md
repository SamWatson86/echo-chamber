# React Parity Checklist (PR #58)

Last updated: 2026-02-24 22:18 ET
Branch: `feat/react-tailwind-viewer-foundation`

> Truth status: **NOT DONE**. This checklist tracks progress; hard requirements are not yet fully met.

## Legend
- ✅ Implemented in `core/viewer-next`
- 🟡 Partial/in-progress in `core/viewer-next`
- ❌ Not yet ported

## Legacy -> React feature map

| Legacy source area | Legacy behavior | React parity status | Notes / evidence |
|---|---|---:|---|
| `index.html` connect panel | Control URL / SFU URL / name / password / connect-disconnect | ✅ | React shell now uses legacy IDs/classes and same labels/buttons. |
| `app.js` auth/token provisioning | `/v1/auth/login` + `/v1/auth/token` connection flow | ✅ | Existing XState machine still drives provisioning. |
| `app.js` publish controls | Enable Mic / Camera / Screen buttons | 🟡 | React now calls LiveKit `setMicrophoneEnabled`, `setCameraEnabled`, `setScreenShareEnabled`; recovery/reconcile parity still missing. |
| `app.js` device controls | Mic/cam/speaker selectors + refresh | 🟡 | Device enumeration + mic/cam switch + output sink selection wired; advanced native/noise-cancel paths still missing. |
| `app.js` online users | `/api/online` polling and pills | ✅ | Polling hook added in React; rendered in connect card. |
| `app.js` room list | Fixed rooms + participant counts + tooltip names | ✅ | `/v1/room-status` polling + active-room switching + tooltips. |
| `app.js` screen grid | Screen share tile attach/recover/watch logic | 🟡 | LiveKit screen tracks now attach/render in React tiles; watchdog/recovery/keyframe logic still missing. |
| `app.js` active user cards | Avatar/video tiles + indicators + per-user controls | 🟡 | LiveKit participant media/speaking indicators now render; per-user volume/chime/admin actions incomplete. |
| `app.js` chat panel | Open/close, send, emoji picker, uploads, data-channel sync | 🟡 | LiveKit data-channel send/receive + server history/upload persistence wired; delete/reaction/full media parity incomplete. |
| `app.js` soundboard compact/edit | Favorite quick-play + search + edit/upload + ordering | 🟡 | API-backed list/play/upload + favorites in React; icon picker, ordering, edit UX, full transport parity still missing. |
| `app.js` camera lobby | Lobby modal + mic/cam toggles + participant camera tiles | 🟡 | Lobby now renders live camera tracks and uses real mic/cam toggles; advanced lobby controls still partial. |
| `app.js` theme system | Theme panel + apply theme + UI transparency slider | ✅ | Dataset theme + opacity slider + local persistence ported. |
| `jam.js` jam panel | Spotify connect/start/join/leave/search/queue/audio stream | 🟡 | React now wires jam APIs (state/poll/search/queue/start/stop/join/leave/spotify auth) + WS audio stream; still needs deeper parity validation. |
| `app.js` bug report | Bug modal + screenshot + submit | 🟡 | React now posts to `/api/bug-report` with optional screenshot upload; native stats capture + admin bug workflows still partial. |
| `app.js` debug panel | open/copy/clear debug logs | ✅ | Panel + copy/clear/close actions ported. |
| `app.js` admin dashboards | Admin tabs, metrics, history, bug moderation | ❌ | Placeholder only. |
| `app.js` reconnect/session/media reliability | reconcile loops, watchdogs, track recovery, RNNoise, native capture | ❌ | Not yet ported to React runtime. |
| legacy runtime removal requirement | React as active runtime with no iframe/legacy embed | 🟡 | React UI is active for viewer-next dev flow; legacy runtime still primary for full functionality. |

## Verification artifacts (latest run)

- Behavior JSON: `docs/proof/parity/2026-02-25T03-16-27-599Z-behavior.json`
- Screenshots:
  - `docs/proof/parity/2026-02-25T03-16-27-599Z-01-connected-shell.png`
  - `docs/proof/parity/2026-02-25T03-16-27-599Z-02-chat-open.png`
  - `docs/proof/parity/2026-02-25T03-16-27-599Z-03-theme-open.png`

## Required command run status (this run)

- `npm run test` ✅
- `npm run build` ✅
- `npm run dev -- --host 127.0.0.1 --port 4174 --strictPort` ✅
- `npm run test:e2e` ✅

## Hard requirements status

1. React app is active implementation of legacy behavior: **Not yet** (partial).
2. No visible UI/UX drift vs legacy: **Not yet** (major parity shell done, detailed drift remains).
3. No functional drift vs legacy: **Not yet**.
4. No legacy iframe/runtime as active app: **Not yet** at full-product level.
5. Dev server + Playwright login/core journeys with screenshot artifacts: **Met for mocked React journey proof**.
