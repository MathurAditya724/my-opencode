<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Architecture

<!-- lore:019ddf82-a57d-74e2-92f1-e4b42484708b -->
* **Bundled agents copied to ~/.config/opencode/agents at image build time**: Agent \`.md\` files in \`agents/\` are COPYed to \`/home/developer/.config/opencode/agents/\` at build time. Five agents: \`github-issue-resolver\` (primary, issue→draft PR), \`pr-reviewer\` (primary, delegates to fix-applier for bot-authored PRs), \`pr-fix-applier\` (subagent, \`task: deny\` to prevent recursion), \`ci-fixer\` (primary, 3-attempt budget via sentinel PR comments), \`pr-comment-responder\` (primary, triage inline/top-level comments). All use \`mode: primary\` except \`pr-fix-applier\` (\`mode: subagent\`). Agent name passed to \`runOpencode\` must match filename without \`.md\`.

<!-- lore:019ddb97-585b-74f2-9ab1-adc4c03f338b -->
* **docker-entrypoint.sh skills bootstrap pattern**: Skills are baked into the image via Dockerfile \`COPY skills/ /home/developer/.config/opencode/skills/\` — no \`npx skills add\` calls at runtime. \`docker-entrypoint.sh\` does NOT run any skills bootstrap or cron scheduler; it only: chowns the dev volume if root-owned, inits git, configures \`gh auth setup-git\` + git user identity from \`gh api user\`, then \`exec opencode web\`. The webhook plugin (opencode-webhooks) loads in-process — there is no sidecar process.

<!-- lore:019ddf82-a55d-747f-b14b-cb1efd6e4b8f -->
* **Hono sidecar: webhook-to-agent dispatch pattern**: The opencode-webhooks plugin opens a single \`Bun.serve\` listener (port 5050, configurable via \`WEBHOOK\_PORT\`) inside the OpenCode server process — no Hono, no sidecar. Routes: \`GET /healthz\`, \`POST /webhooks/github\`. Pipeline: HMAC verify (sha256/timingSafeEqual) → SQLite dedup (delivery\_id UNIQUE) → trigger matching (findMatching, all enabled matches fire) → per-trigger gating (ignore\_authors / require\_bot\_match / payload\_filter) → template render (\`{{ a.b\[c] }}\`) → fire-and-forget \`ctx.client.session.create\` + \`.session.prompt\`. Semaphore caps concurrency at \`max\_concurrent\` (default 2). Zero npm runtime deps — pure Bun built-ins.

<!-- lore:019ddb97-583c-7303-8d84-01bb358bcc86 -->
* **OpenCode skills loaded from filesystem, not from opencode.json**: Skills are discovered from filesystem paths (\`~/.config/opencode/skills/\<name>/SKILL.md\` globally, \`.opencode/skills/\<name>/SKILL.md\` project-locally). The \`opencode.json\` config only controls \`permission.skill.\*\` entries to allow/deny/ask per skill name pattern. There is no \`skills\` declaration in the config file itself.

<!-- lore:019de4e6-2747-7fcd-a14c-2f2f2ef3bb5b -->
* **opencode-config-package.json vs opencode-user-config.json: producer/consumer split**: \`opencode-config-package.json\` (→ \`~/.config/opencode/package.json\`) is a dependency manifest — \`bun install\` fetches packages into \`node\_modules/\` but nothing loads automatically. \`opencode-user-config.json\` (→ \`~/.config/opencode/opencode.json\`) is OpenCode's config; its \`plugin: \[...]\` array is what actually triggers plugin loading at startup. Both files are required today because packages use \`file:\` deps (not published to npm). Once published, both could be dropped in favor of bare names in \`opencode.json\` and OpenCode's runtime auto-install. Keeping both enables build-time install (reproducible image, no cold-boot network call).

<!-- lore:019de4f1-1f2b-7e9f-8ee0-61ace7c64d95 -->
* **opencode-webhooks plugin: zero npm runtime deps, raw TS, no build step**: \`packages/opencode-webhooks/src/\` ships 11 raw \`.ts\` files with no build step and zero npm runtime dependencies. Uses only Bun built-ins (\`Bun.serve\`, \`Bun.spawn\`, \`Bun.file\`, \`bun:sqlite\`) and Node built-ins (\`node:crypto\`, \`node:os\`, \`node:fs\`, \`node:path\`). \`package.json\` lists only \`peerDependencies\` (\`@opencode-ai/plugin\`) and \`devDependencies\`. The \`exports\` field points directly to \`./src/index.ts\` — Bun loads TS natively at runtime.

<!-- lore:019ddf9b-acf0-76f3-8a33-44a1d0d48fb4 -->
* **Plugin dependencies: package.json at ~/.config/opencode/ (not inside plugins/)**: OpenCode runs \`bun install\` at startup using a \`package.json\` at the config directory root (\`~/.config/opencode/package.json\`), not inside the \`plugins/\` subdirectory. Placing \`package.json\` inside \`plugins/\` will not resolve imports. In the image, \`opencode-config-package.json\` in the repo is COPYed to \`~/.config/opencode/package.json\` at build time.

<!-- lore:019ddfd8-298f-79db-b305-68d5c5082d7e -->
* **webhooks.json baked into image, env-var overridable**: \`webhooks.json\` at repo root is COPYed to \`~/.config/opencode/webhooks.json\` in the Dockerfile. Contains 9 triggers (not 1): issues.assigned→github-issue-resolver; pull\_request.{opened,ready\_for\_review,review\_requested,assigned}→pr-reviewer; check\_suite.completed(failure)→ci-fixer; pull\_request\_review\_comment.created + issue\_comment.created(PR) + pull\_request\_review.submitted→pr-comment-responder. Override via \`WEBHOOKS\_CONFIG\` env var. \`$BOT\_LOGIN\` in the file is a literal substituted at config-load time from \`gh api user\`, not an env var.

### Gotcha

<!-- lore:019ddb97-5851-7c8e-9718-837e8ef95e99 -->
* **BYK/dotskills files are OpenCode commands, not installable skills**: BYK/dotskills flat \`.md\` files use OpenCode command frontmatter (\`description\` + \`agent: build|plan\`), not the Agent Skills spec. Running \`npx skills add BYK/dotskills\` returns 'No valid skills found'. To use them as skills requires converting each to \`\<name>/SKILL.md\` with proper \`name\`+\`description\` frontmatter in a subdirectory.

<!-- lore:019ddb97-387d-7086-babf-1a0fd6cc2978 -->
* **GitHub CLI auth lost on server restart — symlink to persistent volume**: gh CLI auth is lost on Railway redeploy because it stores tokens in ~/.config/gh/ on the ephemeral rootfs. sentry-cli survives because it reads SENTRY\_AUTH\_TOKEN from env vars on every invocation. Two fixes: (1) \*\*Recommended\*\*: set GH\_TOKEN as a Railway env var (PAT with repo/workflow/read:org scopes) — gh auto-detects it, no disk state needed, matches sentry-cli pattern. (2) Symlink approach: in docker-entrypoint.sh, run \`mkdir -p ~/.config/gh ~/dev/.gh-config\` then \`ln -sfn ~/dev/.gh-config/$f ~/.config/gh/$f\` for hosts.yml and config.yml. Use \`GH\_TOKEN\` not \`GITHUB\_TOKEN\` — Railway/Actions can override the latter.

<!-- lore:019ddf88-31c5-7c9c-83b2-30b2e84407cc -->
* **Hono middleware ordering: \`use('/')\` matches POST routes registered after it**: AGENTS.md contains stale lore from the abandoned \`.opencode/plans/add-hono-sidecar.md\` design: references to Hono framework, API\_TOKEN bearer gate, sidecar process supervision, \`npx skills add\` bootstrap, and 'one trigger' in webhooks.json are all outdated. Current implementation: in-process plugin with \`Bun.serve\` (no Hono), no API\_TOKEN, no sidecar, skills baked via Dockerfile \`COPY\`, and 9 triggers in webhooks.json. Do not rely on AGENTS.md architecture bullets without cross-checking against \`packages/opencode-webhooks/src/\` and \`docker-entrypoint.sh\`.

<!-- lore:019ddf9b-acec-7435-ac05-5e06fb4359bb -->
* **opencode.json \`experimental\` key rejects unknown subkeys (additionalProperties: false)**: The published OpenCode config JSON schema defines \`experimental\` with \`additionalProperties: false\`. Adding a custom key like \`experimental.webhook\` will fail strict schema validation in editors. Workaround: store plugin-specific config in a separate file (e.g. \`~/.config/opencode/webhooks.json\`) read directly via \`Bun.file().json()\`, or drop the \`$schema\` reference from \`opencode.json\` to silence editor errors. Do NOT put custom plugin config under \`experimental\` expecting schema tolerance.

<!-- lore:019ddf82-a571-7ee4-ad93-8e3039df4ea8 -->
* **Sidecar cold-boot race: opencode not ready when first webhook arrives**: Cold-boot race is eliminated when using a plugin architecture: the plugin starts after OpenCode's server is ready (it's loaded during server init, not in parallel). The race only applies to the sidecar pattern (separate process). If using a plugin with its own \`Bun.serve\` listener, no readiness polling or retry logic is needed.
<!-- End lore-managed section -->
