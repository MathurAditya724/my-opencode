#!/usr/bin/env bun
// CLI entry point for running opentower as a standalone server.
// Usage: opentower
//
// Requires OPENCODE_URL to be set, pointing to a running OpenCode instance.
// Configuration is read from webhooks.json (see WEBHOOKS_CONFIG env var).

import "./server"
