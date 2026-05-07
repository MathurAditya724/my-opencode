import { ApiClient } from "@/lib/api"
import { useMemo } from "react"
import { useServers } from "./use-servers"

export function useApiClient(): ApiClient | null {
  const { activeServer } = useServers()
  // biome-ignore lint/correctness/useExhaustiveDependencies: only recreate client when url/token change, not name
  return useMemo(
    () => (activeServer ? new ApiClient(activeServer.url, activeServer.token) : null),
    [activeServer?.url, activeServer?.token],
  )
}

export function useOpencodeUrl(): string | undefined {
  const { activeServer } = useServers()
  return activeServer?.opencodeUrl
}
