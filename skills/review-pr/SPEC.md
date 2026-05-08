# review-pr — Specification

## Intent

Review a PR the bot is involved in, either self-fixing findings on
its own PRs or posting review feedback on others' PRs.

## Scope

### In scope

- Determining PR authorship (own vs. others')
- Loading the `review` skill for structured analysis
- Applying fixes on own PRs via `apply-fixes`
- Posting review comments on others' PRs

### Out of scope

- Merging PRs
- Approving PRs (reserve for when correctness can be vouched for)
- Pushing changes to others' branches

## Invocation

Loaded by `github-agent` when a PR event involves the bot (as author,
reviewer, or assignee). Requires `repo-setup` first.

## Runtime contract

### Input

- PR number and repository context
- A prepared worktree on the PR's branch

### Output

- A review URL (posted via `gh pr review`), or fix commits pushed to own PR

### Side effects

- May push commits to own PRs (via `apply-fixes`)
- Posts review comments on GitHub

## Evaluation criteria

- Own PR findings are fixed, not just reported
- Others' PR reviews are specific and actionable
- Review tone matches "senior dev" style — direct, no filler
- Drafts are not skipped (own drafts are reviewed for self-improvement)

## Maintenance

- The `explore` sub-agent delegation for large diffs should be monitored for quality
