// Resolve the bot's GitHub login via `gh api user --jq .login`.
// gh reads GH_TOKEN from env. Returns null on any failure.

export async function resolveBotLogin(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    const timer = setTimeout(() => proc.kill("SIGTERM"), 5_000)
    timer.unref?.()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    if (exitCode !== 0) {
      console.warn(
        `[github-webhooks] gh api user exit=${exitCode} stderr=${stderr.trim().slice(0, 200)}`,
      )
      return null
    }
    const login = stdout.trim()
    return login.length > 0 ? login : null
  } catch (err) {
    console.warn("[github-webhooks] resolveBotLogin failed:", err)
    return null
  }
}
