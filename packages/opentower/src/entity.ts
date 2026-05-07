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
// For email events with no regex match, falls back to the AI resolver
// if one is provided.
export async function extractEntityKey(
  event: string,
  payload: unknown,
  resolver?: EntityResolver | null,
): Promise<EntityKey | null> {
  if (event.startsWith("email.")) {
    return extractEmailEntityKey(payload, resolver)
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

// Extract entity key from a GitHub notification email.
// GitHub emails include structured headers we can parse:
//   message_id / references: <owner/repo/issues/42/...@github.com>
//                            <owner/repo/pull/43/...@github.com>
//   subject:                 Re: [owner/repo] Title (#42)
async function extractEmailEntityKey(payload: unknown, resolver?: EntityResolver | null): Promise<EntityKey | null> {
  const o = payload as Record<string, unknown> | null
  if (!o || typeof o !== "object") return null

  // 1. Try message_id and references — most reliable, encodes repo + number + type.
  //    Format: <owner/repo/issues/N/...@github.com> or <owner/repo/pull/N/...@github.com>
  const messageId = typeof o.message_id === "string" ? o.message_id : ""
  const references = Array.isArray(o.references) ? o.references.filter((s): s is string => typeof s === "string") : []

  const refResult =
    parseGitHubMessageRef(messageId) ??
    references.reduce<EntityKey | null>((found, ref) => found ?? parseGitHubMessageRef(ref), null)
  if (refResult) return refResult

  // 2. Fall back to subject line — format: "Re: [owner/repo] Title (#42)"
  const subject = typeof o.subject === "string" ? o.subject : ""
  const subjectResult = parseGitHubSubject(subject)
  if (subjectResult) return subjectResult

  // 3. Fall back to AI resolver for non-GitHub emails (Sentry, etc.)
  if (!resolver) return null

  const result = await resolver.resolve({
    from: typeof o.from === "string" ? o.from : "",
    to: typeof o.to === "string" ? o.to : "",
    subject,
    message_id: messageId,
    body_text: typeof o.body_text === "string" ? o.body_text : null,
    list_id: typeof o.list_id === "string" ? o.list_id : null,
  })

  if (!result.repo || !result.number) return null
  return {
    key: `${result.repo}#${result.number}`,
    repo: result.repo,
    number: result.number,
    kind: result.kind ?? "issue",
    linkedIssues: [],
  }
}

// Parse owner/repo and issue/PR number from a GitHub email Message-ID or References header.
// Example: <MathurAditya724/outpost/pull/54/c1234567@github.com>
//          <MathurAditya724/outpost/issues/42/890abcde@github.com>
const GITHUB_REF_RE = /<?([A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+)\/(issues|pull)\/(\d+)\//

function parseGitHubMessageRef(ref: string): EntityKey | null {
  const m = GITHUB_REF_RE.exec(ref)
  if (!m) return null
  const repo = m[1]
  const kind = m[2] === "pull" ? "pull_request" : "issue"
  const number = Number(m[3])
  return { key: `${repo}#${number}`, repo, number, kind, linkedIssues: [] }
}

// Parse owner/repo and number from a GitHub email subject line.
// Example: "Re: [MathurAditya724/outpost] Fix CI (#54)"
//          "[owner/repo] New issue title (#42)"
const GITHUB_SUBJECT_RE = /\[([A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+)\].*\(#(\d+)\)/

function parseGitHubSubject(subject: string): EntityKey | null {
  const m = GITHUB_SUBJECT_RE.exec(subject)
  if (!m) return null
  const repo = m[1]
  const number = Number(m[2])
  // Subject doesn't distinguish issue vs PR — default to issue;
  // the lifecycle store's link walking will find the right session
  // if a PR session already exists for this number.
  return { key: `${repo}#${number}`, repo, number, kind: "issue", linkedIssues: [] }
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
