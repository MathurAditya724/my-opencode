# review — Specification

## Intent

Produce a structured list of findings from the current branch's
changes, enabling downstream consumers (fix-appliers, PR reviewers)
to act on them mechanically.

## Scope

### In scope

- Diffing the branch against the default branch (three-dot syntax)
- Classifying findings by kind: bug, test-gap, style, scope, docs
- Running the test suite to catch regressions
- Delegating to an `explore` sub-agent for large diffs

### Out of scope

- Fixing findings (handled by `apply-fixes`)
- Posting reviews on GitHub (handled by `review-pr`)
- Reviewing files outside the branch's diff

## Invocation

Loaded as a utility skill by `resolve-issue`, `review-pr`, `fix-ci`,
and any other skill that needs a quality check before committing.

## Runtime contract

### Input

- A branch with commits ahead of the default branch

### Output

- A JSON block with a `findings` array (empty array = no issues)
- Each finding: `{ kind, file, line, summary, suggested_fix }`

### Side effects

- None (read-only analysis). May spawn an `explore` sub-agent.

## Evaluation criteria

- Findings are actionable — each one points to a specific file and line
- False positive rate is low (style findings require neighboring code to differ)
- Bug findings reflect real logic errors, not hypothetical edge cases
- Empty findings array is used correctly (no "everything looks good" entries)
- Confidence levels are applied appropriately (see references/confidence-calibration.md)
- Known false-positive patterns are filtered (see references/not-a-finding.md)

## Maintenance

- Finding categories may expand as new patterns emerge
- The three-dot diff syntax depends on the branch having a merge-base with the default branch
