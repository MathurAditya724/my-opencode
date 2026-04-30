// GitHub webhooks → OpenCode agent dispatch, as an OpenCode plugin.
//
// Runs inside the long-lived `opencode` server process at startup. Opens
// its own listener on WEBHOOK_PORT (default 5050) that takes verified
// GitHub webhook deliveries and turns them into OpenCode sessions via
// the in-process SDK client.
//
// Why a plugin instead of a separate process:
//   - One process, one log stream, one set of env vars.
//   - The SDK client we get from ctx.client targets THIS server, no
//     loopback HTTP and no cold-boot race.
//   - Trigger config is a JSON file (default ~/.config/opencode/webhooks.json,
//     overridable with WEBHOOKS_CONFIG). This is the documented user
//     surface — version-controlled in the repo, edited at deploy time,
//     or pointed at a path on the persistent volume to mutate without
//     rebuilding.
//
// Trade-off: an unhandled rejection here can crash the OpenCode server.
// We catch aggressively at the dispatch boundary and rely on the
// AbortController + a top-level unhandledRejection guard to keep the
// host process up.

import type { Plugin } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { createHmac, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { homedir } from "node:os"

// ---------- Trigger config shape ----------------------------------------

type Trigger = {
  name: string
  event: string                 // e.g. "issues" | "pull_request" | "*"
  action?: string | null        // e.g. "assigned"; null/undefined = any action
  agent: string                 // agent name to invoke
  prompt_template: string       // {{ payload.foo.bar }} placeholders
  cwd?: string | null           // optional override for session directory
  enabled?: boolean             // default true
}

type WebhookConfig = {
  // Listener port. GitHub posts here. Default 5050.
  port?: number
  // HMAC secret matching GitHub's webhook UI. If omitted, falls back to
  // the GITHUB_WEBHOOK_SECRET env var. Without one of these the plugin
  // returns 503 to every webhook delivery (fail-closed).
  secret?: string
  // Per-session abort timeout (ms). Default 30 min.
  timeout_ms?: number
  // Max concurrent agent sessions. Default 2.
  max_concurrent?: number
  // Default working directory for sessions when a trigger doesn't
  // specify one. Falls back to ctx.directory (whatever opencode hands
  // us at plugin-load time; usually the project root).
  default_cwd?: string
  // Path to the deduplication SQLite file. Default
  // ~/dev/.opencode/github-webhooks.sqlite — co-located with opencode's
  // own session data on the persistent Railway volume.
  db_path?: string
  // Hard cap on persisted webhook deliveries. Default 1000.
  retention?: number
  triggers?: Trigger[]
}

// Resolves and reads the JSON config file. Default path is
// ~/.config/opencode/webhooks.json; override with WEBHOOKS_CONFIG.
// A missing file is fine — the plugin just won't open a listener.
async function readWebhookConfig(): Promise<WebhookConfig> {
  const path =
    process.env.WEBHOOKS_CONFIG ?? `${homedir()}/.config/opencode/webhooks.json`
  if (!existsSync(path)) return {}
  try {
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as WebhookConfig
  } catch (err) {
    console.error(
      `[github-webhooks] failed to parse config at ${path}:`,
      err,
    )
    return {}
  }
}

// ---------- Tiny utilities ----------------------------------------------

function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex")
  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Mustache-ish template renderer. {{ a.b.c }} only — no expressions, no
// helpers. Missing paths render as empty string. Objects render as JSON.
function renderTemplate(
  template: string,
  ctx: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g, (_m, path) => {
    const value = lookup(ctx, String(path))
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    return JSON.stringify(value)
  })
}

