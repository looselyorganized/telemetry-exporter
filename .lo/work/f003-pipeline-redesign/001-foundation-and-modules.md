---
status: done
feature_id: "f003"
feature: "Pipeline Redesign"
phase: 1
---

# Pipeline Redesign — Phase 1: Foundation & Domain Modules

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 770-line `src/sync.ts` into focused `src/db/*` domain modules with standardized error handling via `checkResult`.

**Architecture:** Extract Supabase client, types, and error handling helper first (foundation), then extract each domain module one at a time with backward-compat re-exports from sync.ts. Finally remove sync.ts once all callers migrated.

**Tech Stack:** Bun, TypeScript, Supabase JS client, bun:test

**Spec:** `.lo/work/f003-pipeline-redesign/spec.md`

---

## File Structure

### New files (created in this phase)

```
src/db/
  client.ts         # initSupabase, getSupabase, withRetry
  types.ts          # ModelTokenBreakdown, FacilityMetrics, InsertEventsResult, etc.
  check-result.ts   # checkResult helper + ErrorCategory type
  projects.ts       # upsertProject, updateProjectActivity
  events.ts         # insertEvents, pruneOldEvents
  facility.ts       # updateFacilityStatus, setFacilitySwitch, updateFacilityMetrics
  metrics.ts        # syncDailyMetrics, syncProjectDailyMetrics, deleteProjectDailyMetrics
  telemetry.ts      # batchUpsertProjectTelemetry, verifyProjectTelemetry
  agent-state.ts    # pushAgentState (with per-entity error context)
  errors.ts         # flushErrors, pruneResolved, clearErrorsTable (DB operations)

src/__tests__/
  check-result.test.ts   # Tests for the new checkResult helper
```

### Modified files

```
src/sync.ts              # Gradually emptied — re-exports during migration, then deleted
src/errors.ts            # Remove sync.ts import, add removeErrors(), expand ErrorCategory
bin/daemon.ts            # Update imports from sync.ts → db/* modules, call initErrorReporter
src/__tests__/sync-resilience.test.ts  # Update imports after sync.ts removed
src/__tests__/errors.test.ts           # Update for new error categories
```

### Deleted files

```
src/sync.ts              # Removed in Task 11 after all callers migrated
```

---

## Chunk 1: Foundation

### Task 1: Extract `src/db/client.ts`

**Files:**
- Create: `src/db/client.ts`
- Modify: `src/sync.ts`

- [ ] **Step 1: Create `src/db/client.ts`**

```bash
mkdir -p src/db
```

Move `initSupabase`, `getSupabase`, and `withRetry` from `src/sync.ts`.

```typescript
// src/db/client.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient;

export function initSupabase(url: string, serviceRoleKey: string): void {
  supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getSupabase(): SupabaseClient {
  return supabase;
}

export async function withRetry<T>(
  op: () => Promise<{ data: T; error: any; status?: number }>,
  label: string,
  maxRetries = 2
): Promise<{ data: T; error: any; status?: number }> {
  let lastResult: { data: T; error: any; status?: number } | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await op();
    const status = lastResult.status ?? 0;
    if (!lastResult.error || status < 500) return lastResult;
    if (attempt < maxRetries) {
      const delay = 1000 * 2 ** attempt;
      console.warn(
        `  ${label}: transient error (HTTP ${status}), retry ${attempt + 1}/${maxRetries} in ${delay}ms`
      );
      await Bun.sleep(delay);
    }
  }
  return lastResult!;
}
```

- [ ] **Step 2: Update `src/sync.ts`**

Remove the `initSupabase`, `getSupabase`, `withRetry` definitions and the `let supabase` declaration. Replace with:

```typescript
// At the top of sync.ts, after other imports:
import { getSupabase, initSupabase, withRetry } from "./db/client";

// Re-exports for backward compatibility
export { initSupabase, getSupabase, withRetry };
```

Replace all bare `supabase` references in sync.ts with `getSupabase()`. Every `supabase.from(...)` becomes `getSupabase().from(...)`. Also remove the `import { createClient, type SupabaseClient } from "@supabase/supabase-js"` line — sync.ts no longer needs it directly.

- [ ] **Step 3: Run tests**

```bash
bun test
```

