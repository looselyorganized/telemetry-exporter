import { describe, test, expect } from "bun:test";
import {
  formatTokens,
  sumValues,
  computeLastActive,
  formatModelStats,
  filterAndMapEntries,
  aggregateProjectEvents,
  buildProjectTelemetryUpdates,
  filterRecentEntries,
  type ProjectTelemetryInput,
} from "../daemon-helpers";
import type { LogEntry, ModelStats } from "../../src/parsers";

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "",
    parsedTimestamp: null,
    project: "",
    branch: "",
    emoji: "",
    eventType: "unknown",
    eventText: "",
    ...overrides,
  };
}

// ─── formatTokens ───────────────────────────────────────────────────────────

describe("formatTokens", () => {
  test("formats millions", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  test("formats zero", () => {
    expect(formatTokens(0)).toBe("0.0M");
  });

  test("formats sub-million as fractional M", () => {
    expect(formatTokens(500_000)).toBe("0.5M");
  });

  test("formats large numbers", () => {
    expect(formatTokens(10_500_000)).toBe("10.5M");
  });

  test("rounds to one decimal place", () => {
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(1_249_999)).toBe("1.2M");
  });

  test("handles very small numbers", () => {
    expect(formatTokens(1)).toBe("0.0M");
    expect(formatTokens(100_000)).toBe("0.1M");
  });
});

// ─── sumValues ──────────────────────────────────────────────────────────────

describe("sumValues", () => {
  test("sums all values in a record", () => {
    expect(sumValues({ a: 10, b: 20, c: 30 })).toBe(60);
  });

  test("returns 0 for empty record", () => {
    expect(sumValues({})).toBe(0);
  });

  test("handles single entry", () => {
    expect(sumValues({ only: 42 })).toBe(42);
  });

  test("handles negative values", () => {
    expect(sumValues({ a: 10, b: -3 })).toBe(7);
  });

  test("handles floating point values", () => {
    expect(sumValues({ a: 0.1, b: 0.2 })).toBeCloseTo(0.3);
  });
});

// ─── computeLastActive ─────────────────────────────────────────────────────

