/**
 * Daily metrics sync operations.
 */

import type { StatsCache } from "../parsers";
import type { ProjectTokenMap } from "../project/scanner";
import type { ProjectEventAggregates } from "./types";
import { getSupabase } from "./client";
import { checkResult } from "./check-result";

/**
 * Sync global daily metrics from stats-cache.json.
 */
export async function syncDailyMetrics(statsCache: StatsCache): Promise<number> {
  if (!statsCache.dailyActivity) return 0;

  // Build a map of token data by date
  const tokensByDate: Record<string, Record<string, number>> = {};
  for (const dt of statsCache.dailyModelTokens ?? []) {
    tokensByDate[dt.date] = dt.tokensByModel;
  }

  const rows = statsCache.dailyActivity.map((day) => ({
    date: day.date,
    project_id: null as string | null, // NULL = global aggregate
    messages: day.messageCount,
    sessions: day.sessionCount,
    tool_calls: day.toolCallCount,
    tokens: tokensByDate[day.date] ?? null,
  }));

  if (rows.length === 0) return 0;

  // Batch fetch all existing global daily_metrics rows
  const dates = rows.map((r) => r.date);
  const { data: existingRows } = await getSupabase()
    .from("daily_metrics")
    .select("id, date")
    .in("date", dates)
    .is("project_id", null);

  const existingByDate = new Map<string, number>();
  for (const row of existingRows ?? []) {
    existingByDate.set(row.date, row.id);
  }

  // Split into updates vs inserts
  const toInsert: typeof rows = [];
  const toUpdate: Array<{ id: number; data: Omit<typeof rows[0], "date" | "project_id"> }> = [];

  for (const row of rows) {
    const existingId = existingByDate.get(row.date);
    if (existingId) {
      toUpdate.push({
        id: existingId,
        data: {
          messages: row.messages,
          sessions: row.sessions,
          tool_calls: row.tool_calls,
          tokens: row.tokens,
        },
      });
    } else {
      toInsert.push(row);
    }
  }

  // Bulk insert new rows
  if (toInsert.length > 0) {
    const result = await getSupabase().from("daily_metrics").insert(toInsert);
    checkResult(result, { operation: "syncDailyMetrics.insert", category: "metrics_sync" });
  }

  // Batch update existing rows
  const UPDATE_BATCH = 50;
  for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH) {
    const batch = toUpdate.slice(i, i + UPDATE_BATCH);
    const results = await Promise.all(
      batch.map((u) =>
        getSupabase().from("daily_metrics").update(u.data).eq("id", u.id)
      )
    );
    for (const result of results) {
      checkResult(result, { operation: "syncDailyMetrics.update", category: "metrics_sync" });
    }
  }

  return rows.length;
}

/**
 * Sync per-project daily metrics from JSONL token scan and event aggregates.
 * Upserts rows with project != null into daily_metrics.
 */
interface DailyKeyData {
  tokens?: Record<string, number>;
  events?: { sessions: number; messages: number; toolCalls: number; agentSpawns: number; teamMessages: number };
}

