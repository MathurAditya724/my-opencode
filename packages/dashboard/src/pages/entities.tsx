import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useApiClient, useOpencodeUrl } from "@/hooks/use-api"
import type { PaginatedEntities } from "@/lib/api"
import { entityGitHubUrl, opencodeSessionUrl, timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Terminal } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

export default function EntitiesPage() {
  const client = useApiClient()
  const opencodeUrl = useOpencodeUrl()
  const [page, setPage] = useState(0)
  const [cursors, setCursors] = useState<string[]>([""])

  // Reset pagination when the active server changes
  const serverUrl = client?.baseUrl
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger on server change
  useEffect(() => {
    setPage(0)
    setCursors([""])
  }, [serverUrl])

  const { data, isLoading, isFetching, error, refetch } = useQuery<PaginatedEntities>({
    queryKey: ["entities", client?.baseUrl, cursors[page]],
    queryFn: () => client!.entities({ limit: 25, cursor: cursors[page] || undefined }),
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Entities</h1>
        <Button variant="ghost" size="icon" onClick={() => refetch()}>
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Issues & Pull Requests</CardTitle>
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
                          <a
                            href={ghUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            title="Open on GitHub"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          {(() => {
                            const url = e.session_id?.trim()
                              ? opencodeSessionUrl(e.session_id, e.share_url, e.cwd, opencodeUrl)
                              : null
                            return url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-muted-foreground hover:text-foreground"
                                title="OpenCode session"
                              >
                                <Terminal className="h-3 w-3" />
                              </a>
                            ) : null
                          })()}
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
