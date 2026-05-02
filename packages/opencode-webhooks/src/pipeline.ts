// Event pipeline: entity-keyed session affinity with buffering.
//
// When a webhook arrives for entity "owner/repo#42":
//   1. Extract entity key from payload.
//   2. Look up whether there's a running session for that entity.
//   3a. If yes and session is IDLE: send a follow-up prompt.
//   3b. If yes and session is BUSY (prompt in flight): queue the event.
//   3c. If no: create a new session and send the initial prompt.
//   4. When a prompt completes: flush queued events as a single batched
//      follow-up prompt.
//
// Events without a recognizable entity key (e.g. push events with no
// associated PR) fall through to the old fire-and-forget dispatch path.

import type { PluginInput } from "@opencode-ai/plugin"
import * as Sentry from "@sentry/bun"
import type { EntityKey } from "./entity"
import type { DrainCounter, Semaphore } from "./semaphore"
import type { DeliveryStore } from "./storage"
import type { NormalizedTrigger } from "./types"

type QueuedEvent = {
  trigger: NormalizedTrigger
  prompt: string
  deliveryId: string
  matchedEvent: string
  dispatchId: number
}

type SessionEntry = {
  sessionId: string
  entityKey: string
  agent: string
  // True while a session.prompt call is in flight. Incoming events
  // during this window are queued rather than sent immediately.
  busy: boolean
  queue: QueuedEvent[]
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
}

export type Pipeline = {
  // Try to dispatch via session affinity. Returns true if the event
  // was handled (dispatched or queued); false if no entity key could
  // be extracted and the caller should fall back to fire-and-forget.
  dispatch(
    entityKey: EntityKey,
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
    dispatchId: number,
  ): boolean
  // Fire-and-forget dispatch for events without entity keys.
  dispatchNoAffinity(
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
    dispatchId: number,
  ): void
  // Lookup the active session id for an entity. Used by the read API.
  getSessionId(entityKey: string): string | null
}

