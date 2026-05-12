// SQLite-backed lifecycle store. Tracks entity→session mappings so the
// same opencode session can be reused across the full lifecycle of an
// issue or PR -- even across container restarts and issue→PR transitions.
//
// Schema:
//   entities  – one row per entity key (owner/repo#N). Holds the
//               opencode session ID currently working on that entity.
//   links     – connects related entity keys (e.g. issue #42 → PR #43
//               that fixes it) so they share a session.
//   dispatches – audit log of every dispatch for debugging.
//   cron_jobs – scheduled tasks that trigger agent prompts.
//   cron_executions – execution history for cron jobs.

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type EntityRow = {
  entity_key: string
  repo: string
  number: number
  kind: "issue" | "pull_request"
  session_id: string
  share_url: string | null
  cwd: string | null
  agent: string
  created_at: string
  updated_at: string
}

export type LinkRow = {
  source_key: string
  target_key: string
  relation: string
  created_at: string
}

export type DispatchRow = {
  id: string
  entity_key: string | null
  session_id: string | null
  share_url: string | null
  cwd: string | null
  trigger_name: string
  event: string
  delivery_id: string
  status: "started" | "completed" | "failed" | "timeout"
  created_at: string
  completed_at: string | null
}

export type StatsResult = {
  total_entities: number
  total_dispatches: number
  status_counts: Record<string, number>
  recent_24h: number
}

export type CronJobRow = {
  id: string
  name: string
  cron_expression: string
  prompt: string
  entity_key: string | null
  agent: string
  timezone: string
  enabled: number
  run_once: number
  created_by: string
  created_at: string
  updated_at: string
  last_run_at: string | null
  next_run_at: string | null
}

export type CronExecutionRow = {
  id: string
  cron_job_id: string
  dispatch_id: string | null
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  scheduled_at: string
  started_at: string | null
  completed_at: string | null
}

export type LifecycleStore = {
  upsertEntity(
    row: Pick<EntityRow, "entity_key" | "repo" | "number" | "kind" | "session_id" | "share_url" | "cwd" | "agent">,
  ): void
  deleteEntity(entityKey: string): void
  // Resolve session by entity key, checking links and optionally linked
  // issues. The linkedIssueKeys are issue entity keys (e.g. "owner/repo#42")
  // extracted from a PR body — if no session is found for the PR itself,
  // we check these issues for existing sessions to enable PR→issue affinity.
  resolveSession(entityKey: string, linkedIssueKeys?: string[]): EntityRow | null

  addLink(sourceKey: string, targetKey: string, relation: string): void

  insertDispatch(
    row: Omit<DispatchRow, "created_at" | "completed_at" | "share_url" | "cwd"> & {
      share_url?: string | null
      cwd?: string | null
    },
  ): void
  updateDispatchSession(id: string, sessionId: string, shareUrl: string | null): void
  completeDispatch(id: string, status: "completed" | "failed" | "timeout"): void

  // Query methods for the dashboard API.
  listEntities(opts?: { limit?: number; cursor?: string; repo?: string }): {
    entities: EntityRow[]
    next_cursor: string | null
  }
  getEntity(entityKey: string): EntityRow | null
  getEntityDispatches(entityKey: string): DispatchRow[]
  getEntityLinks(entityKey: string): LinkRow[]
  listDispatches(opts?: { limit?: number; cursor?: string; status?: string; event?: string }): {
    dispatches: DispatchRow[]
    next_cursor: string | null
  }
  getStats(): StatsResult

  // Cron job methods
  createCronJob(
    job: Pick<
      CronJobRow,
      "id" | "name" | "cron_expression" | "prompt" | "entity_key" | "agent" | "timezone" | "run_once" | "created_by"
    > & { next_run_at?: string | null },
  ): void
  updateCronJob(
    id: string,
    updates: Partial<Pick<CronJobRow, "name" | "cron_expression" | "prompt" | "entity_key" | "agent" | "timezone">> & {
      enabled?: boolean
      next_run_at?: string | null
    },
  ): void
  deleteCronJob(id: string): void
  getCronJob(id: string): CronJobRow | null
  getCronJobByName(name: string): CronJobRow | null
  listCronJobs(opts?: { limit?: number; cursor?: string; enabled?: boolean }): {
    jobs: CronJobRow[]
    next_cursor: string | null
  }
  listEnabledCronJobs(): CronJobRow[]
  updateCronJobLastRun(id: string, lastRunAt: string, nextRunAt: string | null): void
  disableCronJob(id: string): void

  // Cron execution methods
  insertCronExecution(row: Pick<CronExecutionRow, "id" | "cron_job_id" | "scheduled_at" | "status">): void
  updateCronExecution(
    id: string,
    updates: Partial<Pick<CronExecutionRow, "dispatch_id" | "status" | "started_at" | "completed_at">>,
  ): void
  listCronExecutions(jobId: string, opts?: { limit?: number }): CronExecutionRow[]

  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  entity_key TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('issue', 'pull_request')),
  session_id TEXT NOT NULL,
  share_url  TEXT,
  cwd        TEXT,
  agent      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS links (
  source_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  relation   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_key, target_key)
);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_key);

