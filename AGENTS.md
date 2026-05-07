<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Architecture

<!-- lore:019e00de-f55a-7c50-9b12-4ea9f3e69318 -->
* **opentower handler.ts: CORS scoped to /api/\* by default, not global**: Prior to the CORS fix, \`hono/cors\` was only applied to \`/api/\*\` routes, leaving \`/healthz\` inaccessible from browser origins. The correct pattern is to register \`app.use('\*', cors({...}))\` as the first middleware before \`app.onError\` and before any route. \`allowMethods\` must include \`POST\` for webhook routes if browser preflight checks are needed.

### Gotcha

<!-- lore:019e00de-f555-75cf-90a0-b08a79b4474b -->
* **Hono middleware registration order: /healthz bypasses app.use('\*') registered after it**: In \`handler.ts\`, \`/healthz\` is registered before \`app.use('\*', ...)\` middleware. Hono evaluates routes/middleware in registration order — any middleware registered after a matched route won't run for that route. To apply CORS (or any global middleware) to ALL routes including \`/healthz\`, register it before any route definitions, as the very first call on the \`app\` instance.
<!-- End lore-managed section -->
