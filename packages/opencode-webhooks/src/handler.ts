// URL router for the plugin's Bun.serve listener. Two POST routes
// (one per ingest source) and a GET healthz, all sharing the same
// dispatcher + store. Per-route logic lives under ./handlers/.
//
// Triggers are split by `source` here once so the handlers don't need
// to know about other ingest paths.

import type { Dispatcher } from "./dispatch"
import type { AllowlistPattern } from "./email/allowlist"
import { makeEmailFetchHandler } from "./handlers/email"
import { makeGithubFetchHandler } from "./handlers/github"
import type { DeliveryStore } from "./storage"
import type { NormalizedTrigger } from "./types"

export function makeFetchHandler(opts: {
  secret: string
  emailSecret: string
  emailAllowlist: AllowlistPattern[]
  triggers: NormalizedTrigger[]
  store: DeliveryStore
  retention: number
  dispatch: Dispatcher
  botLogin: string | null
}): (req: Request) => Promise<Response> {
  const githubTriggers = opts.triggers.filter(
    (t) => t.source === "github_webhook",
  )
  const emailTriggers = opts.triggers.filter((t) => t.source === "email")

  const githubHandler = makeGithubFetchHandler({
    secret: opts.secret,
    triggers: githubTriggers,
    store: opts.store,
    retention: opts.retention,
    dispatch: opts.dispatch,
    botLogin: opts.botLogin,
  })
  const emailHandler = makeEmailFetchHandler({
    emailSecret: opts.emailSecret,
    allowlist: opts.emailAllowlist,
    triggers: emailTriggers,
    store: opts.store,
    retention: opts.retention,
    dispatch: opts.dispatch,
    botLogin: opts.botLogin,
  })

  return async function fetch(req) {
    const url = new URL(req.url)

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, plugin: "opencode-webhooks" })
    }
    if (req.method === "POST" && url.pathname === "/webhooks/github") {
      return githubHandler(req)
    }
    if (req.method === "POST" && url.pathname === "/webhooks/email") {
      return emailHandler(req)
    }
    return new Response("not found", { status: 404 })
  }
}
