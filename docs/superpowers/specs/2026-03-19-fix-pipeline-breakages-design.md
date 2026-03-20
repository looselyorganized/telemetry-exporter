# Fix Telemetry Pipeline Breakages

**Date:** 2026-03-19
**Status:** Draft
**Scope:** telemetry-exporter (code + DB migration), verification dashboard

## Problem

The outbox pipeline refactor (`1fe5295`) introduced 4 bugs that break the platform's telemetry display:

| # | Bug | Root Cause | Platform Impact |
|---|-----|-----------|-----------------|
| 1 | `facility_status.tokens_today = 0` | `processMetrics()` reads `tokens_today` from `~/.claude/stats-cache.json` `dailyModelTokens`, which stopped at Feb 18 on disk. Old daemon computed it from JSONL tokenMap per project. | Hero dash shows "0 tokens 24h" |
| 2 | 14k failed `daily_metrics` rows | Shipper uses `onConflict: "date,project_id"` but no unique constraint exists on that pair. Old daemon used INSERT + UPDATE-by-ID pattern. | Daily activity chart missing recent data |
| 3 | 81 failed `projects` rows | `processEvents()` enqueues activity updates as `{id, last_active}` without `slug`. Upsert tries INSERT first, which fails on `slug NOT NULL` before reaching the ON CONFLICT UPDATE path. Old daemon had separate `updateProjectActivity()` using UPDATE...WHERE. | Project `last_active` frozen |
| 4 | Daily chart double-counting | `getDailyActivity()` sums ALL `daily_metrics` rows per date. Global rows (`project_id IS NULL`) and per-project rows overlap for Jan 15 – Feb 18, inflating totals. | Inaccurate historical chart |

## Design

### 1. Eliminate global `daily_metrics` rows

Global rows (project_id IS NULL) are a denormalized duplicate — the platform's `getDailyActivity()` already aggregates per-project rows per date. Two sources of truth for the same data is the design problem.

**Code changes:**
- `processor.ts` `processMetrics()`: Remove lines 417-435 that generate global daily_metrics rows (the `globalDailyRows` array and its enqueue loop)
- `processor.ts` `processMetrics()`: Remove `globalDailyRows` from the metrics hash input (line 438) since it no longer exists

**DB migration (3 statements, applied in order):**
```sql
DELETE FROM daily_metrics WHERE project_id IS NULL;
ALTER TABLE daily_metrics ALTER COLUMN project_id SET NOT NULL;
CREATE UNIQUE INDEX idx_daily_metrics_date_project ON daily_metrics (date, project_id);
```

**Verification dashboard:**
- `src/verify/remote-reader.ts` `readRemoteMetrics()`: Currently queries `.is("project_id", null)` (line 99). Replace with a fetch of all per-project rows and client-side aggregation by date (Supabase PostgREST does not support GROUP BY):
```ts
const { data, error } = await supabase
  .from("daily_metrics")
  .select("date, messages, sessions, tool_calls")
  .order("date", { ascending: true });
// Aggregate by date client-side (same pattern as platform's getDailyActivity)
```
- `src/verify/outbox-reader.ts`: The outbox reader's SQL handles NULL project_id rows. After the fix, no new NULL rows are produced. This becomes harmless dead code — no change needed, but noted for awareness.
- `src/verify/comparator.ts` and its test: The `RemoteMetrics` shape (`dailyActivity` array of `{date, messages, sessions, toolCalls}`) is unchanged — only the source of the data changes. No modifications needed.

**Tests:**
- `src/pipeline/__tests__/processor.test.ts` lines 620-652: Remove the entire test `"enqueues global daily_metrics to outbox"` — its sole purpose is to verify global row creation, which no longer happens.

**Files touched:**
- `src/pipeline/processor.ts`
- `src/verify/remote-reader.ts`
- `src/pipeline/__tests__/processor.test.ts`

### 2. Fix `facility_status.tokens_today`

**Problem:** `processMetrics()` reads `tokens_today` from `statsCache.dailyModelTokens`. The file `~/.claude/stats-cache.json` is re-read from disk every cycle by `MetricsReceiver.poll()`, but the file itself hasn't had `dailyModelTokens` entries past Feb 18. The data source is unreliable.

**Fix:** Compute `tokens_today` from the per-project tokenMap (JSONL session files), which is the same authoritative source used by `processTokens()`.

**Implementation:**
- Add a `private todayTokensTotal: number = 0` field to the `Processor` class.
- In `processTokens()`, compute today's per-project tokens **unconditionally** (before the `hasChanges` guard at line 127), and store the sum in `this.todayTokensTotal`. Only gate the `enqueue` operations on `hasChanges`.
- In `processMetrics()`, replace the `statsCache.dailyModelTokens` lookup (lines 389-396) with `this.todayTokensTotal`.

**Cold-start safety:** Because the computation happens unconditionally (before the baseline diff guard), `tokens_today` will be correct even on the first cycle after daemon restart when `processTokens()` might skip enqueuing due to matching baselines.

