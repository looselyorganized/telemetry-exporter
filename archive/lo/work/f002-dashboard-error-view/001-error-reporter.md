---
status: pending
feature_id: f002
feature: Dashboard Error View
phase: 1
---

# Dashboard Error View — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface daemon errors in the dashboard by adding an in-memory error aggregator that deduplicates, flushes to Supabase, and is displayed in a new Errors tab.

**Architecture:** A lightweight `ErrorReporter` singleton in `src/errors.ts` collects errors via `reportError()`, deduplicates by `category:normalized_message`, and flushes to an `exporter_errors` Supabase table every aggregator cycle. The daemon instruments ~15 error sites with `reportError()` calls alongside existing `console.error`. The dashboard adds a `GET /api/errors` endpoint and an Errors tab with expandable rows. On daemon startup, the table is cleared (live state, not history).

**Tech Stack:** TypeScript, Bun, Supabase (postgres)

**Spec:** `.lo/work/f002-dashboard-error-view/spec.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/errors.ts` | Create | Error reporter: `reportError()`, `flushErrors()`, `pruneResolved()`, normalization, dedup |
| `src/__tests__/errors.test.ts` | Create | Unit tests for error reporter (normalization, dedup, count tracking, prune logic) |
| `src/sync.ts` | Modify | Add `reportError()` calls at 11 error sites |
| `bin/daemon.ts` | Modify | Add `reportError()` at 6 error sites, call `flushErrors()`/`pruneResolved()` in aggregate loop, clear table on startup |
| `bin/dashboard.ts` | Modify | Add `GET /api/errors` endpoint, Errors tab in HTML, error indicator in health bar |
| `src/__tests__/sync-resilience.test.ts` | (existing, unrelated to this feature) |

---

## Chunk 1: Error Reporter Module

### Task 1: Create error reporter with normalization and dedup

**Files:**
- Create: `src/errors.ts`
- Create: `src/__tests__/errors.test.ts`

- [ ] **Step 1: Write failing tests for message normalization**

```ts
// src/__tests__/errors.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { reportError, getActiveErrors, clearErrors, type ErrorCategory } from "../errors";

describe("ErrorReporter", () => {
  beforeEach(() => {
    clearErrors();
  });

  describe("normalization", () => {
    it("normalizes project IDs", () => {
      reportError("sync_write", "skipping proj_abc123def (FK error)");
      const errors = getActiveErrors();
      expect(errors[0].id).toBe("sync_write:skipping <proj> (FK error)");
    });

    it("normalizes batch ranges", () => {
      reportError("sync_write", "batch 0-500 failed");
      const errors = getActiveErrors();
      expect(errors[0].id).toBe("sync_write:batch <range> failed");
    });

    it("normalizes token counts like 12.3M", () => {
      reportError("sync_write", "wrote 12.3M but DB has 11.9M");
      const errors = getActiveErrors();
      expect(errors[0].id).toBe("sync_write:wrote <N> but DB has <N>");
    });

    it("keeps HTTP status codes as-is", () => {
      reportError("supabase_transient", "HTTP 502, retry 2/3");
      const errors = getActiveErrors();
      expect(errors[0].id).toBe("supabase_transient:HTTP 502, retry 2/3");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test src/__tests__/errors.test.ts`
Expected: FAIL — module `../errors` not found

- [ ] **Step 3: Implement error reporter with normalization**

