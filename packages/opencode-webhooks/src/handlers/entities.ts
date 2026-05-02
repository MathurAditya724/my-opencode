// Hono handlers for the dashboard API. Three routes:
//   GET /entities         — paginated entity list with latest status
//   GET /entities/:key    — single entity timeline
//   GET /stats            — aggregate dashboard stats
//   POST /api/dispatches/:id/retry — retry a failed/timed-out dispatch
//
// No auth: trusts the deployment's network boundary, same as /healthz.

import type { Context } from "hono"
import type { AppEnv } from "../handler"

export function listEntitiesHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const url = new URL(c.req.url)
  const limitRaw = url.searchParams.get("limit")
  const limit = limitRaw != null ? Number(limitRaw) : undefined
  const cursor = url.searchParams.get("cursor")
  const repo = url.searchParams.get("repo")

  const { rows, next_cursor } = store.listEntities({
    limit,
    cursor,
    repo,
  })
  return c.json({ entities: rows, next_cursor })
}

export function getEntityHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const key = c.req.param("key")
  if (!key) return c.json({ error: "missing entity key" }, 400)

  const decoded = decodeURIComponent(key)
  const result = store.getEntity(decoded)
  if (!result) {
    return c.json({ error: "entity not found", entity_key: decoded }, 404)
  }
  return c.json(result)
}

export function getStatsHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  return c.json(store.getStats())
}

export function retryDispatchHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const pipeline = c.get("pipeline")

  const idParam = c.req.param("id")
  if (!idParam) return c.json({ error: "missing dispatch id" }, 400)
  const dispatchId = Number(idParam)
  if (!Number.isFinite(dispatchId)) return c.json({ error: "invalid dispatch id" }, 400)

  const row = store.getDispatch(dispatchId)
  if (!row) return c.json({ error: "dispatch not found" }, 404)
  if (!row.prompt) return c.json({ error: "no stored prompt — cannot retry" }, 422)
  if (row.status === "running" || row.status === "pending") {
    return c.json({ error: "dispatch is still in progress" }, 409)
  }

  const retryTriggerName = `${row.trigger_name}:retry`
  const newDispatchId = store.createDispatch(
    row.delivery_id,
    retryTriggerName,
    row.matched_event,
    row.agent,
    row.entity_key,
    row.prompt,
  )

  const trigger = {
    name: retryTriggerName,
    source: "github_webhook" as const,
    action: null,
    enabled: true,
    events: [row.matched_event],
    agent: row.agent,
    prompt_template: "",
  }

  if (row.entity_key) {
    pipeline.dispatch(
      { key: row.entity_key, repo: "", number: 0, kind: "issue" as const },
      trigger,
      row.prompt,
      row.delivery_id,
      row.matched_event,
      newDispatchId,
    )
  } else {
    pipeline.dispatchNoAffinity(
      trigger,
      row.prompt,
      row.delivery_id,
      row.matched_event,
      newDispatchId,
    )
  }

  return c.json({
    ok: true,
    original_dispatch_id: dispatchId,
    new_dispatch_id: newDispatchId,
    status: "pending",
  })
}

export function dashboardRetryHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const pipeline = c.get("pipeline")

  const idParam = c.req.param("id")
  if (!idParam) return c.redirect("/dashboard")
  const dispatchId = Number(idParam)
  if (!Number.isFinite(dispatchId)) return c.redirect("/dashboard")

  const row = store.getDispatch(dispatchId)
  if (!row || !row.prompt) return c.redirect("/dashboard")
  if (row.status === "running" || row.status === "pending") {
    const entityKey = row.entity_key
    if (entityKey) {
      return c.redirect(`/dashboard/entities/${encodeURIComponent(entityKey)}`)
    }
    return c.redirect("/dashboard")
  }

  const retryTriggerName = `${row.trigger_name}:retry`
  const newDispatchId = store.createDispatch(
    row.delivery_id,
    retryTriggerName,
    row.matched_event,
    row.agent,
    row.entity_key,
    row.prompt,
  )

  const trigger = {
    name: retryTriggerName,
    source: "github_webhook" as const,
    action: null,
    enabled: true,
    events: [row.matched_event],
    agent: row.agent,
    prompt_template: "",
  }

  if (row.entity_key) {
    pipeline.dispatch(
      { key: row.entity_key, repo: "", number: 0, kind: "issue" as const },
      trigger,
      row.prompt,
      row.delivery_id,
      row.matched_event,
      newDispatchId,
    )
    return c.redirect(`/dashboard/entities/${encodeURIComponent(row.entity_key)}`)
  }

  pipeline.dispatchNoAffinity(
    trigger,
    row.prompt,
    row.delivery_id,
    row.matched_event,
    newDispatchId,
  )
  return c.redirect("/dashboard")
}
