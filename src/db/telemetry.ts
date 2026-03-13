/**
 * Project telemetry upserts.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";
import { formatTokens, type ProjectTelemetryUpdate } from "./types";

interface ProjectTelemetryRow {
  id: string;
  tokens_lifetime: number;
  tokens_today: number;
  models_today: Record<string, number>;
  sessions_lifetime: number;
  messages_lifetime: number;
  tool_calls_lifetime: number;
  agent_spawns_lifetime: number;
  team_messages_lifetime: number;
  updated_at: string;
  active_agents?: number;
  agent_count?: number;
}

export async function batchUpsertProjectTelemetry(
  updates: ProjectTelemetryUpdate[],
  options: { skipAgentFields?: boolean } = {}
): Promise<void> {
  if (updates.length === 0) return;

  const now = new Date().toISOString();

  function toRow(u: ProjectTelemetryUpdate): ProjectTelemetryRow {
    const row: ProjectTelemetryRow = {
      id: u.projId,
      tokens_lifetime: u.tokensLifetime,
      tokens_today: u.tokensToday,
      models_today: u.modelsToday,
      sessions_lifetime: u.sessionsLifetime,
      messages_lifetime: u.messagesLifetime,
      tool_calls_lifetime: u.toolCallsLifetime,
      agent_spawns_lifetime: u.agentSpawnsLifetime,
      team_messages_lifetime: u.teamMessagesLifetime,
      updated_at: now,
    };
    if (!options.skipAgentFields) {
      row.active_agents = u.activeAgents;
      row.agent_count = u.agentCount;
    }
    return row;
  }

  console.log(
    `  project_telemetry: writing ${updates.length} rows —`,
    updates.map((u) => `${u.projId}: ${formatTokens(u.tokensLifetime)}`).join(", ")
  );

  // Try batch upsert first (fast path)
  const rows = updates.map(toRow);
  const { error } = await getSupabase()
    .from("project_telemetry")
    .upsert(rows, { onConflict: "id" });

  if (error) {
    // Batch failed (likely FK violation) -- fall back to per-row upserts
    console.error(`  project_telemetry: batch upsert failed (${error.message}), falling back to per-row`);
    checkResult(
      { error },
      { operation: "batchUpsertProjectTelemetry.batch", category: "telemetry_sync" }
    );
    let succeeded = 0;
    for (const update of updates) {
      const rowResult = await getSupabase()
        .from("project_telemetry")
        .upsert(toRow(update), { onConflict: "id" });
      if (rowResult.error) {
        console.error(`  project_telemetry: skipping ${update.projId} (${rowResult.error.message})`);
        checkResult(rowResult, {
          operation: "batchUpsertProjectTelemetry.row",
          category: "telemetry_sync",
          entity: { projId: update.projId },
        });
      } else {
        succeeded++;
      }
    }
    console.log(`  project_telemetry: ${succeeded}/${updates.length} rows updated (batch fallback)`);
  }

  // Verify: read back and compare tokens_lifetime
  await verifyProjectTelemetry(updates);
}

/**
 * Read back project_telemetry rows and log any mismatches against expected values.
 */
async function verifyProjectTelemetry(updates: ProjectTelemetryUpdate[]): Promise<void> {
  const { data: rows } = await getSupabase()
    .from("project_telemetry")
    .select("id, tokens_lifetime");

  if (!rows) return;

  const dbValues = new Map(rows.map((r) => [r.id as string, Number(r.tokens_lifetime)]));
  let mismatches = 0;

  for (const u of updates) {
    const dbVal = dbValues.get(u.projId);
    if (dbVal !== undefined && dbVal !== u.tokensLifetime) {
      console.error(
        `  project_telemetry MISMATCH: ${u.projId} — wrote ${formatTokens(u.tokensLifetime)} but DB has ${formatTokens(dbVal)}`
      );
      mismatches++;
    }
  }

  if (mismatches === 0) {
    console.log(`  project_telemetry: verified ${updates.length} rows match DB`);
  }
}