```ts
// src/errors.ts
/**
 * Lightweight in-memory error aggregator for the telemetry daemon.
 * Deduplicates errors by category:normalized_message and flushes to Supabase.
 */

import { getSupabase } from "./sync";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ErrorCategory = "sync_write" | "project_resolution" | "supabase_transient" | "facility_update";

export interface ActiveError {
  id: string;                          // "category:normalized_message"
  category: ErrorCategory;
  message: string;                     // original (first occurrence) message
  sampleContext: Record<string, unknown> | undefined;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

// ─── State ──────────────────────────────────────────────────────────────────

const errors = new Map<string, ActiveError>();

// ─── Normalization ──────────────────────────────────────────────────────────

/** Strip variable parts from error messages to produce stable dedup keys. */
function normalizeMessage(msg: string): string {
  return msg
    .replace(/proj_[a-f0-9-]+/g, "<proj>")           // project IDs
    .replace(/batch \d+-\d+/g, "batch <range>")       // batch ranges
    .replace(/\d+\.\d+M/g, "<N>");                    // token counts like 12.3M
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Report an error occurrence. Deduplicates by category:normalized_message.
 * Additive — does not replace console.error, called alongside it.
 */
export function reportError(
  category: ErrorCategory,
  message: string,
  context?: Record<string, unknown>
): void {
  const normalized = normalizeMessage(message);
  const id = `${category}:${normalized}`;
  const now = new Date();

  const existing = errors.get(id);
  if (existing) {
    existing.count++;
    existing.lastSeen = now;
  } else {
    errors.set(id, {
      id,
      category,
      message,
      sampleContext: context,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    });
  }
}

/** Get all active errors (for testing and dashboard). */
export function getActiveErrors(): ActiveError[] {
  return [...errors.values()];
}

/** Clear all in-memory errors (for testing and daemon startup). */
export function clearErrors(): void {
  errors.clear();
}

/**
 * Flush active errors to the exporter_errors Supabase table.
 * Upserts on id (the dedup key). Silently fails if Supabase is unreachable
 * (errors remain in memory for next cycle). Does not report its own failures.
 */
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

/**
 * Prune errors not seen in the last 5 minutes from memory and Supabase.
 * Returns the number of pruned errors.
 */
export async function pruneResolved(): Promise<number> {
  const cutoff = Date.now() - 5 * 60 * 1000;
  const toRemove: string[] = [];

  for (const [id, err] of errors) {
    if (err.lastSeen.getTime() < cutoff) {
      toRemove.push(id);
    }
  }

  if (toRemove.length === 0) return 0;

  for (const id of toRemove) {
    errors.delete(id);
  }

  try {
    await getSupabase()
      .from("exporter_errors")
      .delete()
      .in("id", toRemove);
  } catch {
    // Silent — rows will be cleaned up on next daemon restart anyway
  }

  return toRemove.length;
}

/**
 * Clear the exporter_errors table in Supabase.
 * Called on daemon startup — table represents live state, not history.
 */
export async function clearErrorsTable(): Promise<void> {
  try {
    await getSupabase()
      .from("exporter_errors")
      .delete()
      .neq("id", "");  // delete all rows
  } catch {
    // Silent — best-effort cleanup
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test src/__tests__/errors.test.ts`
Expected: PASS — all 4 normalization tests pass

- [ ] **Step 5: Write failing tests for dedup and counting**

Add to `src/__tests__/errors.test.ts`:

```ts
  describe("deduplication", () => {
    it("increments count for duplicate errors", () => {
      reportError("sync_write", "connection refused");
      reportError("sync_write", "connection refused");
      reportError("sync_write", "connection refused");
      const errors = getActiveErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].count).toBe(3);
    });

    it("deduplicates across variable project IDs", () => {
      reportError("sync_write", "skipping proj_aaa (FK error)");
      reportError("sync_write", "skipping proj_bbb (FK error)");
      const errors = getActiveErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].count).toBe(2);
      // Keeps first occurrence's original message
      expect(errors[0].message).toBe("skipping proj_aaa (FK error)");
    });

    it("tracks separate errors by category", () => {
      reportError("sync_write", "timeout");
      reportError("facility_update", "timeout");
      const errors = getActiveErrors();
      expect(errors).toHaveLength(2);
    });

    it("preserves sample_context from first occurrence", () => {
      reportError("sync_write", "batch 0-500 failed", { httpStatus: 502 });
      reportError("sync_write", "batch 500-1000 failed", { httpStatus: 503 });
      const errors = getActiveErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].sampleContext).toEqual({ httpStatus: 502 });
    });

    it("updates lastSeen on repeat", () => {
      reportError("sync_write", "fail");
      const first = getActiveErrors()[0].lastSeen;
      // Small delay to ensure different timestamp
      reportError("sync_write", "fail");
      const second = getActiveErrors()[0].lastSeen;
      expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    });
  });
```

