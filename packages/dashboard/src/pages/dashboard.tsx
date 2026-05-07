import { useCallback, useState } from "react"
import { Link } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { useQuery } from "@/hooks/use-api"
import { timeAgo, entityGitHubUrl } from "@/lib/format"
import type { ApiClient, StatsResult, PaginatedEntities, PaginatedDispatches } from "@/lib/api"
import { Activity, GitPullRequest, Zap, Clock, RefreshCw, ChevronRight, ExternalLink } from "lucide-react"

export default function DashboardPage() {
  const [dispatchFilter, setDispatchFilter] = useState<string>("")
  const fetchStats = useCallback((c: ApiClient) => c.stats(), [])
  const fetchEntities = useCallback((c: ApiClient) => c.entities({ limit: 10 }), [])
  const fetchDispatches = useCallback(
    (c: ApiClient) => c.dispatches({ limit: 20, status: dispatchFilter || undefined }),
    [dispatchFilter],
  )

  const stats = useQuery<StatsResult>(fetchStats)
  const entities = useQuery<PaginatedEntities>(fetchEntities)
  const dispatches = useQuery<PaginatedDispatches>(fetchDispatches, [dispatchFilter])

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          title="Entities"
          value={stats.data?.total_entities}
          icon={<GitPullRequest className="h-4 w-4 text-muted-foreground" />}
          loading={stats.loading}
        />
        <StatCard
          title="Total Dispatches"
          value={stats.data?.total_dispatches}
          icon={<Zap className="h-4 w-4 text-muted-foreground" />}
          loading={stats.loading}
        />
        <StatCard
          title="Last 24h"
          value={stats.data?.recent_24h}
          icon={<Clock className="h-4 w-4 text-muted-foreground" />}
          loading={stats.loading}
        />
        <StatCard
          title="Active / Failed"
          value={
            stats.data
              ? `${stats.data.status_counts.started ?? 0} / ${stats.data.status_counts.failed ?? 0}`
              : undefined
          }
          icon={<Activity className="h-4 w-4 text-muted-foreground" />}
          loading={stats.loading}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent entities */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent Entities</CardTitle>
            <div className="flex gap-2">
              <Button variant="ghost" size="icon" onClick={entities.refetch}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Link to="/entities">
                <Button variant="ghost" size="sm">
                  View all <ChevronRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {entities.loading && !entities.data ? (
              <LoadingSkeleton rows={5} />
            ) : entities.error ? (
              <ErrorMsg msg={entities.error} />
            ) : (
              <div className="space-y-3">
                {entities.data?.entities.map((e) => (
                  <div key={e.entity_key} className="flex items-center justify-between rounded-lg border p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link to={`/entities/${encodeURIComponent(e.entity_key)}`} className="font-mono text-sm font-medium hover:underline">
                          {e.entity_key}
                        </Link>
                        <a href={entityGitHubUrl(e)} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-xs">{e.kind === "pull_request" ? "PR" : "Issue"}</Badge>
                        <span>{timeAgo(e.updated_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {entities.data?.entities.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">No entities yet</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent dispatches */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent Dispatches</CardTitle>
            <div className="flex gap-2">
              <div className="flex gap-1">
                {["", "started", "completed", "failed", "timeout"].map((s) => (
                  <Button
                    key={s}
                    variant={dispatchFilter === s ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setDispatchFilter(s)}
                  >
                    {s || "All"}
                  </Button>
                ))}
              </div>
              <Button variant="ghost" size="icon" onClick={dispatches.refetch}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {dispatches.loading && !dispatches.data ? (
              <LoadingSkeleton rows={8} />
            ) : dispatches.error ? (
              <ErrorMsg msg={dispatches.error} />
            ) : (
              <div className="space-y-2">
                {dispatches.data?.dispatches.map((d) => (
                  <div key={d.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{d.trigger_name}</span>
                        <StatusBadge status={d.status} />
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{d.event}</span>
                        {d.entity_key && (
                          <Link to={`/entities/${encodeURIComponent(d.entity_key)}`} className="font-mono hover:underline">
                            {d.entity_key}
                          </Link>
                        )}
                        <span>{timeAgo(d.created_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {dispatches.data?.dispatches.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">No dispatches</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function StatCard({ title, value, icon, loading }: {
  title: string
  value?: string | number
  icon: React.ReactNode
  loading: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-8 w-16 animate-pulse rounded bg-muted" />
        ) : (
          <div className="text-2xl font-bold">{value ?? 0}</div>
        )}
      </CardContent>
    </Card>
  )
}

function LoadingSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  )
}

function ErrorMsg({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive-foreground">
      {msg}
    </div>
  )
}
