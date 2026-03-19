/**
 * Outbox reader for the verification dashboard.
 * Opens a READ-ONLY SQLite connection to data/telemetry.db and queries
 * the outbox tables to produce data compatible with the comparator.
 *
 * WAL mode allows concurrent readers alongside the daemon's write connection.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutboxData {
  available: boolean;
  status: string;
  /** projId → event count (from outbox rows with target='events') */
  events: Record<string, number>;
  /** projId → tokens_lifetime (from latest project_telemetry row per project) */
  tokens: Record<string, number>;
  projects: Array<{ id: string; slug: string }>;
  dailyMetrics: Array<{
    date: string;
    project_id: string | null;
    tokens: Record<string, number>;
  }>;
}

export interface OutboxHealth {
  depth: { pending: number; shipped: number; failed: number };
  byTarget: Record<string, { pending: number; shipped: number; failed: number }>;
  archive: { pending: number; shipped: number };
  failedRows: Array<{
    id: number;
    target: string;
    error: string;
    retryCount: number;
    createdAt: string;
  }>;
  cursors: Record<string, { offset: number; updatedAt: string }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function openReadOnly(dbPath: string): Database {
  return new Database(dbPath, { readonly: true });
}

// ─── readFromOutbox ───────────────────────────────────────────────────────────

/**
 * Read telemetry data from the local outbox SQLite database.
 * Returns compatible data for use with the comparator.
 */
export function readFromOutbox(dbPath: string): OutboxData {
  if (!existsSync(dbPath)) {
    return {
      available: false,
      status: "Database not found — daemon hasn't run yet",
      events: {},
      tokens: {},
      projects: [],
      dailyMetrics: [],
    };
  }

  const db = openReadOnly(dbPath);

  try {
    // ── Event counts by project ──────────────────────────────────────────
    const eventRows = db
      .query<{ project_id: string; count: number }, []>(
        `SELECT json_extract(payload, '$.project_id') AS project_id,
                COUNT(*) AS count
         FROM outbox
         WHERE target = 'events'
           AND json_extract(payload, '$.project_id') IS NOT NULL
         GROUP BY project_id`
      )
      .all();

    const events: Record<string, number> = {};
    for (const row of eventRows) {
      events[row.project_id] = row.count;
    }

    // ── Token totals from latest project_telemetry row per project ───────
    const tokenRows = db
      .query<{ project_id: string; tokens_lifetime: number }, []>(
        `SELECT json_extract(payload, '$.project_id')       AS project_id,
                json_extract(payload, '$.tokens_lifetime')  AS tokens_lifetime
         FROM outbox
         WHERE target = 'project_telemetry'
           AND json_extract(payload, '$.project_id') IS NOT NULL
           AND id = (
             SELECT MAX(id) FROM outbox AS inner_o
             WHERE inner_o.target = 'project_telemetry'
               AND json_extract(inner_o.payload, '$.project_id')
                   = json_extract(outbox.payload, '$.project_id')
           )`
      )
      .all();

    const tokens: Record<string, number> = {};
    for (const row of tokenRows) {
      tokens[row.project_id] = Number(row.tokens_lifetime) || 0;
    }

    // ── Daily metrics ─────────────────────────────────────────────────────
    const dmRows = db
      .query<{ project_id: string | null; payload: string }, []>(
        `SELECT json_extract(payload, '$.project_id') AS project_id,
                payload
         FROM outbox
         WHERE target = 'daily_metrics'
           AND id = (
             SELECT MAX(id) FROM outbox AS inner_o
             WHERE inner_o.target = 'daily_metrics'
               AND json_extract(inner_o.payload, '$.project_id')
                   IS json_extract(outbox.payload, '$.project_id')
           )`
      )
      .all();

    const dailyMetrics = dmRows.map((row) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        // ignore malformed payloads
      }
      const { date, project_id, ...rest } = parsed as {
        date?: string;
        project_id?: string | null;
        [key: string]: unknown;
      };
      const tokenFields: Record<string, number> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (typeof v === "number") tokenFields[k] = v;
      }
      return {
        date: (date as string) ?? "",
        project_id: (project_id as string | null) ?? null,
        tokens: tokenFields,
      };
    });

    // ── Known projects ────────────────────────────────────────────────────
    const projectRows = db
      .query<{ proj_id: string; slug: string }, []>(
        "SELECT proj_id, slug FROM known_projects ORDER BY proj_id"
      )
      .all();

    const projects = projectRows.map((r) => ({ id: r.proj_id, slug: r.slug }));

    return {
      available: true,
      status: "ok",
      events,
      tokens,
      projects,
      dailyMetrics,
    };
  } finally {
    db.close();
  }
}

