# pr — Specification

## Intent

Create a draft PR with a concise description and the full
implementation plan embedded as an invisible HTML comment for
reviewer context.

## Scope

### In scope

- Creating draft PRs via `gh pr create --draft`
- Writing concise PR descriptions (1-3 sentences)
- Embedding the implementation plan as a hidden HTML comment
- Linking to the originating issue via `Closes #N`

### Out of scope

- Marking PRs ready for review (handled by `mark-pr-ready`)
- Merging PRs
- Creating new branches (the caller handles this)

## Invocation

Loaded as the final step by `resolve-issue` after implementation,
testing, `deslop`, and `review` are complete.

## Runtime contract

### Input

- A branch with committed and pushed changes
- The implementation plan and issue number from the calling context

### Output

- The PR URL printed as the final line

### Side effects

- Creates a draft PR on GitHub

## Evaluation criteria

- PR is created as a draft (not ready-for-review)
- Title follows conventional commit format when the repo uses it
- Description is concise (not bloated with redundant context)
- Implementation plan is present in the HTML comment
- Issue is linked via `Closes #N`

## Maintenance

- The heredoc approach for PR body is important for preserving special characters
- The `git notes` alternative is documented but not the default path
