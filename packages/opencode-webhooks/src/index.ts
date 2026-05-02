// opencode-webhooks: receives GitHub webhooks (and optional Cloudflare
// email worker forwards) and dispatches to OpenCode agents via the
// in-process SDK client. Uses Hono for routing and Sentry for error
// tracking. Listener on WEBHOOK_PORT (default 5050).
// Trigger config in webhooks.json.

import type { Plugin } from "@opencode-ai/plugin"
import * as Sentry from "@sentry/bun"
import { homedir } from "node:os"
import { resolveBotLogin } from "./bot-identity"
import { configPath, normalizeTrigger, readWebhookConfig } from "./config"
import { parseAllowlist } from "./email/allowlist"
import { createApp } from "./handler"
import { makePipeline } from "./pipeline"
import { makeDrainCounter, makeSemaphore } from "./semaphore"
import { openDeliveryStore } from "./storage"
export type {
  Trigger,
  TriggerSource,
  WebhookConfig,
  NormalizedTrigger,
  SkippedDispatch,
} from "./types"

export const GitHubWebhooksPlugin: Plugin = async (ctx) => {
  if (typeof Bun === "undefined") {
    throw new Error(
      "opencode-webhooks requires Bun (uses Bun.serve, Bun.spawn, Bun.file, bun:sqlite). Install Bun >=1.2.0: https://bun.sh",
    )
  }

  // Initialize Sentry if a DSN is configured.
  const sentryDsn = process.env.SENTRY_DSN ?? ""
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      // Capture request headers / IP for debugging.
      sendDefaultPii: true,
      // Default to 10% of requests traced in production. Override via
      // SENTRY_TRACES_SAMPLE_RATE env var (0.0–1.0).
      tracesSampleRate: (() => {
        const rate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
        return Number.isFinite(rate) ? rate : 0.1
      })(),
    })
    console.log("[opencode-webhooks] Sentry initialized")
  }

  // Don't let a dispatch bug take down the host opencode server.
  const guard = globalThis as { __ghWebhookGuard?: boolean }
  if (!guard.__ghWebhookGuard) {
    process.on("unhandledRejection", (err) => {
      console.error("[opencode-webhooks] unhandledRejection:", err)
      Sentry.captureException(err)
    })
    guard.__ghWebhookGuard = true
  }

  const cfg = await readWebhookConfig()

  const port = cfg.port ?? Number(process.env.WEBHOOK_PORT ?? "5050")
  const secret = cfg.secret ?? process.env.GITHUB_WEBHOOK_SECRET ?? ""
  const emailSecret =
    cfg.email_secret ?? process.env.EMAIL_WEBHOOK_SECRET ?? ""
  const emailAllowlist = parseAllowlist(cfg.email_allowed_senders)
  const timeoutMs = cfg.timeout_ms ?? 1_800_000 // 30 min
  const maxConcurrent = Math.max(1, cfg.max_concurrent ?? 2)
  const defaultCwd = cfg.default_cwd ?? ctx.directory
  const retention = cfg.retention ?? 1000
  // Default DB path follows the XDG data spec; override db_path in
  // webhooks.json to point at a persistent location.
  const xdgDataHome = process.env.XDG_DATA_HOME || `${homedir()}/.local/share`
  const dbPath = cfg.db_path ?? `${xdgDataHome}/opencode-webhooks/deliveries.sqlite`

  const botLogin = await resolveBotLogin()
  if (botLogin) {
    console.log(`[opencode-webhooks] bot identity: ${botLogin}`)
    // Tag all Sentry events with the bot login so errors are
    // attributable to the right deployment.
    Sentry.setTag("bot.login", botLogin)
  } else {
    console.warn(
      `[opencode-webhooks] WARNING: could not resolve bot identity via 'gh api user' — $BOT_LOGIN in ignore_authors will not be substituted. Set GH_TOKEN to enable self-loop prevention.`,
    )
  }

  const triggers = (cfg.triggers ?? []).map((t) => normalizeTrigger(t, botLogin))
  const githubTriggerCount = triggers.filter((t) => t.source === "github_webhook").length
  const emailTriggerCount = triggers.filter((t) => t.source === "email").length

  if (triggers.length === 0) {
    console.log(
      `[opencode-webhooks] no triggers configured (looked at ${configPath()}) — listener disabled`,
    )
    return {}
  }
  if (githubTriggerCount > 0 && !secret) {
    console.warn(
      `[opencode-webhooks] WARNING: no GitHub HMAC secret configured (set "secret" in ${configPath()} or GITHUB_WEBHOOK_SECRET) — /webhooks/github will reject deliveries with 503 until you set one`,
    )
  }
  if (emailTriggerCount > 0 && !emailSecret) {
    console.warn(
      `[opencode-webhooks] WARNING: no email HMAC secret configured (set "email_secret" in ${configPath()} or EMAIL_WEBHOOK_SECRET) — /webhooks/email will reject deliveries with 503 until you set one`,
    )
  }

  const batchWindowMs = cfg.batch_window_ms ?? 5_000
  const store = openDeliveryStore(dbPath)
  const semaphore = makeSemaphore(maxConcurrent)
  const drainCounter = makeDrainCounter()
  const pipeline = makePipeline({
    client: ctx.client,
    defaultCwd,
    timeoutMs,
    semaphore,
    drainCounter,
    store,
    batchWindowMs,
  })

  const app = createApp({
    secret,
    emailSecret,
    emailAllowlist,
    triggers,
    store,
    retention,
    pipeline,
    botLogin,
  })

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: app.fetch,
  })

  console.log(
    `[opencode-webhooks] listening on http://0.0.0.0:${port} (db: ${dbPath}, triggers: github=${githubTriggerCount}, email=${emailTriggerCount})`,
  )

  // Graceful shutdown: stop accepting new connections, flush Sentry,
  // drain in-flight dispatches with a 25s ceiling.
  let stopping = false
  const onShutdown = async (sig: NodeJS.Signals) => {
    if (stopping) return
    stopping = true
    console.log(
      `[opencode-webhooks] received ${sig}, closing listener (in-flight dispatches: ${drainCounter.inFlight()})`,
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
        `[opencode-webhooks] drain timeout after ${drainTimeoutMs}ms — ${drainCounter.inFlight()} dispatch(es) still in flight`,
      )
    }
    await Sentry.close(2000)
  }
  process.once("SIGTERM", () => void onShutdown("SIGTERM"))
  process.once("SIGINT", () => void onShutdown("SIGINT"))

  return {}
}

export default GitHubWebhooksPlugin
