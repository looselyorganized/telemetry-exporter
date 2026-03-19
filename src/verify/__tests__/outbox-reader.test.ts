import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import {
  initLocal,
  closeLocal,
  enqueue,
  markShipped,
  markFailed,
  addKnownProject,
  setCursor,
} from "../../db/local";
import { readFromOutbox, readOutboxHealth } from "../outbox-reader";

const TEST_DB_PATH = "/tmp/lo-test-outbox-reader.db";

function deleteTestFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

beforeEach(() => {
  deleteTestFiles();
});

afterEach(() => {
  closeLocal();
  deleteTestFiles();
});

// ─── readFromOutbox ──────────────────────────────────────────────────────────

describe("readFromOutbox — DB does not exist", () => {
  it("returns available=false with descriptive message", () => {
    const result = readFromOutbox("/tmp/no-such-db-outbox-reader-test.db");
    expect(result.available).toBe(false);
    expect(result.status).toMatch(/not found|hasn't run/i);
    expect(result.events).toEqual({});
    expect(result.tokens).toEqual({});
    expect(result.projects).toEqual([]);
    expect(result.dailyMetrics).toEqual([]);
  });
});

describe("readFromOutbox — empty DB", () => {
  it("returns available=true with empty data", () => {
    initLocal(TEST_DB_PATH);
    const result = readFromOutbox(TEST_DB_PATH);
    expect(result.available).toBe(true);
    expect(result.events).toEqual({});
    expect(result.tokens).toEqual({});
    expect(result.projects).toEqual([]);
    expect(result.dailyMetrics).toEqual([]);
  });
});

describe("readFromOutbox — event counts by project", () => {
  it("groups event rows by project_id extracted from payload", () => {
    initLocal(TEST_DB_PATH);
    enqueue("events", { project_id: "proj_aaa", event_type: "tool_call" });
    enqueue("events", { project_id: "proj_aaa", event_type: "tool_call" });
    enqueue("events", { project_id: "proj_bbb", event_type: "session_start" });

    const result = readFromOutbox(TEST_DB_PATH);
    expect(result.events["proj_aaa"]).toBe(2);
    expect(result.events["proj_bbb"]).toBe(1);
  });

  it("counts only rows with target='events'", () => {
    initLocal(TEST_DB_PATH);
    enqueue("events", { project_id: "proj_aaa" });
    enqueue("project_telemetry", { project_id: "proj_aaa", tokens_lifetime: 1000 });

    const result = readFromOutbox(TEST_DB_PATH);
    // Only 1 events row, not 2
    expect(result.events["proj_aaa"]).toBe(1);
  });

  it("ignores events rows with null project_id", () => {
    initLocal(TEST_DB_PATH);
    enqueue("events", { event_type: "global_event" }); // no project_id
    enqueue("events", { project_id: "proj_aaa", event_type: "tool_call" });

    const result = readFromOutbox(TEST_DB_PATH);
    expect(Object.keys(result.events)).toEqual(["proj_aaa"]);
    expect(result.events["proj_aaa"]).toBe(1);
  });
});

describe("readFromOutbox — token totals", () => {
  it("returns tokens_lifetime from latest project_telemetry row per project", () => {
    initLocal(TEST_DB_PATH);
    // Two rows for proj_aaa: second (higher id) should win
    enqueue("project_telemetry", { project_id: "proj_aaa", tokens_lifetime: 1000 });
    enqueue("project_telemetry", { project_id: "proj_aaa", tokens_lifetime: 2500 });
    enqueue("project_telemetry", { project_id: "proj_bbb", tokens_lifetime: 500 });

    const result = readFromOutbox(TEST_DB_PATH);
    expect(result.tokens["proj_aaa"]).toBe(2500);
    expect(result.tokens["proj_bbb"]).toBe(500);
  });

  it("ignores non-project_telemetry rows for token totals", () => {
    initLocal(TEST_DB_PATH);
    enqueue("events", { project_id: "proj_aaa", tokens_lifetime: 9999 });
    enqueue("project_telemetry", { project_id: "proj_aaa", tokens_lifetime: 100 });

    const result = readFromOutbox(TEST_DB_PATH);
    expect(result.tokens["proj_aaa"]).toBe(100);
  });
});

describe("readFromOutbox — known projects", () => {
  it("returns all known projects with id and slug", () => {
    initLocal(TEST_DB_PATH);
    addKnownProject("proj_aaa", "project-alpha");
    addKnownProject("proj_bbb", "project-beta");

    const result = readFromOutbox(TEST_DB_PATH);
    expect(result.projects).toHaveLength(2);
    const ids = result.projects.map((p) => p.id);
    expect(ids).toContain("proj_aaa");
    expect(ids).toContain("proj_bbb");
    const alpha = result.projects.find((p) => p.id === "proj_aaa");
    expect(alpha?.slug).toBe("project-alpha");
  });

  it("returns empty array when no known projects", () => {
    initLocal(TEST_DB_PATH);
    const result = readFromOutbox(TEST_DB_PATH);
    expect(result.projects).toEqual([]);
  });
});

// ─── readOutboxHealth ────────────────────────────────────────────────────────

describe("readOutboxHealth — depth counts", () => {
  it("returns zero counts for empty outbox", () => {
    initLocal(TEST_DB_PATH);
    const health = readOutboxHealth(TEST_DB_PATH);
    expect(health.depth.pending).toBe(0);
    expect(health.depth.shipped).toBe(0);
    expect(health.depth.failed).toBe(0);
  });

  it("counts pending, shipped, and failed rows correctly", () => {
    initLocal(TEST_DB_PATH);
    const id1 = enqueue("events", { project_id: "proj_aaa" });
    const id2 = enqueue("events", { project_id: "proj_bbb" });
    const id3 = enqueue("events", { project_id: "proj_ccc" });
    const id4 = enqueue("events", { project_id: "proj_ddd" });

    markShipped([id1, id2]);
    markFailed([id3], "permanent error");
    // id4 stays pending

    const health = readOutboxHealth(TEST_DB_PATH);
    expect(health.depth.pending).toBe(1);
    expect(health.depth.shipped).toBe(2);
    expect(health.depth.failed).toBe(1);
  });

  it("provides per-target breakdown", () => {
    initLocal(TEST_DB_PATH);
    enqueue("events", { project_id: "proj_aaa" });
    enqueue("events", { project_id: "proj_bbb" });
    const id3 = enqueue("project_telemetry", { project_id: "proj_aaa" });
    markShipped([id3]);

    const health = readOutboxHealth(TEST_DB_PATH);
    expect(health.byTarget["events"].pending).toBe(2);
    expect(health.byTarget["events"].shipped).toBe(0);
    expect(health.byTarget["project_telemetry"].pending).toBe(0);
    expect(health.byTarget["project_telemetry"].shipped).toBe(1);
  });
});

describe("readOutboxHealth — failed rows", () => {
  it("returns failed rows with id, target, error, retryCount, createdAt", () => {
    initLocal(TEST_DB_PATH);
    const id = enqueue("events", { project_id: "proj_aaa" });
    markFailed([id], "schema mismatch");

    const health = readOutboxHealth(TEST_DB_PATH);
    expect(health.failedRows).toHaveLength(1);
    const row = health.failedRows[0];
    expect(row.id).toBe(id);
    expect(row.target).toBe("events");
    expect(row.error).toBe("schema mismatch");
    expect(typeof row.retryCount).toBe("number");
    expect(typeof row.createdAt).toBe("string");
  });

  it("returns empty array when no failed rows", () => {
    initLocal(TEST_DB_PATH);
    enqueue("events", { project_id: "proj_aaa" });
    const health = readOutboxHealth(TEST_DB_PATH);
    expect(health.failedRows).toEqual([]);
  });
});

describe("readOutboxHealth — cursors", () => {
  it("returns cursor state by source", () => {
    initLocal(TEST_DB_PATH);
    setCursor("events.log", 1024, "abc123");
    setCursor("projects", 7, null);

    const health = readOutboxHealth(TEST_DB_PATH);
    expect(health.cursors["events.log"]).toBeDefined();
    expect(health.cursors["events.log"].offset).toBe(1024);
    expect(typeof health.cursors["events.log"].updatedAt).toBe("string");
    expect(health.cursors["projects"].offset).toBe(7);
  });

  it("returns empty cursors object when no cursors set", () => {
    initLocal(TEST_DB_PATH);
    const health = readOutboxHealth(TEST_DB_PATH);
    expect(health.cursors).toEqual({});
  });
});

describe("readOutboxHealth — archive", () => {
  it("returns archive pending and shipped counts", () => {
    initLocal(TEST_DB_PATH);
    // archive_queue is separate — just verify the field exists and returns numbers
    const health = readOutboxHealth(TEST_DB_PATH);
    expect(typeof health.archive.pending).toBe("number");
    expect(typeof health.archive.shipped).toBe("number");
    expect(health.archive.pending).toBe(0);
    expect(health.archive.shipped).toBe(0);
  });
});
