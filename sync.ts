/**
 * Supabase sync layer.
 * Pushes parsed telemetry data to the lo-site database.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { LogEntry, ModelStats, StatsCache } from "./parsers";
import type { ProcessDiff } from "./process-watcher";
import type { ProjectTokenMap } from "./project-scanner";

// ─── Shared types ─────────────────────────────────────────────────────────

/** Token breakdown per model, keyed by model name. */
type ModelTokenBreakdown = Record<string, Omit<ModelStats, "model">>;

/** Aggregate metrics for the facility status row. */
interface FacilityMetrics {
  tokensLifetime: number;
  tokensToday: number;
  sessionsLifetime: number;
  messagesLifetime: number;
  modelStats: ModelTokenBreakdown;
  hourDistribution: Record<string, number>;
  firstSessionDate: string | null;
}

/** Format a token count as a human-readable string (e.g. "12.3M"). */
function formatTokens(n: number): string {
  return (n / 1e6).toFixed(1) + "M";
}

let supabase: SupabaseClient;

export function initSupabase(url: string, serviceRoleKey: string): void {
  supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getSupabase(): SupabaseClient {
  return supabase;
}

// ─── Projects ──────────────────────────────────────────────────────────────

/**
 * Ensure a project exists in the projects table.
 * Upserts on proj_id (canonical PK). Tracks local directory names
 * in the local_names array.
 */
export async function upsertProject(
  projId: string,
  contentSlug: string,
  localName: string,
  visibility: "public" | "classified",
  timestamp?: Date
): Promise<void> {
  const now = timestamp ?? new Date();
  const { data, error } = await supabase
    .from("projects")
    .upsert(
      {
        proj_id: projId,
        content_slug: contentSlug,
        visibility: visibility === "public" ? "public" : "private",
        state: visibility === "public" ? "public" : "private",
        status: "explore",
        first_seen: now.toISOString(),
        last_active: now.toISOString(),
        local_names: [],
      },
      { onConflict: "proj_id", ignoreDuplicates: false }
    )
    .select("local_names")
    .single();

  let localNames: string[] | null = data?.local_names as string[] ?? null;

  if (error) {
    // Upsert failed (e.g. first_seen immutable) — fall back to updating last_active
    const { data: fallback, error: updateError } = await supabase
      .from("projects")
      .update({ last_active: now.toISOString(), visibility })
      .eq("proj_id", projId)
      .select("local_names")
      .single();
    if (updateError) {
      console.error(`  Failed to register project ${projId}:`, error.message);
      return;
    }
    localNames = fallback?.local_names as string[] ?? null;
  }

  // Merge localName into local_names if it's not already present
  if (localName && localName !== contentSlug && localNames) {
    if (!localNames.includes(localName)) {
      await supabase
        .from("projects")
        .update({ local_names: [...localNames, localName] })
        .eq("proj_id", projId);
    }
  }
}

/**
 * Update a project's event count and last_active time.
 */
export async function updateProjectActivity(
  projId: string,
  eventCount: number,
  lastActive: Date
): Promise<void> {
  const { data: current } = await supabase
    .from("projects")
    .select("total_events")
    .eq("proj_id", projId)
    .single();

  if (current) {
    await supabase
      .from("projects")
      .update({
        total_events: current.total_events + eventCount,
        last_active: lastActive.toISOString(),
      })
      .eq("proj_id", projId);
  }
}

// ─── Events ────────────────────────────────────────────────────────────────

interface InsertEventsResult {
  inserted: number;
  errors: number;
  insertedByProject: Record<string, number>;
}

const EMPTY_INSERT_RESULT: InsertEventsResult = { inserted: 0, errors: 0, insertedByProject: {} };

/**
 * Insert a batch of events.
 * Uses upsert with ignoreDuplicates to skip events that already exist
 * (unique index on project, event_type, event_text, timestamp).
 */
export async function insertEvents(entries: LogEntry[]): Promise<InsertEventsResult> {
  if (entries.length === 0) return EMPTY_INSERT_RESULT;

  const rows = entries
    .filter((e) => e.parsedTimestamp)
    .map((e) => ({
      timestamp: e.parsedTimestamp!.toISOString(),
      proj_id: e.project,
      branch: e.branch || null,
      emoji: e.emoji || null,
      event_type: e.eventType,
      event_text: e.eventText,
    }));

  let inserted = 0;
  let errors = 0;
  const insertedByProject: Record<string, number> = {};
  const BATCH_SIZE = 500;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("events")
      .upsert(batch, { onConflict: "proj_id,event_type,event_text,timestamp", ignoreDuplicates: true });

    if (error) {
      console.error(`  Error inserting batch ${i}-${i + batch.length}:`, error.message);
      errors += batch.length;
      continue;
    }

    inserted += batch.length;
    for (const row of batch) {
      if (row.proj_id) {
        insertedByProject[row.proj_id] = (insertedByProject[row.proj_id] ?? 0) + 1;
      }
    }
  }

  return { inserted, errors, insertedByProject };
}