- [ ] **Step 6: Run tests to verify dedup tests pass**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test src/__tests__/errors.test.ts`
Expected: PASS — all 9 tests pass

- [ ] **Step 7: Write failing tests for pruneResolved (in-memory only)**

Add to `src/__tests__/errors.test.ts`:

```ts
  describe("pruneResolved", () => {
    it("prunes errors older than 5 minutes from memory", async () => {
      reportError("sync_write", "old error");
      // Manually backdate the error
      const errors = getActiveErrors();
      errors[0].lastSeen = new Date(Date.now() - 6 * 60 * 1000);

      const pruned = await pruneResolved();
      expect(pruned).toBe(1);
      expect(getActiveErrors()).toHaveLength(0);
    });

    it("keeps errors seen within 5 minutes", async () => {
      reportError("sync_write", "recent error");
      const pruned = await pruneResolved();
      expect(pruned).toBe(0);
      expect(getActiveErrors()).toHaveLength(1);
    });
  });
```

Note: Import `pruneResolved` at the top. These tests will fail on the Supabase call inside `pruneResolved`, but since `getSupabase()` won't be initialized in tests, the `try/catch` will swallow the error. The in-memory state is what we're testing.

- [ ] **Step 8: Run tests to verify prune tests pass**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test src/__tests__/errors.test.ts`
Expected: PASS — all 11 tests pass (Supabase calls silently fail in the catch blocks)

- [ ] **Step 9: Commit**

```bash
git add src/errors.ts src/__tests__/errors.test.ts
git commit -m "feat(f002): add error reporter with normalization, dedup, and prune"
```

---

## Chunk 2: Instrument Error Sites

### Task 2: Instrument sync.ts error sites

**Files:**
- Modify: `src/sync.ts` — add `reportError()` calls at 11 locations

The spec lists these error sites in `src/sync.ts`. Each one is additive — `console.error` stays, `reportError()` is added alongside it.

- [ ] **Step 1: Add import to sync.ts**

At the top of `src/sync.ts`, add:

```ts
import { reportError } from "./errors";
```

- [ ] **Step 2: Instrument `insertEvents` — batch failure**

In `insertEvents()`, after the `console.error` for batch failure (~line 196):

```ts
// Existing:
console.error(`  events: batch ${i}-${i + batch.length} failed (${error.message}), falling back to per-row`);
// Add:
reportError("sync_write", `events: batch ${i}-${i + batch.length} failed (${error.message})`, { batchStart: i, batchEnd: i + batch.length });
```

- [ ] **Step 3: Instrument `insertEvents` — per-row fallback errors**

Inside the per-row fallback loop, after `errors++` (~line 203):

```ts
if (rowError) {
  errors++;
  reportError("sync_write", `events: row insert failed (${rowError.message})`, { project_id: row.project_id });
}
```

- [ ] **Step 4: Instrument `batchUpsertProjectTelemetry` — batch failure**

After the batch upsert `console.error` (~line 607):

```ts
// Existing:
console.error(`  project_telemetry: batch upsert failed (${error.message}), falling back to per-row`);
// Add:
reportError("sync_write", `project_telemetry: batch upsert failed (${error.message})`);
```

- [ ] **Step 5: Instrument `batchUpsertProjectTelemetry` — per-row failure**

After the per-row `console.error` (~line 614):

```ts
// Existing:
console.error(`  project_telemetry: skipping ${update.projId} (${rowError.message})`);
// Add:
reportError("sync_write", `project_telemetry: row failed (${rowError.message})`, { project_id: update.projId });
```

- [ ] **Step 6: Instrument `updateFacilityStatus`**

After the `console.error` (~line 490):

```ts
// Existing:
console.error("Error updating facility status:", error.message);
// Add:
reportError("facility_update", `updateFacilityStatus: ${error.message}`);
```

- [ ] **Step 7: Instrument `updateFacilityMetrics`**

After the `console.error` (~line 532):

```ts
// Existing:
console.error("Error updating facility metrics:", error.message);
// Add:
reportError("facility_update", `updateFacilityMetrics: ${error.message}`);
```

- [ ] **Step 8: Instrument `setFacilitySwitch`**

After the `console.error` (~line 508):

```ts
// Existing:
console.error("Error setting facility switch:", error.message);
// Add:
reportError("facility_update", `setFacilitySwitch: ${error.message}`);
```

- [ ] **Step 9: Instrument `syncProjectDailyMetrics` — bulk insert**

After the `console.error` (~line 435):

```ts
// Existing:
console.error(`  Error bulk inserting project metrics:`, error.message);
// Add:
reportError("sync_write", `syncProjectDailyMetrics: bulk insert failed (${error.message})`);
```

