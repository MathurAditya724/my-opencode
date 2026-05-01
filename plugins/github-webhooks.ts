// github-webhooks: receives GitHub webhooks, dispatches to OpenCode
// agents via the in-process SDK client. Listener on WEBHOOK_PORT
// (default 5050). Trigger config in webhooks.json.

import type { Plugin } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { createHmac, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { homedir } from "node:os"

// ---------- Trigger config shape ----------------------------------------

type Trigger = {
  name: string
  event: string                 // "issues" | "pull_request" | "*"
  action?: string | null        // e.g. "assigned"; null = any action
  agent: string
  prompt_template: string       // {{ payload.foo.bar }} placeholders
  cwd?: string | null
  enabled?: boolean
  // Skip if payload.sender.login matches any entry (case-insensitive).
  // The literal "$BOT_LOGIN" is substituted with the resolved bot login.
  ignore_authors?: string[]
  // Payload-shape gate. Dotted paths → expected values. "*" means any
  // non-empty value; other values are scalar equality. AND across keys.
  payload_filter?: Record<string, unknown>
  // Identity gate. Dotted paths whose string value must equal the bot's
  // resolved login (case-insensitive). OR across paths. Paths support
  // a `[*]` wildcard for arrays.
  require_bot_match?: string[]
}

type WebhookConfig = {
  port?: number
  secret?: string               // falls back to GITHUB_WEBHOOK_SECRET
  timeout_ms?: number           // per-session abort, default 30 min
  max_concurrent?: number       // default 2
  default_cwd?: string          // fallback session cwd
  db_path?: string              // dedup SQLite file
  retention?: number            // cap on persisted deliveries, default 1000
  triggers?: Trigger[]
}

// Resolve the bot's GitHub login via `gh api user --jq .login`. gh
// reads GH_TOKEN from env. Returns null on any failure.
async function resolveBotLogin(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    const timer = setTimeout(() => proc.kill("SIGTERM"), 5_000)
    timer.unref?.()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    if (exitCode !== 0) {
      console.warn(
        `[github-webhooks] gh api user exit=${exitCode} stderr=${stderr.trim().slice(0, 200)}`,
      )
      return null
    }
    const login = stdout.trim()
    return login.length > 0 ? login : null
  } catch (err) {
    console.warn("[github-webhooks] resolveBotLogin failed:", err)
    return null
  }
}

// Read webhooks.json. Default ~/.config/opencode/webhooks.json,
// override via WEBHOOKS_CONFIG. Missing file = no triggers.
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
    console.error(`[github-webhooks] failed to parse config at ${path}:`, err)
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

// {{ a.b.c }} → ctx.a.b.c. Missing → empty string. Objects → JSON.
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

// Every enabled trigger matching (event, action) fires. `*` matches
// any event; null/missing action matches any action.
function findMatching(
  triggers: NormalizedTrigger[],
  event: string,
  action: string | null,
): NormalizedTrigger[] {
  return triggers.filter((t) => {
    if (t.enabled === false) return false
    const eventOk = t.event === "*" || t.event === event
    if (!eventOk) return false
    return t.action === null || t.action === action
  })
}

// Returns null on match, or a string reason for the first miss.
function evaluatePayloadFilter(
  filter: Record<string, unknown> | undefined,
  payload: unknown,
): string | null {
  if (!filter) return null
  for (const [path, expected] of Object.entries(filter)) {
    const actual = lookup(payload, path)
    if (expected === "*") {
      // "*" = any present, non-empty value.
      if (
        actual === undefined ||
        actual === null ||
        actual === "" ||
        (Array.isArray(actual) && actual.length === 0) ||
        (typeof actual === "object" &&
          actual !== null &&
          Object.keys(actual as object).length === 0)
      ) {
        return `payload.${path} is absent/empty`
      }
      continue
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return `payload.${path} = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`
    }
  }
  return null
}

// Returns null on match, or a string reason on miss. OR across paths.
// Fail-closed when bot login is unresolved.
function evaluateBotMatch(
  paths: string[] | undefined,
  payload: unknown,
  botLogin: string | null,
): string | null {
  if (!paths || paths.length === 0) return null
  if (!botLogin) return "bot identity unresolved"
  const lower = botLogin.toLowerCase()
  for (const path of paths) {
    for (const v of lookupAll(payload, path)) {
      if (typeof v === "string" && v.toLowerCase() === lower) return null
    }
  }
  return `none of [${paths.join(", ")}] matched bot login '${botLogin}'`
}

