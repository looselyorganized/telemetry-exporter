/**
 * Local data reader for the verification dashboard.
 * Reads all local telemetry sources using existing parsers.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

import {
  LogTailer,
  readModelStats,
  readStatsCache,
  type LogEntry,
  type ModelStats,
  type StatsCache,
} from "../parsers";
import {
  scanProjectTokens,
  computeTokensByProject,
  type ProjectTokenMap,
} from "../project/scanner";
import {
  buildSlugMap,
  clearSlugCache,
  resolveProjId,
  clearProjIdCache,
  PROJECT_ROOT,
} from "../project/slug-resolver";
import { PID_FILE, isProcessRunning } from "../cli-output";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LocalEvents {
  /** projId → date → count */
  byProjectDate: Record<string, Record<string, number>>;
  totalCount: number;
}

export interface LocalMetrics {
  dailyActivity: Array<{
    date: string;
    messages: number;
    sessions: number;
    toolCalls: number;
  }>;
}

export interface LocalTokens {
  /** projId → lifetime total */
  byProject: Record<string, number>;
}

export interface LocalModels {
  stats: ModelStats[];
}

export interface LocalProject {
  dirName: string;
  slug: string;
  projId: string | null;
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
}

export interface LocalData {
  events: LocalEvents;
  metrics: LocalMetrics;
  tokens: LocalTokens;
  models: LocalModels;
  projects: LocalProject[];
  hourDistribution: Record<string, number>;
  daemon: DaemonStatus;
}

// ─── Readers ────────────────────────────────────────────────────────────────

function readLocalEvents(projIdMap: Map<string, string>): LocalEvents {
  const tailer = new LogTailer();
  const entries = tailer.readAll();
  const byProjectDate: Record<string, Record<string, number>> = {};
  let totalCount = 0;

  // Only count events from the last 30 days to match remote query
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  for (const entry of entries) {
    if (!entry.project || !entry.parsedTimestamp) continue;
    if (entry.parsedTimestamp < cutoff) continue;

    // Resolve directory name → projId so keys match remote side
    const projId = projIdMap.get(entry.project);
    if (!projId) continue;

    const date = entry.parsedTimestamp.toISOString().split("T")[0];
    if (!byProjectDate[projId]) byProjectDate[projId] = {};
    byProjectDate[projId][date] = (byProjectDate[projId][date] ?? 0) + 1;
    totalCount++;
  }

  return { byProjectDate, totalCount };
}

function readLocalMetrics(): LocalMetrics {
  const statsCache = readStatsCache();
  if (!statsCache?.dailyActivity) return { dailyActivity: [] };

  return {
    dailyActivity: statsCache.dailyActivity.map((d) => ({
      date: d.date,
      messages: d.messageCount,
      sessions: d.sessionCount,
      toolCalls: d.toolCallCount,
    })),
  };
}

function readLocalTokens(): LocalTokens {
  const tokenMap = scanProjectTokens();
  return { byProject: computeTokensByProject(tokenMap) };
}

function readLocalModels(): LocalModels {
  return { stats: readModelStats() };
}

function readDaemonStatus(): DaemonStatus {
  if (!existsSync(PID_FILE)) return { running: false, pid: null };

  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return { running: false, pid: null };
    return { running: isProcessRunning(pid), pid };
  } catch {
    return { running: false, pid: null };
  }
}

function readHourDistribution(): Record<string, number> {
  const statsCache = readStatsCache();
  return statsCache?.hourCounts ?? {};
}

// ─── Main export ────────────────────────────────────────────────────────────

export function readAllLocal(): LocalData {
  // Build projId map once, reused by events and projects
  clearSlugCache();
  clearProjIdCache();
  const slugMap = buildSlugMap();
  const projIdMap = new Map<string, string>();
  for (const [dirName] of slugMap) {
    const projId = resolveProjId(join(PROJECT_ROOT, dirName));
    if (projId) projIdMap.set(dirName, projId);
  }

  const projects: LocalProject[] = [];
  for (const [dirName, slug] of slugMap) {
    projects.push({ dirName, slug, projId: projIdMap.get(dirName) ?? null });
  }

  return {
    events: readLocalEvents(projIdMap),
    metrics: readLocalMetrics(),
    tokens: readLocalTokens(),
    models: readLocalModels(),
    projects,
    hourDistribution: readHourDistribution(),
    daemon: readDaemonStatus(),
  };
}
