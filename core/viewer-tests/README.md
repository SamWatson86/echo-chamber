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

Phase 0 injects `layout-policy.js` explicitly because the production
`index.html` does not load a mode controller yet. Phase 1 must wire the policy
before first paint and replace that injected-policy check with an assertion on
the production root's live `data-ui-mode` value.

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
run as narrowly scoped sentinels. They assert the exact current bad geometry
(collapsed participant viewport or zero-width stage), so unrelated runtime or
browser failures still fail the suite. When Clubhouse corrects that geometry,
the sentinel fails and must be replaced by the corresponding positive contract
assertion. That conversion is a rollout gate, not an optional cleanup.
