import { SettingsDialog } from "@/components/settings-dialog"
import { emitTokenChange } from "@/hooks/use-api"
import { clearToken } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  GitPullRequest,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Sun,
  Zap,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useCallback, useEffect, useState } from "react"
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom"

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/entities", label: "Entities", icon: GitPullRequest },
  { to: "/dispatches", label: "Dispatches", icon: Zap },
  { to: "/cron", label: "Cron Jobs", icon: Clock },
]

export default function Layout() {
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  const closeMobile = useCallback(() => setMobileOpen(false), [])

  useEffect(() => {
    if (!mobileOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [mobileOpen])

  function handleLogout() {
    clearToken()
    emitTokenChange()
    navigate("/setup")
  }

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
      <nav className="flex flex-1 flex-col gap-1 p-2">
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

      {/* Theme toggle, settings & logout */}
      <div className="border-t px-3 py-2 space-y-2">
        <ThemeToggle collapsed={collapsed && !mobileOpen} />
        <SettingsDialog collapsed={collapsed && !mobileOpen} />
        {collapsed && !mobileOpen ? (
          <button
            type="button"
            onClick={handleLogout}
            className="mx-auto flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <LogOut className="h-4 w-4" />
            Logout
          </button>
        )}
      </div>

      {/* Sidebar collapse toggle */}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={() => setCollapsed(!collapsed)}
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
    </div>
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
