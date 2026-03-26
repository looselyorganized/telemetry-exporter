import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import {
  initLocal,
  getLocal,
  closeLocal,
  insertOtelEvent,
  getUnprocessedOtelEvents,
  markOtelEventsProcessed,
  pruneProcessedOtelEvents,
  upsertSession,
  getSession,
  upsertCostTracking,
  getCostByProject,
  getCostToday,
} from "../local";

const TEST_DB_PATH = "/tmp/lo-test-otel.db";

function deleteTestFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

beforeEach(() => {
  deleteTestFiles();
  initLocal(TEST_DB_PATH);
});

afterEach(() => {
  closeLocal();
  deleteTestFiles();
});

// ---------------------------------------------------------------------------
// Schema creation
// ---------------------------------------------------------------------------

describe("OTel schema", () => {
  it("creates otel_events table", () => {
    const db = getLocal();
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='otel_events'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("otel_events");
  });

  it("creates sessions table", () => {
    const db = getLocal();
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("sessions");
  });

  it("creates cost_tracking table", () => {
    const db = getLocal();
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cost_tracking'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("cost_tracking");
  });
});

// ---------------------------------------------------------------------------
// otel_events CRUD
// ---------------------------------------------------------------------------

describe("otel_events", () => {
  it("inserts and retrieves events", () => {
    const id = insertOtelEvent("api_request", "sess-123", '{"model":"opus"}');
    expect(id).toBeGreaterThan(0);

    const rows = getUnprocessedOtelEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("api_request");
    expect(rows[0].session_id).toBe("sess-123");
    expect(rows[0].processed).toBe(0);
    expect(JSON.parse(rows[0].payload)).toEqual({ model: "opus" });
  });

  it("handles null session_id", () => {
    insertOtelEvent("metric", null, '{"count":1}');
    const rows = getUnprocessedOtelEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBeNull();
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      insertOtelEvent("api_request", `sess-${i}`, "{}");
    }
    const rows = getUnprocessedOtelEvents(3);
    expect(rows).toHaveLength(3);
  });

  it("returns events in id order", () => {
    const id1 = insertOtelEvent("a", null, "{}");
    const id2 = insertOtelEvent("b", null, "{}");
    const id3 = insertOtelEvent("c", null, "{}");
    const rows = getUnprocessedOtelEvents(10);
    expect(rows.map((r) => r.id)).toEqual([id1, id2, id3]);
  });

  it("marks events as processed", () => {
    const id1 = insertOtelEvent("a", null, "{}");
    const id2 = insertOtelEvent("b", null, "{}");
    markOtelEventsProcessed([id1]);

    const unprocessed = getUnprocessedOtelEvents(10);
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0].id).toBe(id2);
  });

  it("markOtelEventsProcessed handles empty array", () => {
    insertOtelEvent("a", null, "{}");
    markOtelEventsProcessed([]);
    expect(getUnprocessedOtelEvents(10)).toHaveLength(1);
  });

  it("prunes processed events older than threshold", () => {
    const db = getLocal();
    // Insert a processed event with an old received_at
    db.query(
      "INSERT INTO otel_events (event_type, payload, processed, received_at) VALUES (?, ?, 1, ?)"
    ).run("old", "{}", "2020-01-01T00:00:00.000Z");
    // Insert an unprocessed old event (should not be pruned)
    db.query(
      "INSERT INTO otel_events (event_type, payload, processed, received_at) VALUES (?, ?, 0, ?)"
    ).run("old_pending", "{}", "2020-01-01T00:00:00.000Z");
    // Insert a recent processed event (should not be pruned)
    insertOtelEvent("recent", null, "{}");
    markOtelEventsProcessed([3]); // id 3 = the recent one

    const pruned = pruneProcessedOtelEvents(7);
    expect(pruned).toBe(1); // only the old processed one

    // Verify the unprocessed old one and recent processed one remain
    const remaining = db
      .query<{ event_type: string }, []>("SELECT event_type FROM otel_events ORDER BY id")
      .all();
    expect(remaining.map((r) => r.event_type)).toEqual(["old_pending", "recent"]);
  });
});

// ---------------------------------------------------------------------------
// sessions CRUD
// ---------------------------------------------------------------------------

