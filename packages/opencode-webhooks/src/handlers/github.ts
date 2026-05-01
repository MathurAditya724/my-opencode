// Fetch handler for POST /webhooks/github. Verifies HMAC, dedupes by
// X-GitHub-Delivery, runs the standard ignore_authors / require_bot_match
// / payload_filter pipeline, renders the prompt, and dispatches.

import type { Dispatcher } from "../dispatch"
import { verifyGithubSignature } from "../hmac"
import { readBodyBytes, computeSynthetics } from "../http"
import { evaluateAndDispatch } from "../matchers"
import type { DeliveryStore } from "../storage"
import { lookupString } from "../template"
import type { NormalizedTrigger } from "../types"

export function makeGithubFetchHandler(opts: {
  secret: string
  triggers: NormalizedTrigger[]
  store: DeliveryStore
  retention: number
  dispatch: Dispatcher
  botLogin: string | null
}): (req: Request) => Promise<Response> {
  const { secret, triggers, store, retention, dispatch, botLogin } = opts

  return async function fetch(req) {
    if (!secret) {
      return Response.json(
        { error: "no HMAC secret configured on server" },
        { status: 503 },
      )
    }

    // GitHub always sends both headers; refuse otherwise.
    const event = req.headers.get("x-github-event")
    const deliveryId = req.headers.get("x-github-delivery")
    if (!event || !deliveryId) {
      return Response.json(
        {
          error:
            "missing required headers (x-github-event, x-github-delivery)",
        },
        { status: 400 },
      )
    }

    const body = await readBodyBytes(req)
    if (!body.ok) return body.response
    const rawBody = new TextDecoder("utf-8").decode(body.bytes)

    const signature = req.headers.get("x-hub-signature-256")
    if (!verifyGithubSignature(rawBody, signature, secret)) {
      return Response.json({ error: "invalid signature" }, { status: 401 })
    }

    let payload: unknown = {}
    let action: string | null = null
    try {
      payload = JSON.parse(rawBody)
      const a = (payload as { action?: unknown }).action
      if (typeof a === "string") action = a
    } catch {
      // Not JSON — keep the raw bytes, dispatch with empty payload.
    }

    // Idempotency: dedup by X-GitHub-Delivery.
    const inserted = store.insert(deliveryId, event, action)
    if (inserted) store.trim(retention)
    if (!inserted) {
      return Response.json({
        ok: true,
        delivery_id: deliveryId,
        duplicate: true,
        dispatched: [],
      })
    }

    const synthetics = computeSynthetics(payload)
    const { dispatched, skipped } = evaluateAndDispatch({
      triggers,
      event,
      action,
      payload,
      sender: lookupString(payload, "sender.login"),
      botLogin,
      deliveryId,
      templateContext: {
        event,
        action,
        delivery_id: deliveryId,
        payload,
        ...synthetics,
      },
      dispatch,
    })

    return Response.json({
      ok: true,
      delivery_id: deliveryId,
      event,
      action,
      duplicate: false,
      dispatched,
      ...(skipped.length > 0 ? { skipped } : {}),
    })
  }
}
