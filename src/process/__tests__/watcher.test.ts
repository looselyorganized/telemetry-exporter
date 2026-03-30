import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { FacilityState, ClaudeProcess } from "../scanner";
import * as realScanner from "../scanner";

// Mock getFacilityState before importing watcher, re-exporting real exports
const mockGetFacilityState = mock<() => FacilityState>(() => ({
  status: "dormant",
  activeAgents: 0,
  totalProcesses: 0,
  activeProjects: [],
  processes: [],
}));

mock.module("../scanner", () => ({
  ...realScanner,
  getFacilityState: mockGetFacilityState,
}));

// Import after mocking
const { countTruthy, ProcessWatcher } = await import("../watcher");

function makeProcess(overrides: Partial<ClaudeProcess> = {}): ClaudeProcess {
  return {
    pid: 100,
    cpuPercent: 0,
    memMb: 256,
    uptime: "00:01:00",
    cwd: "/tmp/proj",
    projectName: "proj",
    projId: "proj",
    isActive: false,
    model: "",
    sessionId: null,
    ...overrides,
  };
}

function setProcesses(processes: ClaudeProcess[]) {
  const activeCount = processes.filter((p) => p.isActive).length;
  const projIds = [...new Set(processes.map((p) => p.projId).filter((s) => s !== "unknown"))];
  mockGetFacilityState.mockReturnValue({
    status: activeCount > 0 ? "active" : "dormant",
    activeAgents: activeCount,
    totalProcesses: processes.length,
    activeProjects: projIds.map((id) => ({
      name: id,
      active: processes.some((p) => p.projId === id && p.isActive),
    })),
    processes,
  });
}

