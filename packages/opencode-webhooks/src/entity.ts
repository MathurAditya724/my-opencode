// Extract the GitHub entity key from a webhook payload. The entity key
// is the natural "thing being worked on": owner/repo#N where N is the
// issue or PR number. All events related to the same issue or PR share
// the same entity key, enabling session affinity.

import { lookup, lookupString } from "./template"

export type EntityKey = {
  // Canonical key: "owner/repo#123". Used as the session affinity key.
  key: string
  repo: string
  number: number
  kind: "issue" | "pull_request"
}

// Extract entity key from a GitHub webhook payload.
// Returns null for email events (raw email content, no entity structure)
// and for webhook events that don't map to a trackable entity.
export function extractEntityKey(
  event: string,
  payload: unknown,
): EntityKey | null {
  // Email events carry raw email content -- no entity to extract.
  // The agent decides what to do with the email.
  if (event.startsWith("email.")) {
    return null
  }

  const repo = lookupString(payload, "repository.full_name")
  if (!repo) return null

  // issue_comment uses payload.issue (which may be a PR)
  if (event === "issue_comment") {
    const num = lookup(payload, "issue.number")
    if (typeof num !== "number") return null
    const isPR = lookup(payload, "issue.pull_request") != null
    return { key: `${repo}#${num}`, repo, number: num, kind: isPR ? "pull_request" : "issue" }
  }

  // issues.*
  if (event === "issues") {
    const num = lookup(payload, "issue.number")
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "issue" }
  }

  // pull_request.*
  if (event === "pull_request") {
    const num = lookup(payload, "pull_request.number")
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request" }
  }

  // pull_request_review_comment.*
  if (event === "pull_request_review_comment") {
    const num = lookup(payload, "pull_request.number")
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request" }
  }

  // pull_request_review.*
  if (event === "pull_request_review") {
    const num = lookup(payload, "pull_request.number")
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request" }
  }

  // check_suite.* -- extract from pull_requests array
  if (event === "check_suite") {
    const prs = lookup(payload, "check_suite.pull_requests")
    if (!Array.isArray(prs) || prs.length === 0) return null
    const first = prs[0] as Record<string, unknown>
    const num = first?.number
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request" }
  }

  // workflow_run.* -- extract from pull_requests array (same shape as check_suite)
  if (event === "workflow_run") {
    const prs = lookup(payload, "workflow_run.pull_requests")
    if (!Array.isArray(prs) || prs.length === 0) return null
    const first = prs[0] as Record<string, unknown>
    const num = first?.number
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request" }
  }

  // push -- no single entity; dispatched via fire-and-forget (returns null)
  // The agent can inspect the payload to correlate with issues/PRs.

  return null
}
