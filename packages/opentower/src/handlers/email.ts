// Hono handler for POST /webhooks/email. The Cloudflare email worker
// reads the raw RFC822 message, extracts headers and body (text + HTML),
// HMAC-signs the JSON payload, and POSTs it here.
//
// This handler is intentionally simple: verify HMAC, dedup by
// message_id, and pass the full email content to the agent. The agent
// decides what to do.

import * as Sentry from "@sentry/bun"
import type { Context } from "hono"
import type { AppEnv } from "../handler"
import { verifySha256Signature } from "../hmac"
import { MAX_EMAIL_BODY_BYTES, readBodyBytes } from "../http"
import { evaluateAndDispatch } from "../matchers"

// GitHub notification reasons that cannot cause a feedback loop when the
// sender matches the bot. CI results, security alerts, and similar
// automated notifications are safe to process even from the bot's own
// account — the bot responding to them won't generate another email of
// the same kind.
const SELF_LOOP_SAFE_REASONS: ReadonlySet<string> = new Set(["ci_activity", "security_alert"])

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
  body_text: string | null
  body_html: string | null
}

export async function emailWebhookHandler(c: Context<AppEnv>) {
  const emailSecret = c.get("emailSecret")
  const triggers = c.get("emailTriggers")
  const dedup = c.get("dedup")
  const pipeline = c.get("pipeline")
  const botLogin = c.get("botLogin")

  if (!emailSecret) {
    return c.json({ error: "no email HMAC secret configured on server" }, 503)
  }

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
    return c.json({ error: "invalid event body", detail: String(err) }, 400)
  }

  if (!event.from) {
    return c.json({ error: "missing 'from' in event" }, 400)
  }
  if (!event.message_id) {
    return c.json({ error: "missing 'message_id' in event" }, 400)
  }

  const ghSender = event.x_github_sender
  const reason = (event.x_github_reason ?? "forwarded").toLowerCase()
  const triggerEvent = `email.${reason}`

  // Self-loop guard: drop emails triggered by the bot's own activity,
  // but only for reasons that can actually cause feedback loops.
  // Automated notifications like CI results are safe — responding to
  // a CI failure won't generate another CI email.
  if (
    botLogin &&
    ghSender &&
    ghSender.toLowerCase() === botLogin.toLowerCase() &&
    !SELF_LOOP_SAFE_REASONS.has(reason)
  ) {
    return c.json({
      ok: true,
      message_id: event.message_id,
      dropped: "self-loop",
      sender: ghSender,
    })
  }

  const dedupKey = `email:${event.message_id}`
  if (dedup.seen(dedupKey)) {
    return c.json({
      ok: true,
      message_id: event.message_id,
      duplicate: true,
      dispatched: [],
    })
  }
  const deliveryId = crypto.randomUUID()

  Sentry.logger.info("webhook.received", {
    source: "email",
    event: triggerEvent,
    delivery_id: deliveryId,
    from: event.from,
    to: event.to,
    subject: event.subject,
    message_id: event.message_id,
    x_github_reason: event.x_github_reason ?? "",
    x_github_sender: event.x_github_sender ?? "",
  })

  const emailPayload = {
    from: event.from,
    to: event.to,
    subject: event.subject,
    message_id: event.message_id,
    in_reply_to: event.in_reply_to,
    references: event.references,
    list_id: event.list_id,
    x_github_reason: event.x_github_reason,
    x_github_sender: event.x_github_sender,
    body_text: event.body_text,
    body_html: event.body_html,
  }

  const entityResolver = c.get("entityResolver")
  const { dispatched, skipped } = await evaluateAndDispatch({
    triggers,
    event: triggerEvent,
    action: null,
    payload: emailPayload,
    sender: ghSender,
    botLogin,
    deliveryId,
    templateContext: {
      event: triggerEvent,
      action: null,
      delivery_id: deliveryId,
      payload: emailPayload,
    },
    pipeline,
    entityResolver,
  })

  return c.json({
    ok: true,
    delivery_id: deliveryId,
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
  const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null)
  return {
    from: str(o.from, "from"),
    to: str(o.to, "to"),
    subject: str(o.subject, "subject"),
    message_id: str(o.message_id, "message_id"),
    in_reply_to: strOrNull(o.in_reply_to),
    references: Array.isArray(o.references) ? o.references.filter((s): s is string => typeof s === "string") : [],
    list_id: strOrNull(o.list_id),
    x_github_reason: strOrNull(o.x_github_reason),
    x_github_sender: strOrNull(o.x_github_sender),
    body_text: strOrNull(o.body_text),
    body_html: strOrNull(o.body_html),
  }
}
