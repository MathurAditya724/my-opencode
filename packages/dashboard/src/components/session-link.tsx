import { opencodeSessionUrl } from "@/lib/format"
import { ExternalLink, Terminal } from "lucide-react"

export function SessionLink({
  sessionId,
  shareUrl,
  cwd,
  opencodeUrl,
  showLabel,
}: {
  sessionId: string | null | undefined
  shareUrl: string | null | undefined
  cwd: string | null | undefined
  opencodeUrl?: string
  showLabel?: boolean
}) {
  if (!sessionId?.trim()) return null
  const url = opencodeSessionUrl(sessionId, shareUrl, cwd, opencodeUrl)
  if (!url) return null

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      title="OpenCode session"
    >
      <Terminal className="h-3 w-3" />
      {showLabel && <span className="text-xs">session</span>}
    </a>
  )
}

export function SessionLinkPrimary({
  sessionId,
  shareUrl,
  cwd,
  opencodeUrl,
}: {
  sessionId: string
  shareUrl: string | null | undefined
  cwd: string | null | undefined
  opencodeUrl?: string
}) {
  const url = opencodeSessionUrl(sessionId, shareUrl, cwd, opencodeUrl)
  if (!url) return <span className="text-sm text-muted-foreground">N/A</span>
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:underline"
      title={sessionId}
    >
      {sessionId.slice(0, 8)}... <ExternalLink className="h-3 w-3" />
    </a>
  )
}
