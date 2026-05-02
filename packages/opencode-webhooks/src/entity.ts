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

// Extract entity key from a GitHub webhook or synthesized email payload.
// Returns null if the payload doesn't map to a trackable entity (e.g.
// a push event with no associated PR).
export function extractEntityKey(
  event: string,
  payload: unknown,
): EntityKey | null {
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

  // check_suite.* — extract from pull_requests array
  if (event === "check_suite") {
    const prs = lookup(payload, "check_suite.pull_requests") as unknown[]
    if (!Array.isArray(prs) || prs.length === 0) return null
    const first = prs[0] as Record<string, unknown>
    const num = first?.number
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request" }
  }

  // email.* events — synthesized payload has the same shape as real
  // webhook payloads (issue or pull_request at top level)
  if (event.startsWith("email.")) {
    const issueNum = lookup(payload, "issue.number")
    if (typeof issueNum === "number") {
      const isPR = lookup(payload, "pull_request") != null
        || lookup(payload, "issue.pull_request") != null
      return {
        key: `${repo}#${issueNum}`,
        repo,
        number: issueNum,
        kind: isPR ? "pull_request" : "issue",
      }
    }
    const prNum = lookup(payload, "pull_request.number")
    if (typeof prNum === "number") {
      return { key: `${repo}#${prNum}`, repo, number: prNum, kind: "pull_request" }
    }
    return null
  }

  return null
}
