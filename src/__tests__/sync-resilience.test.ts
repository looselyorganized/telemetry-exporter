import { describe, test, expect } from "bun:test";
import { mock } from "bun:test";

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({}),
}));

// Import after mock so initSupabase uses our mock createClient
const { withRetry, initSupabase } = await import("../db/client");

initSupabase("http://fake", "fake-key");

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

