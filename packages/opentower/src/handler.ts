// Hono app for the opentower HTTP listener. Routes: healthz, webhook
// ingest (delegated to WebhookHandlers), JSON API, and static
// dashboard serving. Per-route logic lives under ./handlers/.

import { timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import * as Sentry from "@sentry/bun"
import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { cors } from "hono/cors"
import type { CronScheduler } from "./cron"
import { apiDispatchesHandler, apiEntitiesHandler, apiEntityDetailHandler, apiStatsHandler } from "./handlers/api"
import { makeCronHandlers } from "./handlers/cron"
import type { HandlerContext, WebhookHandler } from "./interfaces"
import type { LifecycleStore } from "./storage"

export type AppEnv = {
  Variables: {
    store: LifecycleStore
  }
}

function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function createApp(opts: {
  handlers: WebhookHandler[]
  handlerContext: HandlerContext
  store: LifecycleStore
  apiToken: string
  cronScheduler: CronScheduler | null
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // CORS -- allows the dashboard SPA (e.g. localhost:5173) to reach
  // all routes including /healthz and /api/*.
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 86400,
    }),
  )

  app.onError((err, c) => {
    Sentry.captureException(err)
    console.error("[opentower] unhandled route error:", err)
    return c.json({ error: "internal server error" }, 500)
  })

  app.get("/healthz", (c) => {
    return c.json({ ok: true, plugin: "opentower" })
  })

  // Sentry middleware: isolate each request into its own scope.
  app.use("*", async (c, next) => {
    await Sentry.withIsolationScope(async (scope) => {
      const method = c.req.method
      const path = new URL(c.req.url).pathname

      scope.setTag("http.method", method)
      scope.setTag("http.route", path)

      const deliveryId = c.req.header("x-github-delivery")
      if (deliveryId) scope.setTag("delivery.id", deliveryId)
      const event = c.req.header("x-github-event")
      if (event) scope.setTag("github.event", event)

      await Sentry.startSpan(
        {
          op: "http.server",
          name: `${method} ${path}`,
          attributes: {
            "http.method": method,
            "http.route": path,
            ...(deliveryId ? { "delivery.id": deliveryId } : {}),
            ...(event ? { "github.event": event } : {}),
          },
        },
        async (span) => {
          await next()
          const status = c.res.status
          span.setAttribute("http.status_code", status)
          span.setStatus({ code: status >= 400 ? 2 : 1 })
        },
      )
    })
  })

  // Register all webhook handlers. Each handler adds its own routes.
  for (const handler of opts.handlers) {
    handler.register(app, opts.handlerContext)
  }

  // --- Dashboard JSON API ---

  app.use("/api/*", async (c, next) => {
    if (!opts.apiToken) {
      return c.json({ error: "API not configured (OPENTOWER_API_TOKEN not set)" }, 503)
    }
    const authHeader = c.req.header("authorization") ?? ""
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (!token || !safeTokenCompare(token, opts.apiToken)) {
      return c.json({ error: "unauthorized" }, 401)
    }
    c.set("store", opts.store)
    await next()
  })

  app.get("/api/stats", apiStatsHandler)
  app.get("/api/entities", apiEntitiesHandler)
  app.get("/api/entities/:key", apiEntityDetailHandler)
  app.get("/api/dispatches", apiDispatchesHandler)

  // Cron job management routes
  if (opts.cronScheduler) {
    const cronHandlers = makeCronHandlers(opts.cronScheduler)
    app.get("/api/cron", cronHandlers.list)
    app.post("/api/cron", cronHandlers.create)
    app.get("/api/cron/:id", cronHandlers.get)
    app.put("/api/cron/:id", cronHandlers.update)
    app.delete("/api/cron/:id", cronHandlers.delete)
    app.post("/api/cron/:id/trigger", cronHandlers.trigger)
    app.get("/api/cron/:id/executions", cronHandlers.executions)
  }

  // --- Static dashboard serving ---
  // Serve bundled dashboard from ./public if it exists
  const publicDir = resolve(import.meta.dirname, "../public")
  if (existsSync(publicDir)) {
    app.use("/assets/*", serveStatic({ root: publicDir }))
    app.get("*", serveStatic({ root: publicDir, path: "index.html" }))
  }

  return app
}
