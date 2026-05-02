// Hono handler for POST /webhooks/email. The Cloudflare email worker
// HMAC-signs a small JSON event (see EmailEvent in email/identity.ts)
// and POSTs it here. We re-verify the allowlist (defense-in-depth),
// identify the referenced GitHub entity from Message-ID/In-Reply-To/
// References, fetch canonical state via `gh`, and drive the same
// dispatcher the github handler uses.
//
// Synthesized event is "email.<reason>" where <reason> is the
// X-GitHub-Reason header (lowercased): mention, review_requested,
// assign, comment, …

import type { Context } from "hono"
import type { AppEnv } from "../handler"
import {
  extractAddress,
  matchesAllowlist,
} from "../email/allowlist"
import { type EmailEvent, identifyEmail } from "../email/identity"
import { synthesizePayload } from "../email/synthesize"
import { verifySha256Signature } from "../hmac"
import { MAX_EMAIL_BODY_BYTES, computeSynthetics, readBodyBytes } from "../http"
import { evaluateAndDispatch } from "../matchers"
import { lookupString } from "../template"

export async function emailWebhookHandler(c: Context<AppEnv>) {
  const emailSecret = c.get("emailSecret")
  const allowlist = c.get("emailAllowlist")
  const triggers = c.get("emailTriggers")
  const store = c.get("store")
  const retention = c.get("retention")
  const dispatch = c.get("dispatch")
  const botLogin = c.get("botLogin")

  if (!emailSecret) {
    return c.json({ error: "no email HMAC secret configured on server" }, 503)
  }

  // Read body as raw bytes for HMAC verification — must match the
  // exact bytes the worker signed, not a re-serialized version.
  const body = await readBodyBytes(c.req.raw, MAX_EMAIL_BODY_BYTES)
  if (!body.ok) return body.response

  const signature = c.req.header("x-email-signature-256") ?? null
  if (!verifySha256Signature(body.bytes, signature, emailSecret)) {
    return c.json({ error: "invalid signature" }, 401)
  }

  let event: EmailEvent
  try {
    event = parseEmailEvent(new TextDecoder("utf-8").decode(body.bytes))
  } catch (err) {
    return c.json(
      { error: "invalid event body", detail: String(err) },
      400,
    )
  }

  if (!event.from) {
    return c.json({ error: "missing 'from' in event" }, 400)
  }
  if (!event.message_id) {
    return c.json({ error: "missing 'message_id' in event" }, 400)
  }

  // Defense-in-depth: re-check the email worker's ALLOWED_SENDERS.
  if (allowlist.length > 0 && !matchesAllowlist(event.from, allowlist)) {
    return c.json(
      { error: "sender not in allowlist", from: extractAddress(event.from) },
      403,
    )
  }

  // Self-loop guard: drop emails triggered by the bot's own activity.
  const ghSender = event.x_github_sender
  if (
    botLogin &&
    ghSender &&
    ghSender.toLowerCase() === botLogin.toLowerCase()
  ) {
    return c.json({
      ok: true,
      message_id: event.message_id,
      dropped: "self-loop",
      sender: ghSender,
    })
  }

  const identity = identifyEmail(event)
  if (identity.kind === "unknown") {
    return c.json({
      ok: true,
      message_id: event.message_id,
      dropped: "unknown-message-id",
    })
  }

  const reason = (event.x_github_reason ?? "subscribed").toLowerCase()
  const triggerEvent = `email.${reason}`
  const dedupKey = `email:${event.message_id}`

  // Synthesize BEFORE dedup — gh api fetch is idempotent, and we
  // need the payload to evaluate payload_filter on the triggers.
  const synth = await synthesizePayload(identity, event, reason)
  if (!synth.ok) {
    return c.json({
      ok: true,
      message_id: event.message_id,
      dropped: synth.error,
    })
  }

  // Idempotency: dedup by Message-ID.
  const inserted = store.insert(dedupKey, triggerEvent, null)
  if (inserted) store.trim(retention)
  if (!inserted) {
    return c.json({
      ok: true,
      message_id: event.message_id,
      duplicate: true,
      dispatched: [],
    })
  }

  const senderForIgnore =
    lookupString(synth.payload, "comment.user.login") ??
    lookupString(synth.payload, "review.user.login") ??
    ghSender

  const synthetics = computeSynthetics(synth.payload)
  const { dispatched, skipped } = evaluateAndDispatch({
    triggers,
    event: triggerEvent,
    action: null,
    payload: synth.payload,
    sender: senderForIgnore,
    botLogin,
    deliveryId: dedupKey,
    templateContext: {
      event: triggerEvent,
      action: null,
      delivery_id: dedupKey,
      payload: synth.payload,
      ...synthetics,
    },
    dispatch,
  })

  return c.json({
    ok: true,
    message_id: event.message_id,
    event: triggerEvent,
    duplicate: false,
    dispatched,
    ...(skipped.length > 0 ? { skipped } : {}),
  })
}

function parseEmailEvent(raw: string): EmailEvent {
  const obj = JSON.parse(raw) as unknown
  if (typeof obj !== "object" || obj === null) {
    throw new Error("body is not an object")
  }
  const o = obj as Record<string, unknown>
  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string") {
      throw new Error(`field '${name}' must be a string, got ${typeof v}`)
    }
    return v
  }
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" ? v : null
  return {
    from: str(o.from, "from"),
    to: str(o.to, "to"),
    subject: str(o.subject, "subject"),
    message_id: str(o.message_id, "message_id"),
    in_reply_to: strOrNull(o.in_reply_to),
    references: Array.isArray(o.references)
      ? o.references.filter((s): s is string => typeof s === "string")
      : [],
    list_id: strOrNull(o.list_id),
    x_github_reason: strOrNull(o.x_github_reason),
    x_github_sender: strOrNull(o.x_github_sender),
  }
}
