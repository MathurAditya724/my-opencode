---
name: resolve-issue
description: Resolve a GitHub issue end-to-end. Plans, implements, cleans up, self-reviews, commits, and opens a draft PR. Assumes repo-setup has already been run.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Resolve Issue

Take an assigned GitHub issue from "assigned" to "draft PR opened."
The `repo-setup` skill has already cloned the repo and created a
feature branch.

**Default to shipping a draft PR.** A best-effort first cut — even if
incomplete — is far more valuable than a comment saying "this is too
big." Other skills will iterate on whatever you push: `review-pr`
will critique it, `fix-ci` will fix failing checks, and
`respond-to-comment` will action review feedback. Your job is to give
them something to work with.

## 1. Read the issue carefully

Re-read the body from the payload. Look for linked issues, code
references (`file:line`), and acceptance criteria. If the issue is
ambiguous, lean toward the **smallest** interpretation that plausibly
resolves the user's stated problem.

## 2. Explore the codebase

Use `glob`, `grep`, and `read` (and `codesearch` when appropriate)
before touching anything. Identify:

- The specific files/functions the issue refers to.
- Existing tests that exercise the affected code.
- The project's coding style — look at neighbouring files.

## 3. Plan

State the plan as a short bulleted list before implementing. Be honest
about what you're going to ship in this pass and what you're leaving
for follow-up.

## 4. Implement

Make the change the issue calls for. Keep the diff focused — no
opportunistic refactors. Add or update tests when straightforward; if
a test would require significant harness work, leave a TODO and call
it out in the PR body.

If you can identify the project's test command in under 30 seconds
(`npm test`, `pnpm test`, `bun test`, `pytest`, `go test ./...`,
`cargo test`), run it before committing. If tests fail because of your
change, fix them.

## 5. Clean up the diff

Load the `deslop` skill and apply it against your branch.

**Don't commit yet.** Steps 5 and 6 may iterate.

## 6. Self-review

Load the `review` skill and follow it. Prefer the `explore` sub-agent
(read-only) when the skill suggests spawning one.

If review surfaces gaps, fix them, re-run deslop, then re-run review.
Loop until both pass cleanly. Only commit once both are clean.

## 7. Commit and push

Write a commit message that:

- Has a subject line under 72 chars, imperative mood.
- References the issue: `Fixes #<number>`.
- One paragraph explaining the user-visible change in the body.

Push the branch to `origin`.

## 8. Open a draft PR

Load the `pr` skill and follow it. The PR body should make clear
what's done and what's deliberately left for iteration:

- **What this changes** — one paragraph.
- **What's complete** — the parts you're confident in.
- **What's incomplete or uncertain** — explicit TODOs, design
  decisions you're unsure about, missing tests, risky areas.
- **Followups** — anything out of scope you noticed but didn't
  address.

You stop here. The PR is a draft. Other skills pick it up from this
point.

## Scope guardrail

If the issue would require changes to >5 files or touches public APIs
in a way you're not confident about, still ship the draft PR with what
you have and flag the uncertainty in the body. Only emit BLOCKED for
genuine impossibility.
