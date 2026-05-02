// Hono handler for POST /webhooks/github. Verifies HMAC, dedupes by
// X-GitHub-Delivery, runs the trigger pipeline, and dispatches.

import type { Context } from "hono"
import * as Sentry from "@sentry/bun"
import type { AppEnv } from "../handler"
import { verifyGithubSignature } from "../hmac"
import { readBodyBytes } from "../http"
import { evaluateAndDispatch } from "../matchers"
import { lookupString } from "../template"

export async function githubWebhookHandler(c: Context<AppEnv>) {
  const secret = c.get("secret")
  const triggers = c.get("githubTriggers")
  const dedup = c.get("dedup")
  const pipeline = c.get("pipeline")
  const botLogin = c.get("botLogin")

  if (!secret) {
    return c.json({ error: "no HMAC secret configured on server" }, 503)
  }

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
    // Not JSON -- dispatch with empty payload.
  }

  if (dedup.seen(deliveryId)) {
    return c.json({ ok: true, delivery_id: deliveryId, duplicate: true, dispatched: [] })
  }

  Sentry.logger.info("webhook.received", {
    source: "github",
    event,
    action: action ?? "",
    delivery_id: deliveryId,
    sender: lookupString(payload, "sender.login") ?? "",
    repo: lookupString(payload, "repository.full_name") ?? "",
  })

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
    },
    pipeline,
  })

  return c.json({
    ok: true,
    delivery_id: deliveryId,
    event,
    action,
    duplicate: false,
    dispatched,
    ...(skipped.length > 0 ? { skipped } : {}),
  })
}