// ─── readOutboxHealth ─────────────────────────────────────────────────────────

/**
 * Read health/diagnostic information from the local outbox.
 */
export function readOutboxHealth(dbPath: string): OutboxHealth {
  if (!existsSync(dbPath)) {
    return {
      depth: { pending: 0, shipped: 0, failed: 0 },
      byTarget: {},
      archive: { pending: 0, shipped: 0 },
      failedRows: [],
      cursors: {},
    };
  }

  const db = openReadOnly(dbPath);

  try {
    // ── Overall depth counts ──────────────────────────────────────────────
    const depthRows = db
      .query<{ status: string; count: number }, []>(
        "SELECT status, COUNT(*) AS count FROM outbox GROUP BY status"
      )
      .all();

    const depth = { pending: 0, shipped: 0, failed: 0 };
    for (const row of depthRows) {
      if (row.status === "pending") depth.pending = row.count;
      else if (row.status === "shipped") depth.shipped = row.count;
      else if (row.status === "failed") depth.failed = row.count;
    }

    // ── Per-target breakdown ──────────────────────────────────────────────
    const targetRows = db
      .query<{ target: string; status: string; count: number }, []>(
        "SELECT target, status, COUNT(*) AS count FROM outbox GROUP BY target, status"
      )
      .all();

    const byTarget: Record<string, { pending: number; shipped: number; failed: number }> = {};
    for (const row of targetRows) {
      if (!byTarget[row.target]) {
        byTarget[row.target] = { pending: 0, shipped: 0, failed: 0 };
      }
      if (row.status === "pending") byTarget[row.target].pending = row.count;
      else if (row.status === "shipped") byTarget[row.target].shipped = row.count;
      else if (row.status === "failed") byTarget[row.target].failed = row.count;
    }

    // ── Archive counts ────────────────────────────────────────────────────
    const archivePendingRow = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM archive_queue WHERE shipped_at IS NULL"
      )
      .get()!;
    const archiveShippedRow = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM archive_queue WHERE shipped_at IS NOT NULL"
      )
      .get()!;

    const archive = {
      pending: archivePendingRow.count,
      shipped: archiveShippedRow.count,
    };

    // ── Failed rows ───────────────────────────────────────────────────────
    const failedRawRows = db
      .query<
        { id: number; target: string; error: string | null; retry_count: number; created_at: string },
        []
      >(
        `SELECT id, target, error, retry_count, created_at
         FROM outbox
         WHERE status = 'failed'
         ORDER BY id`
      )
      .all();

    const failedRows = failedRawRows.map((r) => ({
      id: r.id,
      target: r.target,
      error: r.error ?? "",
      retryCount: r.retry_count,
      createdAt: r.created_at,
    }));

    // ── Cursors ───────────────────────────────────────────────────────────
    const cursorRows = db
      .query<{ source: string; offset: number; updated_at: string }, []>(
        "SELECT source, offset, updated_at FROM cursors"
      )
      .all();

    const cursors: Record<string, { offset: number; updatedAt: string }> = {};
    for (const row of cursorRows) {
      cursors[row.source] = { offset: row.offset, updatedAt: row.updated_at };
    }

    return { depth, byTarget, archive, failedRows, cursors };
  } finally {
    db.close();
  }
}