- [ ] **Step 10: Instrument `deleteProjectDailyMetrics`**

After the `console.error` (~line 668):

```ts
// Existing:
console.error("Error deleting per-project daily_metrics:", error.message);
// Add:
reportError("sync_write", `deleteProjectDailyMetrics: ${error.message}`);
```

- [ ] **Step 11: Instrument `pruneOldEvents`**

After the `console.error` (~line 690):

```ts
// Existing:
console.error("Error pruning old events:", error.message);
// Add:
reportError("sync_write", `pruneOldEvents: ${error.message}`);
```

- [ ] **Step 12: Instrument `pushAgentState` — per-result errors**

After the `console.error` in the results loop (~line 731):

```ts
// Existing:
console.error("  pushAgentState error:", result.error.message);
// Add:
reportError("facility_update", `pushAgentState: ${result.error.message}`);
```

- [ ] **Step 13: Instrument `upsertProject` — failure**

After the `console.error` (~line 108):

```ts
// Existing:
console.error(`  Failed to register project ${projId}:`, error.message);
// Add:
reportError("project_resolution", `upsertProject failed: ${error.message}`, { project_id: projId, slug: contentSlug });
```

- [ ] **Step 14: Instrument `withRetry` — transient errors**

After the `console.warn` (~line 57):

```ts
// Existing:
console.warn(`  ${label}: transient error (HTTP ${status}), retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
// Add:
reportError("supabase_transient", `${label}: transient error (HTTP ${status}), retry ${attempt + 1}/${maxRetries}`, { httpStatus: status, attempt: attempt + 1, label });
```

- [ ] **Step 15: Run existing tests to verify no regressions**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test`
Expected: All existing tests pass

- [ ] **Step 16: Commit**

```bash
git add src/sync.ts
git commit -m "feat(f002): instrument sync.ts error sites with reportError()"
```

### Task 3: Instrument daemon.ts error sites

**Files:**
- Modify: `bin/daemon.ts` — add `reportError()` at 6 locations, call `flushErrors()`/`pruneResolved()` in aggregate loop, clear table on startup

- [ ] **Step 1: Add imports to daemon.ts**

At the top of `bin/daemon.ts`, add to the imports from `../src/errors`:

```ts
import { reportError, flushErrors, pruneResolved, clearErrors, clearErrorsTable } from "../src/errors";
```

- [ ] **Step 2: Clear error table on startup**

After `initSupabase(SUPABASE_URL, SUPABASE_KEY)` (~line 111), add:

```ts
// Clear live error state from previous runs
clearErrors();
await clearErrorsTable();
```

Note: `main()` is already async, so this works. Place the call inside `main()` before the backfill/daemon branch, right after the init log block.

- [ ] **Step 3: Instrument `ensureProjects` — registration failure**

After the `console.error` in `ensureProjects` (~line 217):

```ts
// Existing:
console.error(`  Project registration failed: ${slug} [${projId}] — will retry next cycle`);
// Add:
reportError("project_resolution", `ensureProjects: registration failed for ${slug}`, { project_id: projId, slug });
```

- [ ] **Step 4: Instrument `maybeSyncProjectDailyMetrics` — catch**

In the catch block (~line 474):

```ts
// Existing:
console.error("Error syncing project daily metrics:", err);
// Add:
reportError("sync_write", `maybeSyncProjectDailyMetrics: ${err instanceof Error ? err.message : String(err)}`);
```

- [ ] **Step 5: Instrument `maybePruneEvents` — catch**

In the catch block (~line 535):

```ts
// Existing:
console.error("Error pruning events:", err);
// Add:
reportError("sync_write", `maybePruneEvents: ${err instanceof Error ? err.message : String(err)}`);
```

- [ ] **Step 6: Instrument watcher loop catch**

In the `watcherLoop` catch (~line 708):

```ts
// Existing:
console.error("Watcher error:", err);
// Add:
reportError("facility_update", `watcherLoop: ${err instanceof Error ? err.message : String(err)}`);
```

- [ ] **Step 7: Instrument aggregate loop catch**

In the `aggregateLoop` catch (~line 738):

```ts
// Existing:
console.error("Aggregate sync error:", err);
// Add:
reportError("sync_write", `aggregateLoop: ${err instanceof Error ? err.message : String(err)}`);
```

