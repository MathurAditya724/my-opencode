// Hono handler for POST /webhooks/junior. Receives webhook payloads
// from Sentry's Junior agent after it creates a GitHub issue.
//
// Junior sends a richer payload than a raw GitHub webhook: it includes
// the issue context plus optional fields like summary, source_channel,
// and labels that aren't in the standard GitHub payload shape.

import type { Context } from "hono"
import * as Sentry from "@sentry/bun"
import type { AppEnv } from "../handler"
import { verifySha256Signature } from "../hmac"
import { MAX_EMAIL_BODY_BYTES, readBodyBytes } from "../http"
import { evaluateAndDispatch } from "../matchers"

export type JuniorEvent = {
  // Required: identifies the target repo and issue.
  repo: string // "owner/repo"
  issue_number: number
  issue_title: string
  issue_body: string
  issue_url: string

  // Optional: extra context Junior can attach.
  summary: string | null // Junior's summary of the issue
  source_channel: string | null // Slack channel that triggered the issue
  labels: string[] // labels applied to the issue
  assignees: string[] // GitHub logins assigned
}

export async function juniorWebhookHandler(c: Context<AppEnv>) {
  const secret = c.get("secret")
  const triggers = c.get("juniorTriggers")
  const dedup = c.get("dedup")
  const pipeline = c.get("pipeline")
  const botLogin = c.get("botLogin")

  if (!secret) {
    return c.json({ error: "no junior HMAC secret configured on server" }, 503)
  }

  const body = await readBodyBytes(c.req.raw, MAX_EMAIL_BODY_BYTES)
  if (!body.ok) return body.response

  const signature = c.req.header("x-junior-signature-256") ?? null
  if (!verifySha256Signature(body.bytes, signature, secret)) {
    return c.json({ error: "invalid signature" }, 401)
  }

  let event: JuniorEvent
  try {
    event = parseJuniorEvent(new TextDecoder("utf-8").decode(body.bytes))
  } catch (err) {
    return c.json(
      { error: "invalid event body", detail: String(err) },
      400,
    )
  }

  const deliveryId = c.req.header("x-junior-delivery") ?? crypto.randomUUID()

  if (dedup.seen(`junior:${deliveryId}`)) {
    return c.json({
      ok: true,
      delivery_id: deliveryId,
      duplicate: true,
      dispatched: [],
    })
  }

  Sentry.logger.info("webhook.received", {
    source: "junior",
    event: "junior.issue_created",
    delivery_id: deliveryId,
    repo: event.repo,
    issue_number: event.issue_number,
    issue_title: event.issue_title,
    source_channel: event.source_channel ?? "",
  })

  const juniorPayload = {
    repo: event.repo,
    issue_number: event.issue_number,
    issue_title: event.issue_title,
    issue_body: event.issue_body,
    issue_url: event.issue_url,
    summary: event.summary,
    source_channel: event.source_channel,
    labels: event.labels,
    assignees: event.assignees,
  }

  const { dispatched, skipped } = evaluateAndDispatch({
    triggers,
    event: "junior.issue_created",
    action: "opened",
    payload: juniorPayload,
    sender: "junior",
    botLogin,
    deliveryId,
    templateContext: {
      event: "junior.issue_created",
      action: "opened",
      delivery_id: deliveryId,
      payload: juniorPayload,
    },
    pipeline,
  })

  return c.json({
    ok: true,
    delivery_id: deliveryId,
    event: "junior.issue_created",
    repo: event.repo,
    issue_number: event.issue_number,
    duplicate: false,
    dispatched,
    ...(skipped.length > 0 ? { skipped } : {}),
  })
}

function parseJuniorEvent(raw: string): JuniorEvent {
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
  const num = (v: unknown, name: string): number => {
    if (typeof v !== "number") {
      throw new Error(`field '${name}' must be a number, got ${typeof v}`)
    }
    return v
  }
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" ? v : null

  return {
    repo: str(o.repo, "repo"),
    issue_number: num(o.issue_number, "issue_number"),
    issue_title: str(o.issue_title, "issue_title"),
    issue_body: str(o.issue_body, "issue_body"),
    issue_url: str(o.issue_url, "issue_url"),
    summary: strOrNull(o.summary),
    source_channel: strOrNull(o.source_channel),
    labels: Array.isArray(o.labels)
      ? o.labels.filter((s): s is string => typeof s === "string")
      : [],
    assignees: Array.isArray(o.assignees)
      ? o.assignees.filter((s): s is string => typeof s === "string")
      : [],
  }
}
