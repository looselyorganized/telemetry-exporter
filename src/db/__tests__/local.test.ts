import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { Database } from "bun:sqlite";
import { initLocal, getLocal, closeLocal, enqueue, purgeFailed } from "../local";

const TEST_DB_PATH = "/tmp/lo-test-outbox.db";

function deleteTestFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

beforeEach(() => {
  deleteTestFiles();
});

afterEach(() => {
  closeLocal();
  deleteTestFiles();
});

describe("initLocal", () => {
  it("creates database file", () => {
    initLocal(TEST_DB_PATH);
    expect(existsSync(TEST_DB_PATH)).toBe(true);
  });

  it("enables WAL mode", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });

  it("creates outbox table", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='outbox'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("outbox");
  });

  it("creates cursors table", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cursors'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("cursors");
  });

  it("creates known_projects table", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='known_projects'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("known_projects");
  });

  it("creates archive_queue table", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='archive_queue'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("archive_queue");
  });

  it("is idempotent (safe to call twice)", () => {
    initLocal(TEST_DB_PATH);
    expect(() => initLocal(TEST_DB_PATH)).not.toThrow();
    const db = getLocal();
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('outbox','cursors','known_projects','archive_queue')")
      .all() as { name: string }[];
    expect(rows).toHaveLength(4);
  });
});

describe("getLocal", () => {
  it("throws if not initialized", () => {
    expect(() => getLocal()).toThrow();
  });

  it("returns a Database instance after init", () => {
    initLocal(TEST_DB_PATH);
    expect(getLocal()).toBeInstanceOf(Database);
  });
});

describe("closeLocal", () => {
  it("allows re-initialization after close", () => {
    initLocal(TEST_DB_PATH);
    closeLocal();
    expect(() => initLocal(TEST_DB_PATH)).not.toThrow();
    expect(existsSync(TEST_DB_PATH)).toBe(true);
  });

  it("causes getLocal to throw after close", () => {
    initLocal(TEST_DB_PATH);
    closeLocal();
    expect(() => getLocal()).toThrow();
  });
});

import {
  enqueue,
  dequeueUnshipped,
  markShipped,
  markFailed,
  markTransientError,
  type OutboxRow,
  getCursor,
  setCursor,
  type CursorRow,
  enqueueArchive,
  dequeueUnshippedArchive,
  markArchiveShipped,
  type ArchiveRow,
  addKnownProject,
  getKnownProjectIds,
  isKnownProject,
  pruneShipped,
  pruneShippedArchive,
  outboxDepth,
  archiveDepth,
} from "../local";

describe("enqueue", () => {
  it("inserts a row with status pending", () => {
    initLocal(TEST_DB_PATH);
    enqueue("supabase/events", { foo: "bar" });
    const db = getLocal();
    const row = db.query("SELECT * FROM outbox WHERE id = 1").get() as OutboxRow;
    expect(row).not.toBeNull();
    expect(row.status).toBe("pending");
    expect(row.target).toBe("supabase/events");
  });

  it("stores payload as JSON string", () => {
    initLocal(TEST_DB_PATH);
    enqueue("supabase/events", { hello: "world", n: 42 });
    const db = getLocal();
    const row = db.query("SELECT payload FROM outbox WHERE id = 1").get() as { payload: string };
    expect(() => JSON.parse(row.payload)).not.toThrow();
    const parsed = JSON.parse(row.payload);
    expect(parsed).toEqual({ hello: "world", n: 42 });
  });

  it("stores created_at as ISO 8601", () => {
    initLocal(TEST_DB_PATH);
    enqueue("supabase/events", {});
    const db = getLocal();
    const row = db.query("SELECT created_at FROM outbox WHERE id = 1").get() as { created_at: string };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(row.created_at).getTime()).not.toBeNaN();
  });

  it("initializes retry_count to 0", () => {
    initLocal(TEST_DB_PATH);
    enqueue("supabase/events", {});
    const db = getLocal();
    const row = db.query("SELECT retry_count FROM outbox WHERE id = 1").get() as { retry_count: number };
    expect(row.retry_count).toBe(0);
  });

  it("returns the new row id", () => {
    initLocal(TEST_DB_PATH);
    const id1 = enqueue("t1", {});
    const id2 = enqueue("t2", {});
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });
});

