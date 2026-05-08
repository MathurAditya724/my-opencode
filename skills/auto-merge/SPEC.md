# auto-merge — Specification

## Intent

Automatically merge small, non-disruptive PRs after they pass all
checks and have no review objections. Acts as the final step after
`mark-pr-ready` for trivial changes that don't need human review.

## Scope

### In scope

- Verifying PR state, target branch, and CI status
- Evaluating the size gate (lines, files, sensitive paths)
- Checking for review objections and unresolved threads
- Squash-merging with branch cleanup

### Out of scope

- PRs that were created as ready-for-review from the start
- PRs targeting non-default branches
- PRs with review objections or unresolved threads
- PRs exceeding the size gate

## Invocation

Loaded by `github-agent` after `mark-pr-ready` completes, or in
response to a `pull_request.ready_for_review` webhook for a PR
that transitioned from draft.

## Runtime contract

### Input

- PR number and repository context

### Output

- Merge confirmation comment, or a comment explaining why auto-merge was skipped

### Side effects

- Merges the PR (squash) and deletes the feature branch
- Uses `--auto` to respect branch protection rules

## Evaluation criteria

- All six preconditions are verified before merging
- The size gate correctly identifies sensitive files (CI, lockfiles, migrations, auth, public API)
- PRs that need human review are never auto-merged
- The `--auto` flag is always used (never bypasses branch protection)

## Maintenance

- The size gate thresholds (150 lines, 5 files) may need tuning based on experience
- New sensitive file patterns may need to be added to the size gate
- The GraphQL query for unresolved threads depends on GitHub's API schema
