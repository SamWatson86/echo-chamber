# Viewer Next parity evidence — 2026-02-24T20-41-19

## Scope
- Verify `viewer-next` preserves visible parity by loading legacy viewer runtime unchanged.
- Verify Playwright executes login/connect flow and captures parity screenshots.

## Verification commands and results

### 1) Unit/component tests
`cd core/viewer-next && npm run test`

Result: **pass** (3 files, 5 tests).

### 2) Production build
`cd core/viewer-next && npm run build`

Result: **pass** (Vite build successful).

### 3) Dev server startup
`cd core/viewer-next && npm run dev -- --host 127.0.0.1 --port 4174 --strictPort`

Result: **pass**
- VITE ready
- Local URL: `http://127.0.0.1:4174/`

### 4) Playwright e2e
`cd core/viewer-next && PARITY_EVIDENCE_STAMP=2026-02-24T20-41-19 npm run test:e2e`

Result: **pass** (2 tests)
- loads legacy viewer in parity frame
- executes login flow and captures parity screenshots

## Screenshot artifacts
- `docs/proof/parity/2026-02-24T20-41-19-viewer-next-parity-pre-login.png`
- `docs/proof/parity/2026-02-24T20-41-19-viewer-next-parity-post-login.png`

## Notes
- Parity remains strict iframe-based legacy runtime, preserving 1:1 user-visible behavior.
- Login/connect e2e remains deterministic via test-time LiveKit/API mocks.
