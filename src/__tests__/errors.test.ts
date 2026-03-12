import { describe, it, expect, beforeEach, mock } from "bun:test";

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      delete: () => ({
        in: () => Promise.resolve({ data: null, error: null }),
        neq: () => Promise.resolve({ data: null, error: null }),
      }),
      upsert: () => Promise.resolve({ data: null, error: null }),
    }),
  }),
}));

import { reportError, getActiveErrors, clearErrors, type ErrorCategory } from "../errors";
import { pruneResolved } from "../db/errors";
import { initSupabase } from "../db/client";

initSupabase("http://fake", "fake-key");

describe("ErrorReporter", () => {
  beforeEach(() => {
    clearErrors();
  });

  describe("normalization", () => {
    it("normalizes project IDs", () => {
      reportError("event_write", "skipping proj_abc123def (FK error)");
      const errors = getActiveErrors();
      expect(errors[0].id).toBe("event_write:skipping <proj> (FK error)");
    });

    it("normalizes batch ranges", () => {
      reportError("event_write", "batch 0-500 failed");
      const errors = getActiveErrors();
      expect(errors[0].id).toBe("event_write:batch <range> failed");
    });

    it("normalizes token counts like 12.3M", () => {
      reportError("event_write", "wrote 12.3M but DB has 11.9M");
      const errors = getActiveErrors();
      expect(errors[0].id).toBe("event_write:wrote <N> but DB has <N>");
    });

    it("keeps HTTP status codes as-is", () => {
      reportError("supabase_transient", "HTTP 502, retry 2/3");
      const errors = getActiveErrors();
      expect(errors[0].id).toBe("supabase_transient:HTTP 502, retry 2/3");
    });
  });

  describe("deduplication", () => {
    it("increments count for duplicate errors", () => {
      reportError("event_write", "connection refused");
      reportError("event_write", "connection refused");
      reportError("event_write", "connection refused");
      const errors = getActiveErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].count).toBe(3);
    });

    it("deduplicates across variable project IDs", () => {
      reportError("event_write", "skipping proj_aaa (FK error)");
      reportError("event_write", "skipping proj_bbb (FK error)");
      const errors = getActiveErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].count).toBe(2);
      expect(errors[0].message).toBe("skipping proj_aaa (FK error)");
    });

    it("tracks separate errors by category", () => {
      reportError("event_write", "timeout");
      reportError("facility_state", "timeout");
      const errors = getActiveErrors();
      expect(errors).toHaveLength(2);
    });

    it("preserves sample_context from first occurrence", () => {
      reportError("event_write", "batch 0-500 failed", { httpStatus: 502 });
      reportError("event_write", "batch 500-1000 failed", { httpStatus: 503 });
      const errors = getActiveErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].sampleContext).toEqual({ httpStatus: 502 });
    });

    it("updates lastSeen on repeat", () => {
      reportError("event_write", "fail");
      const first = getActiveErrors()[0].lastSeen;
      reportError("event_write", "fail");
      const second = getActiveErrors()[0].lastSeen;
      expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    });
  });

  describe("pruneResolved", () => {
    it("prunes errors older than 5 minutes from memory", async () => {
      reportError("event_write", "old error");
      const errors = getActiveErrors();
      errors[0].lastSeen = new Date(Date.now() - 6 * 60 * 1000);

      const pruned = await pruneResolved();
      expect(pruned).toBe(1);
      expect(getActiveErrors()).toHaveLength(0);
    });

    it("keeps errors seen within 5 minutes", async () => {
      reportError("event_write", "recent error");
      const pruned = await pruneResolved();
      expect(pruned).toBe(0);
      expect(getActiveErrors()).toHaveLength(1);
    });
  });
});
