# Pipeline Redesign — Spec

## Problem

The telemetry data pipeline has three independent copies of directory-name-to-project-ID resolution that produce different results, a 770-line monolithic sync module with inconsistent error handling, and a verification dashboard that can't agree with the daemon on event counts because they don't share code.

Root cause of the current lorf-bot discrepancy: the daemon resolves `lorf-bot` from disk but doesn't know about the historical `lo-concierge` name. The dashboard's local reader gets it from Supabase's `local_names`, but the daemon never consults that source. Three resolvers, three different answers.

## Goals

1. **Data confidence** — daemon and verify pipeline resolve project names identically because they share a resolver
2. **Error provenance** — every Supabase failure carries operation name, semantic category, and entity context
3. **Modularity** — sync.ts splits into domain modules, each owning one table with documented preconditions
4. **No silent data loss** — buffer overflows, failed registrations, and activity update failures all surface in the Errors tab

## Non-Goals

- Changing the events.log format (owned by Claude Code)
- Persistent on-disk resolution cache (Supabase `local_names` is the durable historical record)
- Generic pipeline abstraction (this is a single-process daemon, not a distributed system)
- Shared filtering/dedup helpers between daemon and verify (they genuinely need different logic — daemon relies on Supabase `ignoreDuplicates`, verify deduplicates locally to predict what the DB holds)

---

## 1. ProjectResolver — Single Resolution Authority

**File:** `src/project/resolver.ts`

### Design

A class that consolidates all dirName → projId resolution into one place. Replaces the three independent resolution paths in daemon.ts, local-reader.ts, and scanner.ts.

### Resolution sources (priority order)

1. **Disk** — reads `project.yml` (falls back to `PROJECT.MD`) from each subdirectory of `PROJECT_ROOT`. This is always ground truth. Uses existing `slug-resolver.ts` internally.
2. **Supabase `local_names`** — historical directory names stored in the `projects` table. Covers renames (e.g., `lo-concierge` → `lorf-bot`). Queried on `refresh()`, merged into in-memory map.
3. **Hardcoded org-root** — `["looselyorganized", "lo"]` → `proj_org-root`. Currently scattered in daemon.ts.
4. **Legacy `.project-mapping.json`** — static fallback for orphaned directories. Currently only used by scanner.ts.

### API

```typescript
class ProjectResolver {
  /** Synchronous, in-memory only. Never hits network or disk. */
  resolve(dirName: string): { projId: string; slug: string } | null;

  /** Async. Rebuilds maps from disk + Supabase. Called at startup and every 60 cycles. */
  async refresh(supabase: SupabaseClient): Promise<void>;

  /** Resolution stats for boot logging. */
  stats(): { total: number; fromDisk: number; fromSupabase: number; fromLegacy: number };
}
```

### Key properties

- `resolve()` is **synchronous** — the 250ms watcher loop calls it and must never await
- `refresh()` reads disk first (ground truth), then merges Supabase `local_names` for historical names, then org-root, then legacy. Disk always wins on conflicts.
- No persistent cache file. The in-memory map rebuilds on every `refresh()`. Supabase `local_names` is the durable historical record — we don't need a second one on disk.
- `slug-resolver.ts` becomes an internal detail — its `buildSlugMap()`, `resolveProjId()`, `clearSlugCache()`, `clearProjIdCache()` are called only by `ProjectResolver`.
- `slug-resolver.ts` already reads `project.yml` (last in priority list after `PROJECT.md`, `project.md`). No code change needed — the existing priority order is fine for now. Reversing it to prefer `project.yml` is a separate concern outside this spec.

### Consumers after refactor

| Consumer | Before | After |
|----------|--------|-------|
| `daemon.ts` | `refreshMaps()` builds local maps, hardcodes org-root | Creates `ProjectResolver`, calls `resolver.refresh()` |
| `local-reader.ts` | Duplicates map-building, receives supplemental map | Receives `ProjectResolver` instance (or builds one identically) |
| `scanner.ts` | Own `resolveProjIdForDir()` with legacy fallback | Calls `resolver.resolve()` |
| `daemon-helpers.ts` | `filterAndMapEntries(entries, toProjId)` | Unchanged — callers pass `(name) => resolver.resolve(name)?.projId ?? null` |

---

## 2. Error Handling — checkResult + Selective DbResult

### checkResult helper

**File:** `src/db/check-result.ts`

Standardizes the `if (error) { console.error; reportError }` pattern across all Supabase operations without changing function signatures.

```typescript
interface ResultContext {
  operation: string;           // "insertEvents", "upsertProject", etc.
  category: ErrorCategory;     // semantic category
  entity?: Record<string, unknown>;  // { projId, batchRange, etc. }
}

/**
 * Checks a Supabase result and reports errors with full context.
 * Returns true if the operation succeeded, false otherwise.
 */
function checkResult(
  result: { error: any; status?: number },
  ctx: ResultContext
): boolean;
```

