/**
 * Receiver adapters — thin wrappers that connect existing parsers to the
 * pipeline by adding cursor persistence.
 *
 * LogReceiver:     LogTailer + SQLite cursor (getCursor/setCursor)
 * TokenReceiver:   scanProjectTokens wrapper
 * MetricsReceiver: readStatsCache + readModelStats wrapper
 */

import { statSync } from "fs";
import { initLocal, getCursor, setCursor, otelEventsReceivedSince } from "../db/local";
import { LogTailer, readStatsCache, readModelStats } from "../parsers";
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

  constructor(logPath: string, dbPath: string) {
    this.tailer = new LogTailer(logPath);

    // Ensure the DB is initialised (idempotent if already done)
    try {
      initLocal(dbPath);
    } catch {
      // Already initialised
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
  private lastFallbackLog = 0;

  constructor(private resolver: ProjectResolver) {}

  /**
   * Poll JSONL token data. Gated by OTel activity — only runs if
   * no OTel events have been received in the last 5 minutes.
   * Returns empty map when OTel data is flowing.
   */
  poll(): ProjectTokenMap {
    const recentOtelEvents = otelEventsReceivedSince(300);

    if (recentOtelEvents > 0) {
      return new Map();
    }

    // Fallback: no OTel events received recently, JSONL scanning active
    const now = Date.now();
    if (now - this.lastFallbackLog > 60_000) {
      console.log("  JSONL fallback: no OTel events in last 5 minutes");
      this.lastFallbackLog = now;
    }

    return scanProjectTokens(this.resolver);
  }

  readAll(): ProjectTokenMap {
    // Always scan all for backfill — skip coverage check
    return scanProjectTokens(this.resolver);
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