- [ ] **Step 8: Instrument periodic task settled rejections**

After the settled loop (~line 731):

```ts
// Existing:
if (r.status === "rejected") console.error("  Periodic task failed:", r.reason);
// Add:
if (r.status === "rejected") {
  const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
  reportError("sync_write", `periodic task failed: ${reason}`);
}
```

- [ ] **Step 9: Add flushErrors() and pruneResolved() to aggregate loop**

At the end of the `try` block in `aggregateLoop`, after `cycleCount++` (~line 736), add:

```ts
// Flush error state to Supabase and prune resolved errors
await flushErrors();
await pruneResolved();
```

- [ ] **Step 10: Run all tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add bin/daemon.ts
git commit -m "feat(f002): instrument daemon.ts error sites, wire flush/prune into aggregate loop"
```

---

## Chunk 3: Dashboard UI

### Task 4: Create Supabase table

- [ ] **Step 1: Create the `exporter_errors` table in Supabase**

Run this SQL via the Supabase dashboard or `supabase` CLI:

```sql
create table exporter_errors (
  id text primary key,
  category text not null,
  message text not null,
  sample_context jsonb,
  count integer not null default 1,
  first_seen timestamptz not null,
  last_seen timestamptz not null
);
```

- [ ] **Step 2: Verify table exists**

Run: `SELECT * FROM exporter_errors LIMIT 1;` — should return empty result set, no errors.

- [ ] **Step 3: Commit** (no code changes — table is infrastructure)

### Task 5: Add errors API endpoint and dashboard tab

**Files:**
- Modify: `bin/dashboard.ts` — add `/api/errors` endpoint, Errors tab, health bar error indicator

- [ ] **Step 1: Add `/api/errors` handler**

In `bin/dashboard.ts`, add a new handler function after `handleCompare`:

```ts
async function handleErrors(): Promise<Response> {
  const { data, error } = await supabase
    .from("exporter_errors")
    .select("*")
    .order("last_seen", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data ?? []);
}
```

- [ ] **Step 2: Add route for `/api/errors`**

In the `fetch` handler, add before the 404 return:

```ts
if (path === "/api/errors") {
  return await handleErrors();
}
```

- [ ] **Step 3: Add error count to health endpoint**

In `handleHealth()`, after getting the health data, also fetch error count:

```ts
async function handleHealth(): Promise<Response> {
  const { local, remote } = await getSnapshot();
  const health = buildHealth(local, remote);

  // Add error count from exporter_errors table
  const { count } = await supabase
    .from("exporter_errors")
    .select("*", { count: "exact", head: true });

  return Response.json({ ...health, errorCount: count ?? 0 });
}
```

- [ ] **Step 4: Add Errors tab button to HTML tabs section**

In `dashboardHtml()`, add an Errors tab after the Projects tab button (~line 294):

```html
  <button class="tab" data-tab="errors">Errors</button>
```

And add the corresponding panel after `panel-projects` (~line 300):

```html
<div class="panel" id="panel-errors"><p class="loading">Loading...</p></div>
```

- [ ] **Step 5: Add error indicator to health bar**

In the health bar HTML (~line 285), add after the "Last sync" item:

```html
  <div class="health-item">
    <span class="dot" id="errors-dot"></span>
    <span>Errors: <span id="errors-status">...</span></span>
  </div>
