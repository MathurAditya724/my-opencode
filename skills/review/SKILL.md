---
name: review
description: Self-review the current branch's changes (and the PR description, if a PR exists) with a critical eye before merge. Use this after implementation but before pushing or marking a draft PR ready, to catch obvious gaps. Spawning a sub-agent for the review tends to produce more objective results than reviewing your own output directly.
license: Apache-2.0
metadata:
  source: https://github.com/BYK/dotskills
  audience: autonomous-agents
---

# Self-review changes

Now review your own code (including the PR description, if a PR exists)
thoroughly and with a critical eye one last time.

## Process

- Inspect `git diff <default-branch>...HEAD` and read every change as if
  you were a reviewer encountering it for the first time.
- Watch for:
  - Logic that doesn't match what the issue asked for
  - Missing test coverage on the new behavior
  - Edge cases (null, empty, large input, concurrency)
  - Inconsistent style with neighboring code
  - Stale comments, dead branches, or scope creep
- Read the PR description (if there is one) and confirm it matches the
  actual diff.

## Outcome

- **Looks good** → proceed to merge / mark ready-for-review.
- **Gaps found** → fix them in the same branch, then run this skill
  again before proceeding.

## Tip

Using a sub-agent (via the `task` tool) for the review often yields
more objective results than reviewing your own output directly. The
sub-agent doesn't have the implementation's "obvious in context" bias.

---

*Adapted from [BYK/dotskills](https://github.com/BYK/dotskills)
(Apache-2.0).*
