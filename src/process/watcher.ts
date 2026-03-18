/**
 * Watches for Claude process lifecycle events by diffing process snapshots.
 * Ticks every 250ms, emits events only when state changes.
 *
 * Uses a sliding window to determine "active" vs "idle". A process must show
 * CPU activity in at least ACTIVE_THRESHOLD of the last WINDOW_SIZE ticks
 * to be considered active. This filters out GC spikes and event loop noise.
 * Both directions include hysteresis: a state change must persist for
 * HYSTERESIS_TICKS consecutive ticks before being reported. Going idle
 * is slower (window must decay below threshold first, then 3 ticks) while
 * going active only needs the window to cross threshold plus 3 ticks.
 */

import { getFacilityState } from "./scanner";

/** How many recent ticks to consider (at 250ms each, 40 = 10 seconds). */
const WINDOW_SIZE = 40;
/** Fraction of window that must show activity to count as "active". */
const ACTIVE_THRESHOLD = 0.15; // 15% — about 6 ticks in 10s (1.5s of CPU in 10s)
/** Consecutive ticks a state change must persist before reporting. */
export const HYSTERESIS_TICKS = 3;

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
    activeProjects: Array<{ name: string; active: boolean; count: number }>;
  };
}

interface SnapshotEntry {
  projId: string;
  isActive: boolean;
}

/** Count truthy values without allocating a filtered copy. */
export function countTruthy(values: boolean[]): number {
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
  /** Consecutive ticks of pending state change per PID (hysteresis). */
  private confirmationCount: Map<number, number> = new Map();

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

    // Update sliding windows and detect transitions (with hysteresis)
    for (const [pid, entry] of current) {
      this.pushWindow(pid, entry.isActive);
      const windowActive = this.isWindowActive(pid);

      if (!this.previous.has(pid)) {
        // New process — emit created, apply hysteresis for initial active
        events.push({ type: "instance:created", project: entry.projId, pid });
        this.reportedActive.set(pid, false);
        if (windowActive) {
          this.confirmationCount.set(pid, 1);
        }
      } else {
        const wasReportedActive = this.reportedActive.get(pid) ?? false;
        if (windowActive !== wasReportedActive) {
          const count = (this.confirmationCount.get(pid) ?? 0) + 1;
          if (count >= HYSTERESIS_TICKS) {
            events.push({
              type: windowActive ? "instance:active" : "instance:idle",
              project: entry.projId,
              pid,
            });
            this.reportedActive.set(pid, windowActive);
            this.confirmationCount.delete(pid);
          } else {
            this.confirmationCount.set(pid, count);
          }
        } else {
          this.confirmationCount.delete(pid);
        }
      }
    }

    // Detect closed PIDs
    for (const [pid, prev] of this.previous) {
      if (!current.has(pid)) {
        events.push({ type: "instance:closed", project: prev.projId, pid });
        this.activityWindow.delete(pid);
        this.reportedActive.delete(pid);
        this.confirmationCount.delete(pid);
      }
    }

    this.previous = current;

    if (events.length === 0) return null;

    // Precompute window-active status once per PID (avoids repeated sliding window scans)
    const windowActive = new Map<number, boolean>();
    for (const proc of state.processes) {
      windowActive.set(proc.pid, this.isWindowActive(proc.pid));
    }

    const uniqueProjIds = new Set(
      state.processes.map((p) => p.projId).filter((s) => s !== "unknown")
    );

    // Compute per-project totals for ALL projects with processes
    const byProject = new Map<string, ProjectAgentState>();
    for (const projId of uniqueProjIds) {
      let count = 0;
      let active = 0;
      for (const proc of state.processes) {
        if (proc.projId !== projId) continue;
        count++;
        if (windowActive.get(proc.pid)) active++;
      }
      byProject.set(projId, { active, count });
    }

    const activeAgentCount = [...windowActive.values()].filter(Boolean).length;

    const activeProjects = [...uniqueProjIds].map((projId) => {
      const proj = byProject.get(projId)!;
      return { name: projId, active: proj.active > 0, count: proj.count };
    });

    return {
      events,
      byProject,
      facility: {
        status: activeAgentCount > 0 ? "active" : "dormant",
        activeAgents: activeAgentCount,
        activeProjects,
      },
    };
  }
}
