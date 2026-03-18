/**
 * Agent state push from ProcessWatcher.
 * Each write is individually labeled for error provenance.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";
import type { ProcessDiff } from "../process/watcher";

/** Last-written per-project state for dirty checking. */
const lastWrittenState = new Map<string, { count: number; active: number }>();

/**
 * Push agent state changes from the ProcessWatcher.
 * Only writes agent-related fields — never touches aggregate metrics.
 */
export async function pushAgentState(diff: ProcessDiff): Promise<void> {
  const now = new Date().toISOString();
  const writes: Promise<unknown>[] = [];

  // Per-project telemetry updates (dirty-checked + parallel)
  for (const [projId, counts] of diff.byProject) {
    const last = lastWrittenState.get(projId);

    // Skip if nothing changed for this project
    if (last && last.count === counts.count && last.active === counts.active) {
      continue;
    }

    const wasActive = last ? last.active > 0 : false;
    lastWrittenState.set(projId, { count: counts.count, active: counts.active });

    writes.push(
      getSupabase()
        .from("project_telemetry")
        .update({
          active_agents: counts.active,
          agent_count: counts.count,
          updated_at: now,
        })
        .eq("project_id", projId)
        .then((result) => {
          checkResult(result, {
            operation: "pushAgentState.projectTelemetry",
            category: "telemetry_sync",
            entity: { projId },
          });
        })
    );

    // Only write last_active on idle→active transition
    if (counts.active > 0 && !wasActive) {
      writes.push(
        getSupabase()
          .from("projects")
          .update({ last_active: now })
          .eq("id", projId)
          .then((result) => {
            checkResult(result, {
              operation: "pushAgentState.lastActive",
              category: "project_registration",
              entity: { projId },
            });
          })
      );
    }
  }

  // Clear cache for projects with no remaining processes
  for (const projId of lastWrittenState.keys()) {
    if (!diff.byProject.has(projId)) {
      lastWrittenState.delete(projId);
    }
  }

  // Facility write is always included (carries global state)
  writes.push(
    getSupabase()
      .from("facility_status")
      .update({
        active_agents: diff.facility.activeAgents,
        active_projects: diff.facility.activeProjects,
        updated_at: now,
      })
      .eq("id", 1)
      .then((result) => {
        checkResult(result, {
          operation: "pushAgentState.facility",
          category: "facility_state",
        });
      })
  );

  await Promise.all(writes);
}
