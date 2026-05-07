import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const statusStyles: Record<string, string> = {
  started: "bg-[#7553ff]/10 text-[#653DE9] border-[#7553ff]/20 dark:text-[#7C83FF]",
  completed: "bg-[#26b085]/10 text-[#1d8a69] border-[#26b085]/20 dark:text-[#2CC590]",
  failed: "bg-[#f55459]/10 text-[#d12a30] border-[#f55459]/20 dark:text-[#F87C7F]",
  timeout: "bg-[#f5c342]/10 text-[#b58b00] border-[#f5c342]/20 dark:text-[#F5C342]",
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("font-mono text-xs", statusStyles[status])}>
      {status}
    </Badge>
  )
}
