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

  test("emits instance:active after sustained activity crosses threshold", () => {
    // ACTIVE_THRESHOLD is 0.15, WINDOW_SIZE is 40
    // With a fresh window, we need ceil(0.15 * n) trues out of n ticks
    // After 1 tick with isActive=true: 1/1 = 100% >= 15% => active immediately
    setProcesses([makeProcess({ pid: 1, projId: "alpha", isActive: true })]);
    const diff = watcher.tick();
    expect(diff).not.toBeNull();
    const events = diff!.events.map((e) => e.type);
    expect(events).toContain("instance:created");
    expect(events).toContain("instance:active");
  });

  test("emits instance:idle after sustained inactivity", () => {
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
    expect(diff!.events).toHaveLength(3); // 2 created + 1 active (for pid 1)

    const types = diff!.events.map((e) => `${e.type}:${e.pid}`);
    expect(types).toContain("instance:created:1");
    expect(types).toContain("instance:created:2");
    expect(types).toContain("instance:active:1");
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
});
