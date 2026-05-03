// Event pipeline: entity-keyed session affinity with lifecycle persistence.
//
// When a webhook arrives for entity "owner/repo#42":
//   1. Extract entity key from payload.
//   2. Check the lifecycle store for an existing opencode session for
//      this entity (or a linked entity, e.g. the issue that this PR
//      fixes). If found, reuse the session.
//   3a. If in-memory entry exists and is IDLE: send a follow-up prompt.
//   3b. If in-memory entry exists and is BUSY: queue the event.
//   3c. If no in-memory entry but DB has a session: restore from DB and
//       send a follow-up prompt.
//   3d. If no session anywhere: create a new session and persist it.
//   4. When a prompt completes: flush queued events as a single batched
//      follow-up prompt.
//
// Events without a recognizable entity key use fire-and-forget dispatch.

import type { PluginInput } from "@opencode-ai/plugin"
import * as Sentry from "@sentry/bun"
import type { EntityKey } from "./entity"
import type { DrainCounter, Semaphore } from "./semaphore"
import type { LifecycleStore } from "./storage"
import type { NormalizedTrigger } from "./types"

type QueuedEvent = {
  trigger: NormalizedTrigger
  prompt: string
  deliveryId: string
  matchedEvent: string
}

type SessionEntry = {
  sessionId: string
  entityKey: string
  agent: string
  busy: boolean
  queue: QueuedEvent[]
  abort: AbortController
  abortTimer: ReturnType<typeof setTimeout>
  batchTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

export type Pipeline = {
  dispatch(
    entityKey: EntityKey,
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
  ): boolean
  dispatchNoAffinity(
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
  ): void
  getSessionId(entityKey: string): string | null
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000

export function makePipeline(opts: {
  client: PluginInput["client"]
  defaultCwd: string
  timeoutMs: number
  semaphore: Semaphore
  drainCounter: DrainCounter
  store: LifecycleStore
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

  function cleanup(entry: SessionEntry): void {
    clearTimeout(entry.abortTimer)
    if (entry.batchTimer) clearTimeout(entry.batchTimer)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    sessions.delete(entry.entityKey)
    drainCounter.end()
  }

  function resetIdleTimer(entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      Sentry.logger.info("session.idle_timeout", {
        entity_key: entry.entityKey,
        session_id: entry.sessionId,
      })
      cleanup(entry)
    }, IDLE_TIMEOUT_MS)
    entry.idleTimer.unref?.()
  }

  // Persist entity→session mapping and issue→PR links to SQLite.
  function persistEntity(entityKey: EntityKey, sessionId: string, agent: string): void {
    store.upsertEntity({
      entity_key: entityKey.key,
      repo: entityKey.repo,
      number: entityKey.number,
      kind: entityKey.kind,
      session_id: sessionId,
      agent,
    })

    // If this is a PR with linked issues, create links so the issue's
    // session can be found when PR events arrive (and vice versa).
    if (entityKey.kind === "pull_request" && entityKey.linkedIssues.length > 0) {
      for (const issueNum of entityKey.linkedIssues) {
        const issueKey = `${entityKey.repo}#${issueNum}`
        store.addLink(issueKey, entityKey.key, "fixes")
      }
    }
  }

  async function createAndPrompt(
    entry: SessionEntry,
    entityKey: EntityKey,
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
  ): Promise<void> {
    drainCounter.start()
    const dispatchId = crypto.randomUUID()
    store.insertDispatch({
      id: dispatchId,
      entity_key: entityKey.key,
      session_id: null,
      trigger_name: trigger.name,
      event: matchedEvent,
      delivery_id: deliveryId,
      status: "started",
    })

    await semaphore.acquire()
    try {
      await Sentry.startSpan(
        {
          op: "dispatch",
          name: `dispatch ${trigger.name}`,
          attributes: {
            "trigger.name": trigger.name,
            "trigger.event": matchedEvent,
            "entity.key": entry.entityKey,
            "delivery.id": deliveryId,
            "agent": trigger.agent,
          },
        },
        async () => {
          const session = await client.session.create({
            body: { title: `[webhook/${trigger.name}] ${entry.entityKey}` },
            query: { directory: trigger.cwd ?? defaultCwd },
            signal: entry.abort.signal,
          })
          const sessionId = session.data?.id
          if (!sessionId) {
            const msg = "session.create returned no id"
            Sentry.logger.error("dispatch.failed", {
              trigger_name: trigger.name,
              entity_key: entry.entityKey,
              delivery_id: deliveryId,
              error: msg,
            })
            store.completeDispatch(dispatchId, "failed")
            cleanup(entry)
            return
          }
          entry.sessionId = sessionId

          persistEntity(entityKey, sessionId, trigger.agent)
          store.completeDispatch(dispatchId, "completed")

          Sentry.logger.info("dispatch.started", {
            trigger_name: trigger.name,
            entity_key: entry.entityKey,
            session_id: sessionId,
            delivery_id: deliveryId,
            matched_event: matchedEvent,
            agent: trigger.agent,
          })

          await Sentry.startSpan(
            {
              op: "agent.prompt",
              name: `prompt ${trigger.agent}`,
              attributes: {
                "session.id": sessionId,
                "agent": trigger.agent,
                "entity.key": entry.entityKey,
              },
            },
            async () => {
              await client.session.prompt({
                path: { id: sessionId },
                body: {
                  agent: trigger.agent,
                  parts: [{ type: "text", text: prompt }],
                },
                signal: entry.abort.signal,
              })
            },
          )

          Sentry.logger.info("dispatch.completed", {
            trigger_name: trigger.name,
            entity_key: entry.entityKey,
            session_id: sessionId,
            delivery_id: deliveryId,
            status: "succeeded",
          })
        },
      )
    } catch (err) {
      const status = entry.abort.signal.aborted ? "timeout" : "failed"
      store.completeDispatch(dispatchId, status as "timeout" | "failed")
      handleError(entry, err, deliveryId, matchedEvent, trigger)
      return
    } finally {
      semaphore.release()
    }
    entry.busy = false
    flushQueue(entry)
  }

  async function resumeAndPrompt(
    entry: SessionEntry,
    entityKey: EntityKey,
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
  ): Promise<void> {
    drainCounter.start()
    const dispatchId = crypto.randomUUID()
    store.insertDispatch({
      id: dispatchId,
      entity_key: entityKey.key,
      session_id: entry.sessionId,
      trigger_name: trigger.name,
      event: matchedEvent,
      delivery_id: deliveryId,
      status: "started",
    })

    // Also persist this entity if it's new (e.g. PR arriving for a
    // session that was originally created for the issue).
    persistEntity(entityKey, entry.sessionId, trigger.agent)

    await semaphore.acquire()
    try {
      await Sentry.startSpan(
        {
          op: "dispatch.resume",
          name: `resume ${entry.entityKey}`,
          attributes: {
            "entity.key": entry.entityKey,
            "session.id": entry.sessionId,
            "delivery.id": deliveryId,
          },
        },
        async () => {
          await client.session.prompt({
            path: { id: entry.sessionId },
            body: {
              agent: trigger.agent,
              parts: [{ type: "text", text: prompt }],
            },
            signal: entry.abort.signal,
          })

          store.completeDispatch(dispatchId, "completed")
          Sentry.logger.info("dispatch.resume_completed", {
            entity_key: entry.entityKey,
            session_id: entry.sessionId,
            delivery_id: deliveryId,
            status: "succeeded",
          })
        },
      )
    } catch (err) {
      const status = entry.abort.signal.aborted ? "timeout" : "failed"
      store.completeDispatch(dispatchId, status as "timeout" | "failed")
      handleError(entry, err, deliveryId, matchedEvent, trigger)
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

    clearTimeout(entry.abortTimer)
    entry.abortTimer = setTimeout(() => entry.abort.abort(), timeoutMs)
    entry.abortTimer.unref?.()

    entry.busy = true
    await semaphore.acquire()
    try {
      await Sentry.startSpan(
        {
          op: "dispatch.followup",
          name: `followup ${entry.entityKey}`,
          attributes: {
            "entity.key": entry.entityKey,
            "session.id": entry.sessionId,
            "event_count": events.length,
          },
        },
        async () => {
          await client.session.prompt({
            path: { id: entry.sessionId },
            body: {
              agent: events[0].trigger.agent,
              parts: [{ type: "text", text: prompt }],
            },
            signal: entry.abort.signal,
          })

          Sentry.logger.info("dispatch.followup_completed", {
            entity_key: entry.entityKey,
            session_id: entry.sessionId,
            event_count: events.length,
            status: "succeeded",
          })
        },
      )
    } catch (err) {
      const status = entry.abort.signal.aborted ? "timeout" : "failed"
      Sentry.logger.error("dispatch.followup_failed", {
        entity_key: entry.entityKey,
        session_id: entry.sessionId,
        event_count: events.length,
        status,
        error: formatError(err),
      })
      reportError(entry, err, events[0].deliveryId, events[0].matchedEvent, events[0].trigger)
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
      resetIdleTimer(entry)
      return
    }
    entry.batchTimer = setTimeout(() => {
      entry.batchTimer = null
      const batch = entry.queue.splice(0)
      if (batch.length === 0) return
      void followUp(entry, batch)
    }, batchWindowMs)
  }

  function handleError(
    entry: SessionEntry,
    err: unknown,
    deliveryId: string,
    matchedEvent: string,
    trigger: NormalizedTrigger,
  ): void {
    const status = entry.abort.signal.aborted ? "timeout" : "failed"
    Sentry.logger.error("dispatch.failed", {
      trigger_name: trigger.name,
      entity_key: entry.entityKey,
      session_id: entry.sessionId,
      delivery_id: deliveryId,
      matched_event: matchedEvent,
      status,
      error: formatError(err),
    })
    reportError(entry, err, deliveryId, matchedEvent, trigger)
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
      `[pipeline] ${entry.entityKey} -> session ${entry.sessionId} ${entry.abort.signal.aborted ? "timed out" : "failed"}:`,
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

  async function fireAndForget(
    trigger: NormalizedTrigger,
    prompt: string,
    deliveryId: string,
    matchedEvent: string,
  ): Promise<void> {
    drainCounter.start()
    const dispatchId = crypto.randomUUID()
    store.insertDispatch({
      id: dispatchId,
      entity_key: null,
      session_id: null,
      trigger_name: trigger.name,
      event: matchedEvent,
      delivery_id: deliveryId,
      status: "started",
    })

    await semaphore.acquire()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    timer.unref?.()
    try {
      await Sentry.startSpan(
        {
          op: "dispatch",
          name: `dispatch ${trigger.name}`,
          attributes: {
            "trigger.name": trigger.name,
            "trigger.event": matchedEvent,
            "delivery.id": deliveryId,
            "agent": trigger.agent,
          },
        },
        async () => {
          const session = await client.session.create({
            body: { title: `[webhook/${trigger.name}] ${matchedEvent}` },
            query: { directory: trigger.cwd ?? defaultCwd },
            signal: abort.signal,
          })
          const sessionId = session.data?.id
          if (!sessionId) {
            Sentry.logger.error("dispatch.failed", {
              trigger_name: trigger.name,
              delivery_id: deliveryId,
              error: "session.create returned no id",
            })
            store.completeDispatch(dispatchId, "failed")
            return
          }

          Sentry.logger.info("dispatch.started", {
            trigger_name: trigger.name,
            session_id: sessionId,
            delivery_id: deliveryId,
            matched_event: matchedEvent,
            agent: trigger.agent,
          })

          await Sentry.startSpan(
            {
              op: "agent.prompt",
              name: `prompt ${trigger.agent}`,
              attributes: { "session.id": sessionId, "agent": trigger.agent },
            },
            async () => {
              await client.session.prompt({
                path: { id: sessionId },
                body: {
                  agent: trigger.agent,
                  parts: [{ type: "text", text: prompt }],
                },
                signal: abort.signal,
              })
            },
          )

          store.completeDispatch(dispatchId, "completed")
          Sentry.logger.info("dispatch.completed", {
            trigger_name: trigger.name,
            session_id: sessionId,
            delivery_id: deliveryId,
            status: "succeeded",
          })
        },
      )
    } catch (err) {
      const status = abort.signal.aborted ? "timeout" : "failed"
      store.completeDispatch(dispatchId, status as "timeout" | "failed")
      Sentry.logger.error("dispatch.failed", {
        trigger_name: trigger.name,
        delivery_id: deliveryId,
        status,
        error: formatError(err),
      })
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
    dispatch(entityKey, trigger, prompt, deliveryId, matchedEvent) {
      // 1. Check in-memory sessions first (hot path).
      const existing = sessions.get(entityKey.key)
      if (existing) {
        if (existing.idleTimer) {
          clearTimeout(existing.idleTimer)
          existing.idleTimer = null
        }
        if (existing.busy) {
          existing.queue.push({ trigger, prompt, deliveryId, matchedEvent })
          Sentry.logger.info("dispatch.queued", {
            entity_key: entityKey.key,
            session_id: existing.sessionId,
            queue_depth: existing.queue.length,
            trigger_name: trigger.name,
          })
          return true
        }
        void followUp(existing, [{ trigger, prompt, deliveryId, matchedEvent }])
        return true
      }

      // 2. Check the lifecycle store for a persisted session (cold path:
      //    after restart or when a PR event arrives for an issue session).
      const persisted = store.resolveSession(entityKey.key)
      if (persisted) {
        const abort = new AbortController()
        const abortTimer = setTimeout(() => abort.abort(), timeoutMs)
        abortTimer.unref?.()
        const entry: SessionEntry = {
          sessionId: persisted.session_id,
          entityKey: entityKey.key,
          agent: persisted.agent,
          busy: true,
          queue: [],
          abort,
          abortTimer,
          batchTimer: null,
          idleTimer: null,
        }
        sessions.set(entityKey.key, entry)

        Sentry.logger.info("session.restored", {
          entity_key: entityKey.key,
          session_id: persisted.session_id,
          original_entity: persisted.entity_key,
        })

        void resumeAndPrompt(entry, entityKey, trigger, prompt, deliveryId, matchedEvent)
        return true
      }

      // 3. No existing session — create a new one.
      const abort = new AbortController()
      const abortTimer = setTimeout(() => abort.abort(), timeoutMs)
      abortTimer.unref?.()
      const entry: SessionEntry = {
        sessionId: "",
        entityKey: entityKey.key,
        agent: trigger.agent,
        busy: true,
        queue: [],
        abort,
        abortTimer,
        batchTimer: null,
        idleTimer: null,
      }
      sessions.set(entityKey.key, entry)
      void createAndPrompt(entry, entityKey, trigger, prompt, deliveryId, matchedEvent)
      return true
    },

    dispatchNoAffinity(trigger, prompt, deliveryId, matchedEvent) {
      void fireAndForget(trigger, prompt, deliveryId, matchedEvent)
    },

    getSessionId(entityKey) {
      // Check in-memory first, fall back to DB.
      const mem = sessions.get(entityKey)?.sessionId
      if (mem) return mem
      const row = store.resolveSession(entityKey)
      return row?.session_id ?? null
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
