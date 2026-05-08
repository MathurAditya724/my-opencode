---
name: self-update
description: Update agent dependencies and configuration, run checks, and open a draft PR.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Self-Update

Update the agent's own dependencies to their latest versions, verify
nothing breaks, and open a draft PR with the changes.

## When to use

- Periodically (e.g., weekly) to stay current
- When a dependency release fixes a known issue
- When asked to update by a maintainer

## Workflow

1. **Preflight**: verify you're on a clean worktree on a fresh branch.
   ```sh
   DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
   git checkout -b chore/update-deps "origin/$DEFAULT_BRANCH"
   ```

2. **Identify updatable dependencies**: check for outdated packages.
   ```sh
   # For bun workspaces
   bun outdated 2>/dev/null || true
   # For npm
   npm outdated 2>/dev/null || true
   ```

3. **Update dependencies**: update to latest compatible versions.
   ```sh
   # For bun
   bun update
   # For npm
   npm update
   ```
   For major version bumps, review the changelog before updating.
   Only bump major versions if the changelog indicates no breaking
   changes for our usage.

4. **Run verification**:
   ```sh
   # Type check
   bun run typecheck 2>/dev/null || npm run typecheck 2>/dev/null || true
   # Lint
   bun run lint 2>/dev/null || npm run lint 2>/dev/null || true
   # Build
   bun run build 2>/dev/null || npm run build 2>/dev/null || true
   # Test
   bun test 2>/dev/null || npm test 2>/dev/null || true
   ```
   Fix any issues caused by the updates. If a fix requires more than
   trivial changes, revert that specific update and note it.

5. **Commit and push**:
   ```sh
   git add -A
   git commit -m "chore: update dependencies"
   git push -u origin HEAD
   ```

6. **Open a draft PR** via the `pr` skill. Title:
   `chore: update dependencies`. Body should list what was updated
   and any issues encountered.

## Constraints

- Only update dependencies, not application code
- Revert updates that cause test or build failures you can't trivially fix
- Include the lockfile in the commit (it must stay in sync)
- Don't update dependencies pinned for a specific reason without
  checking the pin rationale (look for comments in package.json or
  a `VENDORING.md` / `PINNED.md` file)
