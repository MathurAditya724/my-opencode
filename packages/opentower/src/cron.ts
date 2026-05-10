// Cron scheduler for opentower. Uses croner for cron expression parsing
// and scheduling. Jobs are persisted in SQLite and dispatched through
// the existing pipeline for session affinity support.

import * as Sentry from "@sentry/bun"
import { Cron } from "croner"
import { parseEntityKey } from "./entity"
import type { Pipeline } from "./pipeline"
import type { CronJobRow, LifecycleStore } from "./storage"
import type { NormalizedTrigger } from "./types"

export type CronScheduler = {
  start(): void
  stop(): void
  reload(): void
  getNextRun(cronExpression: string, timezone?: string): Date | null
  triggerJob(jobId: string): Promise<boolean>
}

const MIN_INTERVAL_MS = 60 * 60 * 1000 // 1 hour in milliseconds

export type CronIntervalValidation =
  | { valid: true; intervalMs: number }
  | { valid: false; intervalMs: number; error: string }

/**
 * Validates that a cron expression doesn't run more frequently than once per hour.
 * Returns the minimum interval between runs in milliseconds.
 */
export function validateCronInterval(cronExpression: string, timezone = "UTC"): CronIntervalValidation {
  try {
    const cron = new Cron(cronExpression, { timezone })
    const nextRuns = cron.nextRuns(2)

    if (nextRuns.length < 2) {
      return { valid: true, intervalMs: Number.POSITIVE_INFINITY }
    }

    const intervalMs = nextRuns[1].getTime() - nextRuns[0].getTime()

    if (intervalMs < MIN_INTERVAL_MS) {
      const intervalMinutes = Math.round(intervalMs / 60000)
      return {
        valid: false,
        intervalMs,
        error: `Cron expression runs every ${intervalMinutes} minute(s), but the minimum allowed interval is 1 hour. Use expressions like "0 * * * *" (hourly) or less frequent.`,
      }
    }

    return { valid: true, intervalMs }
  } catch {
    return {
      valid: false,
      intervalMs: 0,
      error: `Invalid cron expression: "${cronExpression}"`,
    }
  }
}

export type CronSchedulerOptions = {
  store: LifecycleStore
  pipeline: Pipeline
  defaultAgent: string
  cronTrigger: NormalizedTrigger | null
}

export function makeCronScheduler(opts: CronSchedulerOptions): CronScheduler {
  const { store, pipeline, defaultAgent, cronTrigger } = opts
  const jobs = new Map<string, Cron>()

  function getNextRun(cronExpression: string, timezone = "UTC"): Date | null {
    try {
      const cron = new Cron(cronExpression, { timezone })
      return cron.nextRun() ?? null
    } catch {
      return null
    }
  }

  function scheduleJob(config: CronJobRow): void {
    if (!config.enabled) return

    try {
      const job = new Cron(
        config.cron_expression,
        {
          timezone: config.timezone || "UTC",
          paused: false,
        },
        async () => {
          await executeJob(config)
        },
      )

      jobs.set(config.id, job)

      const nextRun = job.nextRun()
      if (nextRun) {
        store.updateCronJob(config.id, {
          next_run_at: nextRun.toISOString(),
        })
      }

      Sentry.logger.info("cron.job_scheduled", {
        job_id: config.id,
        job_name: config.name,
        cron_expression: config.cron_expression,
        next_run: nextRun?.toISOString() ?? null,
      })
    } catch (err) {
      console.error(`[cron] failed to schedule job ${config.name}:`, err)
      Sentry.captureException(err, {
        tags: { "cron.job_id": config.id, "cron.job_name": config.name },
      })
    }
  }

  async function executeJob(config: CronJobRow): Promise<void> {
    const executionId = crypto.randomUUID()
    const scheduledAt = new Date().toISOString()
    const deliveryId = `cron:${config.id}:${Date.now()}`

    store.insertCronExecution({
      id: executionId,
      cron_job_id: config.id,
      scheduled_at: scheduledAt,
      status: "running",
    })

    store.updateCronExecution(executionId, {
      started_at: scheduledAt,
    })

    Sentry.logger.info("cron.job_executing", {
      job_id: config.id,
      job_name: config.name,
      execution_id: executionId,
    })

    try {
      const trigger: NormalizedTrigger = cronTrigger ?? {
        name: `cron:${config.name}`,
        source: "cron",
        events: ["cron"],
        action: null,
        enabled: true,
        agent: config.agent || defaultAgent,
        prompt_template: "{{ prompt }}",
        cwd: null,
        ignore_authors: [],
      }

      const prompt = config.prompt

      if (config.entity_key) {
        const entityKey = parseEntityKey(config.entity_key)
        if (entityKey) {
          pipeline.dispatch(entityKey, trigger, prompt, deliveryId, "cron")
        } else {
          pipeline.dispatchNoAffinity(trigger, prompt, deliveryId, "cron")
        }
      } else {
        pipeline.dispatchNoAffinity(trigger, prompt, deliveryId, "cron")
      }

      store.updateCronExecution(executionId, {
        status: "completed",
        completed_at: new Date().toISOString(),
      })

      const nextRun = getNextRun(config.cron_expression, config.timezone)
      store.updateCronJobLastRun(config.id, scheduledAt, nextRun?.toISOString() ?? null)

      if (config.run_once) {
        store.disableCronJob(config.id)
        const cronJob = jobs.get(config.id)
        if (cronJob) {
          cronJob.stop()
          jobs.delete(config.id)
        }
        Sentry.logger.info("cron.job_disabled_after_run_once", {
          job_id: config.id,
          job_name: config.name,
        })
      }

      Sentry.logger.info("cron.job_completed", {
        job_id: config.id,
        job_name: config.name,
        execution_id: executionId,
      })
    } catch (err) {
      store.updateCronExecution(executionId, {
        status: "failed",
        completed_at: new Date().toISOString(),
      })

      console.error(`[cron] job ${config.name} failed:`, err)
      Sentry.captureException(err, {
        tags: {
          "cron.job_id": config.id,
          "cron.job_name": config.name,
          "cron.execution_id": executionId,
        },
      })
    }
  }

  return {
    start() {
      const allJobs = store.listEnabledCronJobs()
      console.log(`[cron] starting scheduler with ${allJobs.length} enabled job(s)`)

      for (const job of allJobs) {
        scheduleJob(job)
      }
    },

    stop() {
      console.log(`[cron] stopping scheduler, ${jobs.size} job(s) active`)
      for (const job of jobs.values()) {
        job.stop()
      }
      jobs.clear()
    },

    reload() {
      this.stop()
      this.start()
    },

    getNextRun,

    async triggerJob(jobId: string): Promise<boolean> {
      const job = store.getCronJob(jobId)
      if (!job) return false
      if (!job.enabled) return false
      await executeJob(job)
      return true
    },
  }
}
