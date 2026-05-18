// Standalone server entry point for opentower.
// Runs without the OpenCode plugin host -- connects to a running
// OpenCode instance via OPENCODE_URL using the @opencode-ai/sdk.
//
// Usage:
//   OPENCODE_URL=http://localhost:4096 opentower
//   # or
//   bun run packages/opentower/src/server.ts

import { homedir } from "node:os"
import { join } from "node:path"
import * as Sentry from "@sentry/bun"
import { createOpencodeAgent } from "./agents/opencode"
import { resolveBotLogin } from "./bot-identity"
import { configPath, normalizeTrigger, readWebhookConfig, resolveGithubAppFromEnv } from "./config"
import { makeCronScheduler } from "./cron"
import { makeDedup } from "./dedup"
import { createEntityResolver } from "./entity-resolver"
import { createApp } from "./handler"
import { createHandlers } from "./handlers/registry"
import type { HandlerContext } from "./interfaces"
import { makePipeline } from "./pipeline"
import { makeDrainCounter, makeSemaphore } from "./semaphore"
import { openLifecycleStore } from "./storage"

async function main() {
  console.log("[opentower] starting standalone server...")

  if (typeof Bun === "undefined") {
    throw new Error("opentower requires Bun (uses Bun.serve, Bun.spawn, Bun.file). Install Bun >=1.2.0: https://bun.sh")
  }

  // Sentry
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

  process.on("unhandledRejection", (err) => {
    console.error("[opentower] unhandledRejection:", err)
    Sentry.captureException(err)
  })

  // Config
  const cfg = await readWebhookConfig()
  console.log(`[opentower] config loaded from ${configPath()}`)

  const port = cfg.port ?? Number(process.env.WEBHOOK_PORT ?? "5050")
  const secret = cfg.secret ?? process.env.GITHUB_WEBHOOK_SECRET ?? ""
  const emailSecret = cfg.email_secret ?? process.env.EMAIL_WEBHOOK_SECRET ?? ""
  const timeoutMs = cfg.timeout_ms ?? 1_800_000
  const maxConcurrent = Math.max(1, cfg.max_concurrent ?? 2)
  const defaultCwd = cfg.default_cwd ?? process.cwd()

  // Bot identity
  const botLogin = await resolveBotLogin()
  if (botLogin) {
    console.log(`[opentower] bot identity: ${botLogin}`)
    Sentry.setTag("bot.login", botLogin)
  } else {
    console.warn(
      "[opentower] WARNING: could not resolve bot identity via 'gh api user' -- $BOT_LOGIN in ignore_authors will not be substituted.",
    )
  }

  // Triggers
  const triggers = (cfg.triggers ?? []).map((t) => normalizeTrigger(t, botLogin))
  if (triggers.length === 0) {
    console.log(`[opentower] no triggers configured (looked at ${configPath()}) -- nothing to do`)
    process.exit(0)
  }

  const githubTriggerCount = triggers.filter((t) => t.source === "github_webhook").length
  const emailTriggerCount = triggers.filter((t) => t.source === "email").length
  const githubAppTriggerCount = triggers.filter((t) => t.source === "github_app").length

  if (githubTriggerCount > 0 && !secret) {
    console.warn("[opentower] WARNING: no GitHub HMAC secret configured -- /webhooks/github will reject with 503")
  }
  if (emailTriggerCount > 0 && !emailSecret) {
    console.warn("[opentower] WARNING: no email HMAC secret configured -- /webhooks/email will reject with 503")
  }

  // GitHub App config
  const githubApp = cfg.github_app ?? resolveGithubAppFromEnv()
  if (githubAppTriggerCount > 0 && !githubApp) {
    console.warn(
      "[opentower] WARNING: github_app triggers configured but no GitHub App credentials found -- /webhooks/github-app will not be registered",
    )
  }

  // Agent client -- connect to running OpenCode instance.
  const opencodeUrl = process.env.OPENCODE_URL
  if (!opencodeUrl) {
    throw new Error(
      "OPENCODE_URL is required in standalone mode. Set it to the URL of a running OpenCode instance (e.g. http://localhost:4096).",
    )
  }
  const client = await createOpencodeAgent({ baseUrl: opencodeUrl, directory: defaultCwd })
  console.log(`[opentower] connected to OpenCode at ${opencodeUrl}`)

  // Infrastructure
  const batchWindowMs = cfg.batch_window_ms ?? 5_000
  const dedup = makeDedup()
  const semaphore = makeSemaphore(maxConcurrent)
  const drainCounter = makeDrainCounter()

  const dbPath = process.env.LIFECYCLE_DB_PATH ?? join(homedir(), "dev", ".opencode", "lifecycle.db")
  const store = openLifecycleStore(dbPath)
  console.log(`[opentower] lifecycle store opened at ${dbPath}`)

  const pipeline = makePipeline({
    client,
    defaultCwd,
    timeoutMs,
    semaphore,
    drainCounter,
    store,
    batchWindowMs,
  })

  const entityResolver = createEntityResolver()
  if (entityResolver) {
    console.log("[opentower] AI entity resolver enabled (ANTHROPIC_API_KEY set)")
  } else if (emailTriggerCount > 0) {
    console.warn("[opentower] WARNING: ANTHROPIC_API_KEY not set -- AI entity resolution for emails disabled")
  }

  const apiToken = process.env.OPENTOWER_API_TOKEN ?? ""
  if (!apiToken) {
    console.warn("[opentower] WARNING: OPENTOWER_API_TOKEN not set -- /api/* endpoints will reject with 503")
  }

  // Cron
  const cronTriggers = triggers.filter((t) => t.source === "cron")
  const defaultCronTrigger = cronTriggers[0] ?? null
  const defaultAgent = defaultCronTrigger?.agent ?? triggers[0]?.agent ?? "github-agent"

  const cronScheduler = makeCronScheduler({
    store,
    pipeline,
    defaultAgent,
    cronTrigger: defaultCronTrigger,
  })
  cronScheduler.start()
  console.log("[opentower] cron scheduler started")

  // Handlers
  const handlers = createHandlers({
    secret,
    emailSecret,
    triggers,
    githubApp,
  })

  const handlerContext: HandlerContext = {
    pipeline,
    dedup,
    store,
    botLogin,
    entityResolver,
  }

  const app = createApp({
    handlers,
    handlerContext,
    store,
    apiToken,
    cronScheduler,
  })

  // Start server
  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: app.fetch,
  })

  const cronTriggerCount = cronTriggers.length
  console.log(
    `[opentower] listening on http://0.0.0.0:${server.port} (triggers: github=${githubTriggerCount}, github_app=${githubAppTriggerCount}, email=${emailTriggerCount}, cron=${cronTriggerCount})`,
  )

  // Graceful shutdown
  let stopping = false
  const onShutdown = async (sig: NodeJS.Signals) => {
    if (stopping) return
    stopping = true
    console.log(`[opentower] received ${sig}, closing listener (in-flight: ${drainCounter.inFlight()})`)
    server.stop(true)
    const drainTimeoutMs = 25_000
    try {
      await Promise.race([
        drainCounter.wait(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("drain timeout")), drainTimeoutMs)),
      ])
      console.log("[opentower] all dispatches drained")
    } catch {
      console.warn(
        `[opentower] drain timeout after ${drainTimeoutMs}ms -- ${drainCounter.inFlight()} dispatch(es) still in flight`,
      )
    }
    cronScheduler.stop()
    store.close()
    await Sentry.close(2000)
    process.exit(0)
  }
  process.once("SIGTERM", () => void onShutdown("SIGTERM"))
  process.once("SIGINT", () => void onShutdown("SIGINT"))
}

main().catch((err) => {
  console.error("[opentower] FATAL:", err)
  process.exit(1)
})
