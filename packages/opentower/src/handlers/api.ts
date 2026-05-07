import type { Context } from "hono"
import type { AppEnv } from "../handler"

export function apiStatsHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  return c.json(store.getStats())
}

export function apiEntitiesHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const raw = Number(c.req.query("limit"))
  const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))
  const cursor = c.req.query("cursor") || undefined
  const repo = c.req.query("repo") || undefined
  return c.json(store.listEntities({ limit, cursor, repo }))
}

export function apiEntityDetailHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const key = decodeURIComponent(c.req.param("key") ?? "")
  if (!key) return c.json({ error: "missing entity key" }, 400)
  const entity = store.getEntity(key)
  if (!entity) return c.json({ error: "entity not found" }, 404)
  const dispatches = store.getEntityDispatches(key)
  const links = store.getEntityLinks(key)
  return c.json({ entity, dispatches, links })
}

export function apiDispatchesHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const raw = Number(c.req.query("limit"))
  const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))
  const cursor = c.req.query("cursor") || undefined
  const status = c.req.query("status") || undefined
  const event = c.req.query("event") || undefined
  if (status && !["started", "completed", "failed", "timeout"].includes(status)) {
    return c.json({ error: `invalid status filter: ${status}` }, 400)
  }
  return c.json(store.listDispatches({ limit, cursor, status, event }))
}
