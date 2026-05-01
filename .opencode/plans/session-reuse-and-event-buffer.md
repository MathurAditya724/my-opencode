# Plan: per-PR session reuse with event buffering

## Goal

Today, every webhook delivery spawns a fresh OpenCode session. Each session
re-explores the codebase from scratch, re-clones the repo, re-reads the
issue. Across the PR lifecycle this means the bot pays the cold-start cost
~10× (open → review → CI fix → comment response → review again → …).

Replace the one-session-per-event model with a **per-PR session** model so:

1. Lore, prior reasoning, and codebase context accumulate across events.
2. The agent can correlate "the comment I'm responding to now" with "the
   review I posted 20 minutes ago" without re-deriving from GitHub.
3. The cold-start tax amortizes — only the first event on a PR pays full
   exploration cost.

Add an **event buffer** so when an event arrives mid-session, the plugin
queues it as a follow-up prompt rather than spawning a parallel session
or rejecting it.

## Decisions (proposed; subject to review)

| Question | Choice |
|---|---|
| Affinity key | PR number (`<owner>/<repo>#<n>`); fallback to issue number for `issues.assigned`; fallback to `<owner>/<repo>@<sha>` for PR-less `check_suite` |
| Migration | When `issues.assigned` resolves into a PR, the issue's session is renamed/relinked to the PR's key |
| Concurrency | One in-flight `session.prompt` per session; subsequent events queue FIFO |
| Persistence | Reuse existing `bun:sqlite` (the `deliveries` DB); add `session_map` and `event_queue` tables |
| Context bound | Session retired after N consecutive idle hours OR PR merged/closed OR token-budget exceeds threshold (TBD) |
| Agent role isolation | Each enqueued event sets the `agent` field on `session.prompt` per its trigger config; the system prompt switches across roles within one session |
| Failure model | Agent run errors don't drop the session — next event reuses it. Session retired only on explicit retire signal (PR closed, idle expiry, manual purge) |

## Architecture

### Components added to `plugins/github-webhooks/`

```
session-affinity.ts   key resolution: payload → session-key
session-store.ts      session_map + event_queue persistence
session-runner.ts     replaces dispatch.ts: lookup-or-create + queue + drain
```

### Affinity key resolution (`session-affinity.ts`)

```ts
type SessionKey = string  // canonical form

function resolveSessionKey(event: string, payload: unknown): SessionKey | null
```

Logic by event:

| Event | Key |
|---|---|
| `pull_request.*` | `<owner>/<repo>#pr<n>` |
| `pull_request_review.*` | `<owner>/<repo>#pr<n>` (from `payload.pull_request.number`) |
| `pull_request_review_comment.*` | `<owner>/<repo>#pr<n>` |
| `issue_comment.*` (PR comment) | `<owner>/<repo>#pr<n>` (from `payload.issue.number`, since on PR-issues these align) |
| `issue_comment.*` (issue-only) | `<owner>/<repo>#issue<n>` |
| `issues.*` | `<owner>/<repo>#issue<n>` |
| `check_suite.*` (with PRs) | `<owner>/<repo>#pr<n>` (from `payload.check_suite.pull_requests[0].number`) |
| `check_suite.*` (no PRs) | `<owner>/<repo>@<sha>` (rare; mostly main-branch CI) |

Migration: when `pull_request.opened` fires and the body contains
`Closes #N` / `Fixes #N` / `Resolves #N`, the plugin checks whether a
session for `<owner>/<repo>#issue<N>` exists. If yes, that session's
key is rewritten to the new PR key (single SQLite UPDATE).

### Session map (`session-store.ts`)

New tables in the existing `deliveries.db`:

