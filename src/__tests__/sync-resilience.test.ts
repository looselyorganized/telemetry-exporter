import { describe, test, expect, beforeEach } from "bun:test";
import { mock } from "bun:test";

// ─── Mock Supabase client (queue-based) ─────────────────────────────────────

type MockResult = { data: any; error: any; status?: number };
const resultQueue: MockResult[] = [];

/**
 * Creates a Proxy-based chainable mock that mimics the Supabase PostgREST
 * builder pattern. Any method call returns a new chain; `await` resolves
 * to the next result in the queue.
 */
function createChain(): any {
  return new Proxy(
    {},
    {
      get(_, prop: string) {
        if (prop === "then") {
          const result = resultQueue.shift() ?? { data: null, error: null };
          return (resolve: any, reject?: any) =>
            Promise.resolve(result).then(resolve, reject);
        }
        // All other methods (.upsert, .select, .single, .eq, etc.) return a new chain
        return (..._args: any[]) => createChain();
      },
    }
  );
}

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => createChain() }),
}));

// Import after mock so initSupabase uses our mock createClient
const { withRetry, initSupabase } = await import("../db/client");
const { insertEvents } = await import("../db/events");
const { upsertProject } = await import("../db/projects");

initSupabase("http://fake", "fake-key");

beforeEach(() => {
  resultQueue.length = 0;
});

// ─── withRetry ──────────────────────────────────────────────────────────────

describe("withRetry", () => {
  test("returns immediately on success", async () => {
    let calls = 0;
    const op = () => {
      calls++;
      return Promise.resolve({ data: "ok", error: null, status: 200 });
    };
    const result = await withRetry(op, "test", 2);
    expect(calls).toBe(1);
    expect(result).toEqual({ data: "ok", error: null, status: 200 });
  });

  test("returns immediately on 4xx error (not retryable)", async () => {
    let calls = 0;
    const op = () => {
      calls++;
      return Promise.resolve({
        data: null,
        error: { message: "not found" },
        status: 404,
      });
    };
    const result = await withRetry(op, "test", 2);
    expect(calls).toBe(1);
    expect(result.error.message).toBe("not found");
  });

  test("returns immediately when error has no status (FK violation)", async () => {
    let calls = 0;
    const op = () => {
      calls++;
      return Promise.resolve({
        data: null,
        error: { message: "FK constraint" },
        // no status field — defaults to 0, which is < 500
      });
    };
    const result = await withRetry(op, "test", 2);
    expect(calls).toBe(1);
    expect(result.error.message).toBe("FK constraint");
  });

  test("retries on 5xx and returns success on next attempt", async () => {
    let calls = 0;
    const op = () => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          data: null,
          error: { message: "bad gateway" },
          status: 502,
        });
      }
      return Promise.resolve({ data: "recovered", error: null, status: 200 });
    };
    // maxRetries=1: loop runs attempt=0 (5xx), then attempt=1 (success)
    const result = await withRetry(op, "test", 1);
    expect(calls).toBe(2);
    expect(result.data).toBe("recovered");
    expect(result.error).toBeNull();
  });

  test("returns last error after exhausting all retries (no extra call)", async () => {
    let calls = 0;
    const op = () => {
      calls++;
      return Promise.resolve({
        data: null,
        error: { message: "always fails" },
        status: 500,
      });
    };
    // maxRetries=0: loop runs once (attempt=0), returns last result — no extra op() call
    const result = await withRetry(op, "test", 0);
    expect(calls).toBe(1);
    expect(result.error.message).toBe("always fails");
  });

  test("does not retry when there is no error", async () => {
    let calls = 0;
    const op = () => {
      calls++;
      return Promise.resolve({ data: null, error: null, status: 500 });
    };
    // No error means no retry, even with 5xx status
    const result = await withRetry(op, "test", 2);
    expect(calls).toBe(1);
    expect(result.error).toBeNull();
  });
});

// ─── insertEvents (per-row fallback) ────────────────────────────────────────