Expected: all tests pass (full suite unchanged). The re-exports ensure existing imports work.

- [ ] **Step 4: Commit**

```bash
git add src/db/client.ts src/sync.ts
git commit -m "refactor: extract db/client.ts from sync.ts (initSupabase, getSupabase, withRetry)"
```

---

### Task 2: Break `errors.ts` circular dependency

**Files:**
- Create: `src/db/errors.ts`
- Modify: `src/errors.ts`, `bin/daemon.ts`
- Modify: `src/__tests__/errors.test.ts`

The circular dependency: `errors.ts` imports `getSupabase` from `sync.ts`, and `sync.ts` imports `reportError` from `errors.ts`. Fix by extracting DB operations to `src/db/errors.ts` which imports from `db/client.ts` instead.

- [ ] **Step 1: Add `removeErrors()` to `src/errors.ts`**

The in-memory error store (`errors` Map) is private. `pruneResolved` in the new `db/errors.ts` needs a way to remove entries. Add:

```typescript
/** Remove errors by id from the in-memory store. */
export function removeErrors(ids: string[]): void {
  for (const id of ids) errors.delete(id);
}
```

Also expand the `ErrorCategory` type to include both old and new values (additive — no existing code breaks):

```typescript
export type ErrorCategory =
  | "event_write"
  | "project_registration"
  | "facility_state"
  | "metrics_sync"
  | "telemetry_sync"
  | "supabase_transient"
  // Deprecated — will be removed after domain module migration
  | "sync_write"
  | "project_resolution"
  | "facility_update";
```

Remove `import { getSupabase } from "./sync"` (line 6).

Remove `flushErrors`, `pruneResolved`, and `clearErrorsTable` function definitions from `src/errors.ts`.

- [ ] **Step 2: Create `src/db/errors.ts`**

Move the three DB functions here. They import `getSupabase` from `./client` (no more sync.ts dependency).

```typescript
// src/db/errors.ts
import { getSupabase } from "./client";
import { getActiveErrors, removeErrors } from "../errors";

export async function flushErrors(): Promise<void> {
  const active = getActiveErrors();
  if (active.length === 0) return;

  try {
    const rows = active.map((e) => ({
      id: e.id,
      category: e.category,
      message: e.message,
      sample_context: e.sampleContext ?? null,
      count: e.count,
      first_seen: e.firstSeen.toISOString(),
      last_seen: e.lastSeen.toISOString(),
    }));

    await getSupabase()
      .from("exporter_errors")
      .upsert(rows, { onConflict: "id" });
  } catch {
    // Silent failure — errors stay in memory for next flush
  }
}

export async function pruneResolved(): Promise<number> {
  const cutoff = Date.now() - 5 * 60 * 1000;
  const toRemove: string[] = [];

  for (const err of getActiveErrors()) {
    if (err.lastSeen.getTime() < cutoff) {
      toRemove.push(err.id);
    }
  }

  if (toRemove.length === 0) return 0;

  removeErrors(toRemove);

  try {
    await getSupabase()
      .from("exporter_errors")
      .delete()
      .in("id", toRemove);
  } catch {
    // Silent — rows cleaned up on next daemon restart
  }

  return toRemove.length;
}

export async function clearErrorsTable(): Promise<void> {
  try {
    await getSupabase()
      .from("exporter_errors")
      .delete()
      .neq("id", "");
  } catch {
    // Silent — best-effort cleanup
  }
}
```

- [ ] **Step 3: Update `bin/daemon.ts` imports**

Change line 59:
```typescript
// Before:
import { reportError, flushErrors, pruneResolved, clearErrors, clearErrorsTable } from "../src/errors";

// After:
import { reportError, clearErrors } from "../src/errors";
import { flushErrors, pruneResolved, clearErrorsTable } from "../src/db/errors";
```

- [ ] **Step 4: Update `src/__tests__/errors.test.ts`**

`pruneResolved` moved to `db/errors.ts`, so update the test import. Also add Supabase mock setup since `pruneResolved` now calls `getSupabase()` via `db/client.ts`:

