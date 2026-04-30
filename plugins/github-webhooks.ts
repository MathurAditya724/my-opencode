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
//     overridable with WEBHOOKS_CONFIG), kept out of opencode.json
//     because that file's schema doesn't admit our experimental.webhook
//     extension.
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
  // specify one. Falls back to ctx.directory (project root).
  default_cwd?: string
  // Path to the deduplication SQLite file. Default
  // <project>/.opencode/github-webhooks.sqlite.
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

// Trigger matching with priority: exact (event, action), then
// (event, null), then ('*', null). Multiple matches all fire.
function findMatching(
  triggers: Trigger[],
  event: string,
  action: string | null,
): Trigger[] {
  const enabled = triggers.filter((t) => t.enabled !== false)
  const score = (t: Trigger) => {
    if (t.event === event && t.action === action) return 0
    if (t.event === event && (t.action == null || t.action === undefined))
      return 1
    if (t.event === "*") return 2
    return 99
  }
  return enabled
    .filter((t) => score(t) < 99)
    .filter((t) => {
      // Exact mismatch on a present action: drop.
      if (t.event === event && t.action != null && t.action !== action)
        return false
      return true
    })
    .sort((a, b) => score(a) - score(b))
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
  // the host opencode server. We log and swallow.
  if (!(globalThis as { __ghWebhookGuard?: boolean }).__ghWebhookGuard) {
    process.on("unhandledRejection", (err) => {
      console.error("[github-webhooks] unhandledRejection:", err)
    })
    ;(globalThis as { __ghWebhookGuard?: boolean }).__ghWebhookGuard = true
  }

  const cfg = await readWebhookConfig()

  const port = cfg.port ?? Number(process.env.WEBHOOK_PORT ?? "5050")
  const secret = cfg.secret ?? process.env.GITHUB_WEBHOOK_SECRET ?? ""
  const timeoutMs = cfg.timeout_ms ?? 1_800_000 // 30 min
  const maxConcurrent = Math.max(1, cfg.max_concurrent ?? 2)
  const defaultCwd = cfg.default_cwd ?? ctx.directory
  const retention = cfg.retention ?? 1000
  const dbPath =
    cfg.db_path ?? `${ctx.directory}/.opencode/github-webhooks.sqlite`
  const triggers = cfg.triggers ?? []

  // Bail quietly when nothing is configured. Loading the plugin without
  // setting up triggers shouldn't open a port nobody asked for.
  if (triggers.length === 0) {
    console.log(
      "[github-webhooks] no triggers configured under experimental.webhook.triggers — listener disabled",
    )
    return {}
  }
  if (!secret) {
    console.warn(
      "[github-webhooks] WARNING: no HMAC secret configured (experimental.webhook.secret or GITHUB_WEBHOOK_SECRET) — webhooks will be rejected with 503 until you set one",
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

  // Actually drive a session. ctx.client is bound to the running
  // opencode server — no loopback HTTP, no cold-boot race.
  async function dispatchOne(
    t: Trigger,
    prompt: string,
    deliveryId: string,
  ): Promise<void> {
    await sem.acquire()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
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

      const rawBody = await req.text()
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

  // Plugin hooks. We don't currently need any event hooks — the entire
  // value of this plugin is the listener it opened above. Returning {}
  // is fine; the listener stays alive as long as the host process does.
  return {}
}

// OpenCode's plugin loader looks for any exported function. We export
// our plugin as both the named export above (for tests / explicit
// import) and `default` for the auto-loader.
export default GitHubWebhooksPlugin
