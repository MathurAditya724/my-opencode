# my-opencode

Self-hosted [OpenCode](https://opencode.ai) web UI in a Docker image, ready to deploy on [Railway](https://railway.app) (or any PaaS that builds Dockerfiles and forwards `$PORT`).

> Set `OPENCODE_SERVER_PASSWORD` before going public — it's the basic-auth gate over the URL.

## What's inside

- **OpenCode** (latest, autoupdates) + [Sentry CLI](https://cli.sentry.dev), GitHub CLI, **nvm + Node 22 LTS** (`pnpm` / `yarn` via corepack), **Bun**, plus `git`, `ripgrep`, `fd`, `fzf`, `jq`, `yq`, and `build-essential`.
- **Three remote MCP servers** preconfigured; credentials are pulled from env vars via `{env:VAR}` substitution, so nothing sensitive is baked into the image:
  - [Context7](https://context7.com) → `CONTEXT7_API_KEY`
  - [GitHub MCP](https://github.com/github/github-mcp-server) → `GITHUB_MCP_TOKEN`
  - [Sentry MCP](https://mcp.sentry.dev) → no env var
- Non-root `developer` user. Mount persistent volumes at `/workspace` (your projects) and `/home/developer/.local/share/opencode` (session history + auth) — both are pre-created with the right ownership.

## Deploy on Railway

1. Push this repo to GitHub.
2. Railway: **New Project → Deploy from GitHub repo**.
3. **Variables** tab: set `OPENCODE_SERVER_PASSWORD` and at least one LLM provider key.
4. (Optional) Mount Volumes at `/workspace` and `/home/developer/.local/share/opencode` so projects and session history survive redeploys.
5. **Settings → Networking → Generate Domain**, open it, sign in as `opencode` with the password from step 3.

## Environment variables

See [`.env.example`](./.env.example) for the full template.

| Variable | What it does |
|---|---|
| `OPENCODE_SERVER_PASSWORD` | **Required.** Basic-auth password. |
| One of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | **Required.** LLM provider key. |
| `OPENCODE_SERVER_USERNAME` | Basic-auth username (default `opencode`). |
| `CONTEXT7_API_KEY`, `GITHUB_MCP_TOKEN` | Credentials for the preconfigured MCP servers. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_URL` | For the bundled `sentry` CLI. |
| `PORT` | Set automatically by most PaaS providers. Defaults to `4096`. |

## Local test

```bash
cp .env.example .env       # edit, fill in the required values
docker build -t my-opencode .
docker run --rm -it -p 4096:4096 --env-file .env my-opencode
```

Open <http://localhost:4096>.

## Notes

- Override Node at build time: `docker build --build-arg NODE_VERSION=20.18.0 -t my-opencode .`
- Python isn't installed. If an npm package needs `node-gyp`, install on the fly inside an OpenCode bash session: `sudo apt-get install -y python3`.
