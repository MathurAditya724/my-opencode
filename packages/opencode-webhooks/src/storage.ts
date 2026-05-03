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
  trigger_name: string
  event: string
  delivery_id: string
  status: "started" | "completed" | "failed" | "timeout"
  created_at: string
  completed_at: string | null
}

export type LifecycleStore = {
  upsertEntity(row: Pick<EntityRow, "entity_key" | "repo" | "number" | "kind" | "session_id" | "agent">): void
  deleteEntity(entityKey: string): void
  resolveSession(entityKey: string): EntityRow | null

  addLink(sourceKey: string, targetKey: string, relation: string): void

  insertDispatch(row: Omit<DispatchRow, "created_at" | "completed_at">): void
  completeDispatch(id: string, status: "completed" | "failed" | "timeout"): void

  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  entity_key TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('issue', 'pull_request')),
  session_id TEXT NOT NULL,
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

  const stmts = {
    getEntity: db.prepare<EntityRow, [string]>(
      "SELECT * FROM entities WHERE entity_key = ?",
    ),
    upsertEntity: db.prepare(
      `INSERT INTO entities (entity_key, repo, number, kind, session_id, agent)
       VALUES ($entity_key, $repo, $number, $kind, $session_id, $agent)
       ON CONFLICT(entity_key) DO UPDATE SET
         session_id = excluded.session_id,
         agent      = excluded.agent,
         updated_at = datetime('now')`,
    ),
    deleteEntity: db.prepare("DELETE FROM entities WHERE entity_key = ?"),

    addLink: db.prepare(
      `INSERT OR IGNORE INTO links (source_key, target_key, relation)
       VALUES ($source_key, $target_key, $relation)`,
    ),
    getLinksBySource: db.prepare<LinkRow, [string]>(
      "SELECT * FROM links WHERE source_key = ?",
    ),
    getLinksByTarget: db.prepare<LinkRow, [string]>(
      "SELECT * FROM links WHERE target_key = ?",
    ),

    insertDispatch: db.prepare(
      `INSERT INTO dispatches (id, entity_key, session_id, trigger_name, event, delivery_id, status)
       VALUES ($id, $entity_key, $session_id, $trigger_name, $event, $delivery_id, $status)`,
    ),
    completeDispatch: db.prepare(
      `UPDATE dispatches SET status = $status, completed_at = datetime('now')
       WHERE id = $id`,
    ),
  }

  return {
    upsertEntity(row) {
      stmts.upsertEntity.run({
        $entity_key: row.entity_key,
        $repo: row.repo,
        $number: row.number,
        $kind: row.kind,
        $session_id: row.session_id,
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
        $trigger_name: row.trigger_name,
        $event: row.event,
        $delivery_id: row.delivery_id,
        $status: row.status,
      })
    },

    completeDispatch(id, status) {
      stmts.completeDispatch.run({ $id: id, $status: status })
    },

    close() {
      db.close()
    },
  }
}
