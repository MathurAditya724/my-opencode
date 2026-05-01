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
  // Self-loop guard. If the inbound delivery's payload.sender.login
  // matches any name in this list (case-insensitive, exact match), the
  // trigger is skipped. Use this to stop the bot from triggering itself
  // when its own commits / comments / reviews fire fresh webhooks. Common
  // values: ["github-actions[bot]", "<your-bot-username>"].
  ignore_authors?: string[]
  // Optional payload-shape gate. Keys are dotted paths into the parsed
  // payload (same syntax as the prompt template's `{{ a.b.c }}`). Values
  // are matched as follows:
  //   - "*"   -> any non-empty (truthy) value matches; useful for
  //              "this field exists and isn't empty" checks like
  //              `{ "issue.pull_request": "*" }` to filter issue_comment
  //              events to PR comments only.
  //   - other -> strict equality after JSON.stringify normalization, so
  //              both `"failure"` and `42` work as scalar matches.
  // Multiple keys are AND-ed. Triggers without a payload_filter behave
  // as today (fire on event+action match only). Filter mismatches are
  // counted in the response's `skipped` array with a reason.
  payload_filter?: Record<string, unknown>
  // Identity gate. List of dotted payload paths whose string value, if
  // any matches the bot's resolved GitHub login (case-insensitive),
  // permits dispatch. OR semantics — any path equal to the bot's
  // login is enough to fire. Empty list / absent field means no gate
  // (the trigger fires regardless of identity).
  //
  // Used to scope agents to "things the bot was summoned on": e.g.
  // ["assignee.login"] for issue triggers means the bot only handles
  // issues assigned TO it; ["pull_request.user.login"] means the bot
  // only handles PRs it authored.
  //
  // If the bot's login can't be resolved at boot (gh api user failed)
  // and a trigger has require_bot_match set, that trigger is skipped
  // with reason "bot identity unresolved" — fail-closed for gated
  // triggers, fail-open for un-gated ones.
  require_bot_match?: string[]
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

// Resolve the bot's GitHub login by shelling out to `gh api user --jq
// .login`. gh reads GH_TOKEN from the environment automatically; no
// argument plumbing needed. The result is cached for the process
// lifetime via the singleton call site (one resolveBotLogin() per
// plugin init), and that's the right scope — token rotation requires
// a container restart to propagate, which is fine for our use case.
//
// Returns null on any failure (no GH_TOKEN, network error, gh missing,
// 5s timeout). Callers are expected to fall back to env-var-supplied
// hints (BOT_LOGIN) and/or skip identity-gated work with a clear log.
async function resolveBotLogin(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    // 5s ceiling. gh's own request timeout is more lenient, but the
    // plugin shouldn't sit in startup waiting for a slow network.
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
// Payload-shape filtering happens AFTER this in the request handler,
// so the cheap event/action filter shrinks the candidate set before
// we do any payload walks.
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

// Evaluate a trigger's payload_filter against the parsed payload.
// Returns null on match (= no reason to skip), or a string reason
// describing the first mismatched key. Empty/absent filters match
// anything.
function evaluatePayloadFilter(
  filter: Record<string, unknown> | undefined,
  payload: unknown,
): string | null {
  if (!filter) return null
  for (const [path, expected] of Object.entries(filter)) {
    const actual = lookup(payload, path)
    if (expected === "*") {
      // "* = any truthy/non-empty value". Treats empty string,
      // empty object, null, undefined as "absent". Empty arrays
      // also count as absent — `[]` for `labels` shouldn't match a
      // "has labels" filter.
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
    // Scalar equality. JSON.stringify normalizes both sides so
    // numbers, booleans, and strings compare cleanly without us
    // having to think about JS coercion rules.
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return `payload.${path} = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`
    }
  }
  return null
}

// Identity gate. Returns null on match (= no reason to skip), or a
// string reason on miss. OR across paths: any path whose string value
// (case-insensitive) equals the bot's login passes. If the bot login
// is unresolved we fail closed — the trigger is skipped rather than
// risk firing on something the operator wanted gated.
//
// Paths support a `[*]` wildcard for arrays: e.g.
// `pull_request.requested_reviewers[*].login` matches if ANY element
// of the requested_reviewers array has a login equal to the bot's.
// This lets a single trigger gate on "bot is the PR author OR bot is
// in the requested-reviewers list" by listing both paths.
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

// Like lookup() but yields every value reachable through the path,
// expanding `[*]` segments across array elements. For paths without
// `[*]`, yields a single value (or yields nothing if the path
// doesn't resolve).
function lookupAll(ctx: unknown, path: string): unknown[] {
  // Split on `.` AND on `[*]` boundaries. Numeric `[N]` keeps existing
  // behavior (single index). `[*]` becomes a special STAR token.
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
        // Malformed — treat the rest as a literal segment.
        tokens.push(part.slice(i))
        break
      }
      const inside = part.slice(lb + 1, rb)
      tokens.push(inside === "*" ? STAR : inside)
      i = rb + 1
    }
  }

  // Walk every token, branching on STAR.
  let frontier: unknown[] = [ctx]
  for (const tok of tokens) {
    const next: unknown[] = []
    for (const cur of frontier) {
      if (tok === STAR) {
        if (Array.isArray(cur)) {
          for (const el of cur) next.push(el)
        }
        // Non-array under [*] yields nothing — drop this branch.
      } else {
        if (cur && typeof cur === "object" && tok in (cur as object)) {
          next.push((cur as Record<string, unknown>)[tok])
        }
        // Missing key drops the branch.
      }
    }
    frontier = next
    if (frontier.length === 0) return []
  }
  return frontier
}

