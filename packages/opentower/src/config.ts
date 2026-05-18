// Config file loading + per-trigger normalization.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import type { GithubAppConfig, NormalizedTrigger, Trigger, WebhookConfig } from "./types"

// Read webhooks.json. Default ~/.config/opencode/webhooks.json,
// override via WEBHOOKS_CONFIG. Missing file = no triggers.
export async function readWebhookConfig(): Promise<WebhookConfig> {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as WebhookConfig
  } catch (err) {
    console.error(`[opentower] failed to parse config at ${path}:`, err)
    return {}
  }
}

export function configPath(): string {
  return process.env.WEBHOOKS_CONFIG ?? `${homedir()}/.config/opencode/webhooks.json`
}

// Normalize a trigger's ignore_authors:
//  - "$BOT_LOGIN" is substituted with the resolved bot login (dropped
//    silently if unresolved).
//  - Dedup is case-insensitive.
export function normalizeTrigger(t: Trigger, botLogin: string | null): NormalizedTrigger {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const raw of t.ignore_authors ?? []) {
    const expanded = raw === "$BOT_LOGIN" ? botLogin : raw
    if (!expanded) continue
    const k = expanded.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(expanded)
  }
  // Normalize event to always be an array so matchers can stay simple.
  const events = Array.isArray(t.event) ? t.event : [t.event]
  const { event: _drop, ...rest } = t
  return {
    ...rest,
    source: t.source ?? "github_webhook",
    action: t.action ?? null,
    enabled: t.enabled !== false,
    events,
    ignore_authors: merged.length > 0 ? merged : undefined,
  }
}

// Resolve GitHub App config from environment variables.
// Returns null if any required variable is missing.
export function resolveGithubAppFromEnv(): GithubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET
  if (!appId || !rawKey || !webhookSecret) return null
  // PEM keys stored in env vars often have literal "\n" instead of
  // real newlines. Normalize so crypto.createSign can parse the key.
  const privateKey = rawKey.replace(/\\n/g, "\n")
  return { app_id: appId, private_key: privateKey, webhook_secret: webhookSecret }
}
