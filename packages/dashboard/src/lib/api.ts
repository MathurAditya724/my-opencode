export type EntityRow = {
  entity_key: string
  repo: string
  number: number
  kind: "issue" | "pull_request"
  session_id: string
  share_url: string | null
  cwd: string | null
  agent: string
  created_at: string
  updated_at: string
}

export type DispatchRow = {
  id: string
  entity_key: string | null
  session_id: string | null
  share_url: string | null
  cwd: string | null
  trigger_name: string
  event: string
  delivery_id: string
  status: "started" | "completed" | "failed" | "timeout"
  created_at: string
  completed_at: string | null
}

export type LinkRow = {
  source_key: string
  target_key: string
  relation: string
  created_at: string
}

export type StatsResult = {
  total_entities: number
  total_dispatches: number
  status_counts: Record<string, number>
  recent_24h: number
}

export type EntityDetail = {
  entity: EntityRow
  dispatches: DispatchRow[]
  links: LinkRow[]
}

export type PaginatedEntities = {
  entities: EntityRow[]
  next_cursor: string | null
}

export type PaginatedDispatches = {
  dispatches: DispatchRow[]
  next_cursor: string | null
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export class ApiClient {
  readonly baseUrl: string
  private token: string
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl
    this.token = token
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v) url.searchParams.set(k, v)
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText)
    }
    return res.json() as Promise<T>
  }

  stats(): Promise<StatsResult> {
    return this.request("/api/stats")
  }

  entities(opts?: { limit?: number; cursor?: string; repo?: string }): Promise<PaginatedEntities> {
    return this.request("/api/entities", {
      limit: String(opts?.limit ?? 50),
      cursor: opts?.cursor ?? "",
      repo: opts?.repo ?? "",
    })
  }

  entity(key: string): Promise<EntityDetail> {
    return this.request(`/api/entities/${encodeURIComponent(key)}`)
  }

  dispatches(opts?: {
    limit?: number
    cursor?: string
    status?: string
    event?: string
  }): Promise<PaginatedDispatches> {
    return this.request("/api/dispatches", {
      limit: String(opts?.limit ?? 50),
      cursor: opts?.cursor ?? "",
      status: opts?.status ?? "",
      event: opts?.event ?? "",
    })
  }

  async healthz(): Promise<boolean> {
    try {
      const res = await fetch(new URL("/healthz", this.baseUrl).toString())
      return res.ok
    } catch {
      return false
    }
  }
}
