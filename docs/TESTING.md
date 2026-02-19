# Testing & Verification Strategy

Goal: make regressions hard and PR review lightweight by relying on automated verification.

## Philosophy

- Deterministic tests first (state machines, transition guards, reconcile logic).
- Integration checks for async/race-heavy user flows.
- Keep default checks cheap so they run on every PR.
- Keep deeper checks available for risky changes.

## Test layers

### Layer 1 — Quick PR checks (required)
- Syntax/lint/style basics
- Deterministic viewer state tests
- Fast compile/check steps

### Layer 2 — Extended checks (manual or scheduled)
- Broader test sets
- Slower integration scenarios
- Stress/race-focused checks

### Layer 3 — Release confidence checks (as needed)
- Smoke tests on release candidate builds
- Upgrade/update-path validation

## Regression priorities (current)

1. Room switch state consistency
2. Jam join/leave/reconnect reliability
3. Media publish-state truth vs UI indicators
4. Disconnect/reconnect teardown hygiene

## PR expectations

Every behavior-changing PR should include at least one of:
- a new test proving the expected behavior, or
- an update to existing tests covering the changed path.

## Cost-awareness

This project is private and budget-sensitive.
- Keep mandatory CI lean.
- Run heavy suites intentionally.
- Do not trigger expensive binary builds unless needed.
