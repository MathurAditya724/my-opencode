// Standalone server entry point for opentower.
// Runs without the OpenCode plugin host -- connects to a running
// OpenCode instance via OPENCODE_URL using the @opencode-ai/sdk.
//
// Usage:
//   OPENCODE_URL=http://localhost:4096 opentower
//   # or
//   bun run packages/opentower/src/server.ts

import * as Sentry from "@sentry/bun"
import { createOpencodeAgent } from "./agents/opencode"
import { bootstrap, gracefulShutdown } from "./bootstrap"

async function main() {
  console.log("[opentower] starting standalone server...")

  if (typeof Bun === "undefined") {
    throw new Error("opentower requires Bun (uses Bun.serve, Bun.spawn, Bun.file). Install Bun >=1.2.0: https://bun.sh")
  }

  const sentryDsn = process.env.SENTRY_DSN ?? ""
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      sendDefaultPii: true,
      enableLogs: true,
      tracesSampleRate: (() => {
        const rate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
        return Number.isFinite(rate) ? rate : 0.1
      })(),
    })
    console.log("[opentower] Sentry initialized (logs + traces enabled)")
  }

  process.on("unhandledRejection", (err) => {
    console.error("[opentower] unhandledRejection:", err)
    Sentry.captureException(err)
  })

  const opencodeUrl = process.env.OPENCODE_URL
  if (!opencodeUrl) {
    throw new Error(
      "OPENCODE_URL is required in standalone mode. Set it to the URL of a running OpenCode instance (e.g. http://localhost:4096).",
    )
  }

  const defaultCwd = process.env.DEFAULT_CWD ?? process.cwd()
  const client = await createOpencodeAgent({ baseUrl: opencodeUrl, directory: defaultCwd })
  console.log(`[opentower] connected to OpenCode at ${opencodeUrl}`)

  const result = await bootstrap({ client, defaultCwd })

  let stopping = false
  const onShutdown = async (sig: NodeJS.Signals) => {
    if (stopping) return
    stopping = true
    await gracefulShutdown(result, sig)
    process.exit(0)
  }
  process.once("SIGTERM", () => void onShutdown("SIGTERM"))
  process.once("SIGINT", () => void onShutdown("SIGINT"))
}

main().catch((err) => {
  console.error("[opentower] FATAL:", err)
  process.exit(1)
})
