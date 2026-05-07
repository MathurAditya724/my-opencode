import { Link, NavLink, Outlet } from "react-router-dom"
import { useServers } from "@/hooks/use-servers"
import { cn } from "@/lib/utils"
import { Radio, LayoutDashboard, GitPullRequest, Zap, Settings } from "lucide-react"

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/entities", label: "Entities", icon: GitPullRequest },
  { to: "/dispatches", label: "Dispatches", icon: Zap },
  { to: "/settings", label: "Servers", icon: Settings },
]

export default function Layout() {
  const { activeServer, servers } = useServers()

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <Radio className="h-5 w-5" />
            <span>OpenTower</span>
          </Link>

          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            {activeServer ? (
              <>
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span>{activeServer.name}</span>
                {servers.length > 1 && (
                  <span className="text-xs">({servers.length} servers)</span>
                )}
              </>
            ) : (
              <span>No server connected</span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4 pt-6">
        <Outlet />
      </main>
    </div>
  )
}
