// HMAC verification for GitHub webhook X-Hub-Signature-256.

import { createHmac, timingSafeEqual } from "node:crypto"

export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex")
  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
