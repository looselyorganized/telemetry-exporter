/**
 * Agent state push from ProcessWatcher.
 * Each write is individually labeled for error provenance.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";
import type { ProcessDiff } from "../process/watcher";

/**
 * Push agent state changes from the ProcessWatcher.
 * Only writes agent-related fields — never touches aggregate metrics.
 */
export async function pushAgentState(diff: ProcessDiff): Promise<void> {
  const now = new Date().toISOString();

  // Per-project telemetry updates (agent counts) + last_active for active agents
  for (const [projId, counts] of diff.byProject) {
    const telemetryResult = await getSupabase()
      .from("project_telemetry")
      .update({
        active_agents: counts.active,
        agent_count: counts.count,
        updated_at: now,
      })
      .eq("project_id", projId);

    checkResult(telemetryResult, {
      operation: "pushAgentState.projectTelemetry",
      category: "telemetry_sync",
      entity: { projId },
    });

    if (counts.active > 0) {
      const activeResult = await getSupabase()
        .from("projects")
        .update({ last_active: now })
        .eq("id", projId);

      checkResult(activeResult, {
        operation: "pushAgentState.lastActive",
        category: "project_registration",
        entity: { projId },
      });
    }
  }

  // Facility agent fields (status is owned by lo-open/lo-close)
  const facilityResult = await getSupabase()
    .from("facility_status")
    .update({
      active_agents: diff.facility.activeAgents,
      active_projects: diff.facility.activeProjects,
      updated_at: now,
    })
    .eq("id", 1);

  checkResult(facilityResult, {
    operation: "pushAgentState.facility",
    category: "facility_state",
  });
}
