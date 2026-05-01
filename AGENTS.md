<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Architecture

<!-- lore:019ddf82-a57d-74e2-92f1-e4b42484708b -->
* **Bundled agents copied to ~/.config/opencode/agents at image build time**: Agent \`.md\` files in \`agents/\` are copied into \`/home/developer/.config/opencode/agents/\` at build time (Dockerfile line 182–183), making them available to both interactive sessions and sidecar-spawned sessions. The \`github-issue-resolver\` agent expects \`GH\_TOKEN\` env var for \`gh\` auth and uses \`mode: primary\` with broad tool permissions. Agent name passed to \`runOpencode\` must match the filename (without \`.md\`).

<!-- lore:019ddb97-585b-74f2-9ab1-adc4c03f338b -->
* **docker-entrypoint.sh skills bootstrap pattern**: Skills should be bootstrapped in \`docker-entrypoint.sh\` with a hard-coded list of \`npx skills add\` calls using \`--global -y -a opencode\`. Each call should fail-soft (warn, not exit). Idempotency is handled by \`npx skills\` overwriting existing symlinks. Note: as of the cron-removal refactor, \`docker-entrypoint.sh\` no longer runs a cron scheduler — it supervises only two processes: \`opencode web\` and the Hono sidecar (started only if \`API\_TOKEN\` is set).

<!-- lore:019ddf82-a55d-747f-b14b-cb1efd6e4b8f -->
* **Hono sidecar: webhook-to-agent dispatch pattern**: OpenCode plugins run inside the long-lived \`opencode\` server process. Plugin context provides \`{ client, project, directory, worktree, serverUrl, $ }\` — \`client\` is a bound SDK client (no loopback HTTP needed). Plugins cannot register routes onto OpenCode's HTTP surface but can open their own \`Bun.serve\` listener on a separate port. For GitHub webhook dispatch: plugin opens port 5050, verifies HMAC, deduplicates via \`bun:sqlite\`, calls \`ctx.client.session.create\` + \`ctx.client.session.prompt\` in-process. Config loaded from \`~/.config/opencode/webhooks.json\` (baked in image) or path in \`WEBHOOKS\_CONFIG\` env var. Trade-off: plugin shares OpenCode's process — unhandled rejections can crash the server.

<!-- lore:019ddb97-583c-7303-8d84-01bb358bcc86 -->
* **OpenCode skills loaded from filesystem, not from opencode.json**: Skills are discovered from filesystem paths (\`~/.config/opencode/skills/\<name>/SKILL.md\` globally, \`.opencode/skills/\<name>/SKILL.md\` project-locally). The \`opencode.json\` config only controls \`permission.skill.\*\` entries to allow/deny/ask per skill name pattern. There is no \`skills\` declaration in the config file itself.

<!-- lore:019ddf9b-acf0-76f3-8a33-44a1d0d48fb4 -->
* **Plugin dependencies: package.json at ~/.config/opencode/ (not inside plugins/)**: OpenCode runs \`bun install\` at startup using a \`package.json\` at the config directory root (\`~/.config/opencode/package.json\`), not inside the \`plugins/\` subdirectory. Placing \`package.json\` inside \`plugins/\` will not resolve imports. In the image, \`opencode-config-package.json\` in the repo is COPYed to \`~/.config/opencode/package.json\` at build time.

<!-- lore:019ddfd8-298f-79db-b305-68d5c5082d7e -->
* **webhooks.json baked into image, env-var overridable**: A default \`webhooks.json\` lives at the repo root and is COPYed into \`~/.config/opencode/webhooks.json\` in the Dockerfile. The plugin activates automatically once \`GITHUB\_WEBHOOK\_SECRET\` is set — no separate config step needed. Override at runtime via \`WEBHOOKS\_CONFIG\` env var pointing to an alternative path. The bundled default contains one trigger: \`issues.assigned\` → \`github-issue-resolver\`. HMAC secret is never stored in the file; kept as env var only.

### Gotcha

<!-- lore:019ddb97-5851-7c8e-9718-837e8ef95e99 -->
* **BYK/dotskills files are OpenCode commands, not installable skills**: BYK/dotskills flat \`.md\` files use OpenCode command frontmatter (\`description\` + \`agent: build|plan\`), not the Agent Skills spec. Running \`npx skills add BYK/dotskills\` returns 'No valid skills found'. To use them as skills requires converting each to \`\<name>/SKILL.md\` with proper \`name\`+\`description\` frontmatter in a subdirectory.

<!-- lore:019ddb97-387d-7086-babf-1a0fd6cc2978 -->
* **GitHub CLI auth lost on server restart — symlink to persistent volume**: gh CLI auth is lost on Railway redeploy because it stores tokens in ~/.config/gh/ on the ephemeral rootfs. sentry-cli survives because it reads SENTRY\_AUTH\_TOKEN from env vars on every invocation. Two fixes: (1) \*\*Recommended\*\*: set GH\_TOKEN as a Railway env var (PAT with repo/workflow/read:org scopes) — gh auto-detects it, no disk state needed, matches sentry-cli pattern. (2) Symlink approach: in docker-entrypoint.sh, run \`mkdir -p ~/.config/gh ~/dev/.gh-config\` then \`ln -sfn ~/dev/.gh-config/$f ~/.config/gh/$f\` for hosts.yml and config.yml. Use \`GH\_TOKEN\` not \`GITHUB\_TOKEN\` — Railway/Actions can override the latter.

<!-- lore:019ddf88-31c5-7c9c-83b2-30b2e84407cc -->
* **Hono middleware ordering: \`use('/')\` matches POST routes registered after it**: In Hono, \`webhooks.use('/', requireBearer)\` declared before \`webhooks.post('/github', ...)\` applies the bearer middleware to the public HMAC webhook route too, returning 401. Correct pattern: register the public POST route first, then add \`use('/')\` for bearer-gated routes afterward. Middleware applies only to routes registered after it in Hono.

<!-- lore:019ddf9b-acec-7435-ac05-5e06fb4359bb -->
* **opencode.json \`experimental\` key rejects unknown subkeys (additionalProperties: false)**: The published OpenCode config JSON schema defines \`experimental\` with \`additionalProperties: false\`. Adding a custom key like \`experimental.webhook\` will fail strict schema validation in editors. Workaround: store plugin-specific config in a separate file (e.g. \`~/.config/opencode/webhooks.json\`) read directly via \`Bun.file().json()\`, or drop the \`$schema\` reference from \`opencode.json\` to silence editor errors. Do NOT put custom plugin config under \`experimental\` expecting schema tolerance.

<!-- lore:019ddf82-a571-7ee4-ad93-8e3039df4ea8 -->
* **Sidecar cold-boot race: opencode not ready when first webhook arrives**: Cold-boot race is eliminated when using a plugin architecture: the plugin starts after OpenCode's server is ready (it's loaded during server init, not in parallel). The race only applies to the sidecar pattern (separate process). If using a plugin with its own \`Bun.serve\` listener, no readiness polling or retry logic is needed.
<!-- End lore-managed section -->
