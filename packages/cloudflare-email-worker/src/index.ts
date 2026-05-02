// Cloudflare Email Worker: dumb pipe in front of opencode-webhooks.
//
// Pipeline per inbound email:
//   1. If sender != FORWARD_TO: message.forward(FORWARD_TO). Skipped
//      when the sender IS the FORWARD_TO address to prevent a loop.
//   2. If message.from is in ALLOWED_SENDERS or matches FORWARD_TO,
//      build a small JSON event from the headers we care about,
//      HMAC-sign it, and POST to WEBHOOK_URL.
//   3. On 5xx from the webhook, throw so Cloudflare retries the email.
//      4xx is permanent (signature rejected, dedup hit, etc.) — accept.
//
// All RFC822 parsing stays out of the worker: the plugin already has
// gh-api access for canonical state, and Cloudflare hands us a parsed
// `message.headers` so we don't need to re-implement header decoding.

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

    // 1. Forward to the operator's inbox — unless the email came FROM
    //    that same address (reply from the operator). Wrap in try/catch
    //    so a bad FORWARD_TO (unverified destination, etc.) doesn't
    //    block webhook dispatch.
    if (env.FORWARD_TO && !isFromForwardTo) {
      try {
        await message.forward(env.FORWARD_TO)
      } catch (err) {
        console.error(
          `forward failed: to=${env.FORWARD_TO} message-id=${messageId} err=${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // 2. Webhook gate: allowlisted senders or FORWARD_TO replies.
    if (!isFromForwardTo && !matchesAnyPattern(message.from, COMPILED_PATTERNS)) {
      console.log(
        `webhook skipped: from=${message.from} (not in allowlist)`,
      )
      return
    }

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
      const text = await res.text().catch(() => "")
      console.error(
        `webhook failed: status=${res.status} from=${message.from} message-id=${messageId} body=${text.slice(0, 200)}`,
      )
      if (res.status >= 500) {
        throw new Error(`webhook ${res.status}`)
      }
    }
  },
} satisfies ExportedHandler<Env>

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
