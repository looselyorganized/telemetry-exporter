/**
 * Agent state push — manages the ephemeral agent_state table in Supabase.
 * INSERT when a new process appears, UPDATE on status/token changes, DELETE on exit.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";
import type { ProcessDiff } from "../process/watcher";
import type { ClaudeProcess } from "../process/scanner";

/** Track which sessions we've already inserted. */
const knownSessions = new Set<string>();

/**
 * Sync agent state from ProcessWatcher diff to Supabase agent_state table.
 */
export async function pushAgentState(
  diff: ProcessDiff,
  processes: ClaudeProcess[],
  isProjectRegistered?: (projId: string) => boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const writes: Promise<unknown>[] = [];
  const supabase = getSupabase();

  // Build a PID→process lookup
  const procByPid = new Map<number, ClaudeProcess>();
  for (const p of processes) procByPid.set(p.pid, p);

  for (const event of diff.events) {
    // For instance:closed, the PID is gone — use event.sessionId captured before cache clear
    if (event.type === "instance:closed") {
      const sessionId = event.sessionId;
      if (!sessionId) continue;
      knownSessions.delete(sessionId);
      writes.push(
        supabase
          .from("agent_state")
          .delete()
          .eq("session_id", sessionId)
          .then((result) => checkResult(result, {
            operation: "agentState.delete",
            category: "agent_state",
            entity: { sessionId },
          }))
      );
      continue;
    }

    // For all other events, look up the current process
    const proc = procByPid.get(event.pid);
    if (!proc?.sessionId || proc.projId === "unknown") continue;
    if (isProjectRegistered && !isProjectRegistered(proc.projId)) continue;

    if (event.type === "instance:created") {
      knownSessions.add(proc.sessionId);
      writes.push(
        supabase
          .from("agent_state")
          .upsert({
            session_id: proc.sessionId,
            project_id: proc.projId,
            pid: proc.pid,
            status: proc.isActive ? "active" : "idle",
            parent_session_id: null,
            started_at: now,
            updated_at: now,
          })
          .then((result) => checkResult(result, {
            operation: "agentState.insert",
            category: "agent_state",
            entity: { sessionId: proc.sessionId },
          }))
      );
    } else if (event.type === "instance:active" || event.type === "instance:idle") {
      writes.push(
        supabase
          .from("agent_state")
          .update({
            status: event.type === "instance:active" ? "active" : "idle",
            updated_at: now,
          })
          .eq("session_id", proc.sessionId)
          .then((result) => checkResult(result, {
            operation: "agentState.updateStatus",
            category: "agent_state",
            entity: { sessionId: proc.sessionId },
          }))
      );
    }
  }

  // Update facility_status heartbeat (status + updated_at only, no token fields)
  writes.push(
    supabase
      .from("facility_status")
      .update({
        active_agents: diff.facility.activeAgents,
        active_projects: diff.facility.activeProjects,
        updated_at: now,
      })
      .eq("id", 1)
      .then((result) => checkResult(result, {
        operation: "agentState.facilityHeartbeat",
        category: "facility_state",
      }))
  );

  await Promise.all(writes);
}
