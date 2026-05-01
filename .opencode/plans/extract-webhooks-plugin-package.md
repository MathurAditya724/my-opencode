# Plan: extract github-webhooks plugin as a reusable package

## Goal

Today the plugin lives at `plugins/github-webhooks.ts` + `plugins/github-webhooks/*.ts` inside this repo. It's tightly scoped to the image's filesystem layout and isn't easily consumable by other OpenCode users.

Restructure as a publishable npm package under `packages/opencode-webhooks/` (monorepo layout), so:

1. Other OpenCode users can `bun add opencode-webhooks` and add it to their `plugin: [...]` array, like they do with `@loreai/opencode`.
2. This image continues to consume it locally (via a workspace/file dep) — no behavior change for the existing deployment.
3. Path defaults that assumed `~/dev/.opencode/...` are configurable with sensible non-image-specific fallbacks.

## Decisions

| Question | Choice |
|---|---|
| Distribution | npm package, same monorepo (under `packages/`) |
| Decoupling scope | Paths only — keep `gh` CLI as the bot-identity source |
| Layout | Move everything into `packages/opencode-webhooks/` and delete the old `plugins/github-webhooks*` files |
| License | MIT (matches lore) |
| Versioning | `0.1.0` initial; publishing workflow deferred to follow-up |
| Internal consumption | `file:` dep from `opencode-config-package.json` |
| Default DB path | `~/.local/share/opencode-webhooks/deliveries.sqlite` (XDG-ish), still overridable |
| Bot identity | unchanged: `gh api user`, fail-soft if missing |
| Peer deps | `@opencode-ai/plugin` as a peer (consumer pins the OpenCode version) |

## File layout after extraction

```
packages/opencode-webhooks/
├── package.json                         # name, version, deps, peer deps, exports
├── tsconfig.json                        # strict, ESM, bun types
├── README.md                            # install + config + trigger schema
├── LICENSE                              # MIT
├── src/
│   ├── index.ts                         # exports default GitHubWebhooksPlugin (was plugins/github-webhooks.ts)
│   ├── bot-identity.ts                  # unchanged
│   ├── config.ts                        # readWebhookConfig, normalizeTrigger
│   ├── dispatch.ts                      # makeDispatcher
│   ├── handler.ts                       # makeFetchHandler
│   ├── hmac.ts                          # verifyHmac
│   ├── matchers.ts                      # findMatching, etc.
│   ├── semaphore.ts                     # makeSemaphore, makeDrainCounter
│   ├── storage.ts                       # openDeliveryStore
│   ├── template.ts                      # render(prompt_template, payload)
│   └── types.ts                         # Trigger, WebhookConfig, etc.
```

