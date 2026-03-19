/**
 * Comparator for local vs remote telemetry data.
 * Produces discrepancy lists with severity levels.
 */

import type { RemoteData } from "./remote-reader";

// ─── LocalData type (owned here; local-reader.ts is deleted) ────────────────

export interface LocalData {
  events: { byProjectDate: Record<string, Record<string, number>>; totalCount: number };
  metrics: { dailyActivity: Array<{ date: string; messages: number; sessions: number; toolCalls: number }> };
  tokens: { byProject: Record<string, number> };
  models: { stats: Array<{ model: string; total: number; input: number; cacheWrite: number; cacheRead: number; output: number }> };
  projects: Array<{ dirName: string; slug: string; projId: string | null }>;
  hourDistribution: Record<string, number>;
  daemon: { running: boolean; pid: number | null };
  logStartDate: Date | null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type Severity = "match" | "warning" | "error";

export interface Discrepancy {
  key: string;
  local: number;
  remote: number;
  diff: number;
  pctDiff: number;
  severity: Severity;
}

export interface ComparisonResult {
  local: Record<string, number>;
  remote: Record<string, number>;
  discrepancies: Discrepancy[];
  summary: { matches: number; warnings: number; errors: number };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function severity(local: number, remote: number): Severity {
  if (local === remote) return "match";
  const max = Math.max(local, remote);
  if (max === 0) return "match";
  const pct = Math.abs(local - remote) / max;
  return pct < 0.02 ? "warning" : "error";
}

function compareMaps(
  local: Record<string, number>,
  remote: Record<string, number>
): ComparisonResult {
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const discrepancies: Discrepancy[] = [];
  let matches = 0;
  let warnings = 0;
  let errors = 0;

  for (const key of allKeys) {
    const l = local[key] ?? 0;
    const r = remote[key] ?? 0;
    const diff = l - r;
    const max = Math.max(l, r);
    const pctDiff = max === 0 ? 0 : Math.abs(diff) / max;
    const sev = severity(l, r);

    if (sev === "match") matches++;
    else if (sev === "warning") warnings++;
    else errors++;

    if (sev !== "match") {
      discrepancies.push({ key, local: l, remote: r, diff, pctDiff, severity: sev });
    }
  }

  // Sort discrepancies by severity (errors first), then by absolute diff
  discrepancies.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return Math.abs(b.diff) - Math.abs(a.diff);
  });

  return { local, remote, discrepancies, summary: { matches, warnings, errors } };
}

// ─── Comparison functions ───────────────────────────────────────────────────

export function compareEvents(local: LocalData, remote: RemoteData): ComparisonResult {
  // Flatten to projId → total count
  const localCounts: Record<string, number> = {};
  for (const [proj, dates] of Object.entries(local.events.byProjectDate)) {
    for (const count of Object.values(dates)) {
      localCounts[proj] = (localCounts[proj] ?? 0) + count;
    }
  }

  const remoteCounts: Record<string, number> = {};
  for (const [proj, dates] of Object.entries(remote.events.byProjectDate)) {
    for (const count of Object.values(dates)) {
      remoteCounts[proj] = (remoteCounts[proj] ?? 0) + count;
    }
  }

  return compareMaps(localCounts, remoteCounts);
}

export function compareMetrics(local: LocalData, remote: RemoteData): ComparisonResult {
  // Compare messages per day
  const localByDate: Record<string, number> = {};
  for (const day of local.metrics.dailyActivity) {
    localByDate[day.date] = day.messages;
  }

  const remoteByDate: Record<string, number> = {};
  for (const day of remote.metrics.dailyActivity) {
    remoteByDate[day.date] = day.messages;
  }

  return compareMaps(localByDate, remoteByDate);
}

export function compareTokens(local: LocalData, remote: RemoteData): ComparisonResult {
  return compareMaps(local.tokens.byProject, remote.tokens.byProject);
}

export function compareModels(local: LocalData, remote: RemoteData): ComparisonResult {
  const localByModel: Record<string, number> = {};
  for (const stat of local.models.stats) {
    localByModel[stat.model] = stat.total;
  }

  const remoteByModel: Record<string, number> = {};
  for (const [model, stat] of Object.entries(remote.models.stats)) {
    remoteByModel[model] = stat.total;
  }

  return compareMaps(localByModel, remoteByModel);
}

export function compareProjects(
  local: LocalData,
  remote: RemoteData
): ComparisonResult {
  // Compare project registries: 1 = present, 0 = absent
  const localByProjId: Record<string, number> = {};
  for (const proj of local.projects) {
    if (proj.projId) localByProjId[proj.projId] = 1;
  }

  const remoteByProjId: Record<string, number> = {};
  for (const proj of remote.projects) {
    remoteByProjId[proj.id] = 1;
  }

  return compareMaps(localByProjId, remoteByProjId);
}

// ─── Health check ───────────────────────────────────────────────────────────

export interface HealthStatus {
  daemon: {
    running: boolean;
    pid: number | null;
  };
  supabase: {
    connected: boolean;
    latencyMs: number;
  };
  lastSync: string | null;
  lastSyncAgo: string | null;
  timestamp: string;
}

export function buildHealth(local: LocalData, remote: RemoteData): HealthStatus {
  let lastSyncAgo: string | null = null;
  if (remote.lastSync) {
    const ms = Date.now() - new Date(remote.lastSync).getTime();
    if (ms < 60_000) lastSyncAgo = `${Math.round(ms / 1000)}s ago`;
    else if (ms < 3_600_000) lastSyncAgo = `${Math.round(ms / 60_000)}m ago`;
    else lastSyncAgo = `${Math.round(ms / 3_600_000)}h ago`;
  }

  return {
    daemon: local.daemon,
    supabase: {
      connected: remote.connected,
      latencyMs: remote.latencyMs,
    },
    lastSync: remote.lastSync,
    lastSyncAgo,
    timestamp: new Date().toISOString(),
  };
}