// Like lookup() but expands `[*]` across array elements.
function lookupAll(ctx: unknown, path: string): unknown[] {
  const STAR = Symbol("star")
  const tokens: Array<string | typeof STAR> = []
  for (const part of path.split(".")) {
    let i = 0
    while (i < part.length) {
      const lb = part.indexOf("[", i)
      if (lb < 0) {
        if (i < part.length) tokens.push(part.slice(i))
        break
      }
      if (lb > i) tokens.push(part.slice(i, lb))
      const rb = part.indexOf("]", lb)
      if (rb < 0) {
        tokens.push(part.slice(i))
        break
      }
      const inside = part.slice(lb + 1, rb)
      tokens.push(inside === "*" ? STAR : inside)
      i = rb + 1
    }
  }

  let frontier: unknown[] = [ctx]
  for (const tok of tokens) {
    const next: unknown[] = []
    for (const cur of frontier) {
      if (tok === STAR) {
        if (Array.isArray(cur)) for (const el of cur) next.push(el)
      } else if (cur && typeof cur === "object" && tok in (cur as object)) {
        next.push((cur as Record<string, unknown>)[tok])
      }
    }
    frontier = next
    if (frontier.length === 0) return []
  }
  return frontier
}

type NormalizedTrigger = Omit<Trigger, "action" | "enabled"> & {
  action: string | null
  enabled: boolean
}

// Merge config-supplied ignore_authors with env extras. "$BOT_LOGIN"
// is substituted with the resolved bot login (dropped silently if
// unresolved). Dedup is case-insensitive.
function normalizeTrigger(
  t: Trigger,
  extraIgnoreAuthors: string[],
  botLogin: string | null,
): NormalizedTrigger {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const raw of [...(t.ignore_authors ?? []), ...extraIgnoreAuthors]) {
    const expanded = raw === "$BOT_LOGIN" ? botLogin : raw
    if (!expanded) continue
    const k = expanded.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(expanded)
  }
  return {
    ...t,
    action: t.action ?? null,
    enabled: t.enabled !== false,
    ignore_authors: merged.length > 0 ? merged : undefined,
  }
}

