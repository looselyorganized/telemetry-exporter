import { describe, expect, test } from "bun:test";
import {
  compareEvents,
  compareMetrics,
  compareTokens,
  compareModels,
  compareProjects,
  buildHealth,
  type ComparisonResult,
} from "../comparator";
import type { LocalData } from "../local-reader";
import type { RemoteData } from "../remote-reader";

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeLocalData(overrides: Partial<LocalData> = {}): LocalData {
  return {
    events: { byProjectDate: {}, totalCount: 0 },
    metrics: { dailyActivity: [] },
    tokens: { byProject: {} },
    models: { stats: [] },
    projects: [],
    hourDistribution: {},
    daemon: { running: false, pid: null },
    ...overrides,
  };
}

function makeRemoteData(overrides: Partial<RemoteData> = {}): RemoteData {
  return {
    events: { byProjectDate: {}, totalCount: 0 },
    metrics: { dailyActivity: [] },
    tokens: { byProject: {} },
    models: { stats: {} },
    projects: [],
    hourDistribution: {},
    lastSync: null,
    latencyMs: 50,
    connected: true,
    ...overrides,
  };
}

// ─── compareEvents ──────────────────────────────────────────────────────────

describe("compareEvents", () => {
  test("exact match produces no discrepancies", () => {
    const local = makeLocalData({
      events: {
        byProjectDate: { "proj-a": { "2026-03-10": 42 } },
        totalCount: 42,
      },
    });
    const remote = makeRemoteData({
      events: {
        byProjectDate: { "proj-a": { "2026-03-10": 42 } },
        totalCount: 42,
      },
    });
    const result = compareEvents(local, remote);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.summary.matches).toBe(1);
  });

  test("missing project on remote side produces error", () => {
    const local = makeLocalData({
      events: {
        byProjectDate: { "proj-a": { "2026-03-10": 100 } },
        totalCount: 100,
      },
    });
    const remote = makeRemoteData();
    const result = compareEvents(local, remote);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].severity).toBe("error");
    expect(result.discrepancies[0].key).toBe("proj-a");
  });

  test("small difference (<2%) produces warning", () => {
    const local = makeLocalData({
      events: {
        byProjectDate: { "proj-a": { "2026-03-10": 1000 } },
        totalCount: 1000,
      },
    });
    const remote = makeRemoteData({
      events: {
        byProjectDate: { "proj-a": { "2026-03-10": 990 } },
        totalCount: 990,
      },
    });
    const result = compareEvents(local, remote);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].severity).toBe("warning");
  });

  test("large difference (>=2%) produces error", () => {
    const local = makeLocalData({
      events: {
        byProjectDate: { "proj-a": { "2026-03-10": 100 } },
        totalCount: 100,
      },
    });
    const remote = makeRemoteData({
      events: {
        byProjectDate: { "proj-a": { "2026-03-10": 50 } },
        totalCount: 50,
      },
    });
    const result = compareEvents(local, remote);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].severity).toBe("error");
  });
});

// ─── compareMetrics ─────────────────────────────────────────────────────────

describe("compareMetrics", () => {
  test("matching daily metrics", () => {
    const local = makeLocalData({
      metrics: {
        dailyActivity: [
          { date: "2026-03-09", messages: 50, sessions: 3, toolCalls: 20 },
          { date: "2026-03-10", messages: 30, sessions: 2, toolCalls: 10 },
        ],
      },
    });
    const remote = makeRemoteData({
      metrics: {
        dailyActivity: [
          { date: "2026-03-09", messages: 50, sessions: 3, toolCalls: 20 },
          { date: "2026-03-10", messages: 30, sessions: 2, toolCalls: 10 },
        ],
      },
    });
    const result = compareMetrics(local, remote);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.summary.matches).toBe(2);
  });

  test("date present locally but missing remotely", () => {
    const local = makeLocalData({
      metrics: {
        dailyActivity: [
          { date: "2026-03-10", messages: 30, sessions: 2, toolCalls: 10 },
        ],
      },
    });
    const remote = makeRemoteData();
    const result = compareMetrics(local, remote);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].key).toBe("2026-03-10");
  });
});

// ─── compareTokens ──────────────────────────────────────────────────────────

describe("compareTokens", () => {
  test("exact token match", () => {
    const local = makeLocalData({ tokens: { byProject: { "proj-a": 5000000 } } });
    const remote = makeRemoteData({ tokens: { byProject: { "proj-a": 5000000 } } });
    const result = compareTokens(local, remote);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.summary.matches).toBe(1);
  });

  test("token mismatch", () => {
    const local = makeLocalData({ tokens: { byProject: { "proj-a": 5000000 } } });
    const remote = makeRemoteData({ tokens: { byProject: { "proj-a": 3000000 } } });
    const result = compareTokens(local, remote);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].severity).toBe("error");
  });
});

// ─── compareModels ──────────────────────────────────────────────────────────

