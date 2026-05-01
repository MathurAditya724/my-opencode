// Sender allowlist supporting static strings and regex patterns.
// Mirrors the parser used by the Cloudflare email worker so a single
// list works in both places.
//
//   "notifications@github.com"   — exact match (case-insensitive)
//   "/^.*@github\\.com$/"        — regex (slashes delimit; case-insensitive)

export type AllowlistPattern =
  | { kind: "exact"; value: string }
  | { kind: "regex"; re: RegExp }

export function parseAllowlist(raw: string[] | undefined): AllowlistPattern[] {
  if (!raw || raw.length === 0) return []
  const out: AllowlistPattern[] = []
  for (const s of raw) {
    if (typeof s !== "string" || s.length === 0) continue
    if (s.length >= 2 && s.startsWith("/") && s.endsWith("/")) {
      try {
        out.push({ kind: "regex", re: new RegExp(s.slice(1, -1), "i") })
      } catch {
        // Bad regex — skip (don't fail the whole list).
      }
      continue
    }
    out.push({ kind: "exact", value: s.toLowerCase() })
  }
  return out
}

export function matchesAllowlist(
  from: string,
  patterns: AllowlistPattern[],
): boolean {
  if (patterns.length === 0) return false
  // Strip an RFC5322 display name: '"Foo" <foo@bar.com>' → 'foo@bar.com'.
  const addr = extractAddress(from).toLowerCase()
  return patterns.some((p) =>
    p.kind === "exact" ? p.value === addr : p.re.test(addr),
  )
}

// Extract the bare address from an RFC5322 From value. Falls back to the
// trimmed input if no `<...>` form is present.
export function extractAddress(from: string): string {
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from).trim()
}
