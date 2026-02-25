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

## Parity strategy (current)

To guarantee user-visible 1:1 behavior while refactoring, the current app runs in **parity mode**:

- `viewer-next` renders `core/viewer` (legacy app) inside a same-origin iframe
- legacy UI/UX and runtime behavior remain unchanged for end users
- new React/XState/Zustand/TanStack code remains in this package for incremental cutover

This keeps production behavior stable while allowing internal migration to progress safely.

## Current scope in this PR

- Full UI parity surface via embedded legacy viewer (`public/legacy/*`)
- Functional connection workflow machine for auth + room-token provisioning (`connectionMachine.ts`)
- Zustand-backed viewer preferences store
- Health polling and room listing via TanStack Query
- Baseline test harness (Vitest + Playwright)

## Not migrated yet (internal cutover pending)

- LiveKit media/session lifecycle is still owned by legacy `app.js`
- Jam subsystem still owned by legacy `jam.js`
- Chat/media/soundboard internals still owned by legacy code
- Admin dashboard parity still via legacy app runtime

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

### Capturing parity proof screenshots

The Playwright smoke suite includes a mocked login/connect flow test that writes screenshots into `docs/proof/parity/`.

```bash
PARITY_EVIDENCE_STAMP=$(date +%Y-%m-%dT%H-%M-%S) npm run test:e2e
```

## Migration plan (high-level)

1. Parity mode gate (this PR): no visual/behavior drift vs current viewer
2. Replace subsystems behind feature flags one-by-one (connection, participants, media, jam)
3. Expand parity tests for each subsystem before flipping ownership
4. Remove iframe + legacy runtime only after full parity validation