describe("sessions", () => {
  it("inserts and retrieves a session", () => {
    upsertSession("sess-abc", "proj_123", "/Users/me/project");
    const session = getSession("sess-abc");
    expect(session).not.toBeNull();
    expect(session!.session_id).toBe("sess-abc");
    expect(session!.proj_id).toBe("proj_123");
    expect(session!.cwd).toBe("/Users/me/project");
    expect(session!.first_seen).toBeTruthy();
  });

  it("returns null for unknown session", () => {
    expect(getSession("nonexistent")).toBeNull();
  });

  it("ignores duplicate inserts (immutable)", () => {
    upsertSession("sess-abc", "proj_123", "/path/one");
    upsertSession("sess-abc", "proj_456", "/path/two"); // different proj_id
    const session = getSession("sess-abc");
    // First write wins (INSERT OR IGNORE)
    expect(session!.proj_id).toBe("proj_123");
    expect(session!.cwd).toBe("/path/one");
  });
});

// ---------------------------------------------------------------------------
// cost_tracking CRUD
// ---------------------------------------------------------------------------

describe("cost_tracking", () => {
  it("inserts and retrieves cost data", () => {
    upsertCostTracking("proj_abc", "2026-03-26", "claude-opus-4-6", {
      input: 1000,
      output: 500,
      cache_read: 5000,
      cache_write: 200,
    }, 0.05);

    const rows = getCostByProject("proj_abc");
    expect(rows).toHaveLength(1);
    expect(rows[0].proj_id).toBe("proj_abc");
    expect(rows[0].date).toBe("2026-03-26");
    expect(rows[0].model).toBe("claude-opus-4-6");
    expect(rows[0].input_tokens).toBe(1000);
    expect(rows[0].output_tokens).toBe(500);
    expect(rows[0].cache_read_tokens).toBe(5000);
    expect(rows[0].cache_write_tokens).toBe(200);
    expect(rows[0].cost_usd).toBeCloseTo(0.05);
    expect(rows[0].request_count).toBe(1);
  });

  it("accumulates on conflict (same proj/date/model)", () => {
    upsertCostTracking("proj_abc", "2026-03-26", "opus", {
      input: 1000, output: 500, cache_read: 5000, cache_write: 200,
    }, 0.05);
    upsertCostTracking("proj_abc", "2026-03-26", "opus", {
      input: 2000, output: 300, cache_read: 3000, cache_write: 100,
    }, 0.03);

    const rows = getCostByProject("proj_abc");
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(3000);
    expect(rows[0].output_tokens).toBe(800);
    expect(rows[0].cache_read_tokens).toBe(8000);
    expect(rows[0].cache_write_tokens).toBe(300);
    expect(rows[0].cost_usd).toBeCloseTo(0.08);
    expect(rows[0].request_count).toBe(2);
  });

  it("keeps different models separate", () => {
    upsertCostTracking("proj_abc", "2026-03-26", "opus", {
      input: 1000, output: 500, cache_read: 0, cache_write: 0,
    }, 0.05);
    upsertCostTracking("proj_abc", "2026-03-26", "sonnet", {
      input: 2000, output: 300, cache_read: 0, cache_write: 0,
    }, 0.02);

    const rows = getCostByProject("proj_abc");
    expect(rows).toHaveLength(2);
  });

  it("keeps different dates separate", () => {
    upsertCostTracking("proj_abc", "2026-03-25", "opus", {
      input: 1000, output: 0, cache_read: 0, cache_write: 0,
    }, 0.01);
    upsertCostTracking("proj_abc", "2026-03-26", "opus", {
      input: 2000, output: 0, cache_read: 0, cache_write: 0,
    }, 0.02);

    const rows = getCostByProject("proj_abc");
    expect(rows).toHaveLength(2);
    // Ordered by date DESC
    expect(rows[0].date).toBe("2026-03-26");
    expect(rows[1].date).toBe("2026-03-25");
  });

  it("returns empty for unknown project", () => {
    expect(getCostByProject("nonexistent")).toEqual([]);
  });

  it("getCostToday filters to current date", () => {
    const today = new Date().toISOString().split("T")[0];
    upsertCostTracking("proj_abc", today, "opus", {
      input: 1000, output: 0, cache_read: 0, cache_write: 0,
    }, 0.01);
    upsertCostTracking("proj_abc", "2020-01-01", "opus", {
      input: 5000, output: 0, cache_read: 0, cache_write: 0,
    }, 0.10);

    const rows = getCostToday();
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe(today);
  });
});
