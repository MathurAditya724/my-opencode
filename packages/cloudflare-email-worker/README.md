# opencode-cloudflare-email-worker

Cloudflare Email Worker that forwards GitHub notification emails to the [`opencode-webhooks`](../opencode-webhooks/) plugin's `POST /webhooks/email` endpoint.

This is the **email ingest path**. The plugin parses RFC822 headers, identifies the referenced GitHub issue/PR via `Message-ID`, fetches canonical state via `gh`, and dispatches to OpenCode agents — same shape as a real GitHub webhook.

## Why

GitHub doesn't expose a "send me everything that involves my user" webhook. But it already filters down to "stuff I care about" before sending notification emails — mentions, review requests, assignments, comments on PRs/issues you're involved in, across every repo your account touches. This worker lets you turn that mailbox into an event stream.

## Architecture

```
GitHub  ──email──▶  gh@yourdomain.com
                         │
                         │ Cloudflare Email Routing
                         ▼
                    Email Worker
                       ├─ allowlist (static + /regex/)
                       └─ HMAC-sign + POST
                            │
                            ▼
                  https://your-host/webhooks/email
                       opencode-webhooks plugin
                       (parse → synthesize → dispatch)
```

## Setup

1. **Cloudflare Email Routing**.
   - Cloudflare dashboard → your zone → **Email** → enable Email Routing.
   - Add a destination address (e.g. `gh@yourdomain.com`) and verify it via the email Cloudflare sends.

2. **Edit `wrangler.toml`**.
   - `ALLOWED_SENDERS` — JSON-encoded string array. Exact strings are case-insensitive matches; strings of the form `/regex/` are treated as case-insensitive regex. Default allows `notifications@github.com` and any `*@github.com`.
   - `SIDECAR_URL` — public URL of your opencode-webhooks endpoint, e.g. `https://your-opencode.example.com:5050/webhooks/email`. Must be reachable from the Cloudflare worker network.

3. **Set the shared HMAC secret**:
   ```sh
   wrangler secret put EMAIL_WEBHOOK_SECRET
   ```
   Paste a long random hex string (e.g. `openssl rand -hex 32`). Set the **same** value in your container's environment as `EMAIL_WEBHOOK_SECRET`.

4. **Deploy**:
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
     "name": "email-mention",
     "source": "email",
     "event": "email.mention",
     "agent": "pr-comment-responder",
     "prompt_template": "Mention via email on {{ payload.repository.full_name }}#{{ payload.issue.number }}{{ payload.pull_request.number }} — triage and respond."
   }
   ```

## Test

- Send yourself a mention/review request from another GitHub account.
- Watch the worker: `bun run tail`. Should log a successful POST.
- Watch the container's stdout. Should log `[opencode-webhooks] trigger 'email-mention' → session ...`.

## Security model

| Layer | What it does |
|---|---|
| Cloudflare Email Routing | Rejects mail that fails SPF/DKIM/DMARC at the edge before it ever reaches the worker. |
| Worker `ALLOWED_SENDERS` | Drops any From not in the allowlist (defense vs. spoofs that pass DMARC because the attacker controls `*.github.com`-adjacent domains). |
| `EMAIL_WEBHOOK_SECRET` HMAC | Authenticates the worker → plugin link. Without it, the plugin returns 503. |
| Plugin re-checks `email_allowed_senders` | Same allowlist applied server-side as defense in depth (and lets you tighten without redeploying the worker). |
| Plugin never reads body | The email body never reaches the LLM. Only RFC822 headers (Message-ID, X-GitHub-*) drive routing; the canonical issue/PR/comment is fetched from the GitHub API. Eliminates prompt-injection from email content. |
| Self-loop guard | The plugin drops emails whose `X-GitHub-Sender` matches the bot's own login. |

## Cost

Cloudflare Email Routing is free for personal use. Email Workers count against your Workers free tier (100k req/day) — for normal GitHub-notification volume this is essentially never a concern.

## Limitations

- Email is a notification stream, not an event stream. You only get what GitHub sends to your inbox: mentions, review requests, assignments, comments on things you're involved in. No `push`, no `check_suite`, no `release`. Use a real webhook (or GitHub App) for those.
- ~10–30s end-to-end latency vs. ~1s for direct webhooks.
- One Cloudflare worker per opencode-webhooks endpoint. Multi-tenant fan-out isn't supported (yet).

## License

MIT — see [LICENSE](./LICENSE) (inherits the repo root license).
