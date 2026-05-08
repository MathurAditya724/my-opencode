# resolve-issue — Specification

## Intent

Take a GitHub issue from "assigned" to "draft PR opened" with a
focused, tested implementation. Prefer shipping a best-effort draft
over blocking on ambiguity.

## Scope

### In scope

- Reading and interpreting the issue
- Checking for existing PRs that already address the issue
- Codebase exploration (including read-only cross-repo investigation)
- Planning, implementing, and testing the fix
- Self-review via `deslop` and `review` skills
- Opening a draft PR via the `pr` skill

### Out of scope

- Marking the PR ready for review (handled by `mark-pr-ready`)
- Merging (handled by `auto-merge`)
- Responding to review feedback after PR creation (handled by `respond-to-comment`)
- Closing the issue (GitHub auto-closes on merge via `Fixes #N`)

## Invocation

Loaded by `github-agent` when an issue is assigned to the bot.
Requires `repo-setup` to run first.

## Runtime contract

### Input

- Issue number and repository context (from webhook payload)
- A prepared worktree (from `repo-setup`)

### Output

- A draft PR URL, or `BLOCKED: <reason>` for genuine impossibility

### Side effects

- Commits and pushes to a feature branch
- Opens a draft PR on GitHub

## Evaluation criteria

- The PR addresses the issue's core request (smallest interpretation)
- Tests pass (or "no test suite found" is documented)
- The diff is focused — no unrelated changes
- Self-review produces an empty findings array before PR creation
- Existing PRs for the same issue are detected and continued rather than duplicated

## Maintenance

- Test discovery heuristics should be updated as new ecosystems are encountered
- The conflict resolution section assumes standard git rebase workflow
