# respond-to-comment — Specification

## Intent

Triage and respond to comments on PRs the bot is involved in,
implementing fixes for actionable feedback and explaining decisions
for non-actionable feedback.

## Scope

### In scope

- Self-loop detection (skip own comments)
- Classifying comments as actionable vs. not actionable
- Implementing fixes for actionable comments on own PRs
- Replying with suggestions for actionable comments on others' PRs
- Explaining why a comment is not actionable

### Out of scope

- Approving or merging PRs
- Pushing to others' branches
- Responding to approval-only reviews (thumbs-up with no code refs)

## Invocation

Loaded by `github-agent` when a `pull_request_review_comment`,
`issue_comment`, or `pull_request_review` event arrives for a PR the
bot is involved in. Requires `repo-setup` first.

## Runtime contract

### Input

- Comment body, author, and location (inline or top-level)
- PR number and repository context

### Output

- A reply comment (and optionally a fix commit with SHA)

### Side effects

- May push commits to own PRs
- Posts reply comments on GitHub

## Evaluation criteria

- Own comments are detected and skipped (no self-loops)
- Actionable feedback on own PRs results in a fix commit
- Replies are concise and natural — teammate tone, not support bot
- Approval thumbs-ups are not replied to

## Maintenance

- The thread API vs. top-level comment distinction depends on GitHub's API
