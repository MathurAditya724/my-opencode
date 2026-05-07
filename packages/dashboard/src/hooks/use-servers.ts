import { type ServerConfig, loadServers, saveServers } from "@/lib/servers"
import { useCallback, useMemo, useSyncExternalStore } from "react"

const ACTIVE_KEY = "opentower-active-server"

let listeners: Array<() => void> = []
let cachedServers: ServerConfig[] = loadServers()
let cachedActiveId: string | null = (() => {
  const stored = localStorage.getItem(ACTIVE_KEY)
  const all = cachedServers
  if (stored && all.some((s) => s.id === stored)) return stored
  return all.length > 0 ? all[0].id : null
})()

function emitChange() {
  cachedServers = loadServers()
  for (const listener of listeners) listener()
}

function setActiveIdStore(id: string | null) {
  cachedActiveId = id
  if (id) localStorage.setItem(ACTIVE_KEY, id)
  else localStorage.removeItem(ACTIVE_KEY)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener]
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

function getServersSnapshot(): ServerConfig[] {
  return cachedServers
}

function getActiveIdSnapshot(): string | null {
  return cachedActiveId
}

export function useServers() {
  const servers = useSyncExternalStore(subscribe, getServersSnapshot, getServersSnapshot)
  const activeId = useSyncExternalStore(subscribe, getActiveIdSnapshot, getActiveIdSnapshot)

  const activeServer = useMemo(() => servers.find((s) => s.id === activeId) ?? null, [servers, activeId])

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdStore(id)
  }, [])

  const add = useCallback((server: Omit<ServerConfig, "id">) => {
    const all = loadServers()
    const entry: ServerConfig = { ...server, id: crypto.randomUUID() }
    all.push(entry)
    saveServers(all)
    emitChange()
    if (!cachedActiveId) setActiveIdStore(entry.id)
    return entry
  }, [])

  const update = useCallback((id: string, patch: Partial<Omit<ServerConfig, "id">>) => {
    const all = loadServers().map((s) => (s.id === id ? { ...s, ...patch } : s))
    saveServers(all)
    emitChange()
  }, [])

  const remove = useCallback((id: string) => {
    const all = loadServers().filter((s) => s.id !== id)
    saveServers(all)
    emitChange()
    if (cachedActiveId === id) {
      setActiveIdStore(all.length > 0 ? all[0].id : null)
    }
  }, [])

  return { servers, activeServer, activeId, setActiveId, add, update, remove }
}
