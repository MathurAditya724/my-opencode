// In-process metrics collector. Exposes counters, gauges, and
// histograms for webhook pipeline observability. Served as JSON
// on GET /metrics for scraping by Prometheus (via json_exporter),
// Datadog, or a simple dashboard.

export type Metrics = {
  inc(name: string, tags?: Record<string, string>): void
  gauge(name: string, value: number): void
  timing(name: string, durationMs: number): void
  snapshot(): MetricsSnapshot
}

export type MetricsSnapshot = {
  counters: Record<string, number>
  gauges: Record<string, number>
  timings: Record<string, { count: number; sum: number; min: number; max: number; avg: number }>
  tagged: Record<string, Record<string, number>>
}

export function makeMetrics(): Metrics {
  const counters = new Map<string, number>()
  const gauges = new Map<string, number>()
  const timings = new Map<
    string,
    { count: number; sum: number; min: number; max: number }
  >()
  const tagged = new Map<string, Map<string, number>>()

  function tagKey(name: string, tags?: Record<string, string>): string {
    if (!tags || Object.keys(tags).length === 0) return name
    const parts = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
    return `${name}{${parts.join(",")}}`
  }

  return {
    inc(name, tags) {
      const key = tagKey(name, tags)
      if (tags && Object.keys(tags).length > 0) {
        if (!tagged.has(name)) tagged.set(name, new Map())
        const m = tagged.get(name)!
        m.set(key, (m.get(key) ?? 0) + 1)
      } else {
        counters.set(key, (counters.get(key) ?? 0) + 1)
      }
    },

    gauge(name, value) {
      gauges.set(name, value)
    },

    timing(name, durationMs) {
      const existing = timings.get(name)
      if (existing) {
        existing.count++
        existing.sum += durationMs
        existing.min = Math.min(existing.min, durationMs)
        existing.max = Math.max(existing.max, durationMs)
      } else {
        timings.set(name, {
          count: 1,
          sum: durationMs,
          min: durationMs,
          max: durationMs,
        })
      }
    },

    snapshot() {
      const c: Record<string, number> = {}
      for (const [k, v] of counters) c[k] = v

      const g: Record<string, number> = {}
      for (const [k, v] of gauges) g[k] = v

      const t: Record<
        string,
        { count: number; sum: number; min: number; max: number; avg: number }
      > = {}
      for (const [k, v] of timings) {
        t[k] = { ...v, avg: v.count > 0 ? v.sum / v.count : 0 }
      }

      const tg: Record<string, Record<string, number>> = {}
      for (const [name, m] of tagged) {
        tg[name] = {}
        for (const [k, v] of m) tg[name][k] = v
      }

      return { counters: c, gauges: g, timings: t, tagged: tg }
    },
  }
}
