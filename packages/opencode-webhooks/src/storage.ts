// SQLite for delivery dedup + dispatch lifecycle. Sessions themselves
// live on the host opencode server; this DB only records the metadata
// needed to answer "what happened with delivery X?".

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  DeliveryListItem,
  DeliveryRow,
  DispatchRow,
  DispatchStatus,
  EntityListItem,
} from "./types"

export type ListDeliveriesOpts = {
  limit?: number
  // Keyset cursor encoded as `${received_at}:${id}`. Returned as
  // `next_cursor` from a previous page.
  cursor?: string | null
  event?: string | null
  // Filter to deliveries that have at least one dispatch in this status.
  status?: DispatchStatus | null
  // Lower bound on received_at (epoch ms).
  since?: number | null
}

export type ListDeliveriesResult = {
  rows: DeliveryListItem[]
  next_cursor: string | null
}

export type ListEntitiesOpts = {
  limit?: number
  cursor?: string | null
  repo?: string | null
}

export type ListEntitiesResult = {
  rows: EntityListItem[]
  next_cursor: string | null
}

export type EntityDetail = {
  entity_key: string
  session_id: string | null
  events: Array<{
    dispatch_id: number
    delivery_id: string
    event: string
    action: string | null
    received_at: number
    trigger_name: string
    status: DispatchStatus
    outcome: string | null
    started_at: number
    completed_at: number | null
    duration_ms: number | null
  }>
}

export type StatsResult = {
  total_deliveries: number
  total_dispatches: number
  active_entities: number
  status_counts: Record<string, number>
  today_count: number
}

export type DeliveryStore = {
  /**
   * Insert a delivery. `externalId` is the dedup key (X-GitHub-Delivery
   * or email:<message_id>). Returns the generated UUID delivery_id on
   * success, or null if the externalId already exists (duplicate).
   */
  insert(
    externalId: string,
    event: string,
    action: string | null,
  ): string | null
  /** Trim oldest deliveries when count exceeds `retention`. Cascades to dispatches. */
  trim(retention: number): void

  // Dispatch lifecycle. createDispatch returns the row id which the
  // caller threads through to the lifecycle updates.
  createDispatch(
    deliveryId: string,
    triggerName: string,
    matchedEvent: string,
    agent: string,
    entityKey?: string | null,
    prompt?: string | null,
  ): number
  getDispatch(dispatchId: number): DispatchRow | null
  resetDispatch(dispatchId: number): void
  markRunning(dispatchId: number, sessionId: string): void
  markSucceeded(dispatchId: number): void
  markFailed(dispatchId: number, error: string): void
  markTimeout(dispatchId: number): void

  // Set a free-form outcome string on a completed dispatch.
  setOutcome(dispatchId: number, outcome: string): void
  // Persist skipped triggers as JSON on the delivery row.
  saveSkipped(
    deliveryId: string,
    skipped: Array<{ name: string; reason: string }>,
  ): void

  // Session affinity: bind an entity key to an OpenCode session.
  bindSession(entityKey: string, sessionId: string): void
  // Look up the session id for an entity key. Returns null if no
  // active session.
  lookupSession(entityKey: string): string | null

  // Read API for the GET endpoints.
  listDeliveries(opts: ListDeliveriesOpts): ListDeliveriesResult
  getDelivery(
    deliveryId: string,
  ): { delivery: DeliveryRow; dispatches: DispatchRow[] } | null

  // Dashboard API: entity-centric views.
  listEntities(opts: ListEntitiesOpts): ListEntitiesResult
  getEntity(entityKey: string): EntityDetail | null
  getStats(): StatsResult
}

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

