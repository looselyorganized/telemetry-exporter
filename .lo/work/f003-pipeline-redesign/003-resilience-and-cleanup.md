---
status: pending
feature_id: "f003"
feature: "Pipeline Redesign"
phase: 3
---

# Pipeline Redesign — Phase 3: Resilience & Cleanup

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate silent data loss during failed project registrations, rate-limit telemetry verification, and clean up stale dashboard CSS and legacy slug derivation left over from Phase 1 and 2.

**Architecture:** Extract a testable `RegistrationRetryTracker` class to `src/registration-retry.ts` (avoids importing top-level daemon.ts in tests). The tracker owns event buffers, retry backoff state, and a `bufferedMeta` map that preserves original dirName/slug at failure time so periodic retries have correct values. Telemetry verification moves from every-5s inline call to the 5-minute periodic cycle with projId filtering. Dashboard CSS and legacy slug are one-line fixes.

**Tech Stack:** Bun, TypeScript, Supabase JS client, bun:test

**Spec:** `.lo/work/f003-pipeline-redesign/spec.md` — Sections 4, 6, and leftover items t003/t004

**Depends on:** Phase 1 + Phase 2 complete (db/ modules, ProjectResolver)

---

## File Structure

### New files

```
src/registration-retry.ts               # RegistrationRetryTracker class
src/__tests__/registration-retry.test.ts # Tests for the tracker
```

### Modified files

```
bin/daemon.ts            # Replace inline retry state with tracker, add periodic retry cycle
src/db/telemetry.ts      # Separate verify from upsert, export verify, add projId filter
bin/dashboard.ts         # Replace old CSS category classes with new ones
src/project/resolver.ts  # Fix legacy slug derivation (reverse-lookup instead of encoded path)
```

---

## Chunk 1: RegistrationRetryTracker

### Task 1: Create `src/registration-retry.ts` with tests (TDD)

