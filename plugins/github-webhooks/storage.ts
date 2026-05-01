// SQLite for delivery dedup. Sessions live on the host opencode
// server, not here.

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type DeliveryStore = {
  /** Insert a delivery. Returns true if inserted, false if it was a duplicate. */
  insert(deliveryId: string, event: string, action: string | null): boolean
  /** Trim oldest deliveries when count exceeds `retention`. */
  trim(retention: number): void
}

export function openDeliveryStore(dbPath: string): DeliveryStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id  TEXT NOT NULL UNIQUE,
      event        TEXT NOT NULL,
      action       TEXT,
      received_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_received
      ON deliveries(received_at DESC);
  `)
  const insertStmt = db.prepare<
    void,
    [string, string, string | null, number]
  >(
    `INSERT INTO deliveries (delivery_id, event, action, received_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
  )
  const trimStmt = db.prepare<void, [number]>(
    `DELETE FROM deliveries WHERE id NOT IN (
       SELECT id FROM deliveries ORDER BY received_at DESC LIMIT ?
     )`,
  )
  return {
    insert(deliveryId, event, action) {
      const res = insertStmt.run(deliveryId, event, action, Date.now())
      return res.changes > 0
    },
    trim(retention) {
      if (retention > 0) trimStmt.run(retention)
    },
  }
}