CREATE TABLE IF NOT EXISTS dispatches (
  id           TEXT PRIMARY KEY,
  entity_key   TEXT,
  session_id   TEXT,
  share_url    TEXT,
  cwd          TEXT,
  trigger_name TEXT NOT NULL,
  event        TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'started',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatches_entity ON dispatches(entity_key);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  cron_expression TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  entity_key      TEXT,
  agent           TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  enabled         INTEGER NOT NULL DEFAULT 1,
  run_once        INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_at     TEXT,
  next_run_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at);

CREATE TABLE IF NOT EXISTS cron_executions (
  id           TEXT PRIMARY KEY,
  cron_job_id  TEXT NOT NULL,
  dispatch_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT NOT NULL,
  started_at   TEXT,
  completed_at TEXT,
  FOREIGN KEY (cron_job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cron_executions_job ON cron_executions(cron_job_id);
`

export function openLifecycleStore(dbPath: string): LifecycleStore {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(SCHEMA)

  // Migration: add share_url column to existing databases.
  try {
    db.exec("ALTER TABLE entities ADD COLUMN share_url TEXT")
  } catch {
    // Column already exists — ignore.
  }
  try {
    db.exec("ALTER TABLE dispatches ADD COLUMN share_url TEXT")
  } catch {
    // Column already exists — ignore.
  }
  // Migration: add cwd column to existing databases.
  try {
    db.exec("ALTER TABLE entities ADD COLUMN cwd TEXT")
  } catch {
    // Column already exists — ignore.
  }
  try {
    db.exec("ALTER TABLE dispatches ADD COLUMN cwd TEXT")
  } catch {
    // Column already exists — ignore.
  }

  const stmts = {
    getEntity: db.prepare<EntityRow, [string]>("SELECT * FROM entities WHERE entity_key = ?"),
    upsertEntity: db.prepare(
      `INSERT INTO entities (entity_key, repo, number, kind, session_id, share_url, cwd, agent)
       VALUES ($entity_key, $repo, $number, $kind, $session_id, $share_url, $cwd, $agent)
       ON CONFLICT(entity_key) DO UPDATE SET
         session_id = excluded.session_id,
         share_url  = COALESCE(excluded.share_url, entities.share_url),
         cwd        = COALESCE(excluded.cwd, entities.cwd),
         kind       = CASE WHEN excluded.kind = 'pull_request' THEN 'pull_request' ELSE entities.kind END,
         agent      = excluded.agent,
         updated_at = datetime('now')`,
    ),
    deleteEntity: db.prepare("DELETE FROM entities WHERE entity_key = ?"),

    addLink: db.prepare(
      `INSERT OR IGNORE INTO links (source_key, target_key, relation)
       VALUES ($source_key, $target_key, $relation)`,
    ),
    getLinksBySource: db.prepare<LinkRow, [string]>("SELECT * FROM links WHERE source_key = ?"),
    getLinksByTarget: db.prepare<LinkRow, [string]>("SELECT * FROM links WHERE target_key = ?"),

    insertDispatch: db.prepare(
      `INSERT INTO dispatches (id, entity_key, session_id, share_url, cwd, trigger_name, event, delivery_id, status)
       VALUES ($id, $entity_key, $session_id, $share_url, $cwd, $trigger_name, $event, $delivery_id, $status)`,
    ),
    updateDispatchSession: db.prepare(
      `UPDATE dispatches SET session_id = $session_id, share_url = $share_url
       WHERE id = $id`,
    ),
    completeDispatch: db.prepare(
      `UPDATE dispatches SET status = $status, completed_at = datetime('now')
       WHERE id = $id`,
    ),

    getEntityDispatches: db.prepare<DispatchRow, [string]>(
      "SELECT * FROM dispatches WHERE entity_key = ? ORDER BY created_at DESC",
    ),

    statsTotalEntities: db.prepare<{ c: number }, []>("SELECT COUNT(*) as c FROM entities"),
    statsTotalDispatches: db.prepare<{ c: number }, []>("SELECT COUNT(*) as c FROM dispatches"),
    statsRecent24h: db.prepare<{ c: number }, []>(
      "SELECT COUNT(*) as c FROM dispatches WHERE created_at > datetime('now', '-1 day')",
    ),
    statsStatusCounts: db.prepare<{ status: string; c: number }, []>(
      "SELECT status, COUNT(*) as c FROM dispatches GROUP BY status",
    ),

    // Cron job statements
    createCronJob: db.prepare(
      `INSERT INTO cron_jobs (id, name, cron_expression, prompt, entity_key, agent, timezone, run_once, created_by, next_run_at)
       VALUES ($id, $name, $cron_expression, $prompt, $entity_key, $agent, $timezone, $run_once, $created_by, $next_run_at)`,
    ),
    getCronJob: db.prepare<CronJobRow, [string]>("SELECT * FROM cron_jobs WHERE id = ?"),
    getCronJobByName: db.prepare<CronJobRow, [string]>("SELECT * FROM cron_jobs WHERE name = ?"),
    deleteCronJob: db.prepare("DELETE FROM cron_jobs WHERE id = ?"),
    listEnabledCronJobs: db.prepare<CronJobRow, []>("SELECT * FROM cron_jobs WHERE enabled = 1"),
    updateCronJobLastRun: db.prepare(
      `UPDATE cron_jobs SET last_run_at = $last_run_at, next_run_at = $next_run_at, updated_at = datetime('now')
       WHERE id = $id`,
    ),
    disableCronJob: db.prepare("UPDATE cron_jobs SET enabled = 0, updated_at = datetime('now') WHERE id = ?"),

    // Cron execution statements
    insertCronExecution: db.prepare(
      `INSERT INTO cron_executions (id, cron_job_id, scheduled_at, status)
       VALUES ($id, $cron_job_id, $scheduled_at, $status)`,
    ),
    listCronExecutions: db.prepare<CronExecutionRow, [string, number]>(
      "SELECT * FROM cron_executions WHERE cron_job_id = ? ORDER BY scheduled_at DESC LIMIT ?",
    ),
  }

  // Helper to run raw SQL for dynamic queries (pagination with cursor).
  function queryEntities(limit: number, cursor: string | null, repo: string | null): EntityRow[] {
    let sql = "SELECT * FROM entities"
    const conditions: string[] = []
    const params: Record<string, string | number> = {}
    if (cursor) {
      conditions.push("updated_at < $cursor")
      params.$cursor = cursor
    }
    if (repo) {
      conditions.push("repo = $repo")
      params.$repo = repo
    }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`
    sql += " ORDER BY updated_at DESC LIMIT $limit"
    params.$limit = limit + 1
    return db.prepare<EntityRow, Record<string, string | number>>(sql).all(params)
  }

  function queryDispatches(
    limit: number,
    cursor: string | null,
    status: string | null,
    event: string | null,
  ): DispatchRow[] {
    let sql = "SELECT * FROM dispatches"
    const conditions: string[] = []
    const params: Record<string, string | number> = {}
    if (cursor) {
      conditions.push("created_at < $cursor")
      params.$cursor = cursor
    }
    if (status) {
      conditions.push("status = $status")
      params.$status = status
    }
    if (event) {
      conditions.push("event = $event")
      params.$event = event
    }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`
    sql += " ORDER BY created_at DESC LIMIT $limit"
    params.$limit = limit + 1
    return db.prepare<DispatchRow, Record<string, string | number>>(sql).all(params)
  }

  function queryCronJobs(limit: number, cursor: string | null, enabled: boolean | null): CronJobRow[] {
    let sql = "SELECT * FROM cron_jobs"
    const conditions: string[] = []
    const params: Record<string, string | number> = {}
    if (cursor) {
      conditions.push("created_at < $cursor")
      params.$cursor = cursor
    }
    if (enabled !== null) {
      conditions.push("enabled = $enabled")
      params.$enabled = enabled ? 1 : 0
    }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`
    sql += " ORDER BY created_at DESC LIMIT $limit"
    params.$limit = limit + 1
    return db.prepare<CronJobRow, Record<string, string | number>>(sql).all(params)
  }

  return {
    upsertEntity(row) {
      stmts.upsertEntity.run({
        $entity_key: row.entity_key,
        $repo: row.repo,
        $number: row.number,
        $kind: row.kind,
        $session_id: row.session_id,
        $share_url: row.share_url,
        $cwd: row.cwd ?? null,
        $agent: row.agent,
      })
    },

    deleteEntity(entityKey) {
      stmts.deleteEntity.run(entityKey)
    },

    // Walk links to find an existing session. If entityKey itself has
    // a session, return it. Otherwise check linked entities (both
    // directions) for a session — this lets an issue and its fixing PR
    // share the same session.
    //
    // Also checks linkedIssueKeys (issue keys extracted from PR body)
    // for existing sessions — this handles the case where a PR event
    // arrives before any link is persisted (e.g., first email about a
    // new PR that fixes an existing issue).
    resolveSession(entityKey, linkedIssueKeys) {
      const direct = stmts.getEntity.get(entityKey)
      if (direct) return direct

      // Check links where this entity is the source
      const asSource = stmts.getLinksBySource.all(entityKey)
      for (const link of asSource) {
        const target = stmts.getEntity.get(link.target_key)
        if (target) return target
      }

      // Check links where this entity is the target
      const asTarget = stmts.getLinksByTarget.all(entityKey)
      for (const link of asTarget) {
        const source = stmts.getEntity.get(link.source_key)
        if (source) return source
      }

      // Check linked issue keys from PR body — these are issues that
      // the PR references via "Fixes #N" etc. If any of those issues
      // have an existing session, reuse it for the PR.
      if (linkedIssueKeys && linkedIssueKeys.length > 0) {
        for (const issueKey of linkedIssueKeys) {
          const issueEntity = stmts.getEntity.get(issueKey)
          if (issueEntity) return issueEntity
        }
      }

      return null
    },

    addLink(sourceKey, targetKey, relation) {
      stmts.addLink.run({
        $source_key: sourceKey,
        $target_key: targetKey,
        $relation: relation,
      })
    },

    insertDispatch(row) {
      stmts.insertDispatch.run({
        $id: row.id,
        $entity_key: row.entity_key,
        $session_id: row.session_id,
        $share_url: row.share_url ?? null,
        $cwd: row.cwd ?? null,
        $trigger_name: row.trigger_name,
        $event: row.event,
        $delivery_id: row.delivery_id,
        $status: row.status,
      })
    },

    updateDispatchSession(id, sessionId, shareUrl) {
      stmts.updateDispatchSession.run({ $id: id, $session_id: sessionId, $share_url: shareUrl })
    },

    completeDispatch(id, status) {
      stmts.completeDispatch.run({ $id: id, $status: status })
    },

    listEntities(opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      const rows = queryEntities(limit, opts.cursor ?? null, opts.repo ?? null)
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return {
        entities: rows,
        next_cursor: hasMore && rows.length > 0 ? rows[rows.length - 1].updated_at : null,
      }
    },

    getEntity(entityKey) {
      return stmts.getEntity.get(entityKey) ?? null
    },

    getEntityDispatches(entityKey) {
      return stmts.getEntityDispatches.all(entityKey)
    },

    getEntityLinks(entityKey) {
      const asSource = stmts.getLinksBySource.all(entityKey)
      const asTarget = stmts.getLinksByTarget.all(entityKey)
      return [...asSource, ...asTarget]
    },

    listDispatches(opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      const rows = queryDispatches(limit, opts.cursor ?? null, opts.status ?? null, opts.event ?? null)
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return {
        dispatches: rows,
        next_cursor: hasMore && rows.length > 0 ? rows[rows.length - 1].created_at : null,
      }
    },

    getStats() {
      return db.transaction(() => {
        const totalEntities = stmts.statsTotalEntities.get()?.c ?? 0
        const totalDispatches = stmts.statsTotalDispatches.get()?.c ?? 0
        const recent24h = stmts.statsRecent24h.get()?.c ?? 0
        const statusRows = stmts.statsStatusCounts.all()
        const statusCounts: Record<string, number> = {}
        for (const row of statusRows) statusCounts[row.status] = row.c
        return {
          total_entities: totalEntities,
          total_dispatches: totalDispatches,
          status_counts: statusCounts,
          recent_24h: recent24h,
        }
      })()
    },

    // Cron job methods
    createCronJob(job) {
      stmts.createCronJob.run({
        $id: job.id,
        $name: job.name,
        $cron_expression: job.cron_expression,
        $prompt: job.prompt,
        $entity_key: job.entity_key,
        $agent: job.agent,
        $timezone: job.timezone,
        $run_once: job.run_once ? 1 : 0,
        $created_by: job.created_by,
        $next_run_at: job.next_run_at ?? null,
      })
    },

    updateCronJob(id, updates) {
      const fields: string[] = []
      const params: Record<string, string | number | null> = { $id: id }

      if (updates.name !== undefined) {
        fields.push("name = $name")
        params.$name = updates.name
      }
      if (updates.cron_expression !== undefined) {
        fields.push("cron_expression = $cron_expression")
        params.$cron_expression = updates.cron_expression
      }
      if (updates.prompt !== undefined) {
        fields.push("prompt = $prompt")
        params.$prompt = updates.prompt
      }
      if (updates.entity_key !== undefined) {
        fields.push("entity_key = $entity_key")
        params.$entity_key = updates.entity_key
      }
      if (updates.agent !== undefined) {
        fields.push("agent = $agent")
        params.$agent = updates.agent
      }
      if (updates.timezone !== undefined) {
        fields.push("timezone = $timezone")
        params.$timezone = updates.timezone
      }
      if (updates.enabled !== undefined) {
        fields.push("enabled = $enabled")
        params.$enabled = updates.enabled ? 1 : 0
      }
      if (updates.next_run_at !== undefined) {
        fields.push("next_run_at = $next_run_at")
        params.$next_run_at = updates.next_run_at ?? null
      }

      if (fields.length === 0) return

      fields.push("updated_at = datetime('now')")
      const sql = `UPDATE cron_jobs SET ${fields.join(", ")} WHERE id = $id`
      db.prepare(sql).run(params)
    },

    deleteCronJob(id) {
      stmts.deleteCronJob.run(id)
    },

    getCronJob(id) {
      return stmts.getCronJob.get(id) ?? null
    },

    getCronJobByName(name) {
      return stmts.getCronJobByName.get(name) ?? null
    },

    listCronJobs(opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      const rows = queryCronJobs(limit, opts.cursor ?? null, opts.enabled ?? null)
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return {
        jobs: rows,
        next_cursor: hasMore && rows.length > 0 ? rows[rows.length - 1].created_at : null,
      }
    },

    listEnabledCronJobs() {
      return stmts.listEnabledCronJobs.all()
    },

    updateCronJobLastRun(id, lastRunAt, nextRunAt) {
      stmts.updateCronJobLastRun.run({
        $id: id,
        $last_run_at: lastRunAt,
        $next_run_at: nextRunAt,
      })
    },

    disableCronJob(id) {
      stmts.disableCronJob.run(id)
    },

    // Cron execution methods
    insertCronExecution(row) {
      stmts.insertCronExecution.run({
        $id: row.id,
        $cron_job_id: row.cron_job_id,
        $scheduled_at: row.scheduled_at,
        $status: row.status,
      })
    },

    updateCronExecution(id, updates) {
      const fields: string[] = []
      const params: Record<string, string | null> = { $id: id }

      if (updates.dispatch_id !== undefined) {
        fields.push("dispatch_id = $dispatch_id")
        params.$dispatch_id = updates.dispatch_id ?? null
      }
      if (updates.status !== undefined) {
        fields.push("status = $status")
        params.$status = updates.status
      }
      if (updates.started_at !== undefined) {
        fields.push("started_at = $started_at")
        params.$started_at = updates.started_at ?? null
      }
      if (updates.completed_at !== undefined) {
        fields.push("completed_at = $completed_at")
        params.$completed_at = updates.completed_at ?? null
      }

      if (fields.length === 0) return

      const sql = `UPDATE cron_executions SET ${fields.join(", ")} WHERE id = $id`
      db.prepare(sql).run(params)
    },

    listCronExecutions(jobId, opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      return stmts.listCronExecutions.all(jobId, limit)
    },

    close() {
      db.close()
    },
  }
}
