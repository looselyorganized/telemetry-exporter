import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Processor } from "../processor";
import { initLocal, getLocal } from "../../db/local";
import type { LogEntry } from "../../parsers";
import type { ResolvedProject } from "../../project/resolver";

// ---------------------------------------------------------------------------
// Mock ProjectResolver
// ---------------------------------------------------------------------------

class MockResolver {
  private map: Map<string, ResolvedProject>;

  constructor(mappings: Record<string, ResolvedProject>) {
    this.map = new Map(Object.entries(mappings));
  }

  resolve(dirName: string): ResolvedProject | null {
    return this.map.get(dirName) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "03/19 10:00 AM",
    parsedTimestamp: new Date("2026-03-19T10:00:00Z"),
    project: "my-project",
    branch: "main",
    emoji: "🔧",
    eventType: "tool",
    eventText: "Some tool call",
    ...overrides,
  };
}

/** Return today's date string in YYYY-MM-DD format. */
function todayStr(): string {
  return new Date().toISOString().substring(0, 10);
}

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "processor-test-"));
  const dbPath = join(tmpDir, "test.db");
  initLocal(dbPath);
  db = getLocal();
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Processor.processEvents", () => {
  test("filters out entries where resolver returns null", () => {
    const resolver = new MockResolver({
      // no mapping for 'unknown-project'
    });
    const processor = new Processor(resolver as any, db);

    processor.processEvents([
      makeEntry({ project: "unknown-project" }),
    ]);

    const outboxRows = db.query("SELECT * FROM outbox").all();
    expect(outboxRows).toHaveLength(0);
  });

  test("registers unknown projects to outbox with target 'projects'", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_abc123", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);

    processor.processEvents([makeEntry({ project: "my-project" })]);

    const projectRows = db
      .query("SELECT * FROM outbox WHERE target = 'projects' AND json_extract(payload, '$.id') IS NOT NULL AND json_extract(payload, '$.last_active') IS NULL")
      .all() as any[];
    expect(projectRows.length).toBeGreaterThanOrEqual(1);
    const registration = projectRows[0];
    const payload = JSON.parse(registration.payload);
    expect(payload.id).toBe("proj_abc123");
    expect(payload.slug).toBe("my-project");
  });

  test("adds unknown projects to known_projects table", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_abc123", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);

    processor.processEvents([makeEntry({ project: "my-project" })]);

    const knownRows = db
      .query("SELECT * FROM known_projects WHERE proj_id = 'proj_abc123'")
      .all();
    expect(knownRows).toHaveLength(1);
  });

  test("does not re-register already-known projects", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_abc123", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);

    // First call — registers it
    processor.processEvents([makeEntry({ project: "my-project" })]);
    const countBefore = (
      db.query("SELECT COUNT(*) as c FROM outbox WHERE target = 'projects' AND json_extract(payload, '$.id') IS NOT NULL AND json_extract(payload, '$.last_active') IS NULL").get() as any
    ).c;

    // Second call — should NOT add another registration row
    processor.processEvents([makeEntry({ project: "my-project" })]);
    const countAfter = (
      db.query("SELECT COUNT(*) as c FROM outbox WHERE target = 'projects' AND json_extract(payload, '$.id') IS NOT NULL AND json_extract(payload, '$.last_active') IS NULL").get() as any
    ).c;

    expect(countAfter).toBe(countBefore);
  });

  test("enqueues events to outbox with target 'events'", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_abc123", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);

    const entry = makeEntry({
      project: "my-project",
      eventType: "tool",
      eventText: "Bash call",
      branch: "feat/test",
      emoji: "🔧",
      parsedTimestamp: new Date("2026-03-19T10:00:00Z"),
    });

    processor.processEvents([entry]);

    const eventRows = db
      .query("SELECT * FROM outbox WHERE target = 'events'")
      .all() as any[];
    expect(eventRows).toHaveLength(1);

    const payload = JSON.parse(eventRows[0].payload);
    expect(payload.project_id).toBe("proj_abc123");
    expect(payload.event_type).toBe("tool");
    expect(payload.event_text).toBe("Bash call");
    expect(payload.branch).toBe("feat/test");
    expect(payload.emoji).toBe("🔧");
    expect(payload.timestamp).toBe("2026-03-19T10:00:00.000Z");
  });

  test("project activity updates include slug", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_aaa", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);
    processor.loadKnownProjects();

    const entries: LogEntry[] = [
      makeEntry({ project: "my-project", eventType: "session_start", eventText: "Started", parsedTimestamp: new Date("2026-03-19T10:00:00.000Z") }),
    ];
    processor.processEvents(entries);

    const rows = db
      .query("SELECT * FROM outbox WHERE target = 'projects' ORDER BY id")
      .all() as any[];

    const activityRow = rows.find((r: any) => {
      const p = JSON.parse(r.payload);
      return p.last_active !== undefined;
    });
    expect(activityRow).toBeDefined();
    const payload = JSON.parse(activityRow!.payload);
    expect(payload.slug).toBe("my-project");
    expect(payload.id).toBe("proj_aaa");
    expect(payload.last_active).toBeDefined();
  });

  test("enqueues project activity updates with last_active", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_abc123", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);

    const t1 = new Date("2026-03-19T09:00:00Z");
    const t2 = new Date("2026-03-19T10:30:00Z");
    const t3 = new Date("2026-03-19T10:00:00Z");

    processor.processEvents([
      makeEntry({ project: "my-project", parsedTimestamp: t1 }),
      makeEntry({ project: "my-project", parsedTimestamp: t2 }),
      makeEntry({ project: "my-project", parsedTimestamp: t3 }),
    ]);

    const activityRows = db
      .query("SELECT * FROM outbox WHERE target = 'projects' AND json_extract(payload, '$.last_active') IS NOT NULL")
      .all() as any[];
    expect(activityRows).toHaveLength(1);

    const payload = JSON.parse(activityRows[0].payload);
    expect(payload.id).toBe("proj_abc123");
    expect(payload.last_active).toBe(t2.toISOString());
  });

  test("enqueues events to archive_queue with content_hash", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_abc123", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);

    processor.processEvents([makeEntry({ project: "my-project" })]);

    const archiveRows = db
      .query("SELECT * FROM archive_queue")
      .all() as any[];
    expect(archiveRows).toHaveLength(1);
    expect(archiveRows[0].fact_type).toBe("event");
    expect(archiveRows[0].content_hash).toBeTruthy();
    expect(archiveRows[0].content_hash).toHaveLength(64); // SHA-256 hex
  });

  test("archive dedup: same event twice produces only one archive row", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_abc123", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);

    const entry = makeEntry({ project: "my-project" });
    processor.processEvents([entry]);
    processor.processEvents([entry]);

    const archiveRows = db.query("SELECT * FROM archive_queue").all();
    expect(archiveRows).toHaveLength(1);
  });

  test("all writes are in a single transaction — error mid-way leaves nothing written", () => {
    // We need a resolver that throws after the first resolution
    let callCount = 0;
    const faultyResolver = {
      resolve(dirName: string): ResolvedProject | null {
        callCount++;
        if (callCount === 1) return { projId: "proj_abc123", slug: "my-project" };
        // Throw on second resolution to simulate mid-transaction error
        throw new Error("Simulated resolver error");
      },
    };

    const processor = new Processor(faultyResolver as any, db);

    const entries = [
      makeEntry({ project: "my-project", parsedTimestamp: new Date("2026-03-19T10:00:00Z") }),
      makeEntry({ project: "other-project", parsedTimestamp: new Date("2026-03-19T10:01:00Z") }),
    ];

    expect(() => processor.processEvents(entries)).toThrow("Simulated resolver error");

    // Nothing should be written because the transaction rolled back
    const outboxRows = db.query("SELECT * FROM outbox").all();
    const archiveRows = db.query("SELECT * FROM archive_queue").all();
    const knownRows = db.query("SELECT * FROM known_projects").all();

    expect(outboxRows).toHaveLength(0);
    expect(archiveRows).toHaveLength(0);
    expect(knownRows).toHaveLength(0);
  });

  test("handles empty entries array — no error, no writes", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);

    expect(() => processor.processEvents([])).not.toThrow();

    const outboxRows = db.query("SELECT * FROM outbox").all();
    const archiveRows = db.query("SELECT * FROM archive_queue").all();
    expect(outboxRows).toHaveLength(0);
    expect(archiveRows).toHaveLength(0);
  });

  test("multiple projects in one batch each get activity updates", () => {
    const resolver = new MockResolver({
      "project-a": { projId: "proj_aaa", slug: "project-a" },
      "project-b": { projId: "proj_bbb", slug: "project-b" },
    });
    const processor = new Processor(resolver as any, db);

    processor.processEvents([
      makeEntry({ project: "project-a", parsedTimestamp: new Date("2026-03-19T09:00:00Z") }),
      makeEntry({ project: "project-b", parsedTimestamp: new Date("2026-03-19T09:30:00Z") }),
      makeEntry({ project: "project-a", parsedTimestamp: new Date("2026-03-19T10:00:00Z") }),
    ]);

    const activityRows = db
      .query("SELECT * FROM outbox WHERE target = 'projects' AND json_extract(payload, '$.last_active') IS NOT NULL ORDER BY id")
      .all() as any[];
    expect(activityRows).toHaveLength(2);

    const payloads = activityRows.map((r) => JSON.parse(r.payload));
    const aActivity = payloads.find((p: any) => p.id === "proj_aaa");
    const bActivity = payloads.find((p: any) => p.id === "proj_bbb");

    expect(aActivity?.last_active).toBe("2026-03-19T10:00:00.000Z");
    expect(bActivity?.last_active).toBe("2026-03-19T09:30:00.000Z");
  });

  test("loadKnownProjects populates in-memory set from DB", () => {
    // Pre-seed known_projects in DB
    db.query(
      "INSERT INTO known_projects (proj_id, slug, created_at) VALUES (?, ?, ?)"
    ).run("proj_preloaded", "preloaded", new Date().toISOString());

    const resolver = new MockResolver({
      "preloaded-dir": { projId: "proj_preloaded", slug: "preloaded" },
    });
    const processor = new Processor(resolver as any, db);
    processor.loadKnownProjects();

    // Process entry for the already-known project
    processor.processEvents([makeEntry({ project: "preloaded-dir" })]);

    // Registration row should NOT appear since project was already known
    const registrationRows = db
      .query("SELECT * FROM outbox WHERE target = 'projects' AND json_extract(payload, '$.id') IS NOT NULL AND json_extract(payload, '$.last_active') IS NULL")
      .all();
    expect(registrationRows).toHaveLength(0);
  });

  test("event with null parsedTimestamp enqueues with fallback timestamp", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_abc123", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);

    processor.processEvents([
      makeEntry({ project: "my-project", parsedTimestamp: null }),
    ]);

    const eventRows = db
      .query("SELECT * FROM outbox WHERE target = 'events'")
      .all() as any[];
    expect(eventRows).toHaveLength(1);
    const payload = JSON.parse(eventRows[0].payload);
    expect(payload.timestamp).not.toBeNull();
    expect(new Date(payload.timestamp).getTime()).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Processor.hydrate
// ---------------------------------------------------------------------------

describe("Processor.hydrate", () => {
  test("loads known_projects from SQLite into Set", async () => {
    // Seed DB with a known project
    db.query(
      "INSERT INTO known_projects (proj_id, slug, created_at) VALUES (?, ?, ?)"
    ).run("proj_hydrate_test", "hydrate-slug", new Date().toISOString());

    const resolver = new MockResolver({
      "hydrate-dir": { projId: "proj_hydrate_test", slug: "hydrate-slug" },
    });
    const processor = new Processor(resolver as any, db);
    await processor.hydrate();

    // Process entry for the already-known project — registration row should NOT appear
    processor.processEvents([makeEntry({ project: "hydrate-dir" })]);

    const registrationRows = db
      .query(
        "SELECT * FROM outbox WHERE target = 'projects' AND json_extract(payload, '$.id') IS NOT NULL AND json_extract(payload, '$.last_active') IS NULL"
      )
      .all();
    expect(registrationRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Processor.refreshResolver
// ---------------------------------------------------------------------------

describe("Processor.refreshResolver", () => {
  test("calls resolver.refresh()", async () => {
    let refreshCalled = false;
    const mockResolver = {
      resolve: () => null,
      refresh: async () => { refreshCalled = true; },
    };

    const processor = new Processor(mockResolver as any, db);
    await processor.refreshResolver();

    expect(refreshCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Processor.processOtelBatch
// ---------------------------------------------------------------------------

describe("Processor.processOtelBatch", () => {
  /** Helper: create a minimal valid OtelEventBatch with defaults for new fields. */
  function makeBatch(overrides: Partial<import("../../pipeline/otel-receiver").OtelEventBatch> = {}): import("../../pipeline/otel-receiver").OtelEventBatch {
    return {
      apiRequests: [],
      toolResults: [],
      toolDecisionRejects: [],
      apiErrors: [],
      unresolved: 0,
      skipped: 0,
      ...overrides,
    };
  }

  test("does nothing for empty batch", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);

    processor.processOtelBatch(makeBatch());

    const rows = db.query("SELECT COUNT(*) as c FROM outbox").get() as any;
    expect(rows.c).toBe(0);
  });

  test("enqueues otel_api_requests per request", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    processor.processOtelBatch(makeBatch({
      apiRequests: [
        {
          projId: "proj_abc",
          sessionId: "sess-1",
          model: "claude-opus-4-6",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 5000,
          cacheWriteTokens: 200,
          costUsd: 0.05,
          durationMs: 1234,
          timestamp: `${today}T12:00:00.000Z`,
        },
      ],
    }));

    const rows = db
      .query("SELECT * FROM outbox WHERE target = 'otel_api_requests'")
      .all() as any[];
    expect(rows).toHaveLength(1);

    const payload = JSON.parse(rows[0].payload);
    expect(payload.project_id).toBe("proj_abc");
    expect(payload.model).toBe("claude-opus-4-6");
    expect(payload.input_tokens).toBe(1000);
    expect(payload.output_tokens).toBe(500);
  });

  test("accumulates tokens and cost into pendingRollups via flushRollups", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    processor.processOtelBatch(makeBatch({
      apiRequests: [
        {
          projId: "proj_abc",
          sessionId: "sess-1",
          model: "claude-opus-4-6",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 5000,
          cacheWriteTokens: 200,
          costUsd: 0.05,
          durationMs: 1234,
          timestamp: `${today}T12:00:00.000Z`,
        },
      ],
    }));

    // Before flush, no daily_rollups in outbox
    const beforeFlush = db
      .query("SELECT COUNT(*) as c FROM outbox WHERE target = 'daily_rollups'")
      .get() as any;
    expect(beforeFlush.c).toBe(0);

    // Flush
    processor.flushRollups();

    const rows = db
      .query("SELECT * FROM outbox WHERE target = 'daily_rollups'")
      .all() as any[];
    expect(rows).toHaveLength(1);

    const payload = JSON.parse(rows[0].payload);
    expect(payload.date).toBe(today);
    expect(payload.project_id).toBe("proj_abc");
    expect(payload.tokens["claude-opus-4-6"]).toEqual({
      input: 1000,
      cache_read: 5000,
      cache_write: 200,
      output: 500,
    });
    expect(payload.cost["claude-opus-4-6"]).toBeCloseTo(0.05);
  });

  test("accumulates multiple api_requests for same model into rollup", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    processor.processOtelBatch(makeBatch({
      apiRequests: [
        {
          projId: "proj_abc", sessionId: "s1", model: "opus",
          inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
          costUsd: 0.03, durationMs: 100, timestamp: `${today}T12:00:00.000Z`,
        },
        {
          projId: "proj_abc", sessionId: "s1", model: "opus",
          inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0,
          costUsd: 0.02, durationMs: 200, timestamp: `${today}T12:01:00.000Z`,
        },
      ],
    }));

    processor.flushRollups();

    const rows = db
      .query("SELECT * FROM outbox WHERE target = 'daily_rollups'")
      .all() as any[];
    expect(rows).toHaveLength(1);

    const payload = JSON.parse(rows[0].payload);
    expect(payload.tokens["opus"]).toEqual({
      input: 3000,
      cache_read: 0,
      cache_write: 0,
      output: 800,
    });
    expect(payload.cost["opus"]).toBeCloseTo(0.05);
  });

  test("accumulates tool_result counts into rollup events", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);

    processor.processOtelBatch(makeBatch({
      toolResults: [
        {
          projId: "proj_abc",
          sessionId: "sess-1",
          toolName: "Bash",
          success: true,
          durationMs: 567,
          timestamp: "2026-03-26T12:00:00.000Z",
        },
        {
          projId: "proj_abc",
          sessionId: "sess-1",
          toolName: "Read",
          success: false,
          durationMs: 12,
          timestamp: "2026-03-26T12:00:01.000Z",
        },
      ],
    }));

    processor.flushRollups();

    const rows = db
      .query("SELECT * FROM outbox WHERE target = 'daily_rollups'")
      .all() as any[];
    expect(rows).toHaveLength(1);

    const payload = JSON.parse(rows[0].payload);
    // Bash -> "tool", Read -> "read"
    expect(payload.events["tool"]).toBe(1);
    expect(payload.events["read"]).toBe(1);
  });

  test("does not enqueue tool_results as individual events", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);

    processor.processOtelBatch(makeBatch({
      toolResults: [
        {
          projId: "proj_abc",
          sessionId: "sess-1",
          toolName: "Bash",
          success: true,
          durationMs: 567,
          timestamp: "2026-03-26T12:00:00.000Z",
        },
      ],
    }));

    // Tool results should NOT be in events target (only in rollups)
    const eventRows = db
      .query("SELECT * FROM outbox WHERE target = 'events'")
      .all() as any[];
    expect(eventRows).toHaveLength(0);
  });

  test("enqueues tool_decision rejects as individual events", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);

    processor.processOtelBatch(makeBatch({
      toolDecisionRejects: [
        {
          projId: "proj_abc",
          sessionId: "sess-1",
          toolName: "Bash",
          timestamp: "2026-03-26T12:00:00.000Z",
        },
      ],
    }));

    const rows = db
      .query("SELECT * FROM outbox WHERE target = 'events'")
      .all() as any[];
    expect(rows).toHaveLength(1);

    const payload = JSON.parse(rows[0].payload);
    expect(payload.event_type).toBe("tool_decision_reject");
    expect(payload.event_text).toContain("Bash");
    expect(payload.event_text).toContain("rejected");
  });

  test("enqueues api_errors as individual events and accumulates error count in rollup", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    processor.processOtelBatch(makeBatch({
      apiErrors: [
        {
          projId: "proj_abc",
          sessionId: "sess-1",
          error: "rate_limited",
          statusCode: 429,
          model: "opus",
          timestamp: `${today}T12:00:00.000Z`,
        },
        {
          projId: "proj_abc",
          sessionId: "sess-1",
          error: "server_error",
          statusCode: 500,
          model: "opus",
          timestamp: `${today}T12:01:00.000Z`,
        },
      ],
    }));

    // Individual events enqueued
    const eventRows = db
      .query("SELECT * FROM outbox WHERE target = 'events'")
      .all() as any[];
    expect(eventRows).toHaveLength(2);

    const p1 = JSON.parse(eventRows[0].payload);
    expect(p1.event_type).toBe("api_error");
    expect(p1.event_text).toContain("429");
    expect(p1.event_text).toContain("rate_limited");

    // Rollup error count
    processor.flushRollups();
    const rollupRows = db
      .query("SELECT * FROM outbox WHERE target = 'daily_rollups'")
      .all() as any[];
    expect(rollupRows).toHaveLength(1);
    const rollup = JSON.parse(rollupRows[0].payload);
    expect(rollup.errors).toBe(2);
  });

  test("per-payload dedup via flushRollups: identical rollup is not re-enqueued", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    const batch = makeBatch({
      apiRequests: [{
        projId: "proj_abc", sessionId: "s1", model: "opus",
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0.03, durationMs: 100, timestamp: `${today}T12:00:00.000Z`,
      }],
    });

    processor.processOtelBatch(batch);
    processor.flushRollups();
    const countFirst = (db.query("SELECT COUNT(*) as c FROM outbox WHERE target = 'daily_rollups'").get() as any).c;
    expect(countFirst).toBe(1);

    // Second batch with identical data — pendingRollups was cleared, so it builds
    // the same rollup again. flushRollups dedup should skip it.
    processor.processOtelBatch(batch);
    processor.flushRollups();
    const countSecond = (db.query("SELECT COUNT(*) as c FROM outbox WHERE target = 'daily_rollups'").get() as any).c;

    // Identical payload — dedup should prevent re-enqueue
    expect(countSecond).toBe(1);
  });

  test("flushRollups enqueues when rollup data changes between cycles", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    processor.processOtelBatch(makeBatch({
      apiRequests: [{
        projId: "proj_abc", sessionId: "s1", model: "opus",
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0.03, durationMs: 100, timestamp: `${today}T12:00:00.000Z`,
      }],
    }));
    processor.flushRollups();

    // Second cycle with different data
    processor.processOtelBatch(makeBatch({
      apiRequests: [{
        projId: "proj_abc", sessionId: "s1", model: "opus",
        inputTokens: 2000, outputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0.05, durationMs: 150, timestamp: `${today}T12:05:00.000Z`,
      }],
    }));
    processor.flushRollups();

    const count = (db.query("SELECT COUNT(*) as c FROM outbox WHERE target = 'daily_rollups'").get() as any).c;
    // Different payload — should enqueue a second row
    expect(count).toBe(2);
  });

  test("fires budget alert when daily cost exceeds threshold", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    // Send enough cost to exceed $5 threshold
    processor.processOtelBatch(makeBatch({
      apiRequests: [{
        projId: "proj_expensive", sessionId: "s1", model: "opus",
        inputTokens: 100000, outputTokens: 50000, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 6.0, durationMs: 100, timestamp: `${today}T12:00:00.000Z`,
      }],
    }));

    const alertRows = db
      .query("SELECT * FROM outbox WHERE target = 'alerts'")
      .all() as any[];
    expect(alertRows.length).toBeGreaterThanOrEqual(1);

    const payload = JSON.parse(alertRows[0].payload);
    expect(payload.project_id).toBe("proj_expensive");
    expect(payload.alert_type).toBe("budget_threshold");
    expect(payload.threshold_usd).toBe(5);
    expect(payload.current_usd).toBe(6.0);
  });

  test("fires multiple alerts for multiple thresholds", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    processor.processOtelBatch(makeBatch({
      apiRequests: [{
        projId: "proj_big", sessionId: "s1", model: "opus",
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 26.0, durationMs: 100, timestamp: `${today}T12:00:00.000Z`,
      }],
    }));

    const alertRows = db
      .query("SELECT * FROM outbox WHERE target = 'alerts'")
      .all() as any[];
    // Should fire $5, $10, $25 = 3 alerts
    expect(alertRows).toHaveLength(3);

    const thresholds = alertRows.map((r: any) => JSON.parse(r.payload).threshold_usd).sort((a: number, b: number) => a - b);
    expect(thresholds).toEqual([5, 10, 25]);
  });

  test("does not re-fire same threshold on subsequent batches", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    const batch = makeBatch({
      apiRequests: [{
        projId: "proj_repeat", sessionId: "s1", model: "opus",
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 6.0, durationMs: 100, timestamp: `${today}T12:00:00.000Z`,
      }],
    });

    processor.processOtelBatch(batch);
    const countFirst = (db.query("SELECT COUNT(*) as c FROM outbox WHERE target = 'alerts'").get() as any).c;
    expect(countFirst).toBe(1); // $5 threshold

    // Budget alerts now use in-batch cost, not accumulated cost_tracking.
    // Second batch with same $6 cost triggers $5 again but it's already fired.
    // No $10 threshold crossed since each batch is independent.
    processor.processOtelBatch(batch);
    const countSecond = (db.query("SELECT COUNT(*) as c FROM outbox WHERE target = 'alerts'").get() as any).c;

    // Same $5 threshold was already fired, $6 < $10 — no new alerts
    expect(countSecond).toBe(1);
  });

  test("does not fire alert below threshold", () => {
    const resolver = new MockResolver({});
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    processor.processOtelBatch(makeBatch({
      apiRequests: [{
        projId: "proj_cheap", sessionId: "s1", model: "opus",
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0.01, durationMs: 100, timestamp: `${today}T12:00:00.000Z`,
      }],
    }));

    const alertRows = db
      .query("SELECT * FROM outbox WHERE target = 'alerts'")
      .all();
    expect(alertRows).toHaveLength(0);
  });

  test("unified accumulator: OTel tokens and event counts in same rollup", () => {
    const resolver = new MockResolver({
      "my-project": { projId: "proj_abc", slug: "my-project" },
    });
    const processor = new Processor(resolver as any, db);
    const today = todayStr();

    // Process events (from JSONL pipeline)
    processor.processEvents([
      makeEntry({
        project: "my-project",
        eventType: "session_start",
        parsedTimestamp: new Date(`${today}T09:00:00Z`),
      }),
    ]);

    // Process OTel batch (from OTel pipeline)
    processor.processOtelBatch(makeBatch({
      apiRequests: [{
        projId: "proj_abc", sessionId: "s1", model: "opus",
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0.03, durationMs: 100, timestamp: `${today}T10:00:00.000Z`,
      }],
    }));

    // Flush produces ONE unified rollup with both tokens and event counts
    processor.flushRollups();

    const rows = db
      .query("SELECT * FROM outbox WHERE target = 'daily_rollups'")
      .all() as any[];
    expect(rows).toHaveLength(1);

    const payload = JSON.parse(rows[0].payload);
    expect(payload.project_id).toBe("proj_abc");
    expect(payload.tokens["opus"].input).toBe(1000);
    expect(payload.events["session_start"]).toBe(1);
    expect(payload.cost["opus"]).toBeCloseTo(0.03);
  });
});
