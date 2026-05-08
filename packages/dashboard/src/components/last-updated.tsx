import { cn } from "@/lib/utils"
import { RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"

export function LastUpdated({
  dataUpdatedAt,
  isFetching,
  onRefresh,
}: {
  dataUpdatedAt: number
  isFetching: boolean
  onRefresh: () => void
}) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(interval)
  }, [])

  const ago = dataUpdatedAt ? formatSecondsAgo(Date.now() - dataUpdatedAt) : null

  return (
    <button
      type="button"
      onClick={onRefresh}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      title="Click to refresh"
    >
      <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
      {ago && <span>Updated {ago}</span>}
    </button>
  )
}

function formatSecondsAgo(ms: number): string {
  if (ms < 5_000) return "just now"
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  return `${Math.floor(ms / 60_000)}m ago`
}
