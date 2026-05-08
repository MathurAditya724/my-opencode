# fix-ci — Specification

## Intent

Diagnose and fix failing CI on a PR the bot authored, with a hard
budget of 3 attempts to prevent infinite fix loops.

## Scope

### In scope

- Reading CI failure logs
- Categorizing failures (test, type/lint, build, snapshot, flaky, infra)
- Making targeted fixes for test, type, lint, and build failures
- Re-running flaky tests once
- Loading `deslop` and `review` before committing fixes

### Out of scope

- Modifying CI configuration (unless the failure is specifically in it)
- Bumping dependency versions
- Fixing infrastructure issues (BLOCKED)
- Fixing failures unrelated to the bot's changes

## Invocation

Loaded by `github-agent` when a `check_suite` or `workflow_run` event
arrives with `conclusion: failure` for a PR the bot authored.
Requires `repo-setup` first.

## Runtime contract

### Input

- PR number and branch (from webhook payload)
- A prepared worktree on the PR's branch

### Output

- A fix commit pushed to the branch, or `BLOCKED: <reason>`

### Side effects

- Posts `fix-ci: attempt N` comments for budget tracking
- Commits and pushes fixes to the PR branch
- May re-run failed workflows for flaky tests

## Evaluation criteria

- The 3-attempt budget is respected (counted via comment prefix)
- Fixes are minimal — don't change more than necessary
- Flaky tests are re-run rather than "fixed"
- Infrastructure issues are correctly identified as BLOCKED
- The fix actually resolves the CI failure

## Maintenance

- The `gh run view --log-failed` output format may change across `gh` versions
- New CI failure categories may emerge (e.g., security scanning failures)
