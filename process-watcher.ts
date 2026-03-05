/**
 * Watches for Claude process lifecycle events by diffing process snapshots.
 * Ticks every 250ms, emits events only when state changes.
 *
 * Uses a sliding window to determine "active" vs "idle". A process must show
 * CPU activity in at least ACTIVE_THRESHOLD of the last WINDOW_SIZE ticks
 * to be considered active. This filters out GC spikes and event loop noise.
 * Going idle requires sustained inactivity; going active is near-instant
 * (a short burst of real work fills the threshold quickly).
 */

import { getFacilityState } from "./process-scanner";

/** How many recent ticks to consider (at 250ms each, 40 = 10 seconds). */
const WINDOW_SIZE = 40;
/** Fraction of window that must show activity to count as "active". */
const ACTIVE_THRESHOLD = 0.15; // 15% — about 6 ticks in 10s (1.5s of CPU in 10s)

export type ProcessEventType =
  | "instance:created"
  | "instance:closed"
  | "instance:active"
  | "instance:idle";

export interface ProcessEvent {
  type: ProcessEventType;
  project: string;
  pid: number;
}

export interface ProjectAgentState {
  active: number;
  count: number;
}

export interface ProcessDiff {
  events: ProcessEvent[];
  byProject: Map<string, ProjectAgentState>;
  facility: {
    status: "active" | "dormant";
    activeAgents: number;
    activeProjects: Array<{ name: string; active: boolean }>;
  };
}

interface SnapshotEntry {
  projId: string;
  isActive: boolean;
}

/** Count truthy values without allocating a filtered copy. */
function countTruthy(values: boolean[]): number {
  let n = 0;
  for (const v of values) {
    if (v) n++;
  }
  return n;
}

export class ProcessWatcher {
  private previous: Map<number, SnapshotEntry> = new Map();
  /** Sliding window of raw CPU activity per PID (true = had CPU this tick). */
  private activityWindow: Map<number, boolean[]> = new Map();
  /** Last reported state per PID (true = reported as active). */
  private reportedActive: Map<number, boolean> = new Map();

  /** Number of active agents based on windowed state (cheap in-memory check). */
  get activeAgents(): number {
    let count = 0;
    for (const pid of this.previous.keys()) {
      if (this.isWindowActive(pid)) count++;
    }
    return count;
  }

  /** Check if a PID is "active" based on its sliding window. */
  private isWindowActive(pid: number): boolean {
    const window = this.activityWindow.get(pid);
    if (!window || window.length === 0) return false;
    return countTruthy(window) / window.length >= ACTIVE_THRESHOLD;
  }

  /** Push a tick into a PID's sliding window. */
  private pushWindow(pid: number, active: boolean): void {
    const existing = this.activityWindow.get(pid);
    if (existing) {
      existing.push(active);
      if (existing.length > WINDOW_SIZE) existing.shift();
    } else {
      this.activityWindow.set(pid, [active]);
    }
  }

  /**
   * Poll process state and diff against previous snapshot.
   * Returns null if nothing changed.
   */
  tick(): ProcessDiff | null {
    const state = getFacilityState();

    const current = new Map<number, SnapshotEntry>();
    for (const proc of state.processes) {
      current.set(proc.pid, { projId: proc.projId, isActive: proc.isActive });
    }

    const events: ProcessEvent[] = [];

    // Update sliding windows and detect transitions
    for (const [pid, entry] of current) {
      this.pushWindow(pid, entry.isActive);
      const windowActive = this.isWindowActive(pid);
      const wasReportedActive = this.reportedActive.get(pid) ?? false;

      if (!this.previous.has(pid)) {
        events.push({ type: "instance:created", project: entry.projId, pid });
        if (windowActive) {
          events.push({ type: "instance:active", project: entry.projId, pid });
        }
        this.reportedActive.set(pid, windowActive);
      } else if (windowActive && !wasReportedActive) {
        events.push({ type: "instance:active", project: entry.projId, pid });
        this.reportedActive.set(pid, true);
      } else if (!windowActive && wasReportedActive) {
        events.push({ type: "instance:idle", project: entry.projId, pid });
        this.reportedActive.set(pid, false);
      }
    }

    // Detect closed PIDs
    for (const [pid, prev] of this.previous) {
      if (!current.has(pid)) {
        events.push({ type: "instance:closed", project: prev.projId, pid });
        this.activityWindow.delete(pid);
        this.reportedActive.delete(pid);
      }
    }

    this.previous = current;

    if (events.length === 0) return null;

    // Compute per-project totals for affected projects using windowed active state
    const affectedProjIds = new Set(
      events.map((e) => e.project).filter((s) => s !== "unknown")
    );

    const byProject = new Map<string, ProjectAgentState>();
    for (const projId of affectedProjIds) {
      let count = 0;
      let active = 0;
      for (const proc of state.processes) {
        if (proc.projId !== projId) continue;
        count++;
        if (this.isWindowActive(proc.pid)) active++;
      }
      byProject.set(projId, { active, count });
    }

    // Facility-level counts also use windowed state
    const activeProcessPids = state.processes.filter((p) =>
      this.isWindowActive(p.pid)
    );
    const activePidProjIds = new Set(activeProcessPids.map((p) => p.projId));

    const uniqueProjIds = new Set(
      state.processes.map((p) => p.projId).filter((s) => s !== "unknown")
    );
    const activeProjects = [...uniqueProjIds].map((projId) => ({
      name: projId,
      active: activePidProjIds.has(projId),
    }));

    return {
      events,
      byProject,
      facility: {
        status: activeProcessPids.length > 0 ? "active" : "dormant",
        activeAgents: activeProcessPids.length,
        activeProjects,
      },
    };
  }
}
