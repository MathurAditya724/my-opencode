---
name: review-pr
description: Review a pull request. Determines whether the bot authored the PR (self-review path with fixes) or someone else did (post a GitHub review). Uses the review skill for the actual review pass.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Review PR

Review a pull request the bot is involved in (author, requested
reviewer, or assignee). The `repo-setup` skill has already checked
out the PR.

## 1. Whose PR is it?

```sh
PR_AUTHOR=$(gh pr view <pr-number> --json author --jq .author.login)
ME=$(gh api user --jq .login)
```

`OWN_PR=true` if `PR_AUTHOR == ME` (case-insensitive), else `false`.

If the PR is a **draft** and `OWN_PR=false`, stop:
`SKIPPED: PR is draft`. Drafts authored by the bot are fine to
self-review.

## 2. Read the PR's intent

- PR body.
- Closed issues: look for `Closes #N` / `Fixes #N` / `Resolves #N`
  and run `gh issue view N`.
- Commit messages: `git log --oneline "$DEFAULT_BRANCH"..HEAD`.

State what you think the PR is trying to do.

## 3. Run the review skill

Load the `review` skill and follow it. For larger diffs, prefer
spawning the `explore` sub-agent via the `task` tool for the read
pass.

Normalize findings into this shape:

```json
[
  {
    "kind": "bug" | "test-gap" | "style" | "scope" | "docs",
    "file": "src/foo.ts",
    "line": 42,
    "summary": "one-line description",
    "suggested_fix": "one-line description of the change"
  }
]
```

## 4. Act on the findings

### 4a. Empty findings

Default to `--comment` with a one-paragraph summary. Reserve
`--approve` for cases where you have a positive reason to vouch for
the change (traced the diff against the linked issue, ran tests, the
change is non-trivial enough to give real signal). Don't rubber-stamp.

```sh
gh pr review <pr-number> --comment --body "..."
```

### 4b. Findings, OWN_PR=true

Load the `apply-fixes` skill. Pass it the findings JSON. It will
implement and push fixes. After it completes:

- **Success** -- don't post a review. The commits speak for
  themselves. Print the commit SHA.
- **BLOCKED** -- fall through to 4c (post a review with the findings).

### 4c. Findings, OWN_PR=false (or apply-fixes blocked)

Post a structured GitHub review:

- **REQUEST_CHANGES** if any finding has `kind: "bug"` or
  `kind: "test-gap"` on a critical path.
- **COMMENT** otherwise.

```sh
gh pr review <pr-number> --request-changes --body "$(cat <<'EOF'
<one-paragraph summary>

- src/foo.ts:42 — <summary>
- src/bar.ts:7  — <summary>
EOF
)"
```

## 5. Print the URL

The review URL or commit URL, as the final line of your reply.

## Constraints

- Don't push code yourself on someone else's PR. Pushing happens
  through `apply-fixes` on your own PRs only.
- Don't approve trivially.
- Don't merge the PR.
