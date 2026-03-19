import { Database } from "bun:sqlite";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OutboxRow } from "../db/local";
import type { ShipResult, ShippingStrategy } from "../db/types";
import {
  dequeueUnshipped,
  markShipped,
  markFailed,
  markTransientError,
  dequeueUnshippedArchive,
  markArchiveShipped,
  pruneShipped as pruneShippedLocal,
  pruneShippedArchive as pruneShippedArchiveLocal,
  outboxDepth as outboxDepthLocal,
  archiveDepth as archiveDepthLocal,
} from "../db/local";

// ---------------------------------------------------------------------------
// Re-export types for convenience
// ---------------------------------------------------------------------------

export type { ShipResult, ShippingStrategy } from "../db/types";

// ---------------------------------------------------------------------------
// Shipping strategies
// ---------------------------------------------------------------------------

export const SHIPPING_STRATEGIES: Record<string, ShippingStrategy> = {
  projects: {
    table: "projects",
    method: "upsert",
    onConflict: "id",
    ignoreDuplicates: false,
    batchSize: 50,
    fallbackToPerRow: true,
    priority: 1,
  },
  events: {
    table: "events",
    method: "upsert",
    onConflict: "project_id,event_type,event_text,timestamp",
    ignoreDuplicates: true,
    batchSize: 500,
    fallbackToPerRow: true,
    priority: 2,
  },
  daily_metrics: {
    table: "daily_metrics",
    method: "upsert",
    onConflict: "date,project_id",
    ignoreDuplicates: false,
    batchSize: 100,
    fallbackToPerRow: true,
    priority: 3,
  },
  project_telemetry: {
    table: "project_telemetry",
    method: "upsert",
    onConflict: "project_id",
    excludeFields: ["active_agents", "agent_count"],
    batchSize: 50,
    fallbackToPerRow: true,
    priority: 4,
  },
  facility_metrics: {
    table: "facility_status",
    method: "update",
    filter: { id: 1 },
    excludeFields: ["active_agents", "active_projects", "status"],
    batchSize: 1,
    fallbackToPerRow: false,
    priority: 5,
  },
};

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  state: "closed" | "open" | "half-open" = "closed";

  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private readonly timeoutMs: number;

  constructor(timeoutMs = 60_000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Returns true if the circuit is open and the timeout has NOT yet elapsed.
   * If the timeout has elapsed, transitions to half-open and returns false.
   */
  isOpen(): boolean {
    if (this.state === "open") {
      if (this.openedAt !== null && Date.now() - this.openedAt >= this.timeoutMs) {
        this.state = "half-open";
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    if (this.state === "half-open") {
      // Any failure in half-open immediately re-opens
      this.state = "open";
      this.openedAt = Date.now();
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 3) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: groupByTarget
// ---------------------------------------------------------------------------

/**
 * Partition outbox rows by their target field.
 */
export function groupByTarget(rows: OutboxRow[]): Map<string, OutboxRow[]> {
  const map = new Map<string, OutboxRow[]>();
  for (const row of rows) {
    let bucket = map.get(row.target);
    if (!bucket) {
      bucket = [];
      map.set(row.target, bucket);
    }
    bucket.push(row);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Helper: sortByPriority
// ---------------------------------------------------------------------------

/**
 * Sort target names by their SHIPPING_STRATEGIES priority (ascending).
 * Unknown targets are placed after all known targets.
 */
export function sortByPriority(targets: string[]): string[] {
  const MAX_PRIORITY = Number.MAX_SAFE_INTEGER;
  return [...targets].sort((a, b) => {
    const pa = SHIPPING_STRATEGIES[a]?.priority ?? MAX_PRIORITY;
    const pb = SHIPPING_STRATEGIES[b]?.priority ?? MAX_PRIORITY;
    return pa - pb;
  });
}

// ---------------------------------------------------------------------------
// Helper: filterBlockedByFK
// ---------------------------------------------------------------------------

/**
 * Split rows into allowed vs blocked based on whether their project_id (or id)
 * appears in blockedProjIds.
 *
 * Rows with malformed JSON payloads are passed through as allowed (no project
 * identity to block against).
 */
export function filterBlockedByFK(
  rows: OutboxRow[],
  blockedProjIds: Set<string>
): { allowed: OutboxRow[]; blocked: OutboxRow[] } {
  const allowed: OutboxRow[] = [];
  const blocked: OutboxRow[] = [];

  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      // Malformed JSON — allow through
      allowed.push(row);
      continue;
    }

    const projId =
      (typeof payload.project_id === "string" ? payload.project_id : null) ??
      (typeof payload.id === "string" ? payload.id : null);

    if (projId !== null && blockedProjIds.has(projId)) {
      blocked.push(row);
    } else {
      allowed.push(row);
    }
  }

  return { allowed, blocked };
}

// ---------------------------------------------------------------------------
// Shipper class
// ---------------------------------------------------------------------------

/**
 * Whether an HTTP status code represents a transient (retryable) error.
 * 5xx or missing status → transient. 4xx → permanent.
 */
function isTransient(status: number | undefined): boolean {
  if (status === undefined || status === 0) return true;
  return status >= 500;
}

/**
 * Strip excludeFields from a payload object.
 */
function stripFields(payload: Record<string, unknown>, excludeFields: string[]): Record<string, unknown> {
  const result = { ...payload };
  for (const field of excludeFields) {
    delete result[field];
  }
  return result;
}

export class Shipper {
  private db: Database;
  private supabase: SupabaseClient;
  private breaker: CircuitBreaker;

  constructor(db: Database, supabase: SupabaseClient) {
    this.db = db;
    this.supabase = supabase;
    this.breaker = new CircuitBreaker();
  }

  async ship(): Promise<ShipResult> {
    const result: ShipResult = {
      shipped: 0,
      failed: 0,
      retriesScheduled: 0,
      circuitBreakerState: this.breaker.state,
      byTarget: {},
    };

    // Check circuit breaker before dequeuing
    if (this.breaker.isOpen()) {
      result.circuitBreakerState = this.breaker.state;
      return result;
    }

    const rows = dequeueUnshipped(500);
    if (rows.length === 0) return result;

    const grouped = groupByTarget(rows);
    const orderedTargets = sortByPriority([...grouped.keys()]);

    // Track project IDs whose registration permanently failed (4xx)
    const blockedProjIds = new Set<string>();

    for (const target of orderedTargets) {
      let targetRows = grouped.get(target)!;
      const strategy = SHIPPING_STRATEGIES[target];

      if (!result.byTarget[target]) {
        result.byTarget[target] = { shipped: 0, failed: 0 };
      }

      // For project-dependent targets, filter out rows blocked by FK constraint
      const isProjectDependent =
        target === "events" ||
        target === "daily_metrics" ||
        target === "project_telemetry";

      if (isProjectDependent && blockedProjIds.size > 0) {
        const { allowed, blocked } = filterBlockedByFK(targetRows, blockedProjIds);
        // Blocked rows stay pending — no action taken
        targetRows = allowed;
        void blocked; // acknowledged but not shipped/failed
      }

      if (targetRows.length === 0) continue;

      // Unknown target — skip
      if (!strategy) continue;

      // Singleton deduplication for facility_metrics
      if (strategy.batchSize === 1 || target === "facility_metrics") {
        if (targetRows.length > 1) {
          // Keep only the highest id row; mark the rest as shipped (superseded)
          const sorted = [...targetRows].sort((a, b) => b.id - a.id);
          const [keep, ...superseded] = sorted;
          const supersededIds = superseded.map((r) => r.id);
          markShipped(supersededIds);
          result.shipped += supersededIds.length;
          result.byTarget[target].shipped += supersededIds.length;
          targetRows = [keep];
        }
      }

      // Build payloads, stripping excluded fields
      const exclude = strategy.excludeFields ?? [];
      const payloads = targetRows.map((row) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.payload) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        return exclude.length > 0 ? stripFields(parsed, exclude) : parsed;
      });

      const ids = targetRows.map((r) => r.id);

      const execute = async (batchIds: number[], batchPayloads: Record<string, unknown>[]) => {
        let response: { data?: any; error?: any; status?: number };

        if (strategy.method === "upsert") {
          const payload = batchPayloads.length === 1 ? batchPayloads : batchPayloads;
          response = await (this.supabase
            .from(strategy.table)
            .upsert(payload, {
              onConflict: strategy.onConflict,
              ignoreDuplicates: strategy.ignoreDuplicates ?? false,
            }) as Promise<{ data?: any; error?: any; status?: number }>);
        } else {
          // "update" — always single row
          response = await (this.supabase
            .from(strategy.table)
            .update(batchPayloads[0])
            .match(strategy.filter ?? {}) as Promise<{ data?: any; error?: any; status?: number }>);
        }

        return response;
      };

      const processResponse = (
        resp: { data?: any; error?: any; status?: number },
        batchIds: number[],
        targetKey: string,
        projPayloads: Record<string, unknown>[]
      ) => {
        if (!resp.error) {
          markShipped(batchIds);
          this.breaker.recordSuccess();
          result.shipped += batchIds.length;
          result.byTarget[targetKey].shipped += batchIds.length;
        } else {
          const status = resp.status;
          const errMsg = resp.error?.message ?? String(resp.error);

          if (isTransient(status)) {
            markTransientError(batchIds, errMsg);
            this.breaker.recordFailure();
            result.retriesScheduled += batchIds.length;
          } else {
            // Permanent 4xx error
            markFailed(batchIds, errMsg);
            this.breaker.recordFailure();
            result.failed += batchIds.length;
            result.byTarget[targetKey].failed += batchIds.length;

            // Track project IDs that permanently failed for FK blocking
            if (targetKey === "projects") {
              for (const p of projPayloads) {
                if (typeof p.id === "string") {
                  blockedProjIds.add(p.id);
                }
              }
            }
          }
        }
      };

      // Execute batch
      const resp = await execute(ids, payloads);

      if (resp.error && strategy.fallbackToPerRow) {
        // Retry per-row
        for (let i = 0; i < ids.length; i++) {
          const singleResp = await execute([ids[i]], [payloads[i]]);
          processResponse(singleResp, [ids[i]], target, [payloads[i]]);
        }
      } else {
        processResponse(resp, ids, target, payloads);
      }
    }

    result.circuitBreakerState = this.breaker.state;
    return result;
  }

  async shipArchive(): Promise<ShipResult> {
    const result: ShipResult = {
      shipped: 0,
      failed: 0,
      retriesScheduled: 0,
      circuitBreakerState: this.breaker.state,
      byTarget: {},
    };

    const rows = dequeueUnshippedArchive(200);
    if (rows.length === 0) return result;

    const payloads = rows.map((r) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(r.payload) as Record<string, unknown>;
      } catch {
        parsed = { payload: r.payload };
      }
      return { ...parsed, fact_type: r.fact_type, content_hash: r.content_hash };
    });

    const ids = rows.map((r) => r.id);

    const resp = await (this.supabase
      .from("outbox_archive")
      .upsert(payloads, { onConflict: "fact_type,content_hash", ignoreDuplicates: true }) as Promise<{ data?: any; error?: any; status?: number }>);

    if (!resp.error) {
      markArchiveShipped(ids);
      result.shipped += ids.length;
    } else {
      const status = resp.status;
      const errMsg = resp.error?.message ?? String(resp.error);
      if (isTransient(status)) {
        // Archive rows have no retry_count mechanism — just leave unshipped
        result.retriesScheduled += ids.length;
      } else {
        result.failed += ids.length;
      }
    }

    result.circuitBreakerState = this.breaker.state;
    return result;
  }

  pruneShipped(days: number): void {
    pruneShippedLocal(days);
  }

  pruneShippedArchive(days: number): void {
    pruneShippedArchiveLocal(days);
  }

  outboxDepth(): number {
    return outboxDepthLocal();
  }

  archiveDepth(): number {
    return archiveDepthLocal();
  }

  async verify(lastUpdates: any[]): Promise<void> {
    if (lastUpdates.length === 0) return;

    const projIds = lastUpdates.map((u) => u.projId).filter(Boolean);
    if (projIds.length === 0) return;

    const resp = await (this.supabase
      .from("project_telemetry")
      .select("project_id,tokens_lifetime,sessions_lifetime")
      .in("project_id", projIds) as Promise<{ data?: any; error?: any }>);

    if (resp.error || !resp.data) {
      console.warn("[shipper:verify] failed to read back project_telemetry:", resp.error?.message);
      return;
    }

    const remoteById = new Map<string, any>(
      (resp.data as any[]).map((r: any) => [r.project_id, r])
    );

    for (const update of lastUpdates) {
      const remote = remoteById.get(update.projId);
      if (!remote) {
        console.warn(`[shipper:verify] project_telemetry missing for ${update.projId}`);
        continue;
      }
      if (remote.tokens_lifetime !== update.tokensLifetime) {
        console.warn(
          `[shipper:verify] tokens_lifetime mismatch for ${update.projId}: ` +
          `local=${update.tokensLifetime} remote=${remote.tokens_lifetime}`
        );
      }
    }
  }
}