```sql
CREATE TABLE IF NOT EXISTS session_map (
  key            TEXT PRIMARY KEY,        -- canonical session key
  session_id     TEXT NOT NULL UNIQUE,    -- OpenCode session id
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER NOT NULL,
  retired_at     INTEGER                  -- NULL = active
);

CREATE INDEX IF NOT EXISTS idx_session_map_last_used
  ON session_map(last_used_at DESC);

CREATE TABLE IF NOT EXISTS event_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key  TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  agent        TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  enqueued_at  INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','running','done','failed'))
);

CREATE INDEX IF NOT EXISTS idx_event_queue_session_status
  ON event_queue(session_key, status, id);
```

API:

```ts
type SessionMap = {
  lookup(key: SessionKey): { sessionId: string; lastUsedAt: number } | null
  create(key: SessionKey, sessionId: string): void
  touch(key: SessionKey): void
  retire(key: SessionKey): void
  retireIdle(olderThanMs: number): SessionKey[]
}

type EventQueue = {
  enqueue(item: QueueItem): number             // returns row id
  nextFor(key: SessionKey): QueueItem | null   // FIFO
  markRunning(id: number): void
  markDone(id: number, status: 'done' | 'failed'): void
  pendingFor(key: SessionKey): number          // count
}
```

### Runner (`session-runner.ts`)

Replaces `dispatch.ts` with a queue-aware variant. One in-memory
mutex per session-key to serialize prompts:

```ts
function makeSessionRunner(opts: {...}): Dispatcher {
  const locks = new Map<SessionKey, Promise<void>>()

  return async function dispatch(t, prompt, deliveryId, payload) {
    const key = resolveSessionKey(t.event, payload)
    if (!key) {
      // No correlatable key — fall back to old single-shot model.
      return legacyDispatch(t, prompt, deliveryId)
    }
    eventQueue.enqueue({
      sessionKey: key,
      triggerName: t.name,
      agent: t.agent,
      prompt,
      deliveryId,
      enqueuedAt: Date.now(),
      status: 'queued',
    })
    // Kick the drainer (no-op if already running for this key).
    drainKey(key)
  }

  async function drainKey(key: SessionKey) {
    if (locks.has(key)) return                    // already draining
    const p = (async () => {
      let item = eventQueue.nextFor(key)
      while (item) {
        eventQueue.markRunning(item.id)
        try {
          const sessionId = await ensureSession(key, item)
          await client.session.prompt({
            path: { id: sessionId },
            body: { agent: item.agent, parts: [{ type: 'text', text: item.prompt }] },
          })
          eventQueue.markDone(item.id, 'done')
          sessionMap.touch(key)
        } catch (err) {
          eventQueue.markDone(item.id, 'failed')
          // continue to next event — don't kill the queue on one failure
          console.error(`[session-runner] item ${item.id} failed:`, err)
        }
        item = eventQueue.nextFor(key)
      }
    })()
    locks.set(key, p)
    try { await p } finally { locks.delete(key) }
  }

  async function ensureSession(key, item) {
    const existing = sessionMap.lookup(key)
    if (existing && !await isSessionRetiredRemotely(existing.sessionId)) {
      return existing.sessionId
    }
    const session = await client.session.create({
      body: { title: `[${key}] ${item.triggerName}` },
      query: { directory: deriveCwd(key) },
    })
    sessionMap.create(key, session.data.id)
    return session.data.id
  }
}
```

`isSessionRetiredRemotely` defends against the case where the OpenCode
host purges a session out from under us (e.g. user manually deleted it).

### Idle reaper

Background timer every hour:

```ts
const retired = sessionMap.retireIdle(MAX_IDLE_MS)
for (const key of retired) {
  console.log(`[session-runner] retired idle session for ${key}`)
}
```

`MAX_IDLE_MS` defaults to **72 hours**. Configurable via `SESSION_IDLE_HOURS`
in the webhook config.

## Migration: issue → PR

When `pull_request.opened` arrives and body contains `Closes #N`:

