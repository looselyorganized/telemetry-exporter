/**
 * Daily metrics operations.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";

/**
 * Delete all per-project daily_metrics rows.
 * Used before backfill to ensure stale inflated rows don't persist.
 * Global rows (project IS NULL) are left untouched.
 */
export async function deleteProjectDailyMetrics(): Promise<number> {
  const result = await getSupabase()
    .from("daily_metrics")
    .delete({ count: "exact" })
    .not("project_id", "is", null);

  if (!checkResult(result, { operation: "deleteProjectDailyMetrics", category: "metrics_sync" })) {
    return 0;
  }

  return result.count ?? 0;
}
