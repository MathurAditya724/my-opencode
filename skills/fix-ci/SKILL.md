---
name: fix-ci
description: Diagnose and fix failing CI on a pull request. Reads failed job logs, categorizes the failure, makes the smallest fix, pushes, and posts a comment. Capped at 3 attempts per PR.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Fix CI

Diagnose and fix failing CI on a PR the bot authored. The `repo-setup`
skill has already checked out the PR branch.

## 0. Attempt-budget check

You get **at most 3 fix attempts per PR**. Count prior sentinels:

```sh
PRIOR=$(gh pr view <pr-number> --json comments \
  --jq '[.comments[] | select(.body | startswith("ci-fixer: starting attempt"))] | length')
```

If `PRIOR >= 3`, stop: `BLOCKED: attempt budget exhausted`. Post a
result comment summarizing the failure mode and recommending the next
investigation step.

Otherwise, claim the slot:

```sh
N=$((PRIOR + 1))
gh pr comment <pr-number> --body "ci-fixer: starting attempt $N of 3"
```

## 1. Find the failed job and read its log

```sh
gh run list --branch "$(git rev-parse --abbrev-ref HEAD)" \
  --status failure --limit 5 --json databaseId,name,conclusion

gh run view <run-id> --log-failed
```

`--log-failed` prints just the failing steps.

## 2. Categorize the failure

- **Test failure** — look at assertion message + stack trace, fix
  the code or the test (whichever is wrong per the issue's intent).
- **Type / lint error** — fix locally, re-run the same command.
- **Build error** — same.
- **Snapshot / fixture diff** — update if the new behavior is
  intended; don't blindly refresh.
- **Flaky test** — re-run once (`gh run rerun <run-id> --failed`).
  If it passes, post a comment and stop.
- **Infra / runner / dependency-resolution** — out of scope. BLOCKED.

Don't guess. If the log is genuinely ambiguous, BLOCKED.

## 3. Reproduce locally if possible

Run the same command CI ran. If you can reproduce, you have a fast
feedback loop; if you can't, be conservative.

## 4. Plan the fix

State as 1-2 bullets before editing.

**Scope guardrail.** If the fix would touch >5 files, change CI
config, modify lockfiles, or alter dependency versions, BLOCKED.
Post a comment describing what you found and what you'd change.

## 5. Implement the fix

Smallest possible change. Re-run the local reproducer. Iterate until
it passes locally.

## 6. Clean up and review

Load the `deslop` skill. Then load the `review` skill.

## 7. Commit and push

```sh
git add -A
git commit -m "Fix CI: <summary>" -m "<body>"
git push
```

## 8. Comment on the PR

```sh
gh pr comment <pr-number> --body "$(cat <<'EOF'
ci-fixer: result — <one-line summary>

- failed run: <run-url>
- category: <test|lint|type|build|snapshot|flake>
- fix: <one or two sentences>
EOF
)"
```

## Constraints

- Don't modify CI config files unless the failure is specifically
  in the CI config itself AND the fix is unambiguous.
- Don't bump dependency versions. BLOCKED with the dependency name.
- Don't push --force.
- Don't merge the PR.
