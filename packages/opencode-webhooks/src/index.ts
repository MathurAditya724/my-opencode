// opencode-webhooks: receives GitHub webhooks (and optional Cloudflare
// email worker forwards) and dispatches to OpenCode agents via the
// in-process SDK client. Uses Hono for routing, Sentry for
// observability (traces, structured logs, error tracking).
// Listener on WEBHOOK_PORT (default 5050). Trigger config in webhooks.json.

import type { Plugin } from "@opencode-ai/plugin"
import * as Sentry from "@sentry/bun"
import { resolveBotLogin } from "./bot-identity"
import { configPath, normalizeTrigger, readWebhookConfig } from "./config"
import { makeDedup } from "./dedup"
import { createApp } from "./handler"
import { makeMetrics } from "./metrics"
import { makePipeline } from "./pipeline"
import { makeDrainCounter, makeSemaphore } from "./semaphore"
export type {
  Trigger,
  TriggerSource,
  WebhookConfig,
  NormalizedTrigger,
  SkippedDispatch,
} from "./types"

export const GitHubWebhooksPlugin: Plugin = async (ctx) => {
  console.log("[opencode-webhooks] plugin loading...")

  const g = globalThis as { __webhookServerStarted?: boolean }
  if (g.__webhookServerStarted) {
    console.log("[opencode-webhooks] server already running, skipping duplicate init")
    return {}
  }
  g.__webhookServerStarted = true

  try {
    if (typeof Bun === "undefined") {
      throw new Error(
        "opencode-webhooks requires Bun (uses Bun.serve, Bun.spawn, Bun.file). Install Bun >=1.2.0: https://bun.sh",
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
      console.log("[opencode-webhooks] Sentry initialized (logs + traces enabled)")
    }

    const guard = globalThis as { __ghWebhookGuard?: boolean }
    if (!guard.__ghWebhookGuard) {
      process.on("unhandledRejection", (err) => {
        console.error("[opencode-webhooks] unhandledRejection:", err)
        Sentry.captureException(err)
      })
      guard.__ghWebhookGuard = true
    }

    const cfg = await readWebhookConfig()
    console.log(`[opencode-webhooks] config loaded from ${configPath()}`)

    const port = cfg.port ?? Number(process.env.WEBHOOK_PORT ?? "5050")
    const secret = cfg.secret ?? process.env.GITHUB_WEBHOOK_SECRET ?? ""
    const emailSecret =
      cfg.email_secret ?? process.env.EMAIL_WEBHOOK_SECRET ?? ""
    const timeoutMs = cfg.timeout_ms ?? 1_800_000
    const maxConcurrent = Math.max(1, cfg.max_concurrent ?? 2)
    const defaultCwd = cfg.default_cwd ?? ctx.directory

    const botLogin = await resolveBotLogin()
    if (botLogin) {
      console.log(`[opencode-webhooks] bot identity: ${botLogin}`)
      Sentry.setTag("bot.login", botLogin)
    } else {
      console.warn(
        `[opencode-webhooks] WARNING: could not resolve bot identity via 'gh api user' -- $BOT_LOGIN in ignore_authors will not be substituted.`,
      )
    }

    const triggers = (cfg.triggers ?? []).map((t) => normalizeTrigger(t, botLogin))
    const githubTriggerCount = triggers.filter((t) => t.source === "github_webhook").length
    const emailTriggerCount = triggers.filter((t) => t.source === "email").length

    if (triggers.length === 0) {
      console.log(
        `[opencode-webhooks] no triggers configured (looked at ${configPath()}) -- listener disabled`,
      )
      return {}
    }
    if (githubTriggerCount > 0 && !secret) {
      console.warn(
        `[opencode-webhooks] WARNING: no GitHub HMAC secret configured -- /webhooks/github will reject with 503`,
      )
    }
    if (emailTriggerCount > 0 && !emailSecret) {
      console.warn(
        `[opencode-webhooks] WARNING: no email HMAC secret configured -- /webhooks/email will reject with 503`,
      )
    }

    const batchWindowMs = cfg.batch_window_ms ?? 5_000
    const dedup = makeDedup()
    const semaphore = makeSemaphore(maxConcurrent)
    const drainCounter = makeDrainCounter()
    const metrics = makeMetrics()
    const pipeline = makePipeline({
      client: ctx.client,
      defaultCwd,
      timeoutMs,
      semaphore,
      drainCounter,
      batchWindowMs,
      metrics,
    })

    const app = createApp({
      secret,
      emailSecret,
      triggers,
      dedup,
      pipeline,
      metrics,
      botLogin,
    })

    console.log(`[opencode-webhooks] starting Bun.serve on port ${port}...`)
    const server = Bun.serve({
      port,
      hostname: "0.0.0.0",
      fetch: app.fetch,
    })

    console.log(
      `[opencode-webhooks] listening on http://0.0.0.0:${server.port} (triggers: github=${githubTriggerCount}, email=${emailTriggerCount})`,
    )

    let stopping = false
    const onShutdown = async (sig: NodeJS.Signals) => {
      if (stopping) return
      stopping = true
      console.log(
        `[opencode-webhooks] received ${sig}, closing listener (in-flight: ${drainCounter.inFlight()})`,
      )
      server.stop(true)
      const drainTimeoutMs = 25_000
      try {
        await Promise.race([
          drainCounter.wait(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("drain timeout")), drainTimeoutMs),
          ),
        ])
        console.log(`[opencode-webhooks] all dispatches drained`)
      } catch {
        console.warn(
          `[opencode-webhooks] drain timeout after ${drainTimeoutMs}ms -- ${drainCounter.inFlight()} dispatch(es) still in flight`,
        )
      }
      await Sentry.close(2000)
    }
    process.once("SIGTERM", () => void onShutdown("SIGTERM"))
    process.once("SIGINT", () => void onShutdown("SIGINT"))

    return {}
  } catch (err) {
    g.__webhookServerStarted = false
    console.error("[opencode-webhooks] FATAL: plugin failed to start:", err)
    throw err
  }
}

export default GitHubWebhooksPlugin
