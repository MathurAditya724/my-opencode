// Shared HTTP helpers for the github + email handlers.

// Upper-bound for GitHub's 25 MB webhook payload cap.
export const MAX_BODY_BYTES = 25 * 1024 * 1024

// Cap for /webhooks/email -- the JSON payload now includes email body
// content (text + HTML). Most emails are well under 256 KB but
// forwarded emails with inline content can be larger.
export const MAX_EMAIL_BODY_BYTES = 512 * 1024

// Read the request body as raw bytes with a size cap enforced both
// against the declared Content-Length and the actual buffered size
// (defends against lying clients).
export async function readBodyBytes(
  req: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; response: Response }
> {
  const declaredLength = Number(req.headers.get("content-length") ?? "0")
  if (declaredLength > maxBytes) {
    return {
      ok: false,
      response: Response.json({ error: "payload too large" }, { status: 413 }),
    }
  }
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      response: Response.json({ error: "payload too large" }, { status: 413 }),
    }
  }
  return { ok: true, bytes }
}