// ─── Per-project event aggregation type ───────────────────────────────────

/** project → date → { sessions, messages, toolCalls, agentSpawns, teamMessages } */
export type ProjectEventAggregates = Map<
  string,
  Map<string, { sessions: number; messages: number; toolCalls: number; agentSpawns: number; teamMessages: number }>
>;

// ─── Daily Metrics ─────────────────────────────────────────────────────────

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
    proj_id: null as string | null, // NULL = global aggregate
    messages: day.messageCount,
    sessions: day.sessionCount,
    tool_calls: day.toolCallCount,
    tokens: tokensByDate[day.date] ?? null,
  }));

  if (rows.length === 0) return 0;

  // Batch fetch all existing global daily_metrics rows
  const dates = rows.map((r) => r.date);
  const { data: existingRows } = await supabase
    .from("daily_metrics")
    .select("id, date")
    .in("date", dates)
    .is("proj_id", null);

  const existingByDate = new Map<string, number>();
  for (const row of existingRows ?? []) {
    existingByDate.set(row.date, row.id);
  }

  // Split into updates vs inserts
  const toInsert: typeof rows = [];
  const toUpdate: Array<{ id: number; data: Omit<typeof rows[0], "date" | "proj_id"> }> = [];

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
    await supabase.from("daily_metrics").insert(toInsert);
  }

  // Batch update existing rows (Supabase doesn't support bulk update by different IDs,
  // so we batch these into reasonable chunks to limit sequential calls)
  const UPDATE_BATCH = 50;
  for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH) {
    const batch = toUpdate.slice(i, i + UPDATE_BATCH);
    await Promise.all(
      batch.map((u) =>
        supabase.from("daily_metrics").update(u.data).eq("id", u.id)
      )
    );
  }

  return rows.length;
}

/**
 * Sync per-project daily metrics from JSONL token scan and event aggregates.
 * Upserts rows with project != null into daily_metrics.
 */
export async function syncProjectDailyMetrics(
  tokenMap: ProjectTokenMap,
  eventAggregates?: ProjectEventAggregates
): Promise<number> {
  // Build a unified set of (project, date) keys from both sources
  const keys = new Map<string, { tokens?: Record<string, number>; events?: { sessions: number; messages: number; toolCalls: number; agentSpawns: number; teamMessages: number } }>();

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
    const { data: existingRows } = await supabase
      .from("daily_metrics")
      .select("id, date, proj_id")
      .in("proj_id", projectBatch)
      .in("date", dates);

    for (const row of existingRows ?? []) {
      existingByKey.set(makeKey(row.proj_id, row.date), { id: row.id });
    }
  }

  // Split into updates vs inserts
  interface ProjectDailyMetricsInsert {
    date: string;
    proj_id: string;
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
        proj_id: row.project,
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
    const { error } = await supabase.from("daily_metrics").insert(batch);
    if (error) {
      console.error(`  Error bulk inserting project metrics:`, error.message);
    }
  }

  // Batch update existing rows with concurrent requests
  const UPDATE_BATCH = 50;
  for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH) {
    const batch = toUpdate.slice(i, i + UPDATE_BATCH);
    await Promise.all(
      batch.map((u) =>
        supabase.from("daily_metrics").update(u.data).eq("id", u.id)
      )
    );
  }

  return allRows.length;
}

// ─── Facility Status ───────────────────────────────────────────────────────

export interface FacilityUpdate extends FacilityMetrics {
  status: "active" | "dormant";
  activeAgents: number;
  activeProjects: Array<{ name: string; active: boolean }>;
}

