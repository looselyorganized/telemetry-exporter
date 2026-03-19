/**
 * Facility status operations.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";

/**
 * Set the facility open/close status.
 * Only called by lo-open/lo-close commands and the auto-close timer.
 */
export async function setFacilitySwitch(status: "active" | "dormant"): Promise<void> {
  const result = await getSupabase()
    .from("facility_status")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", 1);

  checkResult(result, { operation: "setFacilitySwitch", category: "facility_state" });
}
