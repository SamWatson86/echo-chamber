# Validation & Verification

This repo uses a two-tier verification model so we can move fast without flooding reviewers with low-confidence PRs.

## 1) Quick verification (required for every PR)
Run locally:

```bash
bash tools/verify/quick.sh
```

What it does:
- JS syntax check for viewer files
- Deterministic JS state tests (`node --test core/viewer/room-switch-state.test.js`)
- Rust compile check for control plane (`cargo check -p echo-core-control`)
- (Optional) Rust formatting check when enabled (`VERIFY_RUN_FMT=1`)

CI equivalent:
- **PR Verification (Quick)** workflow (`.github/workflows/pr-verify-quick.yml`)

## 2) Extended verification (recommended for risky fixes)
Run locally:

```bash
bash tools/verify/extended.sh
```

What it adds:
- Rust clippy (`-D warnings`) for control plane
- Rust tests for control plane

CI equivalent:
- **Verification (Extended Manual)** workflow (`.github/workflows/verify-extended.yml`)

## Branching and merge policy
- Never push directly to `main`/`master`
- Always use feature branch + PR
- Require human approval before merge
- Prefer PRs with concrete repro + before/after evidence

## Cost-aware CI usage
This project is private/friend-group scale, so CI is intentionally lean:
- Quick checks run on PRs
- Heavy verification remains manually invoked
- Installer builds (EXE/DMG) stay manual/tag-driven only when needed
