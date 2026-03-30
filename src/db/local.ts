import { Database } from "bun:sqlite";

let db: Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target        TEXT NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL,
  shipped_at    TEXT,
  error         TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error_at TEXT
);

CREATE TABLE IF NOT EXISTS cursors (
  source     TEXT PRIMARY KEY,
  offset     INTEGER NOT NULL DEFAULT 0,
  checksum   TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS known_projects (
  proj_id    TEXT PRIMARY KEY,
  slug       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_type    TEXT NOT NULL,
  payload      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  shipped_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_shipped ON outbox(shipped_at) WHERE shipped_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_target ON outbox(target, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_content ON archive_queue(fact_type, content_hash);
CREATE INDEX IF NOT EXISTS idx_archive_unshipped ON archive_queue(shipped_at) WHERE shipped_at IS NULL;

CREATE TABLE IF NOT EXISTS otel_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  session_id  TEXT,
  payload     TEXT NOT NULL,
  processed   INTEGER DEFAULT 0,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otel_unprocessed
  ON otel_events(processed) WHERE processed = 0;
CREATE INDEX IF NOT EXISTS idx_otel_session_received
  ON otel_events(session_id, received_at) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  proj_id     TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  first_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_tracking (
  proj_id             TEXT NOT NULL,
  date                TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  cache_read_tokens   INTEGER DEFAULT 0,
  cache_write_tokens  INTEGER DEFAULT 0,
  cost_usd            REAL DEFAULT 0,
  request_count       INTEGER DEFAULT 0,
  PRIMARY KEY (proj_id, date, model)
);
`;

export function initLocal(dbPath: string): void {
  if (db !== null) {
    db.close();
    db = null;
  }

  db = new Database(dbPath, { create: true });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec(SCHEMA);

  // Migrate sessions table — ALTER TABLE adds columns that CREATE TABLE IF NOT EXISTS won't
  try {
    db.query("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT").run();
  } catch {} // column already exists
  try {
    db.query("ALTER TABLE sessions ADD COLUMN pid INTEGER").run();
  } catch {} // column already exists
}

export function getLocal(): Database {
  if (db === null) {
    throw new Error("Local database is not initialized. Call initLocal() first.");
  }
  return db;
}

export function closeLocal(): void {
  if (db !== null) {
    db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Outbox types
// ---------------------------------------------------------------------------

export interface OutboxRow {
  id: number;
  target: string;
  payload: string;
  status: string;
  created_at: string;
  shipped_at: string | null;
  error: string | null;
  retry_count: number;
  last_error_at: string | null;
}

// ---------------------------------------------------------------------------
// Outbox CRUD
// ---------------------------------------------------------------------------

/**
 * Insert a row into the outbox with status='pending'.
 * Returns the new row's id.
 */
export function enqueue(target: string, payload: unknown): number {
  const db = getLocal();
  const now = new Date().toISOString();
  const result = db
    .query(
      "INSERT INTO outbox (target, payload, status, created_at) VALUES (?, ?, 'pending', ?) RETURNING id"
    )
    .get(target, JSON.stringify(payload), now) as { id: number };
  return result.id;
}

/**
 * Base WHERE clause for pending rows whose backoff window has elapsed.
 */
const PENDING_WHERE = `status = 'pending'
  AND (last_error_at IS NULL
       OR (julianday('now') - julianday(last_error_at)) * 86400 >= min(power(2, retry_count), 60))`;

/**
 * Return up to `limit` pending rows whose backoff window has elapsed.
 *
 * Uses priority-aware dequeue: non-event targets (projects, daily_metrics,
 * project_telemetry, facility_metrics) are fetched first, then events fill
 * the remaining slots. This prevents high-volume events from starving
 * higher-priority targets via head-of-line blocking.
 */
export function dequeueUnshipped(limit: number): OutboxRow[] {
  const db = getLocal();

  // 1. Fetch all non-event pending rows (usually a handful)
  const priority = db
    .query<OutboxRow, [number]>(
      `SELECT * FROM outbox
       WHERE ${PENDING_WHERE} AND target != 'events'
       ORDER BY id
       LIMIT ?`
    )
    .all(limit);

  const remaining = limit - priority.length;
  if (remaining <= 0) return priority.slice(0, limit);

  // 2. Fill remaining slots with events
  const events = db
    .query<OutboxRow, [number]>(
      `SELECT * FROM outbox
       WHERE ${PENDING_WHERE} AND target = 'events'
       ORDER BY id
       LIMIT ?`
    )
    .all(remaining);

  return [...priority, ...events];
}

/**
 * Mark rows as shipped, recording shipped_at.
 */
export function markShipped(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getLocal();
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(", ");
  db.query(
    `UPDATE outbox SET status = 'shipped', shipped_at = ? WHERE id IN (${placeholders})`
  ).run(now, ...ids);
}

/**
 * Permanently mark rows as failed with an error message.
 */
export function markFailed(ids: number[], error: string): void {
  if (ids.length === 0) return;
  const db = getLocal();
  const placeholders = ids.map(() => "?").join(", ");
  db.query(
    `UPDATE outbox SET status = 'failed', error = ? WHERE id IN (${placeholders})`
  ).run(error, ...ids);
}

/**
 * Delete all permanently failed rows from the outbox.
 * Safe because dequeueUnshipped only picks up 'pending' rows.
 */
export function purgeFailed(): number {
  const db = getLocal();
  const result = db.run("DELETE FROM outbox WHERE status = 'failed'");
  return result.changes;
}

/**
 * Record a transient error: increment retry_count, set error and last_error_at.
 * If retry_count reaches 10, permanently fail the row.
 */
export function markTransientError(ids: number[], error: string): void {
  if (ids.length === 0) return;
  const db = getLocal();
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(", ");
  // Increment first, then check threshold
  db.query(
    `UPDATE outbox
     SET retry_count   = retry_count + 1,
         error         = ?,
         last_error_at = ?,
         status        = CASE WHEN retry_count + 1 >= 10 THEN 'failed' ELSE status END
     WHERE id IN (${placeholders})`
  ).run(error, now, ...ids);
}

// ---------------------------------------------------------------------------
// Cursor types and operations
// ---------------------------------------------------------------------------

export interface CursorRow {
  source: string;
  offset: number;
  checksum: string | null;
  updated_at: string;
}

/**
 * Return the cursor row for the given source, or null if not found.
 */
export function getCursor(source: string): CursorRow | null {
  const db = getLocal();
  return (
    db
      .query<CursorRow, [string]>("SELECT * FROM cursors WHERE source = ?")
      .get(source) ?? null
  );
}

/**
 * Upsert (INSERT OR REPLACE) the cursor for the given source.
 */
export function setCursor(
  source: string,
  offset: number,
  checksum: string | null
): void {
  const db = getLocal();
  const now = new Date().toISOString();
  db.query(
    "INSERT OR REPLACE INTO cursors (source, offset, checksum, updated_at) VALUES (?, ?, ?, ?)"
  ).run(source, offset, checksum, now);
}

// ---------------------------------------------------------------------------
// Archive queue types and operations
// ---------------------------------------------------------------------------

export interface ArchiveRow {
  id: number;
  fact_type: string;
  payload: string;
  content_hash: string;
  created_at: string;
  shipped_at: string | null;
}

/**
 * Insert a row into archive_queue. Silently ignores duplicates by content_hash.
 */
export function enqueueArchive(
  factType: string,
  payload: string,
  contentHash: string
): void {
  const db = getLocal();
  const now = new Date().toISOString();
  db.query(
    "INSERT OR IGNORE INTO archive_queue (fact_type, payload, content_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(factType, payload, contentHash, now);
}

/**
 * Return up to `limit` unshipped archive rows ordered by id ascending.
 */
export function dequeueUnshippedArchive(limit: number): ArchiveRow[] {
  const db = getLocal();
  return db
    .query<ArchiveRow, [number]>(
      "SELECT * FROM archive_queue WHERE shipped_at IS NULL ORDER BY id LIMIT ?"
    )
    .all(limit);
}

/**
 * Mark archive rows as shipped, recording shipped_at.
 */
export function markArchiveShipped(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getLocal();
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(", ");
  db.query(
    `UPDATE archive_queue SET shipped_at = ? WHERE id IN (${placeholders})`
  ).run(now, ...ids);
}

// ---------------------------------------------------------------------------
// Known projects operations
// ---------------------------------------------------------------------------

/**
 * Record a project as known. Silently ignores duplicates.
 */
export function addKnownProject(projId: string, slug: string): void {
  const db = getLocal();
  const now = new Date().toISOString();
  db.query(
    "INSERT OR IGNORE INTO known_projects (proj_id, slug, created_at) VALUES (?, ?, ?)"
  ).run(projId, slug, now);
}

/**
 * Return all known project IDs.
 */
export function getKnownProjectIds(): string[] {
  const db = getLocal();
  const rows = db
    .query<{ proj_id: string }, []>("SELECT proj_id FROM known_projects")
    .all();
  return rows.map((r) => r.proj_id);
}

/**
 * Return true if the given project ID is known.
 */
export function isKnownProject(projId: string): boolean {
  const db = getLocal();
  const row = db
    .query<{ proj_id: string }, [string]>(
      "SELECT proj_id FROM known_projects WHERE proj_id = ?"
    )
    .get(projId);
  return row !== null;
}

// ---------------------------------------------------------------------------
// Prune operations
// ---------------------------------------------------------------------------

/**
 * Delete shipped outbox rows older than `olderThanDays` days.
 * Returns the number of rows deleted.
 */
export function pruneShipped(olderThanDays: number): number {
  const db = getLocal();
  const result = db
    .query<never, [number]>(
      `DELETE FROM outbox
       WHERE status = 'shipped'
         AND shipped_at < datetime('now', ? || ' days')`
    )
    .run(-olderThanDays);
  return result.changes;
}

/**
 * Delete shipped archive rows older than `olderThanDays` days.
 * Returns the number of rows deleted.
 */
export function pruneShippedArchive(olderThanDays: number): number {
  const db = getLocal();
  const result = db
    .query<never, [number]>(
      `DELETE FROM archive_queue
       WHERE shipped_at IS NOT NULL
         AND shipped_at < datetime('now', ? || ' days')`
    )
    .run(-olderThanDays);
  return result.changes;
}

/**
 * Return the count of pending outbox rows.
 */
export function outboxDepth(): number {
  const db = getLocal();
  const row = db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM outbox WHERE status = 'pending'"
    )
    .get()!;
  return row.count;
}

/**
 * Return the count of unshipped archive rows.
 */
export function archiveDepth(): number {
  const db = getLocal();
  const row = db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM archive_queue WHERE shipped_at IS NULL"
    )
    .get()!;
  return row.count;
}

// ---------------------------------------------------------------------------
// OTel events CRUD
// ---------------------------------------------------------------------------

export interface OtelEventRow {
  id: number;
  event_type: string;
  session_id: string | null;
  payload: string;
  processed: number;
  received_at: string;
}

export function insertOtelEvent(
  eventType: string,
  sessionId: string | null,
  payload: string
): number {
  const db = getLocal();
  const now = new Date().toISOString();
  const result = db
    .query(
      "INSERT INTO otel_events (event_type, session_id, payload, received_at) VALUES (?, ?, ?, ?) RETURNING id"
    )
    .get(eventType, sessionId, payload, now) as { id: number };
  return result.id;
}

export function getUnprocessedOtelEvents(limit: number): OtelEventRow[] {
  const db = getLocal();
  return db
    .query<OtelEventRow, [number]>(
      "SELECT * FROM otel_events WHERE processed = 0 ORDER BY id LIMIT ?"
    )
    .all(limit);
}

/** Count OTel events received in the last N seconds. */
export function otelEventsReceivedSince(seconds: number): number {
  const db = getLocal();
  const row = db
    .query<{ count: number }, [number]>(
      "SELECT COUNT(*) AS count FROM otel_events WHERE received_at > datetime('now', ? || ' seconds')"
    )
    .get(-seconds)!;
  return row.count;
}

/** Count distinct session_ids in recent OTel events. */
export function otelActiveSessionCount(seconds: number): number {
  const db = getLocal();
  const row = db
    .query<{ count: number }, [number]>(
      "SELECT COUNT(DISTINCT session_id) AS count FROM otel_events WHERE session_id IS NOT NULL AND received_at > datetime('now', ? || ' seconds')"
    )
    .get(-seconds)!;
  return row.count;
}

/** Count unprocessed OTel events (queue depth). */
export function otelQueueDepth(): number {
  const db = getLocal();
  const row = db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM otel_events WHERE processed = 0"
    )
    .get()!;
  return row.count;
}

export function markOtelEventsProcessed(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getLocal();
  const placeholders = ids.map(() => "?").join(", ");
  db.query(`UPDATE otel_events SET processed = 1 WHERE id IN (${placeholders})`).run(...ids);
}

/** Mark OTel events as skipped (non-LO project). */
export function skipOtelEvents(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getLocal();
  const placeholders = ids.map(() => "?").join(",");
  db.query(`UPDATE otel_events SET processed = 2 WHERE id IN (${placeholders})`).run(...ids);
}

export function pruneProcessedOtelEvents(olderThanDays: number): number {
  const db = getLocal();
  const result = db
    .query<never, [number]>(
      `DELETE FROM otel_events
       WHERE processed = 1
         AND received_at < datetime('now', ? || ' days')`
    )
    .run(-olderThanDays);
  return result.changes;
}

/**
 * Mark unresolved OTel events as processed if older than threshold.
 * Prevents indefinite accumulation of events from sessions that will
 * never be resolved (e.g., Claude instances outside the org root).
 */
export function expireStaleOtelEvents(olderThanHours: number): number {
  const db = getLocal();
  const result = db
    .query<never, [number]>(
      `UPDATE otel_events SET processed = 1
       WHERE processed = 0
         AND received_at < datetime('now', ? || ' hours')`
    )
    .run(-olderThanHours);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Sessions CRUD
// ---------------------------------------------------------------------------

export interface SessionRow {
  session_id: string;
  proj_id: string;
  parent_session_id: string | null;
  cwd: string;
  first_seen: string;
  pid: number | null;
}

export function upsertSession(
  sessionId: string,
  projId: string,
  cwd: string,
  parentSessionId?: string | null
): void {
  const db = getLocal();
  const now = new Date().toISOString();
  db.query(
    "INSERT OR IGNORE INTO sessions (session_id, proj_id, parent_session_id, cwd, first_seen) VALUES (?, ?, ?, ?, ?)"
  ).run(sessionId, projId, parentSessionId ?? null, cwd, now);
}

/** Count total registered sessions. */
export function sessionCount(): number {
  const db = getLocal();
  const row = db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
    .get()!;
  return row.count;
}

export function getSession(sessionId: string): SessionRow | null {
  const db = getLocal();
  return (
    db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) ?? null
  );
}

// ---------------------------------------------------------------------------
// Cost tracking CRUD
// ---------------------------------------------------------------------------

export interface CostTrackingRow {
  proj_id: string;
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  request_count: number;
}

export function upsertCostTracking(
  projId: string,
  date: string,
  model: string,
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  },
  costUsd: number
): void {
  const db = getLocal();
  db.query(
    `INSERT INTO cost_tracking (proj_id, date, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, request_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (proj_id, date, model) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
       cost_usd = cost_usd + excluded.cost_usd,
       request_count = request_count + 1`
  ).run(projId, date, model, tokens.input, tokens.output, tokens.cache_read, tokens.cache_write, costUsd);
}

export function getCostByProject(projId: string): CostTrackingRow[] {
  const db = getLocal();
  return db
    .query<CostTrackingRow, [string]>(
      "SELECT * FROM cost_tracking WHERE proj_id = ? ORDER BY date DESC, model"
    )
    .all(projId);
}

export function getCostToday(): CostTrackingRow[] {
  const db = getLocal();
  const today = new Date().toISOString().split("T")[0];
  return db
    .query<CostTrackingRow, [string]>(
      "SELECT * FROM cost_tracking WHERE date = ? ORDER BY proj_id, model"
    )
    .all(today);
}