describe("computeLastActive", () => {
  test("returns latest timestamp per project", () => {
    const early = new Date("2026-01-01T10:00:00Z");
    const late = new Date("2026-01-01T15:00:00Z");
    const result = computeLastActive([
      makeEntry({ project: "proj-a", parsedTimestamp: early }),
      makeEntry({ project: "proj-a", parsedTimestamp: late }),
    ]);
    expect(result["proj-a"]).toEqual(late);
  });

  test("handles multiple projects independently", () => {
    const dateA = new Date("2026-01-01T10:00:00Z");
    const dateB = new Date("2026-01-02T10:00:00Z");
    const result = computeLastActive([
      makeEntry({ project: "proj-a", parsedTimestamp: dateA }),
      makeEntry({ project: "proj-b", parsedTimestamp: dateB }),
    ]);
    expect(result["proj-a"]).toEqual(dateA);
    expect(result["proj-b"]).toEqual(dateB);
  });

  test("skips entries without project", () => {
    const result = computeLastActive([
      makeEntry({ project: "", parsedTimestamp: new Date() }),
    ]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("skips entries without parsedTimestamp", () => {
    const result = computeLastActive([makeEntry({ project: "proj-a" })]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("returns empty for empty input", () => {
    expect(computeLastActive([])).toEqual({});
  });

  test("picks later date when entries arrive out of order", () => {
    const late = new Date("2026-03-01T12:00:00Z");
    const early = new Date("2026-01-01T12:00:00Z");
    const result = computeLastActive([
      makeEntry({ project: "p", parsedTimestamp: late }),
      makeEntry({ project: "p", parsedTimestamp: early }),
    ]);
    expect(result["p"]).toEqual(late);
  });
});

// ─── formatModelStats ───────────────────────────────────────────────────────

describe("formatModelStats", () => {
  test("transforms array to keyed object", () => {
    const stats: ModelStats[] = [
      { model: "claude-3", total: 100, input: 40, cacheWrite: 10, cacheRead: 30, output: 20 },
    ];
    const result = formatModelStats(stats);
    expect(result).toEqual({
      "claude-3": { total: 100, input: 40, cacheWrite: 10, cacheRead: 30, output: 20 },
    });
  });

  test("handles multiple models", () => {
    const stats: ModelStats[] = [
      { model: "model-a", total: 50, input: 20, cacheWrite: 5, cacheRead: 15, output: 10 },
      { model: "model-b", total: 200, input: 80, cacheWrite: 20, cacheRead: 60, output: 40 },
    ];
    const result = formatModelStats(stats);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["model-b"]).toEqual({
      total: 200, input: 80, cacheWrite: 20, cacheRead: 60, output: 40,
    });
  });

  test("returns empty object for empty input", () => {
    expect(formatModelStats([])).toEqual({});
  });

  test("last model wins on duplicate names", () => {
    const stats: ModelStats[] = [
      { model: "dup", total: 1, input: 1, cacheWrite: 0, cacheRead: 0, output: 0 },
      { model: "dup", total: 99, input: 99, cacheWrite: 0, cacheRead: 0, output: 0 },
    ];
    const result = formatModelStats(stats);
    expect((result["dup"] as any).total).toBe(99);
  });
});

// ─── filterAndMapEntries ────────────────────────────────────────────────────

describe("filterAndMapEntries", () => {
  const resolver = (name: string) => {
    const map: Record<string, string> = {
      "my-app": "proj_aaa",
      "dashboard": "proj_bbb",
    };
    return map[name] ?? null;
  };

  test("maps known project names to projIds", () => {
    const entries = [makeEntry({ project: "my-app", eventType: "tool" })];
    const result = filterAndMapEntries(entries, resolver);
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe("proj_aaa");
  });

  test("filters out unknown projects", () => {
    const entries = [makeEntry({ project: "unknown-project" })];
    const result = filterAndMapEntries(entries, resolver);
    expect(result).toHaveLength(0);
  });

  test("filters out entries with empty project", () => {
    const entries = [makeEntry({ project: "" })];
    const result = filterAndMapEntries(entries, resolver);
    expect(result).toHaveLength(0);
  });

  test("preserves all other entry fields", () => {
    const ts = new Date("2026-01-01T10:00:00Z");
    const entries = [makeEntry({
      project: "my-app",
      parsedTimestamp: ts,
      eventType: "session_start",
      branch: "main",
      emoji: "🟢",
      eventText: "🟢 Session started",
    })];
    const result = filterAndMapEntries(entries, resolver);
    expect(result[0].project).toBe("proj_aaa");
    expect(result[0].parsedTimestamp).toEqual(ts);
    expect(result[0].eventType).toBe("session_start");
    expect(result[0].branch).toBe("main");
  });

  test("handles mix of known and unknown projects", () => {
    const entries = [
      makeEntry({ project: "my-app" }),
      makeEntry({ project: "external" }),
      makeEntry({ project: "dashboard" }),
    ];
    const result = filterAndMapEntries(entries, resolver);
    expect(result).toHaveLength(2);
    expect(result[0].project).toBe("proj_aaa");
    expect(result[1].project).toBe("proj_bbb");
  });

  test("does not mutate original entries", () => {
    const original = makeEntry({ project: "my-app" });
    filterAndMapEntries([original], resolver);
    expect(original.project).toBe("my-app");
  });
});

// ─── aggregateProjectEvents ─────────────────────────────────────────────────

describe("aggregateProjectEvents", () => {
  const resolver = (name: string) => name === "proj" ? "proj_id" : null;

  test("counts session_start events", () => {
    const entries = [
      makeEntry({ project: "proj", parsedTimestamp: new Date("2026-01-15T10:00:00Z"), eventType: "session_start" }),
      makeEntry({ project: "proj", parsedTimestamp: new Date("2026-01-15T11:00:00Z"), eventType: "session_start" }),
    ];
    const result = aggregateProjectEvents(entries, resolver);
    const counts = result.get("proj_id")!.get("2026-01-15")!;
    expect(counts.sessions).toBe(2);
    expect(counts.messages).toBe(0);
  });

  test("counts all event types correctly", () => {
    const ts = new Date("2026-02-01T10:00:00Z");
    const entries = [
      makeEntry({ project: "proj", parsedTimestamp: ts, eventType: "session_start" }),
      makeEntry({ project: "proj", parsedTimestamp: ts, eventType: "response_finish" }),
      makeEntry({ project: "proj", parsedTimestamp: ts, eventType: "tool" }),
      makeEntry({ project: "proj", parsedTimestamp: ts, eventType: "agent_spawn" }),
      makeEntry({ project: "proj", parsedTimestamp: ts, eventType: "message" }),
    ];
    const result = aggregateProjectEvents(entries, resolver);
    const counts = result.get("proj_id")!.get("2026-02-01")!;
    expect(counts.sessions).toBe(1);
    expect(counts.messages).toBe(1);
    expect(counts.toolCalls).toBe(1);
    expect(counts.agentSpawns).toBe(1);
    expect(counts.teamMessages).toBe(1);
  });

  test("ignores unrecognized event types", () => {
    const ts = new Date("2026-02-01T10:00:00Z");
    const entries = [
      makeEntry({ project: "proj", parsedTimestamp: ts, eventType: "unknown" }),
      makeEntry({ project: "proj", parsedTimestamp: ts, eventType: "read" }),
    ];
    const result = aggregateProjectEvents(entries, resolver);
    const counts = result.get("proj_id")!.get("2026-02-01")!;
    expect(counts.sessions).toBe(0);
    expect(counts.messages).toBe(0);
    expect(counts.toolCalls).toBe(0);
  });

  test("groups by date", () => {
    const entries = [
      makeEntry({ project: "proj", parsedTimestamp: new Date("2026-01-15T10:00:00Z"), eventType: "tool" }),
      makeEntry({ project: "proj", parsedTimestamp: new Date("2026-01-16T10:00:00Z"), eventType: "tool" }),
    ];
    const result = aggregateProjectEvents(entries, resolver);
    const dateMap = result.get("proj_id")!;
    expect(dateMap.size).toBe(2);
    expect(dateMap.get("2026-01-15")!.toolCalls).toBe(1);
    expect(dateMap.get("2026-01-16")!.toolCalls).toBe(1);
  });

  test("groups by project", () => {
    const multiResolver = (name: string) => {
      if (name === "a") return "id_a";
      if (name === "b") return "id_b";
      return null;
    };
    const ts = new Date("2026-01-15T10:00:00Z");
    const entries = [
      makeEntry({ project: "a", parsedTimestamp: ts, eventType: "tool" }),
      makeEntry({ project: "b", parsedTimestamp: ts, eventType: "tool" }),
    ];
    const result = aggregateProjectEvents(entries, multiResolver);
    expect(result.size).toBe(2);
    expect(result.get("id_a")!.get("2026-01-15")!.toolCalls).toBe(1);
    expect(result.get("id_b")!.get("2026-01-15")!.toolCalls).toBe(1);
  });

  test("skips entries without project", () => {
    const result = aggregateProjectEvents(
      [makeEntry({ parsedTimestamp: new Date(), eventType: "tool" })],
      resolver
    );
    expect(result.size).toBe(0);
  });

  test("skips entries without parsedTimestamp", () => {
    const result = aggregateProjectEvents(
      [makeEntry({ project: "proj", eventType: "tool" })],
      resolver
    );
    expect(result.size).toBe(0);
  });

  test("skips entries where resolver returns null", () => {
    const result = aggregateProjectEvents(
      [makeEntry({ project: "external", parsedTimestamp: new Date(), eventType: "tool" })],
      resolver
    );
    expect(result.size).toBe(0);
  });

  test("returns empty map for empty input", () => {
    expect(aggregateProjectEvents([], resolver).size).toBe(0);
  });
});

// ─── buildProjectTelemetryUpdates ───────────────────────────────────────────

describe("buildProjectTelemetryUpdates", () => {
  const emptyCaches: ProjectTelemetryInput = {
    tokensByProject: {},
    lifetimeCounters: {},
    todayTokensByProject: {},
  };

  test("returns empty array when all caches are empty", () => {
    expect(buildProjectTelemetryUpdates(emptyCaches)).toHaveLength(0);
  });

  test("builds update from tokensByProject", () => {
    const caches: ProjectTelemetryInput = {
      tokensByProject: { "proj_a": 1_000_000 },
      lifetimeCounters: {},
      todayTokensByProject: {},
    };
    const result = buildProjectTelemetryUpdates(caches);
    expect(result).toHaveLength(1);
    expect(result[0].projId).toBe("proj_a");
    expect(result[0].tokensLifetime).toBe(1_000_000);
    expect(result[0].sessionsLifetime).toBe(0);
    expect(result[0].activeAgents).toBe(0);
  });

  test("merges data from all caches for same projId", () => {
    const caches: ProjectTelemetryInput = {
      tokensByProject: { "proj_a": 500_000 },
      lifetimeCounters: {
        "proj_a": { sessions: 10, messages: 50, toolCalls: 200, agentSpawns: 3, teamMessages: 5 },
      },
      todayTokensByProject: {
        "proj_a": { total: 100_000, models: { "claude-4": 100_000 } },
      },
    };
    const result = buildProjectTelemetryUpdates(caches);
    expect(result).toHaveLength(1);
    expect(result[0].tokensLifetime).toBe(500_000);
    expect(result[0].tokensToday).toBe(100_000);
    expect(result[0].modelsToday).toEqual({ "claude-4": 100_000 });
    expect(result[0].sessionsLifetime).toBe(10);
    expect(result[0].messagesLifetime).toBe(50);
    expect(result[0].toolCallsLifetime).toBe(200);
    expect(result[0].agentSpawnsLifetime).toBe(3);
    expect(result[0].teamMessagesLifetime).toBe(5);
  });

  test("includes agent counts from agentsByProject param", () => {
    const caches: ProjectTelemetryInput = {
      tokensByProject: { "proj_a": 100 },
      lifetimeCounters: {},
      todayTokensByProject: {},
    };
    const agents = { "proj_a": { count: 3, active: 2 } };
    const result = buildProjectTelemetryUpdates(caches, agents);
    expect(result[0].activeAgents).toBe(2);
    expect(result[0].agentCount).toBe(3);
  });

  test("unions projIds across all caches", () => {
    const caches: ProjectTelemetryInput = {
      tokensByProject: { "proj_a": 100 },
      lifetimeCounters: { "proj_b": { sessions: 1, messages: 0, toolCalls: 0, agentSpawns: 0, teamMessages: 0 } },
      todayTokensByProject: { "proj_c": { total: 50, models: {} } },
    };
    const result = buildProjectTelemetryUpdates(caches);
    const ids = result.map((r) => r.projId).sort();
    expect(ids).toEqual(["proj_a", "proj_b", "proj_c"]);
  });

  test("defaults missing cache data to zeros", () => {
    const caches: ProjectTelemetryInput = {
      tokensByProject: {},
      lifetimeCounters: {},
      todayTokensByProject: {},
    };
    const agents = { "proj_x": { count: 1, active: 0 } };
    const result = buildProjectTelemetryUpdates(caches, agents);
    expect(result[0].tokensLifetime).toBe(0);
    expect(result[0].tokensToday).toBe(0);
    expect(result[0].sessionsLifetime).toBe(0);
  });
});

// ─── filterRecentEntries ────────────────────────────────────────────────────

describe("filterRecentEntries", () => {
  test("keeps entries within the cutoff window", () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    const entries = [makeEntry({ parsedTimestamp: recent, project: "p" })];
    const result = filterRecentEntries(entries, 31);
    expect(result).toHaveLength(1);
  });

  test("removes entries older than cutoff", () => {
    const old = new Date();
    old.setDate(old.getDate() - 60);
    const entries = [makeEntry({ parsedTimestamp: old, project: "p" })];
    const result = filterRecentEntries(entries, 31);
    expect(result).toHaveLength(0);
  });

  test("removes entries with null parsedTimestamp", () => {
    const entries = [makeEntry({ project: "p" })];
    const result = filterRecentEntries(entries, 31);
    expect(result).toHaveLength(0);
  });

  test("handles mixed old and recent entries", () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 2);
    const old = new Date();
    old.setDate(old.getDate() - 60);
    const entries = [
      makeEntry({ parsedTimestamp: recent, project: "p" }),
      makeEntry({ parsedTimestamp: old, project: "p" }),
      makeEntry({ parsedTimestamp: new Date(), project: "p" }),
    ];
    const result = filterRecentEntries(entries, 31);
    expect(result).toHaveLength(2);
  });

  test("returns empty for empty input", () => {
    expect(filterRecentEntries([], 31)).toHaveLength(0);
  });

  test("does not mutate original array", () => {
    const old = new Date();
    old.setDate(old.getDate() - 60);
    const entries = [makeEntry({ parsedTimestamp: old })];
    filterRecentEntries(entries, 31);
    expect(entries).toHaveLength(1);
  });

  test("respects custom day count", () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const entries = [makeEntry({ parsedTimestamp: threeDaysAgo, project: "p" })];
    expect(filterRecentEntries(entries, 7)).toHaveLength(1);
    expect(filterRecentEntries(entries, 2)).toHaveLength(0);
  });

  test("entry exactly at cutoff boundary is kept", () => {
    const atCutoff = new Date();
    atCutoff.setDate(atCutoff.getDate() - 31);
    atCutoff.setHours(atCutoff.getHours() + 1); // slightly within window
    const entries = [makeEntry({ parsedTimestamp: atCutoff, project: "p" })];
    expect(filterRecentEntries(entries, 31)).toHaveLength(1);
  });
});
