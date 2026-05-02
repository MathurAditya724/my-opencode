// Shared utilities for dashboard components — formatting, icons, CSS
// class names. Pure functions, no JSX, no Hono imports.

export function timeAgo(epochMs: number): string {
  const diff = Date.now() - epochMs
  if (diff < 0) return "just now"

  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

export function formatDate(epochMs: number): string {
  const d = new Date(epochMs)
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ]
  const mon = months[d.getMonth()]
  const day = d.getDate()
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${mon} ${day}, ${hh}:${mm}`
}

export function statusIcon(status: string): string {
  switch (status) {
    case "succeeded": return "●"
    case "failed":    return "✗"
    case "timeout":   return "✗"
    case "running":   return "◐"
    case "pending":   return "…"
    case "skipped":   return "○"
    default:          return "?"
  }
}

export function statusClass(status: string): string {
  switch (status) {
    case "succeeded": return "status-succeeded"
    case "failed":    return "status-failed"
    case "timeout":   return "status-timeout"
    case "running":   return "status-running"
    case "pending":   return "status-pending"
    case "skipped":   return "status-skipped"
    default:          return ""
  }
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSec = seconds % 60
  return `${minutes}m ${remainSec}s`
}
