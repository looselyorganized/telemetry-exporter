/**
 * Facility status operations.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";
import type { FacilityMetrics, FacilityUpdate, FacilityMetricsUpdate } from "./types";

/** Map FacilityMetrics fields to the DB column names. */
function metricsToRow(metrics: FacilityMetrics): Record<string, unknown> {
  return {
    tokens_lifetime: metrics.tokensLifetime,
    tokens_today: metrics.tokensToday,
    sessions_lifetime: metrics.sessionsLifetime,
    messages_lifetime: metrics.messagesLifetime,
    model_stats: metrics.modelStats,
    hour_distribution: metrics.hourDistribution,
    first_session_date: metrics.firstSessionDate,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Update the singleton facility_status row with agent fields and aggregate metrics.
 * NOTE: status is NOT written here -- it's owned by the manual switch (lo-open/lo-close).
 */
export async function updateFacilityStatus(update: FacilityUpdate): Promise<void> {
  const result = await getSupabase()
    .from("facility_status")
    .update({
      ...metricsToRow(update),
      active_agents: update.activeAgents,
      active_projects: update.activeProjects,
    })
    .eq("id", 1);

  checkResult(result, { operation: "updateFacilityStatus", category: "facility_state" });
}

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

/**
 * Update aggregate metrics on facility_status.
 * Does NOT write agent fields (status, active_agents, active_projects) --
 * those are owned by the ProcessWatcher via pushAgentState().
 */
export async function updateFacilityMetrics(update: FacilityMetricsUpdate): Promise<void> {
  const result = await getSupabase()
    .from("facility_status")
    .update(metricsToRow(update))
    .eq("id", 1);

  checkResult(result, { operation: "updateFacilityMetrics", category: "facility_state" });
}
