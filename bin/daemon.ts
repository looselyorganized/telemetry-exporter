#!/usr/bin/env bun
/**
 * LO Telemetry Exporter
 *
 * Reads Claude Code telemetry from ~/.claude/ and pushes it to Supabase
 * for the Loosely Organized operations dashboard.
 *
 * Usage:
 *   bun run bin/daemon.ts              # Start the daemon (incremental sync)
 *   bun run bin/daemon.ts --backfill   # Backfill all historical data, then run daemon
 */

import {
  LogTailer,
  readModelStats,
  readStatsCache,
  type LogEntry,
} from "../src/parsers";
import {
  formatTokens,
  sumValues,
  computeLastActive,
  formatModelStats,
  filterAndMapEntries,
  aggregateProjectEvents,
  buildProjectTelemetryUpdates as buildTelemetryUpdatesHelper,
  filterRecentEntries,
  type LifetimeCounters,
  type TodayTokens,
} from "./daemon-helpers";
import { getFacilityState } from "../src/process/scanner";
import { scanProjectTokens, computeTokensByProject } from "../src/project/scanner";
import {
  initSupabase,
  getSupabase,
  upsertProject,
  updateProjectActivity,
  insertEvents,
  syncDailyMetrics,
  syncProjectDailyMetrics,
  deleteProjectDailyMetrics,
  updateFacilityStatus,
  batchUpsertProjectTelemetry,
  pruneOldEvents,
  pushAgentState,
  updateFacilityMetrics,
  setFacilitySwitch,
  type FacilityUpdate,
  type FacilityMetricsUpdate,
  type ProjectTelemetryUpdate,
  type ProjectEventAggregates,
} from "../src/sync";
import { ProcessWatcher } from "../src/process/watcher";
import {
  loadVisibilityCache,
  getVisibility,
} from "../src/visibility-cache";
import { buildSlugMap, clearSlugCache, resolveProjId, clearProjIdCache, PROJECT_ROOT } from "../src/project/slug-resolver";
import { PID_FILE, isProcessRunning } from "../src/cli-output";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

// ─── Config ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const IS_BACKFILL = process.argv.includes("--backfill");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  console.error("Copy .env.example to .env and fill in your credentials.");
  process.exit(1);
}

// ─── Single-instance guard (PID file) ───────────────────────────────────────

if (existsSync(PID_FILE)) {
  const existingPid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (!isNaN(existingPid) && isProcessRunning(existingPid) && existingPid !== process.pid) {
    console.error(`Another exporter is already running (PID ${existingPid}).`);
    console.error(`If this is stale, remove ${PID_FILE} and retry.`);
    process.exit(1);
  }
}

writeFileSync(PID_FILE, String(process.pid));

// Clean up PID file on exit
function removePidFile(): void {
  try { unlinkSync(PID_FILE); } catch {}
}

function handleShutdown(): void {
  removePidFile();
  process.exit(0);
}

process.on("exit", removePidFile);
process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);

// ─── Init ──────────────────────────────────────────────────────────────────

console.log("LO Telemetry Exporter starting...");
console.log(`  Supabase: ${SUPABASE_URL}`);
console.log(`  Watcher: 250ms poll (agent state push-on-change)`);
console.log(`  Aggregator: 5s cycle (tokens, sessions, events)`);
console.log(`  Mode: ${IS_BACKFILL ? "BACKFILL + daemon" : "daemon (incremental)"}`);
console.log();

initSupabase(SUPABASE_URL, SUPABASE_KEY);
loadVisibilityCache();

const tailer = new LogTailer();

// ─── State ──────────────────────────────────────────────────────────────────

// Track projects we've already ensured exist in the DB (by projId)
const knownProjects = new Set<string>();

// Directory name → slug mapping, refreshed every 60 cycles
let slugMap: Map<string, string> = new Map();

// Directory name → projId mapping, refreshed every 60 cycles
let projIdMap: Map<string, string> = new Map();

// Org-root directory names that should map to the org-root project
const ORG_ROOT_ID = "proj_org-root";
const ORG_ROOT_NAMES = ["looselyorganized", "lo"];

