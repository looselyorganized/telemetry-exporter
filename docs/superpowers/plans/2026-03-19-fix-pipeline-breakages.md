# Fix Telemetry Pipeline Breakages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 bugs introduced by the outbox pipeline refactor that break the platform's telemetry display.

**Architecture:** Three code fixes in `processor.ts` (eliminate global daily rows, fix tokens_today source, add slug to project activity updates), one new utility in `local.ts` (purgeFailed), dashboard reader update, test updates, one DB migration, and a backfill run. All changes are in the telemetry-exporter; no platform changes needed.

**Tech Stack:** Bun, TypeScript, bun:sqlite, Supabase (PostgreSQL), bun test

**Spec:** `docs/superpowers/specs/2026-03-19-fix-pipeline-breakages-design.md`

---

### Task 1: Stop the daemon [parallel]

**Files:** None (operational step)

- [ ] **Step 1: Stop the running daemon**

```bash
launchctl unload ~/Library/LaunchAgents/com.lo.telemetry-exporter.plist 2>/dev/null || true
# Verify it's stopped
ps aux | grep "bin/daemon.ts" | grep -v grep
```

Expected: No matching processes (or kill manually if still running).

---

### Task 2: DB migration — eliminate global daily_metrics rows [parallel]

**Files:** Supabase migration (3 SQL statements)

- [ ] **Step 1: Run the migration**

Execute against Supabase (project ID: `yatzprmgcmqfkmrokuet`):

```sql
-- 1. Delete redundant global rows (project_id IS NULL)
DELETE FROM daily_metrics WHERE project_id IS NULL;

-- 2. Prevent future NULL project_id rows
ALTER TABLE daily_metrics ALTER COLUMN project_id SET NOT NULL;

-- 3. Add unique constraint for upsert support
CREATE UNIQUE INDEX idx_daily_metrics_date_project ON daily_metrics (date, project_id);
```

- [ ] **Step 2: Verify migration**

```sql
-- Should return 0
SELECT COUNT(*) FROM daily_metrics WHERE project_id IS NULL;

-- Should show the new index
SELECT indexname FROM pg_indexes WHERE tablename = 'daily_metrics' AND indexname = 'idx_daily_metrics_date_project';
```

---

### Task 3: Fix `processEvents` — add slug to project activity updates

**Files:**
- Modify: `src/pipeline/processor.ts:86-99`
- Test: `src/pipeline/__tests__/processor.test.ts`

- [ ] **Step 1: Write failing test**

Add to the `processEvents` describe block in `src/pipeline/__tests__/processor.test.ts`:

```ts
test("project activity updates include slug", () => {
  const resolver = new MockResolver({
    "my-project": { projId: "proj_aaa", slug: "my-project" },
  });
  const processor = new Processor(resolver as any, db);
  processor.loadKnownProjects();

  const entries: LogEntry[] = [
    makeEntry({ project: "my-project", eventType: "session_start", eventText: "Started", parsedTimestamp: new Date("2026-03-19T10:00:00.000Z") }),
  ];
  processor.processEvents(entries);

  // Get all projects rows from outbox
  const rows = db
    .query("SELECT * FROM outbox WHERE target = 'projects' ORDER BY id")
    .all() as any[];

  // Activity update (second row) must also include slug
  const activityRow = rows.find((r: any) => {
    const p = JSON.parse(r.payload);
    return p.last_active !== undefined;
  });
  expect(activityRow).toBeDefined();
  const payload = JSON.parse(activityRow!.payload);
  expect(payload.slug).toBe("my-project");
  expect(payload.id).toBe("proj_aaa");
  expect(payload.last_active).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/pipeline/__tests__/processor.test.ts -t "project activity updates include slug"
```

Expected: FAIL — `payload.slug` is `undefined`.

- [ ] **Step 3: Implement the fix**

In `src/pipeline/processor.ts`, replace lines 86-99:

