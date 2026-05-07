import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useApiClient, useOpencodeUrl } from "@/hooks/use-api"
import type { PaginatedDispatches } from "@/lib/api"
import { formatDuration, opencodeSessionUrl, timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, RefreshCw, Terminal } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

export default function DispatchesPage() {
  const client = useApiClient()
  const opencodeUrl = useOpencodeUrl()
  const [statusFilter, setStatusFilter] = useState("")
  const [page, setPage] = useState(0)
  const [cursors, setCursors] = useState<string[]>([""])

  // Reset pagination when the active server changes
  const serverUrl = client?.baseUrl
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger on server change
  useEffect(() => {
    setPage(0)
    setCursors([""])
    setStatusFilter("")
  }, [serverUrl])

  const { data, isLoading, isFetching, error, refetch } = useQuery<PaginatedDispatches>({
    queryKey: ["dispatches", client?.baseUrl, statusFilter, cursors[page]],
    queryFn: () =>
      client!.dispatches({
        limit: 30,
        cursor: cursors[page] || undefined,
        status: statusFilter || undefined,
      }),
    enabled: !!client,
    placeholderData: keepPreviousData,
  })

  function nextPage() {
    if (data?.next_cursor) {
      const next = page + 1
      setCursors((prev) => {
        const updated = [...prev]
        updated[next] = data.next_cursor!
        return updated
      })
      setPage(next)
    }
  }

  function prevPage() {
    if (page > 0) setPage(page - 1)
  }

  function changeFilter(f: string) {
    setStatusFilter(f)
    setPage(0)
    setCursors([""])
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Dispatches</h1>
        <Button variant="ghost" size="icon" onClick={() => refetch()}>
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
        </Button>
      </div>

      <div className="flex gap-1">
        {["", "started", "completed", "failed", "timeout"].map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "secondary" : "ghost"}
            size="sm"
            onClick={() => changeFilter(s)}
          >
            {s || "All"}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Event Dispatches</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && !data ? (
            <div className="space-y-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive-foreground">
              {error.message}
            </div>
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
                    <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                      {d.entity_key && (
                        <Link
                          to={`/entities/${encodeURIComponent(d.entity_key)}`}
                          className="font-mono text-primary hover:underline"
                        >
                          {d.entity_key}
                        </Link>
                      )}
                      {d.session_id?.trim() && (
                        <a
                          href={opencodeSessionUrl(d.session_id, d.share_url, opencodeUrl)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                          title="OpenCode session"
                        >
                          <Terminal className="h-3 w-3" />
                          {d.session_id.slice(0, 8)}
                        </a>
                      )}
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

              {(page > 0 || data?.next_cursor) && (
                <div className="mt-4 flex items-center justify-between">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={prevPage}>
                    <ChevronLeft className="h-4 w-4" /> Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">Page {page + 1}</span>
                  <Button variant="outline" size="sm" disabled={!data?.next_cursor} onClick={nextPage}>
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
