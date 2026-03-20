/**
 * Daily metrics operations.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";

/**
 * Delete all daily_metrics rows.
 * Used before backfill to ensure stale rows don't persist.
 */
export async function deleteProjectDailyMetrics(): Promise<number> {
  const result = await getSupabase()
    .from("daily_metrics")
    .delete({ count: "exact" })
    .neq("id", 0); // match all rows (Supabase requires a filter)

  if (!checkResult(result, { operation: "deleteProjectDailyMetrics", category: "metrics_sync" })) {
    return 0;
  }

  return result.count ?? 0;
}