```typescript
// At the top of the file, BEFORE other imports:
import { mock } from "bun:test";

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      delete: () => ({
        in: () => Promise.resolve({ data: null, error: null }),
        neq: () => Promise.resolve({ data: null, error: null }),
      }),
      upsert: () => Promise.resolve({ data: null, error: null }),
    }),
  }),
}));

// Then update the imports:
// Before:
import { reportError, getActiveErrors, clearErrors, pruneResolved, type ErrorCategory } from "../errors";

// After:
import { reportError, getActiveErrors, clearErrors, type ErrorCategory } from "../errors";
import { pruneResolved } from "../db/errors";
import { initSupabase } from "../db/client";

initSupabase("http://fake", "fake-key");
```

- [ ] **Step 5: Run tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/db/errors.ts bin/daemon.ts src/__tests__/errors.test.ts
git commit -m "refactor: break errors.ts circular dependency — extract DB ops to db/errors.ts"
```

---

### Task 3: Extract `src/db/types.ts`

**Files:**
- Create: `src/db/types.ts`
- Modify: `src/sync.ts`

- [ ] **Step 1: Create `src/db/types.ts`**

Move these type definitions from `src/sync.ts`:

```typescript
// src/db/types.ts
import type { ModelStats } from "../parsers";

/** Token breakdown per model, keyed by model name. */
export type ModelTokenBreakdown = Record<string, Omit<ModelStats, "model">>;

/** Aggregate metrics for the facility status row. */
export interface FacilityMetrics {
  tokensLifetime: number;
  tokensToday: number;
  sessionsLifetime: number;
  messagesLifetime: number;
  modelStats: ModelTokenBreakdown;
  hourDistribution: Record<string, number>;
  firstSessionDate: string | null;
}

export interface InsertEventsResult {
  inserted: number;
  errors: number;
  insertedByProject: Record<string, number>;
}

/** project → date → { sessions, messages, toolCalls, agentSpawns, teamMessages } */
export type ProjectEventAggregates = Map<
  string,
  Map<string, { sessions: number; messages: number; toolCalls: number; agentSpawns: number; teamMessages: number }>
>;

export interface FacilityUpdate extends FacilityMetrics {
  status: "active" | "dormant";
  activeAgents: number;
  activeProjects: Array<{ name: string; active: boolean }>;
}

export type FacilityMetricsUpdate = FacilityMetrics;

export interface ProjectTelemetryUpdate {
  projId: string;
  tokensLifetime: number;
  tokensToday: number;
  modelsToday: Record<string, number>;
  sessionsLifetime: number;
  messagesLifetime: number;
  toolCallsLifetime: number;
  agentSpawnsLifetime: number;
  teamMessagesLifetime: number;
  activeAgents: number;
  agentCount: number;
}

/** Format a token count as a human-readable string (e.g. "12.3M"). */
export function formatTokens(n: number): string {
  return (n / 1e6).toFixed(1) + "M";
}
```

**Note:** `formatTokens` also exists in `bin/daemon-helpers.ts` (line 36, exported). After this step, `db/types.ts` becomes the canonical copy. The `daemon-helpers.ts` copy is left in place for now — it will be consolidated in Task 11 when all imports are migrated.

- [ ] **Step 2: Update `src/sync.ts`**

Remove the type definitions and `formatTokens` from sync.ts. Add import + re-export:

```typescript
import {
  formatTokens,
  type ModelTokenBreakdown,
  type FacilityMetrics,
  type InsertEventsResult,
  type ProjectEventAggregates,
  type FacilityUpdate,
  type FacilityMetricsUpdate,
  type ProjectTelemetryUpdate,
} from "./db/types";

// Re-exports for backward compatibility
export {
  type FacilityUpdate,
  type FacilityMetricsUpdate,
  type ProjectTelemetryUpdate,
  type ProjectEventAggregates,
};
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/db/types.ts src/sync.ts
git commit -m "refactor: extract db/types.ts — shared type definitions"
```

---

### Task 4: Create `src/db/check-result.ts` (TDD)

**Files:**
- Create: `src/__tests__/check-result.test.ts`
- Create: `src/db/check-result.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/check-result.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { checkResult } from "../db/check-result";
import { getActiveErrors, clearErrors } from "../errors";

beforeEach(() => {
  clearErrors();
});

