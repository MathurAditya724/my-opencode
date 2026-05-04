---
name: repo-setup
description: Clone or refresh a GitHub repo and prepare the working tree. Load this before any situation skill.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Repository Setup

Clone or refresh the repo and create an isolated worktree for the branch.

## Why worktrees

The main clone at `~/dev/<owner>/<repo>` is shared across sessions. Working
directly in it causes concurrent sessions to overwrite each other's changes.
Git worktrees give each branch its own directory with its own working tree
and index, while sharing the object store.

## Steps

1. **Clone** (or refresh) the bare-ish main clone:
   ```sh
   gh repo clone <owner>/<repo> ~/dev/<owner>/<repo> -- --depth=50 2>/dev/null || true
   cd ~/dev/<owner>/<repo>
   git fetch --all --prune
   ```

2. **Determine the branch name**:
   - **New issue**: `issue-<number>-<slug>` (e.g. `issue-42-fix-login`)
   - **Existing PR**: the PR's head branch — get it with:
     ```sh
     BRANCH=$(gh pr view <number> --json headRefName --jq .headRefName)
     ```

3. **Create or reuse a worktree** for the branch:
   ```sh
   WORKTREE=~/dev/<owner>/<repo>-wt/<branch>
   ```
   - If `$WORKTREE` already exists, just `cd "$WORKTREE"` and skip to step 4.
   - **New branch** (issue):
     ```sh
     DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
     git worktree add "$WORKTREE" -b <branch> "origin/$DEFAULT_BRANCH"
     ```
   - **Existing branch** (PR checkout):
     ```sh
     git fetch origin "<branch>:<branch>" 2>/dev/null || true
     git worktree add "$WORKTREE" "<branch>"
     ```

4. **Work in the worktree** — all subsequent commands run from `$WORKTREE`:
   ```sh
   cd "$WORKTREE"
   ```

5. **Clean up** (optional, after push): if the worktree is no longer needed:
   ```sh
   git -C ~/dev/<owner>/<repo> worktree remove "$WORKTREE" --force
   ```

## Important

- Never `git reset --hard` or `git clean -fd` in the main clone — other
  worktrees depend on the shared objects.
- The worktree directory pattern `~/dev/<owner>/<repo>-wt/<branch>` keeps
  worktrees adjacent to the main clone without nesting inside it.
