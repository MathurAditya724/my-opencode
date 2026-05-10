// AI-powered entity resolution for inbound emails. Uses the Vercel AI
// SDK to extract the GitHub entity (issue or PR) that an email relates
// to — regardless of whether the email is a GitHub notification, a
// Sentry alert, a CI notification, or anything else.
//
// The resolver is the single source of truth for email→entity mapping.
// It replaces regex-based header parsing with a unified LLM call that
// can reason about cross-platform references (e.g. a Sentry error that
// was introduced by a specific PR).
//
// After AI extraction, the resolver verifies the entity via `gh` CLI
// to ensure it exists and to get the correct kind (issue vs PR). This
// prevents session affinity errors when the AI guesses the wrong kind.

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
  source: z.enum(["github", "sentry", "ci", "other"]).describe("The platform that originated this email"),
  confidence: z.enum(["high", "medium", "low"]).describe("How confident you are in the entity identification"),
  reasoning: z.string().describe("Brief explanation of how the entity was identified or why it could not be"),
})

export type EntityResult = z.infer<typeof entityResultSchema>

const SYSTEM_PROMPT = `You are an entity resolver for a GitHub-centric automation system. Given an inbound email, determine which GitHub issue or pull request it relates to.

## What you receive
Emails from various sources: GitHub notifications, Sentry alerts, CI/CD systems, or forwarded messages from other platforms. Headers include standard email fields plus GitHub-specific ones (X-GitHub-Reason, X-GitHub-Sender) when present.

## What you return
The specific GitHub entity (owner/repo + issue/PR number) the email is about, or null if no entity can be identified from the content.

## When to return entity: null

Only return \`entity: null\` when the email genuinely does not reference any specific GitHub issue or pull request. Examples:
- **Marketing/newsletter emails**: GitHub changelog, product announcements, billing notices
- **Repository-level notifications** with no issue/PR reference: new stars, forks, watchers
- Emails where you simply cannot find any issue or PR number, URL, or reference

Do NOT return null just because an email is automated or informational. If a bot notification, CI result, deploy preview, Sentry alert, or dependabot alert references a specific issue or PR, extract that entity.

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

**CI/CD notifications:**
- Build/deploy notifications often reference the PR or branch that triggered them
- Look for PR numbers, branch names like \`fix/issue-42\`, or commit messages

## Rules
- Your job is entity extraction only — do NOT judge whether the email is "actionable" or "noise". The downstream agent decides what to do.
- Return \`entity: null\` only when no specific GitHub entity can be identified from the content
- Set confidence to "high" when you find an explicit reference (URL, #N pattern, structured header)
- Set confidence to "medium" when you can infer the entity from context clues (branch names, commit messages, partial references)
- Set confidence to "low" only when the link between the email and the entity is very tenuous
- For the \`kind\` field: use "pull_request" only when you have evidence it's a PR; default to "issue" otherwise`

// Result of verifying an entity via `gh` CLI.
export type VerifiedEntity = {
  repo: string
  number: number
  kind: "issue" | "pull_request"
  // PR body for extracting linked issues (only present for PRs)
  body: string | null
}

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
  // Verify an AI-extracted entity via `gh` CLI. Returns the verified
  // entity with correct kind and PR body, or null if verification fails.
  verify(entity: { repo: string; number: number }): Promise<VerifiedEntity | null>
}

// Verify an entity via `gh` CLI. Checks both PR and issue endpoints
// to determine the correct kind and fetch the body for link extraction.
async function verifyEntity(entity: { repo: string; number: number }): Promise<VerifiedEntity | null> {
  // Try PR first since it's more specific (issues API also returns PRs
  // but with less detail)
  try {
    const prProc = Bun.spawn(["gh", "pr", "view", String(entity.number), "-R", entity.repo, "--json", "number,body"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const prOut = await new Response(prProc.stdout).text()
    const prCode = await prProc.exited
    if (prCode === 0) {
      const pr = JSON.parse(prOut) as { number: number; body: string }
      Sentry.logger.info("entity_resolver.verified", {
        entity: `${entity.repo}#${entity.number}`,
        kind: "pull_request",
      })
      return {
        repo: entity.repo,
        number: entity.number,
        kind: "pull_request",
        body: pr.body ?? null,
      }
    }
  } catch {
    // PR fetch failed, try issue
  }

  // Try issue
  try {
    const issueProc = Bun.spawn(
      ["gh", "issue", "view", String(entity.number), "-R", entity.repo, "--json", "number,body"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const issueOut = await new Response(issueProc.stdout).text()
    const issueCode = await issueProc.exited
    if (issueCode === 0) {
      const issue = JSON.parse(issueOut) as { number: number; body: string }
      Sentry.logger.info("entity_resolver.verified", {
        entity: `${entity.repo}#${entity.number}`,
        kind: "issue",
      })
      return {
        repo: entity.repo,
        number: entity.number,
        kind: "issue",
        body: issue.body ?? null,
      }
    }
  } catch {
    // Issue fetch also failed
  }

  Sentry.logger.warn("entity_resolver.verify_failed", {
    entity: `${entity.repo}#${entity.number}`,
    reason: "entity not found via gh CLI",
  })
  return null
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

    async verify(entity) {
      return verifyEntity(entity)
    },
  }
}
