# Outbox Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the telemetry exporter from a monolithic daemon into a staged pipeline (Receivers -> Processor -> SQLite Outbox -> Shipper -> Supabase) for local durability, pluggable export targets, and clean separation of concerns.

**Architecture:** Local SQLite WAL database as a durable outbox between data collection and cloud delivery. Receivers parse sources, the Processor resolves/aggregates/writes to the outbox, the Shipper reads from the outbox and pushes to Supabase. Process watcher stays direct to Supabase (bypasses outbox).

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (built-in), `@supabase/supabase-js`, macOS launchd

**Spec:** `docs/superpowers/specs/2026-03-19-outbox-pipeline-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/db/local.ts` | SQLite init, WAL mode, outbox CRUD, cursor CRUD, archive queue, prune operations |
| `src/pipeline/processor.ts` | Receives parsed data, resolves projects, aggregates, deduplicates, writes to SQLite outbox in transactions |
| `src/pipeline/shipper.ts` | Reads outbox, ships to Supabase per strategy dispatch table, manages retries + circuit breaker |
| `src/pipeline/receivers.ts` | LogReceiver, TokenReceiver, MetricsReceiver adapters wrapping existing parsers |
| `src/verify/outbox-reader.ts` | Reads from SQLite outbox for dashboard comparison (replaces local-reader.ts) |
| `src/db/__tests__/local.test.ts` | Tests for SQLite operations |
| `src/pipeline/__tests__/processor.test.ts` | Tests for processor logic |
| `src/pipeline/__tests__/shipper.test.ts` | Tests for shipper logic |
| `src/pipeline/__tests__/receivers.test.ts` | Tests for receiver adapters |

### Modified Files

| File | Changes |
|------|---------|
| `bin/daemon.ts` | Stage 3: Replace with thin orchestrator (~200 lines) |
| `bin/dashboard.ts` | Stage 4: Add `/api/outbox`, update `/api/health`, switch compare endpoints to outbox reader |
| `src/db/types.ts` | Add `ShipResult`, `ShippingStrategy` types (Task 7). `OutboxRow`/`ArchiveRow`/`CursorRow` co-located in `src/db/local.ts`. |
| `src/parsers.ts` | Add `resetOffset()` and `currentOffset()` to LogTailer |
| `.gitignore` | Add `data/` directory |

### Removed Files (Stage 3+)

| File | Reason |
|------|--------|
| `src/registration-retry.ts` | Replaced by outbox retry + FK dependency check |
| `src/verify/local-reader.ts` | Replaced by `outbox-reader.ts` (Stage 4) |

---

## Stage 1: Add SQLite Layer

### Task 1: SQLite Init and Schema [parallel]

**Files:**
- Create: `src/db/local.ts`
- Create: `src/db/__tests__/local.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Add `data/` to .gitignore**

Append to `.gitignore`:
```
data/
```

- [ ] **Step 2: Write failing test for SQLite init**

```typescript
// src/db/__tests__/local.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initLocal, getLocal, closeLocal } from "../local";
import { existsSync, unlinkSync } from "fs";

const TEST_DB = "/tmp/lo-test-outbox.db";

beforeEach(() => {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
});

afterEach(() => {
  try { closeLocal(); } catch {}
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
});

