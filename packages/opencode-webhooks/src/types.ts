// Shared types for the opencode-webhooks plugin.

export type Trigger = {
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

export type WebhookConfig = {
  port?: number
  secret?: string               // falls back to GITHUB_WEBHOOK_SECRET
  timeout_ms?: number           // per-session abort, default 30 min
  max_concurrent?: number       // default 2
  default_cwd?: string          // fallback session cwd
  db_path?: string              // dedup SQLite file
  retention?: number            // cap on persisted deliveries, default 1000
  triggers?: Trigger[]
}

export type NormalizedTrigger = Omit<Trigger, "action" | "enabled"> & {
  action: string | null
  enabled: boolean
}

export type SkippedDispatch = {
  name: string
  reason: string
}