export function makePipeline(opts: {
  client: PluginInput["client"]
  defaultCwd: string
  timeoutMs: number
  semaphore: Semaphore
  drainCounter: DrainCounter
  store: DeliveryStore
  // How long to wait for additional events before flushing the queue
  // as a batched follow-up. Default 5s.
  batchWindowMs?: number
}): Pipeline {
  const {
    client,
    defaultCwd,
    timeoutMs,
    semaphore,
    drainCounter,
    store,
    batchWindowMs = 5_000,
  } = opts

  // In-memory registry: entity_key → active session.
  const sessions = new Map<string, SessionEntry>()

  // Create a new OpenCode session and send the initial prompt.
  async function createAndPrompt(
    entry: SessionEntry,
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
    dispatchId: number,
  ): Promise<void> {
    drainCounter.start()
    await semaphore.acquire()
    try {
      const session = await client.session.create({
        body: { title: `[webhook/${trigger.name}] ${entry.entityKey}` },
        query: { directory: trigger.cwd ?? defaultCwd },
        signal: entry.abort.signal,
      })
      const sessionId = session.data?.id
      if (!sessionId) {
        const msg = "session.create returned no id"
        console.error(
          `[pipeline] ${entry.entityKey}: ${msg}`,
        )
        store.markFailed(dispatchId, msg)
        sessions.delete(entry.entityKey)
        return
      }
      entry.sessionId = sessionId
      store.markRunning(dispatchId, sessionId)
      store.bindSession(entry.entityKey, sessionId)
      console.log(
        `[pipeline] ${entry.entityKey} → new session ${sessionId}`,
      )
      entry.busy = true
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: trigger.agent,
          parts: [{ type: "text", text: prompt }],
        },
        signal: entry.abort.signal,
      })
      store.markSucceeded(dispatchId)
      console.log(
        `[pipeline] ${entry.entityKey} → session ${sessionId} initial prompt completed`,
      )
    } catch (err) {
      handleError(entry, dispatchId, err, deliveryId, matchedEvent, trigger)
      return
    } finally {
      semaphore.release()
      // Don't decrement drainCounter yet — there may be queued events.
    }
    entry.busy = false
    flushQueue(entry)
  }

  // Send a follow-up prompt to an existing session.
  async function followUp(
    entry: SessionEntry,
    events: QueuedEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    // Build a single batched prompt from all queued events.
    const prompt = events.length === 1
      ? events[0].prompt
      : formatBatchPrompt(events)

    entry.busy = true
    const firstDispatchId = events[0].dispatchId
    // Mark all queued dispatches as running in the existing session.
    for (const e of events) {
      store.markRunning(e.dispatchId, entry.sessionId)
    }
    try {
      await client.session.prompt({
        path: { id: entry.sessionId },
        body: {
          agent: events[0].trigger.agent,
          parts: [{ type: "text", text: prompt }],
        },
        signal: entry.abort.signal,
      })
      for (const e of events) {
        store.markSucceeded(e.dispatchId)
      }
      console.log(
        `[pipeline] ${entry.entityKey} → session ${entry.sessionId} follow-up completed (${events.length} event${events.length > 1 ? "s" : ""})`,
      )
    } catch (err) {
      for (const e of events) {
        const aborted = entry.abort.signal.aborted
        if (aborted) {
          store.markTimeout(e.dispatchId)
        } else {
          store.markFailed(e.dispatchId, formatError(err))
        }
      }
      reportError(entry, err, events[0].deliveryId, events[0].matchedEvent, events[0].trigger)
      sessions.delete(entry.entityKey)
      drainCounter.end()
      return
    }
    entry.busy = false
    flushQueue(entry)
  }

  // Drain the queue. If the queue is empty, mark the session as idle.
  // If new events accumulated while the previous prompt was running,
  // batch them into a single follow-up after a short window to allow
  // more events to coalesce.
  function flushQueue(entry: SessionEntry): void {
    if (entry.queue.length === 0) {
      // Session is idle. Keep it registered for future events.
      // Drain counter was started when session was created; it
      // stays active until the session is cleaned up or times out.
      return
    }
    // Wait briefly to batch any additional events that arrive.
    setTimeout(() => {
      const batch = entry.queue.splice(0)
      if (batch.length === 0) return
      void followUp(entry, batch)
    }, batchWindowMs)
  }

  function handleError(
    entry: SessionEntry,
    dispatchId: number,
    err: unknown,
    deliveryId: string,
    matchedEvent: string,
    trigger: NormalizedTrigger,
  ): void {
    const aborted = entry.abort.signal.aborted
    if (aborted) {
      store.markTimeout(dispatchId)
    } else {
      store.markFailed(dispatchId, formatError(err))
    }
    reportError(entry, err, deliveryId, matchedEvent, trigger)
    // Fail any queued events too.
    for (const q of entry.queue) {
      store.markFailed(q.dispatchId, `session failed: ${formatError(err)}`)
    }
    entry.queue.length = 0
    sessions.delete(entry.entityKey)
    drainCounter.end()
  }

  function reportError(
    entry: SessionEntry,
    err: unknown,
    deliveryId: string,
    matchedEvent: string,
    trigger: NormalizedTrigger,
  ): void {
    const aborted = entry.abort.signal.aborted
    console.error(
      `[pipeline] ${entry.entityKey} → session ${entry.sessionId} ${aborted ? "timed out" : "failed"}:`,
      err,
    )
    Sentry.withScope((scope) => {
      scope.setTag("trigger.name", trigger.name)
      scope.setTag("trigger.event", matchedEvent)
      scope.setTag("delivery.id", deliveryId)
      scope.setTag("entity.key", entry.entityKey)
      if (entry.sessionId) scope.setTag("session.id", entry.sessionId)
      Sentry.captureException(err)
    })
  }

  // Fire-and-forget for events without entity affinity — same as the
  // old dispatcher behavior.
  async function dispatchNoAffinity(
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
    dispatchId: number,
  ): Promise<void> {
    drainCounter.start()
    await semaphore.acquire()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    timer.unref?.()
    try {
      const session = await client.session.create({
        body: { title: `[webhook/${trigger.name}] ${matchedEvent}` },
        query: { directory: trigger.cwd ?? defaultCwd },
        signal: abort.signal,
      })
      const sessionId = session.data?.id
      if (!sessionId) {
        store.markFailed(dispatchId, "session.create returned no id")
        return
      }
      store.markRunning(dispatchId, sessionId)
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: trigger.agent,
          parts: [{ type: "text", text: prompt }],
        },
        signal: abort.signal,
      })
      store.markSucceeded(dispatchId)
    } catch (err) {
      if (abort.signal.aborted) {
        store.markTimeout(dispatchId)
      } else {
        store.markFailed(dispatchId, formatError(err))
      }
      Sentry.withScope((scope) => {
        scope.setTag("trigger.name", trigger.name)
        scope.setTag("trigger.event", matchedEvent)
        scope.setTag("delivery.id", deliveryId)
        Sentry.captureException(err)
      })
    } finally {
      clearTimeout(timer)
      semaphore.release()
      drainCounter.end()
    }
  }

  return {
    dispatch(entityKey, trigger, prompt, deliveryId, matchedEvent, dispatchId) {
      const existing = sessions.get(entityKey.key)
      if (existing) {
        if (existing.busy) {
          // Session is processing a prompt — queue the event.
          existing.queue.push({
            trigger,
            prompt,
            deliveryId,
            matchedEvent,
            dispatchId,
          })
          store.markRunning(dispatchId, existing.sessionId)
          console.log(
            `[pipeline] ${entityKey.key} → queued (session ${existing.sessionId} busy, queue depth: ${existing.queue.length})`,
          )
          return true
        }
        // Session is idle — send follow-up immediately.
        store.markRunning(dispatchId, existing.sessionId)
        void followUp(existing, [{
          trigger,
          prompt,
          deliveryId,
          matchedEvent,
          dispatchId,
        }])
        return true
      }

      // No existing session — create one.
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), timeoutMs)
      timer.unref?.()
      const entry: SessionEntry = {
        sessionId: "",
        entityKey: entityKey.key,
        agent: trigger.agent,
        busy: false,
        queue: [],
        abort,
        timer,
      }
      sessions.set(entityKey.key, entry)
      void createAndPrompt(entry, trigger, prompt, deliveryId, matchedEvent, dispatchId)
      return true
    },

    dispatchNoAffinity(trigger, prompt, deliveryId, matchedEvent, dispatchId) {
      void dispatchNoAffinity(trigger, prompt, deliveryId, matchedEvent, dispatchId)
    },

    getSessionId(entityKey) {
      return sessions.get(entityKey)?.sessionId ?? null
    },
  }
}

function formatBatchPrompt(events: QueuedEvent[]): string {
  const lines = [
    `${events.length} new events arrived for this entity while you were working. Process them in order:\n`,
  ]
  for (let i = 0; i < events.length; i++) {
    lines.push(`--- Event ${i + 1} of ${events.length} ---`)
    lines.push(events[i].prompt)
    lines.push("")
  }
  return lines.join("\n")
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}
