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
  skipOtelEvents,
} from "../db/local";
import type { OtelEventRow } from "../db/local";
import {
  lookupSession,
  findSessionLocation,
  discoverAndRegisterSession,
  PROJECTS_DIR,
} from "../otel/session-registry";
import type { SessionLocation } from "../otel/session-registry";
import { flattenAttributes } from "../otel/parser";
import type { ProjectResolver } from "../project/resolver";

const LO_PROJECT_DIR_RE = /^-users-bigviking-documents-github-projects-lo(?:-|$)/;

export function isLOProjectDir(dir: string): boolean {
  return LO_PROJECT_DIR_RE.test(dir.toLowerCase());
}

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

export interface ToolDecisionReject {
  projId: string;
  sessionId: string;
  toolName: string;
  timestamp: string;
}

export interface ApiErrorEvent {
  projId: string;
  sessionId: string;
  error: string;
  statusCode: number;
  model: string;
  timestamp: string;
}

export interface OtelEventBatch {
  apiRequests: ApiRequestEvent[];
  toolResults: ToolResultEvent[];
  toolDecisionRejects: ToolDecisionReject[];
  apiErrors: ApiErrorEvent[];
  unresolved: number;
  skipped: number;
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
  private resolver: ProjectResolver | null;
  private projectsDir: string;

  constructor(batchSize = 500, resolver?: ProjectResolver, projectsDir?: string) {
    this.batchSize = batchSize;
    this.resolver = resolver ?? null;
    this.projectsDir = projectsDir ?? PROJECTS_DIR;
  }

  /**
   * Read unprocessed OTel events, resolve session→project,
   * and return structured batches.
   */
  poll(): OtelEventBatch {
    const rows = getUnprocessedOtelEvents(this.batchSize);

    const apiRequests: ApiRequestEvent[] = [];
    const toolResults: ToolResultEvent[] = [];
    const toolDecisionRejects: ToolDecisionReject[] = [];
    const apiErrors: ApiErrorEvent[] = [];
    const resolvedIds: number[] = [];
    const skippedIds: number[] = [];
    let unresolved = 0;

    // Batch-scope memo: multiple events for the same unknown session share one FS walk
    const locationMemo = new Map<string, SessionLocation | null>();
    const findLocation = (sessionId: string): SessionLocation | null => {
      if (locationMemo.has(sessionId)) return locationMemo.get(sessionId)!;
      const loc = findSessionLocation(sessionId, this.projectsDir);
      locationMemo.set(sessionId, loc);
      return loc;
    };

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

      let session = lookupSession(row.session_id);
      if (!session && this.resolver) {
        const location = findLocation(row.session_id);
        if (location && isLOProjectDir(location.encodedDir)) {
          session = discoverAndRegisterSession(
            row.session_id,
            this.resolver,
            this.projectsDir,
            location,
          );
        } else if (location) {
          skippedIds.push(row.id);
          continue;
        }
      }
      if (!session) {
        const ageMs = Date.now() - new Date(row.received_at).getTime();
        if (ageMs > 5 * 60 * 1000) {
          skippedIds.push(row.id);
        } else {
          unresolved++;
        }
        continue;
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
      } else if (row.event_type === "tool_decision") {
        const decision = getStr(attrs, "decision");
        if (decision === "reject") {
          toolDecisionRejects.push({
            projId: session.proj_id,
            sessionId: row.session_id,
            toolName: getStr(attrs, "tool_name"),
            timestamp,
          });
        }
        resolvedIds.push(row.id);
      } else if (row.event_type === "api_error") {
        apiErrors.push({
          projId: session.proj_id,
          sessionId: row.session_id,
          error: getStr(attrs, "error"),
          statusCode: getNum(attrs, "status_code"),
          model: getStr(attrs, "model"),
          timestamp,
        });
        resolvedIds.push(row.id);
      } else {
        resolvedIds.push(row.id);
      }
    }

    // Mark resolved events as processed
    markOtelEventsProcessed(resolvedIds);
    skipOtelEvents(skippedIds);

    return { apiRequests, toolResults, toolDecisionRejects, apiErrors, unresolved, skipped: skippedIds.length };
  }
}
