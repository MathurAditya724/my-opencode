// Hono app for the plugin's HTTP listener. Three routes — healthz +
// one per ingest source — sharing the same dispatcher, store, and
// trigger config. Per-route logic lives under ./handlers/.
//
// Triggers are split by `source` here once so the handlers don't need
// to know about other ingest paths.

import { Hono } from "hono"
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

  // Inject shared deps into context for all routes.
  app.use("*", async (c, next) => {
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

  app.get("/healthz", (c) => {
    return c.json({ ok: true, plugin: "opencode-webhooks" })
  })

  app.post("/webhooks/github", githubWebhookHandler)
  app.post("/webhooks/email", emailWebhookHandler)

  return app
}
