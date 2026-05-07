// AI-powered entity key resolution for emails that don't match
// structured GitHub header patterns (e.g. Sentry alerts, forwarded
// issues from other platforms). Uses the Vercel AI SDK with Anthropic
// to extract a GitHub entity reference from unstructured email content.
//
// This is the slow path — regex extraction in entity.ts handles the
// fast path for GitHub notification emails.

import { createAnthropic } from "@ai-sdk/anthropic"
import * as Sentry from "@sentry/bun"
import { generateObject } from "ai"
import { z } from "zod"

const entityResultSchema = z.object({
  repo: z
    .string()
    .nullable()
    .describe("GitHub repository in owner/repo format, or null if not identifiable"),
  number: z
    .number()
    .nullable()
    .describe("Issue or PR number, or null if not identifiable"),
  kind: z
    .enum(["issue", "pull_request"])
    .nullable()
    .describe("Whether this references an issue or pull request, or null if unknown"),
  reasoning: z
    .string()
    .describe("Brief explanation of how the entity was identified"),
})

type EntityResult = z.infer<typeof entityResultSchema>

const SYSTEM_PROMPT = `You are an entity resolver for a GitHub automation system. Given an email, identify whether it references a specific GitHub issue or pull request.

Look for:
- Direct references: issue/PR URLs, "#123" patterns, "owner/repo#123"
- Sentry alerts: error titles that match known issues, deployment references, commit SHAs
- CI/CD notifications: build failures, deployment status tied to PRs
- Forwarded issues from other platforms that reference GitHub entities

Return the GitHub repo (owner/repo format) and issue/PR number if identifiable.
If you cannot confidently identify a specific GitHub entity, return null for all fields.
Be conservative — only return a match when you're confident.`

export type EntityResolver = {
  resolve(email: {
    from: string
    to: string
    subject: string
    message_id: string
    body_text: string | null
    list_id: string | null
  }): Promise<EntityResult>
}

export function createEntityResolver(): EntityResolver | null {
  // Only create the resolver if ANTHROPIC_API_KEY is available.
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const anthropic = createAnthropic({ apiKey })
  const model = anthropic("claude-sonnet-4-20250514")

  return {
    async resolve(email) {
      const prompt = [
        `From: ${email.from}`,
        `To: ${email.to}`,
        `Subject: ${email.subject}`,
        `Message-ID: ${email.message_id}`,
        email.list_id ? `List-ID: ${email.list_id}` : null,
        "",
        "Body:",
        email.body_text?.slice(0, 4000) ?? "(no text body)",
      ]
        .filter((l) => l !== null)
        .join("\n")

      try {
        const { object } = await generateObject({
          model,
          schema: entityResultSchema,
          system: SYSTEM_PROMPT,
          prompt,
          temperature: 0,
          maxOutputTokens: 256,
        })
        return object
      } catch (err) {
        Sentry.logger.error("entity_resolver.failed", {
          message_id: email.message_id,
          error: err instanceof Error ? err.message : String(err),
        })
        return { repo: null, number: null, kind: null, reasoning: `resolver error: ${String(err)}` }
      }
    },
  }
}
