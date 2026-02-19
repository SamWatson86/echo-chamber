# ADR-0001: Deployment and Release Boundaries

- Status: Accepted
- Date: 2026-02-19

## Context

The team observed recurring confusion around:
- server-side updates vs desktop binary updates
- what auto-updater can and cannot do
- when EXE/DMG releases are actually required

This created coordination overhead and incorrect implementation requests.

## Decision

Adopt explicit delivery boundaries and terminology:

1. Treat **server deploy** and **desktop binary release** as different operations.
2. Require PRs to state release impact (server-only, desktop-binary, or both).
3. Use [Release Boundaries](../RELEASE-BOUNDARIES.md) as normative guidance.
4. Prefer server-only deploys when feasible to reduce unnecessary binary churn.

## Consequences

Positive:
- less ambiguity in planning and communication
- fewer unnecessary binary builds/releases
- clearer contributor and agent prompts

Tradeoffs:
- requires discipline in PR descriptions/labels
- initial habit change for contributors

## Follow-up

- Add/standardize release-impact labeling or PR template section.
- Revisit boundaries if deployment architecture materially changes.
