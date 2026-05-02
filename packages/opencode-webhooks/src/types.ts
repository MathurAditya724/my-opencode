// Shared types for the opencode-webhooks plugin.

export type TriggerSource = "github_webhook" | "email"

export type Trigger = {
  name: string
  source?: TriggerSource
  event: string | string[]
  action?: string | null
  agent: string
  prompt_template: string
  cwd?: string | null
  enabled?: boolean
  ignore_authors?: string[]
}

export type WebhookConfig = {
  port?: number
  secret?: string
  email_secret?: string
  timeout_ms?: number
  max_concurrent?: number
  batch_window_ms?: number
  default_cwd?: string
  triggers?: Trigger[]
}

export type NormalizedTrigger = Omit<Trigger, "action" | "enabled" | "source" | "event"> & {
  source: TriggerSource
  action: string | null
  enabled: boolean
  events: string[]
}

export type SkippedDispatch = {
  name: string
  reason: string
}
