// Map a GitHub notification email's headers to the GitHub entity it
// references: (owner, repo, kind, number[, comment]).
//
// GitHub's notification Message-IDs follow predictable patterns:
//
//   <owner/repo/issues/N@github.com>
//   <owner/repo/issues/comment/COMMENT_ID@github.com>
//   <owner/repo/pull/N@github.com>
//   <owner/repo/pull/N/c<COMMENT_ID>@github.com>           (issue-comment on PR)
//   <owner/repo/pull/N/review/<REVIEW_ID>@github.com>
//   <owner/repo/pull/N/r<COMMENT_ID>@github.com>           (inline review comment)
//   <owner/repo/push/<sha>@github.com>                     (push notification — ignored)
//
// We resolve the entity via Message-ID + List-ID. The `In-Reply-To` and
// `References` headers can also help when the Message-ID is for a
// reply, but the patterns above are enough for the v1 surface.

import type { EmailHeaders } from "./parse"

export type EmailIdentity =
  | {
      kind: "issue"
      owner: string
      repo: string
      number: number
      comment_id?: number
    }
  | {
      kind: "pull"
      owner: string
      repo: string
      number: number
      // Only set when the email was about a comment/review on a PR.
      comment_id?: number
      comment_kind?: "issue" | "review" | "review_comment"
    }
  | { kind: "unknown" }

const ISSUE_RE =
  /^<?([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/(?:comment\/)?(\d+))?@github\.com>?$/i
const PULL_RE =
  /^<?([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(c|r|review\/?)(\d+))?@github\.com>?$/i

export function identifyEmail(headers: EmailHeaders): EmailIdentity {
  const messageId = headers.get("message-id") ?? ""

  const issue = ISSUE_RE.exec(messageId)
  if (issue) {
    const [, owner, repo, n, commentId] = issue
    return {
      kind: "issue",
      owner,
      repo,
      number: Number(n),
      comment_id: commentId ? Number(commentId) : undefined,
    }
  }

  const pull = PULL_RE.exec(messageId)
  if (pull) {
    const [, owner, repo, n, marker, commentId] = pull
    let comment_kind: "issue" | "review" | "review_comment" | undefined
    if (marker === "c") comment_kind = "issue"
    else if (marker === "r") comment_kind = "review_comment"
    else if (marker?.startsWith("review")) comment_kind = "review"
    return {
      kind: "pull",
      owner,
      repo,
      number: Number(n),
      comment_id: commentId ? Number(commentId) : undefined,
      comment_kind,
    }
  }

  return { kind: "unknown" }
}
