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

export type LifecycleStore = {
  upsertEntity(
    row: Pick<EntityRow, "entity_key" | "repo" | "number" | "kind" | "session_id" | "share_url" | "agent">,
  ): void
  deleteEntity(entityKey: string): void
  resolveSession(entityKey: string): EntityRow | null

  addLink(sourceKey: string, targetKey: string, relation: string): void

  insertDispatch(
    row: Omit<DispatchRow, "created_at" | "completed_at" | "share_url"> & { share_url?: string | null },
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
  trigger_name TEXT NOT NULL,
  event        TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'started',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatches_entity ON dispatches(entity_key);
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

  const stmts = {
    getEntity: db.prepare<EntityRow, [string]>("SELECT * FROM entities WHERE entity_key = ?"),
    upsertEntity: db.prepare(
      `INSERT INTO entities (entity_key, repo, number, kind, session_id, share_url, agent)
       VALUES ($entity_key, $repo, $number, $kind, $session_id, $share_url, $agent)
       ON CONFLICT(entity_key) DO UPDATE SET
         session_id = excluded.session_id,
         share_url  = COALESCE(excluded.share_url, entities.share_url),
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
      `INSERT INTO dispatches (id, entity_key, session_id, share_url, trigger_name, event, delivery_id, status)
       VALUES ($id, $entity_key, $session_id, $share_url, $trigger_name, $event, $delivery_id, $status)`,
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

  return {
    upsertEntity(row) {
      stmts.upsertEntity.run({
        $entity_key: row.entity_key,
        $repo: row.repo,
        $number: row.number,
        $kind: row.kind,
        $session_id: row.session_id,
        $share_url: row.share_url,
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
    resolveSession(entityKey) {
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

    close() {
      db.close()
    },
  }
}
