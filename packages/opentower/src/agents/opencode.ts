// OpencodeAgent factory. Creates an AgentClient backed by either:
//   - A plugin-provided client (when running as an OpenCode plugin)
//   - A standalone SDK client (when running as a standalone server)
//
// In both cases the returned object satisfies the AgentClient interface.

import type { AgentClient } from "../interfaces"

export type OpencodeAgentOptions = {
  // Provide a pre-existing client (plugin mode — ctx.client).
  client?: AgentClient

  // Connect to a running OpenCode instance at this URL (standalone mode).
  baseUrl?: string

  // Working directory passed to the SDK client factory.
  directory?: string
}

export async function createOpencodeAgent(opts: OpencodeAgentOptions): Promise<AgentClient> {
  if (opts.client) {
    return opts.client
  }

  if (!opts.baseUrl) {
    throw new Error(
      "OpencodeAgent requires either a plugin client or a baseUrl. " +
        "Set OPENCODE_URL to point to a running OpenCode instance.",
    )
  }

  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  const client = createOpencodeClient({
    baseUrl: opts.baseUrl,
    ...(opts.directory ? { directory: opts.directory } : {}),
  })

  return client as AgentClient
}
