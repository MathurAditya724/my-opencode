// Hono handlers for the dashboard API. Three routes:
//   GET /entities         — paginated entity list with latest status
//   GET /entities/:key    — single entity timeline
//   GET /stats            — aggregate dashboard stats
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
