import { describe, test, expect } from "bun:test";
import {
  parseOtlpLogs,
  parseOtlpMetrics,
  parseOtlpTraces,
  extractSessionId,
  classifyEvent,
  flattenAttributes,
} from "../parser";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeLogPayload(overrides: Record<string, any> = {}) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "claude-code" } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "com.anthropic.claude_code" },
            logRecords: [
              {
                timeUnixNano: "1711497600000000000", // 2024-03-27T00:00:00Z
                eventName: "claude_code.api_request",
                attributes: [
                  { key: "session.id", value: { stringValue: "abc-123" } },
                  { key: "model", value: { stringValue: "claude-opus-4-6" } },
                  { key: "cost_usd", value: { doubleValue: 0.05 } },
                  { key: "input_tokens", value: { intValue: "1000" } },
                  { key: "output_tokens", value: { intValue: "500" } },
                  { key: "cache_read_tokens", value: { intValue: "5000" } },
                  { key: "cache_creation_tokens", value: { intValue: "200" } },
                  { key: "duration_ms", value: { intValue: "1234" } },
                ],
                ...overrides,
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeMetricsPayload(metricName: string, value: number, attrs: Record<string, any> = {}) {
  const dpAttrs = Object.entries(attrs).map(([key, val]) => {
    if (typeof val === "string") return { key, value: { stringValue: val } };
    if (typeof val === "number") return { key, value: { doubleValue: val } };
    return { key, value: { stringValue: String(val) } };
  });

  return {
    resourceMetrics: [
      {
        resource: { attributes: [] },
        scopeMetrics: [
          {
            scope: { name: "com.anthropic.claude_code" },
            metrics: [
              {
                name: metricName,
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      asDouble: value,
                      timeUnixNano: "1711497600000000000",
                      attributes: dpAttrs,
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
}

function makeTracesPayload(spanName: string, attrs: Record<string, any> = {}) {
  const spanAttrs = Object.entries(attrs).map(([key, val]) => ({
    key,
    value: typeof val === "string" ? { stringValue: val } : { intValue: String(val) },
  }));

  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: { name: "com.anthropic.claude_code" },
            spans: [
              {
                name: spanName,
                traceId: "AABBCC",
                spanId: "112233",
                startTimeUnixNano: "1711497600000000000",
                endTimeUnixNano: "1711497601000000000",
                attributes: spanAttrs,
              },
            ],
          },
        ],
      },
    ],
  };
}

// ─── flattenAttributes ─────────────────────────────────────────────────────

describe("flattenAttributes", () => {
  test("extracts stringValue", () => {
    const result = flattenAttributes([
      { key: "name", value: { stringValue: "hello" } },
    ]);
    expect(result).toEqual({ name: "hello" });
  });

  test("extracts intValue as number", () => {
    const result = flattenAttributes([
      { key: "count", value: { intValue: "42" } },
    ]);
    expect(result).toEqual({ count: 42 });
  });

  test("extracts doubleValue", () => {
    const result = flattenAttributes([
      { key: "cost", value: { doubleValue: 0.05 } },
    ]);
    expect(result).toEqual({ cost: 0.05 });
  });

  test("extracts boolValue", () => {
    const result = flattenAttributes([
      { key: "success", value: { boolValue: true } },
    ]);
    expect(result).toEqual({ success: true });
  });

  test("returns empty for undefined", () => {
    expect(flattenAttributes(undefined)).toEqual({});
  });

  test("skips attributes with no extractable value", () => {
    const result = flattenAttributes([
      { key: "array", value: { arrayValue: { values: [] } } },
      { key: "name", value: { stringValue: "ok" } },
    ]);
    expect(result).toEqual({ name: "ok" });
  });

  test("handles mixed types", () => {
    const result = flattenAttributes([
      { key: "s", value: { stringValue: "hi" } },
      { key: "i", value: { intValue: "7" } },
      { key: "d", value: { doubleValue: 3.14 } },
      { key: "b", value: { boolValue: false } },
    ]);
    expect(result).toEqual({ s: "hi", i: 7, d: 3.14, b: false });
  });
});

// ─── parseOtlpLogs ─────────────────────────────────────────────────────────

describe("parseOtlpLogs", () => {
  test("parses api_request event", () => {
    const events = parseOtlpLogs(makeLogPayload());
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("claude_code.api_request");
    expect(events[0].sessionId).toBe("abc-123");
    expect(events[0].attributes["model"]).toBe("claude-opus-4-6");
    expect(events[0].attributes["cost_usd"]).toBe(0.05);
    expect(events[0].attributes["input_tokens"]).toBe(1000);
    expect(events[0].attributes["output_tokens"]).toBe(500);
  });

  test("extracts timestamp from timeUnixNano", () => {
    const events = parseOtlpLogs(makeLogPayload());
    expect(events[0].timestamp).toBe("2024-03-27T00:00:00.000Z");
  });

  test("falls back to event.name when eventName missing", () => {
    const payload = makeLogPayload({ eventName: undefined });
    // event.name is not in the default fixture, so eventType falls back to the attributes
    // Let's add it explicitly
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    delete (lr as any).eventName;
    lr.attributes.push({ key: "event.name", value: { stringValue: "tool_result" } });

    const events = parseOtlpLogs(payload);
    expect(events[0].eventType).toBe("tool_result");
  });

  test("returns empty for null/undefined body", () => {
    expect(parseOtlpLogs(null)).toEqual([]);
    expect(parseOtlpLogs(undefined)).toEqual([]);
  });

  test("returns empty for missing resourceLogs", () => {
    expect(parseOtlpLogs({})).toEqual([]);
    expect(parseOtlpLogs({ resourceLogs: "not-array" })).toEqual([]);
  });

  test("handles multiple logRecords", () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { eventName: "a", attributes: [] },
                { eventName: "b", attributes: [] },
              ],
            },
          ],
        },
      ],
    };
    const events = parseOtlpLogs(payload);
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe("a");
    expect(events[1].eventType).toBe("b");
  });

  test("handles multiple scopeLogs", () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            { logRecords: [{ eventName: "a", attributes: [] }] },
            { logRecords: [{ eventName: "b", attributes: [] }] },
          ],
        },
      ],
    };
    const events = parseOtlpLogs(payload);
    expect(events).toHaveLength(2);
  });

  test("session_id is null when not present", () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { eventName: "test", attributes: [] },
              ],
            },
          ],
        },
      ],
    };
    const events = parseOtlpLogs(payload);
    expect(events[0].sessionId).toBeNull();
  });

  test("rawPayload is JSON of the logRecord", () => {
    const events = parseOtlpLogs(makeLogPayload());
    const parsed = JSON.parse(events[0].rawPayload);
    expect(parsed.eventName).toBe("claude_code.api_request");
  });
});