describe("dequeueUnshipped", () => {
  it("returns pending rows ordered by id", () => {
    initLocal(TEST_DB_PATH);
    enqueue("t1", { a: 1 });
    enqueue("t2", { b: 2 });
    enqueue("t3", { c: 3 });
    const rows = dequeueUnshipped(10);
    expect(rows).toHaveLength(3);
    expect(rows[0].target).toBe("t1");
    expect(rows[1].target).toBe("t2");
    expect(rows[2].target).toBe("t3");
  });

  it("respects the limit parameter", () => {
    initLocal(TEST_DB_PATH);
    enqueue("t1", {});
    enqueue("t2", {});
    enqueue("t3", {});
    const rows = dequeueUnshipped(2);
    expect(rows).toHaveLength(2);
  });

  it("excludes shipped rows", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    enqueue("t2", {});
    markShipped([id]);
    const rows = dequeueUnshipped(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe("t2");
  });

  it("excludes failed rows", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    enqueue("t2", {});
    markFailed([id], "permanent error");
    const rows = dequeueUnshipped(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe("t2");
  });

  it("skips rows within their backoff window", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    // Set last_error_at to now and retry_count=1 — backoff window is 2^1=2s, not yet elapsed
    const db = getLocal();
    db.query("UPDATE outbox SET retry_count = 1, last_error_at = datetime('now') WHERE id = ?").run(id);
    const rows = dequeueUnshipped(10);
    expect(rows).toHaveLength(0);
  });

  it("includes rows whose backoff window has elapsed", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    // Set last_error_at to 10s ago with retry_count=1 — backoff is 2^1=2s, already elapsed
    const db = getLocal();
    db.query("UPDATE outbox SET retry_count = 1, last_error_at = datetime('now', '-10 seconds') WHERE id = ?").run(id);
    const rows = dequeueUnshipped(10);
    expect(rows).toHaveLength(1);
  });

  it("returns all fields as OutboxRow", () => {
    initLocal(TEST_DB_PATH);
    enqueue("supabase/events", { x: 1 });
    const rows = dequeueUnshipped(1);
    const row = rows[0];
    expect(typeof row.id).toBe("number");
    expect(typeof row.target).toBe("string");
    expect(typeof row.payload).toBe("string");
    expect(typeof row.status).toBe("string");
    expect(typeof row.created_at).toBe("string");
    expect(row.shipped_at).toBeNull();
    expect(row.error).toBeNull();
    expect(typeof row.retry_count).toBe("number");
    expect(row.last_error_at).toBeNull();
  });
});

describe("markShipped", () => {
  it("sets status to shipped", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    markShipped([id]);
    const db = getLocal();
    const row = db.query("SELECT status FROM outbox WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("shipped");
  });

  it("sets shipped_at to a non-null ISO 8601 timestamp", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    markShipped([id]);
    const db = getLocal();
    const row = db.query("SELECT shipped_at FROM outbox WHERE id = ?").get(id) as { shipped_at: string | null };
    expect(row.shipped_at).not.toBeNull();
    expect(new Date(row.shipped_at!).getTime()).not.toBeNaN();
  });

  it("handles multiple ids at once", () => {
    initLocal(TEST_DB_PATH);
    const id1 = enqueue("t1", {});
    const id2 = enqueue("t2", {});
    markShipped([id1, id2]);
    const db = getLocal();
    const rows = db.query("SELECT status FROM outbox WHERE id IN (?, ?)").all(id1, id2) as { status: string }[];
    expect(rows.every(r => r.status === "shipped")).toBe(true);
  });

  it("is a no-op for empty array", () => {
    initLocal(TEST_DB_PATH);
    expect(() => markShipped([])).not.toThrow();
  });
});

describe("markFailed", () => {
  it("sets status to failed", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    markFailed([id], "fatal error");
    const db = getLocal();
    const row = db.query("SELECT status FROM outbox WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("failed");
  });

  it("records the error message", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    markFailed([id], "fatal error");
    const db = getLocal();
    const row = db.query("SELECT error FROM outbox WHERE id = ?").get(id) as { error: string };
    expect(row.error).toBe("fatal error");
  });

  it("handles multiple ids at once", () => {
    initLocal(TEST_DB_PATH);
    const id1 = enqueue("t1", {});
    const id2 = enqueue("t2", {});
    markFailed([id1, id2], "batch failure");
    const db = getLocal();
    const rows = db.query("SELECT status FROM outbox WHERE id IN (?, ?)").all(id1, id2) as { status: string }[];
    expect(rows.every(r => r.status === "failed")).toBe(true);
  });

  it("is a no-op for empty array", () => {
    initLocal(TEST_DB_PATH);
    expect(() => markFailed([], "err")).not.toThrow();
  });
});

