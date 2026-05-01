// Shared HTTP helpers for the github + email handlers.

import { lookupString } from "./template"

// GitHub's webhook payload cap. Same value bounds the email path so
// the listener never buffers an arbitrarily large RFC822 message.
export const MAX_BODY_BYTES = 25 * 1024 * 1024

// Read the request body as raw bytes with a size cap enforced both
// against the declared Content-Length and the actual buffered size
// (defends against lying clients).
export async function readBodyBytes(
  req: Request,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; response: Response }
> {
  const declaredLength = Number(req.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: Response.json({ error: "payload too large" }, { status: 413 }),
    }
  }
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) {
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
