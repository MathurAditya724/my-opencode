<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Architecture

<!-- lore:019ddf82-a57d-74e2-92f1-e4b42484708b -->
* **Bundled agents copied to ~/.config/opencode/agents at image build time**: Single unified \`github-agent.md\` (Opus 4.6, \`mode: primary\`) is COPYed at build time. Triages events and executes work directly by loading skills (no sub-agent delegation). Loads \`repo-setup\` first (git worktrees for isolation), then the situation skill. Agent name passed to \`runOpencode\` must match filename without \`.md\`. Skills are minimal — trust Opus 4.6 to figure out the how. \`docker-entrypoint.sh\`: chowns dev volume, inits git, configures \`gh auth setup-git\` + git identity from \`gh api user\`, then \`exec opencode web\`. The webhook plugin loads in-process — no sidecar. Skills baked via \`COPY skills/ ~/.config/opencode/skills/\` — no runtime bootstrap.

<!-- lore:019dea44-ae1a-7a61-8caf-eba2ae67b078 -->
* **Email pipeline: dumb pipe, agent decides — no identity resolution**: Email pipeline is a dumb pipe — no identity resolution. Plugin does: HMAC verify, dedup by \`message\_id\`, fire-and-forget dispatch (entity\_key=null). Email→PR disconnect is intentional: email session is isolated; PRs created from it get their own entity-keyed session from the first \`pull\_request\` webhook. \`MAX\_EMAIL\_BODY\_BYTES\` is 512 KB. Cloudflare worker: wrap \`message.forward(FORWARD\_TO)\` in try/catch (uncaught throw blocks entire pipeline via CF retry), check \`ALLOWED\_SENDERS\`, parse MIME body, POST HMAC-signed JSON to \`WEBHOOK\_URL\`. \`EMAIL\_WEBHOOK\_SECRET\` via \`wrangler secret put\`.

<!-- lore:019de760-ce6c-7e8b-bef6-e06b2b3c0c53 -->
* **Entity-keyed session affinity pipeline with idle cleanup and semaphore-gated follow-ups**: \*\*Entity-keyed session affinity pipeline\*\* (\`pipeline.ts\`): entity key (\`owner/repo#N\`) maps to \`SessionEntry\` in an in-memory Map. New event → no session: \`createAndPrompt\` acquires semaphore, creates session, sends prompt. Session busy: event queued. Session idle: \`followUp\` batches queue (5s window). Critical invariants: (1) idle timer (10 min) calls \`cleanup()\` → deletes Map entry + \`drainCounter.end()\` exactly once; (2) ALL termination paths go through \`cleanup()\`; (3) on error, queued events are salvaged via \`fireAndForget\` instead of discarded — prevents silent event loss; (4) abort timer starts AFTER \`semaphore.acquire()\` so time waiting for a concurrency slot does not count against the dispatch timeout.

<!-- lore:019debfe-9334-7c0d-8d81-b6358b8c8632 -->
* **GET /metrics endpoint: in-memory pipeline observability, not persistent**: \`GET /metrics\` on the webhook plugin returns JSON with \`counters\`, \`gauges\` (\`sessions.active\`, \`queue.depth\`), \`timings\` (\`dispatch.duration\_ms\`), and \`tagged\` counters keyed by trigger name + event type. Tracks: \`dispatch.started/completed/failed\`, \`dispatch.followup\`, \`dispatch.fire\_and\_forget\`, \`dispatch.queued\`. All in-memory — resets on container restart. Designed for Prometheus \`json\_exporter\` scraping or manual \`curl\` debugging. No scraper is wired up by default. Not a persistent audit log — use the SQLite \`dispatches\` table for that.

<!-- lore:019df4a1-5db7-7ef5-a20f-a73019ab6248 -->
* **Git worktree isolation in repo-setup skill: per-branch directories**: Git worktree isolation in repo-setup skill: per-branch directories: Main clone stays at \`~/dev/\<owner>/\<repo>\`; each branch gets an isolated worktree at \`~/dev/\<owner>/\<repo>-wt/\<branch>\`. New issue → \`git worktree add -b \<branch> origin/$DEFAULT\_BRANCH\`. Existing PR → fetch branch then \`git worktree add\`. Never \`git reset --hard\` or \`git clean\` in the main clone — other worktrees share its object store. Cleanup after push: \`git worktree remove --force\`. Sessions for entity-keyed dispatches anchor to \`~/dev/\<owner>/\<repo>\` (derived from \`entityKey.repo\`) via \`sessionCwd()\` in \`pipeline.ts\` with priority: \`trigger.cwd\` > per-repo path > \`defaultCwd\`. Fire-and-forget dispatches fall back to \`defaultCwd\`.

<!-- lore:019ddb97-583c-7303-8d84-01bb358bcc86 -->
* **OpenCode skills loaded from filesystem, not from opencode.json**: Skills are discovered from filesystem paths (\`~/.config/opencode/skills/\<name>/SKILL.md\` globally, \`.opencode/skills/\<name>/SKILL.md\` project-locally). The \`opencode.json\` config only controls \`permission.skill.\*\` entries to allow/deny/ask per skill name pattern. There is no \`skills\` declaration in the config file itself.

<!-- lore:019de4e6-2747-7fcd-a14c-2f2f2ef3bb5b -->
* **opencode-config-package.json vs opencode-user-config.json: producer/consumer split**: \`opencode-config-package.json\` (→ \`~/.config/opencode/package.json\`) is a dependency manifest for \`bun install\` — packages go into \`node\_modules/\` but nothing loads automatically. \`opencode-user-config.json\` (→ \`~/.config/opencode/opencode.json\`) is OpenCode's config; its \`plugin: \[...]\` array triggers plugin loading at startup. Both required because packages use \`file:\` deps. Build-time \`bun install\` gives a reproducible image with no cold-boot network call. Note: \`package.json\` must be at \`~/.config/opencode/\` root, not inside \`plugins/\` — wrong location silently breaks import resolution.

<!-- lore:019de4f1-1f2b-7e9f-8ee0-61ace7c64d95 -->
* **opencode-webhooks plugin: zero npm runtime deps, raw TS, no build step**: \`packages/opentower/src/\` (renamed from \`packages/opentower/\`, formerly \`opencode-webhooks\`/\`openhealer\`) ships raw \`.ts\` files with no build step. Runtime dependencies: \`hono ^4.0.0\` and \`@sentry/bun ^9.0.0\`. Dev deps: \`@opencode-ai/plugin\`, \`@types/bun\`, \`typescript\`. Uses Bun built-ins (\`Bun.serve\`, \`Bun.spawn\`, \`Bun.file\`, \`bun:sqlite\`) and Node built-ins (\`node:crypto\`, \`node:os\`, \`node:fs\`, \`node:path\`). \`exports\` points to \`./src/index.ts\` — Bun loads TS natively at runtime.

<!-- lore:019de5eb-d81e-7bf8-b924-30fe9b7552b7 -->
* **opencode-webhooks Sentry integration: init at plugin boot, DSN from env**: Sentry init in \`index.ts\` inside the plugin's try/catch, gated on \`SENTRY\_DSN\`. Critical: if plugin crashes before init (config load or DB migration), errors won't be captured — ideally init before config/DB work. \`tracesSampleRate\` defaults to 0.5 (override via \`SENTRY\_TRACES\_SAMPLE\_RATE\`). After resolving bot identity, \`Sentry.setTag('bot.login', botLogin)\`. \`Sentry.close(2000)\` on SIGTERM/SIGINT. \`process.on('unhandledRejection')\` guarded by \`\_\_ghWebhookGuard\` to prevent duplicate registration.

<!-- lore:019de755-23d5-7637-832d-d9230ea8fa42 -->
* **Plugin removes require\_bot\_match and payload\_filter; agent handles triage**: The \`require\_bot\_match\` and \`payload\_filter\` fields were removed from the \`Trigger\` type in \`types.ts\`. Identity gating (e.g. fire only when bot is assigned) and payload shape gating (e.g. skip empty review bodies, skip issue\_comment on non-PRs) are now handled by the agent in its pre-flight triage step. The plugin only handles: HMAC verification, dedup, \`ignore\_authors\` self-loop guard, prompt rendering, and dispatch. This avoids duplicating business logic between plugin config and agent instructions.

<!-- lore:019dee32-08dc-7d49-98f6-0a23ff6117de -->
* **SQLite schema: entities/links/dispatches — kind CHECK blocks non-PR/issue entities**: SQLite schema — three tables: \`entities\` (entity\_key PK, repo, number, kind CHECK('issue','pull\_request'), session\_id, agent, timestamps); \`links\` (source\_key, target\_key, relation); \`dispatches\` (id PK, entity\_key nullable, trigger\_name, event, delivery\_id, status, timestamps). Key gotchas: \`kind\` CHECK blocks non-issue/PR entities — requires migration to extend; \`entity\_key\` is null for email/push (fire-and-forget); \`setOutcome()\` in \`storage.ts\` is never called — \`status='succeeded'\` only means \`session.prompt()\` resolved; migration adds missing columns (e.g. \`external\_id\`) before \`insertStmt\` is prepared — if skipped, dashboard returns 500 while \`/healthz\` returns 200.

<!-- lore:019ddfd8-298f-79db-b305-68d5c5082d7e -->
* **webhooks.json baked into image, env-var overridable**: \`webhooks.json\` at repo root is COPYed to \`~/.config/opencode/webhooks.json\` in the Dockerfile. Contains 3 triggers: github-event (issues/pull\_request/check\_suite)→github-agent; github-comment (pull\_request\_review\_comment/issue\_comment/pull\_request\_review, with ignore\_authors)→github-agent; email-event (email.\*, with ignore\_authors)→github-agent. Override via \`WEBHOOKS\_CONFIG\` env var. \`$BOT\_LOGIN\` in the file is a literal substituted at config-load time from \`gh api user\`, not an env var.

### Gotcha

<!-- lore:019df684-7287-7d45-a4d7-8f5e62961943 -->
* **200 OK returned before async dispatch — failures invisible to GitHub**: The webhook handler returns 200 OK immediately; \`createAndPrompt\`/\`fireAndForget\` run via \`void\`. GitHub never retries on failure. Any failure in session creation, semaphore acquisition, or prompting silently drops the event. Observability only via Sentry and the SQLite \`dispatches\` table (status stays \`started\` on failure). Architectural — by design to beat GitHub's 10s timeout.

<!-- lore:019ddb97-5851-7c8e-9718-837e8ef95e99 -->
* **BYK/dotskills files are OpenCode commands, not installable skills**: BYK/dotskills flat \`.md\` files use OpenCode command frontmatter (\`description\` + \`agent: build|plan\`), not the Agent Skills spec. Running \`npx skills add BYK/dotskills\` returns 'No valid skills found'. To use them as skills requires converting each to \`\<name>/SKILL.md\` with proper \`name\`+\`description\` frontmatter in a subdirectory.

<!-- lore:019df684-728f-7321-9c69-95ef1793c803 -->
* **Config parse error silently disables all webhook processing**: Two silent failure modes that disable all webhook processing: (1) JSON syntax error in \`webhooks.json\` causes \`readWebhookConfig()\` to return \`{}\` — \`triggers.length === 0\` makes plugin return early with only a \`console.error\`, no exception; (2) In \`matchers.ts\`, if \`findMatching()\` returns empty, handler returns 200 OK \`{dispatched: \[], skipped: \[]}\` with no log, no Sentry event. Typos or wrong casing in trigger event names silently discard all matching webhooks. Detection: inspect GitHub's recent deliveries for empty \`dispatched\` arrays.

<!-- lore:019ddb97-387d-7086-babf-1a0fd6cc2978 -->
* **GitHub CLI auth lost on server restart — symlink to persistent volume**: gh CLI auth lost on Railway redeploy — tokens stored in ephemeral \`~/.config/gh/\`. Fix: set \`GH\_TOKEN\` as a Railway env var (PAT with repo/workflow/read:org scopes) — gh auto-detects it, no disk state needed. Use \`GH\_TOKEN\` not \`GITHUB\_TOKEN\`; Railway/Actions can override the latter. Symlink approach (\`ln -sfn ~/dev/.gh-config/...\`) also works but is more fragile.

<!-- lore:019de571-09ff-7714-8333-015078d0fb10 -->
* **HMAC over JSON: plugin must verify raw bytes, not re-serialized JSON**: When the email worker HMAC-signs a JSON body, the plugin must verify against the exact bytes received (\`req.text()\` before \`JSON.parse\`), not a re-serialized version. \`JSON.stringify\` key ordering is insertion-order-stable in JS/V8 but not spec-guaranteed cross-runtime. Re-serializing will produce matching output today but is fragile. Pattern: \`const raw = await req.text(); verify(raw); const payload = JSON.parse(raw)\`.

<!-- lore:019de986-40ab-7482-8ba4-5cfd8fdfb493 -->
* **Hono JSX dashboard files require jsx/jsxImportSource in tsconfig**: Dashboard \`.tsx\` files crash with \`Error: No renderer found\` when plugin runs from \`node\_modules\` on Railway — Bun's built-in \`createElement\` overrides Hono's, ignoring \`@jsxImportSource\` pragma. Fix: convert all dashboard files from \`.tsx\` to \`.ts\` using \`hono/html\` tagged template literals and \`raw()\` for unescaped CSS. Ensure renamed files are committed — Railway deploys from last commit, not local staging.

<!-- lore:019ddf88-31c5-7c9c-83b2-30b2e84407cc -->
* **Hono middleware ordering: \`use('/')\` matches POST routes registered after it**: Hono routing in \`handler.ts\`: routes are \`GET /healthz\`, \`GET /metrics\` (no auth), \`POST /webhooks/github\` (HMAC \`X-Hub-Signature-256\`), \`POST /webhooks/email\` (HMAC \`X-Email-Signature-256\`). Dep-injection middleware scoped to \`/webhooks/\*\` only. \`app.use('\*')\` wraps all in Sentry isolation scope. Gotcha: \`use('/')\` matches POST routes registered after it — always scope middleware narrowly.

<!-- lore:019de755-23d2-7199-b3cb-52211d0a70ad -->
* **ignore\_authors on broad github trigger blocks bot's own PR/issue events**: If \`ignore\_authors: \["$BOT\_LOGIN"]\` is placed on a trigger that also matches \`issues\` and \`pull\_request\` events, it will block the bot from self-reviewing its own PRs or being triggered when assigned an issue. Only apply \`ignore\_authors\` on triggers for comment events (pull\_request\_review\_comment, issue\_comment, pull\_request\_review) where self-loops are actually a risk. The bundled \`webhooks.json\` splits these into separate triggers for this reason.

<!-- lore:019de9d7-f743-7103-b241-5c650d5bd5fd -->
* **opencode-webhooks loads once per project/worktree — EADDRINUSE on shared port**: OpenCode loads plugins once per project/worktree in the same process. When multiple projects are open simultaneously (e.g. Railway volume with many repos), the plugin tries \`Bun.serve\` on port 5050 for each — only the first succeeds, rest crash with \`EADDRINUSE\`. Fix: guard with \`globalThis.\_\_webhookServerStarted\` flag. First invocation sets it and starts server; subsequent ones return early. Reset flag to \`false\` in catch block so a failed startup can be retried. Pattern already used for \`\_\_ghWebhookGuard\` (unhandledRejection dedup) in \`index.ts\`.

<!-- lore:019ddf9b-acec-7435-ac05-5e06fb4359bb -->
* **opencode.json \`experimental\` key rejects unknown subkeys (additionalProperties: false)**: The published OpenCode config JSON schema defines \`experimental\` with \`additionalProperties: false\`. Adding a custom key like \`experimental.webhook\` will fail strict schema validation in editors. Workaround: store plugin-specific config in a separate file (e.g. \`~/.config/opencode/webhooks.json\`) read directly via \`Bun.file().json()\`, or drop the \`$schema\` reference from \`opencode.json\` to silence editor errors. Do NOT put custom plugin config under \`experimental\` expecting schema tolerance.

<!-- lore:019de984-4bcd-7f21-acb9-384550d3fb3c -->
* **Railway PORT env causes OpenCode/webhook port conflict**: Railway sets \`PORT\` env var and routes all external traffic to it. OpenCode runs on whatever port Railway assigns (e.g. 8080 via \`PORT\`). The webhook plugin binds separately to its own port (default 5050 via \`WEBHOOK\_PORT\`). If the plugin crashes on startup (e.g. JSX config missing), its port disappears from Railway's service view while OpenCode's port remains. \`EXPOSE\` in Dockerfile is documentation only — Railway ignores it.

### Pattern

<!-- lore:019de622-bdfa-7267-9101-3c11dceb04e1 -->
* **Dispatch errors reported to Sentry with trigger/delivery tags via withScope**: Dispatch errors reported to Sentry with trigger/delivery tags via \`withScope\`. In \`pipeline.ts\`, both the affinity path (\`createAndPrompt\`/\`followUp\`) and the fire-and-forget path (\`fireAndForget\`) wrap \`Sentry.captureException(err)\` in \`Sentry.withScope()\` to attach \`trigger.name\`, \`trigger.event\`, \`delivery.id\`, and \`entity.key\` scoped only to that error event. Pattern: \`Sentry.withScope(scope => { scope.setTag(...); Sentry.captureException(err) })\`. Note: \`dispatch.ts\` was deleted; the pattern now lives exclusively in \`pipeline.ts\`.
<!-- End lore-managed section -->
