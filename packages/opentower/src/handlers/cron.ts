import type { Context } from "hono"
import { type CronScheduler, validateCronInterval } from "../cron"
import type { AppEnv } from "../handler"

export function makeCronHandlers(scheduler: CronScheduler) {
  return {
    list(c: Context<AppEnv>) {
      const store = c.get("store")
      const raw = Number(c.req.query("limit"))
      const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))
      const cursor = c.req.query("cursor") || undefined
      const enabledParam = c.req.query("enabled")
      const enabled = enabledParam === "true" ? true : enabledParam === "false" ? false : undefined
      return c.json(store.listCronJobs({ limit, cursor, enabled }))
    },

    async create(c: Context<AppEnv>) {
      const store = c.get("store")
      let body: {
        name?: string
        cron_expression?: string
        prompt?: string
        entity_key?: string | null
        agent?: string
        timezone?: string
        run_once?: boolean
      }
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: "invalid JSON" }, 400)
      }

      const name = typeof body.name === "string" ? body.name.trim() : ""
      if (!name) {
        return c.json({ error: "name is required" }, 400)
      }

      const cron_expression = typeof body.cron_expression === "string" ? body.cron_expression.trim() : ""
      if (!cron_expression) {
        return c.json({ error: "cron_expression is required" }, 400)
      }

      const timezone = typeof body.timezone === "string" ? body.timezone.trim() || "UTC" : "UTC"
      const run_once = body.run_once === true

      const nextRun = scheduler.getNextRun(cron_expression, timezone)
      if (!nextRun) {
        return c.json({ error: "invalid cron expression" }, 400)
      }

      if (!run_once) {
        const intervalValidation = validateCronInterval(cron_expression, timezone)
        if (!intervalValidation.valid) {
          return c.json({ error: intervalValidation.error }, 400)
        }
      }

      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
      if (!prompt) {
        return c.json({ error: "prompt is required" }, 400)
      }

      const agent = typeof body.agent === "string" ? body.agent.trim() : ""
      if (!agent) {
        return c.json({ error: "agent is required" }, 400)
      }

      const existing = store.getCronJobByName(name)
      if (existing) {
        return c.json({ error: "a cron job with this name already exists" }, 409)
      }

      const id = crypto.randomUUID()
      const entity_key = typeof body.entity_key === "string" ? body.entity_key.trim() || null : null

      store.createCronJob({
        id,
        name,
        cron_expression,
        prompt,
        entity_key,
        agent,
        timezone,
        run_once: run_once ? 1 : 0,
        created_by: "user",
        next_run_at: nextRun.toISOString(),
      })

      scheduler.reload()

      return c.json(
        {
          created: {
            id,
            name,
            cron_expression,
            prompt,
            entity_key,
            agent,
            timezone,
            run_once,
            next_run_at: nextRun.toISOString(),
          },
        },
        201,
      )
    },

    get(c: Context<AppEnv>) {
      const store = c.get("store")
      const id = c.req.param("id") ?? ""
      if (!id) return c.json({ error: "missing job id" }, 400)
      const job = store.getCronJob(id)
      if (!job) return c.json({ error: "cron job not found" }, 404)
      return c.json(job)
    },

    async update(c: Context<AppEnv>) {
      const store = c.get("store")
      const id = c.req.param("id") ?? ""
      if (!id) return c.json({ error: "missing job id" }, 400)

      const existing = store.getCronJob(id)
      if (!existing) return c.json({ error: "cron job not found" }, 404)

      let body: {
        name?: string
        cron_expression?: string
        prompt?: string
        entity_key?: string | null
        agent?: string
        timezone?: string
        enabled?: boolean
      }
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: "invalid JSON" }, 400)
      }

      const updates: Parameters<typeof store.updateCronJob>[1] = {}

      if (typeof body.name === "string") {
        const name = body.name.trim()
        if (name && name !== existing.name) {
          const other = store.getCronJobByName(name)
          if (other && other.id !== id) {
            return c.json({ error: "a cron job with this name already exists" }, 409)
          }
          updates.name = name
        }
      }

      if (typeof body.cron_expression === "string") {
        const cron_expression = body.cron_expression.trim()
        if (cron_expression && cron_expression !== existing.cron_expression) {
          const tz = typeof body.timezone === "string" ? body.timezone.trim() || existing.timezone : existing.timezone
          const nextRun = scheduler.getNextRun(cron_expression, tz)
          if (!nextRun) {
            return c.json({ error: "invalid cron expression" }, 400)
          }
          if (!existing.run_once) {
            const intervalValidation = validateCronInterval(cron_expression, tz)
            if (!intervalValidation.valid) {
              return c.json({ error: intervalValidation.error }, 400)
            }
          }
          updates.cron_expression = cron_expression
          updates.next_run_at = nextRun.toISOString()
        }
      }

      if (typeof body.prompt === "string") {
        const prompt = body.prompt.trim()
        if (prompt) updates.prompt = prompt
      }

      if (body.entity_key !== undefined) {
        updates.entity_key = typeof body.entity_key === "string" ? body.entity_key.trim() || null : null
      }

      if (typeof body.agent === "string") {
        const agent = body.agent.trim()
        if (agent) updates.agent = agent
      }

      if (typeof body.timezone === "string") {
        const newTimezone = body.timezone.trim() || "UTC"
        if (newTimezone !== existing.timezone) {
          updates.timezone = newTimezone
          const expr = updates.cron_expression ?? existing.cron_expression
          const nextRun = scheduler.getNextRun(expr, newTimezone)
          if (nextRun) updates.next_run_at = nextRun.toISOString()
        }
      }

      if (typeof body.enabled === "boolean") {
        updates.enabled = body.enabled
      }

      store.updateCronJob(id, updates)
      scheduler.reload()

      const updated = store.getCronJob(id)
      return c.json(updated)
    },

    delete(c: Context<AppEnv>) {
      const store = c.get("store")
      const id = c.req.param("id") ?? ""
      if (!id) return c.json({ error: "missing job id" }, 400)

      const existing = store.getCronJob(id)
      if (!existing) return c.json({ error: "cron job not found" }, 404)

      store.deleteCronJob(id)
      scheduler.reload()

      return c.json({ deleted: id })
    },

    async trigger(c: Context<AppEnv>) {
      const store = c.get("store")
      const id = c.req.param("id") ?? ""
      if (!id) return c.json({ error: "missing job id" }, 400)

      const job = store.getCronJob(id)
      if (!job) return c.json({ error: "cron job not found" }, 404)

      if (!job.enabled) {
        return c.json({ error: "cron job is disabled" }, 400)
      }

      const triggered = await scheduler.triggerJob(id)
      if (!triggered) {
        return c.json({ error: "failed to trigger cron job" }, 500)
      }

      return c.json({ triggered: id, message: "job execution started" })
    },

    executions(c: Context<AppEnv>) {
      const store = c.get("store")
      const id = c.req.param("id") ?? ""
      if (!id) return c.json({ error: "missing job id" }, 400)

      const job = store.getCronJob(id)
      if (!job) return c.json({ error: "cron job not found" }, 404)

      const raw = Number(c.req.query("limit"))
      const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))

      const executions = store.listCronExecutions(id, { limit })
      return c.json({ executions })
    },
  }
}