```ts
      // Step 4: Enqueue project activity updates (one per project, using latest timestamp)
      const latestByProject = new Map<string, string>();
      for (const { entry, projId } of resolved) {
        if (entry.parsedTimestamp === null) continue;
        const ts = entry.parsedTimestamp.toISOString();
        const existing = latestByProject.get(projId);
        if (!existing || ts > existing) {
          latestByProject.set(projId, ts);
        }
      }

      // Build slug lookup from resolved entries
      const slugByProject = new Map<string, string>();
      for (const { projId, slug } of resolved) {
        slugByProject.set(projId, slug);
      }

      for (const [projId, lastActive] of latestByProject) {
        enqueue("projects", { id: projId, slug: slugByProject.get(projId), last_active: lastActive });
      }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/pipeline/__tests__/processor.test.ts -t "project activity updates include slug"
```

Expected: PASS

- [ ] **Step 5: Run all processor tests**

```bash
bun test src/pipeline/__tests__/processor.test.ts
```

Expected: All pass (the global daily_metrics test at line 620 will still pass for now — we remove it in Task 5).

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/processor.ts src/pipeline/__tests__/processor.test.ts
git commit -m "fix: include slug in project activity updates to prevent NOT NULL violation"
```

---

### Task 4: Fix `processMetrics` — tokens_today from tokenMap, remove global rows

**Note:** This task modifies `processor.ts` after Task 3. Line numbers below reference the file state *before* Task 3's changes. After Task 3 adds ~6 lines to the `processEvents` method, lines in `processTokens` and `processMetrics` shift by ~6. Use the method signatures and comments as anchors rather than exact line numbers.

**Files:**
- Modify: `src/pipeline/processor.ts` — class fields (near line 28), `processTokens` method, `processMetrics` method
- Test: `src/pipeline/__tests__/processor.test.ts`

- [ ] **Step 1: Write failing test for tokens_today**

Add to the `processMetrics` describe block in `src/pipeline/__tests__/processor.test.ts`:

```ts
test("tokens_today comes from tokenMap, not statsCache", () => {
  const resolver = new MockResolver({});
  const processor = new Processor(resolver as any, db);

  const today = todayStr();

  // Create a tokenMap with today's data
  const tokenMap: ProjectTokenMap = new Map([
    ["proj_aaa", new Map([
      [today, { "claude-opus-4-6": 5000, "claude-haiku-4-5": 3000 }],
    ])],
  ]);

  // Process tokens first (sets todayTokensTotal)
  processor.processTokens(tokenMap);

  // Process metrics with empty statsCache (no dailyModelTokens)
  const statsCache: StatsCache = {
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: {},
    totalSessions: 0,
    totalMessages: 0,
    firstSessionDate: null,
    hourCounts: {},
  };
  processor.processMetrics(statsCache, []);

  const rows = db
    .query("SELECT * FROM outbox WHERE target = 'facility_metrics'")
    .all() as any[];
  expect(rows).toHaveLength(1);

  const payload = JSON.parse(rows[0].payload);
  // tokens_today should be 8000 (5000 + 3000) from tokenMap, not 0 from empty statsCache
  expect(payload.tokens_today).toBe(8000);
});
```

- [ ] **Step 2: Write test that global daily_metrics are NOT produced**

```ts
test("does not enqueue global daily_metrics rows", () => {
  const resolver = new MockResolver({});
  const processor = new Processor(resolver as any, db);

  const statsCache: StatsCache = {
    dailyActivity: [
      { date: todayStr(), messageCount: 5, sessionCount: 2, toolCallCount: 12 },
    ],
    dailyModelTokens: [
      { date: todayStr(), tokensByModel: { "claude-opus-4-6": 8000 } },
    ],
    modelUsage: {},
    totalSessions: 10,
    totalMessages: 50,
    firstSessionDate: "2025-01-01",
    hourCounts: {},
  };

  processor.processMetrics(statsCache, []);

  const rows = db
    .query("SELECT * FROM outbox WHERE target = 'daily_metrics'")
    .all() as any[];
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
bun test src/pipeline/__tests__/processor.test.ts -t "tokens_today comes from tokenMap"
bun test src/pipeline/__tests__/processor.test.ts -t "does not enqueue global daily_metrics"
```

Expected: Both FAIL — tokens_today is 0 (from empty statsCache), global rows are still produced.

- [ ] **Step 4: Add `todayTokensTotal` field to Processor class**

In `src/pipeline/processor.ts`, add after line 28 (`private lastSnapshotTime: number = 0;`):

```ts
  private todayTokensTotal: number = 0;
```

- [ ] **Step 5: Compute todayTokensTotal unconditionally in processTokens**

In `src/pipeline/processor.ts`, move the today-tokens computation (lines 129-138) BEFORE the `hasChanges` guard (line 127). Replace lines 104-138 with:

```ts
  /** Process token data: enqueue daily_metrics and project_telemetry updates. */
  processTokens(tokenMap: ProjectTokenMap): void {
    const today = new Date().toISOString().substring(0, 10);

    // 1. Compute lifetime totals per project
    const tokensByProject = computeTokensByProject(tokenMap);

    // 2. Compute today's tokens unconditionally (used by processMetrics)
    let todayTotal = 0;
    const todayTokensByProject: Record<string, { total: number; models: Record<string, number> }> = {};
    for (const [projId, dateMap] of tokenMap) {
      const todayModels = dateMap.get(today);
      if (todayModels) {
        let total = 0;
        for (const t of Object.values(todayModels)) total += t;
        todayTokensByProject[projId] = { total, models: { ...todayModels } };
        todayTotal += total;
      }
    }
    this.todayTokensTotal = todayTotal;

    // 3. Check baseline diff — skip enqueuing if nothing changed
    let hasChanges = false;
    for (const [projId, total] of Object.entries(tokensByProject)) {
      if (this.tokenBaseline.get(projId) !== total) {
        hasChanges = true;
        break;
      }
    }
    // Also check if a project was removed from baseline
    if (!hasChanges) {
      for (const projId of this.tokenBaseline.keys()) {
        if (!(projId in tokensByProject)) {
          hasChanges = true;
          break;
        }
      }
    }
    if (!hasChanges) return;
```

(The rest of processTokens from line 140 onwards stays the same — it already uses `todayTokensByProject` which is now computed above.)

- [ ] **Step 6: Fix processMetrics — use todayTokensTotal, remove global rows**

Replace the `processMetrics` method (lines 376-457) with:

```ts
  /** Process facility-wide metrics: enqueue facility_metrics. */
  processMetrics(statsCache: StatsCache | null, modelStats: ModelStats[]): void {
    // 1. Compute lifetime totals from baselines
    let tokensLifetime = 0;
    for (const total of this.tokenBaseline.values()) {
      tokensLifetime += total;
    }

    let sessionsLifetime = 0;
    let messagesLifetime = 0;
    for (const counters of this.lifetimeBaseline.values()) {
      sessionsLifetime += counters.sessions;
      messagesLifetime += counters.messages;
    }

    // 2. Build facility metrics (tokens_today from tokenMap via processTokens)
    const facilityPayload = {
      tokens_lifetime: tokensLifetime,
      tokens_today: this.todayTokensTotal,
      sessions_lifetime: sessionsLifetime,
      messages_lifetime: messagesLifetime,
      model_stats: formatModelStats(modelStats),
      hour_distribution: statsCache?.hourCounts ?? {},
      first_session_date: statsCache?.firstSessionDate ?? null,
      updated_at: new Date().toISOString(),
    };

    // 3. Hash to detect changes
    const hashInput = JSON.stringify({ facilityPayload });
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(hashInput);
    const metricsHash = hasher.digest("hex");

    if (metricsHash === this.lastMetricsHash) return;

    this.db.transaction(() => {
      enqueue("facility_metrics", facilityPayload);
      this.lastMetricsHash = metricsHash;
    })();
  }
```

- [ ] **Step 7: Run new tests to verify they pass**

```bash
bun test src/pipeline/__tests__/processor.test.ts -t "tokens_today comes from tokenMap"
bun test src/pipeline/__tests__/processor.test.ts -t "does not enqueue global daily_metrics"
```

Expected: Both PASS.

- [ ] **Step 8: Remove old global daily_metrics test (lines 620-652)**

Delete the entire test block `"enqueues global daily_metrics to outbox"` from `src/pipeline/__tests__/processor.test.ts`.

- [ ] **Step 9: Run all processor tests**

```bash
bun test src/pipeline/__tests__/processor.test.ts
```

Expected: All pass.

- [ ] **Step 10: Commit**

```bash
git add src/pipeline/processor.ts src/pipeline/__tests__/processor.test.ts
git commit -m "fix: compute tokens_today from tokenMap, eliminate global daily_metrics rows"
```

---

### Task 5: Add `purgeFailed()` and call at daemon startup

**Files:**
- Modify: `src/db/local.ts`
- Modify: `bin/daemon.ts:84-88`
- Test: `src/db/__tests__/local.test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/db/__tests__/local.test.ts`. Update the import on line 4 to include `purgeFailed` and `enqueue`:

```ts
import { initLocal, getLocal, closeLocal, enqueue, purgeFailed } from "../local";
```

Then add the test:

```ts
describe("purgeFailed", () => {
  it("deletes failed rows and returns count", () => {
    initLocal(TEST_DB_PATH);

    // Insert some rows with different statuses
    enqueue("projects", { id: "proj_1" });
    enqueue("projects", { id: "proj_2" });
    enqueue("events", { id: "ev_1" });

    // Manually mark some as failed
    const db = getLocal();
    db.run("UPDATE outbox SET status = 'failed' WHERE id IN (1, 2)");

    const purged = purgeFailed();
    expect(purged).toBe(2);

    // Verify only the pending row remains
    const remaining = db.query("SELECT * FROM outbox").all();
    expect(remaining).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/db/__tests__/local.test.ts -t "purgeFailed"
```

Expected: FAIL — `purgeFailed` is not defined.

- [ ] **Step 3: Implement purgeFailed**

Add to `src/db/local.ts` after the `markFailed` function:

```ts
/**
 * Delete all permanently failed rows from the outbox.
 * Safe because dequeueUnshipped only picks up 'pending' rows.
 */
export function purgeFailed(): number {
  const db = getLocal();
  const result = db.run("DELETE FROM outbox WHERE status = 'failed'");
  return result.changes;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/db/__tests__/local.test.ts -t "purgeFailed"
```

Expected: PASS.

- [ ] **Step 5: Wire into daemon startup**

In `bin/daemon.ts`, add after line 85 (`console.log(\`  SQLite: ${DB_PATH}\`);`):

```ts
const purged = purgeFailed();
if (purged > 0) console.log(`  Purged ${purged} permanently failed outbox rows`);
```

And add `purgeFailed` to the import from `"../src/db/local"` on line 22.

- [ ] **Step 6: Run all local tests**

```bash
bun test src/db/__tests__/local.test.ts
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/db/local.ts bin/daemon.ts src/db/__tests__/local.test.ts
git commit -m "feat: add purgeFailed() and call at daemon startup"
```

---

### Task 6: Update verification dashboard remote reader

**Files:**
- Modify: `src/verify/remote-reader.ts:95-115`

- [ ] **Step 1: Replace readRemoteMetrics**

In `src/verify/remote-reader.ts`, replace lines 95-115 with:

```ts
async function readRemoteMetrics(supabase: SupabaseClient): Promise<{ data: RemoteMetrics; ok: boolean }> {
  const { data, error } = await supabase
    .from("daily_metrics")
    .select("date, messages, sessions, tool_calls")
    .order("date", { ascending: true });

  if (error || !data) return { data: { dailyActivity: [] }, ok: false };

  // Aggregate per-project rows by date (same pattern as platform's getDailyActivity)
  const byDate = new Map<string, { messages: number; sessions: number; toolCalls: number }>();
  for (const row of data) {
    const date = row.date as string;
    const existing = byDate.get(date) ?? { messages: 0, sessions: 0, toolCalls: 0 };
    existing.messages += Number(row.messages) || 0;
    existing.sessions += Number(row.sessions) || 0;
    existing.toolCalls += Number(row.tool_calls) || 0;
    byDate.set(date, existing);
  }

  return {
    data: {
      dailyActivity: Array.from(byDate.entries()).map(([date, counts]) => ({
        date,
        ...counts,
      })),
    },
    ok: true,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/verify/remote-reader.ts
git commit -m "fix: aggregate per-project daily_metrics in dashboard remote reader"
```

---

### Task 7: Clean up dead NOT NULL filters

**Files:**
- Modify: `src/db/metrics.ts`
- Modify: `src/pipeline/processor.ts:330,346`

- [ ] **Step 1: Update deleteProjectDailyMetrics**

Replace `src/db/metrics.ts` entirely:

```ts
/**
 * Daily metrics operations.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";

/**
 * Delete all daily_metrics rows.
 * Used before backfill to ensure stale rows don't persist.
 */
export async function deleteProjectDailyMetrics(): Promise<number> {
  const result = await getSupabase()
    .from("daily_metrics")
    .delete({ count: "exact" })
    .neq("id", 0); // match all rows (Supabase requires a filter)

  if (!checkResult(result, { operation: "deleteProjectDailyMetrics", category: "metrics_sync" })) {
    return 0;
  }

  return result.count ?? 0;
}
```

- [ ] **Step 2: Remove redundant `.not("project_id", "is", null)` from processor.ts**

In `src/pipeline/processor.ts` `_loadBaselinesFromSupabase()`, delete the `.not("project_id", "is", null)` line at ~line 330, so the chain ends at the `)` of `.select(...)`. Do the same for the second occurrence at ~line 346.

Before:
```ts
        .not("project_id", "is", null);
```

After: delete the entire `.not(...)` line. The preceding `.select(...)` closing paren already ends the chain.

- [ ] **Step 3: Update test mocks to match new call chain**

In `src/pipeline/__tests__/processor.test.ts`, the `makeMockSupabase` (line 732) and `makeTelemetryOnlyMockSupabase` (line 747) functions chain `.not()` after `.select()`. After removing `.not()` from the production code, `.select()` must return `{ data, error }` directly (as a Promise), not `{ not: ... }`.

Replace `makeMockSupabase` (lines 732-743):

```ts
function makeMockSupabase(telemetryRows: any[], dailyRows: any[], error: any = null) {
  return {
    from: (table: string) => ({
      select: (..._args: any[]) =>
        Promise.resolve({
          data: table === "project_telemetry" ? telemetryRows : dailyRows,
          error,
        }),
    }),
  };
}
```

Replace `makeTelemetryOnlyMockSupabase` (lines 747-768):

```ts
function makeTelemetryOnlyMockSupabase(telemetryRows: any[], error: any = null) {
  return {
    from: (table: string) => ({
      select: (..._args: any[]) =>
        Promise.resolve({
          data: table === "project_telemetry" ? telemetryRows : [],
          error,
        }),
    }),
  };
}
```

- [ ] **Step 4: Run all tests**

```bash
bun test
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/metrics.ts src/pipeline/processor.ts src/pipeline/__tests__/processor.test.ts
git commit -m "chore: remove dead NOT NULL filters after daily_metrics migration"
```

---

### Task 8: Backfill and verify

**Files:** None (operational step)

- [ ] **Step 1: Start daemon with backfill**

```bash
bun run backfill
```

Expected: Backfill completes, ships all rows, then daemon continues running.

- [ ] **Step 2: Verify facility_status.tokens_today > 0**

Query Supabase:
```sql
SELECT tokens_today, tokens_lifetime, updated_at FROM facility_status LIMIT 1;
```

Expected: `tokens_today > 0`, `updated_at` is recent.

- [ ] **Step 3: Verify daily_metrics has no NULL project_id**

```sql
SELECT COUNT(*) FROM daily_metrics WHERE project_id IS NULL;
```

Expected: 0 (and the query will actually error since column is NOT NULL — that's fine).

- [ ] **Step 4: Verify outbox is clean**

```bash
bun run dashboard
```

Expected: No failed rows, outbox drains to near-zero.

- [ ] **Step 5: Verify platform shows tokens**

Check https://looselyorganized.xyz/ — hero dash should show non-zero "tokens 24h".

---

## Task Dependency Graph

```
Task 1 (stop daemon) ──┐
                        ├── Task 3 (fix slug) ── Task 4 (fix tokens) ──┐
Task 2 (DB migration) ─┤                                               ├── Task 7 (cleanup) ── Task 8 (backfill)
                        ├── Task 5 (purgeFailed) [parallel] ────────────┤
                        └── Task 6 (dashboard) [parallel] ─────────────┘
```

- Tasks 1 and 2 must complete first (stop daemon before migration).
- Tasks 3 and 4 are **sequential** (both modify `processor.ts`; line numbers in Task 4 assume Task 3 is already applied).
- Tasks 5 and 6 can run in parallel with 3/4 (different files).
- Task 7 depends on Tasks 2, 3, 4 (migration + processor changes must be in place before removing NOT NULL filters and updating test mocks).
- Task 8 is last (backfill + verify).
