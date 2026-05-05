// Path lookup + mustache-ish template rendering.

// Walk a dotted path and return the value only if it's a string.
// Saves the (lookup → typeof === "string" ? v : null) dance at call sites.
export function lookupString(ctx: unknown, path: string): string | null {
  const v = lookup(ctx, path)
  return typeof v === "string" ? v : null
}

// Walk a dotted path through a payload. Numeric `[N]` works; missing
// segment yields undefined.
export function lookup(ctx: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

// {{ a.b.c }} → ctx.a.b.c. Missing → empty string. Objects → JSON.
export function renderTemplate(
  template: string,
  ctx: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g, (_m, path) => {
    const value = lookup(ctx, String(path))
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    return JSON.stringify(value)
  })
}