export function openDeliveryStore(dbPath: string): DeliveryStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  // Required per-connection for ON DELETE CASCADE on the dispatches FK.
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id  TEXT NOT NULL UNIQUE,
      external_id  TEXT NOT NULL UNIQUE,
      event        TEXT NOT NULL,
      action       TEXT,
      received_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_received
      ON deliveries(received_at DESC);

    CREATE TABLE IF NOT EXISTS dispatches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id   TEXT NOT NULL REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
      trigger_name  TEXT NOT NULL,
      matched_event TEXT NOT NULL,
      agent         TEXT NOT NULL,
      session_id    TEXT,
      status        TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','timeout')),
      started_at    INTEGER NOT NULL,
      completed_at  INTEGER,
      error         TEXT,
      UNIQUE(delivery_id, trigger_name)
    );
    CREATE INDEX IF NOT EXISTS idx_dispatches_delivery ON dispatches(delivery_id);
    CREATE INDEX IF NOT EXISTS idx_dispatches_status   ON dispatches(status);
    CREATE INDEX IF NOT EXISTS idx_dispatches_started  ON dispatches(started_at DESC);

    CREATE TABLE IF NOT EXISTS entity_sessions (
      entity_key   TEXT NOT NULL PRIMARY KEY,
      session_id   TEXT NOT NULL,
      bound_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entity_sessions_session
      ON entity_sessions(session_id);
  `)

  // Schema migrations for new columns. SQLite errors if the column
  // already exists, which is expected on subsequent boots.
  try { db.exec("ALTER TABLE dispatches ADD COLUMN entity_key TEXT") } catch {}
  try { db.exec("ALTER TABLE dispatches ADD COLUMN outcome TEXT") } catch {}
  try { db.exec("ALTER TABLE deliveries ADD COLUMN skipped TEXT") } catch {}
  try { db.exec("ALTER TABLE dispatches ADD COLUMN prompt TEXT") } catch {}
  db.exec("CREATE INDEX IF NOT EXISTS idx_dispatches_entity ON dispatches(entity_key)")

  // Drop the UNIQUE(delivery_id, trigger_name) constraint so retries
  // can create a new dispatch row for the same delivery+trigger combo.
  // SQLite doesn't support DROP CONSTRAINT, so we recreate the table.
  try {
    const hasUnique = db
      .prepare<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='dispatches'",
      )
      .get()
    if (hasUnique?.sql?.includes("UNIQUE(delivery_id, trigger_name)")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dispatches_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id   TEXT NOT NULL REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
          trigger_name  TEXT NOT NULL,
          matched_event TEXT NOT NULL,
          agent         TEXT NOT NULL,
          session_id    TEXT,
          status        TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','timeout')),
          started_at    INTEGER NOT NULL,
          completed_at  INTEGER,
          error         TEXT,
          entity_key    TEXT,
          outcome       TEXT,
          prompt        TEXT
        );
        INSERT INTO dispatches_new SELECT id, delivery_id, trigger_name, matched_event,
          agent, session_id, status, started_at, completed_at, error, entity_key, outcome, prompt
          FROM dispatches;
        DROP TABLE dispatches;
        ALTER TABLE dispatches_new RENAME TO dispatches;
        CREATE INDEX IF NOT EXISTS idx_dispatches_delivery ON dispatches(delivery_id);
        CREATE INDEX IF NOT EXISTS idx_dispatches_status   ON dispatches(status);
        CREATE INDEX IF NOT EXISTS idx_dispatches_started  ON dispatches(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_dispatches_entity   ON dispatches(entity_key);
      `)
    }
  } catch {}

  const insertStmt = db.prepare<
    void,
    [string, string, string, string | null, number]
  >(
    `INSERT INTO deliveries (delivery_id, external_id, event, action, received_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(external_id) DO NOTHING`,
  )
  const trimStmt = db.prepare<void, [number]>(
    `DELETE FROM deliveries WHERE id NOT IN (
       SELECT id FROM deliveries ORDER BY received_at DESC LIMIT ?
     )`,
  )

  const createDispatchStmt = db.prepare<
    void,
    [string, string, string, string, string | null, string | null, number]
  >(
    `INSERT INTO dispatches (delivery_id, trigger_name, matched_event, agent, entity_key, prompt, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
  const markRunningStmt = db.prepare<void, [string, number]>(
    `UPDATE dispatches SET status = 'running', session_id = ? WHERE id = ?`,
  )
  const markSucceededStmt = db.prepare<void, [number, number]>(
    `UPDATE dispatches SET status = 'succeeded', completed_at = ? WHERE id = ?`,
  )
  const markFailedStmt = db.prepare<void, [string, number, number]>(
    `UPDATE dispatches SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
  )
  const markTimeoutStmt = db.prepare<void, [number, number]>(
    `UPDATE dispatches SET status = 'timeout', completed_at = ? WHERE id = ?`,
  )

  const bindSessionStmt = db.prepare<void, [string, string, number]>(
    `INSERT INTO entity_sessions (entity_key, session_id, bound_at)
     VALUES (?, ?, ?)
     ON CONFLICT(entity_key) DO UPDATE SET session_id = excluded.session_id, bound_at = excluded.bound_at`,
  )
  const lookupSessionStmt = db.prepare<{ session_id: string }, [string]>(
    `SELECT session_id FROM entity_sessions WHERE entity_key = ?`,
  )

  const getDeliveryStmt = db.prepare<DeliveryRow, [string]>(
    `SELECT delivery_id, external_id, event, action, received_at, skipped
     FROM deliveries WHERE delivery_id = ?`,
  )
  const getDispatchesStmt = db.prepare<DispatchRow, [string]>(
    `SELECT id, delivery_id, trigger_name, matched_event, agent, session_id,
            status, started_at, completed_at, error, entity_key, outcome, prompt
     FROM dispatches WHERE delivery_id = ? ORDER BY started_at ASC, id ASC`,
  )

  const getDispatchStmt = db.prepare<DispatchRow, [number]>(
    `SELECT id, delivery_id, trigger_name, matched_event, agent, session_id,
            status, started_at, completed_at, error, entity_key, outcome, prompt
     FROM dispatches WHERE id = ?`,
  )

  const resetDispatchStmt = db.prepare<void, [number, number]>(
    `UPDATE dispatches SET status = 'pending', session_id = NULL, error = NULL,
            outcome = NULL, completed_at = NULL, started_at = ? WHERE id = ?`,
  )

  const setOutcomeStmt = db.prepare<void, [string, number]>(
    `UPDATE dispatches SET outcome = ? WHERE id = ?`,
  )
  const saveSkippedStmt = db.prepare<void, [string, string]>(
    `UPDATE deliveries SET skipped = ? WHERE delivery_id = ?`,
  )

  return {
    insert(externalId, event, action) {
      const deliveryId = randomUUID()
      const res = insertStmt.run(
        deliveryId,
        externalId,
        event,
        action,
        Date.now(),
      )
      return res.changes > 0 ? deliveryId : null
    },
    trim(retention) {
      if (retention > 0) trimStmt.run(retention)
    },

    createDispatch(deliveryId, triggerName, matchedEvent, agent, entityKey, prompt) {
      const res = createDispatchStmt.run(
        deliveryId,
        triggerName,
        matchedEvent,
        agent,
        entityKey ?? null,
        prompt ?? null,
        Date.now(),
      )
      return Number(res.lastInsertRowid)
    },
    getDispatch(dispatchId) {
      return getDispatchStmt.get(dispatchId) ?? null
    },
    resetDispatch(dispatchId) {
      resetDispatchStmt.run(Date.now(), dispatchId)
    },
    markRunning(dispatchId, sessionId) {
      markRunningStmt.run(sessionId, dispatchId)
    },
    markSucceeded(dispatchId) {
      markSucceededStmt.run(Date.now(), dispatchId)
    },
    markFailed(dispatchId, error) {
      markFailedStmt.run(error, Date.now(), dispatchId)
    },
    markTimeout(dispatchId) {
      markTimeoutStmt.run(Date.now(), dispatchId)
    },

    bindSession(entityKey, sessionId) {
      bindSessionStmt.run(entityKey, sessionId, Date.now())
    },
    lookupSession(entityKey) {
      const row = lookupSessionStmt.get(entityKey)
      return row?.session_id ?? null
    },

    listDeliveries(opts) {
      const limit = clampLimit(opts.limit)
      const where: string[] = []
      const params: Array<string | number> = []

      if (opts.cursor) {
        const parsed = parseCursor(opts.cursor)
        if (parsed) {
          where.push("(d.received_at < ? OR (d.received_at = ? AND d.id < ?))")
          params.push(parsed.received_at, parsed.received_at, parsed.id)
        }
      }
      if (opts.event) {
        where.push("d.event = ?")
        params.push(opts.event)
      }
      if (opts.since != null) {
        where.push("d.received_at >= ?")
        params.push(opts.since)
      }
      if (opts.status) {
        where.push(
          "EXISTS (SELECT 1 FROM dispatches dd WHERE dd.delivery_id = d.delivery_id AND dd.status = ?)",
        )
        params.push(opts.status)
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
      const sql = `
        SELECT d.id, d.delivery_id, d.external_id, d.event, d.action, d.received_at, d.skipped,
               COUNT(disp.id) AS dispatch_count,
               COALESCE(SUM(CASE WHEN disp.status = 'pending'   THEN 1 ELSE 0 END), 0) AS s_pending,
               COALESCE(SUM(CASE WHEN disp.status = 'running'   THEN 1 ELSE 0 END), 0) AS s_running,
               COALESCE(SUM(CASE WHEN disp.status = 'succeeded' THEN 1 ELSE 0 END), 0) AS s_succeeded,
               COALESCE(SUM(CASE WHEN disp.status = 'failed'    THEN 1 ELSE 0 END), 0) AS s_failed,
               COALESCE(SUM(CASE WHEN disp.status = 'timeout'   THEN 1 ELSE 0 END), 0) AS s_timeout
        FROM deliveries d
        LEFT JOIN dispatches disp ON disp.delivery_id = d.delivery_id
        ${whereSql}
        GROUP BY d.id
        ORDER BY d.received_at DESC, d.id DESC
        LIMIT ?
      `
      const stmt = db.prepare<ListRow, (string | number)[]>(sql)
      const raw = stmt.all(...params, limit + 1)
      const hasMore = raw.length > limit
      const page = hasMore ? raw.slice(0, limit) : raw

      const rows: DeliveryListItem[] = page.map((r) => {
        const statuses: Partial<Record<DispatchStatus, number>> = {}
        if (r.s_pending) statuses.pending = r.s_pending
        if (r.s_running) statuses.running = r.s_running
        if (r.s_succeeded) statuses.succeeded = r.s_succeeded
        if (r.s_failed) statuses.failed = r.s_failed
        if (r.s_timeout) statuses.timeout = r.s_timeout
        return {
          delivery_id: r.delivery_id,
          external_id: r.external_id,
          event: r.event,
          action: r.action,
          received_at: r.received_at,
          skipped: r.skipped,
          dispatch_count: r.dispatch_count,
          statuses,
        }
      })

      let next_cursor: string | null = null
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1]!
        next_cursor = `${last.received_at}:${last.id}`
      }
      return { rows, next_cursor }
    },

    getDelivery(deliveryId) {
      const delivery = getDeliveryStmt.get(deliveryId)
      if (!delivery) return null
      const dispatches = getDispatchesStmt.all(deliveryId)
      return { delivery, dispatches }
    },

    setOutcome(dispatchId, outcome) {
      setOutcomeStmt.run(outcome, dispatchId)
    },
    saveSkipped(deliveryId, skipped) {
      saveSkippedStmt.run(JSON.stringify(skipped), deliveryId)
    },

    listEntities(opts) {
      const limit = clampLimit(opts.limit)
      const where: string[] = []
      const params: Array<string | number> = []

      if (opts.cursor) {
        const parsed = parseEntityCursor(opts.cursor)
        if (parsed) {
          where.push(
            "(last_d.started_at < ? OR (last_d.started_at = ? AND last_d.id < ?))",
          )
          params.push(parsed.started_at, parsed.started_at, parsed.id)
        }
      }
      if (opts.repo) {
        // entity_key format is "owner/repo#N"; filter by prefix.
        where.push("d.entity_key LIKE ? || '#%'")
        params.push(opts.repo)
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
      const sql = `
        SELECT
          d.entity_key,
          es.session_id,
          last_d.matched_event AS last_event,
          del.action          AS last_action,
          last_d.status       AS last_status,
          last_d.outcome      AS last_outcome,
          last_d.started_at   AS last_activity,
          COUNT(d.id)         AS event_count,
          last_d.started_at   AS _sort_ts,
          last_d.id           AS _sort_id
        FROM dispatches d
        JOIN (
          SELECT entity_key, MAX(id) AS max_id
          FROM dispatches
          WHERE entity_key IS NOT NULL
          GROUP BY entity_key
        ) latest ON latest.entity_key = d.entity_key
        JOIN dispatches last_d ON last_d.id = latest.max_id
        JOIN deliveries del ON del.delivery_id = last_d.delivery_id
        LEFT JOIN entity_sessions es ON es.entity_key = d.entity_key
        ${whereSql}
        GROUP BY d.entity_key
        ORDER BY last_d.started_at DESC, last_d.id DESC
        LIMIT ?
      `
      const stmt = db.prepare<EntityListRow, (string | number)[]>(sql)
      const raw = stmt.all(...params, limit + 1)
      const hasMore = raw.length > limit
      const page = hasMore ? raw.slice(0, limit) : raw

      const rows: EntityListItem[] = page.map((r) => ({
        entity_key: r.entity_key,
        session_id: r.session_id,
        last_event: r.last_event,
        last_action: r.last_action,
        last_status: r.last_status as DispatchStatus,
        last_outcome: r.last_outcome,
        last_activity: r.last_activity,
        event_count: r.event_count,
      }))

      let next_cursor: string | null = null
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1]!
        next_cursor = `${last._sort_ts}:${last._sort_id}`
      }
      return { rows, next_cursor }
    },

    getEntity(entityKey) {
      const es = db
        .prepare<{ session_id: string }, [string]>(
          `SELECT session_id FROM entity_sessions WHERE entity_key = ?`,
        )
        .get(entityKey)

      const events = db
        .prepare<EntityEventRow, [string]>(
          `SELECT
             d.id,
             d.delivery_id,
             del.event,
             del.action,
             del.received_at,
             d.trigger_name,
             d.status,
             d.outcome,
             d.started_at,
             d.completed_at
           FROM dispatches d
           JOIN deliveries del ON del.delivery_id = d.delivery_id
           WHERE d.entity_key = ?
           ORDER BY d.started_at ASC, d.id ASC`,
        )
        .all(entityKey)

      if (events.length === 0) return null

      return {
        entity_key: entityKey,
        session_id: es?.session_id ?? null,
        events: events.map((e) => ({
          dispatch_id: e.id,
          delivery_id: e.delivery_id,
          event: e.event,
          action: e.action,
          received_at: e.received_at,
          trigger_name: e.trigger_name,
          status: e.status as DispatchStatus,
          outcome: e.outcome,
          started_at: e.started_at,
          completed_at: e.completed_at,
          duration_ms:
            e.completed_at != null ? e.completed_at - e.started_at : null,
        })),
      }
    },

    getStats() {
      const totalDeliveries = db
        .prepare<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM deliveries")
        .get()!.cnt
      const totalDispatches = db
        .prepare<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM dispatches")
        .get()!.cnt
      const activeEntities = db
        .prepare<{ cnt: number }, []>(
          "SELECT COUNT(DISTINCT entity_key) AS cnt FROM dispatches WHERE entity_key IS NOT NULL",
        )
        .get()!.cnt

      const statusRows = db
        .prepare<{ status: string; cnt: number }, []>(
          "SELECT status, COUNT(*) AS cnt FROM dispatches GROUP BY status",
        )
        .all()
      const status_counts: Record<string, number> = {}
      for (const r of statusRows) {
        status_counts[r.status] = r.cnt
      }

      const todayStart = startOfDayMs()
      const todayCount = db
        .prepare<{ cnt: number }, [number]>(
          "SELECT COUNT(*) AS cnt FROM deliveries WHERE received_at >= ?",
        )
        .get(todayStart)!.cnt

      return {
        total_deliveries: totalDeliveries,
        total_dispatches: totalDispatches,
        active_entities: activeEntities,
        status_counts,
        today_count: todayCount,
      }
    },
  }
}

