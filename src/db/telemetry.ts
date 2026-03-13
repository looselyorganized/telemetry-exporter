/**
 * Project telemetry upserts.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";
import { formatTokens, type ProjectTelemetryUpdate } from "./types";

interface ProjectTelemetryRow {
  initiative_id: string;
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
): Promise<{ writtenProjIds: string[] }> {
  if (updates.length === 0) return { writtenProjIds: [] };

  const now = new Date().toISOString();

  function toRow(u: ProjectTelemetryUpdate): ProjectTelemetryRow {
    const row: ProjectTelemetryRow = {
      initiative_id: u.projId,
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
    .upsert(rows, { onConflict: "initiative_id" });

  if (error) {
    // Batch failed (likely FK violation) -- fall back to per-row upserts
    console.error(`  project_telemetry: batch upsert failed (${error.message}), falling back to per-row`);
    checkResult(
      { error },
      { operation: "batchUpsertProjectTelemetry.batch", category: "telemetry_sync" }
    );
    const writtenProjIds: string[] = [];
    for (const update of updates) {
      const rowResult = await getSupabase()
        .from("project_telemetry")
        .upsert(toRow(update), { onConflict: "initiative_id" });
      if (rowResult.error) {
        console.error(`  project_telemetry: skipping ${update.projId} (${rowResult.error.message})`);
        checkResult(rowResult, {
          operation: "batchUpsertProjectTelemetry.row",
          category: "telemetry_sync",
          entity: { projId: update.projId },
        });
      } else {
        writtenProjIds.push(update.projId);
      }
    }
    console.log(`  project_telemetry: ${writtenProjIds.length}/${updates.length} rows updated (batch fallback)`);
    return { writtenProjIds };
  }

  return { writtenProjIds: updates.map((u) => u.projId) };
}

/**
 * Read back project_telemetry rows and log any mismatches against expected values.
 * When projIds is provided, only fetches those rows (efficient for periodic checks).
 * When omitted, fetches all rows (used during backfill verification).
 */
export async function verifyProjectTelemetry(
  updates: ProjectTelemetryUpdate[],
  projIds?: string[]
): Promise<void> {
  let query = getSupabase()
    .from("project_telemetry")
    .select("initiative_id, tokens_lifetime");

  if (projIds && projIds.length > 0) {
    query = query.in("initiative_id", projIds);
  }

  const { data: rows } = await query;

  if (!rows) return;

  const dbValues = new Map(rows.map((r) => [r.initiative_id as string, Number(r.tokens_lifetime)]));
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
    const scope = projIds ? `${projIds.length} filtered` : `${updates.length}`;
    console.log(`  project_telemetry: verified ${scope} rows match DB`);
  }
}
