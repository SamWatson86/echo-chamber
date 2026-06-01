# Codex Operating Model

This document exists to keep Codex usage simple and prevent project/worktree
sprawl.

## One Canonical Echo Project

Use the saved Codex project named **Echo Chamber - Main** as the canonical Echo
Chamber project.

Do not create additional Codex projects for ordinary Echo bugs, cleanup, release
prep, or investigations. Older project entries such as release-audit clones,
driver-validation clones, or one-off bug worktrees are historical unless Sam
explicitly asks to revive them.

## What The Words Mean

- **Project**: the saved Codex entry for the Echo repo. Use **Echo Chamber -
  Main**.
- **Thread**: one conversation/task. Start a new thread for each real bug.
- **Worktree**: a separate repo checkout for a thread that might change code.
- **Branch**: the Git name for the change, usually `codex/...`.
- **Workspace**: the folder Codex is currently operating in. Do not use this
  word as a planning primitive.

## Default Bug Workflow

For real Echo bugs:

1. Open **Echo Chamber - Main**.
2. Start a new thread.
3. Choose a new worktree from `main` if code may change.
4. Use a branch name like `codex/bug-short-description`.
5. Investigate before editing.

Do not:

- create a new Codex project
- work directly on `main`
- reuse an old bug branch
- use historical plans/handovers unless Sam names one
- release, restart services, touch SAM-PC, or reload remote clients unless Sam
  explicitly asks

## Bug Investigation Prompt

```text
Investigate this Echo Chamber bug from current main.

Do not release, restart services, touch SAM-PC, or change code yet.

First:
1. classify runtime surface
2. classify release impact
3. show the call path
4. propose repro/verification
5. say whether code changes are needed

Bug:
[paste bug]
```

## When To Use Local vs Worktree

Use **local** only for:

- asking questions
- reading code
- planning
- docs-only inspection where no edits are expected

Use a **worktree** for:

- bugs that may require code changes
- PR work
- uncertain investigations
- anything that might touch runtime behavior

## ELI5 Requirement

Every bug PR or bug-fix final summary should include:

```text
ELI5:
What broke:
Why it broke:
What changed:
How we know it works:
Does this need a desktop update:
What could still go wrong:
```

For larger bugs, create a short file under `docs/eli5/`.
