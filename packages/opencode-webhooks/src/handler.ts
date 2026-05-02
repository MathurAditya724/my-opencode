// Hono app for the plugin's HTTP listener. Routes: healthz, delivery
// read endpoints, entity/stats API, dashboard pages, and one webhook
// ingest per source — sharing the same store, pipeline, and trigger
// config. Per-route logic lives under ./handlers/.
//
// Triggers are split by `source` here once so the handlers don't need
// to know about other ingest paths.

import { Hono, type Context } from "hono"
import * as Sentry from "@sentry/bun"
import type { AllowlistPattern } from "./email/allowlist"
import {
  getDeliveryHandler,
  listDeliveriesHandler,
} from "./handlers/deliveries"
import {
  listEntitiesHandler,
  getEntityHandler,
  getStatsHandler,
  retryDispatchHandler,
  dashboardRetryHandler,
} from "./handlers/entities"
import {
  dashboardOverviewHandler,
  dashboardEntityHandler,
} from "./handlers/dashboard"
import { githubWebhookHandler } from "./handlers/github"
import { emailWebhookHandler } from "./handlers/email"
import type { Pipeline } from "./pipeline"
import type { DeliveryStore } from "./storage"
import type { NormalizedTrigger } from "./types"

export type AppEnv = {
  Variables: {
    secret: string
    emailSecret: string
    emailAllowlist: AllowlistPattern[]
    store: DeliveryStore
    retention: number
    pipeline: Pipeline
    botLogin: string | null
    githubTriggers: NormalizedTrigger[]
    emailTriggers: NormalizedTrigger[]
  }
}

export function createApp(opts: {
  secret: string
  emailSecret: string
  emailAllowlist: AllowlistPattern[]
  triggers: NormalizedTrigger[]
  store: DeliveryStore
  retention: number
  pipeline: Pipeline
  botLogin: string | null
}): Hono<AppEnv> {
  const githubTriggers = opts.triggers.filter(
    (t) => t.source === "github_webhook",
  )
  const emailTriggers = opts.triggers.filter((t) => t.source === "email")

  const app = new Hono<AppEnv>()

  app.onError((err, c) => {
    Sentry.captureException(err)
    console.error("[opencode-webhooks] unhandled route error:", err)
    return c.json({ error: "internal server error" }, 500)
  })

  app.get("/healthz", (c) => {
    return c.json({ ok: true, plugin: "opencode-webhooks" })
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

  // Inject store for read-only routes (deliveries, entities, stats, dashboard).
  const storeMiddleware = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    c.set("store", opts.store)
    await next()
  }

  // --- JSON API routes ---

  app.use("/deliveries", storeMiddleware)
  app.use("/deliveries/*", storeMiddleware)
  app.get("/deliveries", listDeliveriesHandler)
  app.get("/deliveries/:id", getDeliveryHandler)

  // Inject store + pipeline for API routes that need dispatch capabilities.
  const dispatchMiddleware = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    c.set("store", opts.store)
    c.set("pipeline", opts.pipeline)
    await next()
  }

  app.use("/api/*", storeMiddleware)
  app.get("/api/entities", listEntitiesHandler)
  app.get("/api/entities/:key", getEntityHandler)
  app.get("/api/stats", getStatsHandler)

  app.use("/api/dispatches/*", dispatchMiddleware)
  app.post("/api/dispatches/:id/retry", retryDispatchHandler)

  // --- Dashboard pages (server-rendered HTML) ---

  app.use("/dashboard", storeMiddleware)
  app.use("/dashboard/*", storeMiddleware)
  app.get("/dashboard", dashboardOverviewHandler)
  app.get("/dashboard/entities", (c) => c.redirect("/dashboard"))
  app.get("/dashboard/entities/:key", dashboardEntityHandler)

  // Dashboard retry: POST form action that retries and redirects back.
  app.use("/dashboard/dispatches/*", dispatchMiddleware)
  app.post("/dashboard/dispatches/:id/retry", dashboardRetryHandler)

  // Redirect root to dashboard for convenience.
  app.get("/", (c) => c.redirect("/dashboard"))

  // --- Webhook ingest routes ---

  app.use("/webhooks/*", async (c, next) => {
    c.set("secret", opts.secret)
    c.set("emailSecret", opts.emailSecret)
    c.set("emailAllowlist", opts.emailAllowlist)
    c.set("store", opts.store)
    c.set("retention", opts.retention)
    c.set("pipeline", opts.pipeline)
    c.set("botLogin", opts.botLogin)
    c.set("githubTriggers", githubTriggers)
    c.set("emailTriggers", emailTriggers)
    await next()
  })

  app.post("/webhooks/github", githubWebhookHandler)
  app.post("/webhooks/email", emailWebhookHandler)

  return app
}
