/**
 * Detects running Claude Code processes on the local machine.
 * Mirrors the ProcessScanner from dashboard.py.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { basename, dirname, join } from "path";
import { homedir } from "os";

import { resolveProjId } from "./slug-resolver";

const PROJECT_ROOT = "/Users/bigviking/Documents/github/projects/lo";

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

/**
 * Derive content_slug from a working directory.
 * Maps dir name via deriveProjectName, then resolves the slug from project metadata.
 */
export function deriveProjId(cwd: string): string {
  const dirName = deriveProjectName(cwd);
  if (dirName === "unknown") return "unknown";
  return resolveProjId(join(PROJECT_ROOT, dirName)) ?? "unknown";
}

/** Run a shell command, returning stdout or null on failure. */
function execQuiet(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 });
  } catch {
    return null;
  }
}

/** Parse Claude processes from ps output. */
function parseClaudeProcesses(psOutput: string): Array<{
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

/** Resolve working directories for a set of PIDs via lsof. */
function resolveCwds(pids: number[]): Record<number, string> {
  const output = execQuiet(`lsof -d cwd -a -p ${pids.join(",")} -Fn`);
  if (!output) return {};

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

/** Find parent PIDs that have a caffeinate child (indicates active work). */
function findCaffeinatePids(): Set<number> {
  const output = execQuiet("ps -eo pid,ppid,comm");
  if (!output) return new Set();

  const pids = new Set<number>();
  for (const line of output.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && parts[2] === "caffeinate") {
      pids.add(parseInt(parts[1]));
    }
  }
  return pids;
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
