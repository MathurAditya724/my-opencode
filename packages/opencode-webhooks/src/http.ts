// Shared HTTP helpers for the github + email handlers.

import { lookupString } from "./template"

// Shared upper-bound sized for GitHub's 25 MB webhook payload cap.
// The email path uses a tighter cap (see MAX_EMAIL_BODY_BYTES) since
// the worker now POSTs a small JSON event, not a raw RFC822 message.
export const MAX_BODY_BYTES = 25 * 1024 * 1024

// Tighter cap for /webhooks/email — the JSON event the Cloudflare
// worker posts is well under 5 KB; 64 KB leaves slack for long
// References headers without letting a malicious client buffer
// megabytes by hitting this endpoint directly.
export const MAX_EMAIL_BODY_BYTES = 64 * 1024

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

// Values surfaced into prompt templates that the path-only renderer
// can't compute (lowercased values, etc.). Presence/non-empty checks
// are handled by `payload_filter: { path: "*" }` on the trigger
// instead. Shared between github and email handlers so a new synthetic
// lands in one place for both.
export function computeSynthetics(payload: unknown): Record<string, unknown> {
  return {
    review_state: lookupString(payload, "review.state")?.toLowerCase() ?? null,
  }
}
