# mark-pr-ready — Specification

## Intent

Promote a draft PR to ready-for-review after CI passes and
self-review is clean. The `auto-merge` skill may follow for small,
non-disruptive changes, but this skill itself never merges.

## Scope

### In scope

- Verifying CI status via `gh pr checks`
- Marking the PR ready with `gh pr ready`
- Requesting reviewers from CODEOWNERS
- Adding labels (`bot-generated` + priority labels from the issue)
- Posting a confirmation comment

### Out of scope

- Merging the PR
- Creating labels that don't exist in the repo
- Running self-review (should be done before this skill is loaded)

## Invocation

Loaded by `github-agent` after a `check_suite` or `workflow_run`
event with `conclusion: success` on a draft PR where the bot is
the author.

## Runtime contract

### Input

- PR number and repository context
- CI must be green

### Output

- A confirmation comment noting the PR is ready

### Side effects

- Marks the PR as ready-for-review on GitHub
- May request reviewers and add labels

## Evaluation criteria

- CI is verified green before marking ready
- Reviewer assignment failures are silently skipped
- Label creation failures are silently skipped (don't create labels)
- The confirmation comment varies its wording

## Maintenance

- CODEOWNERS file location may vary (`.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`)
- Priority label patterns may need updating