**Files:**
- Create: `src/__tests__/registration-retry.test.ts`
- Create: `src/registration-retry.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/registration-retry.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { RegistrationRetryTracker } from "../registration-retry";
import type { LogEntry } from "../parsers";

function fakeEntry(project: string, i: number): LogEntry {
  return {
    timestamp: `3/12 10:0${i} AM`,
    parsedTimestamp: new Date(`2026-03-12T10:0${i}:00`),
    project,
    branch: "main",
    emoji: "🔧",
    eventType: "tool",
    eventText: `event-${i}`,
  };
}

describe("RegistrationRetryTracker", () => {
  let tracker: RegistrationRetryTracker;

  beforeEach(() => {
    tracker = new RegistrationRetryTracker();
  });

  // ── markFailed / hasFailed ──

  test("hasFailed returns false for unknown projId", () => {
    expect(tracker.hasFailed("proj_abc")).toBe(false);
  });

  test("markFailed makes hasFailed return true", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    expect(tracker.hasFailed("proj_abc")).toBe(true);
  });

  test("size tracks number of failed projects", () => {
    expect(tracker.size).toBe(0);
    tracker.markFailed("proj_a", "a", "a");
    tracker.markFailed("proj_b", "b", "b");
    expect(tracker.size).toBe(2);
  });

  // ── buffering ──

  test("bufferEvent stores and totalBuffered counts", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    expect(tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 0))).toBe(true);
    expect(tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 1))).toBe(true);
    expect(tracker.totalBuffered).toBe(2);
  });

  test("bufferEvent returns false when buffer is full", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    for (let i = 0; i < 1000; i++) {
      tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 0));
    }
    expect(tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 0))).toBe(false);
    expect(tracker.totalBuffered).toBe(1000);
  });

  // ── meta ──

  test("getMeta returns stored dirName and slug", () => {
    tracker.markFailed("proj_abc", "my-project", "my-proj-slug");
    expect(tracker.getMeta("proj_abc")).toEqual({
      dirName: "my-project",
      slug: "my-proj-slug",
    });
  });

  test("getMeta returns undefined for unknown projId", () => {
    expect(tracker.getMeta("proj_unknown")).toBeUndefined();
  });

  test("markFailed does not overwrite existing meta", () => {
    tracker.markFailed("proj_abc", "original-dir", "original-slug");
    tracker.markFailed("proj_abc", "new-dir", "new-slug");
    expect(tracker.getMeta("proj_abc")).toEqual({
      dirName: "original-dir",
      slug: "original-slug",
    });
  });

  // ── markSuccess (returns drained buffer) ──

  test("markSuccess clears failed state and returns buffered events", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 0));
    tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 1));

    const drained = tracker.markSuccess("proj_abc");
    expect(drained).toHaveLength(2);
    expect(tracker.hasFailed("proj_abc")).toBe(false);
    expect(tracker.totalBuffered).toBe(0);
    expect(tracker.getMeta("proj_abc")).toBeUndefined();
  });

  test("markSuccess returns empty array when no buffer", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    const drained = tracker.markSuccess("proj_abc");
    expect(drained).toHaveLength(0);
  });

  // ── backoff: getReadyToRetry / recordAttempt ──

  test("newly failed project is ready on first periodic cycle", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    expect(tracker.getReadyToRetry(1)).toEqual(["proj_abc"]);
  });

  test("after recordAttempt, project is not ready until backoff elapses", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");

    // Attempt 1 at cycle 1 → next retry at cycle 1 + 1 = 2
    tracker.recordAttempt("proj_abc", 1);
    expect(tracker.getReadyToRetry(1)).toEqual([]);
    expect(tracker.getReadyToRetry(2)).toEqual(["proj_abc"]);
  });

  test("backoff doubles: 1, 2, 4, then caps at 6", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");

    // Attempt 1 at cycle 0 → delay 1 → ready at 1
    tracker.recordAttempt("proj_abc", 0);
    expect(tracker.getReadyToRetry(1)).toEqual(["proj_abc"]);

    // Attempt 2 at cycle 1 → delay 2 → ready at 3
    tracker.recordAttempt("proj_abc", 1);
    expect(tracker.getReadyToRetry(2)).toEqual([]);
    expect(tracker.getReadyToRetry(3)).toEqual(["proj_abc"]);

    // Attempt 3 at cycle 3 → delay 4 → ready at 7
    tracker.recordAttempt("proj_abc", 3);
    expect(tracker.getReadyToRetry(6)).toEqual([]);
    expect(tracker.getReadyToRetry(7)).toEqual(["proj_abc"]);

    // Attempt 4 at cycle 7 → delay capped at 6 → ready at 13
    tracker.recordAttempt("proj_abc", 7);
    expect(tracker.getReadyToRetry(12)).toEqual([]);
    expect(tracker.getReadyToRetry(13)).toEqual(["proj_abc"]);
  });

  // ── abandoned ──

  test("getAbandonedToReport returns empty before max attempts", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    for (let i = 0; i < 5; i++) tracker.recordAttempt("proj_abc", i * 10);
    expect(tracker.getAbandonedToReport()).toHaveLength(0);
  });

  test("getAbandonedToReport returns project after 6 failures", () => {
    tracker.markFailed("proj_abc", "my-project", "my-proj-slug");
    for (let i = 0; i < 6; i++) tracker.recordAttempt("proj_abc", i * 10);

    const abandoned = tracker.getAbandonedToReport();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toEqual({
      projId: "proj_abc",
      attempts: 6,
      dirName: "my-project",
      slug: "my-proj-slug",
    });
  });

  test("abandoned project is excluded from getReadyToRetry", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    for (let i = 0; i < 6; i++) tracker.recordAttempt("proj_abc", i * 10);
    expect(tracker.getReadyToRetry(9999)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/__tests__/registration-retry.test.ts
```

