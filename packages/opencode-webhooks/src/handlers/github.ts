// Hono handler for POST /webhooks/github. Verifies HMAC, dedupes by
// X-GitHub-Delivery, runs the trigger pipeline, and dispatches.

import type { Context } from "hono"
import type { AppEnv } from "../handler"
import { verifyGithubSignature } from "../hmac"
import { readBodyBytes } from "../http"
import { evaluateAndDispatch } from "../matchers"
import { lookupString } from "../template"

export async function githubWebhookHandler(c: Context<AppEnv>) {
  const secret = c.get("secret")
  const triggers = c.get("githubTriggers")
  const store = c.get("store")
  const retention = c.get("retention")
  const pipeline = c.get("pipeline")
  const botLogin = c.get("botLogin")

  if (!secret) {
    return c.json({ error: "no HMAC secret configured on server" }, 503)
  }

  // GitHub always sends both headers; refuse otherwise.
  const event = c.req.header("x-github-event")
  const deliveryId = c.req.header("x-github-delivery")
  if (!event || !deliveryId) {
    return c.json(
      { error: "missing required headers (x-github-event, x-github-delivery)" },
      400,
    )
  }

  const body = await readBodyBytes(c.req.raw)
  if (!body.ok) return body.response

  const rawBody = new TextDecoder("utf-8").decode(body.bytes)
  const signature = c.req.header("x-hub-signature-256") ?? null
  if (!verifyGithubSignature(rawBody, signature, secret)) {
    return c.json({ error: "invalid signature" }, 401)
  }

  let payload: unknown = {}
  let action: string | null = null
  try {
    payload = JSON.parse(rawBody)
    const a = (payload as { action?: unknown }).action
    if (typeof a === "string") action = a
  } catch {
    // Not JSON — dispatch with empty payload.
  }

  // Idempotency: dedup by X-GitHub-Delivery. insert() returns a UUID
  // delivery_id on success, or null if the external key already exists.
  const externalId = deliveryId
  const newDeliveryId = store.insert(externalId, event, action)
  if (newDeliveryId) store.trim(retention)
  if (!newDeliveryId) {
    return c.json({
      ok: true,
      external_id: externalId,
      duplicate: true,
      dispatched: [],
    })
  }

  const { dispatched, skipped } = evaluateAndDispatch({
    triggers,
    event,
    action,
    payload,
    sender: lookupString(payload, "sender.login"),
    botLogin,
    deliveryId: newDeliveryId,
    templateContext: {
      event,
      action,
      delivery_id: newDeliveryId,
      payload,
    },
    pipeline,
    store,
  })

  return c.json({
    ok: true,
    delivery_id: newDeliveryId,
    external_id: externalId,
    event,
    action,
    duplicate: false,
    dispatched,
    ...(skipped.length > 0 ? { skipped } : {}),
  })
}
