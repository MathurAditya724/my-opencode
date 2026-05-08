import { useCallback, useState } from "react"
import { useSearchParams } from "react-router-dom"

export function useUrlPagination(opts?: { defaultPageSize?: number }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [cursors, setCursors] = useState<string[]>([""])

  const page = Number(searchParams.get("page") ?? "0")
  const pageSize = Number(searchParams.get("pageSize") ?? String(opts?.defaultPageSize ?? 25))

  const setPage = useCallback(
    (p: number) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (p === 0) next.delete("page")
        else next.set("page", String(p))
        return next
      })
    },
    [setSearchParams],
  )

  const setPageSize = useCallback(
    (size: number) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set("pageSize", String(size))
        next.delete("page")
        return next
      })
      setCursors([""])
    },
    [setSearchParams],
  )

  const nextPage = useCallback(
    (cursor: string) => {
      const next = page + 1
      setCursors((prev) => {
        const updated = [...prev]
        updated[next] = cursor
        return updated
      })
      setPage(next)
    },
    [page, setPage],
  )

  const prevPage = useCallback(() => {
    if (page > 0) setPage(page - 1)
  }, [page, setPage])

  const resetPagination = useCallback(() => {
    setPage(0)
    setCursors([""])
  }, [setPage])

  const cursor = cursors[page] || ""

  return { page, pageSize, cursor, setPageSize, nextPage, prevPage, resetPagination }
}

export function useUrlFilter(key: string) {
  const [searchParams, setSearchParams] = useSearchParams()
  const value = searchParams.get(key) ?? ""

  const setValue = useCallback(
    (v: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (!v) next.delete(key)
        else next.set(key, v)
        next.delete("page")
        return next
      })
    },
    [key, setSearchParams],
  )

  return [value, setValue] as const
}

export const PAGE_SIZE_OPTIONS = [10, 25, 50] as const
