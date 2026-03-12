/**
 * Backward-compatibility re-exports.
 * All implementations have moved to src/db/ domain modules.
 * This file will be removed in Task 11 when all consumers are updated.
 */

export { initSupabase, getSupabase, withRetry } from "./db/client";
export { upsertProject, updateProjectActivity } from "./db/projects";
export { insertEvents, pruneOldEvents } from "./db/events";
export { updateFacilityStatus, setFacilitySwitch, updateFacilityMetrics } from "./db/facility";
export { syncDailyMetrics, syncProjectDailyMetrics, deleteProjectDailyMetrics } from "./db/metrics";
export { batchUpsertProjectTelemetry } from "./db/telemetry";
export { pushAgentState } from "./db/agent-state";
export {
  type FacilityUpdate,
  type FacilityMetricsUpdate,
  type ProjectTelemetryUpdate,
  type ProjectEventAggregates,
} from "./db/types";
