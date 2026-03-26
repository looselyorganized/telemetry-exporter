import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { initLocal, closeLocal, getLocal, getUnprocessedOtelEvents } from "../../db/local";
import { startOtlpServer, stopOtlpServer, isOtlpServerRunning, pruneRateLimits } from "../server";

const TEST_DB_PATH = "/tmp/lo-test-otlp-server.db";
const TEST_PORT = 14318; // Avoid conflict with real OTLP on 4318
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function deleteTestFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

function makeLogPayload(sessionId = "sess-test", eventName = "claude_code.api_request") {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1711497600000000000",
                eventName,
                attributes: [
                  { key: "session.id", value: { stringValue: sessionId } },
                  { key: "model", value: { stringValue: "claude-opus-4-6" } },
                  { key: "cost_usd", value: { doubleValue: 0.05 } },
                  { key: "input_tokens", value: { intValue: "1000" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

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
  // Clear otel_events between tests
  getLocal().run("DELETE FROM otel_events");
  pruneRateLimits();
});

// ─── POST /v1/logs ──────────────────────────────────────────────────────────

describe("POST /v1/logs", () => {
  test("stores valid log event and returns 200", async () => {
    const res = await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeLogPayload()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(1);

    const rows = getUnprocessedOtelEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("api_request");
    expect(rows[0].session_id).toBe("sess-test");
  });

  test("stores multiple log records in one payload", async () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { eventName: "claude_code.api_request", attributes: [{ key: "session.id", value: { stringValue: "s1" } }] },
                { eventName: "claude_code.tool_result", attributes: [{ key: "session.id", value: { stringValue: "s1" } }] },
              ],
            },
          ],
        },
      ],
    };

    const res = await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(2);

    const rows = getUnprocessedOtelEvents(10);
    expect(rows).toHaveLength(2);
  });

  test("returns 400 for invalid JSON", async () => {
    const res = await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });

    expect(res.status).toBe(400);
  });

  test("returns 200 with stored=0 for empty payload", async () => {
    const res = await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(0);
  });
});

// ─── POST /v1/metrics ───────────────────────────────────────────────────────

describe("POST /v1/metrics", () => {
  test("stores metric data points", async () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  sum: {
                    dataPoints: [
                      {
                        asDouble: 100,
                        attributes: [{ key: "session.id", value: { stringValue: "sess-m1" } }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await fetch(`${BASE_URL}/v1/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(1);

    const rows = getUnprocessedOtelEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("metric");
    expect(rows[0].session_id).toBe("sess-m1");
  });
});

// ─── POST /v1/traces ────────────────────────────────────────────────────────

describe("POST /v1/traces", () => {
  test("stores trace spans", async () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "tool_call",
                  traceId: "AA",
                  spanId: "BB",
                  attributes: [{ key: "session.id", value: { stringValue: "sess-t1" } }],
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await fetch(`${BASE_URL}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(1);

    const rows = getUnprocessedOtelEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("span");
  });
});

// ─── Error handling ─────────────────────────────────────────────────────────

describe("error handling", () => {
  test("returns 405 for GET", async () => {
    const res = await fetch(`${BASE_URL}/v1/logs`);
    expect(res.status).toBe(405);
  });

  test("returns 404 for unknown path", async () => {
    const res = await fetch(`${BASE_URL}/v1/unknown`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});

// ─── Rate limiting ──────────────────────────────────────────────────────────

describe("rate limiting", () => {
  test("allows up to 200 events per session per minute", async () => {
    // Send 201 events for one session
    const payload = makeLogPayload("rate-test-session");
    const bigPayload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: Array.from({ length: 201 }, () => ({
                eventName: "claude_code.api_request",
                attributes: [
                  { key: "session.id", value: { stringValue: "rate-test-session" } },
                ],
              })),
            },
          ],
        },
      ],
    };

    const res = await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bigPayload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(200);
    expect(body.rateLimited).toBe(1);
  });

  test("rate limits are per-session (different sessions are independent)", async () => {
    // Fill rate limit for session A
    const bigPayload = (sessionId: string) => ({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: Array.from({ length: 200 }, () => ({
                eventName: "claude_code.api_request",
                attributes: [
                  { key: "session.id", value: { stringValue: sessionId } },
                ],
              })),
            },
          ],
        },
      ],
    });

    await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bigPayload("session-A")),
    });

    // Session B should still be allowed
    const res = await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeLogPayload("session-B")),
    });

    const body = await res.json();
    expect(body.stored).toBe(1);
    expect(body.rateLimited).toBe(0);
  });

  test("returns 429 when all events are rate limited", async () => {
    // Fill rate limit first
    const fillPayload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: Array.from({ length: 200 }, () => ({
                eventName: "claude_code.api_request",
                attributes: [
                  { key: "session.id", value: { stringValue: "limit-sess" } },
                ],
              })),
            },
          ],
        },
      ],
    };

    await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fillPayload),
    });

    // Next request should be fully rate limited
    const res = await fetch(`${BASE_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeLogPayload("limit-sess")),
    });

    expect(res.status).toBe(429);
  });
});

// ─── Server lifecycle ───────────────────────────────────────────────────────

describe("server lifecycle", () => {
  test("isOtlpServerRunning returns true when running", () => {
    expect(isOtlpServerRunning()).toBe(true);
  });
});
