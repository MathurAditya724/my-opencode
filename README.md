# my-opencode

Self-hosted [OpenCode](https://opencode.ai) web UI in a Docker image, ready to deploy on [Railway](https://railway.app) (or any PaaS that builds Dockerfiles and forwards `$PORT`).

> The container exposes the OpenCode web UI with no built-in auth. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) (or equivalent) in front of the public domain before exposing it — see [Auth](#auth) below.

## What's inside

- **OpenCode** built from source from the [`BYK/opencode`](https://github.com/BYK/opencode/tree/byk/cumulative) fork (`byk/cumulative` branch) — carries question-dock UX, plan-mode, and db perf fixes that aren't yet in upstream. Built fresh into the image; auto-update is effectively disabled because the fork has no release feed.
- [Sentry CLI](https://cli.sentry.dev), GitHub CLI, **nvm + Node 22 LTS** (`pnpm` / `yarn` via corepack), **Bun**, plus `git`, `ripgrep`, `fd`, `fzf`, `jq`, `yq`, and `build-essential`.
- No MCP servers preconfigured — add your own via a project-local `opencode.json` or by editing [`opencode-user-config.json`](./opencode-user-config.json) before building.
- **Bundled OpenCode plugin: [`github-webhooks`](./plugins/github-webhooks.ts)** — turns inbound GitHub webhook deliveries into OpenCode agent sessions running in the same `opencode` process. Listener stays off until you create a config file with at least one trigger (see [GitHub webhooks → agent sessions](#github-webhooks--agent-sessions) below).
- **Bundled agent: [`github-issue-resolver`](./agents/github-issue-resolver.md)** — autonomous "issue assigned → branch → plan → implement → PR" workflow, designed to be invoked by the webhook plugin or directly via `@github-issue-resolver`.
- Non-root `developer` user. OpenCode starts in `~/dev`. Mount a single persistent volume at `~/dev` (= `/home/developer/dev`) to keep your projects **and** OpenCode session/auth data across redeploys — `~/.local/share/opencode` is symlinked into `~/dev/.opencode`.

## Deploy on Railway

1. Push this repo to GitHub.
2. Railway: **New Project → Deploy from GitHub repo**.
3. **Variables** tab: set at least one LLM provider key (e.g. `ANTHROPIC_API_KEY`).
4. (Optional) Add a **Volume** mounted at `/home/developer/dev` so projects you clone and OpenCode session history both survive redeploys (sessions live at `~/dev/.opencode` via a symlink, so one volume covers both).
5. **Settings → Networking → Generate Domain**. Don't open it publicly — first put Cloudflare Access in front (see [Auth](#auth)), then visit the Access-protected URL and sign in via your IdP.

## Auth

The image runs `opencode web` with no built-in authentication, so you **must** front it with an auth proxy that issues a real session cookie (basic auth re-prompts constantly on mobile, which is why it's gone).

Recommended: **[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)**.

1. Point your custom domain at the Railway-generated domain via Cloudflare DNS (orange-cloud / proxied).
2. **Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted**, set the application domain to your custom hostname.
3. Add a policy (e.g. allow your email, an `@yourdomain` rule, or a GitHub identity).
4. Visit the domain — you'll get Cloudflare's sign-in page, then a long-lived `CF_Authorization` cookie that mobile browsers keep across app kills and reboots.

Alternatives: [Tailscale Serve / Funnel](https://tailscale.com/kb/1242/tailscale-serve), [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) sidecar, [Authelia](https://www.authelia.com/).

## Environment variables

See [`.env.example`](./.env.example) for the full template.

| Variable | What it does |
|---|---|
| One of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | **Required.** LLM provider key. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_URL` | For the bundled `sentry` CLI. |
| `GH_TOKEN` | For the bundled `gh` CLI. PAT with the scopes you need. |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for the `github-webhooks` plugin. Required to receive webhooks. |
| `WEBHOOK_PORT`, `WEBHOOKS_CONFIG` | Optional plugin tuning. See [`.env.example`](./.env.example). |
| `PORT` | Set automatically by most PaaS providers. Defaults to `4096`. |

## GitHub webhooks → agent sessions

The bundled [`github-webhooks`](./plugins/github-webhooks.ts) plugin runs
**inside** the OpenCode server process — no sidecar, no second process to
supervise, no loopback HTTP. It opens its own listener on port `5050`
(configurable via `WEBHOOK_PORT`) and dispatches verified deliveries
into agent sessions via the in-process SDK client.

The plugin stays dormant until you give it a config file. By default it
looks at `~/.config/opencode/webhooks.json`; override the path with
`WEBHOOKS_CONFIG` (handy if you want the file on the `~/dev` volume so
it survives image rebuilds).

### Example config

```json
{
  "port": 5050,
  "max_concurrent": 2,
  "timeout_ms": 1800000,
  "retention": 1000,
  "triggers": [
    {
      "name": "issue-assigned-to-me",
      "event": "issues",
      "action": "assigned",
      "agent": "github-issue-resolver",
      "prompt_template": "Resolve issue #{{ payload.issue.number }} ({{ payload.issue.title }}) in {{ payload.repository.full_name }}.\n\nIssue body:\n{{ payload.issue.body }}\n\nAssignee: {{ payload.assignee.login }}.\n\nFollow your standard workflow: clone, branch, plan, implement, push, open PR.",
      "cwd": null
    }
  ]
}
```

Field reference:

| Field | Required | What it does |
|---|---|---|
| `triggers[].name` | ✓ | Unique identifier; surfaces in plugin logs. |
| `triggers[].event` | ✓ | GitHub event header (`issues`, `pull_request`, `push`, ...). Use `"*"` to match anything. |
| `triggers[].action` | optional | If set, must match the payload's `action` exactly. Omit/`null` to match any action of this event. |
| `triggers[].agent` | ✓ | Agent name to invoke (built-in or from `agents/`). |
| `triggers[].prompt_template` | ✓ | Mustache-ish template. `{{ payload.foo.bar }}` looks up paths in the payload; missing paths render empty. |
| `triggers[].cwd` | optional | Override the session's working directory. Falls back to `default_cwd`, then to OpenCode's project root. |
| `port` | optional | Listener port; defaults to `5050` or `WEBHOOK_PORT`. |
| `secret` | optional | HMAC secret. Falls back to `GITHUB_WEBHOOK_SECRET`. |
| `max_concurrent` | optional | Cap on concurrent agent sessions across all triggers (default 2). |
| `timeout_ms` | optional | Per-session abort timeout (default 30 min). |
| `retention` | optional | Cap on persisted delivery rows for dedup (default 1000). |
| `default_cwd` | optional | Fallback `cwd` for triggers without one. |

In the GitHub webhook UI:

- **Payload URL**: `https://<your-domain>:5050/webhooks/github` (or however you route to that port).
- **Content type**: `application/json`.
- **Secret**: same value as `GITHUB_WEBHOOK_SECRET`.
- **Events**: pick what you need (`Issues`, `Pull request review`, etc.).

The plugin verifies `X-Hub-Signature-256`, dedups on `X-GitHub-Delivery`
(redeliveries are ack'd as `duplicate: true` and don't re-fire agents),
and parses each delivery's `action` for trigger matching. The dispatched
session itself is the system of record for everything that happens
afterward — view it in OpenCode's UI like any other session.

> **Railway note.** Railway only generates one HTTP domain per service. To
> reach `5050` you'll need a second Railway service pointing at the same
> image, a TCP proxy, or to route through Cloudflare. The opencode web UI
> on `4096`/`$PORT` and the plugin listener are independent — both speak
> plain HTTP on `0.0.0.0`.

### Health check

`GET http://<host>:5050/healthz` returns `{ "ok": true, "plugin": "github-webhooks" }` once the listener is up. No auth required.

## Local test

```bash
cp .env.example .env       # edit, fill in the required values
docker build -t my-opencode .
docker run --rm -it \
  -p 4096:4096 -p 5050:5050 \
  --env-file .env my-opencode
```

Open <http://localhost:4096> for OpenCode. Hit
<http://localhost:5050/healthz> if you've set up a `webhooks.json` and
want to verify the plugin loaded.

## Notes

- Override Node at build time: `docker build --build-arg NODE_VERSION=22.20.0 -t my-opencode .`
- Python isn't installed in the runtime image. If an npm package needs `node-gyp`, install on the fly inside an OpenCode bash session: `sudo apt-get install -y python3`.
- Pin a different opencode revision/fork at build time:
  `docker build --build-arg OPENCODE_REPO=https://github.com/anomalyco/opencode.git --build-arg OPENCODE_REF=dev -t my-opencode .`
  (defaults: `BYK/opencode` @ `byk/cumulative`).
