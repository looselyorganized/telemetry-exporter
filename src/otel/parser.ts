/**
 * OTLP JSON parser — extracts structured events from OpenTelemetry payloads.
 *
 * All functions are pure (no side effects, no database access).
 * Handles the OTLP HTTP/JSON encoding where:
 *   - intValue is a string-encoded int64
 *   - attributes are {key, value: {stringValue|intValue|doubleValue|boolValue}} arrays
 *   - eventName identifies the log event type
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Extracted from a single logRecord. */
export interface OtelLogEvent {
  eventType: string;
  sessionId: string | null;
  timestamp: string | null;
  attributes: Record<string, string | number | boolean>;
  rawPayload: string;
}

/** Extracted from a metric data point. */
export interface OtelMetricEvent {
  metricName: string;
  sessionId: string | null;
  value: number;
  attributes: Record<string, string | number | boolean>;
  rawPayload: string;
}

/** Extracted from a trace span. */
export interface OtelSpanEvent {
  spanName: string;
  sessionId: string | null;
  traceId: string | null;
  startTime: string | null;
  endTime: string | null;
  attributes: Record<string, string | number | boolean>;
  rawPayload: string;
}

/** Classified event type for routing in the pipeline. */
export type EventClass =
  | "api_request"
  | "tool_result"
  | "user_prompt"
  | "api_error"
  | "tool_decision"
  | "metric"
  | "span"
  | "unknown";

// ─── Attribute helpers ──────────────────────────────────────────────────────

interface OtlpAttribute {
  key: string;
  value?: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
    arrayValue?: unknown;
    kvlistValue?: unknown;
    bytesValue?: string;
  };
}

