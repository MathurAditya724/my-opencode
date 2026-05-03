---
name: resolve-issue
description: Resolve a GitHub issue end-to-end — explore, plan, implement, clean up, and open a draft PR.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Resolve Issue

Take an issue from "assigned" to "draft PR opened." Load `repo-setup`
first to get on a feature branch.

**Default to shipping a draft PR.** A best-effort first cut is more
valuable than a "too big" comment. Other agents will review it, fix CI,
and respond to feedback.

## Workflow

1. Read the issue body. Lean toward the smallest interpretation.
2. Check for existing PRs that reference this issue:
   ```sh
   gh pr list --search "linked:issue:<number>" --repo <owner>/<repo> --json number,title,state,headRefName,url
   ```
   If that returns nothing, also try:
   ```sh
   gh api "repos/<owner>/<repo>/issues/<number>/timeline" --paginate \
     --jq '[.[] | select(.event=="cross-referenced" and .source.issue.pull_request != null) | {number: .source.issue.number, state: .source.issue.state, title: .source.issue.title}]'
   ```
   - **Open PR exists** → check it out (`gh pr checkout <number>`),
     review what's done, and continue from there instead of starting
     fresh. Load `review` skill to assess quality first.
   - **Draft/stale PR exists** → same as above. Rebase onto the
     default branch if needed (see conflict resolution below).
   - **Only closed/merged PRs** → the issue may already be resolved.
     Verify before starting new work.
   - **No linked PRs** → proceed with fresh implementation.
3. Explore the codebase before editing. If the issue references other
   repos (e.g. a shared library, a backend API), clone them for
   read-only investigation:
   ```sh
   gh repo clone <other-owner>/<other-repo> ~/dev/<other-owner>/<other-repo> -- --depth=50
   ```
   Only push changes to the repo where the fix belongs.
4. Plan — state what you'll do before doing it.
5. Implement. Keep the diff focused.
6. **Discover and run tests** — see the test discovery section below.
7. Load `deslop` skill — clean up AI noise.
8. Load `review` skill — self-review. Fix issues and re-run deslop
   until clean.
9. Commit with `Fixes #<number>` in the message. Push.
10. Load `pr` skill — open a draft PR. Be explicit about what's
    complete vs. uncertain.

## Conflict resolution

Before pushing, check for conflicts with the default branch:

```sh
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
git fetch origin "$DEFAULT_BRANCH"
git rebase "origin/$DEFAULT_BRANCH"
```

If the rebase has conflicts:

1. Check `git diff --name-only --diff-filter=U` for conflicted files.
2. For each file, read the conflict markers (`<<<<<<<`, `=======`,
   `>>>>>>>`), understand both sides, and resolve.
3. `git add <resolved-file>` then `git rebase --continue`.
4. If the conflict is too complex to resolve confidently, abort with
   `git rebase --abort` and note it in the PR description.

Never force-push to someone else's branch. On your own feature branch,
a rebase followed by `git push --force-with-lease` is acceptable.

## Test discovery

Before committing, find and run the project's test suite. Check these
locations in order and use the first match:

1. **package.json** (Node/JS/TS):
   ```sh
   jq -r '.scripts.test // empty' package.json
   ```
   Run with `npm test`, `bun test`, `pnpm test`, or `yarn test`
   depending on the lockfile present.

2. **Makefile / Justfile**:
   ```sh
   grep -E '^test[ :]' Makefile Justfile 2>/dev/null
   ```
   Run with `make test` or `just test`.

3. **Python** (pytest / unittest):
   ```sh
   test -f pytest.ini || test -f pyproject.toml || test -f setup.cfg
   ```
   Run with `pytest` or `python -m pytest`.

4. **Go**:
   ```sh
   test -f go.mod
   ```
   Run with `go test ./...`.

5. **CI workflows** (fallback):
   ```sh
   grep -r 'run:.*test' .github/workflows/ 2>/dev/null | head -5
   ```
   Extract the test command from the workflow file.

If no test command is found within 30 seconds of searching, skip and
note "no test suite found" in the PR description. Don't spend more
than 2 minutes on a failing test suite that's unrelated to your
changes — note it and move on.

Only BLOCKED for genuine impossibility (auth, repo missing, contradictory issue).
