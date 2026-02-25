# Viewer Next (React refactor foundation)

This directory is the staged frontend migration for Echo Chamber.

## Stack

- React 18 + TypeScript + Vite
- Tailwind CSS
- XState (real-time workflow/state-machine orchestration)
- Zustand (lightweight client/UI state)
- TanStack Query (server-state queries + caching)
- Vitest + Testing Library (unit/component tests)
- Playwright (browser smoke/e2e)

## Why this exists

The current viewer (`core/viewer/app.js`) has grown into a large, real-time, stateful codebase.
This refactor introduces framework structure without forcing a risky big-bang cutover.

## Current scope in this PR

- Functional connection workflow machine for auth + room-token provisioning (`connectionMachine.ts`)
- Zustand-backed viewer preferences store (ready for persistence middleware)
- React shell now mirrors legacy viewer DOM layout/classes (connect panel, room list, side panels, chat/soundboard/theme/jam/debug modals)
- Room-status and online-user polling hooks (`/v1/room-status`, `/api/online`)
- Playwright mocked journey for login + core shell interactions with screenshot evidence output to `docs/proof/parity/`
- Baseline test harness (Vitest + Playwright)

## Not migrated yet

- Full LiveKit media/session lifecycle (track subscribe/publish/reconcile/recovery)
- Jam subsystem functional Spotify/audio runtime wiring
- Chat/media transport parity over LiveKit data channels + file upload persistence
- Soundboard upload/edit persistence and playback transport parity
- Admin dashboard feature parity

## Run locally

```bash
cd core/viewer-next
npm install
npm run dev
```

## Tests

```bash
npm test
npx playwright install   # one-time browser install
npm run test:e2e
```

## Migration plan (high-level)

1. Land foundation and CI (this PR)
2. Port connection + participant/session rendering with parity checks
3. Port jam and publish/reconcile paths behind feature flag
4. Flip default viewer route when parity + reliability checks pass
