# Fix tokens_today Zero on Daemon Startup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the window after daemon startup where `facility_status.tokens_today` shows 0 despite JSONL data existing for today.

**Architecture:** The root cause is a concurrency violation — the process watcher (250ms loop) updates `facility_status.updated_at` immediately via direct Supabase write, while `tokens_today` is only updated through the slow outbox pipeline. The frontend sees fresh `updated_at` and displays "Operational" with stale `tokens_today = 0`. The fix initializes `tokens_today` synchronously before starting the concurrent loops, using the same pattern as backfill mode's synchronous outbox drain.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test

---

### Task 1: Add test — todayTokensTotal survives baseline early-return

The processor computes `this.todayTokensTotal` before the baseline diff check in `processTokens`. If the baseline matches (no token changes), `processTokens` returns early — but `todayTokensTotal` must still be correct for `processMetrics` to use. This invariant is critical for the startup fix to work: the initial `processTokens` call sets the baseline, and if a second call sees the same data, it must NOT zero out `todayTokensTotal`.

**Files:**
- Modify: `src/pipeline/__tests__/processor.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("Processor.processMetrics", ...)` block (after the "tokens_today comes from tokenMap" test at line ~679):

```typescript
test("tokens_today survives processTokens baseline early-return", () => {
  const resolver = new MockResolver({});
  const processor = new Processor(resolver as any, db);

  const today = todayStr();
  const tokenMap: ProjectTokenMap = new Map([
    ["proj_aaa", new Map([
      [today, { "claude-opus-4-6": 5000, "claude-haiku-4-5": 3000 }],
    ])],
  ]);

  // First call: sets todayTokensTotal AND updates baseline
  processor.processTokens(tokenMap);

  // Second call with identical data: baseline matches → early return
  // But todayTokensTotal must still be 8000, not reset to 0
  processor.processTokens(tokenMap);

  // Verify by calling processMetrics and checking the enqueued payload
  const statsCache: StatsCache = {
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: {},
    totalSessions: 0,
    totalMessages: 0,
    firstSessionDate: null,
    hourCounts: {},
  };

  // Clear any facility_metrics from the first processTokens+processMetrics cycle
  db.query("DELETE FROM outbox WHERE target = 'facility_metrics'").run();

  // Force a new hash by changing a statsCache field
  processor.processMetrics({ ...statsCache, totalSessions: 99 }, []);

  const rows = db
    .query("SELECT * FROM outbox WHERE target = 'facility_metrics'")
    .all() as any[];
  expect(rows).toHaveLength(1);

  const payload = JSON.parse(rows[0].payload);
  expect(payload.tokens_today).toBe(8000);
});
```

- [ ] **Step 2: Run the test to verify it passes**

This test validates existing behavior (todayTokensTotal is already computed before the baseline check). It should pass immediately — we're locking in the invariant, not fixing it.

Run: `bun test src/pipeline/__tests__/processor.test.ts -t "tokens_today survives"`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/__tests__/processor.test.ts
git commit -m "test: add invariant test for todayTokensTotal surviving baseline early-return"
```

---

### Task 2: Add startup sync to daemon

This is the core fix. After gap detection (or when no gap), run one synchronous pipeline cycle (scan tokens → process → ship) before starting the concurrent watcher + pipeline loops. This guarantees `tokens_today` is correct in Supabase before the watcher starts updating `updated_at`.

**Files:**
- Modify: `bin/daemon.ts:152-160`

- [ ] **Step 1: Replace the startup section**

In `bin/daemon.ts`, replace lines 152-159 (the `// ─── Startup` section):

**Current code (lines 152-159):**
```typescript
// ─── Startup ────────────────────────────────────────────────────────────────
if (IS_BACKFILL) {
  await runBackfill();
} else {
  console.log("Reading log file...");
  await detectAndFillGap();
  console.log("  Ready — will only sync new events from this point.\n");
}
```

**Replace with:**
```typescript
// ─── Startup ────────────────────────────────────────────────────────────────
if (IS_BACKFILL) {
  await runBackfill();
} else {
  console.log("Reading log file...");
  await detectAndFillGap();

  // Always run one synchronous pipeline cycle before starting the concurrent
  // loops. This ensures tokens_today is correct in Supabase before the watcher
  // starts updating updated_at (which makes the frontend think data is fresh).
  // Note: log events are already handled by detectAndFillGap() above.
  const initialTokenMap = tokenReceiver.poll();
  processor.processTokens(initialTokenMap);
  processor.processMetrics(readStatsCache(), readModelStats());

  let startupShipped = 0;
  while (shipper.outboxDepth() > 0) {
    startupShipped += (await shipper.ship()).shipped;
    await Bun.sleep(100);
  }
  if (startupShipped > 0) console.log(`  Startup sync: shipped ${startupShipped} rows`);

  console.log("  Ready — will only sync new events from this point.\n");
}
```

**Why this is safe:**
- If gap fill ran and already called `processGapEntries` (which calls `processTokens` + `processMetrics`), the second `processTokens` call hits the baseline match → returns early. But `todayTokensTotal` is already correct (validated by Task 1's test). The second `processMetrics` call hits the hash check → returns early. No duplicate rows. The drain ships the gap fill's rows.
- If no gap was detected, this is the FIRST `processTokens`/`processMetrics` call. Rows are enqueued and immediately drained.
- The drain loop uses the exact same pattern as `runBackfill()` (lines 143-147), proven in production.
- The drain handles ~20-30 rows (10 projects × daily_metrics + project_telemetry + facility_metrics). Takes < 1 second.

- [ ] **Step 2: Verify existing tests still pass**

Run: `bun test`

Expected: All tests pass. `daemon.ts` has no unit tests (top-level side effects), but this confirms no processor/shipper regressions.

- [ ] **Step 3: Commit**

```bash
git add bin/daemon.ts
git commit -m "fix: sync tokens_today to Supabase before starting concurrent daemon loops

The process watcher updates facility_status.updated_at within 250ms of
startup, but tokens_today was only updated through the slow outbox pipeline.
This created a window where the frontend showed 'Operational' with stale
tokens_today=0.

Now the daemon runs one synchronous pipeline cycle (scan → process → ship)
before starting the watcher + pipeline loops, ensuring tokens_today is
correct in Supabase before the watcher signals freshness."
```

---

### Task 3: Manual verification

- [ ] **Step 1: Restart the daemon and observe startup**

```bash
# Stop the current daemon
kill $(cat .exporter.pid 2>/dev/null) 2>/dev/null; sleep 1

# Start fresh and watch the log
bun run start 2>&1 | head -30
```

Expected output should include:
```
  Startup sync: shipped N rows
  Ready — will only sync new events from this point.
```

- [ ] **Step 2: Query Supabase to verify tokens_today is non-zero**

Within 5 seconds of the daemon starting (before it has run any pipeline cycles), query:

```bash
bun -e "
const { createClient } = require('@supabase/supabase-js');
const c = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
const { data } = await c.from('facility_status').select('tokens_today, updated_at').single();
console.log('tokens_today:', data?.tokens_today, 'updated_at:', data?.updated_at);
"
```

Expected: `tokens_today` is non-zero (should match the sum of today's JSONL token data).

- [ ] **Step 3: Verify the frontend displays correctly**

Open the platform site and confirm the "24H" token count in the status bar shows a non-zero value immediately, not after a delay.

---
