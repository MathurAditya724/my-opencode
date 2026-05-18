// Handler registry: creates and collects all enabled WebhookHandlers
// based on the current configuration.

import { createGitHubAppAuth } from "../github-app-auth"
import type { WebhookHandler } from "../interfaces"
import type { GithubAppConfig, NormalizedTrigger } from "../types"
import { createEmailWebhookHandler } from "./email-webhook"
import { createGithubAppHandler } from "./github-app"
import { createGithubWebhookHandler } from "./github-webhook"

export type HandlerRegistryOptions = {
  secret: string
  emailSecret: string
  triggers: NormalizedTrigger[]
  githubApp?: GithubAppConfig | null
}

export function createHandlers(opts: HandlerRegistryOptions): WebhookHandler[] {
  const handlers: WebhookHandler[] = []

  const githubTriggers = opts.triggers.filter((t) => t.source === "github_webhook")
  const emailTriggers = opts.triggers.filter((t) => t.source === "email")
  const githubAppTriggers = opts.triggers.filter((t) => t.source === "github_app")

  if (githubTriggers.length > 0) {
    handlers.push(
      createGithubWebhookHandler({
        secret: opts.secret,
        triggers: githubTriggers,
      }),
    )
  }

  if (emailTriggers.length > 0) {
    handlers.push(
      createEmailWebhookHandler({
        secret: opts.emailSecret,
        triggers: emailTriggers,
      }),
    )
  }

  if (githubAppTriggers.length > 0 && opts.githubApp) {
    const auth = createGitHubAppAuth(opts.githubApp.app_id, opts.githubApp.private_key)
    handlers.push(
      createGithubAppHandler({
        webhookSecret: opts.githubApp.webhook_secret,
        triggers: githubAppTriggers,
        auth,
      }),
    )
  }

  return handlers
}
