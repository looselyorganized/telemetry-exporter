/**
 * Detects running Claude Code processes on the local machine.
 * Mirrors the ProcessScanner from dashboard.py.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { homedir } from "os";

import { resolveProjId, PROJECT_ROOT } from "../project/slug-resolver";
import { readLoYml } from "../project/resolver";

export interface ClaudeProcess {
  pid: number;
  cpuPercent: number;
  memMb: number;
  uptime: string;
  cwd: string;
  projectName: string;
  projId: string;
  isActive: boolean;
  model: string;
  sessionId: string | null;
}

const projectNameCache = new Map<string, string>();

/**
 * Derive project name from working directory by finding nearest git root.
 * Falls back to "projects/" heuristic, then basename.
 */
export function deriveProjectName(cwd: string): string {
  if (!cwd || cwd === "/") return "unknown";
  if (projectNameCache.has(cwd)) return projectNameCache.get(cwd)!;

  const home = homedir();
  let name: string | undefined;

  // Walk up to find nearest git root
  let current = cwd;
  while (current !== home && current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      name = basename(current);
      break;
    }
    current = dirname(current);
  }

  // Fallback: look for a "projects/" segment
  if (!name) {
    const parts = cwd.split("/");
    const idx = parts.indexOf("projects");
    if (idx !== -1 && idx + 1 < parts.length) {
      name = parts[idx + 1];
    }
  }

  const result = name || basename(cwd) || "unknown";
  projectNameCache.set(cwd, result);
  return result;
}

/** Org-root directory names that map to proj_org-root. */
const ORG_ROOT_NAMES = new Set(["looselyorganized", "lo"]);
const ORG_ROOT_ID = "proj_org-root";

/**
 * Derive proj_UUID from a working directory.
 * Reads lo.yml for the canonical project ID (proj_*).
 * Falls back to org-root hardcode, then slug-resolver.
 */
export function deriveProjId(cwd: string): string {
  const dirName = deriveProjectName(cwd);
  if (dirName === "unknown") return "unknown";
  // Org-root hardcode (no lo.yml at monorepo root)
  if (ORG_ROOT_NAMES.has(dirName)) return ORG_ROOT_ID;
  const projDir = join(PROJECT_ROOT, dirName);
  // Try lo.yml first (canonical project ID)
  const loYmlId = readLoYml(projDir);
  if (loYmlId) return loYmlId;
  return resolveProjId(projDir) ?? "unknown";
}

/** Run a shell command, returning stdout or null on failure. */
function execQuiet(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 });
  } catch {
    return null;
  }
}

/** Clear the project name cache (useful for testing). */
export function clearProjectNameCache(): void {
  projectNameCache.clear();
}

/** PID→session cache (immutable for PID lifetime — only caches successful resolutions). */
const pidSessionCache = new Map<number, string>();

/** Track first-seen time for unresolved PIDs (gives up after MAX_RESOLVE_AGE_MS). */
const unresolvedFirstSeen = new Map<number, number>();

/** Stop retrying session resolution after 5 minutes. */
const MAX_RESOLVE_AGE_MS = 5 * 60 * 1000;

/** Path to Claude Code's session files directory. */
const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/**
 * Try to resolve session_id from ~/.claude/sessions/<pid>.json.
 * Claude Code writes these at process start (2.1.89+, observed in 2.1.88 too).
 */
function resolveSessionFromFile(pid: number): string | null {
  try {
    const raw = readFileSync(join(SESSIONS_DIR, `${pid}.json`), "utf-8");
    const data = JSON.parse(raw);
    if (typeof data.sessionId === "string" && data.sessionId) return data.sessionId;
  } catch {
    // File doesn't exist yet or parse error — caller will retry
  }
  return null;
}

/**
 * Fallback: resolve session_id via lsof open directory handle.
 * Works when the process holds ~/.claude/tasks/<session_id>/ open (pre-2.1.89 behavior).
 */