describe("checkResult", () => {
  test("returns true when no error", () => {
    const ok = checkResult(
      { error: null, status: 200 },
      { operation: "test", category: "event_write" }
    );
    expect(ok).toBe(true);
    expect(getActiveErrors()).toHaveLength(0);
  });

  test("returns false and reports error on failure", () => {
    const ok = checkResult(
      { error: { message: "FK violation" }, status: 409 },
      { operation: "insertEvents", category: "event_write", entity: { projId: "proj_abc" } }
    );
    expect(ok).toBe(false);
    const errors = getActiveErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].category).toBe("event_write");
    expect(errors[0].message).toContain("insertEvents");
  });

  test("uses supabase_transient category for 5xx errors", () => {
    checkResult(
      { error: { message: "bad gateway" }, status: 502 },
      { operation: "upsertProject", category: "project_registration" }
    );
    const errors = getActiveErrors();
    expect(errors[0].category).toBe("supabase_transient");
  });

  test("passes entity context to error report", () => {
    checkResult(
      { error: { message: "fail" } },
      { operation: "test", category: "event_write", entity: { batchStart: 0 } }
    );
    const errors = getActiveErrors();
    expect(errors[0].sampleContext).toEqual({ batchStart: 0 });
  });

  test("handles missing status (defaults to non-5xx)", () => {
    checkResult(
      { error: { message: "constraint error" } },
      { operation: "test", category: "metrics_sync" }
    );
    const errors = getActiveErrors();
    expect(errors[0].category).toBe("metrics_sync");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/__tests__/check-result.test.ts
```

Expected: FAIL — `checkResult` module not found.

- [ ] **Step 3: Implement `src/db/check-result.ts`**

```typescript
// src/db/check-result.ts
import { reportError, type ErrorCategory } from "../errors";

export interface ResultContext {
  operation: string;
  category: ErrorCategory;
  entity?: Record<string, unknown>;
}

/**
 * Check a Supabase result and report errors with full context.
 * Returns true if the operation succeeded, false otherwise.
 *
 * 5xx errors are automatically categorized as "supabase_transient"
 * regardless of the provided category.
 */
export function checkResult(
  result: { error: any; status?: number },
  ctx: ResultContext
): boolean {
  if (!result.error) return true;

  const status = result.status ?? 0;
  const category: ErrorCategory =
    status >= 500 ? "supabase_transient" : ctx.category;
  const msg = `${ctx.operation}: ${result.error.message}`;

  console.error(`  ${msg}`);
  reportError(category, msg, ctx.entity);

  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/__tests__/check-result.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/db/check-result.ts src/__tests__/check-result.test.ts
git commit -m "feat: add checkResult helper for standardized Supabase error handling"
```

---

## Chunk 2: Domain Module Extraction

Each domain module extraction follows the same pattern:
1. Create `src/db/<module>.ts` — move functions from sync.ts, import `getSupabase` from `./client`
2. Wire `checkResult` into error handling (replacing scattered `console.error` + `reportError` calls)
3. Add re-exports in `sync.ts` for backward compatibility
4. Run tests, commit

Tasks 5-10 are **independent** — they touch different functions in sync.ts and can be executed in parallel.

### Task 5: Extract `src/db/projects.ts` [parallel]

**Files:**
- Create: `src/db/projects.ts`
- Modify: `src/sync.ts`

- [ ] **Step 1: Create `src/db/projects.ts`**

Move `upsertProject` (sync.ts lines 73-134) and `updateProjectActivity` (lines 139-159).

Key changes from sync.ts version:
- Import `getSupabase` from `"./client"` instead of using bare `supabase`
- Import `checkResult` from `"./check-result"`
- In `upsertProject`: replace `reportError("project_resolution", ...)` with `checkResult(result, { operation: "upsertProject.fallback", category: "project_registration", entity: { projId, slug: contentSlug } })`
- Log the original upsert error (currently swallowed when fallback runs):
  ```typescript
  if (error) {
    console.warn(`  upsertProject: primary upsert failed (${error.message}), trying fallback update`);
    // ... fallback code
  }
  ```
- In `updateProjectActivity`: change return type from `void` to `boolean`. Use `checkResult` for both the select and update calls. Return false on failure.

```typescript
export async function updateProjectActivity(
  projId: string,
  eventCount: number,
  lastActive: Date
): Promise<boolean> {
  const { data: current, error: selectError } = await getSupabase()
    .from("projects")
    .select("total_events")
    .eq("id", projId)
    .single();

  if (selectError || !current) {
    checkResult(
      { error: selectError ?? { message: "no project row" } },
      { operation: "updateProjectActivity.select", category: "project_registration", entity: { projId } }
    );
    return false;
  }

  const result = await getSupabase()
    .from("projects")
    .update({
      total_events: current.total_events + eventCount,
      last_active: lastActive.toISOString(),
    })
    .eq("id", projId);

  return checkResult(result, {
    operation: "updateProjectActivity.update",
    category: "project_registration",
    entity: { projId },
  });
}
```

- [ ] **Step 2: Update `src/sync.ts`**

Remove `upsertProject` and `updateProjectActivity` definitions. Add:

```typescript
import { upsertProject, updateProjectActivity } from "./db/projects";
export { upsertProject, updateProjectActivity };
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

Expected: all tests pass (sync-resilience tests import via sync.ts re-exports).

- [ ] **Step 4: Commit**

```bash
git add src/db/projects.ts src/sync.ts
git commit -m "refactor: extract db/projects.ts — upsertProject, updateProjectActivity"
```

---

### Task 6: Extract `src/db/events.ts` [parallel]

**Files:**
- Create: `src/db/events.ts`
- Modify: `src/sync.ts`

- [ ] **Step 1: Create `src/db/events.ts`**

Move `insertEvents`, `pruneOldEvents`, and the `EMPTY_INSERT_RESULT` constant from sync.ts.

Key changes:
- Import `getSupabase` from `"./client"`, `withRetry` from `"./client"`, `checkResult` from `"./check-result"`, `InsertEventsResult` from `"./types"`
- In `insertEvents`, replace the 5xx error path:
  ```typescript
  // Before:
  reportError("supabase_transient", `events: batch ...`);
  // After (handled by checkResult):
  checkResult({ error, status: errorStatus }, {
    operation: "insertEvents.batch",
    category: "event_write",
    entity: { batchStart: i, batchEnd: i + batch.length },
  });
  ```
- In the per-row fallback path, replace `reportError("sync_write", ...)` with `checkResult` using `category: "event_write"`, `operation: "insertEvents.rowFallback"`, `entity: { projId: row.project_id, eventType: row.event_type }`
- In `pruneOldEvents`, replace `reportError("sync_write", ...)` with `checkResult` using `category: "event_write"`

- [ ] **Step 2: Update `src/sync.ts`**

Remove `insertEvents`, `pruneOldEvents`, `EMPTY_INSERT_RESULT`. Add:

```typescript
import { insertEvents, pruneOldEvents } from "./db/events";
export { insertEvents, pruneOldEvents };
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/db/events.ts src/sync.ts
git commit -m "refactor: extract db/events.ts — insertEvents, pruneOldEvents"
```

---

### Task 7: Extract `src/db/facility.ts` [parallel]

**Files:**
- Create: `src/db/facility.ts`
- Modify: `src/sync.ts`

- [ ] **Step 1: Create `src/db/facility.ts`**

Move `updateFacilityStatus`, `setFacilitySwitch`, `updateFacilityMetrics`, and the private `metricsToRow` helper from sync.ts.

Key changes:
- Import `getSupabase` from `"./client"`, `checkResult` from `"./check-result"`, types from `"./types"`
- Replace all `reportError("facility_update", ...)` with `checkResult(result, { operation: "...", category: "facility_state" })`

- [ ] **Step 2: Update `src/sync.ts`**

Remove the facility functions and `metricsToRow`. Add:

```typescript
import { updateFacilityStatus, setFacilitySwitch, updateFacilityMetrics } from "./db/facility";
export { updateFacilityStatus, setFacilitySwitch, updateFacilityMetrics };
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/db/facility.ts src/sync.ts
git commit -m "refactor: extract db/facility.ts — facility status operations"
```

---

### Task 8: Extract `src/db/metrics.ts` [parallel]

**Files:**
- Create: `src/db/metrics.ts`
- Modify: `src/sync.ts`

- [ ] **Step 1: Create `src/db/metrics.ts`**

Move `syncDailyMetrics`, `syncProjectDailyMetrics`, and `deleteProjectDailyMetrics` from sync.ts. Also move the `DailyKeyData` interface and the inline `ProjectDailyMetricsInsert`/`ProjectDailyMetricsPartial` interfaces.

Key changes:
- Import `getSupabase` from `"./client"`, `checkResult` from `"./check-result"`
- Replace `reportError("sync_write", ...)` in `syncProjectDailyMetrics` bulk insert with `checkResult(result, { operation: "syncProjectDailyMetrics.insert", category: "metrics_sync" })`
- Replace `reportError("sync_write", ...)` in `deleteProjectDailyMetrics` with `checkResult(result, { operation: "deleteProjectDailyMetrics", category: "metrics_sync" })`

- [ ] **Step 2: Update `src/sync.ts`**

Remove the metrics functions. Add:

```typescript
import { syncDailyMetrics, syncProjectDailyMetrics, deleteProjectDailyMetrics } from "./db/metrics";
export { syncDailyMetrics, syncProjectDailyMetrics, deleteProjectDailyMetrics };
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/db/metrics.ts src/sync.ts
git commit -m "refactor: extract db/metrics.ts — daily metrics sync operations"
```

---

### Task 9: Extract `src/db/telemetry.ts` [parallel]

**Files:**
- Create: `src/db/telemetry.ts`
- Modify: `src/sync.ts`

- [ ] **Step 1: Create `src/db/telemetry.ts`**

Move `batchUpsertProjectTelemetry` and `verifyProjectTelemetry` from sync.ts. Also move the `ProjectTelemetryRow` interface. `verifyProjectTelemetry` stays private to this module (not exported) — it's called internally by `batchUpsertProjectTelemetry`.

Key changes:
- Import `getSupabase` from `"./client"`, `checkResult` from `"./check-result"`, `formatTokens` and `ProjectTelemetryUpdate` from `"./types"`
- Replace `reportError("sync_write", ...)` in batch upsert with `checkResult(result, { operation: "batchUpsertProjectTelemetry.batch", category: "telemetry_sync" })`
- Per-row fallback: `checkResult(result, { operation: "batchUpsertProjectTelemetry.row", category: "telemetry_sync", entity: { projId: update.projId } })`

- [ ] **Step 2: Update `src/sync.ts`**

Remove telemetry functions and `ProjectTelemetryRow`. Add:

```typescript
import { batchUpsertProjectTelemetry } from "./db/telemetry";
export { batchUpsertProjectTelemetry };
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/db/telemetry.ts src/sync.ts
git commit -m "refactor: extract db/telemetry.ts — project telemetry upserts"
```

---

### Task 10: Extract `src/db/agent-state.ts` [parallel]

**Files:**
- Create: `src/db/agent-state.ts`
- Modify: `src/sync.ts`

- [ ] **Step 1: Create `src/db/agent-state.ts`**

Move `pushAgentState` from sync.ts. **Refactor** from flat `Promise.all` to labeled per-entity writes with `checkResult` for each.

**Latency note:** This intentionally changes from parallel (`Promise.all`) to sequential writes. The trade-off is increased latency (N round-trips instead of 1) in exchange for per-entity error provenance. This is acceptable because `pushAgentState` runs on the 250ms watcher loop and typically has 1-5 projects — the extra latency is negligible compared to the error context gained.

```typescript
// src/db/agent-state.ts
import { getSupabase } from "./client";
import { checkResult } from "./check-result";
import type { ProcessDiff } from "../process/watcher";

/**
 * Push agent state changes from the ProcessWatcher.
 * Only writes agent-related fields — never touches aggregate metrics.
 * Each write is individually labeled for error provenance.
 */
export async function pushAgentState(diff: ProcessDiff): Promise<void> {
  const now = new Date().toISOString();

  // Per-project telemetry updates (agent counts)
  for (const [projId, counts] of diff.byProject) {
    const result = await getSupabase()
      .from("project_telemetry")
      .update({
        active_agents: counts.active,
        agent_count: counts.count,
        updated_at: now,
      })
      .eq("id", projId);

    checkResult(result, {
      operation: "pushAgentState.projectTelemetry",
      category: "telemetry_sync",
      entity: { projId },
    });
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

  // Update last_active for projects with active agents
  for (const [projId, counts] of diff.byProject) {
    if (counts.active > 0) {
      const result = await getSupabase()
        .from("projects")
        .update({ last_active: now })
        .eq("id", projId);

      checkResult(result, {
        operation: "pushAgentState.lastActive",
        category: "project_registration",
        entity: { projId },
      });
    }
  }
}
```

- [ ] **Step 2: Update `src/sync.ts`**

Remove `pushAgentState`. Add:

```typescript
import { pushAgentState } from "./db/agent-state";
export { pushAgentState };
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/db/agent-state.ts src/sync.ts
git commit -m "refactor: extract db/agent-state.ts — per-entity error context for pushAgentState"
```

---

## Chunk 3: Remove sync.ts

### Task 11: Remove `src/sync.ts` and update all imports

**Files:**
- Delete: `src/sync.ts`
- Modify: `bin/daemon.ts`
- Modify: `bin/daemon-helpers.ts`
- Modify: `src/__tests__/sync-resilience.test.ts`

After Tasks 5-10, `sync.ts` is a pure re-export file. Remove it and update all consumers.

- [ ] **Step 1: Update `bin/daemon.ts` imports**

Replace the sync.ts import block with direct db/ module imports:

```typescript
import { initSupabase, getSupabase } from "../src/db/client";
import {
  type FacilityUpdate,
  type FacilityMetricsUpdate,
  type ProjectTelemetryUpdate,
  type ProjectEventAggregates,
} from "../src/db/types";
import { upsertProject, updateProjectActivity } from "../src/db/projects";
import { insertEvents, pruneOldEvents } from "../src/db/events";
import {
  updateFacilityStatus,
  updateFacilityMetrics,
  setFacilitySwitch,
} from "../src/db/facility";
import {
  syncDailyMetrics,
  syncProjectDailyMetrics,
  deleteProjectDailyMetrics,
} from "../src/db/metrics";
import { batchUpsertProjectTelemetry } from "../src/db/telemetry";
import { pushAgentState } from "../src/db/agent-state";
```

Also update the errors imports if not already done:

```typescript
import { reportError, clearErrors } from "../src/errors";
import { flushErrors, pruneResolved, clearErrorsTable } from "../src/db/errors";
```

- [ ] **Step 2: Update `bin/daemon-helpers.ts` imports**

`bin/daemon-helpers.ts` imports `ProjectEventAggregates` from sync.ts. Update:

```typescript
// Before (daemon-helpers.ts line 8):
import type { ProjectEventAggregates } from "../src/sync";

// After:
import type { ProjectEventAggregates } from "../src/db/types";
```

Also consolidate the `formatTokens` duplicate — `daemon-helpers.ts` has its own copy (line 36). Replace with an import from `db/types.ts`:

```typescript
// Remove the local formatTokens function definition from daemon-helpers.ts
// Add to the import:
import { formatTokens, type ProjectEventAggregates } from "../src/db/types";
```

- [ ] **Step 3: Update `src/__tests__/sync-resilience.test.ts` imports**

```typescript
// Before:
const { withRetry, insertEvents, upsertProject, initSupabase } = await import("../sync");

// After:
const { withRetry, initSupabase } = await import("../db/client");
const { insertEvents } = await import("../db/events");
const { upsertProject } = await import("../db/projects");
```

- [ ] **Step 4: Check for any remaining sync.ts imports**

Search the codebase for any remaining `from.*sync` imports:

```bash
grep -r "from.*[\"'].*sync[\"']" src/ bin/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts"
```

Fix any remaining references.

- [ ] **Step 5: Delete `src/sync.ts`**

```bash
rm src/sync.ts
```

- [ ] **Step 6: Remove deprecated error categories**

In `src/errors.ts`, remove the deprecated category values from the `ErrorCategory` union:

```typescript
export type ErrorCategory =
  | "event_write"
  | "project_registration"
  | "facility_state"
  | "metrics_sync"
  | "telemetry_sync"
  | "supabase_transient";
```

Update test assertions in `src/__tests__/errors.test.ts` that use old category names (`"sync_write"`, `"facility_update"`, `"project_resolution"`). Replace with new names:
- `"sync_write"` → `"event_write"`
- `"facility_update"` → `"facility_state"`
- `"project_resolution"` → `"project_registration"`

- [ ] **Step 7: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove sync.ts — all callers migrated to db/ modules"
```
