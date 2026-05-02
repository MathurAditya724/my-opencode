# my-opencode

Self-hosted [OpenCode](https://opencode.ai) web UI in a Docker image, ready to deploy on [Railway](https://railway.app) (or any PaaS that builds Dockerfiles and forwards `$PORT`).

> The container exposes the OpenCode web UI with no built-in auth. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) (or equivalent) in front of the public domain before exposing it — see [Auth](#auth) below.

## What's inside

- **OpenCode** built from source from the [`BYK/opencode`](https://github.com/BYK/opencode/tree/byk/cumulative) fork (`byk/cumulative` branch) — carries question-dock UX, plan-mode, and db perf fixes that aren't yet in upstream. Built fresh into the image; auto-update is effectively disabled because the fork has no release feed.
- [Sentry CLI](https://cli.sentry.dev), GitHub CLI, **nvm + Node 22 LTS** (`pnpm` / `yarn` via corepack), **Bun**, plus `git`, `ripgrep`, `fd`, `fzf`, `jq`, `yq`, and `build-essential`.
- No MCP servers preconfigured — add your own via a project-local `opencode.json` or by editing [`opencode-user-config.json`](./opencode-user-config.json) before building.
- **Bundled OpenCode plugin: [`opencode-webhooks`](./packages/opencode-webhooks)** — turns inbound GitHub webhook deliveries into OpenCode agent sessions running in the same `opencode` process. Ships with [`webhooks.json`](./webhooks.json) baked in (2 broad triggers covering all GitHub events and email notifications). Activates on container start once you set `GITHUB_WEBHOOK_SECRET`. The plugin lives as a standalone, publishable npm package under [`packages/opencode-webhooks/`](./packages/opencode-webhooks) — see its [README](./packages/opencode-webhooks/README.md) for the full config schema and how to use it in your own OpenCode setup. See also [GitHub webhooks → agent sessions](#github-webhooks--agent-sessions) below for this image's specific wiring.
- **Bundled agent** (permissions pre-broadened so it doesn't stall on approval prompts):
  - [`github-agent`](./agents/github-agent.md) — unified agent that receives raw webhook payloads, triages the event, and loads situation-specific skills to drive it to completion. Handles the full lifecycle: issue assignment → draft PR → review → CI fix → comment response.
- **Bundled skills** (loadable on demand by the agent via the `skill` tool):
  - **Situation skills** (domain workflows the agent loads based on the event type):
    - [`repo-setup`](./skills/repo-setup/SKILL.md) — shared clone/checkout/branch boilerplate.
    - [`resolve-issue`](./skills/resolve-issue/SKILL.md) — plan, implement, clean up, open a draft PR.
    - [`review-pr`](./skills/review-pr/SKILL.md) — review a PR; self-fix or post a structured review.
    - [`fix-ci`](./skills/fix-ci/SKILL.md) — diagnose and fix failing CI (3-attempt budget).
    - [`respond-to-comment`](./skills/respond-to-comment/SKILL.md) — triage PR comments and respond.
    - [`apply-fixes`](./skills/apply-fixes/SKILL.md) — apply review findings as smallest code changes.
  - **Utility skills** (cross-cutting tools used by situation skills):
    - [`pr`](./skills/pr/SKILL.md) — open a draft PR with the implementation plan embedded.
    - [`review`](./skills/review/SKILL.md) — diff against default branch and emit a structured `findings` list.
    - [`deslop`](./skills/deslop/SKILL.md) — strip AI-generated noise from the diff before commit.
  - Utility skills adapted from [BYK/dotskills](https://github.com/BYK/dotskills) (Apache-2.0).
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
| `GH_TOKEN` | For the bundled `gh` CLI **and** the `opencode-webhooks` plugin's identity-gated triggers. PAT with the scopes you need (typical: `repo`, `read:org`, `workflow`). The plugin runs `gh api user --jq .login` at boot to resolve the bot's GitHub identity; without `GH_TOKEN`, identity-gated triggers fail closed. |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for the `opencode-webhooks` plugin. Required to receive webhooks. |
| `WEBHOOK_PORT`, `WEBHOOKS_CONFIG` | Optional plugin tuning. See [`.env.example`](./.env.example). |
| `PORT` | Set automatically by most PaaS providers. Defaults to `4096`. |

## GitHub webhooks → agent sessions

The bundled [`opencode-webhooks`](./packages/opencode-webhooks) plugin
runs **inside** the OpenCode server process — no sidecar, no second
process to supervise, no loopback HTTP. It opens its own listener on
port `5050` (configurable via `WEBHOOK_PORT`) and dispatches verified
deliveries into agent sessions via the in-process SDK client.

### Default behavior

The image ships with [`webhooks.json`](./webhooks.json) baked in at
`~/.config/opencode/webhooks.json`. It defines **2 broad triggers**
that route all supported GitHub events to the unified `github-agent`:

| Trigger | Events | Agent |
|---|---|---|
| `github-event` | `issues`, `pull_request`, `check_suite`, `pull_request_review_comment`, `issue_comment`, `pull_request_review` | `github-agent` |
| `email-event` | `email.*` (any email notification) | `github-agent` |

The agent receives the **raw webhook payload** and decides what to do.
It runs pre-flight checks (self-loop guard, involvement check) and
then loads the appropriate situation skill:

- **Issue assigned** → `repo-setup` + `resolve-issue` → draft PR
- **PR opened/ready/review-requested/assigned** → `repo-setup` + `review-pr` → review or self-fix
- **CI failed** → `repo-setup` + `fix-ci` → smallest fix + comment
- **Comment/review on PR** → `repo-setup` + `respond-to-comment` → triage + reply/fix

The plugin only handles self-loop prevention (`ignore_authors` with
`$BOT_LOGIN`) and deduplication. All identity checks, payload
filtering, and routing decisions are made by the agent itself, giving
it the flexibility to chain skills within a single session (e.g.,
resolve an issue → self-review → open PR, all in one context window).

Once `GITHUB_WEBHOOK_SECRET` is set and `GH_TOKEN` is available
(both required), the plugin boots its listener on port 5050
automatically. No further setup needed.

### Stopping the bot from triggering itself

Self-loop prevention works at two levels:

1. **Plugin level** — both triggers use `ignore_authors: ["$BOT_LOGIN"]`.
   The plugin substitutes `$BOT_LOGIN` with the bot login auto-resolved
   at boot via `gh api user`. This prevents the bot's own webhook
   activity (e.g., opening a PR, posting a comment) from re-triggering
   a new session.

2. **Agent level** — the `github-agent` runs a self-loop guard as a
   pre-flight check: if `payload.sender.login` equals the bot's
   identity, it stops with `SKIPPED: self-triggered`. The exception is
   `check_suite.completed` where the sender is the CI app, not the
   pusher.

If `gh api user` fails at boot (no `GH_TOKEN`, network error), the
`$BOT_LOGIN` placeholder is silently dropped — the trigger doesn't
filter, which is the safer failure mode. The agent's own pre-flight
check provides a second layer of defense.

### Overriding the default config

The bundled file gives you all four agent flows out of the box. To
customize:

- **Edit before building** — change [`webhooks.json`](./webhooks.json) in
  this repo and rebuild the image. Triggers stay version-controlled.
- **Override at runtime** — set `WEBHOOKS_CONFIG=/home/developer/dev/.opencode/webhooks.json`
  (or any other path) and put your own file there. Handy for adding
  per-deployment triggers without rebuilding.

The HMAC secret (`secret` field) is intentionally **not** baked into the
file — set `GITHUB_WEBHOOK_SECRET` as an env var instead.

### Config schema

The minimum-viable trigger:

```json
{
  "triggers": [
    {
      "name": "all-events",
      "event": ["issues", "pull_request"],
      "agent": "github-agent",
      "prompt_template": "A GitHub webhook arrived.\n\nEvent: {{ event }}\nAction: {{ action }}\n\nPayload:\n{{ payload }}"
    }
  ]
}
```

The bundled [`webhooks.json`](./webhooks.json) passes the raw payload
to the agent, which decides what to do. The plugin's job is kept
minimal: HMAC verification, dedup, self-loop guard, and dispatch.

Field reference:

| Field | Required | What it does |
|---|---|---|
| `triggers[].name` | ✓ | Unique identifier; surfaces in plugin logs. |
| `triggers[].event` | ✓ | GitHub event header (`issues`, `pull_request`, `push`, ...). Use `"*"` to match anything. Accepts an array for OR-matching. Supports trailing wildcards (`"email.*"`). |
| `triggers[].action` | optional | If set, must match the payload's `action` exactly. Omit/`null` to match any action of this event. |
| `triggers[].agent` | ✓ | Agent name to invoke (built-in or from `agents/`). |
| `triggers[].prompt_template` | ✓ | Mustache-ish template. `{{ payload.foo.bar }}` looks up paths in the payload; missing paths render empty. |
| `triggers[].cwd` | optional | Override the session's working directory. Falls back to `default_cwd`, then to OpenCode's project root. |
| `triggers[].ignore_authors` | optional | List of GitHub logins to filter out (case-insensitive, exact match) on `payload.sender.login`. The literal string `"$BOT_LOGIN"` is substituted with the auto-resolved bot login at boot. Use this to prevent the bot from re-triggering on its own webhook activity. |
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

`GET http://<host>:5050/healthz` (the plugin's port, not OpenCode's
4096) returns `{ "ok": true, "plugin": "opencode-webhooks" }` once the
listener is up. No auth required.

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
