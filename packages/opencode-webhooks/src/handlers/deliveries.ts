// Hono handlers for the read API. Two routes:
//   GET /deliveries        — paginated list with per-status counts
//   GET /deliveries/:id    — single delivery + its dispatches
//
// No auth: trusts the deployment's network boundary, same as /healthz.

import type { Context } from "hono"
import type { AppEnv } from "../handler"
import type { DispatchStatus } from "../types"

const VALID_STATUSES: ReadonlySet<DispatchStatus> = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timeout",
])

export function listDeliveriesHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const url = new URL(c.req.url)
  const limitRaw = url.searchParams.get("limit")
  const limit = limitRaw != null ? Number(limitRaw) : undefined
  const cursor = url.searchParams.get("cursor")
  const event = url.searchParams.get("event")
  const statusRaw = url.searchParams.get("status")
  const sinceRaw = url.searchParams.get("since")

  let status: DispatchStatus | null = null
  if (statusRaw) {
    if (!VALID_STATUSES.has(statusRaw as DispatchStatus)) {
      return c.json(
        { error: `invalid status; expected one of ${[...VALID_STATUSES].join(", ")}` },
        400,
      )
    }
    status = statusRaw as DispatchStatus
  }

  let since: number | null = null
  if (sinceRaw) {
    const n = Number(sinceRaw)
    if (!Number.isFinite(n)) {
      return c.json({ error: "invalid 'since'; expected epoch ms" }, 400)
    }
    since = n
  }

  const { rows, next_cursor } = store.listDeliveries({
    limit,
    cursor,
    event,
    status,
    since,
  })
  return c.json({ deliveries: rows, next_cursor })
}

export function getDeliveryHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const id = c.req.param("id")
  if (!id) return c.json({ error: "missing delivery id" }, 400)
  const result = store.getDelivery(id)
  if (!result) {
    return c.json({ error: "delivery not found", delivery_id: id }, 404)
  }
  return c.json(result)
}
