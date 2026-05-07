function parseUTC(iso: string): number {
  return new Date(/[Zz+\-]/.test(iso.slice(-6)) ? iso : iso + "Z").getTime()
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - parseUTC(iso)
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function formatDuration(start: string, end: string | null): string {
  if (!end) return "running..."
  const ms = parseUTC(end) - parseUTC(start)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

export function entityGitHubUrl(entity: { repo: string; number: number; kind: string }): string {
  const type = entity.kind === "pull_request" ? "pull" : "issues"
  return `https://github.com/${entity.repo}/${type}/${entity.number}`
}