No build step — package ships raw `.ts` files (matches `@loreai/opencode`'s pattern). `package.json`'s `main`/`exports`/`types` all point at `./src/index.ts`. Bun and OpenCode handle TS natively.

Repo root after extraction:
- `plugins/github-webhooks.ts` — **deleted**
- `plugins/github-webhooks/` — **deleted**
- `webhooks.json` — **stays** (image's deployment-specific trigger config)
- `agents/*.md` — **stay** (image's bundled agents)
- `opencode-config-package.json` — adds `"opencode-webhooks": "file:../../packages/opencode-webhooks"` (path resolves at install-time relative to the package being installed; we install from `~/.config/opencode/`, so the reference is to `packages/...` in the image's workdir)
- `opencode-user-config.json` — adds `"file:///home/developer/.config/opencode/node_modules/opencode-webhooks"` to the `plugin` array

## Key changes from current plugin

### 1. Default DB path

Was: `~/dev/.opencode/github-webhooks.sqlite` (assumes `~/dev` symlink exists)
Now: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-webhooks/deliveries.sqlite`

In this image, the existing `db_path: "/home/developer/dev/.opencode/github-webhooks.sqlite"` (or equivalent) will be set explicitly in `webhooks.json` to preserve persistence on the existing volume layout. New consumers get the XDG default automatically.

### 2. Default config-file path

Currently `~/.config/opencode/webhooks.json` (already XDG-aligned). No change.

### 3. Plugin name in logs

Was: `[github-webhooks]`
Now: `[opencode-webhooks]` (matches the package name; clearer for consumers reading logs from multiple plugins)

### 4. Imports in `src/index.ts`

Currently uses relative imports like `./github-webhooks/bot-identity`. Becomes `./bot-identity` (one level shallower since the package is its own root).

### 5. Type exports

Re-export `Trigger`, `WebhookConfig`, `NormalizedTrigger` from `index.ts` so consumers can author config-generators in TS with type safety.

## What does NOT change

- `webhooks.json` schema — stays the same. Existing consumers' configs work unchanged.
- HMAC verification, identity gating, payload filters, prompt templating — bit-identical behavior.
- Bot identity resolution via `gh api user` — unchanged. Documented as a soft dependency in the README ("install gh and set GH_TOKEN, or live without identity-gated triggers").
- Agent dispatch via `client.session.create` + `client.session.prompt` — unchanged.
- All four migrated tests in the existing plugin (none currently — there are no tests; we're not adding any in this PR but the structure makes them addable later).

## Internal-consumption flow (this image, after the change)

1. `Dockerfile` `COPY packages/ /home/developer/.config/opencode/packages/` (new line) before the `bun install` step.
2. `opencode-config-package.json` declares `"opencode-webhooks": "file:./packages/opencode-webhooks"`.
3. `bun install` resolves the local file dep into `~/.config/opencode/node_modules/opencode-webhooks/`.
4. `opencode-user-config.json`'s `plugin` array references `file://.../node_modules/opencode-webhooks` (mirrors the existing `@loreai/opencode` entry).
5. Plugin loads at OpenCode startup. Reads `~/.config/opencode/webhooks.json` (unchanged path). Behavior identical.

## External-consumption flow (other users, after publishing)

```jsonc
// in their ~/.config/opencode/package.json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.30",
    "opencode-webhooks": "^0.1.0"
  }
}
```

```jsonc
// in their ~/.config/opencode/opencode.json
{
  "plugin": [
    "opencode-webhooks"
  ]
}
```

Plus a `webhooks.json` they author from the README's example config. Plus `GITHUB_WEBHOOK_SECRET` and (optionally) `GH_TOKEN` in env.

## README outline (new file in the package)

1. **What it does** — 2-paragraph elevator pitch. Receives GitHub webhooks, dispatches to OpenCode agents.
2. **Install** — `bun add opencode-webhooks`, plus add to `plugin: [...]`.
3. **Config** — `webhooks.json` schema reference. Link to the existing image's `webhooks.json` as a working example.
4. **Env vars** — `GITHUB_WEBHOOK_SECRET` (required), `GH_TOKEN` (recommended), `WEBHOOK_PORT` (default 5050), `WEBHOOKS_CONFIG` (path override).
5. **Triggers** — list of supported `event.action` pairs and what fields are gated on what.
6. **Identity gating** — explain `require_bot_match` + `ignore_authors` + `$BOT_LOGIN` substitution.
7. **Limitations** — soft deps on `gh` CLI; no built-in rate limiting beyond `max_concurrent`; one-process plugin sharing OpenCode's process.
8. **License** — MIT.

Most of this prose can be lifted from the my-opencode README's existing webhook section (which already documents all the surfaces in a consumer-friendly way).

## Open questions

### 1. Should the package include reference agent prompts?

The agents in `agents/*.md` (pr-reviewer, ci-fixer, etc.) are *examples* of what to put in your OpenCode agents directory. They're not part of the plugin — but external users wanting to replicate this setup will need them.

**Proposal**: link from the README to `agents/` in this repo as a reference. Don't bundle them in the package — that's scope creep and would force a release to update agent prompts.

### 2. What about the plugin currently doing `~/dev/.opencode/github-webhooks.sqlite`?

For the image to keep its existing DB intact across the change, `webhooks.json` will need to gain an explicit `"db_path": "/home/developer/dev/.opencode/github-webhooks.sqlite"` line. Without this, on first boot after the change, the plugin will create a *new* DB at the XDG default and lose dedup history (~1000 entries).

**Proposal**: include the explicit `db_path` in this PR's `webhooks.json` change so the cutover is seamless.

### 3. Publishing workflow

Out of scope for this PR. Track as a follow-up: GitHub Actions on tag push, `npm publish --access public`, version managed via `npm version <bump>` + `git push --follow-tags`. Could use `changesets` if we expect frequent updates.

### 4. Bun-specific APIs

The plugin uses `Bun.serve`, `Bun.spawn`, `bun:sqlite`, `Bun.file`. These are runtime-locked to Bun. OpenCode itself runs Bun, so this is fine — but document it in the README so consumers don't try to use this with Node-based forks.

**Proposal**: README has a "Runtime: Bun ≥ 1.0" line up top.

### 5. Semantic version commitment

`0.1.0` signals "API may change without notice." Drop to `1.0.0` once the config schema is committed-to. We're at the right level for now.

## Out of scope for this PR

- npm publishing workflow.
- Tests (the original plugin has none; adding now would inflate the diff).
- Schema validation of `webhooks.json` (currently structural; adding zod would change behavior subtly).
- Migration tooling for existing deliveries DB (`db_path` override handles it).
- Decoupling `gh` CLI dependency (your call: keep as-is).
- Replacing `Bun.serve` with a Node-compatible alternative.
- Splitting `bot-identity.ts` into pluggable backends (octokit, gh, env-var, etc.).

## Follow-up: simplify config after npm publish

Per OpenCode docs, once `opencode-webhooks` is published to npm, the cleaner config form is:

```jsonc
{ "plugin": ["opencode-webhooks"] }
```

OpenCode auto-installs into `~/.cache/opencode/node_modules/` — no manual `bun install` needed. After publish, we can:

1. Drop `"opencode-webhooks": "file:./packages/opencode-webhooks"` from `opencode-config-package.json`.
2. Replace the absolute `file://` URL in `opencode-user-config.json` with the bare name `"opencode-webhooks"`.
3. Skip the `COPY packages/` Dockerfile step.

Out of scope for this PR — needed for testing the in-repo development cycle anyway. Track as a follow-up alongside the npm publish workflow.

## Rollout

This is a one-shot move (no feature flag). The path is:

1. Create `packages/opencode-webhooks/` skeleton with `package.json`, `tsconfig.json`, `LICENSE`, `README.md`.
2. `git mv` the existing `plugins/github-webhooks.ts` → `packages/.../src/index.ts` and `plugins/github-webhooks/*.ts` → `packages/.../src/*.ts`.
3. Update relative imports inside `src/`.
4. Update `opencode-config-package.json` to declare the new dep.
5. Update `opencode-user-config.json`'s `plugin` array.
6. Update `Dockerfile` to copy `packages/` and re-run `bun install`.
7. Update `webhooks.json` to include explicit `db_path` (preserve existing volume).
8. Run a local boot test (build the image, hit the webhook endpoint with a fake delivery, verify the plugin loads from the new path).
9. Update repo README to point at the package's README for the canonical config docs.

If step 8 reveals issues, fall back to a shim file (Option A from initial design) — but only as a contingency.

## Risks

- **OpenCode plugin loader behavior**. Need to verify OpenCode's `plugin: [...]` array correctly resolves a `file://` URL pointing at a `node_modules/...` directory containing both an ESM `dist/index.js` and a `package.json` with `"main"` / `"exports"`. The lore plugin uses this pattern, so it should work — but worth confirming during step 8.
- **bun-install resolution of local deps**. `file:./packages/...` from `~/.config/opencode/` resolves relative to the consumer's package.json. In the image, the relative path needs to be correct *after* the COPY. May need to use an absolute path or restructure.
- **Path persistence on cutover**. Per open question 2 above — without an explicit `db_path` in `webhooks.json`, the existing dedup DB is orphaned. Manageable but worth flagging.
