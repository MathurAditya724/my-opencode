import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useServers } from "@/hooks/use-servers"
import { ApiClient } from "@/lib/api"
import { Plus, Trash2, Loader2, Check, Server } from "lucide-react"

export default function SettingsPage() {
  const { servers, activeId, setActiveId, add, remove } = useServers()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  const [testing, setTesting] = useState(false)

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    const trimmedUrl = url.replace(/\/+$/, "")
    if (!trimmedUrl || !token) {
      setError("URL and token are required")
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
      if (!ok) {
        setError("Could not reach the server")
        return
      }
      await client.stats()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed")
      return
    } finally {
      setTesting(false)
    }

    add({ name: name || hostname, url: trimmedUrl, token })
    setName("")
    setUrl("")
    setToken("")
    setAdding(false)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Servers</h1>
        <Button size="sm" onClick={() => setAdding(!adding)}>
          <Plus className="h-4 w-4" /> Add Server
        </Button>
      </div>

      {adding && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add Server</CardTitle>
            <CardDescription>Connect to a new OpenTower instance.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="add-name">Name (optional)</Label>
                <Input id="add-name" placeholder="Production" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-url">Server URL</Label>
                <Input id="add-url" placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-token">API Token</Label>
                <Input id="add-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
              </div>
              {error && <p className="text-sm text-destructive-foreground">{error}</p>}
              <div className="flex gap-2">
                <Button type="submit" disabled={testing}>
                  {testing && <Loader2 className="animate-spin" />}
                  {testing ? "Testing..." : "Connect"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {servers.length === 0 && !adding ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Server className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No servers configured. Add one to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {servers.map((s) => (
            <Card key={s.id} className={activeId === s.id ? "ring-2 ring-primary" : ""}>
              <CardContent className="flex items-center justify-between p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    {activeId === s.id && <Check className="h-4 w-4 text-primary" />}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">{s.url}</p>
                </div>
                <div className="flex gap-2">
                  {activeId !== s.id && (
                    <Button variant="outline" size="sm" onClick={() => setActiveId(s.id)}>
                      Select
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="text-destructive-foreground" onClick={() => remove(s.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
