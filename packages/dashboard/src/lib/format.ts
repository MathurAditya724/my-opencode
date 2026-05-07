function parseUTC(iso: string): number {
  return new Date(/[Zz+\-]/.test(iso.slice(-6)) ? iso : `${iso}Z`).getTime()
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

/**
 * Base64url-encode without padding, matching the OpenCode SPA's
 * `base64Encode` from `@opencode-ai/core/util/encode`.
 * Handles UTF-8 correctly via TextEncoder.
 */
function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/**
 * Return the best available URL for viewing an OpenCode session.
 * Prefers the public share URL (from auto-share) when available.
 * Falls back to constructing a URL that matches the OpenCode web UI
 * route structure: /{base64url(directory)}/session/{sessionId}.
 * Returns null when both shareUrl and directory are missing.
 */
export function opencodeSessionUrl(
  sessionId: string,
  shareUrl: string | null | undefined,
  directory: string | null | undefined,
  opencodeUrl?: string,
): string | null {
  if (shareUrl) return shareUrl
  if (!directory) return null
  const dir = base64UrlEncode(directory)
  const base = opencodeUrl?.replace(/\/+$/, "")
  const path = `/${dir}/session/${encodeURIComponent(sessionId)}`
  return base ? `${base}${path}` : path
}