/** Map FacilityMetrics fields to the DB column names. */
function metricsToRow(metrics: FacilityMetrics): Record<string, unknown> {
  return {
    tokens_lifetime: metrics.tokensLifetime,
    tokens_today: metrics.tokensToday,
    sessions_lifetime: metrics.sessionsLifetime,
    messages_lifetime: metrics.messagesLifetime,
    model_stats: metrics.modelStats,
    hour_distribution: metrics.hourDistribution,
    first_session_date: metrics.firstSessionDate,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Update the singleton facility_status row with agent fields and aggregate metrics.
 * NOTE: status is NOT written here -- it's owned by the manual switch (lo-open/lo-close).
 */
export async function updateFacilityStatus(update: FacilityUpdate): Promise<void> {
  const { error } = await supabase
    .from("facility_status")
    .update({
      ...metricsToRow(update),
      active_agents: update.activeAgents,
      active_projects: update.activeProjects,
    })
    .eq("id", 1);

  if (error) {
    console.error("Error updating facility status:", error.message);
  }
}

// ─── Facility Switch (manual open/close) ─────────────────────────────────────

/**
 * Set the facility open/close status.
 * Only called by lo-open/lo-close commands and the auto-close timer.
 */
export async function setFacilitySwitch(status: "active" | "dormant"): Promise<void> {
  const { error } = await supabase
    .from("facility_status")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) {
    console.error("Error setting facility switch:", error.message);
  }
}

// ─── Facility Metrics (aggregate only) ──────────────────────────────────────

/**
 * FacilityMetricsUpdate is a type alias for FacilityMetrics.
 * Kept as a named export so callers express intent clearly.
 */
export type FacilityMetricsUpdate = FacilityMetrics;

/**
 * Update aggregate metrics on facility_status.
 * Does NOT write agent fields (status, active_agents, active_projects) --
 * those are owned by the ProcessWatcher via pushAgentState().
 */
export async function updateFacilityMetrics(update: FacilityMetricsUpdate): Promise<void> {
  const { error } = await supabase
    .from("facility_status")
    .update(metricsToRow(update))
    .eq("id", 1);

  if (error) {
    console.error("Error updating facility metrics:", error.message);
  }
}

// ─── Project Telemetry ──────────────────────────────────────────────────────

export interface ProjectTelemetryUpdate {
  projId: string;
  tokensLifetime: number;
  tokensToday: number;
  modelsToday: Record<string, number>;
  sessionsLifetime: number;
  messagesLifetime: number;
  toolCallsLifetime: number;
  agentSpawnsLifetime: number;
  teamMessagesLifetime: number;
  activeAgents: number;
  agentCount: number;
}

interface ProjectTelemetryRow {
  proj_id: string;
  tokens_lifetime: number;
  tokens_today: number;
  models_today: Record<string, number>;
  sessions_lifetime: number;
  messages_lifetime: number;
  tool_calls_lifetime: number;
  agent_spawns_lifetime: number;
  team_messages_lifetime: number;
  updated_at: string;
  active_agents?: number;
  agent_count?: number;
}

export async function batchUpsertProjectTelemetry(
  updates: ProjectTelemetryUpdate[],
  options: { skipAgentFields?: boolean } = {}
): Promise<void> {
  if (updates.length === 0) return;

  const now = new Date().toISOString();

  function toRow(u: ProjectTelemetryUpdate): ProjectTelemetryRow {
    const row: ProjectTelemetryRow = {
      proj_id: u.projId,
      tokens_lifetime: u.tokensLifetime,
      tokens_today: u.tokensToday,
      models_today: u.modelsToday,
      sessions_lifetime: u.sessionsLifetime,
      messages_lifetime: u.messagesLifetime,
      tool_calls_lifetime: u.toolCallsLifetime,
      agent_spawns_lifetime: u.agentSpawnsLifetime,
      team_messages_lifetime: u.teamMessagesLifetime,
      updated_at: now,
    };
    if (!options.skipAgentFields) {
      row.active_agents = u.activeAgents;
      row.agent_count = u.agentCount;
    }
    return row;
  }

  console.log(
    `  project_telemetry: writing ${updates.length} rows —`,
    updates.map((u) => `${u.projId}: ${formatTokens(u.tokensLifetime)}`).join(", ")
  );

  // Try batch upsert first (fast path)
  const rows = updates.map(toRow);
  const { error } = await supabase
    .from("project_telemetry")
    .upsert(rows, { onConflict: "proj_id" });

  if (error) {
    // Batch failed (likely FK violation) -- fall back to per-row upserts
    console.error(`  project_telemetry: batch upsert failed (${error.message}), falling back to per-row`);
    let succeeded = 0;
    for (const update of updates) {
      const { error: rowError } = await supabase
        .from("project_telemetry")
        .upsert(toRow(update), { onConflict: "proj_id" });
      if (rowError) {
        console.error(`  project_telemetry: skipping ${update.projId} (${rowError.message})`);
      } else {
        succeeded++;
      }
    }
    console.log(`  project_telemetry: ${succeeded}/${updates.length} rows updated (batch fallback)`);
  }

  // Verify: read back and compare tokens_lifetime
  await verifyProjectTelemetry(updates);
}

/**
 * Read back project_telemetry rows and log any mismatches against expected values.
 */
async function verifyProjectTelemetry(updates: ProjectTelemetryUpdate[]): Promise<void> {
  const { data: rows } = await supabase
    .from("project_telemetry")
    .select("proj_id, tokens_lifetime");

  if (!rows) return;

  const dbValues = new Map(rows.map((r) => [r.proj_id as string, Number(r.tokens_lifetime)]));
  let mismatches = 0;

  for (const u of updates) {
    const dbVal = dbValues.get(u.projId);
    if (dbVal !== undefined && dbVal !== u.tokensLifetime) {
      console.error(
        `  project_telemetry MISMATCH: ${u.projId} — wrote ${formatTokens(u.tokensLifetime)} but DB has ${formatTokens(dbVal)}`
      );
      mismatches++;
    }
  }

  if (mismatches === 0) {
    console.log(`  project_telemetry: verified ${updates.length} rows match DB`);
  }
}

// ─── Pre-backfill Cleanse ────────────────────────────────────────────────────

/**
 * Delete all per-project daily_metrics rows.
 * Used before backfill to ensure stale inflated rows don't persist.
 * Global rows (project IS NULL) are left untouched.
 */
export async function deleteProjectDailyMetrics(): Promise<number> {
  const { count, error } = await supabase
    .from("daily_metrics")
    .delete({ count: "exact" })
    .not("proj_id", "is", null);

  if (error) {
    console.error("Error deleting per-project daily_metrics:", error.message);
    return 0;
  }

  return count ?? 0;
}

// ─── Event Pruning ──────────────────────────────────────────────────────────

/**
 * Delete events older than the retention period.
 * Aggregated data lives in daily_metrics; old events only bloat the table.
 */
export async function pruneOldEvents(retentionDays = 14): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const { count, error } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .lt("timestamp", cutoff.toISOString());

  if (error) {
    console.error("Error pruning old events:", error.message);
    return 0;
  }

  return count ?? 0;
}

