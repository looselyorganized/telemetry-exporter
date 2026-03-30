import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import {
  initLocal,
  closeLocal,
  insertOtelEvent,
  upsertSession,
  getUnprocessedOtelEvents,
} from "../../db/local";
import { OtelReceiver } from "../otel-receiver";

const TEST_DB_PATH = "/tmp/lo-test-otel-receiver.db";

function deleteTestFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

/** Build a logRecord payload matching the OTLP format stored by the server. */
function makeLogRecord(attrs: Record<string, any>) {
  return JSON.stringify({
    eventName: attrs["event.name"] ?? "unknown",
    attributes: Object.entries(attrs).map(([key, val]) => {
      if (typeof val === "string") return { key, value: { stringValue: val } };
      if (typeof val === "number") {
        if (Number.isInteger(val)) return { key, value: { intValue: String(val) } };
        return { key, value: { doubleValue: val } };
      }
      if (typeof val === "boolean") return { key, value: { boolValue: val } };
      return { key, value: { stringValue: String(val) } };
    }),
  });
}

beforeEach(() => {
  deleteTestFiles();
  initLocal(TEST_DB_PATH);
});

afterEach(() => {
  closeLocal();
  deleteTestFiles();
});

describe("OtelReceiver", () => {
  test("returns empty batch when no events", () => {
    const receiver = new OtelReceiver();
    const batch = receiver.poll();
    expect(batch.apiRequests).toEqual([]);
    expect(batch.toolResults).toEqual([]);
    expect(batch.toolDecisionRejects).toEqual([]);
    expect(batch.apiErrors).toEqual([]);
    expect(batch.unresolved).toBe(0);
    expect(batch.skipped).toBe(0);
  });

  test("extracts api_request events with resolved sessions", () => {
    upsertSession("sess-1", "proj_abc", "/path/to/project");

    insertOtelEvent("api_request", "sess-1", makeLogRecord({
      "event.name": "api_request",
      "session.id": "sess-1",
      model: "claude-opus-4-6",
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 5000,
      cache_creation_tokens: 200,
      cost_usd: 0.05,
      duration_ms: 1234,
      "event.timestamp": "2026-03-26T12:00:00.000Z",
    }));

    const receiver = new OtelReceiver();
    const batch = receiver.poll();

    expect(batch.apiRequests).toHaveLength(1);
    expect(batch.toolDecisionRejects).toEqual([]);
    expect(batch.apiErrors).toEqual([]);
    expect(batch.unresolved).toBe(0);
    expect(batch.skipped).toBe(0);

    const req = batch.apiRequests[0];
    expect(req.projId).toBe("proj_abc");
    expect(req.sessionId).toBe("sess-1");
    expect(req.model).toBe("claude-opus-4-6");
    expect(req.inputTokens).toBe(1000);
    expect(req.outputTokens).toBe(500);
    expect(req.cacheReadTokens).toBe(5000);
    expect(req.cacheWriteTokens).toBe(200);
    expect(req.costUsd).toBeCloseTo(0.05);
    expect(req.durationMs).toBe(1234);
    expect(req.timestamp).toBe("2026-03-26T12:00:00.000Z");
  });

  test("extracts tool_result events", () => {
    upsertSession("sess-1", "proj_abc", "/path");

    insertOtelEvent("tool_result", "sess-1", makeLogRecord({
      "event.name": "tool_result",
      "session.id": "sess-1",
      tool_name: "Bash",
      success: "true",
      duration_ms: 567,
      "event.timestamp": "2026-03-26T12:00:00.000Z",
    }));

    const receiver = new OtelReceiver();
    const batch = receiver.poll();

    expect(batch.toolResults).toHaveLength(1);
    const tool = batch.toolResults[0];
    expect(tool.projId).toBe("proj_abc");
    expect(tool.toolName).toBe("Bash");
    expect(tool.success).toBe(true);
    expect(tool.durationMs).toBe(567);
  });

  test("leaves unresolved sessions for retry", () => {
    // No session registered for "sess-unknown"
    insertOtelEvent("api_request", "sess-unknown", makeLogRecord({
      model: "opus",
    }));

    const receiver = new OtelReceiver();
    const batch = receiver.poll();

    expect(batch.apiRequests).toHaveLength(0);
    expect(batch.unresolved).toBe(1);

    // Event should still be unprocessed
    const remaining = getUnprocessedOtelEvents(10);
    expect(remaining).toHaveLength(1);
  });

  test("marks resolved events as processed", () => {
    upsertSession("sess-1", "proj_abc", "/path");
    insertOtelEvent("api_request", "sess-1", makeLogRecord({ model: "opus" }));

    const receiver = new OtelReceiver();
    receiver.poll();

    // Should be marked as processed
    const remaining = getUnprocessedOtelEvents(10);
    expect(remaining).toHaveLength(0);
  });

  test("handles mixed resolved and unresolved events", () => {
    upsertSession("sess-1", "proj_abc", "/path");

    insertOtelEvent("api_request", "sess-1", makeLogRecord({ model: "opus" }));
    insertOtelEvent("api_request", "sess-unknown", makeLogRecord({ model: "sonnet" }));
    insertOtelEvent("tool_result", "sess-1", makeLogRecord({ tool_name: "Read" }));

    const receiver = new OtelReceiver();
    const batch = receiver.poll();

    expect(batch.apiRequests).toHaveLength(1);
    expect(batch.toolResults).toHaveLength(1);
    expect(batch.unresolved).toBe(1);

    // Only the unresolved event should remain
    const remaining = getUnprocessedOtelEvents(10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].session_id).toBe("sess-unknown");
  });

  test("marks metric and span events as processed without extracting", () => {
    insertOtelEvent("metric", "sess-1", "{}");
    insertOtelEvent("span", "sess-1", "{}");

    const receiver = new OtelReceiver();
    const batch = receiver.poll();

    expect(batch.apiRequests).toHaveLength(0);
    expect(batch.toolResults).toHaveLength(0);
    expect(getUnprocessedOtelEvents(10)).toHaveLength(0);
  });

  test("marks events with no session_id as processed", () => {
    insertOtelEvent("api_request", null, makeLogRecord({ model: "opus" }));

    const receiver = new OtelReceiver();
    const batch = receiver.poll();

    expect(batch.apiRequests).toHaveLength(0);
    expect(getUnprocessedOtelEvents(10)).toHaveLength(0);
  });

  test("respects batch size limit", () => {
    upsertSession("sess-1", "proj_abc", "/path");
    for (let i = 0; i < 10; i++) {
      insertOtelEvent("api_request", "sess-1", makeLogRecord({ model: "opus" }));
    }

    const receiver = new OtelReceiver(3);
    const batch = receiver.poll();

    // Should process only 3
    expect(batch.apiRequests).toHaveLength(3);

    // 7 should remain
    const remaining = getUnprocessedOtelEvents(100);
    expect(remaining).toHaveLength(7);
  });

  test("idempotent: second poll returns new events only", () => {
    upsertSession("sess-1", "proj_abc", "/path");

    insertOtelEvent("api_request", "sess-1", makeLogRecord({ model: "opus" }));

    const receiver = new OtelReceiver();
    const batch1 = receiver.poll();
    expect(batch1.apiRequests).toHaveLength(1);

    // Second poll should find nothing
    const batch2 = receiver.poll();
    expect(batch2.apiRequests).toHaveLength(0);
    expect(batch2.unresolved).toBe(0);

    // Add new event
    insertOtelEvent("api_request", "sess-1", makeLogRecord({ model: "sonnet" }));
    const batch3 = receiver.poll();
    expect(batch3.apiRequests).toHaveLength(1);
    expect(batch3.apiRequests[0].model).toBe("sonnet");
  });

  test("handles malformed payload gracefully", () => {
    upsertSession("sess-1", "proj_abc", "/path");
    insertOtelEvent("api_request", "sess-1", "not valid json{{{");

    const receiver = new OtelReceiver();
    const batch = receiver.poll();

    // Should be marked processed (can't parse, don't retry forever)
    expect(batch.apiRequests).toHaveLength(0);
    expect(getUnprocessedOtelEvents(10)).toHaveLength(0);
  });
});
