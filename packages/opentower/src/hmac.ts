// HMAC verification. Used for both GitHub's X-Hub-Signature-256 and
// the email worker's X-Email-Signature-256 (same scheme: prefix
// "sha256=" + hex-encoded HMAC of the raw body).

import { createHmac, timingSafeEqual } from "node:crypto"

export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  return verifySha256Signature(rawBody, signatureHeader, secret)
}

export function verifySha256Signature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false
  const hmac = createHmac("sha256", secret)
  hmac.update(rawBody)
  const expected = "sha256=" + hmac.digest("hex")
  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
