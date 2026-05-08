import { Button } from "@/components/ui/button"
import { ChevronLeft, ChevronRight } from "lucide-react"

export function Pagination({
  page,
  hasNext,
  onPrev,
  onNext,
}: {
  page: number
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
}) {
  if (page === 0 && !hasNext) return null
  return (
    <div className="mt-4 flex items-center justify-between">
      <Button variant="outline" size="sm" disabled={page === 0} onClick={onPrev}>
        <ChevronLeft className="h-4 w-4" /> Prev
      </Button>
      <span className="text-xs text-muted-foreground">Page {page + 1}</span>
      <Button variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>
        Next <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}