// Caps in-flight sessions to prevent a noisy delivery from fanning out
// into N parallel LLM calls.
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
  // Don't let a dispatch bug take down the host opencode server.
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
  // Dedup DB on the persistent volume so it survives redeploys.
  const dbPath =
    cfg.db_path ?? `${homedir()}/dev/.opencode/github-webhooks.sqlite`

  const botLogin = await resolveBotLogin()
  if (botLogin) {
    console.log(`[github-webhooks] bot identity: ${botLogin}`)
  } else {
    console.warn(
      `[github-webhooks] WARNING: could not resolve bot identity via 'gh api user' — triggers with require_bot_match will be skipped. Set GH_TOKEN to enable identity-gated triggers.`,
    )
  }

  // BOT_LOGIN(S): extra ignore_authors entries. Additive, deduped.
  // For self-loop guard on the bot itself, use "$BOT_LOGIN" in the
  // trigger config — it picks up the gh-resolved login automatically.
  const envIgnoreAuthors: string[] = []
  if (process.env.BOT_LOGIN) {
    envIgnoreAuthors.push(process.env.BOT_LOGIN.trim())
  }
  if (process.env.BOT_LOGINS) {
    for (const l of process.env.BOT_LOGINS.split(",")) {
      const trimmed = l.trim()
      if (trimmed) envIgnoreAuthors.push(trimmed)
    }
  }

  const triggers = (cfg.triggers ?? []).map((t) =>
    normalizeTrigger(t, envIgnoreAuthors, botLogin),
  )

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

  // SQLite for delivery dedup only. Sessions live on the host opencode
  // server, not here.
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

  // In-flight counter for graceful shutdown drain.
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

  // Drive a session via the in-process SDK client.
  async function dispatchOne(
    t: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
  ): Promise<void> {
    dispatchStarted()
    await sem.acquire()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    timer.unref?.() // don't block process exit on a 30-min timer
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

      // GitHub always sends both headers. Refuse otherwise.
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

      // Body size cap (matches GitHub's 25 MB limit). Check both
      // declared and actual length to defend against lying clients.
      const MAX_BODY_BYTES = 25 * 1024 * 1024
      const declaredLength = Number(req.headers.get("content-length") ?? "0")
      if (declaredLength > MAX_BODY_BYTES) {
        return Response.json(
          { error: "payload too large" },
          { status: 413 },
        )
      }

      const rawBody = await req.text()
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

      let payload: unknown = {}
      let action: string | null = null
      try {
        payload = JSON.parse(rawBody)
        const a = (payload as { action?: unknown }).action
        if (typeof a === "string") action = a
      } catch {
        // Not JSON — keep the raw bytes, dispatch with empty payload.
      }

      // Idempotency. ON CONFLICT DO NOTHING returns changes=0 on dup.
      const res = insertDelivery.run(deliveryId, event, action, Date.now())
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

      const senderLogin =
        typeof payload === "object" && payload !== null
          ? (payload as { sender?: { login?: unknown } }).sender?.login
          : undefined
      const sender = typeof senderLogin === "string" ? senderLogin : null

      // Synthetic booleans for prompt templates. The renderer can only
      // do path lookup; these expose presence/non-empty checks.
      const ev = (payload as Record<string, unknown> | null) ?? {}
      const issuePR = lookup(ev, "issue.pull_request")
      const reviewBody = lookup(ev, "review.body")
      const reviewState = lookup(ev, "review.state")
      const checkConclusion =
        lookup(ev, "check_suite.conclusion") ??
        lookup(ev, "check_run.conclusion")
      const synthetics = {
        is_pr_comment:
          issuePR !== undefined && issuePR !== null && issuePR !== "",
        is_review_with_body:
          typeof reviewBody === "string" && reviewBody.trim() !== "",
        review_state:
          typeof reviewState === "string" ? reviewState.toLowerCase() : null,
        is_ci_failure: checkConclusion === "failure",
      }

      const matches = findMatching(triggers, event, action)
      const dispatched: string[] = []
      const skipped: Array<{ name: string; reason: string }> = []
      for (const t of matches) {
        // 1. Sender filter (self-loop guard).
        if (t.ignore_authors && t.ignore_authors.length > 0 && sender) {
          const lower = sender.toLowerCase()
          const hit = t.ignore_authors.some((a) => a.toLowerCase() === lower)
          if (hit) {
            skipped.push({ name: t.name, reason: `ignored sender '${sender}'` })
            continue
          }
        }

        // 2. Identity gate (is this work for the bot?).
        const botMatchReason = evaluateBotMatch(
          t.require_bot_match,
          payload,
          botLogin,
        )
        if (botMatchReason) {
          skipped.push({ name: t.name, reason: botMatchReason })
          continue
        }

        // 3. Payload-shape filter.
        const filterReason = evaluatePayloadFilter(t.payload_filter, payload)
        if (filterReason) {
          skipped.push({ name: t.name, reason: filterReason })
          continue
        }

        const prompt = renderTemplate(t.prompt_template, {
          event,
          action,
          delivery_id: deliveryId,
          payload,
          ...synthetics,
        })
        // Fire-and-forget; dispatchOne owns its errors.
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
        ...(skipped.length > 0 ? { skipped } : {}),
      })
    },
  })

  console.log(
    `[github-webhooks] listening on http://0.0.0.0:${port} (db: ${dbPath}, triggers: ${triggers.length})`,
  )

  // Graceful shutdown: stop accepting new connections, drain in-flight
  // dispatches with a 25s ceiling.
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
          setTimeout(() => reject(new Error("drain timeout")), drainTimeoutMs),
        ),
      ])
      console.log(`[github-webhooks] all dispatches drained`)
    } catch {
      console.warn(
        `[github-webhooks] drain timeout after ${drainTimeoutMs}ms — ${inFlightDispatches} dispatch(es) still in flight`,
      )
    }
  }
  // process.once so we don't accumulate listeners across re-inits.
  process.once("SIGTERM", () => void onShutdown("SIGTERM"))
  process.once("SIGINT", () => void onShutdown("SIGINT"))

  return {}
}

export default GitHubWebhooksPlugin