Every Supabase call site becomes:

```typescript
const result = await supabase.from("events").upsert(batch, ...);
if (!checkResult(result, { operation: "insertEvents", category: "event_write", entity: { batchStart: i } })) {
  errors += batch.length;
  continue;
}
```

### Selective DbResult

Only 2-3 functions that currently return `void` but silently fail get a return type change:

- `updateProjectActivity`: `void` → `boolean` (caller needs to know)
- Individual writes inside `pushAgentState`: wrapped to return `{ ok, error }` so the loop can report per-entity context

Everything else keeps its existing return type. The `checkResult` helper handles consistent error reporting.

### Error categories (semantic, not file-based)

```typescript
type ErrorCategory =
  | "event_write"           // events table failures
  | "project_registration"  // projects table upsert/update failures
  | "facility_state"        // facility_status table failures
  | "metrics_sync"          // daily_metrics table failures
  | "telemetry_sync"        // project_telemetry table failures
  | "supabase_transient";   // 5xx / network errors (any table)
```

**Migration from existing categories:**

| Old | New | Notes |
|-----|-----|-------|
| `sync_write` | `event_write`, `metrics_sync`, `telemetry_sync` | Split by table — each call site maps to its specific category |
| `project_resolution` | `project_registration` | Rename for clarity |
| `facility_update` | `facility_state` | Rename for clarity |
| `supabase_transient` | `supabase_transient` | Unchanged |

Dashboard CSS classes (`.cat-sync_write`, `.cat-project_resolution`, `.cat-facility_update`) must be updated to match. The `clearErrorsTable()` call on daemon startup purges stale rows with old category values.

### What changes

- No `console.error` or `reportError` scattered across db modules — `checkResult` does both
- Per-row insert failures now carry context: `{ operation: "insertEvents.rowFallback", category: "event_write", entity: { projId, eventType } }`
- `pushAgentState` errors carry `{ projId }` or `{ entity: "facility" }` instead of flat "facility_update"
- `updateProjectActivity` failures are visible (currently silent)
- Original upsert error in `upsertProject` is logged (currently swallowed when fallback runs)

---

## 3. Domain Modules — Splitting sync.ts

### Prerequisite: Break errors.ts circular dependency

**Before any split**, decouple `errors.ts` from `sync.ts`:

- `errors.ts` currently imports `getSupabase` from `sync.ts`
- `sync.ts` imports `reportError` from `errors.ts`
- Fix: `errors.ts` accepts a Supabase client via `initErrorFlusher(supabase: SupabaseClient)` called at daemon startup. No more import from sync.

### Module map

| Module | Tables | Functions | Preconditions |
|--------|--------|-----------|---------------|
| `src/db/client.ts` | — | `initSupabase`, `getSupabase`, `withRetry` | Must call `initSupabase` before any other db module |
| `src/db/events.ts` | `events` | `insertEvents`, `pruneOldEvents` | Projects must exist in `projects` table (FK constraint) |
| `src/db/projects.ts` | `projects` | `upsertProject`, `updateProjectActivity` | `initSupabase` called |
| `src/db/facility.ts` | `facility_status` | `updateFacilityStatus`, `updateFacilityMetrics`, `setFacilitySwitch` | `initSupabase` called |
| `src/db/agent-state.ts` | `project_telemetry`, `projects`, `facility_status` | `pushAgentState` | Projects must exist. Replaces flat Promise.all with labeled per-entity writes |
| `src/db/metrics.ts` | `daily_metrics` | `syncDailyMetrics`, `syncProjectDailyMetrics`, `deleteProjectDailyMetrics` | `initSupabase` called |
| `src/db/telemetry.ts` | `project_telemetry` | `batchUpsertProjectTelemetry`, `verifyProjectTelemetry` | Projects must exist (FK). Verification moves to 5-min cycle, filtered by written projIds |
| `src/db/errors.ts` | `exporter_errors` | `flushErrors`, `pruneResolved`, `clearErrorsTable` | `initErrorFlusher` called |
| `src/db/types.ts` | — | Shared types: `FacilityMetrics`, `ProjectTelemetryUpdate`, `ProjectEventAggregates`, etc. | — |

### What stays where

- `src/errors.ts` keeps in-memory error aggregator (`reportError`, `getActiveErrors`, `clearErrors`) — application state, not a db module
- `bin/daemon-helpers.ts` unchanged — formatting and aggregation helpers for the daemon
- `bin/daemon.ts` remains the orchestrator — it knows the ordering: resolve → register projects → insert events → update activity → sync metrics

### Migration order

