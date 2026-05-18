// GitHub App authentication: JWT generation and installation token management.
//
// GitHub Apps authenticate via a two-step process:
//   1. Sign a short-lived JWT with the app's private key (RS256).
//   2. Exchange the JWT for an installation access token scoped to
//      a specific org/repo installation.
//
// Installation tokens are cached and refreshed before expiry.

import { createSign } from "node:crypto"

const GITHUB_API = "https://api.github.com"

// JWT lifetime: 10 minutes (GitHub max).
const JWT_EXPIRY_SECONDS = 600

// Refresh installation tokens when they have less than 10 minutes left.
const TOKEN_REFRESH_THRESHOLD_MS = 10 * 60 * 1000

type CachedToken = {
  token: string
  expiresAt: number
}

export type GitHubAppAuth = {
  getInstallationToken(installationId: number): Promise<string>
  getAppSlug(): Promise<string>
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input
  return buf.toString("base64url")
}

function generateJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "RS256", typ: "JWT" }
  const payload = {
    iat: now - 60, // 60s clock skew allowance
    exp: now + JWT_EXPIRY_SECONDS,
    iss: appId,
  }

  const headerB64 = base64url(JSON.stringify(header))
  const payloadB64 = base64url(JSON.stringify(payload))
  const unsigned = `${headerB64}.${payloadB64}`

  const signer = createSign("RSA-SHA256")
  signer.update(unsigned)
  signer.end()
  const signature = signer.sign(privateKey, "base64url")

  return `${unsigned}.${signature}`
}

export function createGitHubAppAuth(appId: string, privateKey: string): GitHubAppAuth {
  const tokenCache = new Map<number, CachedToken>()
  let cachedAppSlug: string | null = null

  async function getInstallationToken(installationId: number): Promise<string> {
    const cached = tokenCache.get(installationId)
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_THRESHOLD_MS) {
      return cached.token
    }

    const jwt = generateJWT(appId, privateKey)
    const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to get installation token (HTTP ${response.status}): ${body}`)
    }

    const data = (await response.json()) as { token: string; expires_at: string }
    const expiresAt = new Date(data.expires_at).getTime()
    tokenCache.set(installationId, { token: data.token, expiresAt })
    return data.token
  }

  async function getAppSlug(): Promise<string> {
    if (cachedAppSlug) return cachedAppSlug

    const jwt = generateJWT(appId, privateKey)
    const response = await fetch(`${GITHUB_API}/app`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to get app info (HTTP ${response.status}): ${body}`)
    }

    const data = (await response.json()) as { slug: string }
    cachedAppSlug = data.slug
    return data.slug
  }

  return { getInstallationToken, getAppSlug }
}
