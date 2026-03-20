/**
 * Remote (Supabase) data reader for the verification dashboard.
 * Queries Supabase tables to get the remote side of each comparison.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RemoteEvents {
  /** projId → date → count */
  byProjectDate: Record<string, Record<string, number>>;
  totalCount: number;
}

export interface RemoteMetrics {
  dailyActivity: Array<{
    date: string;
    messages: number;
    sessions: number;
    toolCalls: number;
  }>;
}

export interface RemoteTokens {
  /** project id → tokens_lifetime */
  byProject: Record<string, number>;
}

export interface RemoteModels {
  /** model → { total, input, cacheWrite, cacheRead, output } */
  stats: Record<
    string,
    { total: number; input: number; cacheWrite: number; cacheRead: number; output: number }
  >;
}

export interface RemoteProject {
  id: string;
  slug: string;
  lastActive: string | null;
}

export interface RemoteData {
  events: RemoteEvents;
  metrics: RemoteMetrics;
  tokens: RemoteTokens;
  models: RemoteModels;
  projects: RemoteProject[];
  hourDistribution: Record<string, number>;
  lastSync: string | null;
  latencyMs: number;
  connected: boolean;
}

// ─── Readers ────────────────────────────────────────────────────────────────

/**
 * Fetch events with pagination (Supabase default limit is 1000).
 * Uses the provided cutoff (log start date) so we only compare the
 * time range where both local and remote have data.
 */
async function readRemoteEvents(supabase: SupabaseClient, cutoff: Date): Promise<{ data: RemoteEvents; ok: boolean }> {
  const byProjectDate: Record<string, Record<string, number>> = {};
  let totalCount = 0;
  let offset = 0;
  const PAGE_SIZE = 1000;
  let ok = false;

  while (true) {
    const { data, error } = await supabase
      .from("events")
      .select("project_id, timestamp")
      .gte("timestamp", cutoff.toISOString())
      .range(offset, offset + PAGE_SIZE - 1);

    if (error || !data) break;
    ok = true;

    for (const row of data) {
      const projId = row.project_id as string;
      const date = (row.timestamp as string).split("T")[0];
      if (!byProjectDate[projId]) byProjectDate[projId] = {};
      byProjectDate[projId][date] = (byProjectDate[projId][date] ?? 0) + 1;
      totalCount++;
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { data: { byProjectDate, totalCount }, ok };
}

async function readRemoteMetrics(supabase: SupabaseClient): Promise<{ data: RemoteMetrics; ok: boolean }> {
  const { data, error } = await supabase
    .from("daily_metrics")
    .select("date, messages, sessions, tool_calls")
    .order("date", { ascending: true });

  if (error || !data) return { data: { dailyActivity: [] }, ok: false };

  // Aggregate per-project rows by date (same pattern as platform's getDailyActivity)
  const byDate = new Map<string, { messages: number; sessions: number; toolCalls: number }>();
  for (const row of data) {
    const date = row.date as string;
    const existing = byDate.get(date) ?? { messages: 0, sessions: 0, toolCalls: 0 };
    existing.messages += Number(row.messages) || 0;
    existing.sessions += Number(row.sessions) || 0;
    existing.toolCalls += Number(row.tool_calls) || 0;
    byDate.set(date, existing);
  }

  return {
    data: {
      dailyActivity: Array.from(byDate.entries()).map(([date, counts]) => ({
        date,
        ...counts,
      })),
    },
    ok: true,
  };
}

async function readRemoteTokens(supabase: SupabaseClient): Promise<{ data: RemoteTokens; ok: boolean }> {
  const { data, error } = await supabase
    .from("project_telemetry")
    .select("project_id, tokens_lifetime");

  if (error || !data) return { data: { byProject: {} }, ok: false };

  const byProject: Record<string, number> = {};
  for (const row of data) {
    byProject[row.project_id as string] = Number(row.tokens_lifetime) || 0;
  }

  return { data: { byProject }, ok: true };
}

async function readRemoteModels(supabase: SupabaseClient): Promise<{ data: RemoteModels; ok: boolean }> {
  const { data, error } = await supabase
    .from("facility_status")
    .select("model_stats")
    .eq("id", 1)
    .single();

  if (error || !data?.model_stats) return { data: { stats: {} }, ok: false };

  return { data: { stats: data.model_stats as RemoteModels["stats"] }, ok: true };
}

async function readRemoteProjects(supabase: SupabaseClient): Promise<{ data: RemoteProject[]; ok: boolean }> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, slug, last_active");

  if (error || !data) return { data: [], ok: false };

  return {
    data: data.map((row) => ({
      id: row.id as string,
      slug: row.slug as string,
      lastActive: row.last_active as string | null,
    })),
    ok: true,
  };
}

async function readRemoteHourDistribution(
  supabase: SupabaseClient
): Promise<{ data: Record<string, number>; ok: boolean }> {
  const { data, error } = await supabase
    .from("facility_status")
    .select("hour_distribution")
    .eq("id", 1)
    .single();

  if (error || !data?.hour_distribution) return { data: {}, ok: false };
  return { data: data.hour_distribution as Record<string, number>, ok: true };
}

async function readLastSync(supabase: SupabaseClient): Promise<{ data: string | null; ok: boolean }> {
  const { data, error } = await supabase
    .from("facility_status")
    .select("updated_at")
    .eq("id", 1)
    .single();

  if (error || !data) return { data: null, ok: false };
  return { data: data.updated_at as string, ok: true };
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * @param eventCutoff If provided, only fetch events after this date.
 *   Used to align the remote window with the local events.log start date
 *   so we only compare the range where both sides have data.
 */
export async function readAllRemote(
  supabase: SupabaseClient,
  eventCutoff?: Date
): Promise<RemoteData> {
  const start = Date.now();
  const defaultCutoff = new Date();
  defaultCutoff.setDate(defaultCutoff.getDate() - 14);

  const [events, metrics, tokens, models, projects, hourDistribution, lastSync] =
    await Promise.all([
      readRemoteEvents(supabase, eventCutoff ?? defaultCutoff),
      readRemoteMetrics(supabase),
      readRemoteTokens(supabase),
      readRemoteModels(supabase),
      readRemoteProjects(supabase),
      readRemoteHourDistribution(supabase),
      readLastSync(supabase),
    ]);

  const connected = [events, metrics, tokens, models, projects, hourDistribution, lastSync]
    .some((r) => r.ok);

  return {
    events: events.data,
    metrics: metrics.data,
    tokens: tokens.data,
    models: models.data,
    projects: projects.data,
    hourDistribution: hourDistribution.data,
    lastSync: lastSync.data,
    latencyMs: Date.now() - start,
    connected,
  };
}