Each step is independently shippable and testable:

1. **Extract `db/client.ts`** — move `initSupabase`, `getSupabase`, `withRetry`. Add re-exports from `sync.ts` for backward compat. All existing imports still work.
2. **Break `errors.ts` cycle** — add `initErrorFlusher(supabase)`, remove `import { getSupabase } from "./sync"`.
3. **Extract `db/types.ts`** — move shared type definitions. Update imports.
4. **Extract `db/check-result.ts`** — the new error handling helper.
5. **Extract domain modules one at a time** (projects → events → facility → metrics → telemetry → agent-state → errors), each with re-exports from `sync.ts`.
6. **Remove `sync.ts`** once all callers migrated.
7. **ProjectResolver** as a separate step after the split is stable.

---

## 4. Event Buffering and Data Loss Prevention

### Current gaps

1. Buffer overflow (>1000 events per project) logs a warning but doesn't report an error
2. Registration retry only happens when new events arrive for the failed project
3. Drain failures use a different error path than normal inserts

### Fixes

**Buffer overflow reports an error:**
```
reportError("project_registration", "event buffer full — dropping events", { projId, dropped: count })
```
This surfaces in the Errors tab.

**Registration retry with exponential backoff:**

On the 5-minute periodic cycle, iterate `failedRegistrations` and re-attempt `upsertProject`. Backoff per project:

| Attempt | Delay |
|---------|-------|
| 1 | 1 cycle (5 min) |
| 2 | 2 cycles (10 min) |
| 3 | 4 cycles (20 min) |
| 4+ | Cap at 6 cycles (30 min) |
| After 6 failures | Stop retrying, report once daily |

On success: drain buffer via normal `insertEvents` path, clear from `failedRegistrations`.

**Drain uses same error path:**
Buffer drain calls `insertEvents` (same function as normal flow), results go through `checkResult`. No separate error handling for drain vs normal insert.

---

## 5. Verify Pipeline Alignment

### What changes

- `local-reader.ts` receives a `ProjectResolver` instead of building its own projIdMap
- This means local-reader resolves dirNames identically to the daemon (same Supabase `local_names`, same org-root, same legacy fallback)
- The dashboard's `getSnapshot()` in `bin/dashboard.ts` instantiates a `ProjectResolver` and passes it to `readAllLocal()`

### What stays the same

- local-reader still deduplicates events locally (predicts what Supabase holds via conflict key dedup)
- Daemon still relies on Supabase `ignoreDuplicates` (no local dedup needed)
- remote-reader still queries Supabase with the same cutoff logic
- Comparator is unchanged

### What this fixes

- lorf-bot class of bugs: historical dirName `lo-concierge` resolves because `ProjectResolver.refresh()` pulls `local_names` from Supabase
- ORG_ROOT missing in local-reader: `ProjectResolver` handles it, local-reader doesn't need to know
- Any future resolution fix applies to both daemon and verify automatically

---

## 6. Additional Improvements

### verifyProjectTelemetry rate limiting

Move from every 5-second cycle to the 5-minute periodic cycle. Filter by the projIds just written instead of fetching the entire `project_telemetry` table.

### project.yml already supported

`readProjectFrontmatter()` in `slug-resolver.ts` already reads `project.yml` (line 74). Current priority: `PROJECT.md` > `project.md` > `project.yml`. No change needed for this spec. Reversing priority to prefer `project.yml` is a separate concern.

---

## File Impact Summary

### New files
- `src/project/resolver.ts` — ProjectResolver class
- `src/db/client.ts` — Supabase client init and retry
- `src/db/events.ts` — events table operations
- `src/db/projects.ts` — projects table operations
- `src/db/facility.ts` — facility_status operations
- `src/db/agent-state.ts` — pushAgentState with per-entity error context
- `src/db/metrics.ts` — daily_metrics operations
- `src/db/telemetry.ts` — project_telemetry operations
- `src/db/errors.ts` — exporter_errors table operations
- `src/db/check-result.ts` — error handling helper
- `src/db/types.ts` — shared type definitions

### Modified files
- `bin/daemon.ts` — use ProjectResolver, update imports to db/ modules
- `bin/daemon-helpers.ts` — unchanged (callers wrap resolver at call site)
- `bin/dashboard.ts` — instantiate ProjectResolver for local-reader
- `src/errors.ts` — DI for Supabase client, remove sync.ts import
- `src/project/slug-resolver.ts` — becomes internal to ProjectResolver (no feature changes)
- `src/project/scanner.ts` — use ProjectResolver.resolve() instead of own resolution
- `src/verify/local-reader.ts` — receive ProjectResolver, remove duplicated map building

### Deleted files
- `src/sync.ts` — replaced by `src/db/*` modules (after migration complete)