function resolveSessionFromLsof(pid: number): string | null {
  const output = execQuiet(`lsof -p ${pid} 2>/dev/null`);
  if (!output) return null;

  for (const line of output.split("\n")) {
    const match = line.match(
      /\.claude\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    if (match) return match[1];
  }
  return null;
}

/**
 * Resolve a Claude PID to its session_id.
 * Primary: ~/.claude/sessions/<pid>.json (fast file read).
 * Fallback: lsof for older CC versions.
 * Retries on miss until MAX_RESOLVE_AGE_MS, then gives up.
 */
export function resolveSessionId(pid: number): string | null {
  const cached = pidSessionCache.get(pid);
  if (cached) return cached;

  // Check if we've given up on this PID
  const firstSeen = unresolvedFirstSeen.get(pid);
  if (firstSeen && Date.now() - firstSeen > MAX_RESOLVE_AGE_MS) return null;

  // Try session file first (fast), then lsof fallback
  const sessionId = resolveSessionFromFile(pid) ?? resolveSessionFromLsof(pid);

  if (sessionId) {
    pidSessionCache.set(pid, sessionId);
    unresolvedFirstSeen.delete(pid);
    return sessionId;
  }

  // Track when we first failed — will retry until MAX_RESOLVE_AGE_MS
  if (!firstSeen) unresolvedFirstSeen.set(pid, Date.now());
  return null;
}

/** Clear PID→session cache for closed PIDs. */
export function clearPidSession(pid: number): void {
  pidSessionCache.delete(pid);
  unresolvedFirstSeen.delete(pid);
}

/** Parse Claude processes from ps output. */
export function parseClaudeProcesses(psOutput: string): Array<{
  pid: number;
  cpu: number;
  memMb: number;
  uptime: string;
}> {
  const results: Array<{ pid: number; cpu: number; memMb: number; uptime: string }> = [];

  for (const line of psOutput.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    if (parts[parts.length - 1] !== "claude") continue;

    results.push({
      pid: parseInt(parts[0]),
      cpu: parseFloat(parts[1]),
      memMb: Math.round(parseInt(parts[2]) / 1024),
      uptime: parts[3],
    });
  }

  return results;
}

/** Parse lsof output (p/n line format) into a pid→cwd map. */
export function parseLsofCwds(output: string): Record<number, string> {
  const cwdMap: Record<number, string> = {};
  let currentPid = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = parseInt(line.substring(1));
    } else if (line.startsWith("n") && currentPid) {
      cwdMap[currentPid] = line.substring(1);
    }
  }
  return cwdMap;
}

/** Resolve working directories for a set of PIDs via lsof. */
function resolveCwds(pids: number[]): Record<number, string> {
  const output = execQuiet(`lsof -d cwd -a -p ${pids.join(",")} -Fn`);
  if (!output) return {};
  return parseLsofCwds(output);
}

/** Parse ps output to find parent PIDs of caffeinate processes. */
export function parseCaffeinateParents(output: string): Set<number> {
  const pids = new Set<number>();
  for (const line of output.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && parts[2] === "caffeinate") {
      pids.add(parseInt(parts[1]));
    }
  }
  return pids;
}

/** Find parent PIDs that have a caffeinate child (indicates active work). */
function findCaffeinatePids(): Set<number> {
  const output = execQuiet("ps -eo pid,ppid,comm");
  if (!output) return new Set();
  return parseCaffeinateParents(output);
}

/**
 * Scan for running Claude Code processes.
 */
export function scanProcesses(): ClaudeProcess[] {
  const psOutput = execQuiet("ps -eo pid,pcpu,rss,etime,comm");
  if (!psOutput) return [];

  const claudeProcs = parseClaudeProcesses(psOutput);
  if (claudeProcs.length === 0) return [];

  const cwdMap = resolveCwds(claudeProcs.map((p) => p.pid));
  const cafPids = findCaffeinatePids();

  return claudeProcs.map((p) => {
    const cwd = cwdMap[p.pid] ?? "";
    return {
      pid: p.pid,
      cpuPercent: p.cpu,
      memMb: p.memMb,
      uptime: p.uptime,
      cwd,
      projectName: deriveProjectName(cwd),
      projId: deriveProjId(cwd),
      isActive: p.cpu > 1 || cafPids.has(p.pid),
      model: "",
      sessionId: resolveSessionId(p.pid),
    };
  });
}

export interface FacilityState {
  status: "active" | "dormant";
  activeAgents: number;
  totalProcesses: number;
  activeProjects: Array<{ name: string; active: boolean }>;
  processes: ClaudeProcess[];
}

/**
 * Get a summary of active facility state from running processes.
 */
export function getFacilityState(): FacilityState {
  const processes = scanProcesses();
  const activeProcesses = processes.filter((p) => p.isActive);
  const projIds = [...new Set(processes.map((p) => p.projId).filter((s) => s !== "unknown"))];

  return {
    status: activeProcesses.length > 0 ? "active" : "dormant",
    activeAgents: activeProcesses.length,
    totalProcesses: processes.length,
    activeProjects: projIds.map((projId) => ({
      name: projId,
      active: processes.some((p) => p.projId === projId && p.isActive),
    })),
    processes,
  };
}
