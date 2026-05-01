// Fetch handler factory. Closes over the secret, dispatcher, store,
// triggers, and bot identity so the Bun.serve config stays small.

import type { Dispatcher } from "./dispatch"
import {
  evaluateBotMatch,
  evaluateIgnoreAuthors,
  evaluatePayloadFilter,
  findMatching,
} from "./matchers"
import type { DeliveryStore } from "./storage"
import { lookup, renderTemplate } from "./template"
import type { NormalizedTrigger, SkippedDispatch } from "./types"
import { verifyGithubSignature } from "./hmac"

const MAX_BODY_BYTES = 25 * 1024 * 1024 // GitHub's webhook payload cap

export function makeFetchHandler(opts: {
  secret: string
  triggers: NormalizedTrigger[]
  store: DeliveryStore
  retention: number
  dispatch: Dispatcher
  botLogin: string | null
}): (req: Request) => Promise<Response> {
  const { secret, triggers, store, retention, dispatch, botLogin } = opts

  return async function fetch(req) {
    const url = new URL(req.url)

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, plugin: "github-webhooks" })
    }
    if (req.method !== "POST" || url.pathname !== "/webhooks/github") {
      return new Response("not found", { status: 404 })
    }

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

    // Body size cap (matches GitHub's 25 MB limit). Check both
    // declared and actual length to defend against lying clients.
    const declaredLength = Number(req.headers.get("content-length") ?? "0")
    if (declaredLength > MAX_BODY_BYTES) {
      return Response.json({ error: "payload too large" }, { status: 413 })
    }
    const rawBody = await req.text()
    if (rawBody.length > MAX_BODY_BYTES) {
      return Response.json({ error: "payload too large" }, { status: 413 })
    }
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

    const senderLogin =
      typeof payload === "object" && payload !== null
        ? (payload as { sender?: { login?: unknown } }).sender?.login
        : undefined
    const sender = typeof senderLogin === "string" ? senderLogin : null

    const synthetics = computeSynthetics(payload)

    const matches = findMatching(triggers, event, action)
    const dispatched: string[] = []
    const skipped: SkippedDispatch[] = []
    for (const t of matches) {
      // 1. Sender filter (self-loop guard).
      const senderReason = evaluateIgnoreAuthors(t.ignore_authors, sender)
      if (senderReason) {
        skipped.push({ name: t.name, reason: senderReason })
        continue
      }
      // 2. Identity gate (is this work for the bot?).
      const botMatchReason = evaluateBotMatch(
        t.require_bot_match,
        payload,
        botLogin,
      )
      if (botMatchReason) {
        skipped.push({ name: t.name, reason: botMatchReason })
        continue
      }
      // 3. Payload-shape filter.
      const filterReason = evaluatePayloadFilter(t.payload_filter, payload)
      if (filterReason) {
        skipped.push({ name: t.name, reason: filterReason })
        continue
      }

      const prompt = renderTemplate(t.prompt_template, {
        event,
        action,
        delivery_id: deliveryId,
        payload,
        ...synthetics,
      })
      // Fire-and-forget; dispatch owns its errors.
      void dispatch(t, prompt, deliveryId)
      dispatched.push(t.name)
    }

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

// Booleans surfaced into prompt templates that the path-only renderer
// can't evaluate (presence checks, non-empty checks, lowercased values).
function computeSynthetics(payload: unknown): Record<string, unknown> {
  const ev = (payload as Record<string, unknown> | null) ?? {}
  const issuePR = lookup(ev, "issue.pull_request")
  const reviewBody = lookup(ev, "review.body")
  const reviewState = lookup(ev, "review.state")
  const checkConclusion =
    lookup(ev, "check_suite.conclusion") ?? lookup(ev, "check_run.conclusion")
  return {
    is_pr_comment:
      issuePR !== undefined && issuePR !== null && issuePR !== "",
    is_review_with_body:
      typeof reviewBody === "string" && reviewBody.trim() !== "",
    review_state:
      typeof reviewState === "string" ? reviewState.toLowerCase() : null,
    is_ci_failure: checkConclusion === "failure",
  }
}
