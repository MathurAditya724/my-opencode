<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Architecture

<!-- lore:019e006b-b47c-7996-ba96-965e47b5a28e -->
* **OpenTower session affinity: entity key derived from payload, not sender**: Session affinity (same OpenCode session reused for all events on a given issue/PR) is keyed by \`owner/repo#N\`, extracted from \`payload.issue.number\`, \`payload.pull\_request.number\`, \`payload.check\_suite.pull\_requests\[0].number\`, etc. Push and email events return \`null\` entity key → fire-and-forget dispatch. For a third-party agent creating issues, including \`issue.number\` and \`repository.full\_name\` in its webhook payload is sufficient to get session affinity. \`linked\_issues\` (Fixes/Closes/Resolves #N in PR body) are persisted as SQLite links to connect PR sessions back to their issue sessions.

<!-- lore:019e006b-b461-7fdd-8d83-6b13cfdf34a3 -->
* **OpenTower webhook integration: two endpoints, two HMAC secrets**: OpenTower exposes three ingest endpoints: \`POST /webhooks/github\` (header \`X-Hub-Signature-256\`, secret from \`webhooks.json\` \`secret\` field or \`GITHUB\_WEBHOOK\_SECRET\` env), \`POST /webhooks/email\` (header \`X-Email-Signature-256\`, secret from \`email\_secret\` field or \`EMAIL\_WEBHOOK\_SECRET\` env), and \`POST /webhooks/junior\` (header \`X-Junior-Signature-256\`, secret from dedicated config or env). All three use HMAC-SHA256 with \`sha256=\<hex>\` prefix via the shared \`verifySha256Signature\` function, verified against raw bytes before JSON parsing. Body limits: 25 MB for GitHub, 512 KB for email. Missing secret → 503; bad signature → 401. Junior signs payload with \`openssl dgst\` on the client side.

### Pattern

<!-- lore:019e006b-b46e-766f-9745-049ede688ed4 -->
* **OpenTower custom agent integration: use /webhooks/github with standard GitHub payload shape**: OpenTower now has a dedicated \`/webhooks/junior\` endpoint for Junior agent integration (handler: \`packages/opentower/src/handlers/junior.ts\`), with its own trigger type distinct from GitHub webhooks. Junior POSTs with header \`X-Junior-Signature-256: sha256=\<hmac>\` (signed via \`openssl dgst\`). Payload must include \`repository.full\_name\` and optionally \`issue.number\`/\`pull\_request.number\` for session affinity \[\[019e006b-b47c-7996-ba96-965e47b5a28e]]. The \`/webhooks/github\` endpoint remains the generic path for other custom agents following the GitHub payload shape.
<!-- End lore-managed section -->