/** Extract a primitive value from an OTLP attribute value object. */
function extractValue(attr: OtlpAttribute): string | number | boolean | null {
  const v = attr.value;
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return parseInt(v.intValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return null;
}

/** Convert an OTLP attributes array to a flat Record. */
export function flattenAttributes(
  attrs: OtlpAttribute[] | undefined
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  if (!attrs) return result;
  for (const attr of attrs) {
    const val = extractValue(attr);
    if (val !== null) result[attr.key] = val;
  }
  return result;
}

/** Convert nanosecond timestamp (string) to ISO 8601. */
function nanoToIso(nano: string | undefined): string | null {
  if (!nano || nano === "0") return null;
  const ms = Math.floor(parseInt(nano, 10) / 1_000_000);
  return new Date(ms).toISOString();
}

// ─── Log parsing ────────────────────────────────────────────────────────────

/**
 * Parse an OTLP ExportLogsServiceRequest JSON body.
 * Returns one OtelLogEvent per logRecord.
 */
export function parseOtlpLogs(body: unknown): OtelLogEvent[] {
  const events: OtelLogEvent[] = [];
  if (!body || typeof body !== "object") return events;

  const resourceLogs = (body as any).resourceLogs;
  if (!Array.isArray(resourceLogs)) return events;

  for (const rl of resourceLogs) {
    const scopeLogs = rl?.scopeLogs;
    if (!Array.isArray(scopeLogs)) continue;

    for (const sl of scopeLogs) {
      const logRecords = sl?.logRecords;
      if (!Array.isArray(logRecords)) continue;

      for (const lr of logRecords) {
        const attrs = flattenAttributes(lr?.attributes);
        const eventType = lr?.eventName ?? (attrs["event.name"] as string) ?? "unknown";
        const sessionId = (attrs["session.id"] as string) ?? null;
        const timestamp = nanoToIso(lr?.timeUnixNano) ?? (attrs["event.timestamp"] as string) ?? null;

        events.push({
          eventType,
          sessionId,
          timestamp,
          attributes: attrs,
          rawPayload: JSON.stringify(lr),
        });
      }
    }
  }

  return events;
}

// ─── Metrics parsing ────────────────────────────────────────────────────────

/**
 * Parse an OTLP ExportMetricsServiceRequest JSON body.
 * Returns one OtelMetricEvent per data point.
 */
export function parseOtlpMetrics(body: unknown): OtelMetricEvent[] {
  const events: OtelMetricEvent[] = [];
  if (!body || typeof body !== "object") return events;

  const resourceMetrics = (body as any).resourceMetrics;
  if (!Array.isArray(resourceMetrics)) return events;

  for (const rm of resourceMetrics) {
    const scopeMetrics = rm?.scopeMetrics;
    if (!Array.isArray(scopeMetrics)) continue;

    for (const sm of scopeMetrics) {
      const metrics = sm?.metrics;
      if (!Array.isArray(metrics)) continue;

      for (const metric of metrics) {
        const metricName = metric?.name ?? "unknown";

        // Extract data points from whichever metric type is present
        const dataPoints = extractDataPoints(metric);
        for (const dp of dataPoints) {
          const attrs = flattenAttributes(dp?.attributes);
          const sessionId = (attrs["session.id"] as string) ?? null;
          const value = dp?.asDouble ?? dp?.asInt ?? 0;

          events.push({
            metricName,
            sessionId,
            value: typeof value === "string" ? parseFloat(value) : value,
            attributes: attrs,
            rawPayload: JSON.stringify(dp),
          });
        }
      }
    }
  }

  return events;
}

/** Extract data points from a metric regardless of its type (sum, gauge, histogram). */
function extractDataPoints(metric: any): any[] {
  if (metric?.sum?.dataPoints) return metric.sum.dataPoints;
  if (metric?.gauge?.dataPoints) return metric.gauge.dataPoints;
  if (metric?.histogram?.dataPoints) return metric.histogram.dataPoints;
  if (metric?.exponentialHistogram?.dataPoints) return metric.exponentialHistogram.dataPoints;
  if (metric?.summary?.dataPoints) return metric.summary.dataPoints;
  return [];
}

// ─── Traces parsing ─────────────────────────────────────────────────────────

/**
 * Parse an OTLP ExportTraceServiceRequest JSON body.
 * Returns one OtelSpanEvent per span.
 */
export function parseOtlpTraces(body: unknown): OtelSpanEvent[] {
  const events: OtelSpanEvent[] = [];
  if (!body || typeof body !== "object") return events;

  const resourceSpans = (body as any).resourceSpans;
  if (!Array.isArray(resourceSpans)) return events;

  for (const rs of resourceSpans) {
    const scopeSpans = rs?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;

    for (const ss of scopeSpans) {
      const spans = ss?.spans;
      if (!Array.isArray(spans)) continue;

      for (const span of spans) {
        const attrs = flattenAttributes(span?.attributes);
        const sessionId = (attrs["session.id"] as string) ?? null;

        events.push({
          spanName: span?.name ?? "unknown",
          sessionId,
          traceId: span?.traceId ?? null,
          startTime: nanoToIso(span?.startTimeUnixNano),
          endTime: nanoToIso(span?.endTimeUnixNano),
          attributes: attrs,
          rawPayload: JSON.stringify(span),
        });
      }
    }
  }

  return events;
}

// ─── Event classification ───────────────────────────────────────────────────

/** Extract session.id from a logRecord's attributes. */
export function extractSessionId(record: { attributes?: OtlpAttribute[] }): string | null {
  const attrs = flattenAttributes(record?.attributes);
  return (attrs["session.id"] as string) ?? null;
}

/** Classify an event by its eventName or event.name attribute. */
export function classifyEvent(eventName: string): EventClass {
  if (eventName === "claude_code.api_request") return "api_request";
  if (eventName === "claude_code.tool_result") return "tool_result";
  if (eventName === "claude_code.user_prompt") return "user_prompt";
  if (eventName === "claude_code.api_error") return "api_error";
  if (eventName === "claude_code.tool_decision") return "tool_decision";
  return "unknown";
}
