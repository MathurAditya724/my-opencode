// Thin wrapper around `gh api <path>` via Bun.spawn. Mirrors the
// pattern in bot-identity.ts: subprocess, 5s timeout, returns parsed
// JSON or null on any failure. gh handles auth (GH_TOKEN) and base URL.

export async function ghApi<T = unknown>(
  path: string,
  timeoutMs = 5_000,
): Promise<T | null> {
  try {
    let timedOut = false
    const proc = Bun.spawn(["gh", "api", path], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
    }, timeoutMs)
    timer.unref?.()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    if (timedOut) {
      console.warn(`[opencode-webhooks] gh api ${path} timed out after ${timeoutMs}ms`)
      return null
    }
    if (exitCode !== 0) {
      console.warn(
        `[opencode-webhooks] gh api ${path} exit=${exitCode} stderr=${stderr.trim().slice(0, 200)}`,
      )
      return null
    }
    return JSON.parse(stdout) as T
  } catch (err) {
    console.warn(`[opencode-webhooks] gh api ${path} failed:`, err)
    return null
  }
}
