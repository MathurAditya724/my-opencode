import { cn } from "@/lib/utils"
import { CheckCircle, X, XCircle } from "lucide-react"
import { createContext, useCallback, useContext, useState } from "react"

type Toast = {
  id: string
  message: string
  type: "success" | "error"
}

type ToastContextValue = {
  toast: (message: string, type?: "success" | "error") => void
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const toast = useCallback((message: string, type: "success" | "error" = "success") => {
    const id = crypto.randomUUID()
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3000)
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg",
              "animate-in slide-in-from-bottom-2 fade-in duration-200",
              t.type === "success"
                ? "border-[#26b085]/20 bg-[#26b085]/10 text-[#1d8a69] dark:text-[#2CC590]"
                : "border-destructive/20 bg-destructive/10 text-destructive-foreground",
            )}
          >
            {t.type === "success" ? (
              <CheckCircle className="h-4 w-4 shrink-0" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0" />
            )}
            <span className="flex-1">{t.message}</span>
            <button type="button" onClick={() => dismiss(t.id)} className="shrink-0 opacity-60 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  )
}
