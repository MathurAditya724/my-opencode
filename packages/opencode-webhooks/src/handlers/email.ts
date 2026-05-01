// Fetch handler for POST /webhooks/email. The Cloudflare email worker
// HMAC-signs a small JSON event (see EmailEvent in email/identity.ts)
// and POSTs it here. We re-verify the allowlist (defense-in-depth),
// identify the referenced GitHub entity from Message-ID/In-Reply-To/
// References, fetch canonical state via `gh`, and drive the same
// dispatcher the github handler uses.
//
// Synthesized event is "email.<reason>" where <reason> is the
// X-GitHub-Reason header (lowercased): mention, review_requested,
// assign, comment, …

import type { Dispatcher } from "../dispatch"
import {
  type AllowlistPattern,
  extractAddress,
  matchesAllowlist,
} from "../email/allowlist"
import { type EmailEvent, identifyEmail } from "../email/identity"
import { synthesizePayload } from "../email/synthesize"
import { verifySha256Signature } from "../hmac"
import { computeSynthetics, readBodyBytes } from "../http"
import { evaluateAndDispatch } from "../matchers"
import type { DeliveryStore } from "../storage"
import { lookupString } from "../template"
import type { NormalizedTrigger } from "../types"

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

  return async function fetch(req) {
    if (!emailSecret) {
      return Response.json(
        { error: "no email HMAC secret configured on server" },
        { status: 503 },
      )
    }

    // Read body as raw bytes — JSON.stringify in the worker produces
    // bytes, and HMAC must be over the exact bytes received (not a
    // re-serialized JSON.stringify(JSON.parse(…)) which is allowed to
    // re-order keys).
    const body = await readBodyBytes(req)
    if (!body.ok) return body.response

    const signature = req.headers.get("x-email-signature-256")
    if (!verifySha256Signature(body.bytes, signature, emailSecret)) {
      return Response.json({ error: "invalid signature" }, { status: 401 })
    }

    let event: EmailEvent
    try {
      event = parseEmailEvent(new TextDecoder("utf-8").decode(body.bytes))
    } catch (err) {
      return Response.json(
        { error: "invalid event body", detail: String(err) },
        { status: 400 },
      )
    }

    if (!event.from) {
      return Response.json(
        { error: "missing 'from' in event" },
        { status: 400 },
      )
    }
    if (!event.message_id) {
      return Response.json(
        { error: "missing 'message_id' in event" },
        { status: 400 },
      )
    }

    // Defense-in-depth: re-check the worker's allowlist on the server.
    if (allowlist.length > 0 && !matchesAllowlist(event.from, allowlist)) {
      return Response.json(
        { error: "sender not in allowlist", from: extractAddress(event.from) },
        { status: 403 },
      )
    }

    // Self-loop guard: drop notifications about the bot's own activity
    // before doing any GitHub API work. x_github_sender is the github
    // login of whoever performed the action.
    const ghSender = event.x_github_sender
    if (
      botLogin &&
      ghSender &&
      ghSender.toLowerCase() === botLogin.toLowerCase()
    ) {
      return Response.json({
        ok: true,
        message_id: event.message_id,
        dropped: "self-loop",
        sender: ghSender,
      })
    }

    const identity = identifyEmail(event)
    if (identity.kind === "unknown") {
      return Response.json({
        ok: true,
        message_id: event.message_id,
        dropped: "unknown-message-id",
      })
    }

    const reason = (event.x_github_reason ?? "subscribed").toLowerCase()
    const triggerEvent = `email.${reason}`
    const dedupKey = `email:${event.message_id}`

    // Synthesize BEFORE dedup: if `gh api` fails (network blip, rate
    // limit), we need Cloudflare to retry. Inserting the dedup row
    // first would both swallow the retry AND return 200, losing the
    // email permanently.
    const synth = await synthesizePayload(identity, event, reason)
    if (!synth.ok) {
      return Response.json({
        ok: true,
        message_id: event.message_id,
        dropped: synth.error,
      })
    }

    // Idempotency: dedup by Message-ID, namespaced so it can never
    // collide with GitHub's UUID delivery_ids.
    const inserted = store.insert(dedupKey, triggerEvent, null)
    if (inserted) store.trim(retention)
    if (!inserted) {
      return Response.json({
        ok: true,
        message_id: event.message_id,
        duplicate: true,
        dispatched: [],
      })
    }

    // API-fetched login is the trustworthy source for self-loop
    // suppression; the email-header fallback is best-effort.
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

    return Response.json({
      ok: true,
      message_id: event.message_id,
      event: triggerEvent,
      duplicate: false,
      dispatched,
      ...(skipped.length > 0 ? { skipped } : {}),
    })
  }
}

// Validate + normalize the JSON body the worker posts. Throws on a
// shape mismatch so the handler can return 400 with a useful detail.
function parseEmailEvent(raw: string): EmailEvent {
  const obj = JSON.parse(raw) as unknown
  if (typeof obj !== "object" || obj === null) {
    throw new Error("body is not an object")
  }
  const o = obj as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" ? v : null
  return {
    from: str(o.from),
    to: str(o.to),
    subject: str(o.subject),
    message_id: str(o.message_id),
    in_reply_to: strOrNull(o.in_reply_to),
    references: Array.isArray(o.references)
      ? o.references.filter((s): s is string => typeof s === "string")
      : [],
    list_id: strOrNull(o.list_id),
    x_github_reason: strOrNull(o.x_github_reason),
    x_github_sender: strOrNull(o.x_github_sender),
  }
}
