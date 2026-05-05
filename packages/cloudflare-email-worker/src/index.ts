// Cloudflare Email Worker: dumb pipe in front of openhealer.
//
// Pipeline per inbound email:
//   1. If sender is not FORWARD_TO and not in ALLOWED_EMAILS:
//      message.forward(FORWARD_TO). Skipped when the sender IS one of
//      those addresses to prevent a loop / re-send.
//   2. If message.from matches a pattern in the D1 allowed_senders
//      table, matches FORWARD_TO, or is in ALLOWED_EMAILS: read the
//      raw RFC822 message, extract plain-text and HTML body parts,
//      build a JSON event with headers + body, HMAC-sign it, and POST
//      to WEBHOOK_URL.
//   3. On 5xx from the webhook, throw so Cloudflare retries the email.
//      4xx is permanent (signature rejected, dedup hit, etc.) -- accept.
//
// The allowed_senders table is managed via the fetch() handler:
//   GET  /senders          — list (pagination + search)
//   POST /senders          — create a pattern
//   DELETE /senders/:pattern — remove a pattern
// All endpoints require Bearer <EMAIL_WEBHOOK_SECRET>.

// Seed patterns inserted into D1 on first run. Once in the DB they
// are ordinary rows — deletable via the API like any other entry.
const SEED_SENDERS: readonly { pattern: string; kind: "exact" | "regex" }[] = [
  { pattern: "notifications@github.com", kind: "exact" },
  { pattern: "/^.*@github\\.com$/", kind: "regex" },
]

export interface Env {
  WEBHOOK_URL: string
  EMAIL_WEBHOOK_SECRET: string
  DB: D1Database
  FORWARD_TO?: string
  ALLOWED_EMAILS?: string
}

type Pattern =
  | { kind: "exact"; value: string }
  | { kind: "regex"; re: RegExp }