// ─── Agent State Push (Process Watcher) ─────────────────────────────────────

/**
 * Push agent state changes from the ProcessWatcher.
 * Only writes agent-related fields — never touches aggregate metrics.
 * All writes fire in parallel for minimum latency.
 */
export async function pushAgentState(diff: ProcessDiff): Promise<void> {
  const now = new Date().toISOString();

  const projectWrites = [...diff.byProject.entries()].map(([projId, counts]) =>
    supabase
      .from("project_telemetry")
      .update({ active_agents: counts.active, agent_count: counts.count, updated_at: now })
      .eq("proj_id", projId)
  );

  // Facility agent fields only -- status is owned by the manual switch (lo-open/lo-close)
  const facilityWrite = supabase
    .from("facility_status")
    .update({ active_agents: diff.facility.activeAgents, active_projects: diff.facility.activeProjects, updated_at: now })
    .eq("id", 1);

  const activityWrites = [...diff.byProject.entries()]
    .filter(([, counts]) => counts.active > 0)
    .map(([projId]) =>
      supabase.from("projects").update({ last_active: now }).eq("proj_id", projId)
    );

  const results = await Promise.all([...projectWrites, facilityWrite, ...activityWrites]);

  for (const result of results) {
    if (result.error) {
      console.error("  pushAgentState error:", result.error.message);
    }
  }
}
