---
name: respond-to-comment
description: Triage and respond to comments on a PR. If actionable, implements the fix and replies. If not, replies with the reason. Handles inline review comments, top-level PR comments, and review bodies.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Respond to Comment

Triage a comment on a PR the bot is involved in and respond. The
`repo-setup` skill has already checked out the PR branch.

## Determine the comment type from the payload

- `pull_request_review_comment.created` — inline review comment
  (attached to a specific diff line). Fields: `payload.comment.id`,
  `payload.comment.body`, `payload.comment.path`, `payload.comment.line`.
- `issue_comment.created` — top-level PR comment. The PR number is
  `payload.issue.number`. Fields: `payload.comment.id`,
  `payload.comment.body`.
- `pull_request_review.submitted` — review body. Fields:
  `payload.review.id`, `payload.review.body`, `payload.review.state`.

## 0. Self-loop guard (defense-in-depth)

Check the comment author against `$ME`:

```sh
ME=$(gh api user --jq .login)
```

If the comment author matches `$ME`, stop: `SKIPPED: own comment`.
This is a defense-in-depth check — the plugin's `ignore_authors`
should have already filtered this, but check anyway.

## 1. Triage

Read the comment. Decide:

- **Actionable** — points to a real issue: bug, missing test, broken
  edge case, valid logic concern.
- **Not actionable** — style preference without a project rule, out
  of scope, already addressed, or just a question.
- **Approval acknowledgement** — a review with `state: approved` and
  a brief body (<=80 chars, no question marks, no code references, no
  imperative suggestions). Don't reply. Stop:
  `SKIPPED: approval acknowledgement`.

State your triage decision as the first line of your reply.

If not actionable, jump to step 5 (reply only).

## 2. Plan the fix

For inline comments: focus on the file and line range. For general
comments: re-read the PR diff and the comment together.

**Scope guardrail.** If the comment asks for >5 files, CI/lockfile
changes, or an unrelated feature, decline politely and stop.

## 3. Whose PR is it?

```sh
PR_AUTHOR=$(gh pr view <pr-number> --json author --jq .author.login)
ME=$(gh api user --jq .login)
```

- **Same** — bot authored the PR. Push fix commits. Continue to step 4.
- **Different** — someone else's PR. Don't push. In step 5, reply
  with a ` ```suggestion ` block (inline) or prose description
  (top-level).

## 4. Implement, clean up, commit (own-PR path only)

Make the smallest change. Load the `deslop` skill.

```sh
git add -A
git commit -m "Address review: <one-line summary>" -m "Re: <comment-url>"
git push
```

## 5. Reply to the comment

For **inline review comments**, reply in the same thread:

```sh
gh api --method POST \
  "repos/<owner>/<repo>/pulls/<pr-number>/comments/<comment-id>/replies" \
  -f body="<reply>"
```

For **top-level PR comments**, use:

```sh
gh pr comment <pr-number> --body "<reply>"
```

Reply body depends on triage:

- **Actionable + fixed:** "Fixed in <sha-short>. <explanation>."
- **Actionable but too big:** "That's bigger than this PR's scope.
  Could you open a separate issue?"
- **Not actionable (addressed):** "The code already handles this —
  see <file:line>."
- **Not actionable (style):** "Noted, but I think the existing form
  is fine because <reason>. Happy to change if you feel strongly."
- **Not actionable (out of scope):** "Out of scope for this PR."

Be honest. Don't agree just to be agreeable.

## Constraints

- Don't push to someone else's branch.
- Don't push --force.
- Don't resolve conversation threads.
- Don't merge the PR.
- One comment, one reply.