describe("initLocal", () => {
  test("creates database file", () => {
    initLocal(TEST_DB);
    expect(existsSync(TEST_DB)).toBe(true);
  });

  test("enables WAL mode", () => {
    initLocal(TEST_DB);
    const db = getLocal();
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
  });

  test("creates outbox table", () => {
    initLocal(TEST_DB);
    const tables = getLocal().query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='outbox'"
    ).all();
    expect(tables.length).toBe(1);
  });

  test("creates cursors table", () => {
    initLocal(TEST_DB);
    const tables = getLocal().query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='cursors'"
    ).all();
    expect(tables.length).toBe(1);
  });

  test("creates known_projects table", () => {
    initLocal(TEST_DB);
    const tables = getLocal().query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='known_projects'"
    ).all();
    expect(tables.length).toBe(1);
  });

  test("creates archive_queue table", () => {
    initLocal(TEST_DB);
    const tables = getLocal().query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='archive_queue'"
    ).all();
    expect(tables.length).toBe(1);
  });

  test("is idempotent (safe to call twice)", () => {
    initLocal(TEST_DB);
    initLocal(TEST_DB);
    expect(existsSync(TEST_DB)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/db/__tests__/local.test.ts`
Expected: FAIL -- `../local` module not found

- [ ] **Step 4: Implement initLocal, getLocal, closeLocal**

```typescript
// src/db/local.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

let db: Database | null = null;

export function initLocal(dbPath: string): void {
  if (db) db.close();

  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target      TEXT NOT NULL,
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TEXT NOT NULL,
      shipped_at  TEXT,
      error       TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cursors (
      source     TEXT PRIMARY KEY,
      offset     INTEGER NOT NULL DEFAULT 0,
      checksum   TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS known_projects (
      proj_id    TEXT PRIMARY KEY,
      slug       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS archive_queue (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_type    TEXT NOT NULL,
      payload      TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      shipped_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_outbox_shipped ON outbox(shipped_at) WHERE shipped_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_outbox_target ON outbox(target, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_content ON archive_queue(fact_type, content_hash);
    CREATE INDEX IF NOT EXISTS idx_archive_unshipped ON archive_queue(shipped_at) WHERE shipped_at IS NULL;
  `);
}

export function getLocal(): Database {
  if (!db) throw new Error("SQLite not initialized -- call initLocal() first");
  return db;
}

export function closeLocal(): void {
  if (db) { db.close(); db = null; }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/db/__tests__/local.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/local.ts src/db/__tests__/local.test.ts .gitignore
git commit -m "feat: add SQLite init with WAL mode and outbox schema"
```

### Task 2: Outbox CRUD Operations (depends on 1)

**Files:**
- Modify: `src/db/local.ts`
- Modify: `src/db/__tests__/local.test.ts`

- [ ] **Step 1: Write failing tests for enqueue/dequeue/mark**

Add tests for: `enqueue`, `dequeueUnshipped`, `markShipped`, `markFailed`, `markTransientError`. See spec for expected behaviors -- backoff filter in dequeue, retry_count increment, max 10 retries.

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/db/__tests__/local.test.ts`
Expected: FAIL -- functions not exported

- [ ] **Step 3: Implement outbox operations**

Add to `src/db/local.ts`: `OutboxRow` type, `enqueue()`, `dequeueUnshipped()` (with backoff filter using `min(power(2, retry_count), 60)`), `markShipped()`, `markFailed()`, `markTransientError()` (increments retry_count, marks failed after 10).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/db/__tests__/local.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/local.ts src/db/__tests__/local.test.ts
git commit -m "feat: add outbox enqueue/dequeue/mark with exponential backoff"
```

### Task 3: Cursor, Archive, Known Projects, Prune Operations (depends on 2)

**Files:**
- Modify: `src/db/local.ts`
- Modify: `src/db/__tests__/local.test.ts`

- [ ] **Step 1: Write failing tests**

Tests for: `getCursor`/`setCursor`, `enqueueArchive`/`dequeueUnshippedArchive`/`markArchiveShipped` (with content_hash dedup), `addKnownProject`/`getKnownProjectIds`/`isKnownProject`, `pruneShipped`/`pruneShippedArchive`/`outboxDepth`/`archiveDepth`.

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement all operations**

Add to `src/db/local.ts`: cursor CRUD, archive queue CRUD with INSERT OR IGNORE for dedup, known_projects CRUD, prune functions using `julianday` diff.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/db/__tests__/local.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/local.ts src/db/__tests__/local.test.ts
git commit -m "feat: add cursor, archive, known_projects, and prune operations"
```

### Task 4: Wire SQLite Init into Daemon Startup (depends on 1)

**Files:**
- Modify: `bin/daemon.ts`

- [ ] **Step 1: Import and call initLocal after Supabase init**

Add SQLite init after the existing `initSupabase()` call. Use the codebase's path resolution pattern: `bin/` files use `join(dirname(fileURLToPath(import.meta.url)), "..")` to reach the repo root. Example: `initLocal(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "telemetry.db"))`. Add startup log line.

- [ ] **Step 2: Run existing tests**

Run: `bun test`
Expected: All 283 existing tests still pass

- [ ] **Step 3: Manual smoke test**

Run `bun run start`, verify `data/telemetry.db` is created, daemon runs normally. Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add bin/daemon.ts
git commit -m "feat: initialize SQLite at daemon startup (no behavior change)"
```

---

## Stage 2: Receivers + Processor + Shipper

### Task 5: LogTailer Cursor Support [parallel]

**Files:**
- Modify: `src/parsers.ts`

- [ ] **Step 1: Add resetOffset and currentOffset to LogTailer**

```typescript
// Add to LogTailer class in src/parsers.ts
resetOffset(offset: number): void { this.offset = offset; }
currentOffset(): number { return this.offset; }
```

- [ ] **Step 2: Write tests for the new methods**

Add to `src/__tests__/parsers.test.ts`:

```typescript
test("currentOffset returns byte position after readAll", () => {
  // Write test data, call readAll, verify currentOffset > 0
});

test("resetOffset changes read position for next poll", () => {
  // Write test data, readAll, resetOffset(0), poll returns all entries again
});
```

- [ ] **Step 3: Run parser tests**

Run: `bun test src/__tests__/parsers.test.ts`
Expected: All tests pass (existing + new)

- [ ] **Step 4: Commit**

```bash
git add src/parsers.ts
git commit -m "feat: add resetOffset/currentOffset to LogTailer for cursor persistence"
```

### Task 6: Receiver Adapters (depends on 5)

**Files:**
- Create: `src/pipeline/receivers.ts`
- Create: `src/pipeline/__tests__/receivers.test.ts`

- [ ] **Step 1: Write failing tests for LogReceiver**

Test: `readAll()` reads entries and persists cursor to SQLite, `poll()` returns only new entries, rotation detection (file smaller than cursor resets).

- [ ] **Step 2: Implement LogReceiver, TokenReceiver, MetricsReceiver**

`LogReceiver` wraps `LogTailer`, restores cursor from SQLite on construction, persists after reads. `TokenReceiver` wraps `scanProjectTokens`. `MetricsReceiver` wraps `readStatsCache` + `readModelStats`.

- [ ] **Step 3: Run tests**

Run: `bun test src/pipeline/__tests__/receivers.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Run full suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/receivers.ts src/pipeline/__tests__/receivers.test.ts
git commit -m "feat: add receiver adapters (LogReceiver, TokenReceiver, MetricsReceiver)"
```

### Task 7: Shipper -- Circuit Breaker and Strategy Dispatch [parallel]

**Files:**
- Create: `src/pipeline/shipper.ts`
- Create: `src/pipeline/__tests__/shipper.test.ts`
- Modify: `src/db/types.ts` (add `ShipResult`, `ShippingStrategy` interfaces)

- [ ] **Step 1: Add ShipResult and ShippingStrategy types to src/db/types.ts**

- [ ] **Step 2: Write failing tests for CircuitBreaker**

Test: starts closed, opens after 3 consecutive failures, resets on success, transitions to half-open after timeout, half-open->closed on success, half-open->open on failure.

- [ ] **Step 2: Implement CircuitBreaker class**

State machine: closed -> open (3 failures) -> half-open (after 60s) -> closed (success) / open (failure).

- [ ] **Step 3: Write failing tests for strategy helpers**

Test: `groupByTarget`, `sortByPriority`, `filterBlockedByFK` -- groups rows, sorts by priority number, blocks events for unregistered projIds.

- [ ] **Step 4: Implement strategy dispatch helpers and SHIPPING_STRATEGIES constant**

Declarative strategy table from spec. Helper functions for grouping, sorting, FK filtering.

- [ ] **Step 5: Run tests**

Run: `bun test src/pipeline/__tests__/shipper.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/shipper.ts src/pipeline/__tests__/shipper.test.ts
git commit -m "feat: add shipper circuit breaker and strategy dispatch"
```

### Task 8: Shipper -- ship() and shipArchive() (depends on 7)

**Files:**
- Modify: `src/pipeline/shipper.ts`
- Modify: `src/pipeline/__tests__/shipper.test.ts`

- [ ] **Step 1: Write failing tests for ship()**

Test with mock Supabase: dequeues pending rows, groups by target, processes in priority order, marks shipped on success, marks transient error on 5xx, marks failed on 4xx, batch fallback to per-row, singleton dedup for facility_metrics, returns ShipResult.

- [ ] **Step 2: Implement Shipper class with ship() method**

Constructor takes `Database` + `SupabaseClient`. Implements full ship() algorithm from spec: dequeue -> circuit breaker check -> group -> sort by priority -> FK check -> dispatch per strategy -> mark results. Strips `excludeFields` from payloads.

- [ ] **Step 3: Write failing tests for shipArchive()**

Test: dequeues archive rows, upserts to outbox_archive, marks shipped.

- [ ] **Step 4: Implement shipArchive(), pruneShipped(), outboxDepth(), verify()**

`verify()` reads back `project_telemetry` from Supabase and compares against last-written updates. Logs warnings for mismatches. Called in periodic maintenance (every 5 min).

- [ ] **Step 5: Run tests**

Run: `bun test src/pipeline/__tests__/shipper.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/shipper.ts src/pipeline/__tests__/shipper.test.ts
git commit -m "feat: implement shipper ship() and shipArchive() with Supabase integration"
```

### Task 9: Processor -- processEvents (depends on Task 2, 3)

**Files:**
- Create: `src/pipeline/processor.ts`
- Create: `src/pipeline/__tests__/processor.test.ts`

- [ ] **Step 1: Write failing tests for processEvents**

Test: filters to LO projects via resolver, registers unknown projects (outbox + known_projects + Set), enqueues events to outbox, enqueues last_active updates, enqueues to archive with content hash, all in a single transaction (verify rollback on error).

- [ ] **Step 2: Implement Processor class with processEvents**

Constructor takes `ProjectResolver` + `Database`. `knownProjects` as in-memory Set. SHA-256 hash using Bun's `Bun.CryptoHasher`. Wraps all writes in `db.transaction()`.

- [ ] **Step 3: Run tests**

Run: `bun test src/pipeline/__tests__/processor.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/processor.ts src/pipeline/__tests__/processor.test.ts
git commit -m "feat: implement processor processEvents with project registration"
```

### Task 10: Processor -- processTokens and processMetrics (depends on 9)

**Files:**
- Modify: `src/pipeline/processor.ts`
- Modify: `src/pipeline/__tests__/processor.test.ts`

- [ ] **Step 1: Write failing tests for processTokens**

Test: computes token totals, queries outbox for event aggregation, merges into complete daily_metrics payloads, diffs against baseline, enqueues changed metrics + telemetry, updates baseline in memory, respects date guards.

- [ ] **Step 2: Implement processTokens**

Key: event aggregation SQL query from spec (31-day filter), merge tokens + events, diff against `tokenBaseline`, update baseline to computed values.

- [ ] **Step 3: Write failing tests for processMetrics**

Test: builds facility metrics, hashes output, skips if unchanged, enqueues facility_metrics and global daily_metrics.

- [ ] **Step 4: Implement processMetrics**

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/processor.ts src/pipeline/__tests__/processor.test.ts
git commit -m "feat: implement processTokens and processMetrics with diff and dedup"
```

### Task 11: Processor -- hydrate, snapshot, gap (depends on 10)

**Files:**
- Modify: `src/pipeline/processor.ts`
- Modify: `src/pipeline/__tests__/processor.test.ts`

- [ ] **Step 1: Write failing tests for hydrate**

Test: loads known_projects from SQLite, queries Supabase for baselines (mock), falls back to zero baselines on Supabase failure.

- [ ] **Step 2: Implement hydrate**

- [ ] **Step 3: Write failing tests for snapshotFacilityState**

Test: throttle (skip < 5 min), hourly always fires, only created/closed transitions trigger.

- [ ] **Step 4: Implement snapshotFacilityState**

- [ ] **Step 5: Write tests and implement processGapEntries**

Composition of processEvents + processTokens + processMetrics with gap-filtered entries.

- [ ] **Step 6: Implement refreshBaselines**

Queries Supabase `project_telemetry` and `daily_metrics` for lifetime counters. Updates in-memory baselines.

- [ ] **Step 7: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/processor.ts src/pipeline/__tests__/processor.test.ts
git commit -m "feat: implement hydrate, snapshotFacilityState, processGapEntries, refreshBaselines"
```

### Task 12: Wire Pipeline into Daemon with Feature Flags (depends on 6, 8, 11)

**Files:**
- Modify: `bin/daemon.ts`

- [ ] **Step 1: Add feature flag config and pipeline wiring**

Add `OUTBOX_ENABLED` record. In the aggregator loop, conditionally route through receivers + processor + shipper when enabled. Keep old direct path for disabled targets.

- [ ] **Step 2: Enable events target first, test**

Flip `events: true`. Run daemon, verify events flow through outbox to Supabase. Enable new path first, then disable old.

- [ ] **Step 3: Enable remaining targets one at a time**

`projects` -> `daily_metrics` -> `project_telemetry` -> `facility_metrics`. Test after each.

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit per target**

```bash
git commit -m "feat: migrate events target to outbox pipeline"
git commit -m "feat: migrate remaining targets to outbox pipeline"
```

---

## Stage 3: Refactor Daemon into Orchestrator

### Task 13: Replace daemon.ts with Thin Orchestrator

**Files:**
- Rewrite: `bin/daemon.ts`

- [ ] **Step 1: Write the new orchestrator (~200 lines)**

PID file ('wx' exclusive), signal handlers (close SQLite + flush errors + remove PID), init SQLite + Supabase, build pipeline stages, hydrate processor, gap detection, two loops via Promise.all. Individual receiver try/catch. Periodic maintenance on cycle counter.

- [ ] **Step 2: Remove feature flags (all through outbox now)**

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Smoke test both modes**

`bun run start` and `bun run start -- --backfill`

- [ ] **Step 5: Commit**

```bash
git add bin/daemon.ts
git commit -m "refactor: replace monolithic daemon with thin orchestrator"
```

### Task 14: Remove Dead Code (depends on 13)

**Files:**
- Remove: `src/registration-retry.ts`, `src/__tests__/registration-retry.test.ts`
- Modify: `src/db/events.ts`, `src/db/metrics.ts`, `src/db/telemetry.ts`, `src/db/facility.ts`, `src/db/projects.ts`

- [ ] **Step 1: Delete RegistrationRetryTracker and its tests**

- [ ] **Step 2: Remove direct-write functions from src/db/ modules**

Remove: `insertEvents`, `syncDailyMetrics`, `syncProjectDailyMetrics`, `deleteProjectDailyMetrics`, `batchUpsertProjectTelemetry`, `verifyProjectTelemetry`, `updateFacilityStatus`, `updateFacilityMetrics`, `upsertProject`, `updateProjectActivity`.

Keep: `setFacilitySwitch`, `pushAgentState`, `pruneOldEvents`, `src/db/client.ts` (Supabase client init + `withRetry`), `src/db/check-result.ts` (error categorization -- used by shipper and watcher).

- [ ] **Step 3: Remove tests for deleted functions, fix broken imports**

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: Remaining tests pass

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "chore: remove dead code (RegistrationRetryTracker, direct-write paths)"
```

### Task 15: Enable Archive Shipping (depends on 13)

- [ ] **Step 1: Create outbox_archive table in Supabase**

Run migration SQL from spec.

- [ ] **Step 2: Verify archive shipping works**

Run daemon, check `outbox_archive` table in Supabase for event and daily_metric facts.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: enable archive shipping to Supabase outbox_archive"
```

---

## Stage 4: Update Dashboard

### Task 16: Outbox Reader [parallel]

**Files:**
- Create: `src/verify/outbox-reader.ts`
- Create: `src/verify/__tests__/outbox-reader.test.ts`

- [ ] **Step 1: Write failing tests**

Test: reads event counts by project, token totals, known_projects from SQLite. Handles missing DB gracefully (returns empty data).

- [ ] **Step 2: Implement outbox-reader.ts**

Opens read-only SQLite connection. Returns data shape compatible with comparator.

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git add src/verify/outbox-reader.ts src/verify/__tests__/outbox-reader.test.ts
git commit -m "feat: add outbox reader for dashboard comparison"
```

### Task 17: Dashboard API Updates (depends on 16)

**Files:**
- Modify: `bin/dashboard.ts`
- Remove: `src/verify/local-reader.ts`

- [ ] **Step 1: Add /api/outbox endpoint**

Returns depth, by-target breakdown, failed rows with errors, cursors.

- [ ] **Step 2: Update /api/health with pipeline block**

- [ ] **Step 3: Switch compare endpoints to outbox reader**

- [ ] **Step 4: Delete local-reader.ts**

- [ ] **Step 5: Run all tests, manual test dashboard**

- [ ] **Step 6: Commit**

```bash
git add bin/dashboard.ts src/verify/
git commit -m "feat: update dashboard to compare outbox vs Supabase"
```

### Task 18: Final Cleanup

- [ ] **Step 1: Update CLAUDE.md with new architecture**

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for outbox pipeline architecture"
```

---

## Verification Checklist

After all 4 stages are merged:

- [ ] `bun run start` starts daemon, outbox drains to Supabase
- [ ] `bun run start -- --backfill` backfills history through outbox
- [ ] `bun run dashboard` shows pipeline health, outbox depth, compare endpoints work
- [ ] Daemon restart: outbox persists, unshipped rows drain on next startup
- [ ] Supabase outage: outbox accumulates, circuit breaker opens, drains when restored
- [ ] `data/telemetry.db` exists and is gitignored
- [ ] Process watcher (250ms) still pushes agent state directly
- [ ] All existing tests pass + new tests for all pipeline components
