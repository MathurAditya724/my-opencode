// AI-powered entity resolution for inbound emails. Uses the Vercel AI
// SDK to extract the GitHub entity (issue or PR) that an email relates
// to — regardless of whether the email is a GitHub notification, a
// Sentry alert, a CI notification, or anything else.
//
// The resolver is the single source of truth for email→entity mapping.
// It replaces regex-based header parsing with a unified LLM call that
// can reason about cross-platform references (e.g. a Sentry error that
// was introduced by a specific PR).

import { createAnthropic } from "@ai-sdk/anthropic"
import * as Sentry from "@sentry/bun"
import { generateObject } from "ai"
import { z } from "zod"

const entityResultSchema = z.object({
  entity: z
    .object({
      repo: z.string().describe("GitHub repository in owner/repo format (e.g. 'acme/webapp')"),
      number: z.number().int().positive().describe("GitHub issue or pull request number"),
      kind: z
        .enum(["issue", "pull_request"])
        .describe("Whether this is an issue or a pull request. Default to 'issue' if uncertain."),
    })
    .nullable()
    .describe("The GitHub entity this email relates to, or null if no specific entity can be identified"),
  source: z
    .enum(["github", "sentry", "ci", "other"])
    .describe("The platform that originated this email"),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("How confident you are in the entity identification"),
  reasoning: z.string().describe("Brief explanation of how the entity was identified or why it could not be"),
})

export type EntityResult = z.infer<typeof entityResultSchema>

const SYSTEM_PROMPT = `You are an entity resolver for a GitHub-centric automation system. Given an inbound email, determine which GitHub issue or pull request it relates to.

## What you receive
Emails from various sources: GitHub notifications, Sentry alerts, CI/CD systems, or forwarded messages from other platforms. Headers include standard email fields plus GitHub-specific ones (X-GitHub-Reason, X-GitHub-Sender) when present.

## What you return
The specific GitHub entity (owner/repo + issue/PR number) the email is about, or null if it's not actionable.

## Emails to SKIP (return entity: null)

Return \`entity: null\` for these — they are noise and not tied to a specific entity:
- **Automated bot notifications**: codecov reports, deploy previews (Vercel, Netlify), dependabot alerts, renovate PRs, greenkeeper — these are informational only
- **Repository-level notifications**: new stars, forks, watchers, repository transfers, security advisories with no specific issue
- **Marketing/newsletter emails**: GitHub changelog, product announcements, billing notices
- **Broadcast notifications**: team mentions in discussions, org-wide announcements
- **Deployment status emails** that only confirm "deployment succeeded" with no error or failure to investigate

## How to identify entities

**GitHub notification emails:**
- Message-ID and References headers encode the entity: \`<owner/repo/issues/42/...@github.com>\` or \`<owner/repo/pull/54/...@github.com>\`
- List-ID encodes the repo: \`<repo.owner.github.com>\`
- Subject line format: \`[owner/repo] Title (#42)\` or \`Re: [owner/repo] Title (#42)\`
- The (#N) at the end of the subject is the canonical issue/PR number
- X-GitHub-Reason tells you why you got this email (author, comment, mention, review_requested, etc.)

**Sentry alert emails:**
- Look for GitHub URLs, commit SHAs, PR references in the alert body
- Sentry deployment context may reference the PR that deployed the change
- Error stack traces may contain file paths that hint at the repository
- If the Sentry alert has no clear link to a specific GitHub entity, return null

**CI/CD notifications:**
- Build/deploy notifications often reference the PR or branch that triggered them
- Look for PR numbers, branch names like \`fix/issue-42\`, or commit messages
- Generic "build succeeded" emails with no PR/issue context should return null

## Rules
- Return \`entity: null\` when you cannot confidently identify a specific GitHub entity
- Return \`entity: null\` for noise/automated emails that don't warrant action (see skip list above)
- Set confidence to "high" only when you find an explicit reference (URL, #N pattern, structured header)
- Set confidence to "medium" when you can infer the entity from context clues
- Set confidence to "low" when it's a guess — the caller will discard low-confidence results
- For the \`kind\` field: use "pull_request" only when you have evidence it's a PR; default to "issue" otherwise`

export type EntityResolver = {
  resolve(email: {
    from: string
    to: string
    subject: string
    message_id: string
    in_reply_to: string | null
    references: string[]
    list_id: string | null
    x_github_reason: string | null
    x_github_sender: string | null
    body_text: string | null
  }): Promise<EntityResult>
}

export function createEntityResolver(): EntityResolver | null {
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
        email.in_reply_to ? `In-Reply-To: ${email.in_reply_to}` : null,
        email.references.length > 0 ? `References: ${email.references.join(" ")}` : null,
        email.list_id ? `List-ID: ${email.list_id}` : null,
        email.x_github_reason ? `X-GitHub-Reason: ${email.x_github_reason}` : null,
        email.x_github_sender ? `X-GitHub-Sender: ${email.x_github_sender}` : null,
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
          maxOutputTokens: 512,
        })

        Sentry.logger.info("entity_resolver.resolved", {
          message_id: email.message_id,
          source: object.source,
          confidence: object.confidence,
          entity: object.entity ? `${object.entity.repo}#${object.entity.number}` : "null",
          reasoning: object.reasoning,
        })

        return object
      } catch (err) {
        Sentry.logger.error("entity_resolver.failed", {
          message_id: email.message_id,
          error: err instanceof Error ? err.message : String(err),
        })
        return {
          entity: null,
          source: "other",
          confidence: "low",
          reasoning: `resolver error: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }
}
