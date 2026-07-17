# Production Viewer Layout Tests

This package provides browser-level geometry coverage for the served
`core/viewer/` UI. It is intentionally a sibling of the viewer rather than a
child directory: Echo deploys every file under `core/viewer/`, while this test
package must never ship to users.

The harness:

- serves the real production HTML, CSS, JavaScript, and assets with caching off;
- injects deterministic participants and screen tiles through production
  renderer functions;
- checks layout policy and geometry without connecting to LiveKit; and
- retains traces and screenshots when a browser assertion fails.

It does not use `core/viewer-next/` and does not clone the production viewer
markup into a second test-only page.

Phase 1 exercises `layout-policy.js` and the shell controller through the real
production `index.html`. The suite verifies the pre-paint rollout flag,
production `data-ui-mode` wiring and hysteresis, stable media/feature nodes,
and positive V2 geometry without importing the policy out of band.

## Setup

```bash
npm ci
npm run browser:install
```

## Run

```bash
npm test
```

From the repository root, use `npm run verify:viewer:layout` after setup.

Known legacy failures at `960x540`, `640x480`, and narrow Chat execute on every
run under the explicit `?echo-ui-shell-v2=0` override. They retain the legacy
rollback baseline while separate V2 tests assert a usable participant region
and nonzero Chat-stage geometry at the same viewports.