export default {
  async email(message, env, _ctx) {
    const messageId = message.headers.get("message-id") ?? ""
    const senderAddr = extractAddress(message.from).toLowerCase()
    const forwardTo = extractAddress(env.FORWARD_TO ?? "").toLowerCase()
    const isFromForwardTo = forwardTo !== "" && senderAddr === forwardTo

    const allowedEmails = parseAllowedEmails(env.ALLOWED_EMAILS)
    const isFromAllowedEmail = allowedEmails.has(senderAddr)

    // 1. Forward to the operator's inbox -- unless the email came FROM
    //    the FORWARD_TO address or one of the ALLOWED_EMAILS addresses.
    if (env.FORWARD_TO && !isFromForwardTo && !isFromAllowedEmail) {
      try {
        await message.forward(env.FORWARD_TO)
      } catch (err) {
        console.error(
          `forward failed: to=${env.FORWARD_TO} message-id=${messageId} err=${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // 2. Webhook gate: query D1 for allowlisted patterns.
    if (!isFromForwardTo && !isFromAllowedEmail) {
      const patterns = await loadPatterns(env.DB)
      if (!matchesAnyPattern(message.from, patterns)) {
        console.log(`webhook skipped: from=${message.from} (not in allowlist)`)
        return
      }
    }

    // 3. Read the raw RFC822 message and extract body parts.
    const rawBytes = await streamToBytes(message.raw, message.rawSize)
    const rawText = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes)
    const { text, html } = extractBody(rawText)

    const references = (message.headers.get("references") ?? "")
      .split(/\s+/)
      .filter(Boolean)

    const payload = {
      from: message.from,
      to: message.to,
      subject: message.headers.get("subject") ?? "",
      message_id: messageId,
      in_reply_to: message.headers.get("in-reply-to") ?? null,
      references,
      list_id: message.headers.get("list-id") ?? null,
      x_github_reason: message.headers.get("x-github-reason") ?? null,
      x_github_sender: message.headers.get("x-github-sender") ?? null,
      body_text: text,
      body_html: html,
    }

    const body = JSON.stringify(payload)
    const sig = await hmacSha256Hex(
      env.EMAIL_WEBHOOK_SECRET,
      new TextEncoder().encode(body),
    )

    const res = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-email-signature-256": `sha256=${sig}`,
      },
      body,
    })

    if (!res.ok) {
      const respText = await res.text().catch(() => "")
      console.error(
        `webhook failed: status=${res.status} from=${message.from} message-id=${messageId} body=${respText.slice(0, 200)}`,
      )
      if (res.status >= 500) {
        throw new Error(`webhook ${res.status}`)
      }
    }
  },

  async fetch(request, env, _ctx) {
    const url = new URL(request.url)

    // Health check — no auth required.
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true })
    }

    // Bearer auth for all /senders routes.
    const authHeader = request.headers.get("authorization") ?? ""
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (!token || !env.EMAIL_WEBHOOK_SECRET || token !== env.EMAIL_WEBHOOK_SECRET) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    // POST /seed — one-time seed of default patterns.
    if (request.method === "POST" && url.pathname === "/seed") {
      return handleSeed(env.DB)
    }

    // GET /senders — list with pagination and search.
    if (request.method === "GET" && url.pathname === "/senders") {
      return handleListSenders(env.DB, url)
    }

    // POST /senders — create a pattern.
    if (request.method === "POST" && url.pathname === "/senders") {
      return handleCreateSender(env.DB, request)
    }

    // DELETE /senders/:pattern
    if (request.method === "DELETE" && url.pathname.startsWith("/senders/")) {
      const pattern = decodeURIComponent(url.pathname.slice("/senders/".length))
      return handleDeleteSender(env.DB, pattern)
    }

    return Response.json({ error: "not found" }, { status: 404 })
  },
} satisfies ExportedHandler<Env>

// --- D1 allowlist ---

async function loadPatterns(db: D1Database): Promise<Pattern[]> {
  const { results } = await db
    .prepare("SELECT pattern, kind FROM allowed_senders")
    .all<{ pattern: string; kind: string }>()
  return compileRows(results)
}

function compileRows(rows: { pattern: string; kind: string }[]): Pattern[] {
  const out: Pattern[] = []
  for (const row of rows) {
    if (row.kind === "regex") {
      const body = row.pattern.startsWith("/") && row.pattern.endsWith("/")
        ? row.pattern.slice(1, -1)
        : row.pattern
      try {
        out.push({ kind: "regex", re: new RegExp(body, "i") })
      } catch {
        console.error(`invalid regex in allowed_senders: ${row.pattern}`)
      }
    } else {
      out.push({ kind: "exact", value: row.pattern.toLowerCase() })
    }
  }
  return out
}

async function handleSeed(db: D1Database): Promise<Response> {
  let inserted = 0
  for (const s of SEED_SENDERS) {
    const { meta } = await db
      .prepare(
        "INSERT INTO allowed_senders (pattern, kind) VALUES (?, ?) ON CONFLICT (pattern) DO NOTHING",
      )
      .bind(s.pattern, s.kind)
      .run()
    if (meta.changes > 0) inserted++
  }
  return Response.json({ seeded: inserted })
}

async function handleListSenders(
  db: D1Database,
  url: URL,
): Promise<Response> {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200)
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0)
  const search = url.searchParams.get("search") ?? ""

  let query: string
  let countQuery: string
  const binds: unknown[] = []
  const countBinds: unknown[] = []

  if (search) {
    query = "SELECT pattern, kind, created_at FROM allowed_senders WHERE pattern LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ? OFFSET ?"
    countQuery = "SELECT COUNT(*) as total FROM allowed_senders WHERE pattern LIKE ? ESCAPE '\\'"
    const like = `%${search.replace(/[%_\\]/g, "\\$&")}%`
    binds.push(like, limit, offset)
    countBinds.push(like)
  } else {
    query = "SELECT pattern, kind, created_at FROM allowed_senders ORDER BY created_at DESC LIMIT ? OFFSET ?"
    countQuery = "SELECT COUNT(*) as total FROM allowed_senders"
    binds.push(limit, offset)
  }

  const [data, count] = await Promise.all([
    db.prepare(query).bind(...binds).all<{ pattern: string; kind: string; created_at: string }>(),
    db.prepare(countQuery).bind(...countBinds).first<{ total: number }>(),
  ])

  return Response.json({
    senders: data.results,
    total: count?.total ?? 0,
    limit,
    offset,
  })
}

async function handleCreateSender(
  db: D1Database,
  request: Request,
): Promise<Response> {
  let body: { pattern?: string; kind?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 })
  }

  const pattern = typeof body.pattern === "string" ? body.pattern.trim() : ""
  if (!pattern) {
    return Response.json({ error: "pattern is required" }, { status: 400 })
  }

  // Auto-detect kind if not provided: /.../ → regex, otherwise exact.
  let kind = typeof body.kind === "string" ? body.kind : ""
  if (!kind) {
    kind = pattern.startsWith("/") && pattern.endsWith("/") && pattern.length >= 2
      ? "regex"
      : "exact"
  }
  if (kind !== "exact" && kind !== "regex") {
    return Response.json({ error: "kind must be 'exact' or 'regex'" }, { status: 400 })
  }

  if (kind === "regex") {
    const re = pattern.startsWith("/") && pattern.endsWith("/")
      ? pattern.slice(1, -1)
      : pattern
    try {
      new RegExp(re, "i")
    } catch {
      return Response.json({ error: "invalid regex pattern" }, { status: 400 })
    }
  }

  try {
    await db
      .prepare("INSERT INTO allowed_senders (pattern, kind) VALUES (?, ?)")
      .bind(pattern, kind)
      .run()
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      return Response.json({ error: "pattern already exists" }, { status: 409 })
    }
    throw err
  }

  return Response.json({ created: { pattern, kind } }, { status: 201 })
}

async function handleDeleteSender(
  db: D1Database,
  pattern: string,
): Promise<Response> {
  if (!pattern) {
    return Response.json({ error: "pattern is required" }, { status: 400 })
  }

  const { meta } = await db
    .prepare("DELETE FROM allowed_senders WHERE pattern = ?")
    .bind(pattern)
    .run()

  if (meta.changes === 0) {
    return Response.json({ error: "not found" }, { status: 404 })
  }
  return Response.json({ deleted: pattern })
}

// --- RFC822 body extraction ---

async function streamToBytes(
  stream: ReadableStream,
  sizeHint: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const cap = Math.min(sizeHint + 1024, 512 * 1024)
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total > cap) break
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

// Minimal MIME body extraction. Handles:
// - Simple single-part messages (text/plain or text/html after headers)
// - Multipart messages (extracts text/plain and text/html parts)
// - Nested multipart (e.g. multipart/alternative inside multipart/mixed)
// - Base64 and quoted-printable transfer encodings
function extractBody(raw: string): { text: string | null; html: string | null } {
  const headerEnd = raw.indexOf("\r\n\r\n")
  if (headerEnd === -1) {
    const altEnd = raw.indexOf("\n\n")
    if (altEnd === -1) return { text: null, html: null }
    return extractBodyFromParts(raw.slice(0, altEnd), raw.slice(altEnd + 2))
  }
  return extractBodyFromParts(raw.slice(0, headerEnd), raw.slice(headerEnd + 4))
}

function extractBodyFromParts(
  headers: string,
  body: string,
): { text: string | null; html: string | null } {
  const ct = findHeader(headers, "content-type") ?? "text/plain"
  const boundaryMatch = ct.match(/boundary="?([^";\s]+)"?/i)

  if (boundaryMatch) {
    return extractMultipartBody(body, boundaryMatch[1])
  }

  const decoded = decodeTransferEncoding(body, findHeader(headers, "content-transfer-encoding"))
  if (ct.toLowerCase().includes("text/html")) {
    return { text: null, html: decoded }
  }
  return { text: decoded, html: null }
}

function extractMultipartBody(
  body: string,
  boundary: string,
): { text: string | null; html: string | null } {
  let text: string | null = null
  let html: string | null = null
  const delimiter = `--${boundary}`
  const parts = body.split(delimiter)

  for (const part of parts) {
    if (part.startsWith("--") || part.trim() === "") continue

    const partHeaderEnd = part.indexOf("\r\n\r\n")
    const altPartHeaderEnd = part.indexOf("\n\n")
    let partHeaders: string
    let partBody: string

    if (partHeaderEnd !== -1) {
      partHeaders = part.slice(0, partHeaderEnd)
      partBody = part.slice(partHeaderEnd + 4)
    } else if (altPartHeaderEnd !== -1) {
      partHeaders = part.slice(0, altPartHeaderEnd)
      partBody = part.slice(altPartHeaderEnd + 2)
    } else {
      continue
    }

    const partCt = (findHeader(partHeaders, "content-type") ?? "").toLowerCase()
    const cte = findHeader(partHeaders, "content-transfer-encoding")

    // Recurse into nested multipart parts.
    const nestedBoundary = partCt.match(/boundary="?([^";\s]+)"?/i)
    if (nestedBoundary) {
      const nested = extractMultipartBody(partBody, nestedBoundary[1])
      if (!text && nested.text) text = nested.text
      if (!html && nested.html) html = nested.html
      continue
    }

    const decoded = decodeTransferEncoding(partBody, cte)
    if (partCt.includes("text/plain") && !text) {
      text = decoded
    } else if (partCt.includes("text/html") && !html) {
      html = decoded
    }
  }
  return { text, html }
}

function findHeader(headers: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*(.+)`, "im")
  const m = headers.match(re)
  if (!m) return null
  let value = m[1]
  const rest = headers.slice((m.index ?? 0) + m[0].length)
  const cont = rest.match(/^(?:\r?\n[ \t]+.+)+/)
  if (cont) value += cont[0].replace(/\r?\n[ \t]+/g, " ")
  return value.trim()
}

function decodeTransferEncoding(body: string, encoding: string | null): string {
  const enc = (encoding ?? "").trim().toLowerCase()
  if (enc === "base64") {
    try {
      return atob(body.replace(/\s/g, ""))
    } catch {
      return body
    }
  }
  if (enc === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
  }
  return body
}

// --- Utilities ---

function matchesAnyPattern(from: string, patterns: Pattern[]): boolean {
  if (patterns.length === 0) return false
  const addr = extractAddress(from).toLowerCase()
  return patterns.some((p) =>
    p.kind === "exact" ? p.value === addr : p.re.test(addr),
  )
}

function extractAddress(from: string): string {
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from).trim()
}

function parseAllowedEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

async function hmacSha256Hex(
  secret: string,
  data: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, data)
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
