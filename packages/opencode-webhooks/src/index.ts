// opencode-webhooks: receives GitHub webhooks, dispatches to OpenCode
// agents via the in-process SDK client. Listener on WEBHOOK_PORT
// (default 5050). Trigger config in webhooks.json.

import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { resolveBotLogin } from "./bot-identity"
import { configPath, normalizeTrigger, readWebhookConfig } from "./config"
import { makeDispatcher } from "./dispatch"
import { makeFetchHandler } from "./handler"
import { makeDrainCounter, makeSemaphore } from "./semaphore"
import { openDeliveryStore } from "./storage"
export type { Trigger, WebhookConfig, NormalizedTrigger, SkippedDispatch } from "./types"

export const GitHubWebhooksPlugin: Plugin = async (ctx) => {
  // Don't let a dispatch bug take down the host opencode server.
  const guard = globalThis as { __ghWebhookGuard?: boolean }
  if (!guard.__ghWebhookGuard) {
    process.on("unhandledRejection", (err) => {
      console.error("[opencode-webhooks] unhandledRejection:", err)
    })
    guard.__ghWebhookGuard = true
  }

  const cfg = await readWebhookConfig()

  const port = cfg.port ?? Number(process.env.WEBHOOK_PORT ?? "5050")
  const secret = cfg.secret ?? process.env.GITHUB_WEBHOOK_SECRET ?? ""
  const timeoutMs = cfg.timeout_ms ?? 1_800_000 // 30 min
  const maxConcurrent = Math.max(1, cfg.max_concurrent ?? 2)
  const defaultCwd = cfg.default_cwd ?? ctx.directory
  const retention = cfg.retention ?? 1000
  // Default DB path follows the XDG data spec; consumers running in
  // sandboxed/persistent-volume environments should override `db_path`
  // in webhooks.json to point at their persistent location.
  const xdgDataHome = process.env.XDG_DATA_HOME || `${homedir()}/.local/share`
  const dbPath = cfg.db_path ?? `${xdgDataHome}/opencode-webhooks/deliveries.sqlite`

  const botLogin = await resolveBotLogin()
  if (botLogin) {
    console.log(`[opencode-webhooks] bot identity: ${botLogin}`)
  } else {
    console.warn(
      `[opencode-webhooks] WARNING: could not resolve bot identity via 'gh api user' — triggers with require_bot_match will be skipped. Set GH_TOKEN to enable identity-gated triggers.`,
    )
  }

  const triggers = (cfg.triggers ?? []).map((t) => normalizeTrigger(t, botLogin))

  if (triggers.length === 0) {
    console.log(
      `[opencode-webhooks] no triggers configured (looked at ${configPath()}) — listener disabled`,
    )
    return {}
  }
  if (!secret) {
    console.warn(
      `[opencode-webhooks] WARNING: no HMAC secret configured (set "secret" in ${configPath()} or GITHUB_WEBHOOK_SECRET) — webhooks will be rejected with 503 until you set one`,
    )
  }

  const store = openDeliveryStore(dbPath)
  const semaphore = makeSemaphore(maxConcurrent)
  const drainCounter = makeDrainCounter()
  const dispatch = makeDispatcher({
    client: ctx.client,
    defaultCwd,
    timeoutMs,
    semaphore,
    drainCounter,
  })
  const fetch = makeFetchHandler({
    secret,
    triggers,
    store,
    retention,
    dispatch,
    botLogin,
  })

  const server = Bun.serve({ port, hostname: "0.0.0.0", fetch })

  console.log(
    `[opencode-webhooks] listening on http://0.0.0.0:${port} (db: ${dbPath}, triggers: ${triggers.length})`,
  )

  // Graceful shutdown: stop accepting new connections, drain in-flight
  // dispatches with a 25s ceiling.
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
  }
  process.once("SIGTERM", () => void onShutdown("SIGTERM"))
  process.once("SIGINT", () => void onShutdown("SIGINT"))

  return {}
}

export default GitHubWebhooksPlugin
