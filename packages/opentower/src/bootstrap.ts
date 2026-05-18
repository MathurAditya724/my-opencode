// Shared initialization logic for both plugin and standalone modes.
// This module extracts the common bootstrap sequence: config parsing,
// trigger normalization, infrastructure creation, handler/cron setup.

import { homedir } from "node:os"
import { join } from "node:path"
import * as Sentry from "@sentry/bun"
import type { Hono } from "hono"
import { resolveBotLogin } from "./bot-identity"
import { configPath, normalizeTrigger, readWebhookConfig, resolveGithubAppFromEnv } from "./config"
import { type CronScheduler, makeCronScheduler } from "./cron"
import { type Dedup, makeDedup } from "./dedup"
import { type EntityResolver, createEntityResolver } from "./entity-resolver"
import { type AppEnv, createApp } from "./handler"
import { createHandlers } from "./handlers/registry"
import type { AgentClient, HandlerContext } from "./interfaces"
import { type Pipeline, makePipeline } from "./pipeline"
import { type DrainCounter, makeDrainCounter, makeSemaphore } from "./semaphore"
import { type LifecycleStore, openLifecycleStore } from "./storage"

export type BootstrapResult = {
  app: Hono<AppEnv>
  server: ReturnType<typeof Bun.serve>
  store: LifecycleStore
  pipeline: Pipeline
  cronScheduler: CronScheduler
  drainCounter: DrainCounter
  dedup: Dedup
  botLogin: string | null
  entityResolver: EntityResolver | null
  defaultAgent: string
  client: AgentClient
}

export type BootstrapOptions = {
  client: AgentClient
  defaultCwd: string
}

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const cfg = await readWebhookConfig()
  console.log(`[opentower] config loaded from ${configPath()}`)

  const port = cfg.port ?? Number(process.env.WEBHOOK_PORT ?? "5050")
  const secret = cfg.secret ?? process.env.GITHUB_WEBHOOK_SECRET ?? ""
  const emailSecret = cfg.email_secret ?? process.env.EMAIL_WEBHOOK_SECRET ?? ""
  const timeoutMs = cfg.timeout_ms ?? 1_800_000
  const maxConcurrent = Math.max(1, cfg.max_concurrent ?? 2)
  const defaultCwd = cfg.default_cwd ?? opts.defaultCwd

  const botLogin = await resolveBotLogin()
  if (botLogin) {
    console.log(`[opentower] bot identity: ${botLogin}`)
    Sentry.setTag("bot.login", botLogin)
  } else {
    console.warn(
      "[opentower] WARNING: could not resolve bot identity via 'gh api user' -- $BOT_LOGIN in ignore_authors will not be substituted.",
    )
  }

  const triggers = (cfg.triggers ?? []).map((t) => normalizeTrigger(t, botLogin))
  const githubTriggerCount = triggers.filter((t) => t.source === "github_webhook").length
  const emailTriggerCount = triggers.filter((t) => t.source === "email").length
  const githubAppTriggerCount = triggers.filter((t) => t.source === "github_app").length

  if (githubTriggerCount > 0 && !secret) {
    console.warn("[opentower] WARNING: no GitHub HMAC secret configured -- /webhooks/github will reject with 503")
  }
  if (emailTriggerCount > 0 && !emailSecret) {
    console.warn("[opentower] WARNING: no email HMAC secret configured -- /webhooks/email will reject with 503")
  }

  const githubApp = cfg.github_app ?? resolveGithubAppFromEnv()
  if (githubAppTriggerCount > 0 && !githubApp) {
    console.warn(
      "[opentower] WARNING: github_app triggers configured but no GitHub App credentials found -- /webhooks/github-app will not be registered",
    )
  }

  const batchWindowMs = cfg.batch_window_ms ?? 5_000
  const dedup = makeDedup()
  const semaphore = makeSemaphore(maxConcurrent)
  const drainCounter = makeDrainCounter()

  const dbPath = process.env.LIFECYCLE_DB_PATH ?? join(homedir(), "dev", ".opencode", "lifecycle.db")
  const store = openLifecycleStore(dbPath)
  console.log(`[opentower] lifecycle store opened at ${dbPath}`)

  const pipeline = makePipeline({
    client: opts.client,
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

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: app.fetch,
  })

  const cronTriggerCount = cronTriggers.length
  console.log(
    `[opentower] listening on http://0.0.0.0:${server.port} (triggers: github=${githubTriggerCount}, github_app=${githubAppTriggerCount}, email=${emailTriggerCount}, cron=${cronTriggerCount})`,
  )

  return {
    app,
    server,
    store,
    pipeline,
    cronScheduler,
    drainCounter,
    dedup,
    botLogin,
    entityResolver,
    defaultAgent,
    client: opts.client,
  }
}

export async function gracefulShutdown(
  result: Pick<BootstrapResult, "server" | "drainCounter" | "cronScheduler" | "store">,
  sig: string,
): Promise<void> {
  console.log(`[opentower] received ${sig}, closing listener (in-flight: ${result.drainCounter.inFlight()})`)
  result.server.stop(true)
  const drainTimeoutMs = 25_000
  try {
    await Promise.race([
      result.drainCounter.wait(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("drain timeout")), drainTimeoutMs)),
    ])
    console.log("[opentower] all dispatches drained")
  } catch {
    console.warn(
      `[opentower] drain timeout after ${drainTimeoutMs}ms -- ${result.drainCounter.inFlight()} dispatch(es) still in flight`,
    )
  }
  result.cronScheduler.stop()
  result.store.close()
  await Sentry.close(2000)
}
