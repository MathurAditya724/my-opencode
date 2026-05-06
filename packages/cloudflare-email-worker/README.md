# opencode-cloudflare-email-worker

Cloudflare Email Worker that sits in front of the [`opentower`](../opentower/) plugin. It does two things per inbound email:

1. **Always forwards** the email verbatim to `FORWARD_TO` (your real inbox), if the env var is set. DKIM is preserved via Cloudflare's `message.forward()`.
2. **If the sender matches the D1 `allowed_senders` table**, it builds a JSON event from the email headers and body, HMAC-signs it, and POSTs it to `WEBHOOK_URL` (the plugin's `/webhooks/email` endpoint). The allowlist is managed at runtime via the worker's HTTP API (`GET/POST/DELETE /senders`).

The worker is a **dumb pipe** — the plugin owns identity resolution, dedup, and dispatch.

## Why

GitHub doesn't expose a "send me everything that involves my user" webhook. But it already filters down to "stuff I care about" before sending notification emails — mentions, review requests, assignments, comments on PRs/issues you're involved in, across every repo your account touches. This worker lets you turn that mailbox into an event stream **without** giving up the ability to read the same emails as a human.

## Architecture

```
GitHub  ──email──▶  gh@yourdomain.com
                         │
                         │ Cloudflare Email Routing
                         ▼
                    Email Worker (dumb pipe)
                       ├─ message.forward(FORWARD_TO)        ──▶ your real inbox (always)
                       └─ if From ∈ D1 allowed_senders:
                               POST {headers + body}
                               HMAC-signed application/json
                             │
                             ▼
                   https://your-host/webhooks/email
                        opentower plugin
                        (verify → dedup → dispatch)
```

## Setup

1. **Cloudflare Email Routing**.
   - Cloudflare dashboard → your zone → **Email** → enable Email Routing.
   - Add a destination address (e.g. `gh@yourdomain.com`) and verify it via the email Cloudflare sends.

2. **Configure variables**.

   Two variables are required at runtime:

   | Var | Purpose |
   |---|---|
   | `WEBHOOK_URL` | Public URL of the opentower plugin's email endpoint, e.g. `https://your-opencode.example.com:5050/webhooks/email`. Must be reachable from the Cloudflare worker network. |
   | `FORWARD_TO` | _(optional)_ Destination address for the verbatim forward (e.g. `you@yourdomain.com`). **Must be verified in Cloudflare Email Routing first** (Email Routing → Destination addresses → Add). Unset = no forwarding, webhook still fires. |

   **For local dev (`wrangler dev`)**: copy `.env.example` to `.env` and edit. Wrangler v4 reads `.env` automatically and exposes the keys as worker bindings.

   ```sh
   cp .env.example .env
   $EDITOR .env
   ```

   `.env` is gitignored at the repo root.

   **For production**: set both variables in the Cloudflare dashboard:

   - Workers & Pages → `opencode-email-worker` → **Settings** → **Variables and Secrets** → **Add** (type: Plaintext)
   - Add `WEBHOOK_URL` and (optionally) `FORWARD_TO`.

   Variables set in the dashboard are bound at runtime the same way the local `.env` values are. Code (`env.WEBHOOK_URL`, `env.FORWARD_TO`) is identical across environments.

   The sender allowlist is stored in the D1 `allowed_senders` table and managed at runtime via the worker's HTTP API (bearer-auth protected with `EMAIL_WEBHOOK_SECRET`):
   - `GET /senders` — list (with pagination and search)
   - `POST /senders` — add a pattern (`{"pattern": "...", "kind": "exact"|"regex"}`)
   - `DELETE /senders/:pattern` — remove a pattern
   - `POST /seed` — insert the default seed patterns (`notifications@github.com` + `/^.*@github\.com$/`)

   Exact strings are case-insensitive matches; `/regex/` patterns are case-insensitive regex.

   Logs are enabled in `wrangler.json` via `observability.logs.enabled` so you can `wrangler tail` and see structured output in the dashboard.

3. **Set the shared HMAC secret**:
   ```sh
   wrangler secret put EMAIL_WEBHOOK_SECRET
   ```
   Paste a long random hex string (e.g. `openssl rand -hex 32`). Set the **same** value in your container's environment as `EMAIL_WEBHOOK_SECRET`.

4. **Deploy**:
   - Authenticate first: `wrangler login` (interactive) or set `CLOUDFLARE_API_TOKEN` in your environment.
   ```sh
   bun install
   bun run deploy
   ```

5. **Wire Email Routing → this worker**.
   Cloudflare dashboard → Email Routing → either set the **Catch-all address** to "Send to a Worker" → choose `opencode-email-worker`, or add a specific rule for `gh@yourdomain.com` pointing at the worker.

6. **Add the address to your GitHub account**.
   - GitHub → Settings → Emails → add `gh@yourdomain.com`, verify.
   - Settings → Notifications → set custom routing per-org (or set it as your default email) so notifications land at this address.

7. **Add an email trigger to `webhooks.json`** in the container, e.g.:
   ```json
   {
     "name": "email-event",
     "source": "email",
     "event": ["email.*"],
     "agent": "github-agent",
     "prompt_template": "A GitHub notification arrived via email.\n\nEvent: {{ event }}\nAction: {{ action }}\nDelivery: {{ delivery_id }}\n\nPayload:\n{{ payload }}"
   }
   ```

## Test

- Send yourself a mention/review request from another GitHub account.
- Watch the worker: `bun run tail`. Should log a successful webhook POST and (if `FORWARD_TO` is set) a successful forward.
- Watch the container's stdout. Should log `[opentower] trigger 'email-mention' → session ...`.
- Check your `FORWARD_TO` inbox — the original email should have arrived with DKIM intact.

## Failure modes

| Scenario | Behavior |
|---|---|
| `FORWARD_TO` unset | Skipped, no error. Webhook still fires for allowlisted senders. |
| `FORWARD_TO` set but unverified | `message.forward()` throws — caught and logged; webhook still fires. Verify the address in Cloudflare Email Routing → Destination addresses. |
| Sender not in D1 allowlist | Forward still happens. Webhook is skipped (logged at info). |
| Plugin returns 5xx | Cloudflare retries the email later. Forward already happened, so retries don't double-forward. |
| Plugin returns 4xx (bad signature, dedup, etc.) | Logged, accepted (no retry). Forward already happened. |

## Security model

| Layer | What it does |
|---|---|
| Cloudflare Email Routing | Rejects mail that fails SPF/DKIM/DMARC at the edge before it ever reaches the worker. |
| D1 `allowed_senders` table | Drops any From not in the allowlist (defense vs. spoofs that pass DMARC because the attacker controls `*.github.com`-adjacent domains). |
| `EMAIL_WEBHOOK_SECRET` HMAC | Authenticates the worker → plugin link. Without it, the plugin returns 503. |
| Plugin receives full email body | The worker sends headers + body (up to 512 KB). The agent decides what to do with the content. |
| Self-loop guard | The plugin drops emails whose `x_github_sender` matches the bot's own login. |

## Cost

Cloudflare Email Routing is free for personal use. Email Workers count against your Workers free tier (100k req/day) — for normal GitHub-notification volume this is essentially never a concern.

## Limitations

- Email is a notification stream, not an event stream. You only get what GitHub sends to your inbox: mentions, review requests, assignments, comments on things you're involved in. No `push`, no `check_suite`, no `release`. Use a real webhook (or GitHub App) for those.
- ~10–30s end-to-end latency vs. ~1s for direct webhooks.
- One Cloudflare worker per opentower endpoint. Multi-tenant fan-out isn't supported (yet).

## License

MIT — see [LICENSE](./LICENSE) (inherits the repo root license).
