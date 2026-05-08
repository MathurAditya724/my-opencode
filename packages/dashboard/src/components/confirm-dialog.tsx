import { Button } from "@/components/ui/button"
import { useCallback, useEffect, useRef } from "react"

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    },
    [onCancel],
  )

  useEffect(() => {
    if (!open) return
    document.addEventListener("keydown", handleKeyDown)
    cancelRef.current?.focus()
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [open, handleKeyDown])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onCancel}
        onKeyDown={() => {}}
        role="presentation"
      />
      <div className="relative z-50 w-full max-w-sm rounded-xl border bg-card p-6 shadow-lg">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  )
}
