# Dashboard Error View

**Date**: 2026-03-12
**Status**: Approved

## Problem

The telemetry daemon produces errors (Supabase write failures, FK violations, transient outages) that are only visible in launchd log files (~219K lines of noise). There's no way to see active errors from the dashboard.

## Design

### Error Reporter Module (`src/errors.ts`)

A lightweight in-memory error aggregator that deduplicates and flushes to Supabase.

**Interface:**
```ts
reportError(category: ErrorCategory, message: string, context?: Record<string, unknown>): void
flushErrors(): Promise<void>
pruneResolved(): Promise<number>
```

Uses the existing `getSupabase()` singleton internally — consistent with the rest of the sync layer.

**Categories:** `sync_write`, `project_resolution`, `supabase_transient`, `facility_update`

**Deduplication key:** `category:normalized_message` stored as a plain string (no hash — the key space is small and readable keys aid debugging).

**Normalization rules** — strip variable parts before keying:

| Pattern | Example | Normalized |
|---------|---------|------------|
| Project IDs (`proj_[a-f0-9-]+`) | `skipping proj_abc123 (FK error)` | `skipping <proj> (FK error)` |
| Batch ranges (`batch \d+-\d+`) | `batch 0-500 failed` | `batch <range> failed` |
| Token counts (`\d+\.\d+M`) | `wrote 12.3M but DB has 11.9M` | `wrote <N> but DB has <N>` |
| Numeric values in context | `HTTP 502`, `retry 2/3` | kept as-is (these are useful for categorization) |

Each unique error tracks:
- `count` — total occurrences
- `first_seen` — when this error first appeared
- `last_seen` — most recent occurrence
- `sample_context` — the first occurrence's details (project_id, HTTP status, etc.)

**Lifecycle:**
1. Daemon code calls `reportError()` at each error site (additive — `console.error` stays)
2. Every aggregator cycle (5s), `flushErrors()` upserts active errors to Supabase — called at the end of `incrementalSync()`, after all writes that might generate errors
3. `pruneResolved()` runs after `flushErrors()` — deletes errors not seen in 5 minutes from both memory and the Supabase table

**Startup behavior:** On daemon startup, all rows in `exporter_errors` are deleted. The table represents live daemon state, not historical data. This prevents zombie rows from accumulating across restarts.

**`flushErrors` failure:** If Supabase is unreachable, flush silently fails. Errors remain in memory and will flush on the next successful cycle. No recursion (error reporter does not report its own flush failures).

### Supabase Table

```sql
create table exporter_errors (
  id text primary key,            -- plain string: "category:normalized_message"
  category text not null,
  message text not null,
  sample_context jsonb,
  count integer not null default 1,
  first_seen timestamptz not null,
  last_seen timestamptz not null
);
```

No foreign keys, no additional indexes. Table stays small by design (errors auto-prune after 5 minutes of inactivity, table cleared on daemon restart).

### Dashboard Changes

**New tab: "Errors"**
- Table of active errors sorted by `last_seen` descending
- Columns: category (colored badge), message, count, first seen, last seen
- Expandable row shows `sample_context` as formatted JSON
- Empty state: green "No active errors" message

**Health bar update:**
- Add error indicator dot: green when no errors, red when errors exist
- Show count: "Errors: 3" or "Errors: none"

**New API endpoint:**
- `GET /api/errors` — returns all rows from `exporter_errors` ordered by `last_seen` desc

### Error Sites in Daemon

Add `reportError()` calls alongside existing `console.error` at these locations:

**`src/sync.ts`:**

| Location | Category | Context |
|----------|----------|---------|
| `insertEvents` batch failure + per-row fallback | `sync_write` | batch range, error message |
| `batchUpsertProjectTelemetry` batch/row failure | `sync_write` | project_id, error message |
| `updateFacilityStatus` | `facility_update` | error message |
| `updateFacilityMetrics` | `facility_update` | error message |
| `setFacilitySwitch` | `facility_update` | error message |
| `syncProjectDailyMetrics` bulk insert error | `sync_write` | error message |
| `deleteProjectDailyMetrics` | `sync_write` | error message |
| `pruneOldEvents` | `sync_write` | error message |
| `pushAgentState` per-result errors | `facility_update` | error message |
| `upsertProject` failure | `project_resolution` | project_id, slug |
| `withRetry` transient errors | `supabase_transient` | HTTP status, retry count, label |

**`bin/daemon.ts`:**

| Location | Category | Context |
|----------|----------|---------|
| `ensureProjects` registration failure | `project_resolution` | project_id, slug |
| `maybeSyncProjectDailyMetrics` catch | `sync_write` | error |
| `maybePruneEvents` catch | `sync_write` | error |
| Watcher loop catch | `facility_update` | error |
| Aggregate loop catch | `sync_write` | error |
| Periodic task settled rejections | `sync_write` | reason |

**Excluded:** CLI entry points (`lo-open`, `lo-close`, `lo-status`) — these are interactive commands, not daemon-loop errors.

### What Doesn't Change

- `console.log` / `console.error` remain for log file output
- Existing dashboard tabs (Events, Metrics, Tokens, Models, Projects) untouched
- No changes to existing Supabase tables
- No changes to the verification comparison system
