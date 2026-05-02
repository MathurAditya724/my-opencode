<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Architecture

<!-- lore:019ddf82-a57d-74e2-92f1-e4b42484708b -->
* **Bundled agents copied to ~/.config/opencode/agents at image build time**: Single unified \`github-agent.md\` (Opus 4.6, \`mode: primary\`) is COPYed to \`/home/developer/.config/opencode/agents/\` at build time. It triages events and \*\*spawns sub-agents\*\* via the \`task\` tool for heavy lifting — it does not do everything inline. Situation-specific skills (\`repo-setup\`, \`resolve-issue\`, \`review-pr\`, \`fix-ci\`, \`respond-to-comment\`, \`apply-fixes\`) are concise reference cards; utility skills (\`deslop\`, \`review\`, \`pr\`) are loaded on demand. Agent name passed to \`runOpencode\` must match filename without \`.md\`. Skills are minimal — trust Opus 4.6 to figure out the how.

<!-- lore:019ddb97-585b-74f2-9ab1-adc4c03f338b -->
* **docker-entrypoint.sh skills bootstrap pattern**: Skills are baked into the image via Dockerfile \`COPY skills/ /home/developer/.config/opencode/skills/\` — no \`npx skills add\` calls at runtime. \`docker-entrypoint.sh\` does NOT run any skills bootstrap or cron scheduler; it only: chowns the dev volume if root-owned, inits git, configures \`gh auth setup-git\` + git user identity from \`gh api user\`, then \`exec opencode web\`. The webhook plugin (opencode-webhooks) loads in-process — there is no sidecar process.

<!-- lore:019dea44-ae1a-7a61-8caf-eba2ae67b078 -->
* **Email pipeline: dumb pipe, agent decides — no identity resolution**: Email pipeline is a dumb pipe — no identity resolution. The Cloudflare worker sends full email content (headers + body\_text + body\_html); the plugin handler does only: HMAC verify, dedup by \`message\_id\`, dispatch to agent. The agent decides what to do. The \`email/\` module (identity.ts, synthesize.ts, github-api.ts, allowlist.ts) was deleted. Email events return \`null\` entity key in \`entity.ts\` → fire-and-forget dispatch (no session affinity). \`MAX\_EMAIL\_BODY\_BYTES\` is 512 KB. Cloudflare worker: unconditionally forward via \`message.forward(FORWARD\_TO)\` (wrapped in try/catch), check \`ALLOWED\_SENDERS\`, parse MIME body, POST HMAC-signed JSON to \`WEBHOOK\_URL\`. \`EMAIL\_WEBHOOK\_SECRET\` via \`wrangler secret put\`; runtime vars not in wrangler.json.

<!-- lore:019de760-ce6c-7e8b-bef6-e06b2b3c0c53 -->
* **Entity-keyed session affinity pipeline with idle cleanup and semaphore-gated follow-ups**: \*\*Entity-keyed session affinity pipeline\*\* (\`pipeline.ts\`): entity key (\`owner/repo#N\`) maps to a \`SessionEntry\` in an in-memory Map. New event → no session: \`createAndPrompt\` acquires semaphore, creates session, sends prompt. Session busy: event queued (stays \`pending\`). Session idle: \`followUp\` sends batched follow-up. Critical invariants: (1) idle timer (10 min) calls \`cleanup()\` → deletes Map entry + calls \`drainCounter.end()\` exactly once — prevents memory leak and drain hang; (2) ALL termination paths go through \`cleanup()\`; (3) inner async impl named \`fireAndForget\` (not \`dispatchNoAffinity\`) to avoid recursive method shadowing causing stack overflow.

<!-- lore:019ddb97-583c-7303-8d84-01bb358bcc86 -->
* **OpenCode skills loaded from filesystem, not from opencode.json**: Skills are discovered from filesystem paths (\`~/.config/opencode/skills/\<name>/SKILL.md\` globally, \`.opencode/skills/\<name>/SKILL.md\` project-locally). The \`opencode.json\` config only controls \`permission.skill.\*\` entries to allow/deny/ask per skill name pattern. There is no \`skills\` declaration in the config file itself.

<!-- lore:019de4e6-2747-7fcd-a14c-2f2f2ef3bb5b -->
* **opencode-config-package.json vs opencode-user-config.json: producer/consumer split**: \`opencode-config-package.json\` (→ \`~/.config/opencode/package.json\`) is a dependency manifest — \`bun install\` fetches packages into \`node\_modules/\` but nothing loads automatically. \`opencode-user-config.json\` (→ \`~/.config/opencode/opencode.json\`) is OpenCode's config; its \`plugin: \[...]\` array is what actually triggers plugin loading at startup. Both files are required today because packages use \`file:\` deps (not published to npm). Once published, both could be dropped in favor of bare names in \`opencode.json\` and OpenCode's runtime auto-install. Keeping both enables build-time install (reproducible image, no cold-boot network call).

<!-- lore:019de4f1-1f2b-7e9f-8ee0-61ace7c64d95 -->
* **opencode-webhooks plugin: zero npm runtime deps, raw TS, no build step**: \`packages/opencode-webhooks/src/\` ships raw \`.ts\` files with no build step. Runtime dependencies: \`hono ^4.0.0\` and \`@sentry/bun ^9.0.0\`. Dev deps: \`@opencode-ai/plugin\`, \`@types/bun\`, \`typescript\`. Uses Bun built-ins (\`Bun.serve\`, \`Bun.spawn\`, \`Bun.file\`, \`bun:sqlite\`) and Node built-ins (\`node:crypto\`, \`node:os\`, \`node:fs\`, \`node:path\`). \`exports\` points to \`./src/index.ts\` — Bun loads TS natively at runtime.

<!-- lore:019de5eb-d81e-7bf8-b924-30fe9b7552b7 -->
* **opencode-webhooks Sentry integration: init at plugin boot, DSN from env**: Sentry init in \`index.ts\` inside the plugin's try/catch block, gated on \`SENTRY\_DSN\`. Critical gotcha: if plugin crashes before Sentry init (e.g. during config load or DB migration), errors won't be captured. \`tracesSampleRate\` defaults to 0.5 (override via \`SENTRY\_TRACES\_SAMPLE\_RATE\` env, 0.0–1.0). \`sendDefaultPii: true\`. After resolving bot identity, \`Sentry.setTag('bot.login', botLogin)\` tags all events. \`Sentry.close(2000)\` on SIGTERM/SIGINT. \`process.on('unhandledRejection')\` captures escaping errors (guarded by \`\_\_ghWebhookGuard\` to prevent duplicate registration). To capture startup errors, Sentry should ideally be initialized before config/DB work.

<!-- lore:019ddf9b-acf0-76f3-8a33-44a1d0d48fb4 -->
* **Plugin dependencies: package.json at ~/.config/opencode/ (not inside plugins/)**: OpenCode runs \`bun install\` at startup using a \`package.json\` at the config directory root (\`~/.config/opencode/package.json\`), not inside the \`plugins/\` subdirectory. Placing \`package.json\` inside \`plugins/\` will not resolve imports. In the image, \`opencode-config-package.json\` in the repo is COPYed to \`~/.config/opencode/package.json\` at build time.

<!-- lore:019de755-23d5-7637-832d-d9230ea8fa42 -->
* **Plugin removes require\_bot\_match and payload\_filter; agent handles triage**: The \`require\_bot\_match\` and \`payload\_filter\` fields were removed from the \`Trigger\` type in \`types.ts\`. Identity gating (e.g. fire only when bot is assigned) and payload shape gating (e.g. skip empty review bodies, skip issue\_comment on non-PRs) are now handled by the agent in its pre-flight triage step. The plugin only handles: HMAC verification, dedup, \`ignore\_authors\` self-loop guard, prompt rendering, and dispatch. This avoids duplicating business logic between plugin config and agent instructions.

<!-- lore:019ddfd8-298f-79db-b305-68d5c5082d7e -->
* **webhooks.json baked into image, env-var overridable**: \`webhooks.json\` at repo root is COPYed to \`~/.config/opencode/webhooks.json\` in the Dockerfile. Contains 3 triggers: github-event (issues/pull\_request/check\_suite)→github-agent; github-comment (pull\_request\_review\_comment/issue\_comment/pull\_request\_review, with ignore\_authors)→github-agent; email-event (email.\*, with ignore\_authors)→github-agent. Override via \`WEBHOOKS\_CONFIG\` env var. \`$BOT\_LOGIN\` in the file is a literal substituted at config-load time from \`gh api user\`, not an env var.

### Gotcha

<!-- lore:019ddb97-5851-7c8e-9718-837e8ef95e99 -->
* **BYK/dotskills files are OpenCode commands, not installable skills**: BYK/dotskills flat \`.md\` files use OpenCode command frontmatter (\`description\` + \`agent: build|plan\`), not the Agent Skills spec. Running \`npx skills add BYK/dotskills\` returns 'No valid skills found'. To use them as skills requires converting each to \`\<name>/SKILL.md\` with proper \`name\`+\`description\` frontmatter in a subdirectory.

<!-- lore:019ddb97-387d-7086-babf-1a0fd6cc2978 -->
* **GitHub CLI auth lost on server restart — symlink to persistent volume**: gh CLI auth is lost on Railway redeploy because it stores tokens in ~/.config/gh/ on the ephemeral rootfs. sentry-cli survives because it reads SENTRY\_AUTH\_TOKEN from env vars on every invocation. Two fixes: (1) \*\*Recommended\*\*: set GH\_TOKEN as a Railway env var (PAT with repo/workflow/read:org scopes) — gh auto-detects it, no disk state needed, matches sentry-cli pattern. (2) Symlink approach: in docker-entrypoint.sh, run \`mkdir -p ~/.config/gh ~/dev/.gh-config\` then \`ln -sfn ~/dev/.gh-config/$f ~/.config/gh/$f\` for hosts.yml and config.yml. Use \`GH\_TOKEN\` not \`GITHUB\_TOKEN\` — Railway/Actions can override the latter.

<!-- lore:019de571-09ff-7714-8333-015078d0fb10 -->
* **HMAC over JSON: plugin must verify raw bytes, not re-serialized JSON**: When the email worker HMAC-signs a JSON body, the plugin must verify against the exact bytes received (\`req.text()\` before \`JSON.parse\`), not a re-serialized version. \`JSON.stringify\` key ordering is insertion-order-stable in JS/V8 but not spec-guaranteed cross-runtime. Re-serializing will produce matching output today but is fragile. Pattern: \`const raw = await req.text(); verify(raw); const payload = JSON.parse(raw)\`.

<!-- lore:019de986-40ab-7482-8ba4-5cfd8fdfb493 -->
* **Hono JSX dashboard files require jsx/jsxImportSource in tsconfig**: Dashboard \`.tsx\` files crash with \`Error: No renderer found\` when plugin runs from \`node\_modules\` on Railway. Bun's built-in \`createElement\` (\`/$bunfs/root/src/index.js\`) is used instead of Hono's — \`@jsxImportSource\` pragma is ignored at that load path. \*\*Fix\*\*: convert all dashboard files from \`.tsx\` to \`.ts\` using \`hono/html\` tagged template literals and \`raw()\` for unescaped CSS. No \`createElement\`, no renderer, no pragma needed. Also ensure renamed files are actually committed — the fix is useless if the \`.tsx\`→\`.ts\` conversion is only staged locally but never pushed; Railway will still deploy the old \`.tsx\` files from the last commit.

<!-- lore:019ddf88-31c5-7c9c-83b2-30b2e84407cc -->
* **Hono middleware ordering: \`use('/')\` matches POST routes registered after it**: Plugin uses Hono for routing. \`handler.ts\` exports \`createApp()\` returning \`Hono\<AppEnv>\`. \`app.onError\` captures unhandled throws to Sentry. \`app.use('\*')\` wraps requests in \`Sentry.withIsolationScope\` + \`Sentry.startSpan\`. Deps injected via \`app.use('/webhooks/\*')\` only (healthz excluded). Routes: \`GET /healthz\`, \`POST /webhooks/github\`, \`POST /webhooks/email\`. Handler files export plain \`(c: Context\<AppEnv>) => Promise\<Response>\`. The \`email/\` subdirectory was deleted — email is a dumb pipe (HMAC verify + dedup + dispatch only).

<!-- lore:019de755-23d2-7199-b3cb-52211d0a70ad -->
* **ignore\_authors on broad github trigger blocks bot's own PR/issue events**: If \`ignore\_authors: \["$BOT\_LOGIN"]\` is placed on a trigger that also matches \`issues\` and \`pull\_request\` events, it will block the bot from self-reviewing its own PRs or being triggered when assigned an issue. Only apply \`ignore\_authors\` on triggers for comment events (pull\_request\_review\_comment, issue\_comment, pull\_request\_review) where self-loops are actually a risk. The bundled \`webhooks.json\` splits these into separate triggers for this reason.

<!-- lore:019de571-09ed-7a93-80a1-2bdb76b811d3 -->
* **message.forward() failure blocks entire email pipeline if not caught**: In a Cloudflare Email Worker, if \`message.forward()\` throws (e.g. unverified destination), the worker throws and CF retries the entire email — blocking all webhook dispatch until fixed. Always wrap \`message.forward()\` in try/catch and log the error, then continue to the POST. Otherwise a misconfigured \`FORWARD\_TO\` silently kills the whole pipeline.

<!-- lore:019de9d7-f743-7103-b241-5c650d5bd5fd -->
* **opencode-webhooks loads once per project/worktree — EADDRINUSE on shared port**: OpenCode loads plugins once per project/worktree in the same process. When multiple projects are open simultaneously (e.g. Railway volume with many repos), the plugin tries \`Bun.serve\` on port 5050 for each — only the first succeeds, rest crash with \`EADDRINUSE\`. Fix: guard with \`globalThis.\_\_webhookServerStarted\` flag. First invocation sets it and starts server; subsequent ones return early. Reset flag to \`false\` in catch block so a failed startup can be retried. Pattern already used for \`\_\_ghWebhookGuard\` (unhandledRejection dedup) in \`index.ts\`.

<!-- lore:019ddf9b-acec-7435-ac05-5e06fb4359bb -->
* **opencode.json \`experimental\` key rejects unknown subkeys (additionalProperties: false)**: The published OpenCode config JSON schema defines \`experimental\` with \`additionalProperties: false\`. Adding a custom key like \`experimental.webhook\` will fail strict schema validation in editors. Workaround: store plugin-specific config in a separate file (e.g. \`~/.config/opencode/webhooks.json\`) read directly via \`Bun.file().json()\`, or drop the \`$schema\` reference from \`opencode.json\` to silence editor errors. Do NOT put custom plugin config under \`experimental\` expecting schema tolerance.

<!-- lore:019dea57-bfa1-7859-bd64-ffd3b24764ad -->
* **outcome column always NULL — setOutcome() never called**: \`dispatches.outcome\` is always NULL in practice. \`storage.ts\` defines \`setOutcome(dispatchId, outcome)\` and the column exists, but nothing in \`pipeline.ts\` or any handler ever calls it. \`status='succeeded'\` only means \`session.prompt()\` resolved without throwing — the pipeline has no mechanism to capture what the agent actually decided or produced. The field was designed for agent-reported outcomes (e.g. 'SKIPPED', PR URL) but the write-back integration was never implemented.

<!-- lore:019de984-4bcd-7f21-acb9-384550d3fb3c -->
* **Railway PORT env causes OpenCode/webhook port conflict**: Railway sets \`PORT\` env var and routes all external traffic to it. OpenCode runs on whatever port Railway assigns (e.g. 8080 via \`PORT\`). The webhook plugin binds separately to its own port (default 5050 via \`WEBHOOK\_PORT\`). If the plugin crashes on startup (e.g. JSX config missing), its port disappears from Railway's service view while OpenCode's port remains. \`EXPOSE\` in Dockerfile is documentation only — Railway ignores it.

<!-- lore:019de9d7-f749-71aa-ad94-bc9caaea687c -->
* **SQLite schema migration required when deliveries table lacks external\_id column**: If the persistent SQLite DB was created by an older plugin version, it won't have the \`external\_id\` column. \`storage.ts:openDeliveryStore()\` crashes with \`SQLiteError: table deliveries has no column named external\_id\`, killing all plugin instances. Migration code in \`storage.ts\` adds the column when missing — ensure it runs before \`insertStmt\` is prepared. Secondary symptom: dashboard returns 500 while \`/healthz\` returns 200, indicating partial migration or column mismatch between dashboard queries and actual schema.

### Pattern

<!-- lore:019de622-bdfa-7267-9101-3c11dceb04e1 -->
* **Dispatch errors reported to Sentry with trigger/delivery tags via withScope**: Dispatch errors reported to Sentry with trigger/delivery tags via \`withScope\`. In \`pipeline.ts\`, both the affinity path (\`createAndPrompt\`/\`followUp\`) and the fire-and-forget path (\`fireAndForget\`) wrap \`Sentry.captureException(err)\` in \`Sentry.withScope()\` to attach \`trigger.name\`, \`trigger.event\`, \`delivery.id\`, and \`entity.key\` scoped only to that error event. Pattern: \`Sentry.withScope(scope => { scope.setTag(...); Sentry.captureException(err) })\`. Note: \`dispatch.ts\` was deleted; the pattern now lives exclusively in \`pipeline.ts\`.
<!-- End lore-managed section -->