async function refreshMaps(): Promise<void> {
  clearSlugCache();
  clearProjIdCache();
  slugMap = buildSlugMap();

  projIdMap = new Map();
  for (const [dirName] of slugMap) {
    const projId = resolveProjId(join(PROJECT_ROOT, dirName));
    if (projId) projIdMap.set(dirName, projId);
  }

  // Map org-root directory names so events from the parent dir are tracked
  for (const name of ORG_ROOT_NAMES) {
    projIdMap.set(name, ORG_ROOT_ID);
    slugMap.set(name, "org-root");
  }

  console.log(`  Project maps: ${projIdMap.size} projects mapped`);
}

/** Map a directory name (from events.log) to its content_slug, or null if not a LO project */
function toSlug(dirName: string): string | null {
  return slugMap.get(dirName) ?? null;
}

/** Map a directory name (from events.log) to its project id, or null if not a LO project */
function toProjId(dirName: string): string | null {
  return projIdMap.get(dirName) ?? null;
}

/** Filter entries to only LO projects and map project fields to projIds */
function filterAndMapLocal(entries: LogEntry[]): LogEntry[] {
  return filterAndMapEntries(entries, toProjId);
}

// Cache project token totals for facility status updates
let cachedTokensByProject: Record<string, number> = {};

// Cache per-project lifetime counters for project_telemetry writes
let cachedLifetimeCounters: Record<string, LifetimeCounters> = {};

// Cache per-project today tokens for project_telemetry writes
let cachedTodayTokensByProject: Record<string, TodayTokens> = {};

// Cache all seen log entries to avoid re-reading the entire events.log
let allSeenEntries: LogEntry[] = [];

// Cache model stats — only re-read from disk when new events arrive
let cachedModelStats: ReturnType<typeof readModelStats> = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Today's date as "YYYY-MM-DD". */
function todayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

// ─── Ensure projects exist ─────────────────────────────────────────────────

async function ensureProjects(entries: LogEntry[]): Promise<void> {
  const newProjIds = new Set<string>();
  const projIdToLocal = new Map<string, string>();
  const projIdToSlug = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.project) continue;
    const projId = toProjId(entry.project);
    const slug = toSlug(entry.project);
    if (!projId || !slug) continue;
    if (!knownProjects.has(projId)) {
      newProjIds.add(projId);
      projIdToLocal.set(projId, entry.project);
      projIdToSlug.set(projId, slug);
    }
  }

  for (const projId of newProjIds) {
    const localName = projIdToLocal.get(projId) ?? "";
    const slug = projIdToSlug.get(projId) ?? "";
    const visibility = getVisibility(localName);
    const firstEntry = entries.find((e) => toProjId(e.project) === projId);
    const ok = await upsertProject(projId, slug, localName, visibility, firstEntry?.parsedTimestamp ?? undefined);
    if (ok) {
      knownProjects.add(projId);
      console.log(`  Project registered: ${slug} [${projId}]${slug !== localName ? ` (dir: ${localName})` : ""} (${visibility})`);
    } else {
      console.error(`  Project registration failed: ${slug} [${projId}] — will retry next cycle`);
    }
  }
}

// ─── Compute facility-wide totals from per-project caches ──────────────────

function computeTodayTokens(): number {
  let total = 0;
  for (const entry of Object.values(cachedTodayTokensByProject)) total += entry.total;
  return total;
}

function sumLifetimeField(field: keyof LifetimeCounters): number {
  let total = 0;
  for (const c of Object.values(cachedLifetimeCounters)) total += c[field];
  return total;
}