describe("markTransientError", () => {
  it("increments retry_count", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    markTransientError([id], "transient");
    const db = getLocal();
    const row = db.query("SELECT retry_count FROM outbox WHERE id = ?").get(id) as { retry_count: number };
    expect(row.retry_count).toBe(1);
  });

  it("sets error message", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    markTransientError([id], "network timeout");
    const db = getLocal();
    const row = db.query("SELECT error FROM outbox WHERE id = ?").get(id) as { error: string };
    expect(row.error).toBe("network timeout");
  });

  it("sets last_error_at to a non-null ISO 8601 timestamp", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    markTransientError([id], "oops");
    const db = getLocal();
    const row = db.query("SELECT last_error_at FROM outbox WHERE id = ?").get(id) as { last_error_at: string | null };
    expect(row.last_error_at).not.toBeNull();
    expect(new Date(row.last_error_at!).getTime()).not.toBeNaN();
  });

  it("keeps status as pending for retries below 10", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    for (let i = 0; i < 9; i++) {
      markTransientError([id], "retry");
    }
    const db = getLocal();
    const row = db.query("SELECT status, retry_count FROM outbox WHERE id = ?").get(id) as { status: string; retry_count: number };
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(9);
  });

  it("marks failed after 10 retries", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    for (let i = 0; i < 10; i++) {
      markTransientError([id], "retry");
    }
    const db = getLocal();
    const row = db.query("SELECT status, retry_count FROM outbox WHERE id = ?").get(id) as { status: string; retry_count: number };
    expect(row.status).toBe("failed");
    expect(row.retry_count).toBe(10);
  });

  it("is a no-op for empty array", () => {
    initLocal(TEST_DB_PATH);
    expect(() => markTransientError([], "err")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cursor operations
// ---------------------------------------------------------------------------

describe("getCursor", () => {
  it("returns null for unknown source", () => {
    initLocal(TEST_DB_PATH);
    const result = getCursor("events.log");
    expect(result).toBeNull();
  });
});

describe("setCursor / getCursor", () => {
  it("creates a cursor and getCursor retrieves it", () => {
    initLocal(TEST_DB_PATH);
    setCursor("events.log", 42, "abc123");
    const row = getCursor("events.log");
    expect(row).not.toBeNull();
    expect(row!.offset).toBe(42);
    expect(row!.checksum).toBe("abc123");
    expect(row!.source).toBe("events.log");
  });

  it("stores null checksum", () => {
    initLocal(TEST_DB_PATH);
    setCursor("events.log", 0, null);
    const row = getCursor("events.log");
    expect(row!.checksum).toBeNull();
  });

  it("updates existing cursor on second call", () => {
    initLocal(TEST_DB_PATH);
    setCursor("events.log", 10, "first");
    setCursor("events.log", 99, "second");
    const row = getCursor("events.log");
    expect(row!.offset).toBe(99);
    expect(row!.checksum).toBe("second");
  });

  it("updated_at is set on create", () => {
    initLocal(TEST_DB_PATH);
    setCursor("events.log", 1, null);
    const row = getCursor("events.log");
    expect(row!.updated_at).toBeTruthy();
    expect(new Date(row!.updated_at).getTime()).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Archive queue operations
// ---------------------------------------------------------------------------

describe("enqueueArchive", () => {
  it("inserts a row into archive_queue", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("token_usage", JSON.stringify({ tokens: 100 }), "hash1");
    const db = getLocal();
    const row = db.query("SELECT * FROM archive_queue WHERE content_hash = 'hash1'").get() as ArchiveRow | null;
    expect(row).not.toBeNull();
    expect(row!.fact_type).toBe("token_usage");
  });

  it("ignores duplicate content_hash (INSERT OR IGNORE)", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("token_usage", JSON.stringify({ tokens: 100 }), "hash1");
    enqueueArchive("token_usage", JSON.stringify({ tokens: 999 }), "hash1");
    const db = getLocal();
    const rows = db.query("SELECT * FROM archive_queue WHERE content_hash = 'hash1'").all() as ArchiveRow[];
    expect(rows).toHaveLength(1);
    // Original payload should remain
    const parsed = JSON.parse(rows[0].payload);
    expect(parsed.tokens).toBe(100);
  });
});

describe("dequeueUnshippedArchive", () => {
  it("returns unshipped rows ordered by id", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("type_a", "{}", "h1");
    enqueueArchive("type_b", "{}", "h2");
    enqueueArchive("type_c", "{}", "h3");
    const rows = dequeueUnshippedArchive(10);
    expect(rows).toHaveLength(3);
    expect(rows[0].fact_type).toBe("type_a");
    expect(rows[1].fact_type).toBe("type_b");
    expect(rows[2].fact_type).toBe("type_c");
  });

  it("respects limit", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("type_a", "{}", "h1");
    enqueueArchive("type_b", "{}", "h2");
    enqueueArchive("type_c", "{}", "h3");
    const rows = dequeueUnshippedArchive(2);
    expect(rows).toHaveLength(2);
  });

  it("excludes shipped rows", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("type_a", "{}", "h1");
    enqueueArchive("type_b", "{}", "h2");
    const allRows = dequeueUnshippedArchive(10);
    markArchiveShipped([allRows[0].id]);
    const remaining = dequeueUnshippedArchive(10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].fact_type).toBe("type_b");
  });
});

describe("markArchiveShipped", () => {
  it("sets shipped_at on the row", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("type_a", "{}", "h1");
    const rows = dequeueUnshippedArchive(10);
    markArchiveShipped([rows[0].id]);
    const db = getLocal();
    const row = db.query("SELECT shipped_at FROM archive_queue WHERE id = ?").get(rows[0].id) as { shipped_at: string | null };
    expect(row.shipped_at).not.toBeNull();
    expect(new Date(row.shipped_at!).getTime()).not.toBeNaN();
  });

  it("row no longer appears in dequeueUnshippedArchive after markArchiveShipped", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("type_a", "{}", "h1");
    const before = dequeueUnshippedArchive(10);
    expect(before).toHaveLength(1);
    markArchiveShipped([before[0].id]);
    const after = dequeueUnshippedArchive(10);
    expect(after).toHaveLength(0);
  });

  it("handles multiple ids", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("type_a", "{}", "h1");
    enqueueArchive("type_b", "{}", "h2");
    const rows = dequeueUnshippedArchive(10);
    markArchiveShipped(rows.map(r => r.id));
    const after = dequeueUnshippedArchive(10);
    expect(after).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Known projects operations
// ---------------------------------------------------------------------------

describe("addKnownProject / isKnownProject", () => {
  it("addKnownProject and isKnownProject work together", () => {
    initLocal(TEST_DB_PATH);
    addKnownProject("proj_abc123", "my-project");
    expect(isKnownProject("proj_abc123")).toBe(true);
  });

  it("isKnownProject returns false for unknown project", () => {
    initLocal(TEST_DB_PATH);
    expect(isKnownProject("proj_does_not_exist")).toBe(false);
  });

  it("addKnownProject is idempotent (INSERT OR IGNORE)", () => {
    initLocal(TEST_DB_PATH);
    addKnownProject("proj_abc123", "my-project");
    expect(() => addKnownProject("proj_abc123", "my-project")).not.toThrow();
    expect(isKnownProject("proj_abc123")).toBe(true);
  });
});

describe("getKnownProjectIds", () => {
  it("returns empty array when no projects", () => {
    initLocal(TEST_DB_PATH);
    expect(getKnownProjectIds()).toEqual([]);
  });

  it("returns all proj_ids", () => {
    initLocal(TEST_DB_PATH);
    addKnownProject("proj_aaa", "project-a");
    addKnownProject("proj_bbb", "project-b");
    const ids = getKnownProjectIds();
    expect(ids).toHaveLength(2);
    expect(ids).toContain("proj_aaa");
    expect(ids).toContain("proj_bbb");
  });

  it("returns only proj_id strings (not full rows)", () => {
    initLocal(TEST_DB_PATH);
    addKnownProject("proj_xyz", "xyz-project");
    const ids = getKnownProjectIds();
    expect(typeof ids[0]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Prune operations
// ---------------------------------------------------------------------------

describe("pruneShipped", () => {
  it("deletes old shipped rows and returns count", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    const id = enqueue("t1", {});
    // Manually set shipped_at to 10 days ago
    db.query("UPDATE outbox SET status = 'shipped', shipped_at = datetime('now', '-10 days') WHERE id = ?").run(id);
    const deleted = pruneShipped(7);
    expect(deleted).toBe(1);
    const row = db.query("SELECT * FROM outbox WHERE id = ?").get(id);
    expect(row).toBeNull();
  });

  it("keeps pending rows", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    const id = enqueue("t1", {});
    pruneShipped(0);
    const row = db.query("SELECT * FROM outbox WHERE id = ?").get(id);
    expect(row).not.toBeNull();
  });

  it("keeps recently shipped rows", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    const id = enqueue("t1", {});
    // Shipped 1 day ago, pruning threshold is 7 days
    db.query("UPDATE outbox SET status = 'shipped', shipped_at = datetime('now', '-1 day') WHERE id = ?").run(id);
    const deleted = pruneShipped(7);
    expect(deleted).toBe(0);
    const row = db.query("SELECT * FROM outbox WHERE id = ?").get(id);
    expect(row).not.toBeNull();
  });
});

describe("pruneShippedArchive", () => {
  it("deletes old shipped archive rows and returns count", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    enqueueArchive("type_a", "{}", "h1");
    const rows = dequeueUnshippedArchive(10);
    // Manually set shipped_at to 10 days ago
    db.query("UPDATE archive_queue SET shipped_at = datetime('now', '-10 days') WHERE id = ?").run(rows[0].id);
    const deleted = pruneShippedArchive(7);
    expect(deleted).toBe(1);
    const row = db.query("SELECT * FROM archive_queue WHERE id = ?").get(rows[0].id);
    expect(row).toBeNull();
  });

  it("keeps unshipped archive rows", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    enqueueArchive("type_a", "{}", "h1");
    const rows = dequeueUnshippedArchive(10);
    pruneShippedArchive(0);
    const row = db.query("SELECT * FROM archive_queue WHERE id = ?").get(rows[0].id);
    expect(row).not.toBeNull();
  });

  it("keeps recently shipped archive rows", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();
    enqueueArchive("type_a", "{}", "h1");
    const rows = dequeueUnshippedArchive(10);
    db.query("UPDATE archive_queue SET shipped_at = datetime('now', '-1 day') WHERE id = ?").run(rows[0].id);
    const deleted = pruneShippedArchive(7);
    expect(deleted).toBe(0);
  });
});

describe("outboxDepth", () => {
  it("returns 0 when outbox is empty", () => {
    initLocal(TEST_DB_PATH);
    expect(outboxDepth()).toBe(0);
  });

  it("counts pending rows", () => {
    initLocal(TEST_DB_PATH);
    enqueue("t1", {});
    enqueue("t2", {});
    expect(outboxDepth()).toBe(2);
  });

  it("excludes shipped rows", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    enqueue("t2", {});
    markShipped([id]);
    expect(outboxDepth()).toBe(1);
  });

  it("excludes failed rows", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("t1", {});
    enqueue("t2", {});
    markFailed([id], "err");
    expect(outboxDepth()).toBe(1);
  });
});

