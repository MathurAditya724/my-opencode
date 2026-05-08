import { ErrorMsg } from "@/components/error-msg"
import { LastUpdated } from "@/components/last-updated"
import { SessionLink, SessionLinkPrimary } from "@/components/session-link"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useApiClient, useOpencodeUrl } from "@/hooks/use-api"
import type { EntityDetail } from "@/lib/api"
import { entityGitHubUrl, formatDuration, timeAgo } from "@/lib/format"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ArrowLeft, ExternalLink, Link as LinkIcon } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"

export default function EntityDetailPage() {
  const { key } = useParams<{ key: string }>()
  const navigate = useNavigate()
  const client = useApiClient()
  const opencodeUrl = useOpencodeUrl()
  const decodedKey = decodeURIComponent(key ?? "")

  const { data, isLoading, isFetching, dataUpdatedAt, error, refetch } = useQuery<EntityDetail>({
    queryKey: ["entity", client?.baseUrl, decodedKey],
    queryFn: () => client!.entity(decodedKey),
    enabled: !!client && !!decodedKey,
    placeholderData: keepPreviousData,
  })

  if (!decodedKey) return <p>Invalid entity key</p>

  const githubUrl = data ? entityGitHubUrl(data.entity) : null

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="font-mono text-xl font-bold">{decodedKey}</h1>
        </div>
        <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
      </div>

      {isLoading && !data ? (
        <div className="space-y-4">
          <div className="h-32 animate-pulse rounded-xl bg-muted" />
          <div className="h-64 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : error ? (
        <ErrorMsg msg={error.message} />
      ) : data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Entity Info</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Type</dt>
                  <dd>
                    <Badge variant="outline">{data.entity.kind === "pull_request" ? "Pull Request" : "Issue"}</Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Repository</dt>
                  <dd className="font-mono text-sm">{data.entity.repo}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Agent</dt>
                  <dd className="text-sm">{data.entity.agent}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Session</dt>
                  <dd>
                    {data.entity.session_id?.trim() ? (
                      <SessionLinkPrimary
                        sessionId={data.entity.session_id}
                        shareUrl={data.entity.share_url}
                        cwd={data.entity.cwd}
                        opencodeUrl={opencodeUrl}
                      />
                    ) : (
                      <span className="text-sm text-muted-foreground">N/A</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Created</dt>
                  <dd className="text-sm">{timeAgo(data.entity.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="text-sm">{timeAgo(data.entity.updated_at)}</dd>
                </div>
                {githubUrl && (
                  <div>
                    <dt className="text-xs text-muted-foreground">GitHub</dt>
                    <dd>
                      <a
                        href={githubUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        Open <ExternalLink className="h-3 w-3" />
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          {data.links.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <LinkIcon className="h-4 w-4" /> Linked Entities
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {data.links.map((link) => {
                    const other = link.source_key === decodedKey ? link.target_key : link.source_key
                    return (
                      <div key={`${link.source_key}-${link.target_key}`} className="flex items-center gap-2 text-sm">
                        <Badge variant="outline" className="text-xs">
                          {link.relation}
                        </Badge>
                        <Link to={`/entities/${encodeURIComponent(other)}`} className="font-mono hover:underline">
                          {other}
                        </Link>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Dispatch Timeline ({data.dispatches.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {data.dispatches.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No dispatches</p>
              ) : (
                <div className="relative space-y-0">
                  {data.dispatches.map((d, i) => (
                    <div key={d.id} className="relative flex gap-4 pb-6">
                      {i < data.dispatches.length - 1 && (
                        <div className="absolute bottom-0 left-[11px] top-6 w-px bg-border" />
                      )}
                      <div className="relative z-10 mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full border-2 border-border bg-background" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm">{d.trigger_name}</span>
                          <StatusBadge status={d.status} />
                          <span className="text-xs text-muted-foreground">{d.event}</span>
                          <SessionLink
                            sessionId={d.session_id}
                            shareUrl={d.share_url}
                            cwd={d.cwd}
                            opencodeUrl={opencodeUrl}
                            showLabel
                          />
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                          <span>{timeAgo(d.created_at)}</span>
                          <span>Duration: {formatDuration(d.created_at, d.completed_at)}</span>
                          <span className="font-mono" title={d.id}>
                            {d.id.slice(0, 8)}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}
