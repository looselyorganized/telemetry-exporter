/**
 * Event insertion and pruning.
 */

import type { LogEntry } from "../parsers";
import { getSupabase, withRetry } from "./client";
import { checkResult } from "./check-result";
import type { InsertEventsResult } from "./types";

const EMPTY_INSERT_RESULT: InsertEventsResult = { inserted: 0, errors: 0, insertedByProject: {} };

/**
 * Insert a batch of events.
 * Uses upsert with ignoreDuplicates to skip events that already exist
 * (unique index on project, event_type, event_text, timestamp).
 */
export async function insertEvents(entries: LogEntry[]): Promise<InsertEventsResult> {
  if (entries.length === 0) return EMPTY_INSERT_RESULT;

  const rows = entries
    .filter((e) => e.parsedTimestamp)
    .map((e) => ({
      timestamp: e.parsedTimestamp!.toISOString(),
      initiative_id: e.project,
      branch: e.branch || null,
      emoji: e.emoji || null,
      event_type: e.eventType,
      event_text: e.eventText,
    }));

  let inserted = 0;
  let errors = 0;
  const insertedByProject: Record<string, number> = {};
  const BATCH_SIZE = 500;

  function countInserted(projectRows: typeof rows): void {
    for (const row of projectRows) {
      if (row.initiative_id) {
        insertedByProject[row.initiative_id] = (insertedByProject[row.initiative_id] ?? 0) + 1;
      }
    }
  }

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error, status } = await withRetry(
      () => getSupabase()
        .from("events")
        .upsert(batch, { onConflict: "initiative_id,event_type,event_text,timestamp", ignoreDuplicates: true }),
      `events batch ${i}-${i + batch.length}`
    );

    if (error) {
      const errorStatus = status ?? 0;
      const ctx = { operation: "insertEvents.batch", category: "event_write" as const, entity: { batchStart: i, batchEnd: i + batch.length } };

      if (errorStatus >= 500) {
        console.error(`  events: batch ${i}-${i + batch.length} failed (HTTP ${errorStatus}: ${error.message}), skipping — will retry next cycle`);
        checkResult({ error, status: errorStatus }, ctx);
        errors += batch.length;
        continue;
      }

      console.error(`  events: batch ${i}-${i + batch.length} failed (${error.message}), falling back to per-row`);
      checkResult({ error, status: errorStatus }, ctx);
      let recovered = 0;
      for (const row of batch) {
        const { error: rowError } = await getSupabase()
          .from("events")
          .upsert(row, { onConflict: "initiative_id,event_type,event_text,timestamp", ignoreDuplicates: true });
        if (rowError) {
          errors++;
        } else {
          inserted++;
          recovered++;
          countInserted([row]);
        }
      }
      console.log(`  events: ${recovered}/${batch.length} recovered (batch fallback)`);
      continue;
    }

    inserted += batch.length;
    countInserted(batch);
  }

  return { inserted, errors, insertedByProject };
}

/**
 * Delete events older than the retention period.
 * Aggregated data lives in daily_metrics; old events only bloat the table.
 */
export async function pruneOldEvents(retentionDays = 14): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const { count, error } = await getSupabase()
    .from("events")
    .delete({ count: "exact" })
    .lt("timestamp", cutoff.toISOString());

  if (error) {
    checkResult(
      { error },
      { operation: "pruneOldEvents", category: "event_write" }
    );
    return 0;
  }

  return count ?? 0;
}
