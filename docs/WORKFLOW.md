# Development Workflow

## Branch model

- `main` = release-ready branch
- feature/fix/docs branches = PR branches

## Rules

1. Never push directly to `main`/`master`.
2. Use pull requests for all changes.
3. Required verification checks must pass before merge.
4. Prefer small, focused PRs unless intentionally batching foundational work.
5. Before starting a bugfix PR, check open PRs, issues, branches, and
   `CURRENT_SESSION.md` for the same symptom or fix area. Reuse, update,
   rebase/port, close, or explicitly supersede existing work instead of
   opening duplicate PRs.

## Typical flow

1. Branch from `main`.
2. For bugfixes, confirm there is no matching open PR, issue, branch, or
   deferred note in `CURRENT_SESSION.md`.
3. Implement change.
4. Run quick verification locally.
5. Push branch and open PR.
6. Ensure CI checks pass.
7. Merge.

## PR description minimum

- linked issue(s)
- what changed and why
- release impact (`server-only` / `desktop-binary` / `both`)
- evidence of verification

## Foundation-first policy

For large fix waves:
- merge verification/testing foundation first
- then branch fix/enhancement waves on top
- avoid carrying large stacks that rebase badly
