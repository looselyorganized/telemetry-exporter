/**
 * Lightweight in-memory error aggregator for the telemetry daemon.
 * Deduplicates errors by category:normalized_message and flushes to Supabase.
 */

import { getSupabase } from "./sync";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ErrorCategory = "sync_write" | "project_resolution" | "supabase_transient" | "facility_update";

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

/**
 * Flush active errors to the exporter_errors Supabase table.
 * Upserts on id (the dedup key). Silently fails if Supabase is unreachable
 * (errors remain in memory for next cycle). Does not report its own failures.
 */
export async function flushErrors(): Promise<void> {
  const active = getActiveErrors();
  if (active.length === 0) return;

  try {
    const rows = active.map((e) => ({
      id: e.id,
      category: e.category,
      message: e.message,
      sample_context: e.sampleContext ?? null,
      count: e.count,
      first_seen: e.firstSeen.toISOString(),
      last_seen: e.lastSeen.toISOString(),
    }));

    await getSupabase()
      .from("exporter_errors")
      .upsert(rows, { onConflict: "id" });
  } catch {
    // Silent failure — errors stay in memory for next flush
  }
}

/**
 * Prune errors not seen in the last 5 minutes from memory and Supabase.
 * Returns the number of pruned errors.
 */
export async function pruneResolved(): Promise<number> {
  const cutoff = Date.now() - 5 * 60 * 1000;
  const toRemove: string[] = [];

  for (const [id, err] of errors) {
    if (err.lastSeen.getTime() < cutoff) {
      toRemove.push(id);
    }
  }

  if (toRemove.length === 0) return 0;

  for (const id of toRemove) {
    errors.delete(id);
  }

  try {
    await getSupabase()
      .from("exporter_errors")
      .delete()
      .in("id", toRemove);
  } catch {
    // Silent — rows will be cleaned up on next daemon restart anyway
  }

  return toRemove.length;
}

/**
 * Clear the exporter_errors table in Supabase.
 * Called on daemon startup — table represents live state, not history.
 */
export async function clearErrorsTable(): Promise<void> {
  try {
    await getSupabase()
      .from("exporter_errors")
      .delete()
      .neq("id", "");  // delete all rows
  } catch {
    // Silent — best-effort cleanup
  }
}