Expected: FAIL — `registration-retry` module not found.

- [ ] **Step 3: Implement `src/registration-retry.ts`**

```typescript
// src/registration-retry.ts
import type { LogEntry } from "./parsers";

export interface BufferedMeta {
  dirName: string;
  slug: string;
}

/**
 * Tracks failed project registrations with exponential backoff retry.
 *
 * Extracted from daemon.ts for testability (daemon.ts has top-level
 * side effects that prevent direct import in tests).
 *
 * Owns: failed state, event buffers, original dirName/slug metadata,
 * attempt counts, and backoff scheduling.
 */
export class RegistrationRetryTracker {
  static readonly MAX_BUFFER = 1000;
  static readonly MAX_ATTEMPTS = 6;

  private failed = new Set<string>();
  private buffers = new Map<string, LogEntry[]>();
  private meta = new Map<string, BufferedMeta>();
  private attempts = new Map<string, number>();
  private nextRetry = new Map<string, number>();

  /**
   * Mark a project as having failed registration.
   * Stores original dirName/slug so periodic retry has correct values.
   * Does not overwrite existing meta (preserves the first-seen dirName).
   */
  markFailed(projId: string, dirName: string, slug: string): void {
    this.failed.add(projId);
    if (!this.meta.has(projId)) {
      this.meta.set(projId, { dirName, slug });
      this.attempts.set(projId, 0);
      this.nextRetry.set(projId, 0);
    }
  }

  /**
   * Mark a project as successfully registered.
   * Returns drained buffer (caller inserts via normal insertEvents path).
   * Clears all tracking state for this projId.
   */
  markSuccess(projId: string): LogEntry[] {
    this.failed.delete(projId);
    const buffered = this.buffers.get(projId) ?? [];
    this.buffers.delete(projId);
    this.meta.delete(projId);
    this.attempts.delete(projId);
    this.nextRetry.delete(projId);
    return buffered;
  }

  hasFailed(projId: string): boolean {
    return this.failed.has(projId);
  }

  /**
   * Buffer an event for a failed-registration project.
   * Returns false if buffer is full (caller should reportError).
   */
  bufferEvent(projId: string, entry: LogEntry): boolean {
    const buf = this.buffers.get(projId) ?? [];
    if (buf.length >= RegistrationRetryTracker.MAX_BUFFER) return false;
    buf.push(entry);
    this.buffers.set(projId, buf);
    return true;
  }

  getMeta(projId: string): BufferedMeta | undefined {
    return this.meta.get(projId);
  }

  /**
   * Returns projIds eligible for retry at the given cycle.
   * Excludes abandoned projects (>= MAX_ATTEMPTS).
   */
  getReadyToRetry(currentCycle: number): string[] {
    const ready: string[] = [];
    for (const projId of this.failed) {
      const attempt = this.attempts.get(projId) ?? 0;
      if (attempt >= RegistrationRetryTracker.MAX_ATTEMPTS) continue;
      const next = this.nextRetry.get(projId) ?? 0;
      if (currentCycle >= next) ready.push(projId);
    }
    return ready;
  }

  /**
   * Record a retry attempt. Computes next eligible cycle using
   * exponential backoff: 1, 2, 4, cap at 6 cycles.
   */
  recordAttempt(projId: string, currentCycle: number): void {
    const attempt = (this.attempts.get(projId) ?? 0) + 1;
    this.attempts.set(projId, attempt);
    const delayCycles = Math.min(2 ** (attempt - 1), 6);
    this.nextRetry.set(projId, currentCycle + delayCycles);
  }

  /**
   * Returns projects that have exhausted all retry attempts.
   * Caller reports these via reportError once daily.
   */
  getAbandonedToReport(): Array<{
    projId: string;
    attempts: number;
    dirName: string;
    slug: string;
  }> {
    const abandoned: Array<{
      projId: string;
      attempts: number;
      dirName: string;
      slug: string;
    }> = [];
    for (const projId of this.failed) {
      const attempt = this.attempts.get(projId) ?? 0;
      if (attempt >= RegistrationRetryTracker.MAX_ATTEMPTS) {
        const m = this.meta.get(projId);
        if (m) abandoned.push({ projId, attempts: attempt, ...m });
      }
    }
    return abandoned;
  }

  /** Number of projIds currently tracked as failed. */
  get size(): number {
    return this.failed.size;
  }

  /** Total buffered events across all projects. */
  get totalBuffered(): number {
    let total = 0;
    for (const buf of this.buffers.values()) total += buf.length;
    return total;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/__tests__/registration-retry.test.ts
```

