# Validation & Verification

This repo uses a two-tier verification model so we can move fast without
flooding reviewers with low-confidence PRs.

## Quick Verification

Required for every PR:

```bash
bash tools/verify/quick.sh
```

What it does:

- repo guardrail checks for release/workflow and archived capture boundaries
- JS syntax checks for viewer files
- deterministic JS state tests with `node --test core/viewer/*.test.js`
- Rust compile check for the control plane with
  `cargo check -p echo-core-control`
- optional Rust formatting check when `VERIFY_RUN_FMT=1`

CI equivalent:

- `PR Verification (Quick)` workflow (`.github/workflows/pr-verify-quick.yml`)

## Viewer Layout Verification

Required for connected-shell, participant-card, screen-grid, panel, dock, or
responsive CSS changes:

```bash
npm --prefix core/viewer-tests ci
npm --prefix core/viewer-tests run browser:install
npm run verify:viewer:layout
```

The tests load the production `core/viewer/index.html`, inject deterministic
room scenarios through production participant/screen renderers, and establish
desktop geometry and resize-state baselines. Legacy narrow-layout failures run
as exact bad-geometry sentinels under `?echo-ui-shell-v2=0`; separate positive
V2 assertions prove that the Clubhouse shell fixes the same geometry without
removing rollback coverage. The suite is deliberately outside `core/viewer/`,
so its dependencies and fixtures are never copied into the served viewer
snapshot.

Phase 1 exercises the production-loaded layout policy and mode controller. Its
browser coverage verifies rollout-flag precedence and first-frame selection,
hysteresis, canonical region uniqueness, media/track/state identity across
resize and live variant changes, usable geometry down to `360x640`, long-name
ellipsis, non-overlapping camera cards, popup hit testing, keyboard focus
restoration, accessible control names, and legacy rollback behavior.

CI equivalent:

- path-filtered `PR Viewer Layout` workflow
  (`.github/workflows/pr-viewer-layout.yml`)

Chromium geometry coverage does not replace the Windows WebView2 smoke required
before a UI release.

## Extended Verification

Recommended for risky fixes:

```bash
bash tools/verify/extended.sh
```

What it adds:

- Rust clippy with `-D warnings` for the control plane
- Rust tests for the control plane

CI equivalent:

- `Verification (Extended Manual)` workflow
  (`.github/workflows/verify-extended.yml`)
- `CI - Core Checks` manual Windows workflow (`.github/workflows/ci.yml`)

## Branching And Merge Policy

- Never push directly to `main`/`master`.
- Always use feature branch plus PR.
- Require human approval before merge.
- Prefer PRs with concrete repro and before/after evidence.

## Reliability Coverage Map

The quick suite covers these user-facing reliability clusters:

- Room/session transitions and race behavior:
  `core/viewer/room-switch-state.test.js` and
  `core/viewer/reliability-scenarios.test.js`
- Jam lifecycle and reconnect behavior:
  `core/viewer/jam-session-state.test.js` and
  `core/viewer/reliability-scenarios.test.js`
- Publish-state truth vs actual publication:
  `core/viewer/publish-state-reconcile.test.js` and
  `core/viewer/reliability-scenarios.test.js`

## Cost-Aware CI Usage

This project is private/friend-group scale, so CI is intentionally lean:

- Quick checks run on PRs.
- Heavy verification remains manually invoked.
- Installer builds are local Windows release operations, not normal GitHub
  Actions jobs.
- macOS release jobs stay absent unless Sam explicitly asks for them.