export async function syncProjectDailyMetrics(
  tokenMap: ProjectTokenMap,
  eventAggregates?: ProjectEventAggregates
): Promise<number> {
  // Build a unified set of (project, date) keys from both sources
  const keys = new Map<string, DailyKeyData>();

  const makeKey = (project: string, date: string) => `${project}\0${date}`;

  for (const [project, dateMap] of tokenMap) {
    for (const [date, modelTokens] of dateMap) {
      keys.set(makeKey(project, date), { tokens: modelTokens });
    }
  }

  if (eventAggregates) {
    for (const [project, dateMap] of eventAggregates) {
      for (const [date, counts] of dateMap) {
        const k = makeKey(project, date);
        const existing = keys.get(k) ?? {};
        existing.events = counts;
        keys.set(k, existing);
      }
    }
  }

  const allRows = [...keys.entries()].map(([k, v]) => {
    const [project, date] = k.split("\0");
    return { project, date, ...v };
  });

  if (allRows.length === 0) return 0;

  // Batch fetch all existing per-project daily_metrics rows
  const projects = [...new Set(allRows.map((r) => r.project))];
  const dates = [...new Set(allRows.map((r) => r.date))];

  // Fetch in chunks to stay within Supabase query limits
  const existingByKey = new Map<string, { id: number }>();
  const FETCH_BATCH = 500;
  for (let i = 0; i < projects.length; i += FETCH_BATCH) {
    const projectBatch = projects.slice(i, i + FETCH_BATCH);
    const { data: existingRows } = await getSupabase()
      .from("daily_metrics")
      .select("id, date, project_id")
      .in("project_id", projectBatch)
      .in("date", dates);

    for (const row of existingRows ?? []) {
      existingByKey.set(makeKey(row.project_id, row.date), { id: row.id });
    }
  }

  // Split into updates vs inserts
  interface ProjectDailyMetricsInsert {
    date: string;
    project_id: string;
    tokens: Record<string, number> | null;
    sessions: number;
    messages: number;
    tool_calls: number;
    agent_spawns: number;
    team_messages: number;
  }

  interface ProjectDailyMetricsPartial {
    tokens?: Record<string, number>;
    sessions?: number;
    messages?: number;
    tool_calls?: number;
    agent_spawns?: number;
    team_messages?: number;
  }

  const toInsert: ProjectDailyMetricsInsert[] = [];
  const toUpdate: Array<{ id: number; data: ProjectDailyMetricsPartial }> = [];

  for (const row of allRows) {
    const existing = existingByKey.get(makeKey(row.project, row.date));
    if (existing) {
      const updates: ProjectDailyMetricsPartial = {};
      if (row.tokens) updates.tokens = row.tokens;
      if (row.events) {
        updates.sessions = row.events.sessions;
        updates.messages = row.events.messages;
        updates.tool_calls = row.events.toolCalls;
        updates.agent_spawns = row.events.agentSpawns;
        updates.team_messages = row.events.teamMessages;
      }
      if (Object.keys(updates).length > 0) {
        toUpdate.push({ id: existing.id, data: updates });
      }
    } else {
      toInsert.push({
        date: row.date,
        project_id: row.project,
        tokens: row.tokens ?? null,
        sessions: row.events?.sessions ?? 0,
        messages: row.events?.messages ?? 0,
        tool_calls: row.events?.toolCalls ?? 0,
        agent_spawns: row.events?.agentSpawns ?? 0,
        team_messages: row.events?.teamMessages ?? 0,
      });
    }
  }

  // Bulk insert new rows in batches
  const INSERT_BATCH = 500;
  for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
    const batch = toInsert.slice(i, i + INSERT_BATCH);
    const result = await getSupabase().from("daily_metrics").insert(batch);
    checkResult(result, { operation: "syncProjectDailyMetrics.insert", category: "metrics_sync" });
  }

  // Batch update existing rows with concurrent requests
  const UPDATE_BATCH = 50;
  for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH) {
    const batch = toUpdate.slice(i, i + UPDATE_BATCH);
    const results = await Promise.all(
      batch.map((u) =>
        getSupabase().from("daily_metrics").update(u.data).eq("id", u.id)
      )
    );
    for (const result of results) {
      checkResult(result, { operation: "syncProjectDailyMetrics.update", category: "metrics_sync" });
    }
  }

  return allRows.length;
}

/**
 * Delete all per-project daily_metrics rows.
 * Used before backfill to ensure stale inflated rows don't persist.
 * Global rows (project IS NULL) are left untouched.
 */
export async function deleteProjectDailyMetrics(): Promise<number> {
  const { count, error } = await getSupabase()
    .from("daily_metrics")
    .delete({ count: "exact" })
    .not("project_id", "is", null);

  if (error) {
    checkResult({ error }, { operation: "deleteProjectDailyMetrics", category: "metrics_sync" });
    return 0;
  }

  return count ?? 0;
}
