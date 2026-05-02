// Drive an OpenCode agent session via the in-process SDK client.
// Factored as a closure so the entrypoint can wire ctx.client + the
// semaphore + the drain counter once at boot, and the fetch handler
// just calls dispatch(trigger, prompt, deliveryId, matchedEvent, dispatchId).

import type { PluginInput } from "@opencode-ai/plugin"
import * as Sentry from "@sentry/bun"
import type { Semaphore, DrainCounter } from "./semaphore"
import type { DeliveryStore } from "./storage"
import type { NormalizedTrigger } from "./types"

export type Dispatcher = (
  trigger: NormalizedTrigger,
  prompt: string,
  deliveryId: string,
  // The actual event that matched (for triggers with event arrays,
  // this is the specific event from the inbound request, not the
  // configured array).
  matchedEvent: string,
  // Lifecycle row id from store.createDispatch — the dispatcher updates
  // this row as the session progresses.
  dispatchId: number,
) => Promise<void>

export function makeDispatcher(opts: {
  client: PluginInput["client"]
  defaultCwd: string
  timeoutMs: number
  semaphore: Semaphore
  drainCounter: DrainCounter
  store: DeliveryStore
}): Dispatcher {
  const { client, defaultCwd, timeoutMs, semaphore, drainCounter, store } = opts
  return async function dispatch(t, prompt, deliveryId, matchedEvent, dispatchId) {
    drainCounter.start()
    await semaphore.acquire()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    timer.unref?.() // don't block process exit on a 30-min timer
    try {
      const session = await client.session.create({
        body: { title: `[webhook/${t.name}] ${matchedEvent}` },
        query: { directory: t.cwd ?? defaultCwd },
        signal: abort.signal,
      })
      const sessionId = session.data?.id
      if (!sessionId) {
        const msg = "session.create returned no id"
        console.error(
          `[opencode-webhooks] trigger '${t.name}' (${deliveryId}): ${msg}`,
        )
        store.markFailed(dispatchId, msg)
        return
      }
      store.markRunning(dispatchId, sessionId)
      console.log(
        `[opencode-webhooks] trigger '${t.name}' (${deliveryId}) → session ${sessionId}`,
      )
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: t.agent,
          parts: [{ type: "text", text: prompt }],
        },
        signal: abort.signal,
      })
      store.markSucceeded(dispatchId)
      console.log(
        `[opencode-webhooks] trigger '${t.name}' (${deliveryId}) → session ${sessionId} completed`,
      )
    } catch (err) {
      const aborted = abort.signal.aborted
      if (aborted) {
        store.markTimeout(dispatchId)
      } else {
        store.markFailed(dispatchId, formatError(err))
      }
      console.error(
        `[opencode-webhooks] trigger '${t.name}' (${deliveryId}) ${aborted ? "timed out" : "failed"}:`,
        err,
      )
      // withScope (not withIsolationScope) — dispatch runs outside any HTTP request scope
      Sentry.withScope((scope) => {
        scope.setTag("trigger.name", t.name)
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
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}
