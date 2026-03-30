/**
 * Pure helper functions extracted from daemon.ts for testability.
 * daemon.ts has top-level side effects (env checks, PID file, Supabase init)
 * that prevent direct import in tests.
 */

import type { LogEntry } from "../src/parsers";
import { formatTokens, type ProjectEventAggregates } from "../src/db/types";

export { formatTokens };
export type { ProjectEventAggregates };

// ─── Aggregation ────────────────────────────────────────────────────────────

/** Sum a numeric field across all values in a record. */
export function sumValues(record: Record<string, number>): number {
  let total = 0;
  for (const v of Object.values(record)) total += v;
  return total;
}

/** Build a projId → latest-timestamp map from entries whose project field is already a projId. */
export function computeLastActive(entries: LogEntry[]): Record<string, Date> {
  const lastActiveByProject: Record<string, Date> = {};
  for (const entry of entries) {
    if (!entry.project || !entry.parsedTimestamp) continue;
    if (!lastActiveByProject[entry.project] || entry.parsedTimestamp > lastActiveByProject[entry.project]) {
      lastActiveByProject[entry.project] = entry.parsedTimestamp;
    }
  }
  return lastActiveByProject;
}

/**
 * Filter entries to only LO projects and remap project field to projId.
 * Takes a resolver function to decouple from module state.
 */
export function filterAndMapEntries(
  entries: LogEntry[],
  toProjId: (dirName: string) => string | null
): LogEntry[] {
  return entries.flatMap((e) => {
    const projId = e.project ? toProjId(e.project) : null;
    return projId ? [{ ...e, project: projId }] : [];
  });
}

/**
 * Aggregate per-project event counts by date and event type.
 * Takes a resolver function to decouple from module state.
 */
export function aggregateProjectEvents(
  entries: LogEntry[],
  toProjId: (dirName: string) => string | null
): ProjectEventAggregates {
  const agg: ProjectEventAggregates = new Map();

  for (const entry of entries) {
    if (!entry.project || !entry.parsedTimestamp) continue;

    const projId = toProjId(entry.project);
    if (!projId) continue;
    const date = entry.parsedTimestamp.toISOString().split("T")[0];

    let dateMap = agg.get(projId);
    if (!dateMap) {
      dateMap = new Map();
      agg.set(projId, dateMap);
    }

    let counts = dateMap.get(date);
    if (!counts) {
      counts = { sessions: 0, messages: 0, toolCalls: 0, agentSpawns: 0, teamMessages: 0 };
      dateMap.set(date, counts);
    }

    switch (entry.eventType) {
      case "session_start":   counts.sessions++; break;
      case "response_finish": counts.messages++; break;
      case "tool":            counts.toolCalls++; break;
      case "agent_spawn":     counts.agentSpawns++; break;
      case "message":         counts.teamMessages++; break;
    }
  }

  return agg;
}

/**
 * Filter entries to only those within the last N days.
 * Returns the filtered array (does not mutate input).
 */
export function filterRecentEntries(entries: LogEntry[], days: number): LogEntry[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return entries.filter(
    (e) => e.parsedTimestamp && e.parsedTimestamp >= cutoff
  );
}
