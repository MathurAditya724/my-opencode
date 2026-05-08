import { useTheme } from "next-themes"
import { Toaster as SonnerToaster } from "sonner"

export function Toaster() {
  const { theme } = useTheme()
  return <SonnerToaster theme={theme as "light" | "dark" | "system"} richColors position="bottom-right" />
}
