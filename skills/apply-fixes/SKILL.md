---
name: apply-fixes
description: Apply a structured list of review findings as the smallest possible code changes, then commit and push. Used after the review skill produces findings on the bot's own PR.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Apply Fixes

Take a JSON array of review findings and turn them into commits.
The PR branch is already checked out.

## Input

A JSON array of findings, each with `kind`, `file`, `line`,
`summary`, `suggested_fix` — the shape the `review` skill emits.

## 1. Sanity check

```sh
git status --porcelain
git rev-parse --abbrev-ref HEAD
```

If the branch is the default branch, stop: `BLOCKED: refusing to
push to default branch`.

If `git status --porcelain` shows staged changes (lines not starting
with `??` or ` `), stop: `BLOCKED: staged changes present`.

## 2. Plan the fixes

For each finding, decide:

- **Tractable in a small change** — include it.
- **Requires architectural rework** — skip. Note the skip.
- **Style/scope on code the diff doesn't carry** — skip with a note.

State the plan as a bulleted list before editing.

## 3. Implement

One finding at a time. Smallest change per finding. Update or add
tests when the finding is `kind: bug` or `kind: test-gap`.

If a finding's `suggested_fix` is wrong (you tried it, it doesn't
work), apply the real fix and note the deviation.

## 4. Run tests if you can

If you can identify the test command in under 30 seconds, run it.
If anything breaks that wasn't already broken, back out the offending
change.

## 5. Clean up the diff

Load the `deslop` skill.

## 6. Commit and push

One commit covering all fixes. Stage only files you edited:

```sh
git add <file1> <file2> ...
git commit -m "Address review findings" -m "<short body>"
git push
```

Don't push --force.

## 7. Report

Final output:

- Commit SHA you pushed.
- Bullet list of findings addressed (one line each, by file).
- Bullet list of findings skipped, with the reason.
