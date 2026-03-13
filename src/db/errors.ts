/**
 * Supabase error table operations.
 * Separated from src/errors.ts to break the circular sync.ts ↔ errors.ts dependency.
 */

import { getSupabase } from "./client";
import { getActiveErrors, removeErrors } from "../errors";

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

export async function pruneResolved(): Promise<number> {
  const cutoff = Date.now() - 5 * 60 * 1000;
  const toRemove: string[] = [];

  for (const err of getActiveErrors()) {
    if (err.lastSeen.getTime() < cutoff) {
      toRemove.push(err.id);
    }
  }

  if (toRemove.length === 0) return 0;

  removeErrors(toRemove);

  try {
    await getSupabase()
      .from("exporter_errors")
      .delete()
      .in("id", toRemove);
  } catch {
    // Silent — rows cleaned up on next daemon restart
  }

  return toRemove.length;
}

export async function clearErrorsTable(): Promise<void> {
  try {
    await getSupabase()
      .from("exporter_errors")
      .delete()
      .neq("id", "");
  } catch {
    // Silent — best-effort cleanup
  }
}
