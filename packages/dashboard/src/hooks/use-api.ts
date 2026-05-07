import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { ApiClient } from "@/lib/api"
import { useServers } from "./use-servers"

export function useApiClient(): ApiClient | null {
  const { activeServer } = useServers()
  return useMemo(
    () => activeServer ? new ApiClient(activeServer.url, activeServer.token) : null,
    [activeServer?.url, activeServer?.token],
  )
}

export function useQuery<T>(
  fetcher: ((client: ApiClient) => Promise<T>) | null,
  deps: unknown[] = [],
) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const client = useApiClient()
  const abortRef = useRef<AbortController | null>(null)

  const refetch = useCallback(() => {
    if (!client || !fetcher) {
      setLoading(false)
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    fetcher(client)
      .then((result) => {
        if (ac.signal.aborted) return
        setData(result)
        setError(null)
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        setError(err instanceof Error ? err.message : "Unknown error")
      })
      .finally(() => {
        if (ac.signal.aborted) return
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, fetcher, ...deps])

  useEffect(() => {
    refetch()
    const id = setInterval(refetch, 30_000)
    return () => {
      clearInterval(id)
      abortRef.current?.abort()
    }
  }, [refetch])

  return { data, loading, error, refetch }
}
