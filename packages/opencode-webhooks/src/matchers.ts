// Per-trigger filters + the shared evaluate-and-dispatch loop used by
// both the GitHub and email fetch handlers. The agent handles identity
// gates and payload filtering; the plugin only handles event matching,
// self-loop guard (ignore_authors), and dispatch via the pipeline.

import { extractEntityKey } from "./entity"
import type { Pipeline } from "./pipeline"
import type { DeliveryStore } from "./storage"
import { renderTemplate } from "./template"
import type { NormalizedTrigger, SkippedDispatch } from "./types"

// Match an event string against a pattern. Supports exact match, "*"
// (matches anything), and trailing wildcard like "email.*" (matches
// any event starting with "email.").
function eventMatches(pattern: string, event: string): boolean {
  if (pattern === "*") return true
  if (pattern === event) return true
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1) // "email.*" -> "email."
    return event.startsWith(prefix)
  }
  return false
}

// Every enabled trigger matching (event, action) fires.
export function findMatching(
  triggers: NormalizedTrigger[],
  event: string,
  action: string | null,
): NormalizedTrigger[] {
  return triggers.filter((t) => {
    if (t.enabled === false) return false
    const eventOk = t.events.some((e) => eventMatches(e, event))
    if (!eventOk) return false
    return t.action === null || t.action === action
  })
}

// Sender filter (self-loop guard). Case-insensitive exact match
// against payload.sender.login.
export function evaluateIgnoreAuthors(
  ignoreAuthors: string[] | undefined,
  sender: string | null,
): string | null {
  if (!ignoreAuthors || ignoreAuthors.length === 0 || !sender) return null
  const lower = sender.toLowerCase()
  if (ignoreAuthors.some((a) => a.toLowerCase() === lower)) {
    return `ignored sender '${sender}'`
  }
  return null
}

// Run the full per-trigger pipeline (sender guard → entity extraction
// → session affinity → dispatch). Events for the same entity reuse
// the same OpenCode session; events without a recognizable entity
// fall through to fire-and-forget dispatch.
export function evaluateAndDispatch(opts: {
  triggers: NormalizedTrigger[]
  event: string
  action: string | null
  payload: unknown
  sender: string | null
  botLogin: string | null
  deliveryId: string
  templateContext: Record<string, unknown>
  pipeline: Pipeline
  store: DeliveryStore
}): { dispatched: string[]; skipped: SkippedDispatch[] } {
  const dispatched: string[] = []
  const skipped: SkippedDispatch[] = []

  const entityKey = extractEntityKey(opts.event, opts.payload)

  for (const t of findMatching(opts.triggers, opts.event, opts.action)) {
    const reason = evaluateIgnoreAuthors(t.ignore_authors, opts.sender)
    if (reason) {
      skipped.push({ name: t.name, reason })
      continue
    }
    const prompt = renderTemplate(t.prompt_template, opts.templateContext)
    // Persist a pending row before fire-and-forget so the lifecycle
    // is recoverable from the DB even if the dispatcher crashes.
    const dispatchId = opts.store.createDispatch(
      opts.deliveryId,
      t.name,
      opts.event,
      t.agent,
      entityKey?.key ?? null,
      prompt,
    )

    if (entityKey) {
      opts.pipeline.dispatch(
        entityKey,
        t,
        prompt,
        opts.deliveryId,
        opts.event,
        dispatchId,
      )
    } else {
      opts.pipeline.dispatchNoAffinity(
        t,
        prompt,
        opts.deliveryId,
        opts.event,
        dispatchId,
      )
    }
    dispatched.push(t.name)
  }

  // Persist skipped triggers on the delivery for the dashboard.
  if (skipped.length > 0) {
    opts.store.saveSkipped(opts.deliveryId, skipped)
  }

  return { dispatched, skipped }
}
