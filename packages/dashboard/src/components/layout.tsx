import { useState } from "react"
import { Link, NavLink, Outlet } from "react-router-dom"
import { useServers } from "@/hooks/use-servers"
import { ApiClient } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  LayoutDashboard,
  GitPullRequest,
  Zap,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Server,
} from "lucide-react"

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/entities", label: "Entities", icon: GitPullRequest },
  { to: "/dispatches", label: "Dispatches", icon: Zap },
]

export default function Layout() {
  const { servers, activeId, setActiveId, add, update, remove } = useServers()
  const [collapsed, setCollapsed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          "sticky top-0 flex h-screen flex-col border-r bg-card transition-[width] duration-200",
          collapsed ? "w-14" : "w-64",
        )}
      >
        {/* Logo */}
        <div className="flex h-14 items-center border-b px-3">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <span className="text-xl" role="img" aria-label="outpost">🏕️</span>
            {!collapsed && <span>Outpost</span>}
          </Link>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex flex-col gap-1 p-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  collapsed && "justify-center px-2",
                )
              }
              title={collapsed ? item.label : undefined}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && item.label}
            </NavLink>
          ))}
        </nav>

        {/* Servers section */}
        <div className="mt-2 flex flex-1 flex-col overflow-hidden border-t">
          {!collapsed && (
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Servers</span>
              <button
                onClick={() => { setAdding(!adding); setEditingId(null) }}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title="Add server"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {collapsed && (
            <div className="flex justify-center py-2">
              <button
                onClick={() => { setCollapsed(false); setAdding(true) }}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title="Add server"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Add server form */}
          {adding && !collapsed && (
            <AddServerForm
              onAdd={(cfg) => { add(cfg); setAdding(false) }}
              onCancel={() => setAdding(false)}
            />
          )}

          {/* Server list */}
          <div className="flex-1 overflow-y-auto">
            {servers.map((s) =>
              editingId === s.id && !collapsed ? (
                <EditServerForm
                  key={s.id}
                  server={s}
                  onSave={(patch) => { update(s.id, patch); setEditingId(null) }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div
                  key={s.id}
                  className={cn(
                    "group flex items-center gap-2 border-l-2 px-3 py-2 transition-colors",
                    activeId === s.id
                      ? "border-l-primary bg-primary/5"
                      : "border-l-transparent hover:bg-accent/50",
                    collapsed && "justify-center px-2",
                  )}
                >
                  {collapsed ? (
                    <button
                      onClick={() => setActiveId(s.id)}
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium",
                        activeId === s.id
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground",
                      )}
                      title={s.name}
                    >
                      {s.name.charAt(0).toUpperCase()}
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => setActiveId(s.id)}
                        className="flex min-w-0 flex-1 flex-col items-start text-left"
                      >
                        <span className={cn("truncate text-sm", activeId === s.id ? "font-medium" : "text-muted-foreground")}>
                          {s.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">{new URL(s.url).hostname}</span>
                      </button>
                      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => { setEditingId(s.id); setAdding(false) }}
                          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                          title="Edit"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => remove(s.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive-foreground"
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ),
            )}
            {servers.length === 0 && !collapsed && !adding && (
              <div className="px-3 py-4 text-center">
                <Server className="mx-auto mb-1 h-5 w-5 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">No servers</p>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl p-4 pt-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

function AddServerForm({
  onAdd,
  onCancel,
}: {
  onAdd: (cfg: { name: string; url: string; token: string }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  const [testing, setTesting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    const trimmedUrl = url.replace(/\/+$/, "")
    if (!trimmedUrl || !token) {
      setError("URL and token required")
      return
    }
    let hostname: string
    try {
      hostname = new URL(trimmedUrl).hostname
    } catch {
      setError("Invalid URL")
      return
    }
    setTesting(true)
    try {
      const client = new ApiClient(trimmedUrl, token)
      const ok = await client.healthz()
      if (!ok) { setError("Unreachable"); return }
      await client.stats()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      return
    } finally {
      setTesting(false)
    }
    onAdd({ name: name || hostname, url: trimmedUrl, token })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 border-b px-3 pb-3">
      <input
        className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="Name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="https://..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        required
      />
      <input
        className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        type="password"
        placeholder="API Token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        required
      />
      {error && <p className="text-xs text-destructive-foreground">{error}</p>}
      <div className="flex gap-1">
        <button
          type="submit"
          disabled={testing}
          className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {testing ? "Testing" : "Add"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
        >
          <X className="h-3 w-3" /> Cancel
        </button>
      </div>
    </form>
  )
}

function EditServerForm({
  server,
  onSave,
  onCancel,
}: {
  server: { id: string; name: string; url: string; token: string }
  onSave: (patch: { name?: string; url?: string; token?: string }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(server.name)
  const [url, setUrl] = useState(server.url)
  const [token, setToken] = useState(server.token)
  const [error, setError] = useState("")
  const [testing, setTesting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    const trimmedUrl = url.replace(/\/+$/, "")
    if (!trimmedUrl || !token) {
      setError("URL and token required")
      return
    }
    try { new URL(trimmedUrl) } catch {
      setError("Invalid URL")
      return
    }

    const urlChanged = trimmedUrl !== server.url
    const tokenChanged = token !== server.token
    if (urlChanged || tokenChanged) {
      setTesting(true)
      try {
        const client = new ApiClient(trimmedUrl, token)
        const ok = await client.healthz()
        if (!ok) { setError("Unreachable"); return }
        await client.stats()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed")
        return
      } finally {
        setTesting(false)
      }
    }

    onSave({ name, url: trimmedUrl, token })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 border-b bg-accent/30 px-3 py-2">
      <input
        className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="https://..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        required
      />
      <input
        className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        type="password"
        placeholder="API Token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        required
      />
      {error && <p className="text-xs text-destructive-foreground">{error}</p>}
      <div className="flex gap-1">
        <button
          type="submit"
          disabled={testing}
          className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {testing ? "Testing" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
        >
          <X className="h-3 w-3" /> Cancel
        </button>
      </div>
    </form>
  )
}
