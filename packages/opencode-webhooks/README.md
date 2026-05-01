# opencode-webhooks

OpenCode plugin: receive GitHub webhooks and dispatch them to OpenCode agent sessions running in the same process.

When a configured webhook arrives, the plugin verifies the HMAC signature, deduplicates by `X-GitHub-Delivery`, runs identity/payload gating, renders a prompt template against the payload, and starts a new OpenCode agent session via the in-process SDK client.

> **Runtime: Bun ≥ 1.2.** Uses `Bun.serve`, `Bun.spawn`, and `bun:sqlite`.

## Install

Once published to npm, add the package name to your OpenCode config's `plugin` array — OpenCode will install it into `~/.cache/opencode/node_modules/` automatically at startup:

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-webhooks"
  ]
}
```

> Until the package is published to npm, install it manually: add `"opencode-webhooks": "file:/path/to/this/repo/packages/opencode-webhooks"` to a `package.json` in your OpenCode config directory (`~/.config/opencode/package.json`), run `bun install` there, and reference the resolved path:
>
> ```jsonc
> {
>   "plugin": [
>     "file:///home/<user>/.config/opencode/node_modules/opencode-webhooks"
>   ]
> }
> ```

## Configure

The plugin reads `webhooks.json` from `~/.config/opencode/webhooks.json` by default. Override with the `WEBHOOKS_CONFIG` env var.

Minimal config:

```jsonc
{
  "max_concurrent": 2,
  "timeout_ms": 1800000,
  "retention": 1000,
  "triggers": [
    {
      "name": "issue-assigned",
      "event": "issues",
      "action": "assigned",
      "agent": "github-issue-resolver",
      "require_bot_match": ["assignee.login"],
      "prompt_template": "Issue assigned: {{ payload.issue.html_url }}\n\n{{ payload.issue.body }}"
    }
  ]
}
```

### Top-level fields

| Field | Default | Description |
|---|---|---|
| `port` | `5050` (or `WEBHOOK_PORT`) | TCP port for the listener. |
| `secret` | `GITHUB_WEBHOOK_SECRET` env | HMAC secret. Without one, every delivery is rejected with 503. |
| `timeout_ms` | `1800000` (30 min) | Per-session abort budget. |
| `max_concurrent` | `2` | Concurrency cap across all triggers. |
| `default_cwd` | OpenCode project root | Fallback session cwd when a trigger doesn't override. |
| `db_path` | `${XDG_DATA_HOME or ~/.local/share}/opencode-webhooks/deliveries.sqlite` | SQLite path for delivery dedup. |
| `retention` | `1000` | Max deliveries kept in dedup DB; oldest pruned. |
| `triggers` | `[]` | Array of trigger objects (see below). |

### Trigger fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique per-config; used in logs. |
| `event` | yes | GitHub event header (`issues`, `pull_request`, `*` for any). |
| `action` | no | If set, must match `payload.action` exactly. Omit/`null` = any action. |
| `agent` | yes | OpenCode agent name to invoke. |
| `prompt_template` | yes | Mustache-ish template. `{{ payload.foo.bar }}` looks up paths; missing renders empty. Synthetic `{{ review_state }}` is the lowercased `payload.review.state`. |
| `cwd` | no | Override session cwd. Falls back to `default_cwd`. |
| `enabled` | no | Set `false` to disable a trigger without removing it. |
| `ignore_authors` | no | Skip if `payload.sender.login` matches any entry (case-insensitive). The literal `"$BOT_LOGIN"` is substituted with the resolved bot login. |
| `payload_filter` | no | Object mapping dotted paths → expected values. `"*"` means any non-empty value; other values are scalar equality. AND across keys. |
| `require_bot_match` | no | List of dotted payload paths whose string value must equal the bot's resolved login (case-insensitive). Paths support a `[*]` wildcard (e.g. `requested_reviewers[*].login`). OR across paths. Skips with `bot identity unresolved` if `gh api user` failed at boot (fail-closed). |

## Bot identity

The plugin resolves "the bot" via `gh api user --jq .login` at boot. `gh` reads `GH_TOKEN` from the environment. The resolved login is used for:

- The `require_bot_match` identity gate.
- The `"$BOT_LOGIN"` placeholder substitution in `ignore_authors`.

If `gh` isn't installed or `GH_TOKEN` isn't set, identity-gated triggers refuse to fire (fail-closed). Triggers without `require_bot_match` are unaffected.

> **Soft dependency.** `gh` is the GitHub CLI: <https://cli.github.com>. Install it on the host running OpenCode.

## Environment variables

| Variable | Purpose |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for `X-Hub-Signature-256` verification. Same value you set in GitHub's webhook config. |
| `GH_TOKEN` | GitHub PAT, read by `gh` CLI for `gh api user`. Required for identity-gated triggers. |
| `WEBHOOK_PORT` | Override listener port (default 5050). |
| `WEBHOOKS_CONFIG` | Path to `webhooks.json` (default `~/.config/opencode/webhooks.json`). |

## Health check

```
GET /healthz → 200 { ok: true, plugin: "opencode-webhooks" }
```

## Webhook endpoint

```
POST /webhooks/github
```

Required headers:

- `X-GitHub-Event` — event name (e.g. `issues`).
- `X-GitHub-Delivery` — UUID for dedup.
- `X-Hub-Signature-256` — `sha256=<hex>` HMAC of the raw body using `GITHUB_WEBHOOK_SECRET`.

Returns 200 on accept, 401 on bad signature, 409 on duplicate delivery, 404 on path mismatch, 503 if the listener is starting up or the secret is unconfigured.

## Limitations

- Single-process plugin; shares the OpenCode server's process. An unhandled rejection inside the dispatcher could crash the host server. The plugin installs a top-level `unhandledRejection` handler, but consumers should still pin OpenCode versions.
- One trigger fires per inbound delivery. If multiple triggers' filters match, only the first (by config order) runs.
- No built-in rate limiting beyond `max_concurrent`. A burst of 200 deliveries in a second will queue at the semaphore but not be dropped.
- `bun:sqlite` is required for delivery dedup. The plugin won't run on Node.

## License

MIT — see [LICENSE](./LICENSE).
