import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { initLocal, closeLocal, getLocal, upsertCostTracking } from "../../db/local";
import { startOtlpServer, stopOtlpServer } from "../server";

const TEST_DB_PATH = "/tmp/lo-test-cost-api.db";
const TEST_PORT = 14319; // Different from server.test.ts port
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function deleteTestFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

beforeAll(() => {
  deleteTestFiles();
  initLocal(TEST_DB_PATH);
  startOtlpServer({ port: TEST_PORT });
});

afterAll(() => {
  stopOtlpServer();
  closeLocal();
  deleteTestFiles();
});

beforeEach(() => {
  getLocal().run("DELETE FROM cost_tracking");
});

describe("GET /cost/today", () => {
  test("returns empty array when no data", async () => {
    const res = await fetch(`${BASE_URL}/cost/today`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("returns today's cost data", async () => {
    const today = new Date().toISOString().split("T")[0];
    upsertCostTracking("proj_abc", today, "claude-opus-4-6", {
      input: 1000, output: 500, cache_read: 5000, cache_write: 200,
    }, 0.05);

    const res = await fetch(`${BASE_URL}/cost/today`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].proj_id).toBe("proj_abc");
    expect(data[0].input_tokens).toBe(1000);
    expect(data[0].cost_usd).toBeCloseTo(0.05);
  });

  test("excludes non-today data", async () => {
    const today = new Date().toISOString().split("T")[0];
    upsertCostTracking("proj_abc", today, "opus", { input: 100, output: 0, cache_read: 0, cache_write: 0 }, 0.01);
    upsertCostTracking("proj_abc", "2020-01-01", "opus", { input: 9999, output: 0, cache_read: 0, cache_write: 0 }, 0.99);

    const res = await fetch(`${BASE_URL}/cost/today`);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].input_tokens).toBe(100);
  });
});

describe("GET /cost/:projId", () => {
  test("returns cost data for a project", async () => {
    upsertCostTracking("proj_abc", "2026-03-26", "opus", {
      input: 1000, output: 500, cache_read: 5000, cache_write: 200,
    }, 0.05);
    upsertCostTracking("proj_abc", "2026-03-25", "opus", {
      input: 800, output: 300, cache_read: 3000, cache_write: 100,
    }, 0.03);

    const res = await fetch(`${BASE_URL}/cost/proj_abc`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    // Ordered by date DESC
    expect(data[0].date).toBe("2026-03-26");
    expect(data[1].date).toBe("2026-03-25");
  });

  test("returns empty array for unknown project", async () => {
    const res = await fetch(`${BASE_URL}/cost/proj_nonexistent`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("does not return other projects' data", async () => {
    upsertCostTracking("proj_abc", "2026-03-26", "opus", { input: 100, output: 0, cache_read: 0, cache_write: 0 }, 0.01);
    upsertCostTracking("proj_xyz", "2026-03-26", "opus", { input: 999, output: 0, cache_read: 0, cache_write: 0 }, 0.99);

    const res = await fetch(`${BASE_URL}/cost/proj_abc`);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].proj_id).toBe("proj_abc");
  });
});

describe("GET /budget/:projId", () => {
  test("returns cost data with null thresholds (placeholder)", async () => {
    upsertCostTracking("proj_abc", "2026-03-26", "opus", { input: 100, output: 0, cache_read: 0, cache_write: 0 }, 0.01);

    const res = await fetch(`${BASE_URL}/budget/proj_abc`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project).toBe("proj_abc");
    expect(data.costs).toHaveLength(1);
    expect(data.thresholds).toBeNull();
  });
});

describe("error handling", () => {
  test("returns 404 for unknown GET path", async () => {
    const res = await fetch(`${BASE_URL}/unknown`);
    expect(res.status).toBe(404);
  });

  test("OTLP POST still works alongside cost API", async () => {
    const res = await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });
});