// Trigger as it lives in memory after normalization. action is always
// `string | null` (config-supplied undefined/missing field becomes
// null), enabled is always boolean.
type NormalizedTrigger = Omit<Trigger, "action" | "enabled"> & {
  action: string | null
  enabled: boolean
}

function normalizeTrigger(
  t: Trigger,
  extraIgnoreAuthors: string[],
  botLogin: string | null,
): NormalizedTrigger {
  // Merge config-supplied ignore_authors with extras (e.g. BOT_LOGINS
  // env-supplied). The "$BOT_LOGIN" placeholder anywhere in the
  // config-supplied list is substituted with the resolved bot login;
  // dropped silently if the bot identity isn't resolved (the trigger
  // simply won't filter that case, which is what we want — better to
  // run than to silently never fire).
  //
  // Auto-append happens ONLY through the "$BOT_LOGIN" placeholder, NOT
  // implicitly. Triggers like pr-opened legitimately want to fire on
  // the bot's own actions (self-review pass), so we don't blanket-add
  // the bot login to every trigger's ignore_authors.
  const merged: string[] = []
  const seen = new Set<string>()
  const sources = [...(t.ignore_authors ?? []), ...extraIgnoreAuthors]
  for (const raw of sources) {
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

  // Resolve the bot's identity once at boot. Cached for the lifetime
  // of the plugin process; used for two things downstream:
  //   1. As the default value for ignore_authors when BOT_LOGIN isn't
  //      set explicitly (self-loop prevention).
  //   2. As the comparison target for the require_bot_match identity
  //      gate (scope agents to "things addressed to the bot").
  // If resolution fails the plugin still boots, but identity-gated
  // triggers will refuse to fire until a restart picks up a new token.
  const botLogin = await resolveBotLogin()
  if (botLogin) {
    console.log(`[github-webhooks] bot identity: ${botLogin}`)
  } else {
    console.warn(
      `[github-webhooks] WARNING: could not resolve bot identity via 'gh api user' — triggers with require_bot_match will be skipped. Set GH_TOKEN to enable identity-gated triggers.`,
    )
  }

  // BOT_LOGIN / BOT_LOGINS: extra ignore_authors entries supplied via
  // env vars. Both are appended (deduped) to every trigger's
  // ignore_authors. These are useful when the bot operates under a
  // different commit-author identity than the gh CLI's authenticated
  // user (rare).
  //
  // The bot's own gh-resolved login is NOT appended here. Triggers
  // that want to filter the bot itself can use the literal string
  // "$BOT_LOGIN" in their config-supplied ignore_authors; the
  // placeholder is substituted at trigger-load time. This is opt-in
  // because some triggers (pr-opened, pr-ready-for-review) want to
  // fire on the bot's OWN actions (self-review pass on the bot's PRs).
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

      // Pull the sender login once for ignore_authors filtering. GitHub
      // sets this on every event payload to identify whoever caused the
      // event (the pusher, commenter, reviewer, etc.). For check_suite
      // / check_run events the sender is the app/bot that uploaded the
      // result, which is exactly the case we want to filter.
      const senderLogin =
        typeof payload === "object" && payload !== null
          ? (payload as { sender?: { login?: unknown } }).sender?.login
          : undefined
      const sender = typeof senderLogin === "string" ? senderLogin : null

      // Synthetic booleans for prompt templates. The mustache-ish
      // renderer can only do path lookup; it can't evaluate "is this
      // field present?" or "is this string non-empty?" without help.
      // Computing these once per delivery (rather than per-trigger)
      // keeps the template context consistent across triggers and
      // avoids surprising operators with renderer-internal logic.
      const ev = (payload as Record<string, unknown> | null) ?? {}
      const issuePR = lookup(ev, "issue.pull_request")
      const reviewBody = lookup(ev, "review.body")
      const reviewState = lookup(ev, "review.state")
      const checkConclusion =
        lookup(ev, "check_suite.conclusion") ??
        lookup(ev, "check_run.conclusion")
      const synthetics = {
        // True when the issue_comment event fired on a PR (rather than
        // a regular issue). issue.pull_request is an object on PRs and
        // missing on issues.
        is_pr_comment:
          issuePR !== undefined && issuePR !== null && issuePR !== "",
        // True when a pull_request_review.submitted event has
        // substantive body text (i.e. it's a real comment, not just a
        // wrapper around inline comments which fire their own events).
        is_review_with_body:
          typeof reviewBody === "string" && reviewBody.trim() !== "",
        // The review.state value, lowercased, or null. Useful for
        // templates that branch on approve/changes_requested/commented.
        review_state:
          typeof reviewState === "string" ? reviewState.toLowerCase() : null,
        // True when a check_suite/check_run event reports failure.
        is_ci_failure: checkConclusion === "failure",
      }

      const matches = findMatching(triggers, event, action)
      const dispatched: string[] = []
      const skipped: Array<{ name: string; reason: string }> = []
      for (const t of matches) {
        // Self-loop guard. Case-insensitive exact match on
        // payload.sender.login. Common values to filter:
        //   - 'github-actions[bot]'  (CI workflow runs)
        //   - the agent's own commit-author username
        if (t.ignore_authors && t.ignore_authors.length > 0 && sender) {
          const lower = sender.toLowerCase()
          const hit = t.ignore_authors.some(
            (a) => a.toLowerCase() === lower,
          )
          if (hit) {
            skipped.push({
              name: t.name,
              reason: `ignored sender '${sender}'`,
            })
            continue
          }
        }

        // Identity gate. Scopes the trigger to deliveries where the
        // bot's resolved login matches one of the configured payload
        // paths (e.g. assignee.login for issues, pull_request.user.login
        // for PRs). Fails closed when the bot login is unresolved so a
        // misconfigured deployment doesn't accidentally act on
        // arbitrary repos.
        const botMatchReason = evaluateBotMatch(
          t.require_bot_match,
          payload,
          botLogin,
        )
        if (botMatchReason) {
          skipped.push({ name: t.name, reason: botMatchReason })
          continue
        }

        // Payload-shape filter. Lets a trigger declare "fire only when
        // payload.check_suite.conclusion = 'failure'" without spinning
        // up a session that immediately BLOCKED-exits. Cheaper than
        // the agent's runtime check by an entire LLM call.
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
        ...(skipped.length > 0 ? { skipped } : {}),
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
