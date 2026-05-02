// Hono handlers for the server-rendered dashboard pages.
// These call component functions directly (not as JSX) to avoid
// "No renderer found" errors when the jsxImportSource pragma
// isn't resolved in node_modules at runtime.

import type { Context } from "hono"
import type { AppEnv } from "../handler"
import { OverviewPage } from "../dashboard/overview"
import { EntityDetailPage } from "../dashboard/entity-detail"

export function dashboardOverviewHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const stats = store.getStats()

  // Get recent entities for the activity feed.
  const { rows: recentEntities } = store.listEntities({ limit: 20 })
  const recent = recentEntities.map((r) => ({
    entity_key: r.entity_key,
    event: r.last_event,
    action: r.last_action,
    status: r.last_status,
    outcome: r.last_outcome,
    started_at: r.last_activity,
    trigger_name: "",
  }))

  return c.html(OverviewPage({ stats, recent }))
}

export function dashboardEntityHandler(c: Context<AppEnv>) {
  const store = c.get("store")
  const key = c.req.param("key")
  if (!key) return c.text("missing entity key", 400)

  const decoded = decodeURIComponent(key)
  const result = store.getEntity(decoded)
  if (!result) {
    return c.text(`entity not found: ${decoded}`, 404)
  }

  return c.html(EntityDetailPage({
    entity_key: result.entity_key,
    session_id: result.session_id,
    events: result.events,
  }))
}
