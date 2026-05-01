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
import { renderTemplate } from "../template"
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
    const rawBody = await req.text()
    if (rawBody.length > MAX_BODY_BYTES) {
      return Response.json({ error: "payload too large" }, { status: 413 })
    }

    const signature = req.headers.get("x-email-signature-256")
    if (!verifySha256Signature(rawBody, signature, emailSecret)) {
      return Response.json({ error: "invalid signature" }, { status: 401 })
    }

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

    // Idempotency: dedup by Message-ID, namespaced so it can never
    // collide with GitHub's UUID delivery_ids.
    const dedupKey = `email:${messageId}`
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

    const synth = await synthesizePayload(identity, headers, {
      from: envelopeFrom,
      to: envelopeTo,
    })
    if (!synth.ok) {
      return Response.json({
        ok: true,
        message_id: messageId,
        dropped: synth.error,
      })
    }
    const matches = findMatching(emailTriggers, event, null)
    const dispatched: string[] = []
    const skipped: SkippedDispatch[] = []
    for (const t of matches) {
      const senderReason = evaluateIgnoreAuthors(t.ignore_authors, ghSender)
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
