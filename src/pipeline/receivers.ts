/**
 * Receiver adapters — thin wrappers that connect existing parsers to the
 * pipeline by adding cursor persistence.
 *
 * LogReceiver:     LogTailer + SQLite cursor (getCursor/setCursor)
 * TokenReceiver:   scanProjectTokens wrapper
 * MetricsReceiver: readStatsCache + readModelStats wrapper
 */

import { statSync } from "fs";
import { Database } from "bun:sqlite";
import { initLocal, getLocal, getCursor, setCursor } from "../db/local";
import { LogTailer } from "../parsers";
import { readStatsCache, readModelStats } from "../parsers";
import type { LogEntry, StatsCache, ModelStats } from "../parsers";
import { scanProjectTokens } from "../project/scanner";
import type { ProjectTokenMap } from "../project/scanner";
import type { ProjectResolver } from "../project/resolver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

const CURSOR_SOURCE = "events.log";

// ---------------------------------------------------------------------------
// LogReceiver
// ---------------------------------------------------------------------------

export class LogReceiver {
  private tailer: LogTailer;
  private dbPath: string;

  constructor(logPath: string, dbPath: string) {
    this.tailer = new LogTailer(logPath);
    this.dbPath = dbPath;

    // Ensure the DB is initialised (idempotent if already done)
    try {
      initLocal(dbPath);
    } catch {
      // Already initialised — getLocal() will work
    }

    // Restore cursor from SQLite
    const cursor = getCursor(CURSOR_SOURCE);
    if (cursor !== null) {
      const size = fileSize(logPath);
      if (size < cursor.offset) {
        // File rotated / truncated — start fresh
        this.tailer.resetOffset(0);
      } else {
        this.tailer.resetOffset(cursor.offset);
      }
    }
  }

  /** Read all existing lines (backfill) and persist cursor. */
  readAll(): LogEntry[] {
    const entries = this.tailer.readAll();
    this.persistCursor(this.tailer.currentOffset());
    return entries;
  }

  /** Read only new lines since last call and persist cursor when new data arrives. */
  poll(): LogEntry[] {
    const entries = this.tailer.poll();
    if (entries.length > 0) {
      this.persistCursor(this.tailer.currentOffset());
    }
    return entries;
  }

  private persistCursor(offset: number): void {
    setCursor(CURSOR_SOURCE, offset, String(offset));
  }
}

// ---------------------------------------------------------------------------
// TokenReceiver
// ---------------------------------------------------------------------------

export class TokenReceiver {
  constructor(private resolver: ProjectResolver) {}

  poll(): ProjectTokenMap {
    return scanProjectTokens(this.resolver);
  }

  readAll(): ProjectTokenMap {
    return this.poll();
  }
}

// ---------------------------------------------------------------------------
// MetricsReceiver
// ---------------------------------------------------------------------------

export interface MetricsSnapshot {
  statsCache: StatsCache | null;
  modelStats: ModelStats[];
}

export class MetricsReceiver {
  poll(): MetricsSnapshot {
    return {
      statsCache: readStatsCache(),
      modelStats: readModelStats(),
    };
  }

  readAll(): MetricsSnapshot {
    return this.poll();
  }
}
