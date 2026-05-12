// Cron job management tools for OpenCode agents.
// These tools allow agents to create, list, and delete scheduled jobs
// that run prompts at specified times.

import { tool } from "@opencode-ai/plugin"
import { type CronScheduler, validateCronInterval } from "../cron"
import type { LifecycleStore } from "../storage"

export type CronToolsOptions = {
  store: LifecycleStore
  scheduler: CronScheduler
  defaultAgent: string
}

export function makeCronTools(opts: CronToolsOptions) {
  const { store, scheduler, defaultAgent } = opts

  return {
    create_cron_job: tool({
      description: `Create a scheduled cron job that runs a prompt at specified times. Use this to schedule recurring tasks like daily triage, periodic checks, or one-time delayed executions.

IMPORTANT: Cron jobs run automatically and can have significant impact on resources and workflows. Before calling this tool, you MUST:
1. Present the full job details to the user (name, cron schedule in human-readable form, prompt, timezone, etc.)
2. Explain what the cron job will do and when it will run
3. Ask for explicit user confirmation to proceed
4. Only execute this tool AFTER the user has approved

Never create cron jobs without user confirmation.`,
      args: {
        name: tool.schema
          .string()
          .min(1)
          .max(100)
          .describe("Unique name for the cron job (e.g., 'daily-triage', 'weekly-report')"),
        cron_expression: tool.schema
          .string()
          .min(1)
          .describe(
            "Cron expression defining when to run. Format: 'minute hour day month weekday'. Examples: '0 9 * * MON-FRI' (weekdays 9am), '0 0 * * *' (daily midnight), '*/15 * * * *' (every 15 min)",
          ),
        prompt: tool.schema.string().min(1).describe("The prompt to execute when the job runs"),
        agent: tool.schema
          .string()
          .optional()
          .describe("Agent to use for execution. Defaults to the configured default agent"),
        entity_key: tool.schema
          .string()
          .optional()
          .describe(
            "Entity key for session affinity (e.g., 'owner/repo#123'). If set, executions reuse the same session",
          ),
        timezone: tool.schema.string().optional().describe("Timezone for the cron schedule. Defaults to 'UTC'"),
        run_once: tool.schema
          .boolean()
          .optional()
          .describe("If true, the job is disabled after the first execution. Use for one-time delayed tasks"),
      },
      async execute(args) {
        const name = args.name.trim()
        const cronExpression = args.cron_expression.trim()
        const prompt = args.prompt.trim()
        const agent = args.agent?.trim() || defaultAgent
        const entityKey = args.entity_key?.trim() || null
        const timezone = args.timezone?.trim() || "UTC"
        const runOnce = args.run_once ?? false

        const existing = store.getCronJobByName(name)
        if (existing) {
          return { output: `Error: A cron job named "${name}" already exists (id: ${existing.id})` }
        }

        const nextRun = scheduler.getNextRun(cronExpression, timezone)
        if (!nextRun) {
          return { output: `Error: Invalid cron expression "${cronExpression}"` }
        }

        if (!runOnce) {
          const intervalValidation = validateCronInterval(cronExpression, timezone)
          if (!intervalValidation.valid) {
            return { output: `Error: ${intervalValidation.error}` }
          }
        }

        const id = crypto.randomUUID()
        store.createCronJob({
          id,
          name,
          cron_expression: cronExpression,
          prompt,
          entity_key: entityKey,
          agent,
          timezone,
          run_once: runOnce ? 1 : 0,
          created_by: "agent",
          next_run_at: nextRun.toISOString(),
        })

        scheduler.reload()

        return {
          output: `Created cron job "${name}" (id: ${id})\nSchedule: ${cronExpression} (${timezone})\nNext run: ${nextRun.toISOString()}\nAgent: ${agent}${entityKey ? `\nEntity: ${entityKey}` : ""}${runOnce ? "\nRun once: yes" : ""}`,
          metadata: {
            cron_job_id: id,
            name,
            cron_expression: cronExpression,
            next_run_at: nextRun.toISOString(),
          },
        }
      },
    }),

    list_cron_jobs: tool({
      description:
        "List all scheduled cron jobs. Returns job details including name, schedule, status, and next run time.",
      args: {
        enabled_only: tool.schema
          .boolean()
          .optional()
          .describe("If true, only return enabled jobs. If false, only disabled. Omit for all jobs"),
        limit: tool.schema
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of jobs to return. Defaults to 50"),
      },
      async execute(args) {
        const result = store.listCronJobs({
          limit: args.limit ?? 50,
          enabled: args.enabled_only,
        })

        if (result.jobs.length === 0) {
          return { output: "No cron jobs found." }
        }

        const lines = result.jobs.map((job) => {
          const status = job.enabled ? "enabled" : "disabled"
          const nextRun = job.next_run_at ? new Date(job.next_run_at).toISOString() : "N/A"
          const lastRun = job.last_run_at ? new Date(job.last_run_at).toISOString() : "never"
          return `- ${job.name} (${status})\n  ID: ${job.id}\n  Schedule: ${job.cron_expression} (${job.timezone})\n  Agent: ${job.agent}\n  Next: ${nextRun} | Last: ${lastRun}${job.entity_key ? `\n  Entity: ${job.entity_key}` : ""}${job.run_once ? "\n  Run once: yes" : ""}`
        })

        const output = `Found ${result.jobs.length} cron job(s):\n\n${lines.join("\n\n")}${result.next_cursor ? "\n\n(more jobs available)" : ""}`

        return {
          output,
          metadata: {
            count: result.jobs.length,
            has_more: !!result.next_cursor,
          },
        }
      },
    }),

    get_cron_job: tool({
      description: "Get details of a specific cron job by name or ID, including its prompt and execution history.",
      args: {
        identifier: tool.schema.string().min(1).describe("The cron job name or ID"),
        include_executions: tool.schema
          .boolean()
          .optional()
          .describe("If true, include recent execution history. Defaults to false"),
      },
      async execute(args) {
        const id = args.identifier.trim()
        const job = store.getCronJob(id) ?? store.getCronJobByName(id)

        if (!job) {
          return { output: `Cron job not found: ${id}` }
        }

        const status = job.enabled ? "enabled" : "disabled"
        const nextRun = job.next_run_at ? new Date(job.next_run_at).toISOString() : "N/A"
        const lastRun = job.last_run_at ? new Date(job.last_run_at).toISOString() : "never"

        let output = `Cron Job: ${job.name}
ID: ${job.id}
Status: ${status}
Schedule: ${job.cron_expression} (${job.timezone})
Agent: ${job.agent}
Created by: ${job.created_by}
Created at: ${job.created_at}
Next run: ${nextRun}
Last run: ${lastRun}${job.entity_key ? `\nEntity key: ${job.entity_key}` : ""}${job.run_once ? "\nRun once: yes" : ""}

Prompt:
${job.prompt}`

        if (args.include_executions) {
          const executions = store.listCronExecutions(job.id, { limit: 10 })
          if (executions.length > 0) {
            output += `\n\nRecent executions (${executions.length}):`
            for (const exec of executions) {
              const scheduled = new Date(exec.scheduled_at).toISOString()
              const completed = exec.completed_at ? new Date(exec.completed_at).toISOString() : "N/A"
              output += `\n- ${exec.status} at ${scheduled} (completed: ${completed})`
            }
          } else {
            output += "\n\nNo executions yet."
          }
        }

        return {
          output,
          metadata: { cron_job: job },
        }
      },
    }),

    update_cron_job: tool({
      description: "Update an existing cron job. You can modify its schedule, prompt, agent, or enabled status.",
      args: {
        identifier: tool.schema.string().min(1).describe("The cron job name or ID to update"),
        enabled: tool.schema.boolean().optional().describe("Enable or disable the job"),
        cron_expression: tool.schema.string().optional().describe("New cron expression"),
        prompt: tool.schema.string().optional().describe("New prompt"),
        agent: tool.schema.string().optional().describe("New agent"),
        timezone: tool.schema.string().optional().describe("New timezone"),
        entity_key: tool.schema.string().nullable().optional().describe("New entity key (null to clear)"),
      },
      async execute(args) {
        const id = args.identifier.trim()
        const job = store.getCronJob(id) ?? store.getCronJobByName(id)

        if (!job) {
          return { output: `Cron job not found: ${id}` }
        }

        const updates: Parameters<typeof store.updateCronJob>[1] = {}
        const changes: string[] = []

        if (args.enabled !== undefined) {
          updates.enabled = args.enabled
          changes.push(`enabled: ${args.enabled}`)
        }

        if (args.cron_expression !== undefined) {
          const expr = args.cron_expression.trim()
          const tz = args.timezone?.trim() || job.timezone
          const nextRun = scheduler.getNextRun(expr, tz)
          if (!nextRun) {
            return { output: `Error: Invalid cron expression "${expr}"` }
          }
          if (!job.run_once) {
            const intervalValidation = validateCronInterval(expr, tz)
            if (!intervalValidation.valid) {
              return { output: `Error: ${intervalValidation.error}` }
            }
          }
          updates.cron_expression = expr
          updates.next_run_at = nextRun.toISOString()
          changes.push(`schedule: ${expr}`)
        }

        if (args.prompt !== undefined) {
          updates.prompt = args.prompt.trim()
          changes.push("prompt updated")
        }

        if (args.agent !== undefined) {
          updates.agent = args.agent.trim()
          changes.push(`agent: ${args.agent}`)
        }

        if (args.timezone !== undefined) {
          const tz = args.timezone.trim() || "UTC"
          updates.timezone = tz
          const expr = updates.cron_expression ?? job.cron_expression
          const nextRun = scheduler.getNextRun(expr, tz)
          if (nextRun) {
            updates.next_run_at = nextRun.toISOString()
          }
          changes.push(`timezone: ${tz}`)
        }

        if (args.entity_key !== undefined) {
          updates.entity_key = args.entity_key?.trim() || null
          changes.push(args.entity_key ? `entity_key: ${args.entity_key}` : "entity_key: cleared")
        }

        if (changes.length === 0) {
          return { output: "No changes specified." }
        }

        store.updateCronJob(job.id, updates)
        scheduler.reload()

        return {
          output: `Updated cron job "${job.name}":\n- ${changes.join("\n- ")}`,
          metadata: { cron_job_id: job.id, changes },
        }
      },
    }),

    delete_cron_job: tool({
      description: `Delete a cron job by name or ID. This permanently removes the job and its execution history.

IMPORTANT: This is a destructive action that cannot be undone. Before calling this tool, you MUST:
1. Confirm which job will be deleted by showing its name and details
2. Ask for explicit user confirmation to proceed
3. Only execute this tool AFTER the user has approved

Never delete cron jobs without user confirmation.`,
      args: {
        identifier: tool.schema.string().min(1).describe("The cron job name or ID to delete"),
      },
      async execute(args) {
        const id = args.identifier.trim()
        const job = store.getCronJob(id) ?? store.getCronJobByName(id)

        if (!job) {
          return { output: `Cron job not found: ${id}` }
        }

        store.deleteCronJob(job.id)
        scheduler.reload()

        return {
          output: `Deleted cron job "${job.name}" (id: ${job.id})`,
          metadata: { deleted_id: job.id, deleted_name: job.name },
        }
      },
    }),

    trigger_cron_job: tool({
      description: "Manually trigger a cron job to run immediately, outside of its normal schedule.",
      args: {
        identifier: tool.schema.string().min(1).describe("The cron job name or ID to trigger"),
      },
      async execute(args) {
        const id = args.identifier.trim()
        const job = store.getCronJob(id) ?? store.getCronJobByName(id)

        if (!job) {
          return { output: `Cron job not found: ${id}` }
        }

        if (!job.enabled) {
          return { output: `Cannot trigger disabled cron job "${job.name}". Enable it first.` }
        }

        const triggered = await scheduler.triggerJob(job.id)
        if (!triggered) {
          return { output: `Failed to trigger cron job "${job.name}".` }
        }

        return {
          output: `Triggered cron job "${job.name}" (id: ${job.id}). Job execution started.`,
          metadata: { cron_job_id: job.id },
        }
      },
    }),
  }
}
