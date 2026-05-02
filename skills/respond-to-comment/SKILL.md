---
name: respond-to-comment
description: Triage and respond to comments on a PR. Fix if actionable, reply either way. Load repo-setup first.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Respond to Comment

Triage a comment on a PR the bot is involved in. Load `repo-setup` first.

## Self-loop guard

If the comment author equals your identity (`gh api user --jq .login`),
stop: `SKIPPED: own comment`.

## Triage

- **Actionable**: real bug, missing test, valid concern → fix it
- **Not actionable**: style preference, out of scope, already handled → reply with reason
- **Approval thumbs-up** (short body, no code refs): don't reply, stop

## Workflow

1. Check PR authorship — only push to your own PR's branch.
2. If actionable on your own PR: implement fix, load `deslop`, commit,
   push, reply with commit SHA.
3. If actionable on someone else's PR: reply with a `suggestion` block
   or description. Don't push.
4. If not actionable: reply with the reason.

Reply to inline comments via the thread API. Reply to top-level
comments via `gh pr comment`.

Don't push to others' branches. Don't force-push. Don't merge.
