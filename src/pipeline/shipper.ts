import type { OutboxRow } from "../db/local";
import type { ShippingStrategy } from "../db/types";

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
