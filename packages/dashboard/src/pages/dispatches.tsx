import { useCallback, useState } from "react"
import { Link } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/status-badge"
import { useQuery } from "@/hooks/use-api"
import { timeAgo, formatDuration } from "@/lib/format"
import type { ApiClient, PaginatedDispatches } from "@/lib/api"
import { RefreshCw, ChevronLeft, ChevronRight } from "lucide-react"

export default function DispatchesPage() {
  const [statusFilter, setStatusFilter] = useState("")
  const [cursor, setCursor] = useState<string | undefined>()
  const [cursorStack, setCursorStack] = useState<string[]>([])

  const fetcher = useCallback(
    (c: ApiClient) => c.dispatches({ limit: 30, cursor, status: statusFilter || undefined }),
    [cursor, statusFilter],
  )
  const { data, loading, error, refetch } = useQuery<PaginatedDispatches>(fetcher, [cursor, statusFilter])

  function nextPage() {
    if (data?.next_cursor) {
      setCursorStack((s) => [...s, cursor ?? ""])
      setCursor(data.next_cursor)
    }
  }

  function prevPage() {
    const stack = [...cursorStack]
    const prev = stack.pop()
    setCursorStack(stack)
    setCursor(prev || undefined)
  }

  function changeFilter(f: string) {
    setStatusFilter(f)
    setCursor(undefined)
    setCursorStack([])
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Dispatches</h1>
        <Button variant="ghost" size="icon" onClick={refetch}>
          <RefreshCw className="h-4 w-4" />
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
          {loading && !data ? (
            <div className="space-y-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive-foreground">
              {error}
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
                        <Link to={`/entities/${encodeURIComponent(d.entity_key)}`} className="font-mono hover:underline">
                          {d.entity_key}
                        </Link>
                      )}
                      <span>Duration: {formatDuration(d.created_at, d.completed_at)}</span>
                      <span className="font-mono" title={d.id}>{d.id.slice(0, 8)}</span>
                      <span className="font-mono" title={d.delivery_id}>delivery: {d.delivery_id.slice(0, 8)}</span>
                    </div>
                  </div>
                ))}
                {data?.dispatches.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">No dispatches</p>
                )}
              </div>

              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cursorStack.length === 0}
                  onClick={prevPage}
                >
                  <ChevronLeft className="h-4 w-4" /> Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!data?.next_cursor}
                  onClick={nextPage}
                >
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
