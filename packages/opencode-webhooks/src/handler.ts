// Hono app for the plugin's HTTP listener. Three routes — healthz +
// one per ingest source — sharing the same dispatcher, store, and
// trigger config. Per-route logic lives under ./handlers/.
//
// Triggers are split by `source` here once so the handlers don't need
// to know about other ingest paths.

import { Hono } from "hono"
import * as Sentry from "@sentry/bun"
import type { Dispatcher } from "./dispatch"
import type { AllowlistPattern } from "./email/allowlist"
import { githubWebhookHandler } from "./handlers/github"
import { emailWebhookHandler } from "./handlers/email"
import type { DeliveryStore } from "./storage"
import type { NormalizedTrigger } from "./types"

export type AppEnv = {
  Variables: {
    secret: string
    emailSecret: string
    emailAllowlist: AllowlistPattern[]
    store: DeliveryStore
    retention: number
    dispatch: Dispatcher
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
  dispatch: Dispatcher
  botLogin: string | null
}): Hono<AppEnv> {
  const githubTriggers = opts.triggers.filter(
    (t) => t.source === "github_webhook",
  )
  const emailTriggers = opts.triggers.filter((t) => t.source === "email")

  const app = new Hono<AppEnv>()

  // Catch unhandled errors thrown by any route handler. Reports to
  // Sentry with request context already set by the middleware below,
  // then returns a generic 500 so the caller gets a clean signal.
  app.onError((err, c) => {
    Sentry.captureException(err)
    console.error("[opencode-webhooks] unhandled route error:", err)
    return c.json({ error: "internal server error" }, 500)
  })

  // Healthz is registered before the deps middleware — health probes
  // don't need the store, dispatcher, or triggers.
  app.get("/healthz", (c) => {
    return c.json({ ok: true, plugin: "opencode-webhooks" })
  })

  // Sentry middleware: isolate each request into its own scope and
  // wrap it in a span for per-request tracing. Tags set here appear
  // on every Sentry event captured during the request lifecycle.
  app.use("*", async (c, next) => {
    await Sentry.withIsolationScope(async (scope) => {
      const method = c.req.method
      const path = new URL(c.req.url).pathname

      scope.setTag("http.method", method)
      scope.setTag("http.route", path)

      const deliveryId =
        c.req.header("x-github-delivery") ??
        c.req.header("x-email-signature-256")?.slice(0, 12) ??
        undefined
      if (deliveryId) {
        scope.setTag("delivery.id", deliveryId)
      }

      const event = c.req.header("x-github-event")
      if (event) {
        scope.setTag("github.event", event)
      }

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
          if (status >= 400) {
            span.setStatus({ code: 2 })
          } else {
            span.setStatus({ code: 1 })
          }
        },
      )
    })
  })

  // Inject shared deps into context for webhook routes.
  app.use("/webhooks/*", async (c, next) => {
    c.set("secret", opts.secret)
    c.set("emailSecret", opts.emailSecret)
    c.set("emailAllowlist", opts.emailAllowlist)
    c.set("store", opts.store)
    c.set("retention", opts.retention)
    c.set("dispatch", opts.dispatch)
    c.set("botLogin", opts.botLogin)
    c.set("githubTriggers", githubTriggers)
    c.set("emailTriggers", emailTriggers)
    await next()
  })

  app.post("/webhooks/github", githubWebhookHandler)
  app.post("/webhooks/email", emailWebhookHandler)

  return app
}