```

- [ ] **Step 6: Add CSS for error-specific styles**

Add to the `<style>` block:

```css
  .error-table { width: 100%; font-size: 12px; border-collapse: collapse; }
  .error-table th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #666;
    padding: 6px 8px;
    border-bottom: 1px dashed #333;
  }
  .error-table td { padding: 6px 8px; border-bottom: 1px solid #1a1a1a; }
  .error-table tr { cursor: pointer; }
  .error-table tr:hover { background: #1a1a1a; }
  .cat-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .cat-sync_write { background: #3d2e00; color: #ffc850; }
  .cat-project_resolution { background: #2e003d; color: #c850ff; }
  .cat-supabase_transient { background: #003d2e; color: #50ffc8; }
  .cat-facility_update { background: #3d0000; color: #ff5050; }
  .error-context {
    display: none;
    padding: 8px 12px;
    background: #111;
    border: 1px dashed #282828;
    font-size: 11px;
    white-space: pre-wrap;
    color: #aaa;
    margin: 4px 8px 8px;
  }
  .error-context.open { display: block; }
  .no-errors {
    color: #50ff96;
    padding: 24px;
    text-align: center;
    font-size: 13px;
  }
```

- [ ] **Step 7: Add JS functions for error rendering and health update**

Add to the `<script>` block, before `refreshAll()`:

```js
function renderErrors(panel, data) {
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  if (!data || data.length === 0) {
    panel.appendChild(el('div', 'no-errors', 'No active errors'));
    return;
  }

  var table = el('table', 'error-table');
  var thead = el('thead');
  var hrow = el('tr');
  ['Category', 'Message', 'Count', 'First Seen', 'Last Seen'].forEach(function(h) {
    hrow.appendChild(el('th', '', h));
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  var tbody = el('tbody');
  for (var i = 0; i < data.length; i++) {
    var err = data[i];
    var row = el('tr');

    var catCell = el('td');
    var badge = el('span', 'cat-badge cat-' + err.category, err.category.replace('_', ' '));
    catCell.appendChild(badge);
    row.appendChild(catCell);

    row.appendChild(el('td', '', err.message));
    row.appendChild(el('td', '', String(err.count)));
    row.appendChild(el('td', 'dim', new Date(err.first_seen).toLocaleTimeString()));
    row.appendChild(el('td', '', new Date(err.last_seen).toLocaleTimeString()));

    // Click to expand context
    var contextId = 'ctx-' + i;
    row.dataset.contextId = contextId;
    row.addEventListener('click', (function(cid, ctx) {
      return function() {
        var ctxEl = document.getElementById(cid);
        if (ctxEl) ctxEl.classList.toggle('open');
      };
    })(contextId, err.sample_context));

    tbody.appendChild(row);

    // Context row (hidden by default)
    if (err.sample_context) {
      var ctxRow = el('tr');
      var ctxCell = el('td');
      ctxCell.colSpan = 5;
      var ctxDiv = el('div', 'error-context');
      ctxDiv.id = contextId;
      ctxDiv.textContent = JSON.stringify(err.sample_context, null, 2);
      ctxCell.appendChild(ctxDiv);
      ctxRow.appendChild(ctxCell);
      tbody.appendChild(ctxRow);
    }
  }

  table.appendChild(tbody);
  panel.appendChild(table);
}

function fetchErrors() {
  var panel = document.getElementById('panel-errors');
  return fetch('/api/errors')
    .then(function(res) { return res.json(); })
    .then(function(data) { renderErrors(panel, data); })
    .catch(function(err) { showError(panel, err.message); });
}
```

- [ ] **Step 8: Update health bar rendering to include error indicator**

In the `fetchHealth` `.then` callback, add after the supabase status update:

```js
      var errorsDot = document.getElementById('errors-dot');
      var errorsStatus = document.getElementById('errors-status');
      errorsDot.className = 'dot ' + (h.errorCount > 0 ? 'red' : 'green');
      errorsStatus.textContent = h.errorCount > 0 ? String(h.errorCount) : 'none';
```

- [ ] **Step 9: Add fetchErrors() to refreshAll()**

In the `refreshAll()` function, add `fetchErrors()` to the `Promise.all` array:

```js
  Promise.all([
    fetchHealth(),
    fetchPanel('events'),
    fetchPanel('metrics'),
    fetchPanel('tokens'),
    fetchPanel('models'),
    fetchPanel('projects'),
    fetchErrors()
  ]).then(function() {
```

- [ ] **Step 10: Manually test the dashboard**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun run dashboard`
Expected: Dashboard opens at localhost:7777 with a new "Errors" tab showing "No active errors" and a green error indicator dot in the health bar.

- [ ] **Step 11: Run all tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test`
Expected: All tests pass

- [ ] **Step 12: Commit**

```bash
git add bin/dashboard.ts
git commit -m "feat(f002): add Errors tab, API endpoint, and health indicator to dashboard"
```

---

## Final Verification

- [ ] **Run full test suite:** `bun test`
- [ ] **Start daemon briefly:** `bun run start` — verify clean startup with error table clear
- [ ] **Check dashboard:** `bun run dashboard` — verify Errors tab, health indicator, all existing tabs unaffected