/** Aggregate per-project events using the local projIdMap resolver. */
function aggregateProjectEventsLocal(entries: LogEntry[]): ProjectEventAggregates {
  return aggregateProjectEvents(entries, toProjId);
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Build ProjectTelemetryUpdate[] from cached data. */
function buildProjectTelemetryUpdates(
  agentsByProject?: Record<string, { count: number; active: number }>
): ProjectTelemetryUpdate[] {
  return buildTelemetryUpdatesHelper(
    {
      tokensByProject: cachedTokensByProject,
      lifetimeCounters: cachedLifetimeCounters,
      todayTokensByProject: cachedTodayTokensByProject,
    },
    agentsByProject
  ) as ProjectTelemetryUpdate[];
}

// ─── Shared: insert events and update project activity ──────────────────────

/**
 * Filter entries to LO projects, insert into Supabase, and update
 * per-project activity counts. Returns the insert result.
 */
async function insertAndTrackActivity(entries: LogEntry[]): Promise<{
  inserted: number;
  errors: number;
}> {
  const loEntries = filterAndMapLocal(entries);
  const { inserted, errors, insertedByProject } = await insertEvents(loEntries);

  const lastActiveByProject = computeLastActive(loEntries);
  for (const [projId, count] of Object.entries(insertedByProject)) {
    const lastActive = lastActiveByProject[projId] ?? new Date();
    await updateProjectActivity(projId, count, lastActive);
  }

  return { inserted, errors };
}

// ─── Backfill ──────────────────────────────────────────────────────────────

async function backfill(): Promise<void> {
  console.log("Starting backfill...");

  // 1. Build slug + projId maps
  await refreshMaps();

  // 2. Read all events
  console.log("  Reading events.log...");
  const allEntries = tailer.readAll();
  allSeenEntries = allEntries;
  console.log(`  Found ${allEntries.length} events`);

  // 3. Ensure all projects exist
  console.log("  Registering projects...");
  await ensureProjects(allEntries);

  // 4. Insert events and update project activity
  console.log("  Inserting events...");
  const { inserted, errors } = await insertAndTrackActivity(allEntries);
  console.log(`  Inserted: ${inserted}, Errors: ${errors}`);

  // 5. Sync daily metrics from stats-cache.json
  console.log("  Syncing daily metrics...");
  const statsCache = readStatsCache();
  cachedModelStats = readModelStats();
  if (statsCache) {
    const synced = await syncDailyMetrics(statsCache);
    console.log(`  Synced ${synced} daily metric rows`);
  }

  // 6. Delete stale per-project daily_metrics before recomputing
  console.log("  Cleansing stale per-project daily_metrics...");
  const deletedRows = await deleteProjectDailyMetrics();
  console.log(`  Deleted ${deletedRows} stale per-project daily_metrics rows`);

  // 7. Scan and sync per-project token metrics + event counts from JSONL files
  console.log("  Scanning JSONL files for per-project tokens...");
  const projectTokenMap = scanProjectTokens();
  cachedTokensByProject = computeTokensByProject(projectTokenMap);
  const projectEventAggregates = aggregateProjectEventsLocal(allEntries);
  const projectSynced = await syncProjectDailyMetrics(projectTokenMap, projectEventAggregates);
  console.log(`  Synced ${projectSynced} per-project daily metric rows`);

  // 8. Populate caches for project_telemetry writes from daily_metrics (authoritative)
  await refreshLifetimeCountersFromDb();
  refreshTodayTokensCache(projectTokenMap, todayDateString());

  // 9. Update facility status + project_telemetry
  console.log("  Updating facility status...");
  await syncFacilityStatus(statsCache, cachedModelStats);

  // 10. Verify backfill writes persisted -- refresh caches from DB
  console.log("  Verifying backfill writes...");
  const { data: verifyRows } = await getSupabase()
    .from("project_telemetry")
    .select("id, tokens_lifetime");
  if (verifyRows) {
    for (const row of verifyRows) {
      const projId = row.id as string;
      const dbTokens = Number(row.tokens_lifetime);
      const expected = cachedTokensByProject[projId] ?? 0;
      if (dbTokens !== expected) {
        console.warn(
          `  WARN: ${projId} — cache has ${formatTokens(expected)} but DB has ${formatTokens(dbTokens)}`
        );
      }
      cachedTokensByProject[projId] = dbTokens;
    }
    console.log(
      `  Verified ${verifyRows.length} project_telemetry rows:`,
      verifyRows.map((r) => `${r.id}: ${formatTokens(Number(r.tokens_lifetime))}`).join(", ")
    );
  }

  pruneSeenEntries();

  console.log("Backfill complete.\n");
}

// ─── Incremental sync ──────────────────────────────────────────────────────

async function incrementalSync(): Promise<void> {
  const newEntries = tailer.poll();

  if (newEntries.length > 0) {
    allSeenEntries.push(...newEntries);
    await ensureProjects(newEntries);
    cachedModelStats = readModelStats();

    const { inserted, errors } = await insertAndTrackActivity(newEntries);
    if (inserted > 0 || errors > 0) {
      console.log(
        `  ${new Date().toLocaleTimeString()} — ${inserted} events synced${errors > 0 ? `, ${errors} errors` : ""}`
      );
    }
  }

  // Sync aggregate metrics (tokens, sessions — NOT agent state)
  const statsCache = readStatsCache();
  await syncAggregateMetrics(statsCache, cachedModelStats);
}

// ─── Facility status sync ──────────────────────────────────────────────────

/** Build the aggregate metrics shared by facility status and metrics-only updates. */
function buildFacilityMetrics(
  statsCache: ReturnType<typeof readStatsCache>,
  modelStats: ReturnType<typeof readModelStats>
): FacilityMetricsUpdate {
  return {
    tokensLifetime: sumValues(cachedTokensByProject),
    tokensToday: computeTodayTokens(),
    sessionsLifetime: sumLifetimeField("sessions"),
    messagesLifetime: sumLifetimeField("messages"),
    modelStats: formatModelStats(modelStats),
    hourDistribution: statsCache?.hourCounts ?? {},
    firstSessionDate: statsCache?.firstSessionDate ?? null,
  };
}

async function syncFacilityStatus(
  statsCache: ReturnType<typeof readStatsCache>,
  modelStats: ReturnType<typeof readModelStats>
): Promise<ReturnType<typeof getFacilityState>> {
  const facility = getFacilityState();

  // Compute per-project agent breakdown (keyed by projId)
  const agentsByProject: Record<string, { count: number; active: number }> = {};
  for (const proc of facility.processes) {
    if (proc.projId === "unknown") continue;
    const entry = agentsByProject[proc.projId] ??= { count: 0, active: 0 };
    entry.count++;
    if (proc.isActive) entry.active++;
  }

  const update: FacilityUpdate = {
    ...buildFacilityMetrics(statsCache, modelStats),
    status: facility.status,
    activeAgents: facility.activeAgents,
    activeProjects: facility.activeProjects,
  };

  await updateFacilityStatus(update);
  await batchUpsertProjectTelemetry(buildProjectTelemetryUpdates(agentsByProject));

  return facility;
}

// ─── Aggregate metrics sync (daemon mode) ──────────────────────────────────

async function syncAggregateMetrics(
  statsCache: ReturnType<typeof readStatsCache>,
  modelStats: ReturnType<typeof readModelStats>
): Promise<void> {
  await updateFacilityMetrics(buildFacilityMetrics(statsCache, modelStats));
  await batchUpsertProjectTelemetry(buildProjectTelemetryUpdates(), { skipAgentFields: true });
}

// ─── Periodic daily metrics sync ───────────────────────────────────────────

let lastDailySync = "";

async function maybeSyncDailyMetrics(
  statsCache: ReturnType<typeof readStatsCache>
): Promise<void> {
  const today = todayDateString();
  if (today === lastDailySync) return;

  if (statsCache) {
    await syncDailyMetrics(statsCache);
    lastDailySync = today;
  }
}

// ─── Periodic project daily metrics sync ────────────────────────────────────

let lastProjectSync = "";
let lastPruneDate = "";

async function maybeSyncProjectDailyMetrics(): Promise<void> {
  const today = todayDateString();
  if (today === lastProjectSync) return;

  try {
    const projectTokenMap = scanProjectTokens();
    cachedTokensByProject = computeTokensByProject(projectTokenMap);
    const projectEventAggregates = aggregateProjectEventsLocal(allSeenEntries);
    await syncProjectDailyMetrics(projectTokenMap, projectEventAggregates);

    await refreshLifetimeCountersFromDb();
    refreshTodayTokensCache(projectTokenMap, today);

    lastProjectSync = today;
  } catch (err) {
    console.error("Error syncing project daily metrics:", err);
  }
}

/**
 * Refresh lifetime counters (sessions, messages, tool_calls, etc.)
 * from daily_metrics in Supabase. This is the authoritative source
 * because in daemon mode allSeenEntries only contains events since startup.
 */
async function refreshLifetimeCountersFromDb(): Promise<void> {
  const { data: lifetimeRows } = await getSupabase()
    .from("daily_metrics")
    .select("project_id, sessions, messages, tool_calls, agent_spawns, team_messages")
    .not("project_id", "is", null);
  if (lifetimeRows) {
    const sums: Record<string, LifetimeCounters> = {};
    for (const row of lifetimeRows) {
      const p = row.project_id as string;
      if (!sums[p]) sums[p] = { sessions: 0, messages: 0, toolCalls: 0, agentSpawns: 0, teamMessages: 0 };
      sums[p].sessions += Number(row.sessions) || 0;
      sums[p].messages += Number(row.messages) || 0;
      sums[p].toolCalls += Number(row.tool_calls) || 0;
      sums[p].agentSpawns += Number(row.agent_spawns) || 0;
      sums[p].teamMessages += Number(row.team_messages) || 0;
    }
    cachedLifetimeCounters = sums;
  }
}

/**
 * Re-scan JSONL files and refresh all per-project caches.
 * Runs on the 5-minute cycle so token counts and lifetime counters
 * stay current throughout the day.
 */
async function refreshProjectCachesFromDisk(): Promise<void> {
  const today = todayDateString();
  const projectTokenMap = scanProjectTokens();
  cachedTokensByProject = computeTokensByProject(projectTokenMap);
  refreshTodayTokensCache(projectTokenMap, today);
  await refreshLifetimeCountersFromDb();
}

function refreshTodayTokensCache(projectTokenMap: ReturnType<typeof scanProjectTokens>, today: string): void {
  for (const [projId, dateMap] of projectTokenMap) {
    const models = dateMap.get(today) ?? {};
    cachedTodayTokensByProject[projId] = { total: sumValues(models), models };
  }
}

async function maybePruneEvents(): Promise<void> {
  const today = todayDateString();
  if (today === lastPruneDate) return;

  try {
    const pruned = await pruneOldEvents(14);
    if (pruned > 0) {
      console.log(`  Pruned ${pruned} events older than 14 days`);
    }
    lastPruneDate = today;
  } catch (err) {
    console.error("Error pruning events:", err);
  }
}

// ─── Prune in-memory seen entries ───────────────────────────────────────────

function pruneSeenEntries(): void {
  const before = allSeenEntries.length;
  allSeenEntries = filterRecentEntries(allSeenEntries, 31);
  const pruned = before - allSeenEntries.length;
  if (pruned > 0) {
    console.log(`  Pruned ${pruned} in-memory entries older than 31 days`);
  }
}

// ─── Gap backfill ───────────────────────────────────────────────────────────

const GAP_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes — longer than any normal push cycle

async function gapBackfill(allEntries: LogEntry[]): Promise<void> {
  // Check when the exporter last pushed
  const { data: facilityRow } = await getSupabase()
    .from("facility_status")
    .select("updated_at")
    .single();

  const lastUpdated = facilityRow?.updated_at
    ? new Date(facilityRow.updated_at as string)
    : null;
  const gapMs = lastUpdated ? Date.now() - lastUpdated.getTime() : Infinity;

  if (gapMs < GAP_THRESHOLD_MS) {
    console.log(`  No gap detected (last update ${Math.round(gapMs / 1000)}s ago)`);
    return;
  }

  const gapMinutes = Math.round(gapMs / 60_000);
  console.log(`  Gap detected: exporter was offline for ~${gapMinutes} minutes`);
  console.log(`  Last update: ${lastUpdated?.toISOString() ?? "never"}`);

  // Filter entries to only those after the last update
  const gapEntries = lastUpdated
    ? allEntries.filter(
        (e) => e.parsedTimestamp && e.parsedTimestamp > lastUpdated
      )
    : allEntries;
  console.log(
    `  Found ${gapEntries.length} events in the gap (of ${allEntries.length} total)`
  );

  if (gapEntries.length === 0) {
    console.log("  No events to backfill, syncing metrics only...");
  } else {
    await ensureProjects(gapEntries);

    const { inserted, errors } = await insertAndTrackActivity(gapEntries);
    console.log(
      `  Gap backfill: ${inserted} events inserted${errors > 0 ? `, ${errors} errors` : ""}`
    );

    allSeenEntries.push(...gapEntries);
  }

  // Sync daily metrics (idempotent upserts — covers the full gap)
  const statsCache = readStatsCache();
  cachedModelStats = readModelStats();
  if (statsCache) {
    const synced = await syncDailyMetrics(statsCache);
    console.log(`  Gap backfill: synced ${synced} daily metric rows`);
  }

  // Scan JSONL files for per-project tokens (full scan, idempotent)
  const projectTokenMap = scanProjectTokens();
  cachedTokensByProject = computeTokensByProject(projectTokenMap);
  const projectEventAggregates = aggregateProjectEventsLocal(allSeenEntries);
  const projectSynced = await syncProjectDailyMetrics(
    projectTokenMap,
    projectEventAggregates
  );
  console.log(
    `  Gap backfill: synced ${projectSynced} per-project daily metric rows`
  );

  // Populate caches from daily_metrics (authoritative)
  await refreshLifetimeCountersFromDb();
  refreshTodayTokensCache(projectTokenMap, todayDateString());

  // Update facility status with fresh data
  await syncFacilityStatus(statsCache, cachedModelStats);

  pruneSeenEntries();
  console.log("  Gap backfill complete.\n");
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (IS_BACKFILL) {
    await backfill();
  } else {
    // Build initial slug + projId maps
    await refreshMaps();

    // Read all existing entries (sets tailer offset to end of file)
    console.log("Reading log file...");
    const allEntries = tailer.readAll();
    console.log(`  ${allEntries.length} entries in log`);

    // Check for gap and backfill missed events
    await gapBackfill(allEntries);

    // Seed caches from project_telemetry for ongoing updates
    console.log("  Loading cached telemetry from Supabase...");
    const { data: ptRows } = await getSupabase()
      .from("project_telemetry")
      .select("id, tokens_lifetime, tokens_today, models_today, sessions_lifetime, messages_lifetime, tool_calls_lifetime, agent_spawns_lifetime, team_messages_lifetime");
    if (ptRows && ptRows.length > 0) {
      for (const row of ptRows) {
        cachedTokensByProject[row.id] = Number(row.tokens_lifetime) || 0;
        cachedLifetimeCounters[row.id] = {
          sessions: Number(row.sessions_lifetime) || 0,
          messages: Number(row.messages_lifetime) || 0,
          toolCalls: Number(row.tool_calls_lifetime) || 0,
          agentSpawns: Number(row.agent_spawns_lifetime) || 0,
          teamMessages: Number(row.team_messages_lifetime) || 0,
        };
        const models = (row.models_today && typeof row.models_today === "object")
          ? row.models_today as Record<string, number>
          : {};
        cachedTodayTokensByProject[row.id] = {
          total: Number(row.tokens_today) || 0,
          models,
        };
      }
      console.log(`  Loaded ${ptRows.length} project telemetry entries`);
    }

    console.log("  Ready — will only sync new events from this point.\n");
  }

  console.log("Daemon running (250ms watcher + 5s aggregator). Press Ctrl+C to stop.\n");

  const watcher = new ProcessWatcher();

  // ── Auto-close: flip facility to dormant after 2h with no active agents ──
  const AUTO_CLOSE_MS = 2 * 60 * 60 * 1000; // 2 hours
  let lastActiveAgentTime = Date.now();
  let autoCloseFired = false;

  // ── Loop 1: Process Watcher (250ms) ──
  async function watcherLoop(): Promise<never> {
    while (true) {
      try {
        const diff = watcher.tick();
        if (diff) {
          await pushAgentState(diff);
          for (const event of diff.events) {
            const ts = new Date().toLocaleTimeString();
            console.log(`  ${ts} [${event.type}] ${event.project} (pid ${event.pid})`);
          }
        }

        if (watcher.activeAgents > 0) {
          lastActiveAgentTime = Date.now();
          autoCloseFired = false;
        }

        if (!autoCloseFired && Date.now() - lastActiveAgentTime > AUTO_CLOSE_MS) {
          await setFacilitySwitch("dormant");
          autoCloseFired = true;
          console.log(`  ${new Date().toLocaleTimeString()} [auto-close] Facility dormant after 2h idle`);
        }
      } catch (err) {
        console.error("Watcher error:", err);
      }
      await Bun.sleep(250);
    }
  }

  // ── Loop 2: Aggregate Metrics (5s) ──
  let cycleCount = 0;
  async function aggregateLoop(): Promise<never> {
    while (true) {
      try {
        await incrementalSync();

        // Periodic tasks every ~60 cycles (~5 minutes at 5s interval)
        if (cycleCount % 60 === 0 && cycleCount > 0) {
          const statsCache = readStatsCache();
          await refreshMaps();
          await refreshProjectCachesFromDisk();
          const settled = await Promise.allSettled([
            maybeSyncDailyMetrics(statsCache),
            maybeSyncProjectDailyMetrics(),
            maybePruneEvents(),
          ]);
          for (const r of settled) {
            if (r.status === "rejected") console.error("  Periodic task failed:", r.reason);
          }
          pruneSeenEntries();
        }
        cycleCount++;
      } catch (err) {
        console.error("Aggregate sync error:", err);
      }
      await Bun.sleep(5000);
    }
  }

  // Run both loops concurrently
  await Promise.all([watcherLoop(), aggregateLoop()]);
}

// ─── Start ─────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
