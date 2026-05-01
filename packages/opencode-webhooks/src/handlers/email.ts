// Fetch handler for POST /webhooks/email. The Cloudflare email worker
// HMAC-signs and forwards the raw RFC822 message; we re-verify the
// allowlist (defense-in-depth), parse only headers, identify the
// referenced GitHub entity, fetch canonical state via `gh`, and drive
// the same dispatcher the github handler uses.
//
// Only triggers with source === "email" are considered here. Their
// `event` is "email.<reason>" where <reason> is the X-GitHub-Reason
// header (lowercased): mention, review_requested, assign, comment, ...

import type { Dispatcher } from "../dispatch"
import { verifySha256Signature } from "../hmac"
import {
  evaluateBotMatch,
  evaluateIgnoreAuthors,
  evaluatePayloadFilter,
  findMatching,
} from "../matchers"
import type { DeliveryStore } from "../storage"
import { lookup, renderTemplate } from "../template"
import type { NormalizedTrigger, SkippedDispatch } from "../types"
import {
  type AllowlistPattern,
  extractAddress,
  matchesAllowlist,
} from "../email/allowlist"
import { identifyEmail } from "../email/identity"
import { parseHeaders } from "../email/parse"
import { synthesizePayload } from "../email/synthesize"

const MAX_BODY_BYTES = 25 * 1024 * 1024

export function makeEmailFetchHandler(opts: {
  emailSecret: string
  allowlist: AllowlistPattern[]
  triggers: NormalizedTrigger[]
  store: DeliveryStore
  retention: number
  dispatch: Dispatcher
  botLogin: string | null
}): (req: Request) => Promise<Response> {
  const {
    emailSecret,
    allowlist,
    triggers,
    store,
    retention,
    dispatch,
    botLogin,
  } = opts
  const emailTriggers = triggers.filter((t) => t.source === "email")

  return async function fetch(req) {
    if (!emailSecret) {
      return Response.json(
        { error: "no email HMAC secret configured on server" },
        { status: 503 },
      )
    }

    const declaredLength = Number(req.headers.get("content-length") ?? "0")
    if (declaredLength > MAX_BODY_BYTES) {
      return Response.json({ error: "payload too large" }, { status: 413 })
    }
    // Read body as raw bytes so HMAC matches what the worker signed.
    // UTF-8-decoding via req.text() would replace 8-bit sequences and
    // break signature verification on RFC822 messages with non-UTF-8
    // content (rare for GitHub notifications but possible).
    const rawBytes = new Uint8Array(await req.arrayBuffer())
    if (rawBytes.byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: "payload too large" }, { status: 413 })
    }

    const signature = req.headers.get("x-email-signature-256")
    if (!verifySha256Signature(rawBytes, signature, emailSecret)) {
      return Response.json({ error: "invalid signature" }, { status: 401 })
    }
    // Headers are 7-bit ASCII per RFC 5322; parseHeaders only scans up
    // to the first blank line, so a UTF-8 decode of the full body is
    // safe to feed in.
    const rawBody = new TextDecoder("utf-8").decode(rawBytes)

    const envelopeFrom = req.headers.get("x-email-from") ?? ""
    const envelopeTo = req.headers.get("x-email-to") ?? ""
    const headerMessageId = req.headers.get("x-email-message-id") ?? ""

    if (!envelopeFrom) {
      return Response.json(
        { error: "missing x-email-from header" },
        { status: 400 },
      )
    }

    // Defense-in-depth: re-check the worker's allowlist on the server.
    if (allowlist.length > 0 && !matchesAllowlist(envelopeFrom, allowlist)) {
      return Response.json(
        { error: "sender not in allowlist", from: extractAddress(envelopeFrom) },
        { status: 403 },
      )
    }

    const headers = parseHeaders(rawBody)
    const messageId = headers.get("message-id") ?? headerMessageId
    if (!messageId) {
      return Response.json(
        { error: "missing message-id" },
        { status: 400 },
      )
    }

    // Self-loop guard: drop notifications about the bot's own activity
    // before doing any GitHub API work. X-GitHub-Sender is the github
    // login of whoever performed the action.
    const ghSender = headers.get("x-github-sender") ?? null
    if (
      botLogin &&
      ghSender &&
      ghSender.toLowerCase() === botLogin.toLowerCase()
    ) {
      return Response.json({
        ok: true,
        message_id: messageId,
        dropped: "self-loop",
        sender: ghSender,
      })
    }

    const identity = identifyEmail(headers)
    if (identity.kind === "unknown") {
      return Response.json({
        ok: true,
        message_id: messageId,
        dropped: "unknown-message-id",
      })
    }

    const reason = (headers.get("x-github-reason") ?? "subscribed").toLowerCase()
    const event = `email.${reason}`
    const dedupKey = `email:${messageId}`

    // Synthesize BEFORE dedup: if `gh api` fails (network blip, rate
    // limit), we need Cloudflare to retry. Inserting the dedup row
    // first would both swallow the retry AND return 200, losing the
    // email permanently.
    const synth = await synthesizePayload(identity, headers, {
      from: envelopeFrom,
      to: envelopeTo,
      reason,
    })
    if (!synth.ok) {
      return Response.json({
        ok: true,
        message_id: messageId,
        dropped: synth.error,
      })
    }

    // Idempotency: dedup by Message-ID, namespaced so it can never
    // collide with GitHub's UUID delivery_ids.
    const inserted = store.insert(dedupKey, event, null)
    if (inserted) store.trim(retention)
    if (!inserted) {
      return Response.json({
        ok: true,
        message_id: messageId,
        duplicate: true,
        dispatched: [],
      })
    }

    // API-fetched login is the trustworthy source for self-loop
    // suppression; X-GitHub-Sender header is only the fallback.
    const apiSender = lookup(synth.payload, "comment.user.login")
    const apiReviewSender = lookup(synth.payload, "review.user.login")
    const senderForIgnore =
      (typeof apiSender === "string" ? apiSender : null) ??
      (typeof apiReviewSender === "string" ? apiReviewSender : null) ??
      ghSender

    const reviewState = lookup(synth.payload, "review.state")
    const review_state =
      typeof reviewState === "string" ? reviewState.toLowerCase() : null

    const matches = findMatching(emailTriggers, event, null)
    const dispatched: string[] = []
    const skipped: SkippedDispatch[] = []
    for (const t of matches) {
      const senderReason = evaluateIgnoreAuthors(t.ignore_authors, senderForIgnore)
      if (senderReason) {
        skipped.push({ name: t.name, reason: senderReason })
        continue
      }
      const botMatchReason = evaluateBotMatch(
        t.require_bot_match,
        synth.payload,
        botLogin,
      )
      if (botMatchReason) {
        skipped.push({ name: t.name, reason: botMatchReason })
        continue
      }
      const filterReason = evaluatePayloadFilter(t.payload_filter, synth.payload)
      if (filterReason) {
        skipped.push({ name: t.name, reason: filterReason })
        continue
      }

      const prompt = renderTemplate(t.prompt_template, {
        event,
        action: null,
        delivery_id: dedupKey,
        payload: synth.payload,
        review_state,
      })
      void dispatch(t, prompt, dedupKey)
      dispatched.push(t.name)
    }

    return Response.json({
      ok: true,
      message_id: messageId,
      event,
      duplicate: false,
      dispatched,
      ...(skipped.length > 0 ? { skipped } : {}),
    })
  }
}
