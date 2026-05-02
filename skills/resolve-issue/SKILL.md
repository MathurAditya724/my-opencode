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
2. Explore the codebase before editing.
3. Plan — state what you'll do before doing it.
4. Implement. Keep the diff focused. Run tests if you can find the
   test command quickly.
5. Load `deslop` skill — clean up AI noise.
6. Load `review` skill — self-review. Fix issues and re-run deslop
   until clean.
7. Commit with `Fixes #<number>` in the message. Push.
8. Load `pr` skill — open a draft PR. Be explicit about what's
   complete vs. uncertain.

Only BLOCKED for genuine impossibility (auth, repo missing, contradictory issue).
