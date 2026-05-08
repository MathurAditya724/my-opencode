# apply-fixes — Specification

## Intent

Turn structured review findings into minimal code changes, committed
and pushed. Used on the bot's own PRs after the `review` skill
produces findings.

## Scope

### In scope

- Parsing the findings JSON array
- Implementing one finding at a time as the smallest possible change
- Running tests when available
- Loading `deslop` before committing
- Reporting which findings were addressed and which were skipped

### Out of scope

- Opening new PRs or branches
- Force-pushing
- Fixing findings that require architectural changes

## Invocation

Loaded by `review-pr` when findings exist on the bot's own PR, or
by any skill that needs to apply structured fixes.

## Runtime contract

### Input

- JSON array of findings: `[{ kind, file, line, summary, suggested_fix }]`

### Output

- Commit SHA, list of findings addressed, list of findings skipped with reasons

### Side effects

- Commits and pushes to the current feature branch

## Evaluation criteria

- Each finding is addressed with the smallest possible change
- Skipped findings have clear, valid reasons
- Only files that were edited are staged
- The `deslop` skill runs before committing

## Maintenance

- The findings schema must stay in sync with the `review` skill's output format
