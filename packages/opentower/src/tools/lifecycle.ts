// Lifecycle inspection tools for OpenCode agents.
// These tools allow agents to query dispatches, entities, and session messages.

import { tool } from "@opencode-ai/plugin"
import type { AgentClient } from "../interfaces"
import type { LifecycleStore } from "../storage"

export type LifecycleToolsOptions = {
  store: LifecycleStore
  client: AgentClient
}

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data: unknown }).data
    if (data && typeof data === "object" && "message" in data) {
      return (data as { message: string }).message
    }
  }
  return fallback
}

export function makeLifecycleTools(opts: LifecycleToolsOptions) {
  const { store, client } = opts

  return {
    list_dispatches: tool({
      description:
        "List recent opentower dispatches (sessions triggered by webhooks or cron). Use this to scan recent activity and check session statuses.",
      args: {
        limit: tool.schema
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of dispatches to return. Defaults to 10"),
        status: tool.schema.string().optional().describe("Filter by status: started, completed, failed, or timeout"),
        event: tool.schema
          .string()
          .optional()
          .describe("Filter by event type (e.g., 'issues', 'pull_request', 'check_suite')"),
      },
      async execute(args) {
        const result = store.listDispatches({
          limit: args.limit ?? 10,
          status: args.status,
          event: args.event,
        })

        if (result.dispatches.length === 0) {
          return { output: "No dispatches found." }
        }

        const lines = result.dispatches.map((d) => {
          const completed = d.completed_at ?? "N/A"
          return `- ${d.id}\n  Entity: ${d.entity_key ?? "none"} | Session: ${d.session_id ?? "none"}\n  Share URL: ${d.share_url ?? "none"}\n  Trigger: ${d.trigger_name} | Event: ${d.event} | Delivery: ${d.delivery_id}\n  Status: ${d.status} | Created: ${d.created_at} | Completed: ${completed}`
        })

        const output = `Found ${result.dispatches.length} dispatch(es):\n\n${lines.join("\n\n")}${result.next_cursor ? "\n\n(more dispatches available)" : ""}`

        return {
          output,
          metadata: {
            count: result.dispatches.length,
            has_more: !!result.next_cursor,
          },
        }
      },
    }),

    list_entities: tool({
      description: "List entities (issues and pull requests) tracked by opentower with their session mappings.",
      args: {
        limit: tool.schema
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of entities to return. Defaults to 10"),
        repo: tool.schema.string().optional().describe("Filter by repository (e.g., 'owner/repo')"),
      },
      async execute(args) {
        const result = store.listEntities({
          limit: args.limit ?? 10,
          repo: args.repo,
        })

        if (result.entities.length === 0) {
          return { output: "No entities found." }
        }

        const lines = result.entities.map((e) => {
          return `- ${e.entity_key} (${e.kind})\n  Repo: ${e.repo} | #${e.number}\n  Session: ${e.session_id}\n  Share URL: ${e.share_url ?? "none"}\n  Agent: ${e.agent}\n  Created: ${e.created_at} | Updated: ${e.updated_at}`
        })

        const output = `Found ${result.entities.length} entity(ies):\n\n${lines.join("\n\n")}${result.next_cursor ? "\n\n(more entities available)" : ""}`

        return {
          output,
          metadata: {
            count: result.entities.length,
            has_more: !!result.next_cursor,
          },
        }
      },
    }),

    get_entity: tool({
      description: "Get full details of a specific entity including all its dispatches and linked entities.",
      args: {
        entity_key: tool.schema.string().min(1).describe("Entity key (e.g., 'owner/repo#42')"),
      },
      async execute(args) {
        const entity = store.getEntity(args.entity_key)
        if (!entity) {
          return { output: `Entity not found: ${args.entity_key}` }
        }

        const dispatches = store.getEntityDispatches(args.entity_key)
        const links = store.getEntityLinks(args.entity_key)

        let output = `Entity: ${entity.entity_key} (${entity.kind})
Repo: ${entity.repo} | #${entity.number}
Session: ${entity.session_id}
Share URL: ${entity.share_url ?? "none"}
Agent: ${entity.agent}
Created: ${entity.created_at}
Updated: ${entity.updated_at}`

        if (dispatches.length > 0) {
          output += `\n\nDispatches (${dispatches.length}):`
          for (const d of dispatches) {
            const completed = d.completed_at ?? "N/A"
            output += `\n- ${d.id} [${d.status}] ${d.trigger_name}/${d.event} (${d.created_at}, completed: ${completed})`
          }
        } else {
          output += "\n\nNo dispatches."
        }

        if (links.length > 0) {
          output += `\n\nLinked entities (${links.length}):`
          for (const l of links) {
            output += `\n- ${l.source_key} → ${l.target_key} (${l.relation})`
          }
        } else {
          output += "\n\nNo linked entities."
        }

        return {
          output,
          metadata: { entity, dispatches_count: dispatches.length, links_count: links.length },
        }
      },
    }),

    read_session_messages: tool({
      description:
        "Read messages from an opentower-managed session. Get the session_id from list_dispatches or get_entity first.",
      args: {
        session_id: tool.schema
          .string()
          .min(1)
          .describe("Session ID to read messages from (get this from list_dispatches or get_entity)"),
        limit: tool.schema
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of messages to return. Defaults to 20"),
      },
      async execute(args, context) {
        const result = await client.session.messages({
          path: { id: args.session_id },
          query: { limit: args.limit ?? 20 },
          signal: context.abort,
        })

        if (result.error) {
          return { output: `Error reading session ${args.session_id}: ${errorMessage(result.error, "not found")}` }
        }

        const messages = result.data
        if (!messages || messages.length === 0) {
          return { output: `No messages in session ${args.session_id}.` }
        }

        const lines = messages.map((msg, i) => {
          const role = msg.info.role
          const created = new Date(msg.info.time.created * 1000).toISOString()
          const partTexts: string[] = []

          for (const part of msg.parts) {
            if (part.type === "text" && part.text) {
              const text = part.text.length > 500 ? `${part.text.slice(0, 500)}...` : part.text
              partTexts.push(`  ${text}`)
            } else if (part.type === "tool") {
              partTexts.push(`  [tool: ${part.tool}]`)
            }
          }

          return `[${i + 1}] ${role} (${created}):\n${partTexts.join("\n") || "  (no text content)"}`
        })

        return {
          output: `Session ${args.session_id} — ${messages.length} message(s):\n\n${lines.join("\n\n")}`,
          metadata: { session_id: args.session_id, count: messages.length },
        }
      },
    }),

    post_session_message: tool({
      description: `Post a message into an existing opentower-managed session. This sends a prompt to the agent in that session. Use with care — this directly interacts with another agent session.

IMPORTANT: Before calling this tool, you MUST:
1. Explain which session you will message and why
2. Show the message content to the user
3. Ask for explicit user confirmation
4. Only execute AFTER the user has approved`,
      args: {
        session_id: tool.schema
          .string()
          .min(1)
          .describe("Session ID to post to (get this from list_dispatches or get_entity)"),
        message: tool.schema.string().min(1).describe("The message/prompt to send to the session"),
        agent: tool.schema.string().optional().describe("Override the agent handling the message"),
      },
      async execute(args, context) {
        const result = await client.session.prompt({
          path: { id: args.session_id },
          body: {
            parts: [{ type: "text", text: args.message }],
            ...(args.agent ? { agent: args.agent } : {}),
          },
          signal: context.abort,
        })

        if (result.error) {
          return { output: `Error posting to session ${args.session_id}: ${errorMessage(result.error, "failed")}` }
        }

        return {
          output: `Message posted to session ${args.session_id}.`,
          metadata: { session_id: args.session_id },
        }
      },
    }),
  }
}