describe("insertEvents", () => {
  function makeEntry(project: string, eventType: string, i: number) {
    return {
      timestamp: `3/1 10:0${i} AM`,
      parsedTimestamp: new Date(`2026-03-01T10:0${i}:00`),
      project,
      branch: "main",
      emoji: "🔧",
      eventType,
      eventText: `event-${i}`,
    };
  }

  test("batch success counts all rows as inserted", async () => {
    const entries = [
      makeEntry("proj-a", "tool_call", 0),
      makeEntry("proj-a", "tool_call", 1),
      makeEntry("proj-b", "session_start", 2),
    ];

    // Single batch upsert succeeds
    resultQueue.push({ data: null, error: null, status: 200 });

    const result = await insertEvents(entries);
    expect(result.inserted).toBe(3);
    expect(result.errors).toBe(0);
    expect(result.insertedByProject["proj-a"]).toBe(2);
    expect(result.insertedByProject["proj-b"]).toBe(1);
  });

  test("batch failure triggers per-row fallback with mixed results", async () => {
    const entries = [
      makeEntry("proj-a", "tool_call", 0),
      makeEntry("bad-proj", "tool_call", 1),
      makeEntry("proj-a", "session_start", 2),
    ];

    // Batch upsert fails (FK violation, 409 — not retryable by withRetry)
    resultQueue.push({
      data: null,
      error: { message: "FK constraint violation" },
      status: 409,
    });
    // Per-row fallback: row 0 OK, row 1 FK error, row 2 OK
    resultQueue.push({ data: null, error: null });
    resultQueue.push({
      data: null,
      error: { message: "FK: bad-proj not in projects" },
    });
    resultQueue.push({ data: null, error: null });

    const result = await insertEvents(entries);
    expect(result.inserted).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.insertedByProject["proj-a"]).toBe(2);
    expect(result.insertedByProject["bad-proj"]).toBeUndefined();
  });

  test("per-row fallback recovers all rows when only batch constraint fails", async () => {
    const entries = [
      makeEntry("proj-a", "tool_call", 0),
      makeEntry("proj-b", "tool_call", 1),
    ];

    // Batch fails
    resultQueue.push({
      data: null,
      error: { message: "batch error" },
      status: 409,
    });
    // Both per-row upserts succeed
    resultQueue.push({ data: null, error: null });
    resultQueue.push({ data: null, error: null });

    const result = await insertEvents(entries);
    expect(result.inserted).toBe(2);
    expect(result.errors).toBe(0);
  });

  test("returns empty result for no entries", async () => {
    const result = await insertEvents([]);
    expect(result.inserted).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.insertedByProject).toEqual({});
  });

  test("filters out entries without parsedTimestamp", async () => {
    const entries = [
      makeEntry("proj-a", "tool_call", 0),
      {
        ...makeEntry("proj-a", "tool_call", 1),
        parsedTimestamp: null as any,
      },
    ];

    resultQueue.push({ data: null, error: null, status: 200 });

    const result = await insertEvents(entries);
    expect(result.inserted).toBe(1);
  });
});

// ─── upsertProject (boolean return) ─────────────────────────────────────────

describe("upsertProject", () => {
  test("returns true on successful upsert", async () => {
    // Upsert succeeds
    resultQueue.push({ data: null, error: null });

    const ok = await upsertProject("proj_test", "test");
    expect(ok).toBe(true);
  });

  test("returns true when upsert fails but fallback update succeeds", async () => {
    // Initial upsert fails
    resultQueue.push({
      data: null,
      error: { message: "conflict on upsert" },
    });
    // Fallback update succeeds
    resultQueue.push({
      data: null,
      error: null,
    });

    const ok = await upsertProject("proj_test", "test");
    expect(ok).toBe(true);
  });

  test("returns false when both upsert and fallback update fail", async () => {
    // Initial upsert fails
    resultQueue.push({
      data: null,
      error: { message: "upsert failed" },
    });
    // Fallback update also fails
    resultQueue.push({
      data: null,
      error: { message: "update also failed" },
    });

    const ok = await upsertProject("proj_test", "test");
    expect(ok).toBe(false);
  });
});
