// Minimal RFC822/5322 header parser. We deliberately do NOT touch the
// message body — only headers reach the LLM (via synthesize.ts), and the
// canonical state is fetched from the GitHub API. This keeps the parser
// tiny and removes any prompt-injection surface from email content.

export type EmailHeaders = {
  // Lowercase header name → values (multi-valued for Received etc.).
  get(name: string): string | undefined
  getAll(name: string): string[]
}

export function parseHeaders(raw: string): EmailHeaders {
  // Header block ends at the first blank line. Accept both CRLF and LF.
  const headerEnd = findHeaderEnd(raw)
  const headerBlock = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw

  // Unfold continuation lines: any line starting with whitespace is a
  // continuation of the previous header (RFC 5322 §2.2.3).
  const unfolded: string[] = []
  for (const line of headerBlock.split(/\r?\n/)) {
    if (line.length === 0) continue
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.replace(/^[ \t]+/, "")
    } else {
      unfolded.push(line)
    }
  }

  const map = new Map<string, string[]>()
  for (const line of unfolded) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    const arr = map.get(name)
    if (arr) arr.push(value)
    else map.set(name, [value])
  }

  return {
    get(name) {
      return map.get(name.toLowerCase())?.[0]
    },
    getAll(name) {
      return map.get(name.toLowerCase()) ?? []
    },
  }
}

function findHeaderEnd(raw: string): number {
  const crlf = raw.indexOf("\r\n\r\n")
  if (crlf >= 0) return crlf
  const lf = raw.indexOf("\n\n")
  return lf
}
