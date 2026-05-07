import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useServers } from "@/hooks/use-servers"
import { ApiClient } from "@/lib/api"
import { type ServerFormValues, serverFormSchema } from "@/lib/schemas"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { useNavigate } from "react-router-dom"

export default function SetupPage() {
  const { add } = useServers()
  const navigate = useNavigate()
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
        setServerError("Could not reach the server. Check the URL.")
        return
      }
      await client.stats()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Connection failed")
      return
    } finally {
      setTesting(false)
    }

    add({
      name: parsed.name || hostname,
      url: parsed.url,
      token: parsed.token,
      opencodeUrl: parsed.opencodeUrl,
    })
    navigate("/")
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <span className="text-2xl" role="img" aria-label="outpost">
              🏕️
            </span>
          </div>
          <CardTitle className="text-2xl">Outpost Dashboard</CardTitle>
          <CardDescription>Connect to an Outpost server to view events, dispatches, and sessions.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name (optional)</Label>
              <Input id="name" placeholder="Production, Staging..." {...register("name")} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="url">Server URL</Label>
              <Input id="url" placeholder="https://your-server.example.com" {...register("url")} />
              {errors.url && <p className="text-xs text-destructive">{errors.url.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="token">API Token</Label>
              <Input id="token" type="password" placeholder="API Token" {...register("token")} />
              {errors.token && <p className="text-xs text-destructive">{errors.token.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="opencodeUrl">OpenCode URL (optional)</Label>
              <Input id="opencodeUrl" placeholder="https://your-opencode.example.com" {...register("opencodeUrl")} />
              {errors.opencodeUrl && <p className="text-xs text-destructive">{errors.opencodeUrl.message}</p>}
              <p className="text-xs text-muted-foreground">
                Base URL of your OpenCode web UI for viewing sessions. If omitted, session links will use relative
                paths.
              </p>
            </div>
            {serverError && <p className="text-sm text-destructive">{serverError}</p>}
            <Button type="submit" className="w-full" disabled={testing}>
              {testing && <Loader2 className="animate-spin" />}
              {testing ? "Testing connection..." : "Connect"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
