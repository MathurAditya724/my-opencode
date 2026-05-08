import { ErrorMsg } from "@/components/error-msg"
import { LastUpdated } from "@/components/last-updated"
import { LoadingSkeleton } from "@/components/loading-skeleton"
import { Pagination } from "@/components/pagination"
import { SessionLink } from "@/components/session-link"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useApiClient, useOpencodeUrl } from "@/hooks/use-api"
import type { PaginatedDispatches, PaginatedEntities, StatsResult } from "@/lib/api"
import { entityGitHubUrl, timeAgo } from "@/lib/format"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Activity, ChevronRight, Clock, ExternalLink, GitPullRequest, Zap } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

export default function DashboardPage() {
  const client = useApiClient()
  const opencodeUrl = useOpencodeUrl()
  const [dispatchFilter, setDispatchFilter] = useState("")
  const [entityPage, setEntityPage] = useState(0)
  const [entityCursors, setEntityCursors] = useState<string[]>([""])
  const [dispatchPage, setDispatchPage] = useState(0)
  const [dispatchCursors, setDispatchCursors] = useState<string[]>([""])

  const serverUrl = client?.baseUrl
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger on server change
  useEffect(() => {
    setEntityPage(0)
    setEntityCursors([""])
    setDispatchPage(0)
    setDispatchCursors([""])
    setDispatchFilter("")
  }, [serverUrl])

  const stats = useQuery<StatsResult>({
    queryKey: ["stats", client?.baseUrl],
    queryFn: () => client!.stats(),
    enabled: !!client,
  })

  const entities = useQuery<PaginatedEntities>({
    queryKey: ["dashboard-entities", client?.baseUrl, entityCursors[entityPage]],
    queryFn: () => client!.entities({ limit: 10, cursor: entityCursors[entityPage] || undefined }),
    enabled: !!client,
    placeholderData: keepPreviousData,
  })

  const dispatches = useQuery<PaginatedDispatches>({
    queryKey: ["dashboard-dispatches", client?.baseUrl, dispatchFilter, dispatchCursors[dispatchPage]],
    queryFn: () =>
      client!.dispatches({
        limit: 10,
        status: dispatchFilter || undefined,
        cursor: dispatchCursors[dispatchPage] || undefined,
      }),
    enabled: !!client,
    placeholderData: keepPreviousData,
  })

  function entityNextPage() {
    if (entities.data?.next_cursor) {
      const next = entityPage + 1
      setEntityCursors((prev) => {
        const updated = [...prev]
        updated[next] = entities.data!.next_cursor!
        return updated
      })
      setEntityPage(next)
    }
  }

  function entityPrevPage() {
    if (entityPage > 0) setEntityPage(entityPage - 1)
  }

  function dispatchNextPage() {
    if (dispatches.data?.next_cursor) {
      const next = dispatchPage + 1
      setDispatchCursors((prev) => {
        const updated = [...prev]
        updated[next] = dispatches.data!.next_cursor!
        return updated
      })
      setDispatchPage(next)
    }
  }

  function dispatchPrevPage() {
    if (dispatchPage > 0) setDispatchPage(dispatchPage - 1)
  }

  function changeDispatchFilter(f: string) {
    setDispatchFilter(f)
    setDispatchPage(0)
    setDispatchCursors([""])
  }

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
        <StatCard
          title="Entities"
          value={stats.data?.total_entities}
          icon={<GitPullRequest className="h-4 w-4 text-muted-foreground" />}
          loading={stats.isLoading}
        />
        <StatCard
          title="Total Dispatches"
          value={stats.data?.total_dispatches}
          icon={<Zap className="h-4 w-4 text-muted-foreground" />}
          loading={stats.isLoading}
        />
        <StatCard
          title="Last 24h"
          value={stats.data?.recent_24h}
          icon={<Clock className="h-4 w-4 text-muted-foreground" />}
          loading={stats.isLoading}
        />
        <StatCard
          title="Active / Failed"
          value={
            stats.data
              ? `${stats.data.status_counts.started ?? 0} / ${stats.data.status_counts.failed ?? 0}`
              : undefined
          }
          icon={<Activity className="h-4 w-4 text-muted-foreground" />}
          loading={stats.isLoading}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent entities */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent Entities</CardTitle>
            <div className="flex items-center gap-2">
              <LastUpdated
                dataUpdatedAt={entities.dataUpdatedAt}
                isFetching={entities.isFetching}
                onRefresh={() => entities.refetch()}
              />
              <Link to="/entities">
                <Button variant="ghost" size="sm">
                  View all <ChevronRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {entities.isLoading && !entities.data ? (
              <LoadingSkeleton rows={5} />
            ) : entities.error ? (
              <ErrorMsg msg={entities.error.message} />
            ) : (
              <>
                <div className="space-y-3">
                  {entities.data?.entities.map((e) => (
                    <div key={e.entity_key} className="flex items-center justify-between rounded-lg border p-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/entities/${encodeURIComponent(e.entity_key)}`}
                            className="font-mono text-sm font-medium hover:underline"
                          >
                            {e.entity_key}
                          </Link>
                          <a
                            href={entityGitHubUrl(e)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            title="Open on GitHub"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          <SessionLink
                            sessionId={e.session_id}
                            shareUrl={e.share_url}
                            cwd={e.cwd}
                            opencodeUrl={opencodeUrl}
                          />
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className="text-xs">
                            {e.kind === "pull_request" ? "PR" : "Issue"}
                          </Badge>
                          <span>{timeAgo(e.updated_at)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {entities.data?.entities.length === 0 && (
                    <p className="py-8 text-center text-sm text-muted-foreground">No entities yet</p>
                  )}
                </div>
                <Pagination
                  page={entityPage}
                  hasNext={!!entities.data?.next_cursor}
                  onPrev={entityPrevPage}
                  onNext={entityNextPage}
                />
              </>
            )}
          </CardContent>
        </Card>

        {/* Recent dispatches */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent Dispatches</CardTitle>
            <div className="flex items-center gap-2">
              <LastUpdated
                dataUpdatedAt={dispatches.dataUpdatedAt}
                isFetching={dispatches.isFetching}
                onRefresh={() => dispatches.refetch()}
              />
              <Link to="/dispatches">
                <Button variant="ghost" size="sm">
                  View all <ChevronRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </CardHeader>
          <div className="px-6 pb-2">
            <div className="flex flex-wrap gap-1">
              {["", "started", "completed", "failed", "timeout"].map((s) => (
                <Button
                  key={s}
                  variant={dispatchFilter === s ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => changeDispatchFilter(s)}
                >
                  {s || "All"}
                </Button>
              ))}
            </div>
          </div>
          <CardContent>
            {dispatches.isLoading && !dispatches.data ? (
              <LoadingSkeleton rows={5} />
            ) : dispatches.error ? (
              <ErrorMsg msg={dispatches.error.message} />
            ) : (
              <>
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
                            <Link
                              to={`/entities/${encodeURIComponent(d.entity_key)}`}
                              className="font-mono text-primary hover:underline"
                            >
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
                <Pagination
                  page={dispatchPage}
                  hasNext={!!dispatches.data?.next_cursor}
                  onPrev={dispatchPrevPage}
                  onNext={dispatchNextPage}
                />
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function StatCard({
  title,
  value,
  icon,
  loading,
}: {
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