// ─── parseOtlpMetrics ──────────────────────────────────────────────────────

describe("parseOtlpMetrics", () => {
  test("parses sum metric data point", () => {
    const payload = makeMetricsPayload("claude_code.token.usage", 751, {
      "session.id": "sess-456",
      type: "input",
      model: "claude-sonnet-4-6",
    });
    const events = parseOtlpMetrics(payload);
    expect(events).toHaveLength(1);
    expect(events[0].metricName).toBe("claude_code.token.usage");
    expect(events[0].value).toBe(751);
    expect(events[0].sessionId).toBe("sess-456");
    expect(events[0].attributes["type"]).toBe("input");
  });

  test("parses gauge metric", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "my.gauge",
                  gauge: {
                    dataPoints: [{ asDouble: 42, attributes: [] }],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const events = parseOtlpMetrics(payload);
    expect(events).toHaveLength(1);
    expect(events[0].metricName).toBe("my.gauge");
    expect(events[0].value).toBe(42);
  });

  test("returns empty for null body", () => {
    expect(parseOtlpMetrics(null)).toEqual([]);
  });

  test("returns empty for missing structure", () => {
    expect(parseOtlpMetrics({})).toEqual([]);
    expect(parseOtlpMetrics({ resourceMetrics: "bad" })).toEqual([]);
  });

  test("sessionId is null when not in attributes", () => {
    const payload = makeMetricsPayload("test", 1, {});
    const events = parseOtlpMetrics(payload);
    expect(events[0].sessionId).toBeNull();
  });
});

// ─── parseOtlpTraces ───────────────────────────────────────────────────────

describe("parseOtlpTraces", () => {
  test("parses span", () => {
    const payload = makeTracesPayload("tool_call", {
      "session.id": "sess-789",
    });
    const events = parseOtlpTraces(payload);
    expect(events).toHaveLength(1);
    expect(events[0].spanName).toBe("tool_call");
    expect(events[0].sessionId).toBe("sess-789");
    expect(events[0].traceId).toBe("AABBCC");
    expect(events[0].startTime).toBe("2024-03-27T00:00:00.000Z");
    expect(events[0].endTime).toBe("2024-03-27T00:00:01.000Z");
  });

  test("returns empty for null body", () => {
    expect(parseOtlpTraces(null)).toEqual([]);
  });

  test("returns empty for missing structure", () => {
    expect(parseOtlpTraces({})).toEqual([]);
  });

  test("sessionId is null when not in attributes", () => {
    const payload = makeTracesPayload("test", {});
    const events = parseOtlpTraces(payload);
    expect(events[0].sessionId).toBeNull();
  });
});

// ─── extractSessionId ──────────────────────────────────────────────────────

describe("extractSessionId", () => {
  test("extracts session.id from attributes", () => {
    const id = extractSessionId({
      attributes: [
        { key: "session.id", value: { stringValue: "my-session" } },
      ],
    });
    expect(id).toBe("my-session");
  });

  test("returns null when no session.id", () => {
    const id = extractSessionId({
      attributes: [{ key: "other", value: { stringValue: "val" } }],
    });
    expect(id).toBeNull();
  });

  test("returns null for undefined attributes", () => {
    expect(extractSessionId({})).toBeNull();
  });
});

// ─── classifyEvent ─────────────────────────────────────────────────────────

describe("classifyEvent", () => {
  test("classifies api_request", () => {
    expect(classifyEvent("claude_code.api_request")).toBe("api_request");
  });

  test("classifies tool_result", () => {
    expect(classifyEvent("claude_code.tool_result")).toBe("tool_result");
  });

  test("classifies user_prompt", () => {
    expect(classifyEvent("claude_code.user_prompt")).toBe("user_prompt");
  });

  test("classifies api_error", () => {
    expect(classifyEvent("claude_code.api_error")).toBe("api_error");
  });

  test("classifies tool_decision", () => {
    expect(classifyEvent("claude_code.tool_decision")).toBe("tool_decision");
  });

  test("returns unknown for unrecognized events", () => {
    expect(classifyEvent("something_else")).toBe("unknown");
    expect(classifyEvent("")).toBe("unknown");
  });
});
