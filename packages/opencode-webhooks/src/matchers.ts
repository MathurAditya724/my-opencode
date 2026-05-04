// Per-trigger filters + the shared evaluate-and-dispatch loop used by
// both the GitHub and email handlers. The agent handles identity gates
// and payload filtering; the plugin only handles event matching,
// self-loop guard (ignore_authors), and dispatch via the pipeline.

import * as Sentry from "@sentry/bun"
import { extractEntityKey } from "./entity"
import type { Pipeline } from "./pipeline"
import { renderTemplate } from "./template"
import type { NormalizedTrigger, SkippedDispatch } from "./types"

// Match an event pattern against an incoming event + action.
// Supported pattern forms:
//   "issues"                — matches event "issues" with any action
//   "workflow_run:completed" — matches event "workflow_run" only when action is "completed"
//   "email.*"               — prefix wildcard (matches "email.received", etc.)
//   "*"                     — matches everything
function eventMatches(pattern: string, event: string, action: string | null): boolean {
  if (pattern === "*") return true

  // "event:action" — per-event action filter
  const colon = pattern.indexOf(":")
  if (colon !== -1) {
    const evPart = pattern.slice(0, colon)
    const actPart = pattern.slice(colon + 1)
    return evPart === event && actPart === action
  }

  if (pattern === event) return true
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1)
    return event.startsWith(prefix)
  }
  return false
}

export function findMatching(
  triggers: NormalizedTrigger[],
  event: string,
  action: string | null,
): NormalizedTrigger[] {
  return triggers.filter((t) => {
    if (t.enabled === false) return false
    const eventOk = t.events.some((e) => eventMatches(e, event, action))
    if (!eventOk) return false
    return t.action === null || t.action === action
  })
}

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
}): { dispatched: string[]; skipped: SkippedDispatch[] } {
  const dispatched: string[] = []
  const skipped: SkippedDispatch[] = []

  const entityKey = extractEntityKey(opts.event, opts.payload)

  for (const t of findMatching(opts.triggers, opts.event, opts.action)) {
    const reason = evaluateIgnoreAuthors(t.ignore_authors, opts.sender)
    if (reason) {
      skipped.push({ name: t.name, reason })
      Sentry.logger.info("trigger.skipped", {
        trigger_name: t.name,
        event: opts.event,
        reason,
        delivery_id: opts.deliveryId,
      })
      continue
    }

    const prompt = renderTemplate(t.prompt_template, opts.templateContext)

    if (entityKey) {
      opts.pipeline.dispatch(entityKey, t, prompt, opts.deliveryId, opts.event)
    } else {
      opts.pipeline.dispatchNoAffinity(t, prompt, opts.deliveryId, opts.event)
    }
    dispatched.push(t.name)
  }

  return { dispatched, skipped }
}
