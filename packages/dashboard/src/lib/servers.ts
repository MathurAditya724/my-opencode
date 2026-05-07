const STORAGE_KEY = "opentower-servers"

export type ServerConfig = {
  id: string
  name: string
  url: string
  token: string
}

export function loadServers(): ServerConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as ServerConfig[]
  } catch {
    return []
  }
}

export function saveServers(servers: ServerConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers))
}
