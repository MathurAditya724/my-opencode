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

// Like lookup() but expands `[*]` across array elements.
export function lookupAll(ctx: unknown, path: string): unknown[] {
  const STAR = Symbol("star")
  const tokens: Array<string | typeof STAR> = []
  for (const part of path.split(".")) {
    let i = 0
    while (i < part.length) {
      const lb = part.indexOf("[", i)
      if (lb < 0) {
        if (i < part.length) tokens.push(part.slice(i))
        break
      }
      if (lb > i) tokens.push(part.slice(i, lb))
      const rb = part.indexOf("]", lb)
      if (rb < 0) {
        tokens.push(part.slice(i))
        break
      }
      const inside = part.slice(lb + 1, rb)
      tokens.push(inside === "*" ? STAR : inside)
      i = rb + 1
    }
  }

  let frontier: unknown[] = [ctx]
  for (const tok of tokens) {
    const next: unknown[] = []
    for (const cur of frontier) {
      if (tok === STAR) {
        if (Array.isArray(cur)) for (const el of cur) next.push(el)
      } else if (cur && typeof cur === "object" && tok in (cur as object)) {
        next.push((cur as Record<string, unknown>)[tok])
      }
    }
    frontier = next
    if (frontier.length === 0) return []
  }
  return frontier
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
