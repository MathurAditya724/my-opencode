import { ErrorMsg } from "@/components/error-msg"
import { LastUpdated } from "@/components/last-updated"
import { LoadingSkeleton } from "@/components/loading-skeleton"
import { PageSizeSelect } from "@/components/page-size-select"
import { Pagination } from "@/components/pagination"
import { SessionLink } from "@/components/session-link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useApiClient, useOpencodeUrl } from "@/hooks/use-api"
import { useUrlFilter, useUrlPagination } from "@/hooks/use-url-pagination"
import type { PaginatedEntities } from "@/lib/api"
import { entityGitHubUrl, timeAgo } from "@/lib/format"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ExternalLink, Search } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

export default function EntitiesPage() {
  const client = useApiClient()
  const opencodeUrl = useOpencodeUrl()
  const { page, pageSize, cursor, setPageSize, nextPage, prevPage, resetPagination } = useUrlPagination({
    defaultPageSize: 25,
  })
  const [repoFilter, setRepoFilter] = useUrlFilter("repo")
  const [searchInput, setSearchInput] = useState(repoFilter)

  // Reset pagination when the active server changes
  const serverUrl = client?.baseUrl
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger on server change
  useEffect(() => {
    resetPagination()
  }, [serverUrl])

  useEffect(() => {
    setSearchInput(repoFilter)
  }, [repoFilter])

  const { data, isLoading, isFetching, dataUpdatedAt, error, refetch } = useQuery<PaginatedEntities>({
    queryKey: ["entities", client?.baseUrl, pageSize, cursor, repoFilter],
    queryFn: () =>
      client!.entities({
        limit: pageSize,
        cursor: cursor || undefined,
        repo: repoFilter || undefined,
      }),
    enabled: !!client,
    placeholderData: keepPreviousData,
  })

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setRepoFilter(searchInput.trim())
    resetPagination()
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Entities</h1>
        <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
      </div>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by repository (e.g. owner/repo)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        {repoFilter && (
          <button
            type="button"
            onClick={() => {
              setSearchInput("")
              setRepoFilter("")
              resetPagination()
            }}
            className="rounded-md border px-3 text-sm text-muted-foreground hover:bg-accent"
          >
            Clear
          </button>
        )}
      </form>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            Issues & Pull Requests
            {repoFilter && <span className="ml-2 text-sm font-normal text-muted-foreground">in {repoFilter}</span>}
          </CardTitle>
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
                {data?.entities.map((e) => (
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
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{e.repo}</span>
                        <span>Agent: {e.agent}</span>
                        <span>Updated {timeAgo(e.updated_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {data?.entities.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {repoFilter ? `No entities found for "${repoFilter}"` : "No entities found"}
                  </p>
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
