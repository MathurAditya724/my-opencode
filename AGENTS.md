<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Architecture

<!-- lore:019ddf82-a57d-74e2-92f1-e4b42484708b -->
* **Bundled agents copied to ~/.config/opencode/agents at image build time**: Agent \`.md\` files in \`agents/\` are COPYed to \`/home/developer/.config/opencode/agents/\` at build time. Five agents: \`github-issue-resolver\` (primary, issue→draft PR), \`pr-reviewer\` (primary, delegates to fix-applier for bot-authored PRs), \`pr-fix-applier\` (subagent, \`task: deny\` to prevent recursion), \`ci-fixer\` (primary, 3-attempt budget via sentinel PR comments), \`pr-comment-responder\` (primary, triage inline/top-level comments). All use \`mode: primary\` except \`pr-fix-applier\` (\`mode: subagent\`). Agent name passed to \`runOpencode\` must match filename without \`.md\`.

<!-- lore:019de571-09e1-709b-906d-e5be3eebae88 -->
* **Cloudflare Email Worker: dumb pipe pattern with unconditional forward + gated webhook**: Email Worker is a dumb pipe: (1) unconditionally \`message.forward(FORWARD\_TO)\` if env var set, (2) check \`ALLOWED\_SENDERS\` allowlist, (3) if allowlisted, POST small JSON payload to WEBHOOK\_URL (not raw RFC822). Fields: from, to, subject, message\_id, in\_reply\_to, references, list\_id, x\_github\_reason, x\_github\_sender. HMAC-signed with \`x-email-signature-256\` header. Forward wrapped in try/catch so a bad FORWARD\_TO doesn't block webhook dispatch. Runtime vars (\`WEBHOOK\_URL\`, \`FORWARD\_TO\`) are NOT in wrangler.json — set via \`.env\` for \`wrangler dev\` (auto-loaded by wrangler v4), and via Cloudflare dashboard (Plaintext type) for production. \`EMAIL\_WEBHOOK\_SECRET\` is a \`wrangler secret put\` secret in both envs.

<!-- lore:019ddb97-585b-74f2-9ab1-adc4c03f338b -->
* **docker-entrypoint.sh skills bootstrap pattern**: Skills are baked into the image via Dockerfile \`COPY skills/ /home/developer/.config/opencode/skills/\` — no \`npx skills add\` calls at runtime. \`docker-entrypoint.sh\` does NOT run any skills bootstrap or cron scheduler; it only: chowns the dev volume if root-owned, inits git, configures \`gh auth setup-git\` + git user identity from \`gh api user\`, then \`exec opencode web\`. The webhook plugin (opencode-webhooks) loads in-process — there is no sidecar process.

<!-- lore:019ddf82-a55d-747f-b14b-cb1efd6e4b8f -->
* **Hono sidecar: webhook-to-agent dispatch pattern**: opencode-webhooks Hono instrumentation: \`handler.ts\` \`createApp()\` returns \`Hono\<AppEnv>\`. \`app.onError\` captures unhandled route throws to Sentry. \`app.use('\*')\` middleware wraps each request in \`Sentry.withIsolationScope\` + \`Sentry.startSpan({ op: 'http.server' })\`, setting tags: \`http.method\`, \`http.route\`, \`delivery.id\`, \`github.event\`. Span status set from \`c.res.status\`. Deps injected on \`app.use('/webhooks/\*')\` only (healthz excluded). Routes: \`GET /healthz\`, \`POST /webhooks/github\`, \`POST /webhooks/email\`. \[\[019ddfd8-298f-79db-b305-68d5c5082d7e]]

<!-- lore:019ddb97-583c-7303-8d84-01bb358bcc86 -->
* **OpenCode skills loaded from filesystem, not from opencode.json**: Skills are discovered from filesystem paths (\`~/.config/opencode/skills/\<name>/SKILL.md\` globally, \`.opencode/skills/\<name>/SKILL.md\` project-locally). The \`opencode.json\` config only controls \`permission.skill.\*\` entries to allow/deny/ask per skill name pattern. There is no \`skills\` declaration in the config file itself.

<!-- lore:019de4e6-2747-7fcd-a14c-2f2f2ef3bb5b -->
* **opencode-config-package.json vs opencode-user-config.json: producer/consumer split**: \`opencode-config-package.json\` (→ \`~/.config/opencode/package.json\`) is a dependency manifest — \`bun install\` fetches packages into \`node\_modules/\` but nothing loads automatically. \`opencode-user-config.json\` (→ \`~/.config/opencode/opencode.json\`) is OpenCode's config; its \`plugin: \[...]\` array is what actually triggers plugin loading at startup. Both files are required today because packages use \`file:\` deps (not published to npm). Once published, both could be dropped in favor of bare names in \`opencode.json\` and OpenCode's runtime auto-install. Keeping both enables build-time install (reproducible image, no cold-boot network call).

<!-- lore:019de4f1-1f2b-7e9f-8ee0-61ace7c64d95 -->
* **opencode-webhooks plugin: zero npm runtime deps, raw TS, no build step**: \`packages/opencode-webhooks/src/\` ships raw \`.ts\` files with no build step. Runtime dependencies: \`hono ^4.0.0\` and \`@sentry/bun ^9.0.0\`. Dev deps: \`@opencode-ai/plugin\`, \`@types/bun\`, \`typescript\`. Uses Bun built-ins (\`Bun.serve\`, \`Bun.spawn\`, \`Bun.file\`, \`bun:sqlite\`) and Node built-ins (\`node:crypto\`, \`node:os\`, \`node:fs\`, \`node:path\`). \`exports\` points to \`./src/index.ts\` — Bun loads TS natively at runtime.

<!-- lore:019de5eb-d81e-7bf8-b924-30fe9b7552b7 -->
* **opencode-webhooks Sentry integration: init at plugin boot, DSN from env**: Sentry init in \`index.ts\`: \`tracesSampleRate\` defaults to 0.1 (override via \`SENTRY\_TRACES\_SAMPLE\_RATE\` env), \`sendDefaultPii: true\`. After resolving bot identity, \`Sentry.setTag('bot.login', botLogin)\` on the global scope tags all events with the deployment's identity. \`Sentry.close(2000)\` on SIGTERM/SIGINT flushes pending events. \`process.on('unhandledRejection')\` captures escaping errors. \`SENTRY\_TRACES\_SAMPLE\_RATE\` documented in \`.env.example\`.

<!-- lore:019ddf9b-acf0-76f3-8a33-44a1d0d48fb4 -->
* **Plugin dependencies: package.json at ~/.config/opencode/ (not inside plugins/)**: OpenCode runs \`bun install\` at startup using a \`package.json\` at the config directory root (\`~/.config/opencode/package.json\`), not inside the \`plugins/\` subdirectory. Placing \`package.json\` inside \`plugins/\` will not resolve imports. In the image, \`opencode-config-package.json\` in the repo is COPYed to \`~/.config/opencode/package.json\` at build time.

<!-- lore:019ddfd8-298f-79db-b305-68d5c5082d7e -->
* **webhooks.json baked into image, env-var overridable**: \`webhooks.json\` at repo root is COPYed to \`~/.config/opencode/webhooks.json\` in the Dockerfile. Contains 9 triggers (not 1): issues.assigned→github-issue-resolver; pull\_request.{opened,ready\_for\_review,review\_requested,assigned}→pr-reviewer; check\_suite.completed(failure)→ci-fixer; pull\_request\_review\_comment.created + issue\_comment.created(PR) + pull\_request\_review.submitted→pr-comment-responder. Override via \`WEBHOOKS\_CONFIG\` env var. \`$BOT\_LOGIN\` in the file is a literal substituted at config-load time from \`gh api user\`, not an env var.

### Gotcha

<!-- lore:019ddb97-5851-7c8e-9718-837e8ef95e99 -->
* **BYK/dotskills files are OpenCode commands, not installable skills**: BYK/dotskills flat \`.md\` files use OpenCode command frontmatter (\`description\` + \`agent: build|plan\`), not the Agent Skills spec. Running \`npx skills add BYK/dotskills\` returns 'No valid skills found'. To use them as skills requires converting each to \`\<name>/SKILL.md\` with proper \`name\`+\`description\` frontmatter in a subdirectory.

<!-- lore:019ddb97-387d-7086-babf-1a0fd6cc2978 -->
* **GitHub CLI auth lost on server restart — symlink to persistent volume**: gh CLI auth is lost on Railway redeploy because it stores tokens in ~/.config/gh/ on the ephemeral rootfs. sentry-cli survives because it reads SENTRY\_AUTH\_TOKEN from env vars on every invocation. Two fixes: (1) \*\*Recommended\*\*: set GH\_TOKEN as a Railway env var (PAT with repo/workflow/read:org scopes) — gh auto-detects it, no disk state needed, matches sentry-cli pattern. (2) Symlink approach: in docker-entrypoint.sh, run \`mkdir -p ~/.config/gh ~/dev/.gh-config\` then \`ln -sfn ~/dev/.gh-config/$f ~/.config/gh/$f\` for hosts.yml and config.yml. Use \`GH\_TOKEN\` not \`GITHUB\_TOKEN\` — Railway/Actions can override the latter.

<!-- lore:019de571-09ff-7714-8333-015078d0fb10 -->
* **HMAC over JSON: plugin must verify raw bytes, not re-serialized JSON**: When the email worker HMAC-signs a JSON body, the plugin must verify against the exact bytes received (\`req.text()\` before \`JSON.parse\`), not a re-serialized version. \`JSON.stringify\` key ordering is insertion-order-stable in JS/V8 but not spec-guaranteed cross-runtime. Re-serializing will produce matching output today but is fragile. Pattern: \`const raw = await req.text(); verify(raw); const payload = JSON.parse(raw)\`.

<!-- lore:019ddf88-31c5-7c9c-83b2-30b2e84407cc -->
* **Hono middleware ordering: \`use('/')\` matches POST routes registered after it**: The plugin now uses Hono for routing (not raw Bun.serve fetch function). \`handler.ts\` exports \`createApp()\` returning \`Hono\<AppEnv>\`; handler files (\`handlers/github.ts\`, \`handlers/email.ts\`) export plain \`(c: Context\<AppEnv>) => Promise\<Response>\` functions — no more closure factories. Deps injected via \`app.use('\*', ...)\` middleware into \`c.var\`. AGENTS.md stale lore about sidecar, API\_TOKEN, and \`npx skills add\` remains outdated — source of truth is \`packages/opencode-webhooks/src/\` and \`docker-entrypoint.sh\`.

<!-- lore:019de571-09ed-7a93-80a1-2bdb76b811d3 -->
* **message.forward() failure blocks entire email pipeline if not caught**: In a Cloudflare Email Worker, if \`message.forward()\` throws (e.g. unverified destination), the worker throws and CF retries the entire email — blocking all webhook dispatch until fixed. Always wrap \`message.forward()\` in try/catch and log the error, then continue to the POST. Otherwise a misconfigured \`FORWARD\_TO\` silently kills the whole pipeline.

<!-- lore:019ddf9b-acec-7435-ac05-5e06fb4359bb -->
* **opencode.json \`experimental\` key rejects unknown subkeys (additionalProperties: false)**: The published OpenCode config JSON schema defines \`experimental\` with \`additionalProperties: false\`. Adding a custom key like \`experimental.webhook\` will fail strict schema validation in editors. Workaround: store plugin-specific config in a separate file (e.g. \`~/.config/opencode/webhooks.json\`) read directly via \`Bun.file().json()\`, or drop the \`$schema\` reference from \`opencode.json\` to silence editor errors. Do NOT put custom plugin config under \`experimental\` expecting schema tolerance.

<!-- lore:019ddf82-a571-7ee4-ad93-8e3039df4ea8 -->
* **Sidecar cold-boot race: opencode not ready when first webhook arrives**: Cold-boot race is eliminated when using a plugin architecture: the plugin starts after OpenCode's server is ready (it's loaded during server init, not in parallel). The race only applies to the sidecar pattern (separate process). If using a plugin with its own \`Bun.serve\` listener, no readiness polling or retry logic is needed.

### Pattern

<!-- lore:019de622-bdfa-7267-9101-3c11dceb04e1 -->
* **Dispatch errors reported to Sentry with trigger/delivery tags via withScope**: In \`dispatch.ts\`, the catch block wraps \`Sentry.captureException(err)\` in \`Sentry.withScope()\` to attach \`trigger.name\`, \`trigger.event\`, and \`delivery.id\` tags scoped only to that error event. This avoids polluting the isolation scope of concurrent requests. Pattern: \`Sentry.withScope(scope => { scope.setTag(...); Sentry.captureException(err) })\`.
<!-- End lore-managed section -->
