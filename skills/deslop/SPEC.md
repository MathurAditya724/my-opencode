# deslop — Specification

## Intent

Strip AI-generated noise from the diff before committing, ensuring
the final code reads as if a human wrote it. Clean diffs get merged
faster and avoid distracting reviewers.

## Scope

### In scope

- Removing unnecessary comments that restate the code
- Removing defensive try/catch blocks in trusted code paths
- Removing type casts (`any`, `as unknown as X`) that silence the checker
- Moving inline imports to the top of the file (Python)
- Removing redundant type annotations where inference handles it
- Removing unnecessary `else` after early returns
- Removing leftover debug logging (console.log, print)
- Replacing overly verbose variable names that break file conventions
- Fixing style inconsistencies with the surrounding file

### Out of scope

- Adding new functionality
- Refactoring code beyond slop removal
- Changing the logic or behavior of the code

## Invocation

Loaded as a utility skill before every commit, typically by
`resolve-issue`, `fix-ci`, `respond-to-comment`, and `apply-fixes`.

## Runtime contract

### Input

- A branch with uncommitted or committed changes ahead of the default branch

### Output

- A 1-3 sentence summary of what was cleaned up

### Side effects

- Modifies files in the working tree (removes slop patterns)

## Evaluation criteria

- Removed comments were genuinely redundant (not meaningful documentation)
- Removed try/catch blocks were genuinely unnecessary (not protecting against real failures)
- Style consistency with the surrounding file is improved, not degraded
- No behavioral changes introduced by slop removal

## Maintenance

- New AI slop patterns should be added as they are observed in practice
- Language-specific patterns (Python imports, TypeScript casts) may need expansion
