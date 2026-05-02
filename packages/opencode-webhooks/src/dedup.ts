// In-memory dedup by external ID with TTL-based expiry.
// Replaces the SQLite-backed dedup. Lost on restart -- worst case is a
// duplicate dispatch after a deploy, which is acceptable.

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour
const PRUNE_INTERVAL_MS = 5 * 60 * 1000 // prune every 5 min

export type Dedup = {
  seen(key: string): boolean
  size(): number
}

export function makeDedup(ttlMs: number = DEFAULT_TTL_MS): Dedup {
  const entries = new Map<string, number>()

  const pruneTimer = setInterval(() => {
    const now = Date.now()
    for (const [k, ts] of entries) {
      if (now - ts > ttlMs) entries.delete(k)
    }
  }, PRUNE_INTERVAL_MS)
  pruneTimer.unref?.()

  return {
    seen(key: string): boolean {
      if (entries.has(key)) return true
      entries.set(key, Date.now())
      return false
    },
    size() {
      return entries.size
    },
  }
}
