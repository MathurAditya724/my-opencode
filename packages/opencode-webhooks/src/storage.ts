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
  ): number
  markRunning(dispatchId: number, sessionId: string): void
  markSucceeded(dispatchId: number): void
  markFailed(dispatchId: number, error: string): void
  markTimeout(dispatchId: number): void

  // Read API for the GET endpoints.
  listDeliveries(opts: ListDeliveriesOpts): ListDeliveriesResult
  getDelivery(
    deliveryId: string,
  ): { delivery: DeliveryRow; dispatches: DispatchRow[] } | null
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
  `)

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
    [string, string, string, string, number]
  >(
    `INSERT INTO dispatches (delivery_id, trigger_name, matched_event, agent, status, started_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
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

  const getDeliveryStmt = db.prepare<DeliveryRow, [string]>(
    `SELECT delivery_id, external_id, event, action, received_at
     FROM deliveries WHERE delivery_id = ?`,
  )
  const getDispatchesStmt = db.prepare<DispatchRow, [string]>(
    `SELECT id, delivery_id, trigger_name, matched_event, agent, session_id,
            status, started_at, completed_at, error
     FROM dispatches WHERE delivery_id = ? ORDER BY started_at ASC, id ASC`,
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

    createDispatch(deliveryId, triggerName, matchedEvent, agent) {
      const res = createDispatchStmt.run(
        deliveryId,
        triggerName,
        matchedEvent,
        agent,
        Date.now(),
      )
      return Number(res.lastInsertRowid)
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
        SELECT d.id, d.delivery_id, d.external_id, d.event, d.action, d.received_at,
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
  }
}

type ListRow = {
  id: number
  delivery_id: string
  external_id: string
  event: string
  action: string | null
  received_at: number
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
