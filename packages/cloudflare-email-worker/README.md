# opencode-cloudflare-email-worker

Cloudflare Email Worker that sits in front of the [`opencode-webhooks`](../opencode-webhooks/) plugin. It does two things per inbound email:

1. **Always forwards** the email verbatim to `FORWARD_TO` (your real inbox), if the env var is set. DKIM is preserved via Cloudflare's `message.forward()`.
2. **If the sender is in `ALLOWED_SENDERS`**, it builds a small JSON event from the headers (`from`, `to`, `subject`, `message_id`, `in_reply_to`, `references`, `list_id`, `x_github_reason`, `x_github_sender`), HMAC-signs it, and POSTs it to `WEBHOOK_URL` (the plugin's `/webhooks/email` endpoint).

The worker is a **dumb pipe** — no header parsing, no body inspection, no allowlist beyond the simple From-address gate. The plugin owns identity resolution (Message-ID → owner/repo/issue#), GitHub API fetches, dedup, and dispatch.

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
                       └─ if From ∈ ALLOWED_SENDERS:
                              POST {from, to, subject,
                                    message_id, in_reply_to,
                                    references, list_id,
                                    x_github_reason,
                                    x_github_sender}
                              HMAC-signed application/json
                            │
                            ▼
                  https://your-host/webhooks/email
                       opencode-webhooks plugin
                       (verify → identify → gh fetch → dispatch)
```

## Setup

1. **Cloudflare Email Routing**.
   - Cloudflare dashboard → your zone → **Email** → enable Email Routing.
   - Add a destination address (e.g. `gh@yourdomain.com`) and verify it via the email Cloudflare sends.

2. **Edit config**.
   - `wrangler.json` → `vars.WEBHOOK_URL` — public URL of your opencode-webhooks endpoint, e.g. `https://your-opencode.example.com:5050/webhooks/email`. Must be reachable from the Cloudflare worker network.
   - `wrangler.json` → `vars.FORWARD_TO` — destination address for the verbatim forward (e.g. `you@yourdomain.com`). **Must be verified in Cloudflare Email Routing first** (Email Routing → Destination addresses → Add). Leave unset (or remove the key) to skip forwarding entirely.
   - `src/index.ts` → `ALLOWED_SENDERS` — TypeScript const at the top of the file. Exact strings are case-insensitive matches; strings of the form `/regex/` are treated as case-insensitive regex. Default allows `notifications@github.com` and any `*@github.com`. Compiles once at module load (zero per-request overhead).
   - `wrangler.json` → `observability.logs.enabled` — set to `true` (default in this repo) so you can `wrangler tail` and see structured logs in the Cloudflare dashboard.

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
     "name": "email-mention",
     "source": "email",
     "event": "email.mention",
     "agent": "pr-comment-responder",
     "prompt_template": "Mention via email on {{ payload.repository.full_name }}#{{ payload.issue.number }}{{ payload.pull_request.number }} — triage and respond."
   }
   ```

## Test

- Send yourself a mention/review request from another GitHub account.
- Watch the worker: `bun run tail`. Should log a successful webhook POST and (if `FORWARD_TO` is set) a successful forward.
- Watch the container's stdout. Should log `[opencode-webhooks] trigger 'email-mention' → session ...`.
- Check your `FORWARD_TO` inbox — the original email should have arrived with DKIM intact.

## Failure modes

| Scenario | Behavior |
|---|---|
| `FORWARD_TO` unset | Skipped, no error. Webhook still fires for allowlisted senders. |
| `FORWARD_TO` set but unverified | `message.forward()` throws — caught and logged; webhook still fires. Verify the address in Cloudflare Email Routing → Destination addresses. |
| Sender not in `ALLOWED_SENDERS` | Forward still happens. Webhook is skipped (logged at info). |
| Plugin returns 5xx | Cloudflare retries the email later. Forward already happened, so retries don't double-forward. |
| Plugin returns 4xx (bad signature, dedup, etc.) | Logged, accepted (no retry). Forward already happened. |

## Security model

| Layer | What it does |
|---|---|
| Cloudflare Email Routing | Rejects mail that fails SPF/DKIM/DMARC at the edge before it ever reaches the worker. |
| Worker `ALLOWED_SENDERS` | Drops any From not in the allowlist (defense vs. spoofs that pass DMARC because the attacker controls `*.github.com`-adjacent domains). |
| `EMAIL_WEBHOOK_SECRET` HMAC | Authenticates the worker → plugin link. Without it, the plugin returns 503. |
| Plugin re-checks `email_allowed_senders` | Same allowlist applied server-side as defense in depth (and lets you tighten without redeploying the worker). |
| Plugin never sees the body | The worker only sends the headers it cares about — never the body. The canonical issue/PR/comment is fetched from the GitHub API instead. Eliminates prompt-injection from email content. |
| Self-loop guard | The plugin drops emails whose `x_github_sender` matches the bot's own login. |

## Cost

Cloudflare Email Routing is free for personal use. Email Workers count against your Workers free tier (100k req/day) — for normal GitHub-notification volume this is essentially never a concern.

## Limitations

- Email is a notification stream, not an event stream. You only get what GitHub sends to your inbox: mentions, review requests, assignments, comments on things you're involved in. No `push`, no `check_suite`, no `release`. Use a real webhook (or GitHub App) for those.
- ~10–30s end-to-end latency vs. ~1s for direct webhooks.
- One Cloudflare worker per opencode-webhooks endpoint. Multi-tenant fan-out isn't supported (yet).

## License

MIT — see [LICENSE](./LICENSE) (inherits the repo root license).
