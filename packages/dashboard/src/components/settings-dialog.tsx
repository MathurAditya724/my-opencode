import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getOpencodeUrl, setOpencodeUrl } from "@/lib/api"
import { Settings } from "lucide-react"
import { useEffect, useState } from "react"

interface SettingsDialogProps {
  collapsed?: boolean
}

export function SettingsDialog({ collapsed }: SettingsDialogProps) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    if (open) {
      setUrl(getOpencodeUrl() || "")
      setError("")
    }
  }, [open])

  function handleSave() {
    const trimmed = url.trim()
    if (trimmed && !isValidUrl(trimmed)) {
      setError("Invalid URL format. Must be http:// or https://")
      return
    }
    setOpencodeUrl(trimmed)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {collapsed ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mx-auto flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title="Settings"
        >
          <Settings className="h-4 w-4" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Settings className="h-4 w-4" />
          Settings
        </button>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure your OpenCode deployment URL for session links.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="opencode-url">OpenCode URL</Label>
            <Input
              id="opencode-url"
              type="url"
              placeholder="https://your-opencode-instance.com"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setError("")
              }}
            />
            <p className="text-xs text-muted-foreground">
              Base URL for your OpenCode instance. Session links will open in this instance.
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}