// ---------------------------------------------------------------------------
// countTruthy
// ---------------------------------------------------------------------------
describe("countTruthy", () => {
  test("counts true values", () => {
    expect(countTruthy([true, false, true, true])).toBe(3);
  });

  test("returns 0 for empty array", () => {
    expect(countTruthy([])).toBe(0);
  });

  test("returns 0 for all false", () => {
    expect(countTruthy([false, false, false])).toBe(0);
  });

  test("returns length for all true", () => {
    expect(countTruthy([true, true, true])).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ProcessWatcher
// ---------------------------------------------------------------------------
describe("ProcessWatcher", () => {
  let watcher: InstanceType<typeof ProcessWatcher>;

  beforeEach(() => {
    watcher = new ProcessWatcher();
    mockGetFacilityState.mockClear();
    setProcesses([]);
  });

  test("tick returns null when no processes and no previous state", () => {
    setProcesses([]);
    expect(watcher.tick()).toBeNull();
  });

  test("emits instance:created when a new process appears", () => {
    setProcesses([makeProcess({ pid: 1, projId: "alpha" })]);
    const diff = watcher.tick();
    expect(diff).not.toBeNull();
    expect(diff!.events).toContainEqual({
      type: "instance:created",
      project: "alpha",
      pid: 1,
    });
  });

  test("emits instance:closed when a process disappears", () => {
    setProcesses([makeProcess({ pid: 1, projId: "alpha" })]);
    watcher.tick();

    setProcesses([]);
    const diff = watcher.tick();
    expect(diff).not.toBeNull();
    expect(diff!.events).toContainEqual({
      type: "instance:closed",
      project: "alpha",
      pid: 1,
    });
  });

  test("activeAgents drops to 0 after sustained inactivity", () => {
    // First, make it active
    setProcesses([makeProcess({ pid: 1, projId: "alpha", isActive: true })]);
    watcher.tick();

    // Now send enough inactive ticks to drop below threshold
    // After 1 active + N inactive ticks: ratio = 1/(1+N) < 0.15 when N >= 6
    setProcesses([makeProcess({ pid: 1, projId: "alpha", isActive: false })]);
    for (let i = 0; i < 6; i++) {
      watcher.tick();
    }

    // At tick 7 total (1 active + 6 inactive): 1/7 = 0.143 < 0.15 => should go idle
    const diff = watcher.tick();
    // It might have gone idle on the previous tick; check the last few
    // Let's just verify the watcher's activeAgents is 0
    expect(watcher.activeAgents).toBe(0);
  });

  test("tracks multiple processes independently", () => {
    setProcesses([
      makeProcess({ pid: 1, projId: "alpha", isActive: true }),
      makeProcess({ pid: 2, projId: "beta", isActive: false }),
    ]);
    const diff = watcher.tick();
    expect(diff).not.toBeNull();
    // Hysteresis delays active — only 2 created events on first tick
    expect(diff!.events).toHaveLength(2);

    const types = diff!.events.map((e) => `${e.type}:${e.pid}`);
    expect(types).toContain("instance:created:1");
    expect(types).toContain("instance:created:2");
  });

  test("activeAgents reflects windowed state", () => {
    setProcesses([
      makeProcess({ pid: 1, isActive: true }),
      makeProcess({ pid: 2, isActive: false }),
    ]);
    watcher.tick();
    expect(watcher.activeAgents).toBe(1);
  });

  test("no events emitted when state is unchanged", () => {
    setProcesses([makeProcess({ pid: 1, isActive: false })]);
    watcher.tick(); // created event

    // Same state again — no transitions
    const diff = watcher.tick();
    expect(diff).toBeNull();
  });

  test("byProject aggregates per-project counts", () => {
    setProcesses([
      makeProcess({ pid: 1, projId: "alpha", isActive: true }),
      makeProcess({ pid: 2, projId: "alpha", isActive: false }),
    ]);
    const diff = watcher.tick();
    expect(diff).not.toBeNull();
    const alphaState = diff!.byProject.get("alpha");
    expect(alphaState).toBeDefined();
    expect(alphaState!.count).toBe(2);
    expect(alphaState!.active).toBe(1);
  });

  test("facility status reflects overall activity", () => {
    setProcesses([makeProcess({ pid: 1, isActive: true })]);
    const diff = watcher.tick();
    expect(diff).not.toBeNull();
    expect(diff!.facility.status).toBe("active");
    expect(diff!.facility.activeAgents).toBe(1);
  });

  test("facility status is dormant when no processes are active", () => {
    setProcesses([makeProcess({ pid: 1, isActive: false })]);
    const diff = watcher.tick();
    expect(diff).not.toBeNull();
    expect(diff!.facility.status).toBe("dormant");
  });

  // -------------------------------------------------------------------------
  // Hysteresis
  // -------------------------------------------------------------------------
  describe("hysteresis", () => {
    test("active event requires 3 consecutive confirmations", () => {
      setProcesses([makeProcess({ pid: 1, projId: "alpha", isActive: true })]);

      // Tick 1: created, hysteresis count=1
      const diff1 = watcher.tick();
      expect(diff1!.events.map((e) => e.type)).toEqual(["instance:created"]);

      // Tick 2: count=2, no events
      expect(watcher.tick()).toBeNull();

      // Tick 3: count=3, active fires
      const diff3 = watcher.tick();
      expect(diff3).not.toBeNull();
      expect(diff3!.events).toEqual([
        { type: "instance:active", project: "alpha", pid: 1 },
      ]);
    });

    test("close cleans up hysteresis state for reopened PIDs", () => {
      // Build up 2 hysteresis ticks (not yet confirmed)
      setProcesses([makeProcess({ pid: 1, projId: "alpha", isActive: true })]);
      watcher.tick(); // created, count=1
      watcher.tick(); // count=2 (null)

      // Close before hysteresis confirms
      setProcesses([]);
      const closeDiff = watcher.tick();
      expect(closeDiff!.events).toEqual([
        { type: "instance:closed", project: "alpha", pid: 1 },
      ]);

      // Reopen same PID — should start fresh
      setProcesses([makeProcess({ pid: 1, projId: "alpha", isActive: true })]);
      const reopenDiff = watcher.tick();
      expect(reopenDiff!.events.map((e) => e.type)).toEqual([
        "instance:created",
      ]);

      // Still needs 2 more ticks for active (not continuing from old count)
      expect(watcher.tick()).toBeNull();
      const activeDiff = watcher.tick();
      expect(activeDiff!.events).toEqual([
        { type: "instance:active", project: "alpha", pid: 1 },
      ]);
    });

    test("idle event requires 3 confirmations after window crosses threshold", () => {
      // Get process confirmed active
      setProcesses([makeProcess({ pid: 1, projId: "alpha", isActive: true })]);
      watcher.tick(); // created, count=1
      watcher.tick(); // count=2
      watcher.tick(); // count=3 → active, reportedActive=true

      // Go idle — need window to drop below 15% first
      // After 3 active + N inactive: 3/(3+N) < 0.15 → N > 17 → 18 ticks
      setProcesses([makeProcess({ pid: 1, projId: "alpha", isActive: false })]);

      // Tick 17 inactive: 3/20 = 0.15, still at threshold (active)
      for (let i = 0; i < 17; i++) watcher.tick();

      // Tick 18: 3/21 = 0.143, window crosses → hysteresis count=1
      // Tick 19: count=2
      // Tick 20: count=3 → idle event
      watcher.tick(); // count=1
      watcher.tick(); // count=2
      const idleDiff = watcher.tick(); // count=3 → idle
      expect(idleDiff).not.toBeNull();
      expect(idleDiff!.events).toContainEqual({
        type: "instance:idle",
        project: "alpha",
        pid: 1,
      });
    });
  });
});
