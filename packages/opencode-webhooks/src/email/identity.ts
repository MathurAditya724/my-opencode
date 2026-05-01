// Map a GitHub notification email to the GitHub entity it references:
// (owner, repo, kind, number[, comment]).
//
// GitHub's notification Message-IDs follow predictable patterns:
//
//   <owner/repo/issues/N@github.com>
//   <owner/repo/issues/comment/COMMENT_ID@github.com>
//   <owner/repo/pull/N@github.com>
//   <owner/repo/pull/N/cN@github.com>           (issue-style comment on PR)
//   <owner/repo/pull/N/review/N@github.com>     (review summary)
//   <owner/repo/pull/N/rN@github.com>           (inline review comment)
//   <owner/repo/push/<sha>@github.com>          (push notification — ignored)
//
// We try Message-ID first, then In-Reply-To, then each References token —
// per-event Message-IDs often don't match but the parent <…/issues/N>
// or <…/pull/N> form usually shows up in In-Reply-To.

// Wire shape posted by the Cloudflare email worker. Mirrors
// EmailEvent in the worker; kept as a structural type so we don't
// share TypeScript files across packages.
export type EmailEvent = {
  from: string
  to: string
  subject: string
  message_id: string
  in_reply_to: string | null
  references: string[]
  list_id: string | null
  x_github_reason: string | null
  x_github_sender: string | null
}

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

export function identifyEmail(event: EmailEvent): EmailIdentity {
  const candidates: string[] = []
  if (event.message_id) candidates.push(event.message_id)
  if (event.in_reply_to) candidates.push(event.in_reply_to)
  for (const tok of event.references) {
    if (tok.length > 0) candidates.push(tok)
  }

  for (const candidate of candidates) {
    const issue = ISSUE_RE.exec(candidate)
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

    const pull = PULL_RE.exec(candidate)
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
  }

  return { kind: "unknown" }
}