function lookup(ctx: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

// Trigger matching: every enabled trigger that matches the incoming
// (event, action) pair fires. There's no priority ordering — if you
// register both a specific `{ event: "issues", action: "assigned" }`
// trigger and a catch-all `{ event: "*" }` trigger, BOTH dispatch on
// `issues.assigned`. That's strictly more flexible than "highest
// priority wins" (you can layer an audit-log trigger over a domain
// trigger without one suppressing the other) and is bounded by the
// concurrency semaphore so cost stays predictable.
//
// A trigger matches when:
//   - t.event matches the delivery's event (or t.event === "*"), AND
//   - t.action is null (= "any action of this event") OR
//     t.action equals the delivery's action.
//
// Trigger.action is normalized to null at load time, so the strict
// equality below works for both null payloads and absent-field configs.
function findMatching(
  triggers: NormalizedTrigger[],
  event: string,
  action: string | null,
): NormalizedTrigger[] {
  return triggers.filter((t) => {
    if (t.enabled === false) return false
    const eventOk = t.event === "*" || t.event === event
    if (!eventOk) return false
    const actionOk = t.action === null || t.action === action
    return actionOk
  })
}

// Trigger as it lives in memory after normalization. action is always
// `string | null` (config-supplied undefined/missing field becomes
// null), enabled is always boolean.
type NormalizedTrigger = Omit<Trigger, "action" | "enabled"> & {
  action: string | null
  enabled: boolean
}

function normalizeTrigger(t: Trigger): NormalizedTrigger {
  return {
    ...t,
    action: t.action ?? null,
    enabled: t.enabled !== false,
  }
}

// ---------- Concurrency gate --------------------------------------------
// Caps how many sessions can be in flight at once. Without this, a
// single delivery matching many triggers (or a bursty webhook source)
// could fan out into N parallel LLM calls.

function makeSemaphore(limit: number) {
  let inFlight = 0
  const waiters: Array<() => void> = []
  return {
    async acquire() {
      if (inFlight < limit) {
        inFlight++
        return
      }
      await new Promise<void>((r) => waiters.push(r))
      inFlight++
    },
    release() {
      inFlight--
      const n = waiters.shift()
      if (n) n()
    },
  }
}

// ---------- Plugin export -----------------------------------------------

export const GitHubWebhooksPlugin: Plugin = async (ctx) => {
  // Process-level guard. A bug in our dispatch path must not take down
  // the host opencode server. We log and swallow. Gated so we only ever
  // install the listener once even if the plugin is re-initialized.
  const guard = globalThis as { __ghWebhookGuard?: boolean }
  if (!guard.__ghWebhookGuard) {
    process.on("unhandledRejection", (err) => {
      console.error("[github-webhooks] unhandledRejection:", err)
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
  // Default DB lives on the persistent ~/dev volume so dedup state
  // survives both restarts AND project-directory changes (ctx.directory
  // can shift across sessions; we want one global delivery log).
  const dbPath =
    cfg.db_path ?? `${homedir()}/dev/.opencode/github-webhooks.sqlite`
  const triggers = (cfg.triggers ?? []).map(normalizeTrigger)

  // Bail quietly when nothing is configured. Loading the plugin without
  // setting up triggers shouldn't open a port nobody asked for.
  const configHint =
    process.env.WEBHOOKS_CONFIG ?? `${homedir()}/.config/opencode/webhooks.json`
  if (triggers.length === 0) {
    console.log(
      `[github-webhooks] no triggers configured (looked at ${configHint}) — listener disabled`,
    )
    return {}
  }
  if (!secret) {
    console.warn(
      `[github-webhooks] WARNING: no HMAC secret configured (set "secret" in ${configHint} or GITHUB_WEBHOOK_SECRET) — webhooks will be rejected with 503 until you set one`,
    )
  }

  // SQLite for idempotency only. We dedup by GitHub's X-GitHub-Delivery
  // header so redeliveries (manual replay or auto-retry) don't run
  // agents twice. We do NOT persist sessions or summaries here — the
  // host opencode server is already the system of record for those.
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id  TEXT NOT NULL UNIQUE,
      event        TEXT NOT NULL,
      action       TEXT,
      received_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_received
      ON deliveries(received_at DESC);
  `)
  const insertDelivery = db.prepare<
    void,
    [string, string, string | null, number]
  >(
    `INSERT INTO deliveries (delivery_id, event, action, received_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
  )
  const trimDeliveries = db.prepare<void, [number]>(
    `DELETE FROM deliveries WHERE id NOT IN (
       SELECT id FROM deliveries ORDER BY received_at DESC LIMIT ?
     )`,
  )

  const sem = makeSemaphore(maxConcurrent)

  // Track in-flight dispatches so graceful shutdown can wait for them
  // to complete before fully closing the listener. Counts ALL dispatches
  // (queued behind the semaphore + actively running), so the
  // listener stays alive until the queue drains.
  let inFlightDispatches = 0
  const drainWaiters: Array<() => void> = []
  function dispatchStarted() {
    inFlightDispatches++
  }
  function dispatchEnded() {
    inFlightDispatches--
    if (inFlightDispatches === 0) {
      while (drainWaiters.length > 0) drainWaiters.shift()!()
    }
  }
  function waitForDrain(): Promise<void> {
    if (inFlightDispatches === 0) return Promise.resolve()
    return new Promise<void>((r) => drainWaiters.push(r))
  }

  // Actually drive a session. ctx.client is bound to the running
  // opencode server — no loopback HTTP, no cold-boot race.
  async function dispatchOne(
    t: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
  ): Promise<void> {
    dispatchStarted()
    await sem.acquire()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    // Don't keep the event loop alive just for the abort timer — on
    // SIGTERM the dispatch should either complete naturally or be
    // canceled by the drain logic, NOT block exit because a 30-min
    // timer hasn't fired yet. Bun supports unref(); guard so the call
    // is a no-op on runtimes that don't.
    timer.unref?.()
    try {
      const session = await ctx.client.session.create({
        body: { title: `[webhook/${t.name}] ${t.event}` },
        query: { directory: t.cwd ?? defaultCwd },
        signal: abort.signal,
      })
      const sessionId = session.data?.id
      if (!sessionId) {
        console.error(
          `[github-webhooks] trigger '${t.name}' (${deliveryId}): session.create returned no id`,
        )
        return
      }
      console.log(
        `[github-webhooks] trigger '${t.name}' (${deliveryId}) → session ${sessionId}`,
      )
      await ctx.client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: t.agent,
          parts: [{ type: "text", text: prompt }],
        },
        signal: abort.signal,
      })
      console.log(
        `[github-webhooks] trigger '${t.name}' (${deliveryId}) → session ${sessionId} completed`,
      )
    } catch (err) {
      console.error(
        `[github-webhooks] trigger '${t.name}' (${deliveryId}) failed:`,
        err,
      )
    } finally {
      clearTimeout(timer)
      sem.release()
      dispatchEnded()
    }
  }

  // ---------- HTTP listener ---------------------------------------------

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url)

      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true, plugin: "github-webhooks" })
      }

      if (req.method !== "POST" || url.pathname !== "/webhooks/github") {
        return new Response("not found", { status: 404 })
      }

      if (!secret) {
        return Response.json(
          { error: "no HMAC secret configured on server" },
          { status: 503 },
        )
      }

      // GitHub always sends both headers. Refuse the request if either
      // is missing — without them we can't dedup or filter, and the
      // request is almost certainly not from GitHub.
      const event = req.headers.get("x-github-event")
      const deliveryId = req.headers.get("x-github-delivery")
      if (!event || !deliveryId) {
        return Response.json(
          {
            error:
              "missing required headers (x-github-event, x-github-delivery)",
          },
          { status: 400 },
        )
      }

      // Body size cap. GitHub caps webhook payloads at 25 MB; anything
      // larger is either a misbehaving client or an attacker trying to
      // OOM us via `await req.text()`. Refuse based on the
      // Content-Length header before we ever read the body. (The same
      // header is part of what HMAC will protect anyway, so a forged
      // size would also fail signature verification.)
      const MAX_BODY_BYTES = 25 * 1024 * 1024
      const declaredLength = Number(req.headers.get("content-length") ?? "0")
      if (declaredLength > MAX_BODY_BYTES) {
        return Response.json(
          { error: "payload too large" },
          { status: 413 },
        )
      }

      const rawBody = await req.text()
      // Defense in depth: if a client sent without Content-Length or
      // lied about it, enforce the same cap on the actual bytes.
      if (rawBody.length > MAX_BODY_BYTES) {
        return Response.json(
          { error: "payload too large" },
          { status: 413 },
        )
      }
      const signature = req.headers.get("x-hub-signature-256")
      if (!verifyGithubSignature(rawBody, signature, secret)) {
        return Response.json({ error: "invalid signature" }, { status: 401 })
      }

      // Parse once. Used for both action extraction and template ctx.
      let payload: unknown = {}
      let action: string | null = null
      try {
        payload = JSON.parse(rawBody)
        const a = (payload as { action?: unknown }).action
        if (typeof a === "string") action = a
      } catch {
        // Not JSON — keep going with empty payload context.
      }

      // Idempotency gate. ON CONFLICT DO NOTHING returns changes=0 on
      // a duplicate; we use that to skip dispatch for redeliveries.
      const res = insertDelivery.run(
        deliveryId,
        event,
        action,
        Date.now(),
      )
      const inserted = res.changes > 0
      if (inserted && retention > 0) trimDeliveries.run(retention)

      if (!inserted) {
        return Response.json({
          ok: true,
          delivery_id: deliveryId,
          duplicate: true,
          dispatched: [],
        })
      }

      const matches = findMatching(triggers, event, action)
      const dispatched: string[] = []
      for (const t of matches) {
        const prompt = renderTemplate(t.prompt_template, {
          event,
          action,
          delivery_id: deliveryId,
          payload,
        })
        // Fire-and-forget. dispatchOne catches its own errors so a
        // failing trigger doesn't poison the response.
        void dispatchOne(t, prompt, deliveryId)
        dispatched.push(t.name)
      }

      return Response.json({
        ok: true,
        delivery_id: deliveryId,
        event,
        action,
        duplicate: false,
        dispatched,
      })
    },
  })

  console.log(
    `[github-webhooks] listening on http://0.0.0.0:${port} (db: ${dbPath}, triggers: ${triggers.length})`,
  )

  // Graceful shutdown. When opencode is shutting down (Railway redeploy,
  // local Ctrl-C, OOM-kill, etc.) we want to:
  //   1. Stop accepting new HTTP connections immediately, so a webhook
  //      that arrives during the kill window doesn't silently fail
  //      partway through (GitHub will retry it; better than us claiming
  //      we accepted it then dying).
  //   2. Let already-dispatched agent sessions finish their
  //      session.create+session.prompt round-trip rather than die
  //      mid-flight and leave a half-baked session row on the host.
  //
  // Bun.serve.stop(true) closes the listening socket immediately, so
  // step 1 is just that. For step 2 we await `waitForDrain()` — the
  // counter is incremented inside dispatchOne and decremented in its
  // finally block, so it covers both queued-on-semaphore and actively-
  // running dispatches. A 25s ceiling guards against an agent that's
  // hung on an external call; opencode itself will get its SIGTERM
  // shortly after ours from the same orchestrator and tear things
  // down regardless.
  let stopping = false
  const onShutdown = async (sig: NodeJS.Signals) => {
    if (stopping) return
    stopping = true
    console.log(
      `[github-webhooks] received ${sig}, closing listener (in-flight dispatches: ${inFlightDispatches})`,
    )
    server.stop(true)
    const drainTimeoutMs = 25_000
    try {
      await Promise.race([
        waitForDrain(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("drain timeout")),
            drainTimeoutMs,
          ),
        ),
      ])
      console.log(`[github-webhooks] all dispatches drained`)
    } catch {
      console.warn(
        `[github-webhooks] drain timeout after ${drainTimeoutMs}ms — ${inFlightDispatches} dispatch(es) still in flight`,
      )
    }
  }
  // process.once (not on) so we don't accumulate listeners if the
  // plugin is ever re-initialized in the same process (which OpenCode
  // doesn't currently do, but the protection is cheap). A second
  // SIGTERM after the first will hit Node's default handler and force
  // exit — which is what an operator pressing ^C twice usually wants.
  process.once("SIGTERM", () => void onShutdown("SIGTERM"))
  process.once("SIGINT", () => void onShutdown("SIGINT"))

  // Plugin hooks. We don't currently need any event hooks — the entire
  // value of this plugin is the listener it opened above. Returning {}
  // is fine; the listener stays alive as long as the host process does.
  return {}
}

// `default` is purely ergonomic — OpenCode's plugin loader picks up any
// exported function from a file in ~/.config/opencode/plugins/, so the
// named export above is sufficient. Keeping `default` so the file also
// works for callers that prefer `import x from "./github-webhooks"`.
export default GitHubWebhooksPlugin
