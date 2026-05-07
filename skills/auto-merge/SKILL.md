---
name: auto-merge
description: Auto-merge a PR after it is marked ready-for-review, if the change is small, non-disruptive, and all checks pass.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Auto-merge

Merge a PR that was just promoted from draft to ready-for-review,
**only** when the change is small, non-disruptive, and every required
check is green. This skill is the natural successor to `mark-pr-ready`.

## When to load this skill

Load after the `mark-pr-ready` skill has run (or after a
`pull_request.ready_for_review` event). Do **not** load it for PRs
that were created as ready-for-review from the start — only for PRs
that transitioned from draft.

## Preconditions (all must be true)

1. The PR is open and marked ready for review (not draft).
2. All required CI checks have passed.
3. The diff is small and non-disruptive (see size gate below).

If any precondition fails, stop — do not merge. Post a comment
explaining which precondition was not met.

## Size gate

Classify the PR as "small and non-disruptive" only when **all** of
these hold:

- Total lines changed (additions + deletions) ≤ 150.
- No more than 5 files changed.
- No changes to CI/CD configuration (`.github/workflows/`, `Dockerfile`,
  `docker-compose*`, `Makefile`, `Justfile`, Terraform `*.tf`).
- No changes to dependency lockfiles (`bun.lock`, `package-lock.json`,
  `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`).
- No database migrations or schema changes.
- No changes to authentication, authorization, or secrets handling.
- No deletions of public API surface (exported functions, REST
  endpoints, GraphQL types).

If the PR exceeds the size gate, stop. Post a comment noting the PR
needs human review and list which criteria it exceeded.

## Workflow

1. **Verify PR state**:
   ```sh
   STATE=$(gh pr view <N> --json state,isDraft --jq '"\(.state) \(.isDraft)"')
   ```
   Expect `OPEN false`. If draft or closed, stop.

2. **Verify all checks pass**:
   ```sh
   FAILING=$(gh pr checks <N> --json name,state \
     --jq '[.[] | select(.state != "SUCCESS" and .state != "SKIPPED" and .state != "NEUTRAL")]')
   ```
   If the output is not an empty array `[]`, stop — checks are not
   green yet. Post a comment listing the failing checks.

3. **Evaluate the size gate**:
   ```sh
   DIFF_STAT=$(gh pr diff <N> --stat)
   FILES_CHANGED=$(gh pr view <N> --json files --jq '.files | length')
   ADDITIONS=$(gh pr view <N> --json additions --jq '.additions')
   DELETIONS=$(gh pr view <N> --json deletions --jq '.deletions')
   TOTAL=$((ADDITIONS + DELETIONS))
   ```
   Check each criterion listed in the size gate section. Inspect the
   file list for CI/CD, lockfile, migration, auth, or public API
   changes:
   ```sh
   gh pr view <N> --json files --jq '.files[].path'
   ```

4. **Check for review requests or objections**:
   ```sh
   REVIEWS=$(gh pr view <N> --json reviews --jq '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | length')
   ```
   If any reviewer requested changes, stop — the PR needs human
   attention.

5. **Merge**:
   ```sh
   gh pr merge <N> --squash --auto --delete-branch
   ```
   Use `--squash` to keep the main branch history clean.
   Use `--auto` so GitHub waits for branch protection rules.
   Use `--delete-branch` to clean up the feature branch.

6. **Post a short comment** confirming the merge. Mention the total
   diff size and that all checks passed. Write it naturally — vary
   the wording, don't use a canned phrase.

## When NOT to merge

- The PR has "CHANGES_REQUESTED" reviews.
- The PR modifies security-sensitive code.
- The PR exceeds the size gate.
- Any required check is not green.
- The PR targets a release or protected branch other than the default
  branch.
- The PR has unresolved review comments.

In all these cases, leave a comment explaining why auto-merge was
skipped, and let a human decide.

## Notes

- This skill should be loaded by the coordinator after `mark-pr-ready`
  completes, or in response to a `pull_request.ready_for_review` webhook.
- The `--auto` flag on `gh pr merge` respects branch protection rules.
  If the repo requires approvals, the merge will wait until those are
  satisfied.
- Never force-merge or bypass branch protection.
