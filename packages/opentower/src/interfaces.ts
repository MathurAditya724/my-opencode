// Core interfaces for the opentower architecture.
// These abstractions allow opentower to run as both an OpenCode plugin
// and a standalone server, and to support multiple webhook sources
// and agent backends.

import type { Dedup } from "./dedup"
import type { EntityResolver } from "./entity-resolver"
import type { Pipeline } from "./pipeline"
import type { LifecycleStore } from "./storage"

// Narrow interface for the OpenCode session client.
// Only the 3 methods actually used by the pipeline and tools.
export type AgentClient = {
  session: {
    create(opts: {
      body: { title: string }
      query: { directory: string }
      signal: AbortSignal
    }): Promise<{ data?: { id: string; share?: { url: string } } }>

    prompt(opts: {
      path: { id: string }
      body: { agent?: string; parts: Array<{ type: "text"; text: string }> }
      signal: AbortSignal
    }): Promise<{ error?: unknown; data?: unknown }>

    messages(opts: {
      path: { id: string }
      query: { limit: number }
      signal: AbortSignal
    }): Promise<{
      error?: unknown
      data?: Array<{
        info: { role: string; time: { created: number } }
        parts: Array<{ type: string; text?: string; tool?: string }>
      }>
    }>
  }
}

// Shared context available to all webhook handlers.
export type HandlerContext = {
  pipeline: Pipeline
  dedup: Dedup
  store: LifecycleStore
  botLogin: string | null
  entityResolver: EntityResolver | null
}

// Interface for pluggable webhook/event handlers.
// Each handler registers its own routes on the Hono app.
// Uses `any` for the app parameter to avoid coupling to a specific Hono env type.
export type WebhookHandler = {
  source: string
  register(app: any, context: HandlerContext): void
}
