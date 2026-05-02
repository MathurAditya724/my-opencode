---
name: repo-setup
description: Clone or refresh a GitHub repo and set up the working tree. Handles both fresh clone for new issues and checkout of existing PRs. Shared boilerplate used by all situation skills.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Repository Setup

Clone or refresh the target repository and prepare the working tree
for the current situation. This skill is loaded before every situation
skill.

## Determine repo and context from the payload

Extract the repo from the payload:

```sh
REPO=$(echo '<payload>' | jq -r '.repository.full_name')
OWNER=$(echo "$REPO" | cut -d/ -f1)
NAME=$(echo "$REPO" | cut -d/ -f2)
WORK_DIR=~/dev/$OWNER/$NAME
```

## Clone or refresh

```sh
gh repo clone "$REPO" "$WORK_DIR" -- --depth=50 2>/dev/null || true
cd "$WORK_DIR"
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
git fetch --all --prune
git reset --hard "origin/$DEFAULT_BRANCH"
git clean -fd
git checkout "$DEFAULT_BRANCH"
```

## Branch setup (depends on situation)

### For new issues (resolve-issue)

Create a feature branch:

```sh
git checkout -b issue-<number>-<short-slug>
```

Never push to or modify the default branch directly.

### For existing PRs (review-pr, fix-ci, respond-to-comment)

Check out the PR's branch:

```sh
gh pr checkout <pr-number>
```

The PR number comes from the payload — for `pull_request` events it's
`payload.pull_request.number`; for `check_suite` events, extract from
`payload.check_suite.pull_requests[0].number`; for `issue_comment`
events, it's `payload.issue.number`.

## Output

After this skill completes, you should have:

- `$WORK_DIR` set to the repo path
- `$DEFAULT_BRANCH` set to the default branch name
- The working tree on the correct branch (feature branch for issues,
  PR branch for existing PRs)
- A clean working tree with no uncommitted changes
