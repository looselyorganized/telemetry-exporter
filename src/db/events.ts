/**
 * Event pruning.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";

/**
 * Delete events older than the retention period.
 * Aggregated data lives in daily_metrics; old events only bloat the table.
 */
export async function pruneOldEvents(retentionDays = 14): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const { count, error } = await getSupabase()
    .from("events")
    .delete({ count: "exact" })
    .lt("timestamp", cutoff.toISOString());

  if (error) {
    checkResult(
      { error },
      { operation: "pruneOldEvents", category: "event_write" }
    );
    return 0;
  }

  return count ?? 0;
}
