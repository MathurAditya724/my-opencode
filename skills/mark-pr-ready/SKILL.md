---
name: mark-pr-ready
description: Promote a draft PR to ready-for-review after CI passes and self-review is clean. Assigns reviewers and adds labels.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Mark PR Ready

Promote a draft PR out of draft status. Only do this when CI is green
and self-review found no remaining issues.

## Preconditions

- You are on the PR's feature branch.
- CI has passed (check via `gh pr checks <N> --required`).
- Self-review produced no unresolved findings.

## Workflow

1. Verify CI status:
   ```sh
   gh pr checks <N> --required --json name,state \
     --jq '[.[] | select(.state != "SUCCESS" and .state != "SKIPPED")]'
   ```
   If any required checks are not SUCCESS/SKIPPED, stop — CI isn't
   green yet.

2. Mark ready for review:
   ```sh
   gh pr ready <N>
   ```

3. Assign reviewers from CODEOWNERS (if the file exists):
   ```sh
   if [ -f CODEOWNERS ] || [ -f .github/CODEOWNERS ] || [ -f docs/CODEOWNERS ]; then
     gh pr edit <N> --add-reviewer "$(gh api repos/<owner>/<repo>/pulls/<N>/requested_reviewers --jq '.users[].login' 2>/dev/null || true)"
   fi
   ```
   If CODEOWNERS doesn't exist or reviewer assignment fails, skip
   silently — GitHub may auto-assign via branch protection rules.

4. Add labels:
   ```sh
   gh pr edit <N> --add-label "bot-generated"
   ```
   If the original issue had priority labels, propagate them:
   ```sh
   ISSUE_LABELS=$(gh issue view <issue-N> --json labels --jq '.labels[].name' 2>/dev/null)
   for label in $ISSUE_LABELS; do
     case "$label" in priority*|P0|P1|P2|P3|critical|high|medium|low)
       gh pr edit <N> --add-label "$label" 2>/dev/null || true
       ;;
     esac
   done
   ```

5. Post a comment summarizing the promotion:
   ```sh
   gh pr comment <N> --body "Marked ready for review. CI is green and self-review is clean."
   ```

## Notes

- Don't merge the PR. Marking ready is the final step for the bot.
- If label creation fails (label doesn't exist in the repo), skip
  silently — don't create labels.
- This skill is typically loaded by the coordinator agent after a
  `check_suite` or `workflow_run` event with conclusion `success`.
