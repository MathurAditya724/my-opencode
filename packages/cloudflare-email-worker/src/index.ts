// Cloudflare Email Worker: dumb pipe in front of opencode-webhooks.
//
// Pipeline per inbound email:
//   1. If sender is not FORWARD_TO and not in ALLOWED_EMAILS:
//      message.forward(FORWARD_TO). Skipped when the sender IS one of
//      those addresses to prevent a loop / re-send.
//   2. If message.from is in ALLOWED_SENDERS, matches FORWARD_TO, or
//      is in ALLOWED_EMAILS: read the raw RFC822 message, extract
//      plain-text and HTML body parts, build a JSON event with headers
//      + body, HMAC-sign it, and POST to WEBHOOK_URL.
//   3. On 5xx from the webhook, throw so Cloudflare retries the email.
//      4xx is permanent (signature rejected, dedup hit, etc.) -- accept.

// Sender allowlist for the webhook gate. Strings starting and ending
// with "/" are treated as case-insensitive regex; everything else is
// case-insensitive exact match against the bare address parsed out of
// the From header.
const ALLOWED_SENDERS: readonly string[] = [
  "notifications@github.com",
  "/^.*@github\\.com$/",
]

export interface Env {
  WEBHOOK_URL: string
  EMAIL_WEBHOOK_SECRET: string
  // Optional. If set, every inbound email is forwarded here verbatim
  // (DKIM-preserving via Cloudflare's message.forward()). The address
  // must be verified in Cloudflare Email Routing first.
  //
  // Emails FROM this address are auto-allowed for the webhook (replies
  // from the operator's inbox trigger the agent) and are NOT forwarded
  // back (prevents loop).
  FORWARD_TO?: string
  // Optional. Comma-separated list of email addresses that are treated
  // exactly like FORWARD_TO: emails from these senders are NOT
  // forwarded back and are auto-allowed through the webhook gate.
  // Useful for additional operator inboxes that should reach the agent
  // without being re-sent. Set via `wrangler secret put ALLOWED_EMAILS`.
  ALLOWED_EMAILS?: string
}

type Pattern =
  | { kind: "exact"; value: string }
  | { kind: "regex"; re: RegExp }

const COMPILED_PATTERNS: Pattern[] = compilePatterns(ALLOWED_SENDERS)

export default {
  async email(message, env, _ctx) {
    const messageId = message.headers.get("message-id") ?? ""
    const senderAddr = extractAddress(message.from).toLowerCase()
    const forwardTo = extractAddress(env.FORWARD_TO ?? "").toLowerCase()
    const isFromForwardTo = forwardTo !== "" && senderAddr === forwardTo

    // Parse ALLOWED_EMAILS: comma-separated addresses treated like
    // FORWARD_TO (no re-send, auto-allowed for webhook).
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

    // 2. Webhook gate: allowlisted senders, FORWARD_TO replies, or
    //    ALLOWED_EMAILS addresses.
    if (!isFromForwardTo && !isFromAllowedEmail && !matchesAnyPattern(message.from, COMPILED_PATTERNS)) {
      console.log(
        `webhook skipped: from=${message.from} (not in allowlist)`,
      )
      return
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
} satisfies ExportedHandler<Env>

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

function compilePatterns(raw: readonly string[]): Pattern[] {
  const out: Pattern[] = []
  for (const s of raw) {
    if (s.length === 0) continue
    if (s.length >= 2 && s.startsWith("/") && s.endsWith("/")) {
      out.push({ kind: "regex", re: new RegExp(s.slice(1, -1), "i") })
      continue
    }
    out.push({ kind: "exact", value: s.toLowerCase() })
  }
  return out
}

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
