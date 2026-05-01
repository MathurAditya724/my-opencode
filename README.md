# my-opencode

Self-hosted [OpenCode](https://opencode.ai) web UI in a Docker image, ready to deploy on [Railway](https://railway.app) (or any PaaS that builds Dockerfiles and forwards `$PORT`).

> The container exposes the OpenCode web UI with no built-in auth. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) (or equivalent) in front of the public domain before exposing it — see [Auth](#auth) below.

## What's inside

- **OpenCode** built from source from the [`BYK/opencode`](https://github.com/BYK/opencode/tree/byk/cumulative) fork (`byk/cumulative` branch) — carries question-dock UX, plan-mode, and db perf fixes that aren't yet in upstream. Built fresh into the image; auto-update is effectively disabled because the fork has no release feed.
- [Sentry CLI](https://cli.sentry.dev), GitHub CLI, **nvm + Node 22 LTS** (`pnpm` / `yarn` via corepack), **Bun**, plus `git`, `ripgrep`, `fd`, `fzf`, `jq`, `yq`, and `build-essential`.
- No MCP servers preconfigured — add your own via a project-local `opencode.json` or by editing [`opencode-user-config.json`](./opencode-user-config.json) before building.
- **Bundled OpenCode plugin: [`github-webhooks`](./plugins/github-webhooks.ts)** — turns inbound GitHub webhook deliveries into OpenCode agent sessions running in the same `opencode` process. Ships with [`webhooks.json`](./webhooks.json) baked in (7 triggers covering the full PR lifecycle). Activates on container start once you set `GITHUB_WEBHOOK_SECRET`. See [GitHub webhooks → agent sessions](#github-webhooks--agent-sessions).
- **Bundled agents** (all `mode: primary`, permissions pre-broadened so they don't stall on approval prompts):
  - [`github-issue-resolver`](./agents/github-issue-resolver.md) — issue assigned → branch → plan → implement → draft PR.
  - [`pr-reviewer`](./agents/pr-reviewer.md) — PR opened / ready-for-review → reads diff + linked issue → posts an honest review (APPROVE / REQUEST_CHANGES / COMMENT) via `gh pr review`.
  - [`ci-fixer`](./agents/ci-fixer.md) — `check_suite.completed` with `conclusion: failure` → diagnoses the failure → pushes the smallest fix → comments on the PR. Capped at 3 attempts per PR.
  - [`pr-comment-responder`](./agents/pr-comment-responder.md) — review comment / PR comment / review submitted → triages → fixes if actionable, replies in either case.
- **Bundled skills** (loadable on demand by any agent via the `skill` tool):
  - [`pr`](./skills/pr/SKILL.md) — open a draft PR with the implementation plan attached as a git note.
  - [`review`](./skills/review/SKILL.md) — self-review the diff (and PR description) before merge.
  - [`deslop`](./skills/deslop/SKILL.md) — strip AI-generated noise from the diff before commit.
  - All three are adapted from [BYK/dotskills](https://github.com/BYK/dotskills) (Apache-2.0).
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
| `GH_TOKEN` | For the bundled `gh` CLI **and** the `github-webhooks` plugin's identity-gated triggers. PAT with the scopes you need (typical: `repo`, `read:org`, `workflow`). The plugin runs `gh api user --jq .login` at boot to resolve the bot's GitHub identity; without `GH_TOKEN`, identity-gated triggers fail closed. |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for the `github-webhooks` plugin. Required to receive webhooks. |
| `WEBHOOK_PORT`, `WEBHOOKS_CONFIG` | Optional plugin tuning. See [`.env.example`](./.env.example). |
| `PORT` | Set automatically by most PaaS providers. Defaults to `4096`. |

## GitHub webhooks → agent sessions

The bundled [`github-webhooks`](./plugins/github-webhooks.ts) plugin runs
**inside** the OpenCode server process — no sidecar, no second process to
supervise, no loopback HTTP. It opens its own listener on port `5050`
(configurable via `WEBHOOK_PORT`) and dispatches verified deliveries
into agent sessions via the in-process SDK client.

### Default behavior

The image ships with [`webhooks.json`](./webhooks.json) baked in at
`~/.config/opencode/webhooks.json`. It defines **7 triggers** that
together cover an issue's full lifecycle through merge:

| Trigger | GitHub event (`event.action`) | Identity gate (`require_bot_match`) | Payload gate (`payload_filter`) | Agent |
|---|---|---|---|---|
| `issue-assigned` | `issues.assigned` | `assignee.login` | — | `github-issue-resolver` |
| `pr-opened` | `pull_request.opened` | `pull_request.user.login` | — | `pr-reviewer` |
| `pr-ready-for-review` | `pull_request.ready_for_review` | `pull_request.user.login` | — | `pr-reviewer` |
| `ci-failed` | `check_suite.completed` | (agent-side, see note) | `check_suite.conclusion = "failure"` | `ci-fixer` |
| `pr-review-comment` | `pull_request_review_comment.created` | `pull_request.user.login` | — | `pr-comment-responder` |
| `pr-issue-comment` | `issue_comment.created` | `issue.user.login` | `issue.pull_request` exists | `pr-comment-responder` |
| `pr-review-submitted` | `pull_request_review.submitted` | `pull_request.user.login` | `review.body` non-empty | `pr-comment-responder` |

**`require_bot_match`** scopes each agent to work that's *addressed
to the bot*: only fire when the configured payload field equals the
bot's resolved GitHub login (case-insensitive, OR across multiple
paths). The bot's identity is auto-resolved at boot via `gh api user
--jq .login`. Concretely:

- `github-issue-resolver` only fires on issues assigned to the bot.
- `pr-reviewer` only fires on PRs the bot itself authored — it's a
  second-pass-on-own-work agent, not an org-wide reviewer.
- `pr-comment-responder` only fires on comments / reviews on PRs the
  bot authored.
- `ci-fixer` is the exception: `check_suite` payloads don't include
  the PR author, so the agent does the `gh pr view --json author`
  check itself as step 0 and `BLOCKED`s out if the PR isn't its.

If `gh api user` fails at boot (no `GH_TOKEN`, network error), all
identity-gated triggers skip with reason `bot identity unresolved` —
fail-closed for safety.

**`payload_filter`** is a separate, generic shape gate. When set,
the plugin skips dispatch when the filter doesn't match — no agent
session is created, no LLM tokens spent.

Skipped triggers (from any gate) surface in the response's `skipped`
array with a per-key reason (e.g. `none of [assignee.login] matched
bot login 'foo'` or `payload.check_suite.conclusion = "success"
(expected "failure")`), so you can see at a glance which triggers
passed/skipped on each delivery.

Once `GITHUB_WEBHOOK_SECRET` is set and `GH_TOKEN` is available
(both required), the plugin boots its listener on port 5050
automatically. No further setup needed.

### Stopping the bot from triggering itself

Every trigger except `ci-failed` has a baked-in
`ignore_authors: ["github-actions[bot]"]` so workflow-driven check
events don't fire the agents. The bot's own gh login is auto-appended
at boot (resolved via `gh api user`), so when its own commits /
comments / reviews emit fresh webhooks the agents don't re-trigger
themselves either.

`ci-failed` is the exception: the sender on `check_suite.completed`
events IS `github-actions[bot]` (that's how CI uploads results). If
we filtered that out, ci-fixer would never run. Identity scoping for
this trigger is enforced agent-side via `gh pr view --json author` in
the agent's step 0.

If you want explicit operator override (e.g. the gh CLI auth is to a
different identity than the bot's commit author), set:

```
BOT_LOGIN=<gh-login>
```

(Or `BOT_LOGINS=foo,bar` for multiple accounts.)

> **Important — the two scopes don't overlap.** `BOT_LOGIN` only
> affects `ignore_authors` (the self-loop guard). The
> `require_bot_match` identity gate ALWAYS uses the auto-resolved
> `gh api user` value and ignores `BOT_LOGIN`. This is deliberate:
> webhook payloads carry the bot's GitHub identity (the gh-resolved
> one), not its commit-author identity, so that's what gates "is this
> work for me?" If the two identities differ, set `BOT_LOGIN` for the
> commit-author identity and let `gh api user` handle the GitHub
> identity automatically.
>
> When `BOT_LOGIN` is set, it replaces the auto-resolved value in
> `ignore_authors` (so you don't double-count). `BOT_LOGINS` is always
> additive on top of whichever single value is in effect.

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
      "name": "issue-assigned",
      "event": "issues",
      "action": "assigned",
      "agent": "github-issue-resolver",
      "prompt_template": "Resolve issue #{{ payload.issue.number }} in {{ payload.repository.full_name }}."
    }
  ]
}
```

The bundled [`webhooks.json`](./webhooks.json) is richer — its
`prompt_template` interpolates the issue title, body, assignee, author,
URL, and labels into a context-heavy prompt for the agent. Use that as
the working reference when writing your own trigger.

Field reference:

| Field | Required | What it does |
|---|---|---|
| `triggers[].name` | ✓ | Unique identifier; surfaces in plugin logs. |
| `triggers[].event` | ✓ | GitHub event header (`issues`, `pull_request`, `push`, ...). Use `"*"` to match anything. |
| `triggers[].action` | optional | If set, must match the payload's `action` exactly. Omit/`null` to match any action of this event. |
| `triggers[].agent` | ✓ | Agent name to invoke (built-in or from `agents/`). |
| `triggers[].prompt_template` | ✓ | Mustache-ish template. `{{ payload.foo.bar }}` looks up paths in the payload; missing paths render empty. Synthetic booleans available: `is_pr_comment`, `is_review_with_body`, `review_state`, `is_ci_failure`. |
| `triggers[].cwd` | optional | Override the session's working directory. Falls back to `default_cwd`, then to OpenCode's project root. |
| `triggers[].ignore_authors` | optional | List of GitHub logins to filter out (case-insensitive, exact match) on `payload.sender.login`. Use this to stop the bot from triggering itself. Defaults include the bot's auto-resolved gh login when available. |
| `triggers[].require_bot_match` | optional | List of dotted payload paths whose string value (case-insensitive) must equal the bot's resolved gh login for the trigger to fire. OR semantics across paths. Empty/absent = no gate. Skips with `none of [paths] matched bot login 'X'` on miss, or `bot identity unresolved` if `gh api user` failed at boot (fail-closed). |
| `triggers[].payload_filter` | optional | Object of dotted-path → expected-value gates. `"*"` matches any non-empty value; other values match scalars after JSON normalization. Multiple keys AND. Use to cheaply gate "fire only when payload.X = Y" without spinning up a session that BLOCKED-exits. |
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
4096) returns `{ "ok": true, "plugin": "github-webhooks" }` once the
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
