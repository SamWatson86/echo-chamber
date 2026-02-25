# Viewer Next parity evidence — 2026-02-24T20-36-09

## Scope
- Verify `viewer-next` preserves visible parity by loading legacy viewer runtime unchanged.
- Verify login/connect flow succeeds in Playwright with deterministic mocks.

## Verification commands and results

### 1) Unit/component tests
```bash
cd core/viewer-next
npm run test
```
Result: **pass** (3 files, 5 tests).

### 2) Production build
```bash
cd core/viewer-next
npm run build
```
Result: **pass** (`vite build` complete, dist emitted).

### 3) Dev server startup
```bash
cd core/viewer-next
npm run dev -- --host 127.0.0.1 --port 4174 --strictPort
```
Result: **pass**
- `VITE v5.4.21 ready`
- Local URL: `http://127.0.0.1:4174/`

### 4) Playwright e2e
```bash
cd core/viewer-next
PARITY_EVIDENCE_STAMP=2026-02-24T20-36-09 npm run test:e2e
```
Result: **pass** (2 tests)
- `loads legacy viewer in parity frame`
- `executes login flow and captures parity screenshots`

## Screenshot artifacts
- `docs/proof/parity/2026-02-24T20-36-09-viewer-next-parity-pre-login.png`
- `docs/proof/parity/2026-02-24T20-36-09-viewer-next-parity-post-login.png`

## Notes
- E2E now includes deterministic mock wiring for LiveKit + API endpoints to validate login/connect flow without environment-specific backend dependencies.
- Parity remains iframe-based legacy runtime (no user-visible drift introduced).
