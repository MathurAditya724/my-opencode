---
name: pr
description: Create a draft PR for the current branch following repo conventions. Writes a concise PR description from the implementation plan, attaches the full plan as a git note, and reuses an existing branch when one is already checked out. Use this once your implementation is committed and pushed.
license: Apache-2.0
metadata:
  source: https://github.com/BYK/dotskills
  audience: autonomous-agents
---

# Create a PR

Create a **draft** PR from the current branch's changes. Follow the repo's
conventions for branch name and commit title. The PR description should be
based on the implementation plan and the changes summary, but kept short
and to the point — not overly long or detailed.

## Steps

1. **Check the branch**. If you're already on a relevant feature branch
   (i.e. not `main`/`master`), reuse it. Don't create a new one on top.
2. **Push** the branch to `origin` with `-u` if it isn't already tracked.
3. **Open the PR** with `gh pr create --draft`. Title should match the
   commit subject. Body should be a 1–3 sentence summary plus a
   "Testing" line if relevant.
4. **Attach the plan as a git note** using `git notes add -m "<plan>"
   HEAD` so the full implementation plan is preserved on the commit
   without bloating the PR description.
5. **Print the PR URL** as the final line of your reply.

## Notes

- This skill creates a *draft* PR by design. A separate review/iterate
  step should mark it ready-for-review once self-review and CI pass.
- Don't include diagrams, lengthy "context" sections, or duplicated
  information that's already on the issue. The reader can follow the
  link.

---

*Adapted from [BYK/dotskills](https://github.com/BYK/dotskills)
(Apache-2.0).*
