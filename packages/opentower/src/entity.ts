// Extract the GitHub entity key from a webhook payload. The entity key
// is the natural "thing being worked on": owner/repo#N where N is the
// issue or PR number. All events related to the same issue or PR share
// the same entity key, enabling session affinity.
//
// Also extracts linked issue numbers from PR bodies so the lifecycle
// store can link issue→PR for session reuse.

import type { EntityResolver } from "./entity-resolver"
import { lookup, lookupString } from "./template"

export type EntityKey = {
  // Canonical key: "owner/repo#123". Used as the session affinity key.
  key: string
  repo: string
  number: number
  kind: "issue" | "pull_request"
  // Issue numbers referenced by "Fixes #N" / "Closes #N" in a PR body.
  // Only populated for pull_request events.
  linkedIssues: number[]
}

// Extract entity key from a GitHub webhook payload or email event.
// Returns null for events that don't map to a trackable entity.
// Email events use the AI entity resolver to identify the GitHub
// entity from any email source (GitHub, Sentry, CI, etc.).
export async function extractEntityKey(
  event: string,
  payload: unknown,
  resolver?: EntityResolver | null,
): Promise<EntityKey | null> {
  if (event.startsWith("email.")) {
    return resolveEmailEntity(payload, resolver)
  }

  const repo = lookupString(payload, "repository.full_name")
  if (!repo) return null

  // issue_comment uses payload.issue (which may be a PR)
  if (event === "issue_comment") {
    const num = lookup(payload, "issue.number")
    if (typeof num !== "number") return null
    const isPR = lookup(payload, "issue.pull_request") != null
    return { key: `${repo}#${num}`, repo, number: num, kind: isPR ? "pull_request" : "issue", linkedIssues: [] }
  }

  // issues.*
  if (event === "issues") {
    const num = lookup(payload, "issue.number")
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "issue", linkedIssues: [] }
  }

  // pull_request.*
  if (event === "pull_request") {
    const num = lookup(payload, "pull_request.number")
    if (typeof num !== "number") return null
    const body = lookupString(payload, "pull_request.body") ?? ""
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request", linkedIssues: extractLinkedIssues(body) }
  }

  // pull_request_review_comment.*
  if (event === "pull_request_review_comment") {
    const num = lookup(payload, "pull_request.number")
    if (typeof num !== "number") return null
    const body = lookupString(payload, "pull_request.body") ?? ""
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request", linkedIssues: extractLinkedIssues(body) }
  }

  // pull_request_review.*
  if (event === "pull_request_review") {
    const num = lookup(payload, "pull_request.number")
    if (typeof num !== "number") return null
    const body = lookupString(payload, "pull_request.body") ?? ""
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request", linkedIssues: extractLinkedIssues(body) }
  }

  // check_suite.* -- extract from pull_requests array
  if (event === "check_suite") {
    const prs = lookup(payload, "check_suite.pull_requests")
    if (!Array.isArray(prs) || prs.length === 0) return null
    const first = prs[0] as Record<string, unknown>
    const num = first?.number
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request", linkedIssues: [] }
  }

  // workflow_run.* -- extract from pull_requests array (same shape as check_suite)
  if (event === "workflow_run") {
    const prs = lookup(payload, "workflow_run.pull_requests")
    if (!Array.isArray(prs) || prs.length === 0) return null
    const first = prs[0] as Record<string, unknown>
    const num = first?.number
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request", linkedIssues: [] }
  }

  // push -- no single entity; dispatched via fire-and-forget (returns null)
  // The agent can inspect the payload to correlate with issues/PRs.

  return null
}

// Resolve email entity key using the AI resolver.
// The resolver handles all email sources (GitHub, Sentry, CI, etc.)
// via a single LLM call that extracts the GitHub entity reference.
// Returns null if no resolver is configured or if the email doesn't
// relate to a specific GitHub entity.
async function resolveEmailEntity(payload: unknown, resolver?: EntityResolver | null): Promise<EntityKey | null> {
  if (!resolver) return null
  const o = payload as Record<string, unknown> | null
  if (!o || typeof o !== "object") return null

  const result = await resolver.resolve({
    from: typeof o.from === "string" ? o.from : "",
    to: typeof o.to === "string" ? o.to : "",
    subject: typeof o.subject === "string" ? o.subject : "",
    message_id: typeof o.message_id === "string" ? o.message_id : "",
    in_reply_to: typeof o.in_reply_to === "string" ? o.in_reply_to : null,
    references: Array.isArray(o.references) ? o.references.filter((s): s is string => typeof s === "string") : [],
    list_id: typeof o.list_id === "string" ? o.list_id : null,
    x_github_reason: typeof o.x_github_reason === "string" ? o.x_github_reason : null,
    x_github_sender: typeof o.x_github_sender === "string" ? o.x_github_sender : null,
    body_text: typeof o.body_text === "string" ? o.body_text : null,
  })

  // Discard low-confidence guesses to avoid incorrect session affinity.
  if (!result.entity || result.confidence === "low") return null
  return {
    key: `${result.entity.repo}#${result.entity.number}`,
    repo: result.entity.repo,
    number: result.entity.number,
    kind: result.entity.kind,
    linkedIssues: [],
  }
}

// Extract issue numbers from "Fixes #N", "Closes #N", "Resolves #N"
// patterns in PR bodies. GitHub uses these for auto-close linking.
const LINKED_ISSUE_RE = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi

export function extractLinkedIssues(body: string): number[] {
  const nums = new Set<number>()
  let m: RegExpExecArray | null
  while ((m = LINKED_ISSUE_RE.exec(body)) !== null) {
    nums.add(Number(m[1]))
  }
  LINKED_ISSUE_RE.lastIndex = 0
  return [...nums]
}
