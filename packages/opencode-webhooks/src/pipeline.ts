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
// associated PR) fall through to one-shot fire-and-forget dispatch.

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
  busy: boolean
  queue: QueuedEvent[]
  abort: AbortController
  // Abort timer — fires after timeoutMs to cancel the session.
  abortTimer: ReturnType<typeof setTimeout>
  // Batch timer — fires after batchWindowMs to flush queued events.
  batchTimer: ReturnType<typeof setTimeout> | null
  // Idle timer — fires after idleTimeoutMs to clean up the session.
  idleTimer: ReturnType<typeof setTimeout> | null
}

export type Pipeline = {
  dispatch(
    entityKey: EntityKey,
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
    dispatchId: number,
  ): boolean
  dispatchNoAffinity(
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
    dispatchId: number,
  ): void
  getSessionId(entityKey: string): string | null
}

// Idle sessions are cleaned up after this period of inactivity.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

export function makePipeline(opts: {
  client: PluginInput["client"]
  defaultCwd: string
  timeoutMs: number
  semaphore: Semaphore
  drainCounter: DrainCounter
  store: DeliveryStore
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

  const sessions = new Map<string, SessionEntry>()

  // Clean up a session: clear timers, remove from map, end drain counter.
  function cleanup(entry: SessionEntry): void {
    clearTimeout(entry.abortTimer)
    if (entry.batchTimer) clearTimeout(entry.batchTimer)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    sessions.delete(entry.entityKey)
    drainCounter.end()
  }

  // Start (or restart) the idle timer. When it fires, the session is
  // removed from the registry and subsequent events create a new one.
  function resetIdleTimer(entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      console.log(
        `[pipeline] ${entry.entityKey} → session ${entry.sessionId} idle timeout, cleaning up`,
      )
      cleanup(entry)
    }, IDLE_TIMEOUT_MS)
    entry.idleTimer.unref?.()
  }

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
        console.error(`[pipeline] ${entry.entityKey}: ${msg}`)
        store.markFailed(dispatchId, msg)
        cleanup(entry)
        return
      }
      entry.sessionId = sessionId
      store.markRunning(dispatchId, sessionId)
      store.bindSession(entry.entityKey, sessionId)
      console.log(`[pipeline] ${entry.entityKey} → new session ${sessionId}`)
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
    }
    entry.busy = false
    flushQueue(entry)
  }

  async function followUp(
    entry: SessionEntry,
    events: QueuedEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    const prompt = events.length === 1
      ? events[0].prompt
      : formatBatchPrompt(events)

    // Reset the abort timer — this session is still actively processing.
    clearTimeout(entry.abortTimer)
    entry.abortTimer = setTimeout(() => entry.abort.abort(), timeoutMs)
    entry.abortTimer.unref?.()

    entry.busy = true
    for (const e of events) {
      store.markRunning(e.dispatchId, entry.sessionId)
    }
    await semaphore.acquire()
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
        if (entry.abort.signal.aborted) {
          store.markTimeout(e.dispatchId)
        } else {
          store.markFailed(e.dispatchId, formatError(err))
        }
      }
      reportError(entry, err, events[0].deliveryId, events[0].matchedEvent, events[0].trigger)
      // Fail any remaining queued events.
      for (const q of entry.queue) {
        store.markFailed(q.dispatchId, `session failed: ${formatError(err)}`)
      }
      entry.queue.length = 0
      cleanup(entry)
      return
    } finally {
      semaphore.release()
    }
    entry.busy = false
    flushQueue(entry)
  }

  function flushQueue(entry: SessionEntry): void {
    if (entry.queue.length === 0) {
      // Session is idle. Start the idle timer — if no new events arrive
      // before it fires, the session is cleaned up.
      resetIdleTimer(entry)
      return
    }
    // Wait briefly to batch additional events that arrive in quick
    // succession (e.g. CI failure + review comment from the same push).
    entry.batchTimer = setTimeout(() => {
      entry.batchTimer = null
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
    if (entry.abort.signal.aborted) {
      store.markTimeout(dispatchId)
    } else {
      store.markFailed(dispatchId, formatError(err))
    }
    reportError(entry, err, deliveryId, matchedEvent, trigger)
    for (const q of entry.queue) {
      store.markFailed(q.dispatchId, `session failed: ${formatError(err)}`)
    }
    entry.queue.length = 0
    cleanup(entry)
  }

  function reportError(
    entry: SessionEntry,
    err: unknown,
    deliveryId: string,
    matchedEvent: string,
    trigger: NormalizedTrigger,
  ): void {
    console.error(
      `[pipeline] ${entry.entityKey} → session ${entry.sessionId} ${entry.abort.signal.aborted ? "timed out" : "failed"}:`,
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

  // One-shot dispatch for events without entity affinity.
  async function fireAndForget(
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
        // Cancel idle timer — this session is active again.
        if (existing.idleTimer) {
          clearTimeout(existing.idleTimer)
          existing.idleTimer = null
        }
        if (existing.busy) {
          // Session is processing a prompt — queue the event.
          existing.queue.push({
            trigger, prompt, deliveryId, matchedEvent, dispatchId,
          })
          console.log(
            `[pipeline] ${entityKey.key} → queued (session ${existing.sessionId} busy, queue depth: ${existing.queue.length})`,
          )
          return true
        }
        // Session is idle — send follow-up immediately.
        void followUp(existing, [{
          trigger, prompt, deliveryId, matchedEvent, dispatchId,
        }])
        return true
      }

      // No existing session — create one.
      const abort = new AbortController()
      const abortTimer = setTimeout(() => abort.abort(), timeoutMs)
      abortTimer.unref?.()
      const entry: SessionEntry = {
        sessionId: "",
        entityKey: entityKey.key,
        agent: trigger.agent,
        busy: false,
        queue: [],
        abort,
        abortTimer,
        batchTimer: null,
        idleTimer: null,
      }
      sessions.set(entityKey.key, entry)
      void createAndPrompt(entry, trigger, prompt, deliveryId, matchedEvent, dispatchId)
      return true
    },

    dispatchNoAffinity(trigger, prompt, deliveryId, matchedEvent, dispatchId) {
      void fireAndForget(trigger, prompt, deliveryId, matchedEvent, dispatchId)
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
