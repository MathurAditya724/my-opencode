// Cloudflare Email Worker: GitHub notification → /webhooks/email.
//
// Pipeline:
//   1. Read message.from / message.to / Message-ID for observability.
//   2. Match message.from against ALLOWED_SENDERS (static + /regex/).
//      Drop unmatched mail without forwarding (Cloudflare won't bounce).
//   3. Buffer the raw RFC822 body.
//   4. HMAC-sha256 sign the body with EMAIL_WEBHOOK_SECRET.
//   5. POST to SIDECAR_URL with the signature + envelope headers.
//   6. On 5xx, throw so Cloudflare retries the email later. On 4xx, log
//      and accept (those are permanent — bad signature, dedup hit, etc.).

export interface Env {
  ALLOWED_SENDERS: string // JSON-encoded string[]
  SIDECAR_URL: string
  EMAIL_WEBHOOK_SECRET: string
}

type Pattern =
  | { kind: "exact"; value: string }
  | { kind: "regex"; re: RegExp }

export default {
  async email(message, env, _ctx) {
    const patterns = parsePatterns(env.ALLOWED_SENDERS)
    if (!matchesAnyPattern(message.from, patterns)) {
      console.log(
        `drop: from=${message.from} to=${message.to} (no allowlist match)`,
      )
      return
    }

    const body = new Uint8Array(
      await new Response(message.raw).arrayBuffer(),
    )

    const sig = await hmacSha256Hex(env.EMAIL_WEBHOOK_SECRET, body)
    const messageId = message.headers.get("message-id") ?? ""

    const res = await fetch(env.SIDECAR_URL, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-email-signature-256": `sha256=${sig}`,
        "x-email-from": message.from,
        "x-email-to": message.to,
        "x-email-message-id": messageId,
      },
      body,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.error(
        `forward failed: status=${res.status} from=${message.from} message-id=${messageId} body=${text.slice(0, 200)}`,
      )
      // Re-throw on 5xx so Cloudflare retries; on 4xx accept (permanent).
      if (res.status >= 500) {
        throw new Error(`sidecar ${res.status}`)
      }
    }
  },
} satisfies ExportedHandler<Env>

function parsePatterns(raw: string): Pattern[] {
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: Pattern[] = []
  for (const s of arr) {
    if (typeof s !== "string" || s.length === 0) continue
    if (s.length >= 2 && s.startsWith("/") && s.endsWith("/")) {
      try {
        out.push({ kind: "regex", re: new RegExp(s.slice(1, -1), "i") })
      } catch {
        // bad regex — skip
      }
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