describe("compareModels", () => {
  test("matching model stats", () => {
    const local = makeLocalData({
      models: {
        stats: [
          { model: "claude-opus", total: 1000, input: 500, cacheWrite: 200, cacheRead: 100, output: 200 },
        ],
      },
    });
    const remote = makeRemoteData({
      models: {
        stats: {
          "claude-opus": { total: 1000, input: 500, cacheWrite: 200, cacheRead: 100, output: 200 },
        },
      },
    });
    const result = compareModels(local, remote);
    expect(result.discrepancies).toHaveLength(0);
  });

  test("model present locally but not remotely", () => {
    const local = makeLocalData({
      models: {
        stats: [
          { model: "claude-opus", total: 1000, input: 500, cacheWrite: 200, cacheRead: 100, output: 200 },
        ],
      },
    });
    const remote = makeRemoteData();
    const result = compareModels(local, remote);
    expect(result.discrepancies).toHaveLength(1);
  });
});

// ─── compareProjects ────────────────────────────────────────────────────────

describe("compareProjects", () => {
  test("matching project registries", () => {
    const local = makeLocalData({
      projects: [{ dirName: "my-app", slug: "my-app", projId: "uuid-1" }],
    });
    const remote = makeRemoteData({
      projects: [{ id: "uuid-1", contentSlug: "my-app", localNames: [], lastActive: null }],
    });
    const result = compareProjects(local, remote);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.summary.matches).toBe(1);
  });

  test("project on disk but not in Supabase", () => {
    const local = makeLocalData({
      projects: [{ dirName: "new-proj", slug: "new-proj", projId: "uuid-2" }],
    });
    const remote = makeRemoteData();
    const result = compareProjects(local, remote);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].key).toBe("uuid-2");
    expect(result.discrepancies[0].local).toBe(1);
    expect(result.discrepancies[0].remote).toBe(0);
  });

  test("project in Supabase but not on disk", () => {
    const local = makeLocalData();
    const remote = makeRemoteData({
      projects: [{ id: "uuid-3", contentSlug: "old-proj", localNames: [], lastActive: null }],
    });
    const result = compareProjects(local, remote);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].local).toBe(0);
    expect(result.discrepancies[0].remote).toBe(1);
  });
});

// ─── buildHealth ────────────────────────────────────────────────────────────

describe("buildHealth", () => {
  test("daemon running", () => {
    const local = makeLocalData({ daemon: { running: true, pid: 12345 } });
    const remote = makeRemoteData();
    const health = buildHealth(local, remote);
    expect(health.daemon.running).toBe(true);
    expect(health.daemon.pid).toBe(12345);
  });

  test("supabase connected", () => {
    const local = makeLocalData();
    const remote = makeRemoteData({ connected: true, latencyMs: 45 });
    const health = buildHealth(local, remote);
    expect(health.supabase.connected).toBe(true);
    expect(health.supabase.latencyMs).toBe(45);
  });

  test("supabase disconnected", () => {
    const local = makeLocalData();
    const remote = makeRemoteData({ connected: false, latencyMs: 0 });
    const health = buildHealth(local, remote);
    expect(health.supabase.connected).toBe(false);
  });

  test("lastSyncAgo computed from lastSync", () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    const local = makeLocalData();
    const remote = makeRemoteData({ lastSync: tenSecondsAgo });
    const health = buildHealth(local, remote);
    expect(health.lastSyncAgo).toMatch(/\d+s ago/);
  });

  test("lastSyncAgo null when no lastSync", () => {
    const local = makeLocalData();
    const remote = makeRemoteData({ lastSync: null });
    const health = buildHealth(local, remote);
    expect(health.lastSyncAgo).toBeNull();
  });
});

// ─── Severity thresholds ────────────────────────────────────────────────────

describe("severity thresholds", () => {
  test("exactly 2% difference is error", () => {
    const local = makeLocalData({ tokens: { byProject: { a: 100 } } });
    const remote = makeRemoteData({ tokens: { byProject: { a: 98 } } });
    const result = compareTokens(local, remote);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].severity).toBe("error");
  });

  test("just under 2% difference is warning", () => {
    const local = makeLocalData({ tokens: { byProject: { a: 1000 } } });
    const remote = makeRemoteData({ tokens: { byProject: { a: 981 } } });
    const result = compareTokens(local, remote);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].severity).toBe("warning");
  });

  test("both zero is a match", () => {
    const local = makeLocalData({ tokens: { byProject: { a: 0 } } });
    const remote = makeRemoteData({ tokens: { byProject: { a: 0 } } });
    const result = compareTokens(local, remote);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.summary.matches).toBe(1);
  });

  test("discrepancies sorted: errors before warnings", () => {
    const local = makeLocalData({
      tokens: { byProject: { a: 100, b: 1000 } },
    });
    const remote = makeRemoteData({
      tokens: { byProject: { a: 50, b: 990 } },
    });
    const result = compareTokens(local, remote);
    expect(result.discrepancies).toHaveLength(2);
    expect(result.discrepancies[0].severity).toBe("error");
    expect(result.discrepancies[1].severity).toBe("warning");
  });
});
