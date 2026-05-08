import { ConfirmDialog } from "@/components/confirm-dialog"
import { useServers } from "@/hooks/use-servers"
import { ApiClient } from "@/lib/api"
import { type ServerFormValues, serverFormSchema } from "@/lib/schemas"
import { cn } from "@/lib/utils"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  LayoutDashboard,
  Loader2,
  Menu,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Server,
  Sun,
  Trash2,
  X,
  Zap,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useCallback, useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { Link, NavLink, Outlet } from "react-router-dom"
import { toast } from "sonner"

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/entities", label: "Entities", icon: GitPullRequest },
  { to: "/dispatches", label: "Dispatches", icon: Zap },
]

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export default function Layout() {
  const { servers, activeId, setActiveId, add, update, remove } = useServers()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

  // Close mobile sidebar on route change
  const closeMobile = useCallback(() => setMobileOpen(false), [])

  // Close mobile sidebar on Escape
  useEffect(() => {
    if (!mobileOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [mobileOpen])

  const sidebar = (
    <aside
      className={cn(
        "group/sidebar relative flex h-screen flex-col bg-card transition-[width] duration-200",
        "max-md:w-64",
        !mobileOpen && (collapsed ? "w-14" : "w-64"),
        mobileOpen && "w-64",
      )}
    >
      {/* Logo */}
      <div className={cn("flex h-14 items-center border-b px-3", collapsed && !mobileOpen && "justify-center")}>
        <Link to="/" className="flex items-center gap-2 font-semibold" onClick={closeMobile}>
          <span className="text-xl" role="img" aria-label="outpost">
            🏕️
          </span>
          {(!collapsed || mobileOpen) && <span>Outpost</span>}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col gap-1 p-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            onClick={closeMobile}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                collapsed && !mobileOpen && "justify-center px-2",
              )
            }
            title={collapsed && !mobileOpen ? item.label : undefined}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {(!collapsed || mobileOpen) && item.label}
          </NavLink>
        ))}
      </nav>

      {/* Servers section */}
      <div className="mt-2 flex flex-1 flex-col overflow-hidden border-t">
        {(!collapsed || mobileOpen) && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Servers</span>
            <button
              type="button"
              onClick={() => {
                setAdding(!adding)
                setEditingId(null)
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title="Add server"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {collapsed && !mobileOpen && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              onClick={() => {
                setCollapsed(false)
                setAdding(true)
              }}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title="Add server"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Add server form */}
        {adding && (!collapsed || mobileOpen) && (
          <AddServerForm
            onAdd={(cfg) => {
              add(cfg)
              setAdding(false)
              toast.success(`Server "${cfg.name}" added`)
            }}
            onCancel={() => setAdding(false)}
          />
        )}

        {/* Server list */}
        <div className="flex-1 overflow-y-auto">
          {servers.map((s) =>
            editingId === s.id && (!collapsed || mobileOpen) ? (
              <EditServerForm
                key={s.id}
                server={s}
                onSave={(patch) => {
                  update(s.id, patch)
                  setEditingId(null)
                  toast.success(`Server "${patch.name || s.name}" updated`)
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div
                key={s.id}
                className={cn(
                  "group flex items-center gap-2 border-l-2 px-3 py-2 transition-colors",
                  activeId === s.id ? "border-l-primary bg-primary/5" : "border-l-transparent hover:bg-accent/50",
                  collapsed && !mobileOpen && "justify-center px-2",
                )}
              >
                {collapsed && !mobileOpen ? (
                  <button
                    type="button"
                    onClick={() => setActiveId(s.id)}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium",
                      activeId === s.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                    title={s.name}
                  >
                    {s.name.charAt(0).toUpperCase()}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setActiveId(s.id)}
                      className="flex min-w-0 flex-1 flex-col items-start text-left"
                    >
                      <span
                        className={cn("truncate text-sm", activeId === s.id ? "font-medium" : "text-muted-foreground")}
                      >
                        {s.name}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{safeHostname(s.url)}</span>
                    </button>
                    <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(s.id)
                          setAdding(false)
                        }}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="Edit"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget({ id: s.id, name: s.name })}
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
          {servers.length === 0 && (!collapsed || mobileOpen) && !adding && (
            <div className="px-3 py-4 text-center">
              <Server className="mx-auto mb-1 h-5 w-5 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">No servers</p>
            </div>
          )}
        </div>
      </div>

      {/* Theme toggle */}
      <div className="border-t px-3 py-2">
        <ThemeToggle collapsed={collapsed && !mobileOpen} />
      </div>

      {/* Sidebar collapse toggle - visible chevron button (desktop only) */}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={() => {
          if (!collapsed) {
            setEditingId(null)
            setAdding(false)
          }
          setCollapsed(!collapsed)
        }}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="absolute -right-3 top-[18px] z-20 hidden h-6 w-6 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:text-foreground md:flex"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
      </button>
    </aside>
  )

  return (
    <div className="flex min-h-screen bg-background">
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-40 flex h-9 w-9 items-center justify-center rounded-md border bg-card shadow-sm md:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile overlay + sidebar */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
            onClick={closeMobile}
            onKeyDown={() => {}}
            role="presentation"
          />
          <div className="fixed inset-y-0 left-0 z-50 md:hidden">{sidebar}</div>
        </>
      )}

      {/* Desktop sidebar */}
      <div className="sticky top-0 hidden h-screen md:block">{sidebar}</div>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl p-4 pt-14 md:pt-6">
          <Outlet />
        </div>
      </main>

      {/* Confirm dialog for server deletion */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove server"
        description={`Are you sure you want to remove "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Remove"
        onConfirm={() => {
          if (deleteTarget) {
            remove(deleteTarget.id)
            toast.success(`Server "${deleteTarget.name}" removed`)
            setDeleteTarget(null)
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

const inputClass =
  "w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"

function AddServerForm({
  onAdd,
  onCancel,
}: {
  onAdd: (cfg: { name: string; url: string; token: string; opencodeUrl?: string }) => void
  onCancel: () => void
}) {
  const [serverError, setServerError] = useState("")
  const [testing, setTesting] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ServerFormValues>({
    resolver: zodResolver(serverFormSchema),
    defaultValues: { name: "", url: "", token: "", opencodeUrl: "" },
  })

  async function onSubmit(data: ServerFormValues) {
    setServerError("")
    const parsed = serverFormSchema.parse(data)

    let hostname: string
    try {
      hostname = new URL(parsed.url).hostname
    } catch {
      setServerError("Invalid URL")
      return
    }

    setTesting(true)
    try {
      const client = new ApiClient(parsed.url, parsed.token)
      const ok = await client.healthz()
      if (!ok) {
        setServerError("Unreachable")
        return
      }
      await client.stats()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Failed")
      return
    } finally {
      setTesting(false)
    }

    onAdd({
      name: parsed.name || hostname,
      url: parsed.url,
      token: parsed.token,
      opencodeUrl: parsed.opencodeUrl,
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 border-b px-3 pb-3">
      <div>
        <input className={inputClass} placeholder="Name (optional)" {...register("name")} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>
      <div>
        <input className={inputClass} placeholder="https://opentower.example.com" {...register("url")} />
        {errors.url && <p className="text-xs text-destructive">{errors.url.message}</p>}
      </div>
      <div>
        <input className={inputClass} type="password" placeholder="API Token" {...register("token")} />
        {errors.token && <p className="text-xs text-destructive">{errors.token.message}</p>}
      </div>
      <div>
        <input className={inputClass} placeholder="OpenCode URL (optional)" {...register("opencodeUrl")} />
        {errors.opencodeUrl && <p className="text-xs text-destructive">{errors.opencodeUrl.message}</p>}
      </div>
      {serverError && <p className="text-xs text-destructive">{serverError}</p>}
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
  server: { id: string; name: string; url: string; token: string; opencodeUrl?: string }
  onSave: (patch: { name?: string; url?: string; token?: string; opencodeUrl?: string }) => void
  onCancel: () => void
}) {
  const [serverError, setServerError] = useState("")
  const [testing, setTesting] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ServerFormValues>({
    resolver: zodResolver(serverFormSchema),
    defaultValues: {
      name: server.name,
      url: server.url,
      token: server.token,
      opencodeUrl: server.opencodeUrl ?? "",
    },
  })

  async function onSubmit(data: ServerFormValues) {
    setServerError("")
    const parsed = serverFormSchema.parse(data)

    const urlChanged = parsed.url !== server.url
    const tokenChanged = parsed.token !== server.token
    if (urlChanged || tokenChanged) {
      setTesting(true)
      try {
        const client = new ApiClient(parsed.url, parsed.token)
        const ok = await client.healthz()
        if (!ok) {
          setServerError("Unreachable")
          return
        }
        await client.stats()
      } catch (err) {
        setServerError(err instanceof Error ? err.message : "Failed")
        return
      } finally {
        setTesting(false)
      }
    }

    onSave({
      name: parsed.name,
      url: parsed.url,
      token: parsed.token,
      opencodeUrl: parsed.opencodeUrl,
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 border-b bg-accent/30 px-3 py-2">
      <div>
        <input className={inputClass} placeholder="Name" {...register("name")} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>
      <div>
        <input className={inputClass} placeholder="https://..." {...register("url")} />
        {errors.url && <p className="text-xs text-destructive">{errors.url.message}</p>}
      </div>
      <div>
        <input className={inputClass} type="password" placeholder="API Token" {...register("token")} />
        {errors.token && <p className="text-xs text-destructive">{errors.token.message}</p>}
      </div>
      <div>
        <input className={inputClass} placeholder="OpenCode URL (optional)" {...register("opencodeUrl")} />
        {errors.opencodeUrl && <p className="text-xs text-destructive">{errors.opencodeUrl.message}</p>}
      </div>
      {serverError && <p className="text-xs text-destructive">{serverError}</p>}
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

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme()

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => {
          if (theme === "dark") setTheme("light")
          else if (theme === "light") setTheme("system")
          else setTheme("dark")
        }}
        className="mx-auto flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        title={`Theme: ${theme}`}
      >
        {theme === "dark" ? (
          <Moon className="h-4 w-4" />
        ) : theme === "light" ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Monitor className="h-4 w-4" />
        )}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1 rounded-md border p-0.5">
      {[
        { value: "light", icon: Sun, label: "Light" },
        { value: "dark", icon: Moon, label: "Dark" },
        { value: "system", icon: Monitor, label: "System" },
      ].map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs",
            theme === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          title={label}
        >
          <Icon className="h-3 w-3" />
          {label}
        </button>
      ))}
    </div>
  )
}
