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
  // Supports trailing wildcard: "email.*" matches any email.* event.
  event: string | string[]
  action?: string | null        // e.g. "assigned"; null = any action
  agent: string
  prompt_template: string       // {{ payload.foo.bar }} placeholders
  cwd?: string | null
  enabled?: boolean
  // Skip if payload.sender.login matches any entry (case-insensitive).
  // The literal "$BOT_LOGIN" is substituted with the resolved bot login.
  ignore_authors?: string[]
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
  // Entries may contain trailing wildcards (e.g. "email.*").
  events: string[]
}

export type SkippedDispatch = {
  name: string
  reason: string
}

// Lifecycle states for a dispatch row. pending = matched + persisted but
// session.create not yet called; running = session created, prompt in
// flight; the rest are terminal.
export type DispatchStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"

export type DispatchRow = {
  id: number
  delivery_id: string
  trigger_name: string
  matched_event: string
  agent: string
  session_id: string | null
  status: DispatchStatus
  started_at: number
  completed_at: number | null
  error: string | null
}

export type DeliveryRow = {
  delivery_id: string
  external_id: string
  event: string
  action: string | null
  received_at: number
}

// List-view row: delivery + per-status dispatch counts. Cheap to compute
// via LEFT JOIN + GROUP BY so the list endpoint stays paginated without
// nested arrays.
export type DeliveryListItem = DeliveryRow & {
  dispatch_count: number
  statuses: Partial<Record<DispatchStatus, number>>
}
