// Per-trigger filters. Each returns null on match (= proceed) or a
// string reason on miss (= skip with that reason).

import type { NormalizedTrigger } from "./types"
import { lookup, lookupAll } from "./template"

// Every enabled trigger matching (event, action) fires. `*` matches
// any event; null/missing action matches any action.
export function findMatching(
  triggers: NormalizedTrigger[],
  event: string,
  action: string | null,
): NormalizedTrigger[] {
  return triggers.filter((t) => {
    if (t.enabled === false) return false
    const eventOk = t.event === "*" || t.event === event
    if (!eventOk) return false
    return t.action === null || t.action === action
  })
}

// Returns null on match, or a string reason for the first miss.
export function evaluatePayloadFilter(
  filter: Record<string, unknown> | undefined,
  payload: unknown,
): string | null {
  if (!filter) return null
  for (const [path, expected] of Object.entries(filter)) {
    const actual = lookup(payload, path)
    if (expected === "*") {
      // "*" = any present, non-empty value.
      if (
        actual === undefined ||
        actual === null ||
        actual === "" ||
        (Array.isArray(actual) && actual.length === 0) ||
        (typeof actual === "object" &&
          actual !== null &&
          Object.keys(actual as object).length === 0)
      ) {
        return `payload.${path} is absent/empty`
      }
      continue
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return `payload.${path} = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`
    }
  }
  return null
}

// Returns null on match, or a string reason on miss. OR across paths.
// Fail-closed when bot login is unresolved.
export function evaluateBotMatch(
  paths: string[] | undefined,
  payload: unknown,
  botLogin: string | null,
): string | null {
  if (!paths || paths.length === 0) return null
  if (!botLogin) return "bot identity unresolved"
  const lower = botLogin.toLowerCase()
  for (const path of paths) {
    for (const v of lookupAll(payload, path)) {
      if (typeof v === "string" && v.toLowerCase() === lower) return null
    }
  }
  return `none of [${paths.join(", ")}] matched bot login '${botLogin}'`
}

// Sender filter (self-loop guard). Case-insensitive exact match
// against payload.sender.login.
export function evaluateIgnoreAuthors(
  ignoreAuthors: string[] | undefined,
  sender: string | null,
): string | null {
  if (!ignoreAuthors || ignoreAuthors.length === 0 || !sender) return null
  const lower = sender.toLowerCase()
  if (ignoreAuthors.some((a) => a.toLowerCase() === lower)) {
    return `ignored sender '${sender}'`
  }
  return null
}
