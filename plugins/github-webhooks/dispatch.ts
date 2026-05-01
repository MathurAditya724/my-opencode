// Drive an OpenCode agent session via the in-process SDK client.
// Factored as a closure so the entrypoint can wire ctx.client + the
// semaphore + the drain counter once at boot, and the fetch handler
// just calls dispatch(trigger, prompt, deliveryId).

import type { PluginInput } from "@opencode-ai/plugin"
import type { Semaphore, DrainCounter } from "./semaphore"
import type { NormalizedTrigger } from "./types"

export type Dispatcher = (
  trigger: NormalizedTrigger,
  prompt: string,
  deliveryId: string,
) => Promise<void>

export function makeDispatcher(opts: {
  client: PluginInput["client"]
  defaultCwd: string
  timeoutMs: number
  semaphore: Semaphore
  drainCounter: DrainCounter
}): Dispatcher {
  const { client, defaultCwd, timeoutMs, semaphore, drainCounter } = opts
  return async function dispatch(t, prompt, deliveryId) {
    drainCounter.start()
    await semaphore.acquire()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    timer.unref?.() // don't block process exit on a 30-min timer
    try {
      const session = await client.session.create({
        body: { title: `[webhook/${t.name}] ${t.event}` },
        query: { directory: t.cwd ?? defaultCwd },
        signal: abort.signal,
      })
      const sessionId = session.data?.id
      if (!sessionId) {
        console.error(
          `[github-webhooks] trigger '${t.name}' (${deliveryId}): session.create returned no id`,
        )
        return
      }
      console.log(
        `[github-webhooks] trigger '${t.name}' (${deliveryId}) → session ${sessionId}`,
      )
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: t.agent,
          parts: [{ type: "text", text: prompt }],
        },
        signal: abort.signal,
      })
      console.log(
        `[github-webhooks] trigger '${t.name}' (${deliveryId}) → session ${sessionId} completed`,
      )
    } catch (err) {
      console.error(
        `[github-webhooks] trigger '${t.name}' (${deliveryId}) failed:`,
        err,
      )
    } finally {
      clearTimeout(timer)
      semaphore.release()
      drainCounter.end()
    }
  }
}
