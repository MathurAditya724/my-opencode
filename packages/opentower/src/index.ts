// opentower: receives GitHub webhooks (and optional Cloudflare
// email worker forwards) and dispatches to OpenCode agents via the
// in-process SDK client. Uses Hono for routing, Sentry for
// observability (traces, structured logs, error tracking).
// Listener on WEBHOOK_PORT (default 5050). Trigger config in webhooks.json.
//
// This module is the plugin entry point. For standalone server mode,
// see server.ts / bin.ts.

import type { Plugin } from "@opencode-ai/plugin"
import * as Sentry from "@sentry/bun"
import { createOpencodeAgent } from "./agents/opencode"
import { bootstrap, gracefulShutdown } from "./bootstrap"
import { makeCronTools } from "./tools/cron"
import { makeLifecycleTools } from "./tools/lifecycle"
export type {
  Trigger,
  TriggerSource,
  WebhookConfig,
  NormalizedTrigger,
  SkippedDispatch,
  GithubAppConfig,
} from "./types"
export type { AgentClient, WebhookHandler, HandlerContext } from "./interfaces"

export const GitHubWebhooksPlugin: Plugin = async (ctx) => {
  console.log("[opentower] plugin loading...")

  const g = globalThis as { __webhookServerStarted?: boolean }
  if (g.__webhookServerStarted) {
    console.log("[opentower] server already running, skipping duplicate init")
    return {}
  }
  g.__webhookServerStarted = true

  try {
    if (typeof Bun === "undefined") {
      throw new Error(
        "opentower requires Bun (uses Bun.serve, Bun.spawn, Bun.file). Install Bun >=1.2.0: https://bun.sh",
      )
    }

    const sentryDsn = process.env.SENTRY_DSN ?? ""
    if (sentryDsn) {
      Sentry.init({
        dsn: sentryDsn,
        sendDefaultPii: true,
        enableLogs: true,
        tracesSampleRate: (() => {
          const rate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
          return Number.isFinite(rate) ? rate : 0.1
        })(),
      })
      console.log("[opentower] Sentry initialized (logs + traces enabled)")
    }

    const guard = globalThis as { __ghWebhookGuard?: boolean }
    if (!guard.__ghWebhookGuard) {
      process.on("unhandledRejection", (err) => {
        console.error("[opentower] unhandledRejection:", err)
        Sentry.captureException(err)
      })
      guard.__ghWebhookGuard = true
    }

    const client = await createOpencodeAgent({ client: ctx.client })

    const result = await bootstrap({
      client,
      defaultCwd: ctx.directory,
    })

    let stopping = false
    const onShutdown = async (sig: NodeJS.Signals) => {
      if (stopping) return
      stopping = true
      await gracefulShutdown(result, sig)
    }
    process.once("SIGTERM", () => void onShutdown("SIGTERM"))
    process.once("SIGINT", () => void onShutdown("SIGINT"))

    const cronTools = makeCronTools({
      store: result.store,
      scheduler: result.cronScheduler,
      defaultAgent: result.defaultAgent,
    })

    const lifecycleTools = makeLifecycleTools({
      store: result.store,
      client,
    })

    return {
      tool: { ...cronTools, ...lifecycleTools },
    }
  } catch (err) {
    g.__webhookServerStarted = false
    console.error("[opentower] FATAL: plugin failed to start:", err)
    throw err
  }
}

export default GitHubWebhooksPlugin
