import { useCallback, useState } from "react"
import { Link } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useQuery } from "@/hooks/use-api"
import { timeAgo, entityGitHubUrl } from "@/lib/format"
import type { ApiClient, PaginatedEntities } from "@/lib/api"
import { ExternalLink, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react"

export default function EntitiesPage() {
  const [cursor, setCursor] = useState<string | undefined>()
  const [cursorStack, setCursorStack] = useState<string[]>([])

  const fetcher = useCallback(
    (c: ApiClient) => c.entities({ limit: 25, cursor }),
    [cursor],
  )
  const { data, loading, error, refetch } = useQuery<PaginatedEntities>(fetcher, [cursor])

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Entities</h1>
        <Button variant="ghost" size="icon" onClick={refetch}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Issues & Pull Requests</CardTitle>
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
                {data?.entities.map((e) => {
                  const ghUrl = entityGitHubUrl(e)
                  return (
                    <div key={e.entity_key} className="flex items-center justify-between rounded-lg border p-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/entities/${encodeURIComponent(e.entity_key)}`}
                            className="font-mono text-sm font-medium hover:underline"
                          >
                            {e.entity_key}
                          </Link>
                          <Badge variant="outline" className="text-xs">
                            {e.kind === "pull_request" ? "PR" : "Issue"}
                          </Badge>
                          <a href={ghUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                          <span>{e.repo}</span>
                          <span>Agent: {e.agent}</span>
                          <span>Updated {timeAgo(e.updated_at)}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {data?.entities.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">No entities found</p>
                )}
              </div>

              {/* Pagination */}
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
