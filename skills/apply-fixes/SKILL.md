---
name: apply-fixes
description: Apply review findings as the smallest code changes, then commit and push. Used on the bot's own PRs.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Apply Fixes

Turn a JSON array of review findings into commits on the current branch.

## Input

Findings array with `kind`, `file`, `line`, `summary`, `suggested_fix`.

## Workflow

1. Verify you're on a feature branch, not the default.
2. Plan: decide which findings are tractable in small changes vs. skip.
3. Implement one finding at a time. Smallest change per finding.
4. Run tests if you can find the command quickly.
5. Load `deslop` skill.
6. Commit and push. Stage only files you edited.

Report: commit SHA, findings addressed, findings skipped with reasons.
Don't force-push. Don't open a new branch or PR.
