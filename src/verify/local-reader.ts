/**
 * Local data reader for the verification dashboard.
 * Reads all local telemetry sources using existing parsers.
 */

import { readFileSync, existsSync } from "fs";

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
import type { ProjectResolver } from "../project/resolver";
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
  /** Earliest timestamp in events.log — used to bound remote queries */
  logStartDate: Date | null;
}

// ─── Readers ────────────────────────────────────────────────────────────────

interface LocalEventsResult {
  events: LocalEvents;
  logStartDate: Date | null;
}

function readLocalEvents(projIdMap: Map<string, string>): LocalEventsResult {
  const tailer = new LogTailer();
  const entries = tailer.readAll();
  const byProjectDate: Record<string, Record<string, number>> = {};
  let totalCount = 0;

  // Find the earliest timestamp in the log to bound remote queries
  let logStartDate: Date | null = null;
  for (const entry of entries) {
    if (!entry.parsedTimestamp) continue;
    if (!logStartDate || entry.parsedTimestamp < logStartDate) {
      logStartDate = entry.parsedTimestamp;
    }
  }

  // Use the later of: 14-day retention window or log start date,
  // so we only compare the range both sides actually have data for
  const retentionCutoff = new Date();
  retentionCutoff.setDate(retentionCutoff.getDate() - 14);
  const effectiveCutoff =
    logStartDate && logStartDate > retentionCutoff
      ? logStartDate
      : retentionCutoff;

  // Deduplicate using the same conflict key as Supabase upsert:
  // (project_id, event_type, event_text, timestamp)
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.project || !entry.parsedTimestamp) continue;
    if (entry.parsedTimestamp < effectiveCutoff) continue;

    const projId = projIdMap.get(entry.project);
    if (!projId) continue;

    const dedupKey = `${projId}\0${entry.eventType}\0${entry.eventText}\0${entry.parsedTimestamp.toISOString()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const date = entry.parsedTimestamp.toISOString().split("T")[0];
    if (!byProjectDate[projId]) byProjectDate[projId] = {};
    byProjectDate[projId][date] = (byProjectDate[projId][date] ?? 0) + 1;
    totalCount++;
  }

  return { events: { byProjectDate, totalCount }, logStartDate: effectiveCutoff };
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

function readLocalTokens(resolver?: ProjectResolver): LocalTokens {
  const tokenMap = scanProjectTokens(resolver);
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

/**
 * Read all local telemetry data.
 *
 * Uses ProjectResolver.entries() which already includes disk, Supabase
 * local_names, org-root, and legacy mappings — no supplemental merging needed.
 */
export function readAllLocal(resolver: ProjectResolver): LocalData {
  // Build projIdMap and projects list from resolver.entries()
  const projIdMap = new Map<string, string>();
  const projects: LocalProject[] = [];
  const seenProjIds = new Set<string>();

  for (const [dirName, resolved] of resolver.entries()) {
    projIdMap.set(dirName, resolved.projId);

    // Only add one entry per projId to the projects list
    // (a project may appear under multiple dirNames)
    if (!seenProjIds.has(resolved.projId)) {
      projects.push({ dirName, slug: resolved.slug, projId: resolved.projId });
      seenProjIds.add(resolved.projId);
    }
  }

  const { events, logStartDate } = readLocalEvents(projIdMap);

  return {
    events,
    metrics: readLocalMetrics(),
    tokens: readLocalTokens(resolver),
    models: readLocalModels(),
    projects,
    hourDistribution: readHourDistribution(),
    daemon: readDaemonStatus(),
    logStartDate,
  };
}
