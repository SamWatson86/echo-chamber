# Documentation Index

This folder is the shared source of truth for contributors and automation
agents.

## Start Here

- [Architecture](./ARCHITECTURE.md) - system boundaries, major components, and
  data flow
- [Operations](./OPERATIONS.md) - day-to-day runbook, deploy, logs, incident
  basics
- [Testing](./TESTING.md) - verification model, CI expectations, regression
  strategy
- [Codex operating model](./CODEX.md) - canonical project/thread/worktree rules
- [Release Boundaries](./RELEASE-BOUNDARIES.md) - when desktop-binary updates
  are required vs server-only deploys
- [Terminology](./TERMINOLOGY.md) - shared vocabulary for Sam/agents/contributors
- [Workflow](./WORKFLOW.md) - branching and PR flow
- [Backups](./BACKUPS.md) - backup strategy and recovery notes
- [GitHub setup](./GITHUB.md) - repo setup and collaboration basics

## Historical Context

- `docs/plans/`, `docs/handovers/`, and `docs/superpowers/` may contain stale
  implementation details. Use them as historical evidence only unless Sam names
  a specific parked workstream.
- macOS release plans are historical. Echo Chamber releases are Windows-only
  unless Sam explicitly asks otherwise.

## Decision Records

- [ADR-0001: Deployment & release boundaries](./ADR/0001-deployment-and-release-boundaries.md)

## Maintenance Expectations

- Keep docs practical and bias toward examples/checklists.
- If behavior changes, update docs in the same PR.
- Prefer clear terminology over shorthand (see Terminology doc).
