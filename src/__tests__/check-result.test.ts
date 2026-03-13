import { describe, test, expect, beforeEach } from "bun:test";
import { checkResult } from "../db/check-result";
import { getActiveErrors, clearErrors } from "../errors";

beforeEach(() => {
  clearErrors();
});

describe("checkResult", () => {
  test("returns true when no error", () => {
    const ok = checkResult(
      { error: null, status: 200 },
      { operation: "test", category: "event_write" }
    );
    expect(ok).toBe(true);
    expect(getActiveErrors()).toHaveLength(0);
  });

  test("returns false and reports error on failure", () => {
    const ok = checkResult(
      { error: { message: "FK violation" }, status: 409 },
      { operation: "insertEvents", category: "event_write", entity: { projId: "proj_abc" } }
    );
    expect(ok).toBe(false);
    const errors = getActiveErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].category).toBe("event_write");
    expect(errors[0].message).toContain("insertEvents");
  });

  test("uses supabase_transient category for 5xx errors", () => {
    checkResult(
      { error: { message: "bad gateway" }, status: 502 },
      { operation: "upsertProject", category: "project_registration" }
    );
    const errors = getActiveErrors();
    expect(errors[0].category).toBe("supabase_transient");
  });

  test("passes entity context to error report", () => {
    checkResult(
      { error: { message: "fail" } },
      { operation: "test", category: "event_write", entity: { batchStart: 0 } }
    );
    const errors = getActiveErrors();
    expect(errors[0].sampleContext).toEqual({ batchStart: 0 });
  });

  test("handles missing status (defaults to non-5xx)", () => {
    checkResult(
      { error: { message: "constraint error" } },
      { operation: "test", category: "metrics_sync" }
    );
    const errors = getActiveErrors();
    expect(errors[0].category).toBe("metrics_sync");
  });
});
