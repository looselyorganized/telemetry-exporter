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

  test("event with null parsedTimestamp still enqueues with null timestamp", () => {
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
    expect(payload.timestamp).toBeNull();
  });
});