**Note:** `processMetrics()` still reads `statsCache` for `hourCounts` and `firstSessionDate`. These fields are unrelated to tokens and are not affected by this change. `statsCache` remains a dependency for non-token facility metadata.

**Files touched:**
- `src/pipeline/processor.ts`

### 3. Fix `projects` activity updates

**Problem:** `processEvents()` line 98 enqueues `{ id: projId, last_active: lastActive }` as a projects row. The shipper upserts this with `onConflict: "id"`. Postgres tries INSERT first — fails on `slug NOT NULL` before ever reaching the ON CONFLICT UPDATE path.

**Fix:** Include `slug` in all project payloads. The resolver result (available in the `resolved` array at line 53) already contains the slug. Build a `Map<projId, slug>` from resolved entries and use it at line 98:

```ts
// Build slug lookup from resolved entries
const slugByProject = new Map<string, string>();
for (const { projId, slug } of resolved) {
  slugByProject.set(projId, slug);
}

// Activity updates include slug
for (const [projId, lastActive] of latestByProject) {
  enqueue("projects", { id: projId, slug: slugByProject.get(projId), last_active: lastActive });
}
```

**Files touched:**
- `src/pipeline/processor.ts`

### 4. Outbox cleanup

After deploying fixes and running migrations, purge the poisoned rows from the SQLite outbox so they don't clog the dashboard or get accidentally re-queued.

**Implementation:** Add a `purgeFailed()` function to `src/db/local.ts`:
```ts
export function purgeFailed(): number {
  const db = getLocal();
  const result = db.run("DELETE FROM outbox WHERE status = 'failed'");
  return result.changes;
}
```

Call it at daemon startup immediately after `initLocal(DB_PATH)` (line 84 in `daemon.ts`), before resolver init or any pipeline processing. Log the count. This is safe because failed rows are permanently terminal — `dequeueUnshipped()` only picks up `pending` rows.

**Files touched:**
- `src/db/local.ts`
- `bin/daemon.ts`

### 5. Backfill

After cleanup, run `bun run backfill` to recompute and ship clean per-project daily_metrics for the full history. The backfill process:
1. Calls `deleteProjectDailyMetrics()` — removes existing per-project rows from Supabase
2. Reads all entries from events.log
3. Scans all JSONL token files
4. Processes everything through the pipeline
5. Ships to Supabase

**Known limitation:** Session/message/tool_call counts in daily_metrics come from event aggregation in the outbox SQL query, which is populated from `events.log`. If `events.log` has been rotated, older dates will have token data (from JSONL files) but zero event counts. This was always the case — backfill quality depends on log availability.

**Cleanup:**
- `src/db/metrics.ts` `deleteProjectDailyMetrics()`: Remove the `.not("project_id", "is", null)` filter and stale comment "Global rows (project IS NULL) are left untouched" — dead logic after NOT NULL constraint.
- `src/pipeline/processor.ts` `_loadBaselinesFromSupabase()`: The `.not("project_id", "is", null)` filters on lines 330 and 346 become redundant after the NOT NULL constraint. Remove for consistency.

**Files touched:**
- `src/db/metrics.ts`
- `src/pipeline/processor.ts` (additional cleanup in `_loadBaselinesFromSupabase`)

## Deployment Order

**This order is critical.** Wrong sequencing causes cascading shipping failures.

1. **Stop the daemon** (`lo-close` or `launchctl unload`)
2. **Run DB migration** (3 SQL statements above)
3. **Deploy new code** (all file changes)
4. **Start daemon with backfill** (`bun run backfill`)
5. **Verify** via dashboard that outbox drains to zero and `facility_status.tokens_today > 0`

## Files Changed (Summary)

| File | Change |
|------|--------|
| `src/pipeline/processor.ts` | Remove global daily rows, fix tokens_today computation, fix project activity slug |
| `src/pipeline/__tests__/processor.test.ts` | Remove entire global daily_metrics test (lines 620-652) |
| `src/verify/remote-reader.ts` | Aggregate per-project rows instead of querying project_id IS NULL |
| `src/db/local.ts` | Add `purgeFailed()` function |
| `src/db/metrics.ts` | Remove dead `.not("project_id", "is", null)` filter and stale comment |
| `bin/daemon.ts` | Call `purgeFailed()` at startup |
| Supabase migration | DELETE global rows, NOT NULL constraint, unique index |

## What Is NOT Changed

- **Shipper** — `onConflict: "date,project_id"` stays as-is, now backed by a real constraint
- **Platform** — `getDailyActivity()` already aggregates per-project rows; no changes needed
- **Events pipeline** — working correctly (43k shipped)
- **Project telemetry pipeline** — working correctly (740 shipped)
- **`statsCache` dependency** — still used for `hourCounts` and `firstSessionDate` in `processMetrics()`
