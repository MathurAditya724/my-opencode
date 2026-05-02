// Shared types for the opencode-webhooks plugin.

export type TriggerSource = "github_webhook" | "email"

export type Trigger = {
  name: string
  // Where the event originates. Defaults to "github_webhook" so existing
  // configs keep working unchanged.
  source?: TriggerSource
  // For source=github_webhook: GitHub event header (e.g. "issues", "*").
  // For source=email:          synthetic event "email.<reason>"
  //                            (e.g. "email.mention", "email.review_requested").
  // Accepts a single event string or an array (OR-matched).
  event: string | string[]
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

export type WebhookConfig = {
  port?: number
  secret?: string               // GitHub HMAC; falls back to GITHUB_WEBHOOK_SECRET
  email_secret?: string         // Email-worker HMAC; falls back to EMAIL_WEBHOOK_SECRET
  // Defense-in-depth re-check of the email worker's From-address
  // allowlist. Same format as the worker's ALLOWED_SENDERS: array of
  // exact-match strings or "/regex/" patterns.
  email_allowed_senders?: string[]
  timeout_ms?: number           // per-session abort, default 30 min
  max_concurrent?: number       // default 2
  default_cwd?: string          // fallback session cwd
  db_path?: string              // dedup SQLite file
  retention?: number            // cap on persisted deliveries, default 1000
  triggers?: Trigger[]
}

export type NormalizedTrigger = Omit<Trigger, "action" | "enabled" | "source" | "event"> & {
  source: TriggerSource
  action: string | null
  enabled: boolean
  // Always normalized to an array so matchers don't need to branch.
  events: string[]
}

export type SkippedDispatch = {
  name: string
  reason: string
}
