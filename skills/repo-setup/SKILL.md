---
name: repo-setup
description: Clone or refresh a GitHub repo and prepare the working tree. Load this before any situation skill.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Repository Setup

Clone or refresh the repo and get on the right branch.

## Steps

1. Clone under `~/dev/<owner>/<repo>`:
   ```sh
   gh repo clone <owner>/<repo> ~/dev/<owner>/<repo> -- --depth=50 2>/dev/null || true
   ```

2. Reset to the default branch:
   ```sh
   DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
   git fetch --all --prune
   git reset --hard "origin/$DEFAULT_BRANCH"
   git clean -fd
   git checkout "$DEFAULT_BRANCH"
   ```

3. Branch:
   - **New issue**: `git checkout -b issue-<number>-<slug>`
   - **Existing PR**: `gh pr checkout <number>`
