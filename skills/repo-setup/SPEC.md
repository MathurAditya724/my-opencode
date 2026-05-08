# repo-setup — Specification

## Intent

Provide a safe, isolated working directory for each agent session so
concurrent sessions never overwrite each other's changes. This is the
prerequisite skill for every situation skill.

## Scope

### In scope

- Cloning or refreshing the target repository
- Creating git worktrees for branch isolation
- Determining the correct branch name from issue or PR context

### Out of scope

- Installing dependencies or running setup scripts (the situation skill handles that)
- Making any code changes
- Pushing or committing

## Invocation

Loaded first by `github-agent` before every situation skill. Every
code-touching workflow starts with `repo-setup`.

## Runtime contract

### Input

- Repository identifier (`owner/repo`)
- Context: issue number (for new branches) or PR number (for existing branches)

### Output

- A worktree at `~/dev/<owner>/<repo>-wt/<branch>` ready for work
- Current directory set to the worktree

### Side effects

- Creates or updates the shared clone at `~/dev/<owner>/<repo>`
- Creates a worktree directory on disk

## Evaluation criteria

- Concurrent sessions for different branches on the same repo do not interfere
- Worktree is on the correct branch (new branch from default for issues, PR head branch for PRs)
- `git status` in the worktree is clean after setup

## Maintenance

- If git worktree behavior changes across git versions, the commands here may need updating
- The `--depth=50` clone depth is a balance between speed and having enough history for rebasing
