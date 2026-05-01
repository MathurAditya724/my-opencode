// Build a GitHub-shaped payload from an email, by fetching canonical
// state via the GitHub API. Existing agents/triggers see the same JSON
// shape they'd get from a real webhook delivery, so they don't need
// any email-specific handling.
//
// We never read the email body — only headers. The body of an issue or
// PR comment comes from the API, which is the source of truth.

import { ghApi } from "./github-api"
import type { EmailIdentity } from "./identity"
import type { EmailHeaders } from "./parse"

export type SyntheticPayload = Record<string, unknown> & {
  repository: {
    full_name: string
    owner: { login: string }
    name: string
  }
  sender: { login: string | null }
  _email: {
    reason: string
    message_id: string
    from: string
    to: string
    list_id: string
    kind: string
  }
}

export type SynthesisResult =
  | { ok: true; payload: SyntheticPayload }
  | { ok: false; error: string }

export async function synthesizePayload(
  identity: EmailIdentity,
  headers: EmailHeaders,
  envelope: { from: string; to: string; reason: string },
): Promise<SynthesisResult> {
  if (identity.kind === "unknown") {
    return { ok: false, error: "unknown-message-id" }
  }

  const reason = envelope.reason
  const sender = headers.get("x-github-sender") ?? null
  const messageId = headers.get("message-id") ?? ""
  const listId = headers.get("list-id") ?? ""

  const fullName = `${identity.owner}/${identity.repo}`
  const repository = {
    full_name: fullName,
    owner: { login: identity.owner },
    name: identity.repo,
  }
  const emailMeta = {
    reason,
    message_id: messageId,
    from: envelope.from,
    to: envelope.to,
    list_id: listId,
    kind: identity.kind,
  }

  if (identity.kind === "issue") {
    const issue = await ghApi<Record<string, unknown>>(
      `/repos/${identity.owner}/${identity.repo}/issues/${identity.number}`,
    )
    if (!issue) return { ok: false, error: "fetch-issue-failed" }

    let comment: Record<string, unknown> | null = null
    if (identity.comment_id) {
      comment = await ghApi<Record<string, unknown>>(
        `/repos/${identity.owner}/${identity.repo}/issues/comments/${identity.comment_id}`,
      )
    }

    return {
      ok: true,
      payload: {
        repository,
        issue,
        ...(comment ? { comment } : {}),
        sender: { login: sender },
        _email: emailMeta,
      },
    }
  }

  // identity.kind === "pull"
  const pull = await ghApi<Record<string, unknown>>(
    `/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}`,
  )
  if (!pull) return { ok: false, error: "fetch-pull-failed" }

  let comment: Record<string, unknown> | null = null
  let review: Record<string, unknown> | null = null
  if (identity.comment_id) {
    if (identity.comment_kind === "review") {
      review = await ghApi<Record<string, unknown>>(
        `/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}/reviews/${identity.comment_id}`,
      )
    } else if (identity.comment_kind === "review_comment") {
      comment = await ghApi<Record<string, unknown>>(
        `/repos/${identity.owner}/${identity.repo}/pulls/comments/${identity.comment_id}`,
      )
    } else {
      // "issue" comment on a PR — same endpoint as issue comments.
      comment = await ghApi<Record<string, unknown>>(
        `/repos/${identity.owner}/${identity.repo}/issues/comments/${identity.comment_id}`,
      )
    }
  }

  return {
    ok: true,
    payload: {
      repository,
      pull_request: pull,
      ...(comment ? { comment } : {}),
      ...(review ? { review } : {}),
      sender: { login: sender },
      _email: emailMeta,
    },
  }
}