type ListRow = {
  id: number
  delivery_id: string
  external_id: string
  event: string
  action: string | null
  received_at: number
  skipped: string | null
  dispatch_count: number
  s_pending: number
  s_running: number
  s_succeeded: number
  s_failed: number
  s_timeout: number
}

function clampLimit(raw: number | undefined): number {
  if (raw == null) return DEFAULT_LIMIT
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(raw), MAX_LIMIT)
}

function parseCursor(
  cursor: string,
): { received_at: number; id: number } | null {
  const [a, b] = cursor.split(":")
  const received_at = Number(a)
  const id = Number(b)
  if (!Number.isFinite(received_at) || !Number.isFinite(id)) return null
  return { received_at, id }
}

function parseEntityCursor(
  cursor: string,
): { started_at: number; id: number } | null {
  const [a, b] = cursor.split(":")
  const started_at = Number(a)
  const id = Number(b)
  if (!Number.isFinite(started_at) || !Number.isFinite(id)) return null
  return { started_at, id }
}

function startOfDayMs(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

type EntityListRow = {
  entity_key: string
  session_id: string | null
  last_event: string
  last_action: string | null
  last_status: string
  last_outcome: string | null
  last_activity: number
  event_count: number
  _sort_ts: number
  _sort_id: number
}

type EntityEventRow = {
  id: number
  delivery_id: string
  event: string
  action: string | null
  received_at: number
  trigger_name: string
  status: string
  outcome: string | null
  started_at: number
  completed_at: number | null
}
