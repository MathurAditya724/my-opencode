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
     default branch if needed.
   - **Only closed/merged PRs** → the issue may already be resolved.
     Verify before starting new work.
   - **No linked PRs** → proceed with fresh implementation.
3. Explore the codebase before editing.
4. Plan — state what you'll do before doing it.
5. Implement. Keep the diff focused. Run tests if you can find the
   test command quickly.
6. Load `deslop` skill — clean up AI noise.
7. Load `review` skill — self-review. Fix issues and re-run deslop
   until clean.
8. Commit with `Fixes #<number>` in the message. Push.
9. Load `pr` skill — open a draft PR. Be explicit about what's
   complete vs. uncertain.

Only BLOCKED for genuine impossibility (auth, repo missing, contradictory issue).
