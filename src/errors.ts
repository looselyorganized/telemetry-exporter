/**
 * Lightweight in-memory error aggregator for the telemetry daemon.
 * Deduplicates errors by category:normalized_message and flushes to Supabase.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ErrorCategory =
  | "event_write"
  | "project_registration"
  | "facility_state"
  | "metrics_sync"
  | "telemetry_sync"
  | "supabase_transient";

export interface ActiveError {
  id: string;                          // "category:normalized_message"
  category: ErrorCategory;
  message: string;                     // original (first occurrence) message
  sampleContext: Record<string, unknown> | undefined;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

// ─── State ──────────────────────────────────────────────────────────────────

const errors = new Map<string, ActiveError>();

// ─── Normalization ──────────────────────────────────────────────────────────

/** Strip variable parts from error messages to produce stable dedup keys. */
function normalizeMessage(msg: string): string {
  return msg
    .replace(/proj_[a-f0-9-]+/g, "<proj>")           // project IDs
    .replace(/batch \d+-\d+/g, "batch <range>")       // batch ranges
    .replace(/\d+\.\d+M/g, "<N>");                    // token counts like 12.3M
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Report an error occurrence. Deduplicates by category:normalized_message.
 * Additive — does not replace console.error, called alongside it.
 */
export function reportError(
  category: ErrorCategory,
  message: string,
  context?: Record<string, unknown>
): void {
  const normalized = normalizeMessage(message);
  const id = `${category}:${normalized}`;
  const now = new Date();

  const existing = errors.get(id);
  if (existing) {
    existing.count++;
    existing.lastSeen = now;
  } else {
    errors.set(id, {
      id,
      category,
      message,
      sampleContext: context,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    });
  }
}

/** Get all active errors (for testing and dashboard). */
export function getActiveErrors(): ActiveError[] {
  return [...errors.values()];
}

/** Clear all in-memory errors (for testing and daemon startup). */
export function clearErrors(): void {
  errors.clear();
}

/** Remove errors by id from the in-memory store. */
export function removeErrors(ids: string[]): void {
  for (const id of ids) errors.delete(id);
}
