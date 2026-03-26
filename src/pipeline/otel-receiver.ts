/**
 * OTel receiver — reads unprocessed OTel events from SQLite,
 * resolves session→project attribution via the session registry,
 * and returns structured batches for the processor.
 *
 * Resolved events are marked as processed. Unresolved events
 * stay for retry on the next cycle (the session registry may
 * discover their session on a future refresh).
 */

import {
  getUnprocessedOtelEvents,
  markOtelEventsProcessed,
} from "../db/local";
import type { OtelEventRow } from "../db/local";
import { lookupSession } from "../otel/session-registry";
import { flattenAttributes } from "../otel/parser";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ApiRequestEvent {
  projId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  timestamp: string;
}

export interface ToolResultEvent {
  projId: string;
  sessionId: string;
  toolName: string;
  success: boolean;
  durationMs: number;
  timestamp: string;
}

export interface OtelEventBatch {
  apiRequests: ApiRequestEvent[];
  toolResults: ToolResultEvent[];
  unresolved: number;
}

// ─── Attribute extraction helpers ───────────────────────────────────────────

function getNum(attrs: Record<string, string | number | boolean>, key: string): number {
  const v = attrs[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseInt(v, 10) || 0;
  return 0;
}

function getStr(attrs: Record<string, string | number | boolean>, key: string): string {
  const v = attrs[key];
  return typeof v === "string" ? v : String(v ?? "");
}

// ─── OtelReceiver ───────────────────────────────────────────────────────────

export class OtelReceiver {
  private batchSize: number;

  constructor(batchSize = 500) {
    this.batchSize = batchSize;
  }

  /**
   * Read unprocessed OTel events, resolve session→project,
   * and return structured batches.
   */
  poll(): OtelEventBatch {
    const rows = getUnprocessedOtelEvents(this.batchSize);

    const apiRequests: ApiRequestEvent[] = [];
    const toolResults: ToolResultEvent[] = [];
    const resolvedIds: number[] = [];
    let unresolved = 0;

    for (const row of rows) {
      // Skip non-log event types (metrics/spans stored for future use)
      if (row.event_type === "metric" || row.event_type === "span") {
        resolvedIds.push(row.id);
        continue;
      }

      // Resolve session → project
      if (!row.session_id) {
        resolvedIds.push(row.id);
        continue;
      }

      const session = lookupSession(row.session_id);
      if (!session) {
        unresolved++;
        continue; // leave unprocessed for retry
      }

      // Parse the stored logRecord payload
      let payload: any;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        resolvedIds.push(row.id);
        continue;
      }

      const attrs = flattenAttributes(payload?.attributes);
      // Prefer OTel's event.timestamp; fall back to OTLP ingestion time (received_at)
      // for events that lack it. For unresolved-then-resolved events, received_at
      // reflects when the OTLP receiver got the event, not when it was processed.
      const timestamp = getStr(attrs, "event.timestamp") || row.received_at;

      if (row.event_type === "api_request") {
        const model = getStr(attrs, "model");
        if (!model) {
          // Skip events without a model — would corrupt cost_tracking PK
          resolvedIds.push(row.id);
          continue;
        }
        apiRequests.push({
          projId: session.proj_id,
          sessionId: row.session_id,
          model,
          inputTokens: getNum(attrs, "input_tokens"),
          outputTokens: getNum(attrs, "output_tokens"),
          cacheReadTokens: getNum(attrs, "cache_read_tokens"),
          cacheWriteTokens: getNum(attrs, "cache_creation_tokens"),
          costUsd: typeof attrs["cost_usd"] === "number" ? attrs["cost_usd"] : parseFloat(String(attrs["cost_usd"])) || 0,
          durationMs: getNum(attrs, "duration_ms"),
          timestamp,
        });
        resolvedIds.push(row.id);
      } else if (row.event_type === "tool_result") {
        toolResults.push({
          projId: session.proj_id,
          sessionId: row.session_id,
          toolName: getStr(attrs, "tool_name"),
          success: attrs["success"] === "true" || attrs["success"] === true,
          durationMs: getNum(attrs, "duration_ms"),
          timestamp,
        });
        resolvedIds.push(row.id);
      } else {
        // Other classified events (user_prompt, api_error, tool_decision) —
        // mark as processed, we don't need them in the pipeline yet
        resolvedIds.push(row.id);
      }
    }

    // Mark resolved events as processed
    markOtelEventsProcessed(resolvedIds);

    return { apiRequests, toolResults, unresolved };
  }
}
