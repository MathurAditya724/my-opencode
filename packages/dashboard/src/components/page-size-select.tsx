import { PAGE_SIZE_OPTIONS } from "@/hooks/use-url-pagination"

export function PageSizeSelect({
  value,
  onChange,
}: {
  value: number
  onChange: (size: number) => void
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>Show</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border bg-background px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {PAGE_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
      <span>per page</span>
    </div>
  )
}
