# my-opencode

Self-hosted [OpenCode](https://opencode.ai) web UI in a Docker image, ready to deploy on [Railway](https://railway.app) (or any PaaS that builds Dockerfiles and forwards `$PORT`).

> The container exposes the OpenCode web UI with no built-in auth. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) (or equivalent) in front of the public domain before exposing it — see [Auth](#auth) below.

## What's inside

- **OpenCode** built from source from the [`BYK/opencode`](https://github.com/BYK/opencode/tree/byk/cumulative) fork (`byk/cumulative` branch) — carries question-dock UX, plan-mode, and db perf fixes that aren't yet in upstream. Built fresh into the image; auto-update is effectively disabled because the fork has no release feed.
- [Sentry CLI](https://cli.sentry.dev), GitHub CLI, **nvm + Node 22 LTS** (`pnpm` / `yarn` via corepack), **Bun**, plus `git`, `ripgrep`, `fd`, `fzf`, `jq`, `yq`, and `build-essential`.
- No MCP servers preconfigured — add your own via a project-local `opencode.json` or by editing [`opencode-user-config.json`](./opencode-user-config.json) before building.
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
| `PORT` | Set automatically by most PaaS providers. Defaults to `4096`. |

## Local test

```bash
cp .env.example .env       # edit, fill in the required values
docker build -t my-opencode .
docker run --rm -it -p 4096:4096 --env-file .env my-opencode
```

Open <http://localhost:4096>.

## Notes

- Override Node at build time: `docker build --build-arg NODE_VERSION=22.20.0 -t my-opencode .`
- Python isn't installed in the runtime image. If an npm package needs `node-gyp`, install on the fly inside an OpenCode bash session: `sudo apt-get install -y python3`.
- Pin a different opencode revision/fork at build time:
  `docker build --build-arg OPENCODE_REPO=https://github.com/anomalyco/opencode.git --build-arg OPENCODE_REF=dev -t my-opencode .`
  (defaults: `BYK/opencode` @ `byk/cumulative`).