Expected: all 14 tests pass.

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: all tests pass (existing tests unaffected — new module is additive).

- [ ] **Step 6: Commit**

```bash
git add src/registration-retry.ts src/__tests__/registration-retry.test.ts
git commit -m "feat: add RegistrationRetryTracker — exponential backoff with bufferedMeta"
```

---

### Task 2: Wire tracker into `bin/daemon.ts` — replace inline state

**Files:**
- Modify: `bin/daemon.ts`

This task replaces the inline `failedRegistrations`, `bufferedEvents`, and `MAX_BUFFERED_EVENTS_PER_PROJECT` with the tracker. Does NOT add the periodic retry cycle yet (that's Task 3).

- [ ] **Step 1: Add import**

At `bin/daemon.ts` line 63, after the PID_FILE import, add:

```typescript
import { RegistrationRetryTracker } from "../src/registration-retry";
```

- [ ] **Step 2: Replace inline state (lines 129-136)**

Remove:

```typescript
// Projects whose upsert failed — buffer their events until registration succeeds
const failedRegistrations = new Set<string>();

// Buffered events for failed-registration projects — drained after successful upsert
const bufferedEvents = new Map<string, LogEntry[]>();

// Maximum events to buffer per project while registration is pending
const MAX_BUFFERED_EVENTS_PER_PROJECT = 1000;
```

Replace with:

```typescript
// Tracks failed registrations with exponential backoff, event buffers, and original meta
const tracker = new RegistrationRetryTracker();
```

- [ ] **Step 3: Update `ensureProjects` (lines 188-237)**

Replace the full `ensureProjects` function body. Key changes:
- `failedRegistrations.delete(projId)` → `tracker.markSuccess(projId)` (returns drained buffer)
- `failedRegistrations.add(projId)` → `tracker.markFailed(projId, localName, slug)`
- `bufferedEvents.get(projId)` / `bufferedEvents.delete(projId)` → handled by `markSuccess`

```typescript
async function ensureProjects(entries: LogEntry[]): Promise<void> {
  const newProjIds = new Set<string>();
  const projIdToLocal = new Map<string, string>();
  const projIdToSlug = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.project) continue;
    const projId = toProjId(entry.project);
    const slug = toSlug(entry.project);
    if (!projId || !slug) continue;
    if (!knownProjects.has(projId)) {
      newProjIds.add(projId);
      projIdToLocal.set(projId, entry.project);
      projIdToSlug.set(projId, slug);
    }
  }

  for (const projId of newProjIds) {
    const localName = projIdToLocal.get(projId) ?? "";
    const slug = projIdToSlug.get(projId) ?? "";
    const visibility = getVisibility(localName);
    const firstEntry = entries.find((e) => toProjId(e.project) === projId);
    const ok = await upsertProject(projId, slug, localName, visibility, firstEntry?.parsedTimestamp ?? undefined);
    if (ok) {
      knownProjects.add(projId);
      console.log(`  Project registered: ${slug} [${projId}]${slug !== localName ? ` (dir: ${localName})` : ""} (${visibility})`);

      // Drain any buffered events from prior failed registration attempts
      const buffered = tracker.markSuccess(projId);
      if (buffered.length > 0) {
        console.log(`  Draining ${buffered.length} buffered events for ${slug} [${projId}]`);
        try {
          const { insertedByProject } = await insertEvents(buffered);
          const lastActiveByProject = computeLastActive(buffered);
          for (const [pid, count] of Object.entries(insertedByProject)) {
            const lastActive = lastActiveByProject[pid] ?? new Date();
            await updateProjectActivity(pid, count, lastActive);
          }
        } catch (err) {
          console.error(`  Failed to drain buffered events for ${slug} [${projId}], will retry next cycle:`, err);
        }
      }
    } else {
      tracker.markFailed(projId, localName, slug);
      console.error(`  Project registration failed: ${slug} [${projId}] — buffering events, will retry`);
    }
  }
}
```

- [ ] **Step 4: Update `insertAndTrackActivity` (lines 280-309)**

Replace the buffering block. Key changes:
- `failedRegistrations.has(entry.project)` → `tracker.hasFailed(entry.project)`
- Buffer push → `tracker.bufferEvent(entry.project, entry)`
- Buffer full warning → `reportError("project_registration", ...)` for Errors tab visibility

```typescript
async function insertAndTrackActivity(entries: LogEntry[]): Promise<{
  inserted: number;
  errors: number;
}> {
  const loEntries = filterAndMapLocal(entries);
  const toInsert: LogEntry[] = [];
  for (const entry of loEntries) {
    if (tracker.hasFailed(entry.project)) {
      if (!tracker.bufferEvent(entry.project, entry)) {
        reportError("project_registration", "event buffer full — dropping events", {
          projId: entry.project,
          limit: RegistrationRetryTracker.MAX_BUFFER,
        });
      }
    } else {
      toInsert.push(entry);
    }
  }
  const { inserted, errors, insertedByProject } = await insertEvents(toInsert);

  const lastActiveByProject = computeLastActive(toInsert);
  for (const [projId, count] of Object.entries(insertedByProject)) {
    const lastActive = lastActiveByProject[projId] ?? new Date();
    await updateProjectActivity(projId, count, lastActive);
  }

  return { inserted, errors };
}
```

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: all tests pass (behavior unchanged — just using tracker instead of inline state).

- [ ] **Step 6: Commit**

```bash
git add bin/daemon.ts
git commit -m "refactor: daemon uses RegistrationRetryTracker instead of inline retry state"
```

---

### Task 3: Add periodic retry cycle and abandoned reporting

**Files:**
- Modify: `bin/daemon.ts`

Adds the periodic retry block to the 5-minute cycle. Also adds daily abandoned project reporting.

- [ ] **Step 1: Add `retryFailedRegistrations` function**

Add this function after `ensureProjects` and before `computeTodayTokens` (around line 240):

```typescript
/**
 * Periodic retry: re-attempt upsertProject for projects in the tracker.
 * Called every 5 minutes (60 cycles). Uses stored meta for dirName/slug.
 */
async function retryFailedRegistrations(currentCycle: number): Promise<void> {
  const readyToRetry = tracker.getReadyToRetry(currentCycle);
  if (readyToRetry.length === 0) return;

  console.log(`  Retrying ${readyToRetry.length} failed registrations...`);

  for (const projId of readyToRetry) {
    const meta = tracker.getMeta(projId);
    if (!meta) continue;

    const visibility = getVisibility(meta.dirName);
    const ok = await upsertProject(projId, meta.slug, meta.dirName, visibility);

    if (ok) {
      knownProjects.add(projId);
      console.log(`  Retry succeeded: ${meta.slug} [${projId}]`);

      const buffered = tracker.markSuccess(projId);
      if (buffered.length > 0) {
        console.log(`  Draining ${buffered.length} buffered events for ${meta.slug} [${projId}]`);
        const { insertedByProject } = await insertEvents(buffered);
        const lastActiveByProject = computeLastActive(buffered);
        for (const [pid, count] of Object.entries(insertedByProject)) {
          const lastActive = lastActiveByProject[pid] ?? new Date();
          await updateProjectActivity(pid, count, lastActive);
        }
      }
    } else {
      tracker.recordAttempt(projId, currentCycle);
      console.warn(`  Retry failed: ${meta.slug} [${projId}] (attempt ${(tracker as any)["attempts"]?.get?.(projId) ?? "?"})`);
    }
  }

  // Report abandoned projects (6+ failures) — these stop retrying
  for (const abandoned of tracker.getAbandonedToReport()) {
    reportError("project_registration", `registration abandoned after ${abandoned.attempts} attempts`, {
      projId: abandoned.projId,
      dirName: abandoned.dirName,
      slug: abandoned.slug,
    });
  }
}
```

**Note:** The `(tracker as any)` log line is for debug output only. A cleaner approach is to add a `getAttempts(projId)` method to the tracker, but the spec says YAGNI — this log line is sufficient.

- [ ] **Step 2: Wire into 5-minute periodic block**

In `bin/daemon.ts`, the 5-minute periodic block is at lines 757-769 inside `aggregateLoop`. Add the retry call AFTER `refreshResolver()` (so the resolver has fresh data):

```typescript
// Periodic tasks every ~60 cycles (~5 minutes at 5s interval)
if (cycleCount % 60 === 0 && cycleCount > 0) {
  const statsCache = readStatsCache();
  await refreshResolver();
  await retryFailedRegistrations(cycleCount);
  await refreshProjectCachesFromDisk();
  const settled = await Promise.allSettled([
    maybeSyncDailyMetrics(statsCache),
    maybeSyncProjectDailyMetrics(),
    maybePruneEvents(),
  ]);
  for (const r of settled) {
    if (r.status === "rejected") console.error("  Periodic task failed:", r.reason);
  }
  pruneSeenEntries();
}
```

The only change is inserting `await retryFailedRegistrations(cycleCount);` after `refreshResolver()`.

- [ ] **Step 3: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add bin/daemon.ts
git commit -m "feat: periodic registration retry with exponential backoff and abandoned reporting"
```

---

## Chunk 2: Telemetry Verification Rate Limiting

### Task 4: Move `verifyProjectTelemetry` to 5-minute cycle with projId filter

**Files:**
- Modify: `src/db/telemetry.ts`
- Modify: `bin/daemon.ts`

Per spec section 6: move verification from every 5-second `batchUpsertProjectTelemetry` call to the 5-minute periodic cycle. Filter by written projIds instead of fetching the entire table.

- [ ] **Step 1: Refactor `src/db/telemetry.ts`**

Three changes:
1. Remove the `await verifyProjectTelemetry(updates)` call from `batchUpsertProjectTelemetry` (line 90)
2. Export `verifyProjectTelemetry` (add `export` keyword)
3. Add optional `projIds` parameter to filter the SELECT query

Replace `verifyProjectTelemetry` (lines 96-119) with:

```typescript
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
    .select("id, tokens_lifetime");

  if (projIds && projIds.length > 0) {
    query = query.in("id", projIds);
  }

  const { data: rows } = await query;

  if (!rows) return;

  const dbValues = new Map(rows.map((r) => [r.id as string, Number(r.tokens_lifetime)]));
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
```

And update `batchUpsertProjectTelemetry` to return written projIds instead of verifying inline:

Change the return type and end of function:

```typescript
export async function batchUpsertProjectTelemetry(
  updates: ProjectTelemetryUpdate[],
  options: { skipAgentFields?: boolean } = {}
): Promise<{ writtenProjIds: string[] }> {
  if (updates.length === 0) return { writtenProjIds: [] };

  // ... existing upsert logic unchanged (lines 30-87) ...

  // REMOVE line 90:
  // await verifyProjectTelemetry(updates);

  // Return projIds that were written (all on batch success, tracked on fallback)
  return { writtenProjIds: updates.map((u) => u.projId) };
}
```

For the per-row fallback path, track successes:

After line 70 (`let succeeded = 0;`), the existing fallback loop already tracks `succeeded`. Change the return to only include successful projIds:

```typescript
  if (error) {
    console.error(`  project_telemetry: batch upsert failed (${error.message}), falling back to per-row`);
    checkResult(
      { error },
      { operation: "batchUpsertProjectTelemetry.batch", category: "telemetry_sync" }
    );
    const writtenProjIds: string[] = [];
    for (const update of updates) {
      const rowResult = await getSupabase()
        .from("project_telemetry")
        .upsert(toRow(update), { onConflict: "id" });
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
```

- [ ] **Step 2: Update daemon.ts callers**

There are 3 call sites in daemon.ts that call `batchUpsertProjectTelemetry`:

**a) `syncFacilityStatus` (line 456):**

```typescript
// Before:
await batchUpsertProjectTelemetry(buildProjectTelemetryUpdates(agentsByProject));

// After:
const { writtenProjIds } = await batchUpsertProjectTelemetry(buildProjectTelemetryUpdates(agentsByProject));
```

Store `writtenProjIds` in module state for the 5-minute verify cycle:

Add after `cachedModelStats` declaration (around line 177):

```typescript
// Last written projIds for periodic telemetry verification
let lastWrittenProjIds: string[] = [];
let lastWrittenUpdates: ProjectTelemetryUpdate[] = [];
```

Update `syncFacilityStatus`:

```typescript
async function syncFacilityStatus(
  statsCache: ReturnType<typeof readStatsCache>,
  modelStats: ReturnType<typeof readModelStats>
): Promise<ReturnType<typeof getFacilityState>> {
  const facility = getFacilityState();

  const agentsByProject: Record<string, { count: number; active: number }> = {};
  for (const proc of facility.processes) {
    if (proc.projId === "unknown") continue;
    const entry = agentsByProject[proc.projId] ??= { count: 0, active: 0 };
    entry.count++;
    if (proc.isActive) entry.active++;
  }

  const update: FacilityUpdate = {
    ...buildFacilityMetrics(statsCache, modelStats),
    status: facility.status,
    activeAgents: facility.activeAgents,
    activeProjects: facility.activeProjects,
  };

  await updateFacilityStatus(update);
  const telemetryUpdates = buildProjectTelemetryUpdates(agentsByProject);
  const { writtenProjIds } = await batchUpsertProjectTelemetry(telemetryUpdates);
  lastWrittenProjIds = writtenProjIds;
  lastWrittenUpdates = telemetryUpdates;

  return facility;
}
```

**b) `syncAggregateMetrics` (line 468):**

```typescript
async function syncAggregateMetrics(
  statsCache: ReturnType<typeof readStatsCache>,
  modelStats: ReturnType<typeof readModelStats>
): Promise<void> {
  await updateFacilityMetrics(buildFacilityMetrics(statsCache, modelStats));
  const telemetryUpdates = buildProjectTelemetryUpdates();
  const { writtenProjIds } = await batchUpsertProjectTelemetry(telemetryUpdates, { skipAgentFields: true });
  lastWrittenProjIds = writtenProjIds;
  lastWrittenUpdates = telemetryUpdates;
}
```

**c) Add import for `verifyProjectTelemetry`:**

```typescript
import { batchUpsertProjectTelemetry, verifyProjectTelemetry } from "../src/db/telemetry";
```

**d) Add verification to 5-minute periodic block:**

In the periodic block (after `retryFailedRegistrations`):

```typescript
if (cycleCount % 60 === 0 && cycleCount > 0) {
  const statsCache = readStatsCache();
  await refreshResolver();
  await retryFailedRegistrations(cycleCount);
  if (lastWrittenProjIds.length > 0) {
    await verifyProjectTelemetry(lastWrittenUpdates, lastWrittenProjIds);
  }
  await refreshProjectCachesFromDisk();
  // ... rest unchanged
}
```

- [ ] **Step 3: Run full test suite**

```bash
bun test
```

Expected: all tests pass. The sync-resilience tests don't call `verifyProjectTelemetry` directly.

- [ ] **Step 4: Commit**

```bash
git add src/db/telemetry.ts bin/daemon.ts
git commit -m "perf: move telemetry verification to 5-min cycle with projId filter"
```

---

## Chunk 3: Cleanup

### Task 5: Update dashboard CSS for new error categories (t003)

**Files:**
- Modify: `bin/dashboard.ts:283-286`

- [ ] **Step 1: Replace old CSS classes with new ones**

In `bin/dashboard.ts`, replace lines 283-286:

```css
  .cat-sync_write { background: #3d2e00; color: #ffc850; }
  .cat-project_resolution { background: #2e003d; color: #c850ff; }
  .cat-supabase_transient { background: #003d2e; color: #50ffc8; }
  .cat-facility_update { background: #3d0000; color: #ff5050; }
```

With:

```css
  .cat-event_write { background: #3d2e00; color: #ffc850; }
  .cat-project_registration { background: #2e003d; color: #c850ff; }
  .cat-facility_state { background: #3d0000; color: #ff5050; }
  .cat-metrics_sync { background: #2e3d00; color: #c8ff50; }
  .cat-telemetry_sync { background: #003d3d; color: #50c8ff; }
  .cat-supabase_transient { background: #003d2e; color: #50ffc8; }
```

Mapping:
- `sync_write` → `event_write` (same amber color — events are the primary write)
- `project_resolution` → `project_registration` (same purple)
- `facility_update` → `facility_state` (same red)
- NEW: `metrics_sync` (yellow-green)
- NEW: `telemetry_sync` (cyan)
- `supabase_transient` unchanged

- [ ] **Step 2: Run tests (no test changes needed — CSS is not tested)**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add bin/dashboard.ts
git commit -m "fix: update dashboard CSS for new error category names (t003)"
```

---

### Task 6: Fix legacy resolver slug derivation (t004)

**Files:**
- Modify: `src/project/resolver.ts:120-127`

- [ ] **Step 1: Fix the legacy mapping section**

In `src/project/resolver.ts`, replace lines 120-127:

```typescript
    // 4. Legacy .project-mapping.json
    const legacyMap = loadLegacyMapping();
    for (const [encodedName, projId] of legacyMap) {
      if (!newMap.has(encodedName)) {
        newMap.set(encodedName, { projId, slug: encodedName });
        fromLegacy++;
      }
    }
```

With:

```typescript
    // 4. Legacy .project-mapping.json
    const legacyMap = loadLegacyMapping();
    for (const [encodedName, projId] of legacyMap) {
      if (!newMap.has(encodedName)) {
        // Reverse-lookup projId in already-resolved entries for a real slug.
        // Avoids using encodedName as slug (breaks display) or split("-") on
        // projId (breaks hyphenated names like telemetry-exporter).
        let slug = encodedName;
        for (const [, resolved] of newMap) {
          if (resolved.projId === projId) {
            slug = resolved.slug;
            break;
          }
        }
        newMap.set(encodedName, { projId, slug });
        fromLegacy++;
      }
    }
```

This works because disk + Supabase + org-root entries are already loaded by this point. If the project exists in any prior source, the legacy entry inherits its real slug. If not (truly orphaned), it falls back to encodedName — but that project has no better slug available anyway.

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: all tests pass (project-resolver tests pass — legacy entries with known projIds now get proper slugs).

- [ ] **Step 3: Commit**

```bash
git add src/project/resolver.ts
git commit -m "fix: legacy resolver entries use real slug via reverse-lookup (t004)"
```