describe("archiveDepth", () => {
  it("returns 0 when archive_queue is empty", () => {
    initLocal(TEST_DB_PATH);
    expect(archiveDepth()).toBe(0);
  });

  it("counts unshipped archive rows", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("type_a", "{}", "h1");
    enqueueArchive("type_b", "{}", "h2");
    expect(archiveDepth()).toBe(2);
  });

  it("excludes shipped archive rows", () => {
    initLocal(TEST_DB_PATH);
    enqueueArchive("type_a", "{}", "h1");
    enqueueArchive("type_b", "{}", "h2");
    const rows = dequeueUnshippedArchive(10);
    markArchiveShipped([rows[0].id]);
    expect(archiveDepth()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Purge failed rows
// ---------------------------------------------------------------------------

describe("purgeFailed", () => {
  it("deletes failed rows and returns count", () => {
    initLocal(TEST_DB_PATH);

    enqueue("projects", { id: "proj_1" });
    enqueue("projects", { id: "proj_2" });
    enqueue("events", { id: "ev_1" });

    const db = getLocal();
    db.run("UPDATE outbox SET status = 'failed' WHERE id IN (1, 2)");

    const purged = purgeFailed();
    expect(purged).toBe(2);

    const remaining = db.query("SELECT * FROM outbox").all();
    expect(remaining).toHaveLength(1);
  });
});
