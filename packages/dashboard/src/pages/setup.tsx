import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useServers } from "@/hooks/use-servers"
import { ApiClient } from "@/lib/api"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"

export default function SetupPage() {
	const { add } = useServers()
	const navigate = useNavigate()
	const [name, setName] = useState("")
	const [url, setUrl] = useState("")
	const [token, setToken] = useState("")
	const [opencodeUrl, setOpencodeUrl] = useState("")
	const [error, setError] = useState("")
	const [testing, setTesting] = useState(false)

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		setError("")

		const trimmedUrl = url.replace(/\/+$/, "")
		if (!trimmedUrl) {
			setError("URL is required")
			return
		}
		if (!token) {
			setError("Token is required")
			return
		}

		let hostname: string
		try {
			hostname = new URL(trimmedUrl).hostname
		} catch {
			setError("Invalid URL")
			return
		}

		const trimmedOpencodeUrl = opencodeUrl.replace(/\/+$/, "")
		if (trimmedOpencodeUrl) {
			try {
				new URL(trimmedOpencodeUrl)
			} catch {
				setError("Invalid OpenCode URL")
				return
			}
		}

		setTesting(true)
		try {
			const client = new ApiClient(trimmedUrl, token)
			const ok = await client.healthz()
			if (!ok) {
				setError("Could not reach the server. Check the URL.")
				return
			}
			await client.stats()
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Connection failed"
			setError(msg)
			return
		} finally {
			setTesting(false)
		}

		add({ name: name || hostname, url: trimmedUrl, token, opencodeUrl: trimmedOpencodeUrl || undefined })
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
					<CardDescription>
						Connect to an Outpost server to view events, dispatches, and sessions.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="name">Name (optional)</Label>
							<Input
								id="name"
								placeholder="Production, Staging..."
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="url">Server URL</Label>
							<Input
								id="url"
								placeholder="https://your-server.example.com"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="token">API Token</Label>
							<Input
								id="token"
								type="password"
								placeholder="API Token"
								value={token}
								onChange={(e) => setToken(e.target.value)}
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="opencodeUrl">OpenCode URL (optional)</Label>
							<Input
								id="opencodeUrl"
								placeholder="https://your-opencode.example.com"
								value={opencodeUrl}
								onChange={(e) => setOpencodeUrl(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								Base URL of your OpenCode web UI for viewing sessions. If omitted, session links
								will use relative paths.
							</p>
						</div>
						{error && <p className="text-sm text-destructive">{error}</p>}
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