```ts
const issueKey = `${owner}/${repo}#issue${N}`
const prKey    = `${owner}/${repo}#pr${number}`
if (sessionMap.lookup(issueKey) && !sessionMap.lookup(prKey)) {
  sessionMap.rename(issueKey, prKey)  // UPDATE session_map SET key=? WHERE key=?
}
```

The session that resolved the issue continues seamlessly into reviewing
the PR it produced. This is the highest-value continuity case.

## Open questions / risks

### 1. Context bloat

A long-lived PR with 10+ review rounds can blow past the model's context
window. Options:

- **Auto-summarize** at threshold via OpenCode's existing `session.summarize` API call (need to verify availability).
- **Hard cut**: retire the session at N tokens, start fresh on next event.
- **Manual purge**: agent itself emits a `RETIRE` directive when it senses context is stale, plugin retires the session.

**Proposal**: start with hard-cut at, say, 80% of model max context as
reported by OpenCode. Add summarization as a follow-up if hard-cut proves
disruptive.

### 2. Cross-agent reasoning bias

The same session runs `pr-reviewer` then `pr-comment-responder` on the
same PR. The comment-responder's first turn already has the reviewer's
findings in context. This can be:

- **Good**: the bot doesn't contradict its own prior review.
- **Bad**: the bot agrees with itself even when a human comment surfaces a
  blind spot the reviewer missed.

**Mitigation**: agent prompts already say "this comment may surface things
the prior review missed; treat it on its merits." We rely on the LLM's
own awareness here. If we observe the bias in practice, the escape hatch
is to spawn a fresh sub-agent (via `task` tool) for the comment triage
within the same session, isolating its read pass from the parent's
history.

### 3. Concurrency on the same PR

Two near-simultaneous events on the same PR (e.g. comment + check_suite)
both target the same session-key. The mutex serializes them, but:

- The first event might take 5 minutes (review). The second waits in the
  queue. By the time the second runs, the PR state may have moved.
- Consequence: the agent should always re-read PR state at step 0, not
  trust queued context. Existing agent prompts already do `gh pr view`
  at step 0; adequate.

### 4. Session storage is on the OpenCode host, not in our SQLite

We're storing `(key → sessionId)` mappings, but the session's actual
content lives in OpenCode's per-session storage on disk. A redeploy that
wipes `~/.local/share/opencode/` (e.g. ephemeral rootfs without the
volume) would orphan all our mappings. Need to verify session data is
under `~/dev/.opencode/` (the persistent symlink target — yes, per
docker-entrypoint.sh:21) before relying on persistence claims.

### 5. Manual override

A maintainer should be able to force a fresh session — e.g. when
historical context has gone bad. Add an `X-OpenCode-Session-Reset: true`
header on the webhook delivery? Or a `RETIRE` magic comment on the PR?

**Proposal**: `RETIRE` magic comment is more discoverable. The plugin
checks for `pr-retire-session` in the comment body; if present, retires
the session and dispatches the current event as the start of a fresh one.

## Rollout plan

1. **Phase 1**: ship the session-map + queue infrastructure with a feature
   flag (`SESSION_REUSE_ENABLED=false` by default). Existing single-shot
   dispatch path unchanged.
2. **Phase 2**: enable for `pull_request_review_comment` only. Lowest-risk
   event class — comment-responder already does step-0 state refresh.
3. **Phase 3**: enable for the full PR lifecycle (`pull_request.*`,
   `check_suite.*`, `pull_request_review.*`).
4. **Phase 4**: enable issue→PR migration.

Each phase observes for: context-bloat reports (sessions > 100k tokens),
cross-agent bias incidents, concurrency stalls. Rollback is one env var.

## Out of scope

- Cross-repo session correlation (a PR in repo A that references repo B).
- Sessions surviving across container redeploys *without* the persistent
  volume. The `~/dev` mount is the assumption; without it, this whole
  feature degrades to single-shot.
- Streaming events into a session that's already mid-prompt. Bun's
  `client.session.prompt` is request/response; injecting mid-prompt
  would need OpenCode SDK changes upstream.
- Per-event-class agent-bias mitigation (sub-agent isolation). Deferred
  to follow-up if observed in Phase 2.
