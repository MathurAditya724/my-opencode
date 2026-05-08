import { ErrorMsg } from "@/components/error-msg"
import { LastUpdated } from "@/components/last-updated"
import { LoadingSkeleton } from "@/components/loading-skeleton"
import { PageSizeSelect } from "@/components/page-size-select"
import { Pagination } from "@/components/pagination"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useApiClient, useOpencodeUrl } from "@/hooks/use-api"
import { useUrlFilter, useUrlPagination } from "@/hooks/use-url-pagination"
import type { PaginatedDispatches } from "@/lib/api"
import { formatDuration, opencodeSessionUrl, timeAgo } from "@/lib/format"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Search, Terminal } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

export default function DispatchesPage() {
  const client = useApiClient()
  const opencodeUrl = useOpencodeUrl()
  const { page, pageSize, cursor, setPageSize, nextPage, prevPage, resetPagination } = useUrlPagination({
    defaultPageSize: 25,
  })
  const [statusFilter, setStatusFilter] = useUrlFilter("status")
  const [eventFilter, setEventFilter] = useUrlFilter("event")
  const [eventInput, setEventInput] = useState(eventFilter)

  const serverUrl = client?.baseUrl
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger on server change
  useEffect(() => {
    resetPagination()
  }, [serverUrl])

  useEffect(() => {
    setEventInput(eventFilter)
  }, [eventFilter])

  const { data, isLoading, isFetching, dataUpdatedAt, error, refetch } = useQuery<PaginatedDispatches>({
    queryKey: ["dispatches", client?.baseUrl, pageSize, statusFilter, eventFilter, cursor],
    queryFn: () =>
      client!.dispatches({
        limit: pageSize,
        cursor: cursor || undefined,
        status: statusFilter || undefined,
        event: eventFilter || undefined,
      }),
    enabled: !!client,
    placeholderData: keepPreviousData,
  })

  function handleEventSearch(e: React.FormEvent) {
    e.preventDefault()
    setEventFilter(eventInput.trim())
    resetPagination()
  }

  function changeStatusFilter(f: string) {
    setStatusFilter(f)
    resetPagination()
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Dispatches</h1>
        <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Status filter */}
        <div className="flex flex-wrap gap-1">
          {["", "started", "completed", "failed", "timeout"].map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "secondary" : "ghost"}
              size="sm"
              onClick={() => changeStatusFilter(s)}
            >
              {s || "All"}
            </Button>
          ))}
        </div>

        {/* Event filter */}
        <form onSubmit={handleEventSearch} className="flex gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter by event"
              value={eventInput}
              onChange={(e) => setEventInput(e.target.value)}
              className="h-8 w-48 pl-9 text-xs"
            />
          </div>
          {eventFilter && (
            <button
              type="button"
              onClick={() => {
                setEventInput("")
                setEventFilter("")
                resetPagination()
              }}
              className="rounded-md border px-2 text-xs text-muted-foreground hover:bg-accent"
            >
              Clear
            </button>
          )}
        </form>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Event Dispatches</CardTitle>
          <PageSizeSelect value={pageSize} onChange={setPageSize} />
        </CardHeader>
        <CardContent>
          {isLoading && !data ? (
            <LoadingSkeleton rows={10} />
          ) : error ? (
            <ErrorMsg msg={error.message} />
          ) : (
            <>
              <div className="space-y-2">
                {data?.dispatches.map((d) => (
                  <div key={d.id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{d.trigger_name}</span>
                        <StatusBadge status={d.status} />
                        <span className="text-xs text-muted-foreground">{d.event}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{timeAgo(d.created_at)}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      {d.entity_key && (
                        <Link
                          to={`/entities/${encodeURIComponent(d.entity_key)}`}
                          className="font-mono text-primary hover:underline"
                        >
                          {d.entity_key}
                        </Link>
                      )}
                      {(() => {
                        const sid = d.session_id?.trim()
                        const url = sid ? opencodeSessionUrl(sid, d.share_url, d.cwd, opencodeUrl) : null
                        return url && sid ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                            title="OpenCode session"
                          >
                            <Terminal className="h-3 w-3" />
                            {sid.slice(0, 8)}
                          </a>
                        ) : null
                      })()}
                      <span>Duration: {formatDuration(d.created_at, d.completed_at)}</span>
                      <span className="font-mono" title={d.id}>
                        {d.id.slice(0, 8)}
                      </span>
                      <span className="font-mono" title={d.delivery_id}>
                        delivery: {d.delivery_id.slice(0, 8)}
                      </span>
                    </div>
                  </div>
                ))}
                {data?.dispatches.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">No dispatches</p>
                )}
              </div>

              <Pagination
                page={page}
                hasNext={!!data?.next_cursor}
                onPrev={prevPage}
                onNext={() => data?.next_cursor && nextPage(data.next_cursor)}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
