# Validation & Verification

This repo uses a two-tier verification model so we can move fast without
flooding reviewers with low-confidence PRs.

## Quick Verification

Required for every PR:

```bash
bash tools/verify/quick.sh
```

What it does:

- JS syntax checks for viewer files
- deterministic JS state tests with `node --test core/viewer/*.test.js`
- Rust compile check for the control plane with
  `cargo check -p echo-core-control`
- optional Rust formatting check when `VERIFY_RUN_FMT=1`

CI equivalent:

- `PR Verification (Quick)` workflow (`.github/workflows/pr-verify-quick.yml`)

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
