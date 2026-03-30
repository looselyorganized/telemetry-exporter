# Exporter Pipeline Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewire the telemetry exporter to use the new Supabase schema (sessions, daily_rollups, agent_state, otel_api_requests). Remove JSONL token scanning, fix session resolution, add PID→session mapping.

**Architecture:** Incremental refactor of the existing `telemetry-exporter/` codebase. Each task produces a compilable, testable intermediate state. The old pipeline paths are removed only after new ones are verified.

**Tech Stack:** Bun, SQLite (bun:sqlite), Supabase JS client, child_process (ps/lsof)

**TDD:** `platform/docs/superpowers/specs/2026-03-30-telemetry-architecture-tdd.md`

**Prerequisites:** Plan 1 (Supabase Schema + RPC) must be complete. The new tables and RPC functions must exist in Supabase.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/pipeline/otel-receiver.ts` | Modify | Fix head-of-line blocking, process tool_decision/api_error events |
| `src/db/local.ts` | Modify | Add processed=2 state, add parent_session_id/pid to sessions, remove cost_tracking |
| `src/otel/session-registry.ts` | Modify | Capture parent_session_id from subagent paths |
| `src/process/scanner.ts` | Modify | Add PID→session_id via lsof tasks dir |
| `src/db/agent-state.ts` | Rewrite | Target agent_state table instead of project_telemetry + facility_status |
| `src/pipeline/shipper.ts` | Modify | Update SHIPPING_STRATEGIES for new tables |
| `src/pipeline/processor.ts` | Major refactor | Rewrite processOtelBatch, remove processTokens/processMetrics/baselines |
| `src/pipeline/receivers.ts` | Modify | Remove TokenReceiver and MetricsReceiver classes |
| `bin/daemon.ts` | Modify | Remove old receiver/processor calls, refresh registry every cycle |
| `src/parsers.ts` | Modify | Remove readStatsCache, readModelStats |
| `src/project/scanner.ts` | Modify | Remove scanProjectTokens, computeTokensByProject |

---

### Task 1: Fix head-of-line blocking in OtelReceiver

This is the most urgent fix — unresolved non-LO events are clogging the entire OTel pipeline.

**Files:**
- Modify: `src/db/local.ts`
- Modify: `src/pipeline/otel-receiver.ts`

- [ ] **Step 1: Add skipOtelEvents function and update getUnprocessedOtelEvents query**

In `src/db/local.ts`, add a function to mark events as skipped, and update the query to exclude skipped events:

```typescript
/** Mark OTel events as skipped (non-LO project). */
export function skipOtelEvents(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getLocal();
  const placeholders = ids.map(() => "?").join(",");
  db.query(`UPDATE otel_events SET processed = 2 WHERE id IN (${placeholders})`).run(...ids);
}
```

Also update `getUnprocessedOtelEvents` to only return `processed = 0` (it already does this, just verify).

- [ ] **Step 2: Add isLOSession helper to otel-receiver.ts**

In `src/pipeline/otel-receiver.ts`, add a helper that checks if a session_id belongs to a LO project directory by scanning `~/.claude/projects/` for a matching `.jsonl` file in an LO-rooted encoded directory:

```typescript
import { readdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const LO_ENCODED_PREFIX = "-Users-bigviking-Documents-github-projects-lo-".toLowerCase();

function isLOSession(sessionId: string): boolean | null {
  // Check if any .jsonl file matching this sessionId exists under an LO-encoded dir
  try {
    for (const dir of readdirSync(PROJECTS_DIR)) {
      const dirPath = join(PROJECTS_DIR, dir);
      // Check top-level .jsonl
      try {
        const files = readdirSync(dirPath);
        if (files.includes(`${sessionId}.jsonl`)) {
          return dir.toLowerCase().startsWith(LO_ENCODED_PREFIX);
        }
        // Check subagent dirs
        for (const entry of files) {
          if (entry.endsWith(".jsonl")) continue;
          try {
            const subDir = join(dirPath, entry, "subagents");
            const subFiles = readdirSync(subDir);
            if (subFiles.includes(`${sessionId}.jsonl`)) {
              return dir.toLowerCase().startsWith(LO_ENCODED_PREFIX);
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return null; // session file not found yet — leave for retry
}
```

- [ ] **Step 3: Update poll() to skip non-LO events and expire stale ones**

In `src/pipeline/otel-receiver.ts`, modify the `poll()` method. When a session can't be found via `lookupSession()`, check `isLOSession()`:

```typescript
const session = lookupSession(row.session_id);
if (!session) {
  const isLO = isLOSession(row.session_id);
  if (isLO === false) {
    // Non-LO session — skip permanently
    skippedIds.push(row.id);
  } else {
    // Either LO (will resolve on next registry refresh) or unknown (file not yet created)
    // Expire if stuck for > 5 minutes
    const ageMs = Date.now() - new Date(row.received_at).getTime();
    if (ageMs > 5 * 60 * 1000) {
      skippedIds.push(row.id);
    } else {
      unresolved++;
    }
  }
  continue;
}
```

Add `skippedIds` array alongside `resolvedIds`, and call `skipOtelEvents(skippedIds)` after `markOtelEventsProcessed(resolvedIds)`.

Also add `tool_decision` and `api_error` event processing (they were previously marked as processed and ignored):

```typescript
} else if (row.event_type === "tool_decision") {
  const decision = getStr(attrs, "decision");
  if (decision === "reject") {
    toolDecisionRejects.push({
      projId: session.proj_id,
      sessionId: row.session_id,
      toolName: getStr(attrs, "tool_name"),
      timestamp,
    });
  }
  resolvedIds.push(row.id);
} else if (row.event_type === "api_error") {
  apiErrors.push({
    projId: session.proj_id,
    sessionId: row.session_id,
    error: getStr(attrs, "error"),
    statusCode: getNum(attrs, "status_code"),
    model: getStr(attrs, "model"),
    timestamp,
  });
  resolvedIds.push(row.id);
} else {
  resolvedIds.push(row.id);
}
```

Update the `OtelEventBatch` interface to include `toolDecisionRejects` and `apiErrors` arrays, plus `skipped` count.

- [ ] **Step 4: Run tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test src/pipeline/__tests__/otel-receiver.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/otel-receiver.ts src/db/local.ts
git commit -m "fix(otel): skip non-LO sessions, expire stale events, process tool_decision/api_error

Fixes head-of-line blocking where 500+ non-LO events permanently
clogged the unprocessed queue. Non-LO events are now marked processed=2.
Events unresolved for >5min are expired. tool_decision (reject) and
api_error events are now extracted for downstream processing."
```

---

### Task 2: Session registry improvements

**Files:**
- Modify: `src/otel/session-registry.ts`
- Modify: `src/db/local.ts`

- [ ] **Step 1: Add parent_session_id to SQLite sessions table**

In `src/db/local.ts`, update the sessions CREATE TABLE to include `parent_session_id` and `pid`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,
  proj_id            TEXT NOT NULL,
  parent_session_id  TEXT,
  pid                INTEGER,
  cwd                TEXT NOT NULL,
  first_seen         TEXT NOT NULL
);
```

Update `upsertSession` to accept optional `parentSessionId`:

```typescript
export function upsertSession(
  sessionId: string,
  projId: string,
  cwd: string,
  parentSessionId?: string | null
): void {
  const db = getLocal();
  const now = new Date().toISOString();
  db.query(
    "INSERT OR IGNORE INTO sessions (session_id, proj_id, parent_session_id, cwd, first_seen) VALUES (?, ?, ?, ?, ?)"
  ).run(sessionId, projId, parentSessionId ?? null, cwd, now);
}
```

- [ ] **Step 2: Capture parent_session_id in session-registry.ts**

In `src/otel/session-registry.ts`, the subagent scanning loop (lines 98-116) already iterates `<session-uuid>/subagents/<child-uuid>.jsonl`. Update to pass the parent session UUID:

```typescript
// Scan subagent directories: <session-uuid>/subagents/<uuid>.jsonl
for (const entry of entries) {
  if (entry.endsWith(".jsonl")) continue;
  if (!isUuid(entry)) continue; // parent session UUID is the dir name
  try {
    const subDir = join(dirPath, entry, "subagents");
    for (const sf of readdirSync(subDir)) {
      if (!sf.endsWith(".jsonl")) continue;
      const subSessionId = basename(sf, ".jsonl");
      if (!isUuid(subSessionId)) continue;
      if (!getSession(subSessionId)) {
        upsertSession(subSessionId, projId, cwd, entry); // entry = parent session UUID
        archiveSessionMapping(subSessionId, projId, cwd);
        registered++;
      }
    }
  } catch {}
}
```

- [ ] **Step 3: Also ship sessions to Supabase sessions table**

In `src/otel/session-registry.ts`, when a new session is registered, also enqueue it for shipping to the Supabase `sessions` table:

```typescript
import { enqueue } from "../db/local";

// In the main session registration loop:
if (!getSession(sessionId)) {
  upsertSession(sessionId, projId, cwd);
  archiveSessionMapping(sessionId, projId, cwd);
  enqueue("sessions", {
    id: sessionId,
    project_id: projId,
    parent_session_id: null,
    started_at: new Date().toISOString(),
  });
  registered++;
}

// In the subagent loop:
if (!getSession(subSessionId)) {
  upsertSession(subSessionId, projId, cwd, entry);
  archiveSessionMapping(subSessionId, projId, cwd);
  enqueue("sessions", {
    id: subSessionId,
    project_id: projId,
    parent_session_id: entry,
    started_at: new Date().toISOString(),
  });
  registered++;
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test src/otel/__tests__/session-registry.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/otel/session-registry.ts src/db/local.ts
git commit -m "feat(sessions): capture parent_session_id, ship sessions to Supabase"
```

---

### Task 3: PID→session mapping via lsof

**Files:**
- Modify: `src/process/scanner.ts`

- [ ] **Step 1: Add resolveSessionId function**

```typescript
/** PID→session cache (immutable for PID lifetime). */
const pidSessionCache = new Map<number, string | null>();

/**
 * Resolve a Claude PID to its session_id by finding
 * the open ~/.claude/tasks/<session_id>/ directory handle.
 */
export function resolveSessionId(pid: number): string | null {
  if (pidSessionCache.has(pid)) return pidSessionCache.get(pid)!;

  const output = execQuiet(`lsof -p ${pid} 2>/dev/null`);
  if (!output) {
    pidSessionCache.set(pid, null);
    return null;
  }

  for (const line of output.split("\n")) {
    const match = line.match(/\.claude\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (match) {
      const sessionId = match[1];
      pidSessionCache.set(pid, sessionId);
      return sessionId;
    }
  }

  pidSessionCache.set(pid, null);
  return null;
}

/** Clear PID→session cache for closed PIDs. */
export function clearPidSession(pid: number): void {
  pidSessionCache.delete(pid);
}
```

- [ ] **Step 2: Add sessionId to ClaudeProcess and scanProcesses**

Update the `ClaudeProcess` interface:

```typescript
export interface ClaudeProcess {
  pid: number;
  cpuPercent: number;
  memMb: number;
  uptime: string;
  cwd: string;
  projectName: string;
  projId: string;
  isActive: boolean;
  model: string;
  sessionId: string | null;  // NEW
}
```

In `scanProcesses()`, add `resolveSessionId` call:

```typescript
return claudeProcs.map((p) => {
  const cwd = cwdMap[p.pid] ?? "";
  return {
    pid: p.pid,
    cpuPercent: p.cpu,
    memMb: p.memMb,
    uptime: p.uptime,
    cwd,
    projectName: deriveProjectName(cwd),
    projId: deriveProjId(cwd),
    isActive: p.cpu > 1 || cafPids.has(p.pid),
    model: "",
    sessionId: resolveSessionId(p.pid),
  };
});
```

- [ ] **Step 3: Clean up cache on process exit**

In `src/process/watcher.ts`, when a PID is detected as closed (lines 148-155), call `clearPidSession`:

```typescript
import { clearPidSession } from "./scanner";

// In the closed PIDs detection loop:
for (const [pid, prev] of this.previous) {
  if (!current.has(pid)) {
    events.push({ type: "instance:closed", project: prev.projId, pid });
    this.activityWindow.delete(pid);
    this.reportedActive.delete(pid);
    this.confirmationCount.delete(pid);
    clearPidSession(pid);  // NEW
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test src/process/__tests__/`

- [ ] **Step 5: Commit**

```bash
git add src/process/scanner.ts src/process/watcher.ts
git commit -m "feat(process): add PID→session_id mapping via lsof tasks dir"
```

---

### Task 4: Rewrite pushAgentState for new agent_state table

**Files:**
- Rewrite: `src/db/agent-state.ts`

- [ ] **Step 1: Rewrite agent-state.ts**

Replace the entire file. The new version writes to `agent_state` (INSERT/UPDATE/DELETE) instead of `project_telemetry` + `facility_status`:

```typescript
/**
 * Agent state push — manages the ephemeral agent_state table in Supabase.
 * INSERT when a new process appears, UPDATE on status/token changes, DELETE on exit.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";
import type { ProcessDiff } from "../process/watcher";
import type { ClaudeProcess } from "../process/scanner";

/** Track which sessions we've already inserted. */
const knownSessions = new Set<string>();

/**
 * Sync agent state from ProcessWatcher diff to Supabase agent_state table.
 */
export async function pushAgentState(
  diff: ProcessDiff,
  processes: ClaudeProcess[],
): Promise<void> {
  const now = new Date().toISOString();
  const writes: Promise<unknown>[] = [];
  const supabase = getSupabase();

  // Build a PID→process lookup
  const procByPid = new Map<number, ClaudeProcess>();
  for (const p of processes) procByPid.set(p.pid, p);

  for (const event of diff.events) {
    const proc = procByPid.get(event.pid);
    if (!proc?.sessionId || proc.projId === "unknown") continue;

    if (event.type === "instance:created") {
      // INSERT new agent
      knownSessions.add(proc.sessionId);
      writes.push(
        supabase
          .from("agent_state")
          .upsert({
            session_id: proc.sessionId,
            project_id: proc.projId,
            pid: proc.pid,
            status: proc.isActive ? "active" : "idle",
            parent_session_id: null, // TODO: resolve from session registry
            started_at: now,
            updated_at: now,
          })
          .then((result) => checkResult(result, {
            operation: "agentState.insert",
            category: "agent_state",
            entity: { sessionId: proc.sessionId },
          }))
      );
    } else if (event.type === "instance:active" || event.type === "instance:idle") {
      // UPDATE status
      writes.push(
        supabase
          .from("agent_state")
          .update({
            status: event.type === "instance:active" ? "active" : "idle",
            updated_at: now,
          })
          .eq("session_id", proc.sessionId)
          .then((result) => checkResult(result, {
            operation: "agentState.updateStatus",
            category: "agent_state",
            entity: { sessionId: proc.sessionId },
          }))
      );
    } else if (event.type === "instance:closed") {
      // DELETE agent row
      knownSessions.delete(proc.sessionId);
      writes.push(
        supabase
          .from("agent_state")
          .delete()
          .eq("session_id", proc.sessionId)
          .then((result) => checkResult(result, {
            operation: "agentState.delete",
            category: "agent_state",
            entity: { sessionId: proc.sessionId },
          }))
      );
    }
  }

  // Update facility_status heartbeat (status + updated_at only, no token fields)
  writes.push(
    supabase
      .from("facility_status")
      .update({
        active_agents: diff.facility.activeAgents,
        active_projects: diff.facility.activeProjects,
        updated_at: now,
      })
      .eq("id", 1)
      .then((result) => checkResult(result, {
        operation: "agentState.facilityHeartbeat",
        category: "facility_state",
      }))
  );

  await Promise.all(writes);
}
```

- [ ] **Step 2: Update daemon.ts to pass processes to pushAgentState**

In `bin/daemon.ts`, the watcher tick callback needs to pass the processes array:

```typescript
// Current:
if (diff) await pushAgentState(diff);

// New:
if (diff) await pushAgentState(diff, state.processes);
```

Where `state` is the `getFacilityState()` result used by the watcher.

- [ ] **Step 3: Run tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test`

- [ ] **Step 4: Commit**

```bash
git add src/db/agent-state.ts bin/daemon.ts
git commit -m "feat(agent-state): rewrite to target agent_state table with session identity"
```

---

### Task 5: Update shipping strategies

**Files:**
- Modify: `src/pipeline/shipper.ts`

- [ ] **Step 1: Add sessions and daily_rollups strategies, remove old ones**

In `src/pipeline/shipper.ts`, update `SHIPPING_STRATEGIES`:

```typescript
export const SHIPPING_STRATEGIES: Record<string, ShippingStrategy> = {
  // Sessions must ship before otel_api_requests (FK dependency)
  sessions: {
    table: "sessions",
    method: "upsert",
    onConflict: "id",
    batchSize: 50,
    fallbackToPerRow: true,
    priority: 0,
  },
  projects: {
    table: "projects",
    method: "upsert",
    onConflict: "id",
    batchSize: 50,
    fallbackToPerRow: true,
    priority: 1,
  },
  events: {
    table: "events",
    method: "upsert",
    onConflict: "project_id,event_type,event_text,timestamp",
    ignoreDuplicates: true,
    batchSize: 500,
    fallbackToPerRow: true,
    priority: 2,
  },
  otel_api_requests: {
    table: "otel_api_requests",
    method: "insert",
    batchSize: 100,
    fallbackToPerRow: true,
    priority: 2,
  },
  daily_rollups: {
    table: "daily_rollups",
    method: "upsert",
    onConflict: "project_id,date",
    batchSize: 100,
    fallbackToPerRow: true,
    priority: 3,
  },
  alerts: {
    table: "alerts",
    method: "upsert",
    onConflict: "project_id,alert_type,date",
    batchSize: 10,
    fallbackToPerRow: true,
    priority: 3,
  },
};
```

Removed: `daily_metrics`, `project_telemetry`, `facility_metrics`.

- [ ] **Step 2: Run tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test src/pipeline/__tests__/shipper.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/shipper.ts
git commit -m "feat(shipper): update strategies for new schema (sessions, daily_rollups)"
```

---

### Task 6: Rewrite processOtelBatch

This is the core change. The processor writes to new tables and removes old paths.

**Files:**
- Modify: `src/pipeline/processor.ts`

- [ ] **Step 1: Update processOtelBatch to accept new event types**

Update the method signature and batch interface imports to handle `toolDecisionRejects` and `apiErrors` from the updated OtelReceiver.

- [ ] **Step 2: Remove cost_tracking and project_telemetry from processOtelBatch**

Remove lines 376-382 (`upsertCostTracking` calls) and lines 464-502 (project_telemetry enqueue block). Remove the `costByProject` query that read from `cost_tracking`.

- [ ] **Step 3: Change daily_metrics enqueue to daily_rollups**

Replace `enqueue("daily_metrics", payload)` with `enqueue("daily_rollups", payload)`. The payload shape changes — daily_rollups expects `cost` JSONB alongside `tokens`:

```typescript
// Build daily_rollups payloads grouped by (projId, date)
for (const group of dailyGroups.values()) {
  const costByModel: Record<string, number> = {};
  for (const agg of aggregated.values()) {
    if (agg.projId === group.projId && agg.date === group.date) {
      costByModel[agg.model] = (costByModel[agg.model] ?? 0) + agg.cost;
    }
  }

  const payload = {
    project_id: group.projId,
    date: group.date,
    tokens: group.models,
    cost: costByModel,
  };

  const dailyJson = JSON.stringify(payload);
  const dailyKey = `${group.projId}\0${group.date}`;
  if (this.lastDailyPayloads.get(dailyKey) === dailyJson) continue;
  this.lastDailyPayloads.set(dailyKey, dailyJson);

  enqueue("daily_rollups", payload);
}
```

- [ ] **Step 4: Enqueue tool_decision rejects and api_errors to events table**

```typescript
// Process tool_decision (reject) events
for (const reject of batch.toolDecisionRejects) {
  enqueue("events", {
    project_id: reject.projId,
    session_id: reject.sessionId,
    event_type: "tool_decision_reject",
    event_text: `🔐 ${reject.toolName} rejected`,
    timestamp: reject.timestamp,
  });
}

// Process api_error events
for (const err of batch.apiErrors) {
  enqueue("events", {
    project_id: err.projId,
    session_id: err.sessionId,
    event_type: "api_error",
    event_text: `⚠️ ${err.statusCode} ${err.error} (${err.model})`,
    timestamp: err.timestamp,
  });
}
```

- [ ] **Step 5: Update budget alert logic to use in-batch cost instead of cost_tracking**

Replace the budget alert section that queried `costByProject` (cost_tracking) with in-batch cost accumulation:

```typescript
// Budget threshold alerts (from batch-accumulated cost)
const todayCostByProject = new Map<string, number>();
for (const req of batch.apiRequests) {
  if (req.timestamp.substring(0, 10) === today) {
    todayCostByProject.set(
      req.projId,
      (todayCostByProject.get(req.projId) ?? 0) + req.costUsd
    );
  }
}

for (const [projId, todayCost] of todayCostByProject) {
  for (const threshold of Processor.BUDGET_THRESHOLDS) {
    const alertKey = `${projId}\0${today}\0${threshold}`;
    if (todayCost >= threshold && !this.firedAlerts.has(alertKey)) {
      enqueue("alerts", {
        project_id: projId,
        alert_type: "budget_threshold",
        threshold_usd: threshold,
        current_usd: Math.round(todayCost * 100) / 100,
        date: today,
      });
      this.firedAlerts.add(alertKey);
    }
  }
}
```

Note: This uses in-batch cost, not cumulative daily cost. For accurate budget alerts across pipeline restarts, the processor should query `daily_rollups` from Supabase for today's cost at startup to seed the alert state. Add this as a TODO for the hydrate() method.

- [ ] **Step 6: Run tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test src/pipeline/__tests__/processor.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/processor.ts
git commit -m "feat(processor): rewrite processOtelBatch for new schema

Targets daily_rollups (with cost JSONB) instead of daily_metrics.
Removes cost_tracking upserts and project_telemetry shipping.
Processes tool_decision rejects and api_errors into events table.
Keeps otel_api_requests shipping and budget alerts."
```

---

### Task 7: Remove old pipeline paths from processor

**Files:**
- Modify: `src/pipeline/processor.ts`

- [ ] **Step 1: Remove processTokens method**

Delete the entire `processTokens()` method (~175 lines, lines 160-333) and all supporting state:

Remove from class properties:
- `tokenBaseline`
- `lifetimeBaseline`
- `lastDailySync`
- `todayTokensTotal`
- `lastTelemetryPayloads`
- `otelCoveredPairs`

Remove imports: `computeTokensByProject`, `ProjectTokenMap`, `upsertCostTracking`, `getCostByProject`.

- [ ] **Step 2: Remove processMetrics method**

Delete `processMetrics()` (~50 lines) and `snapshotFacilityState()`.

Remove from class properties: `lastMetricsHash`, `lastSnapshotTime`.

Remove imports: `formatModelStats`, `StatsCache`, `ModelStats`.

- [ ] **Step 3: Remove getStartupMetrics and _loadBaselinesFromSupabase**

Delete both methods. The processor no longer needs Supabase baseline hydration — lifetime is derived from `daily_rollups` via RPC, not maintained as a running counter.

Simplify `hydrate()` to only load known projects:

```typescript
async hydrate(): Promise<void> {
  this.loadKnownProjects();
}
```

Remove `refreshBaselines()`.

- [ ] **Step 4: Run tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test`

Many tests will break because they test removed methods. Update or remove those test cases.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/processor.ts src/pipeline/__tests__/processor.test.ts
git commit -m "refactor(processor): remove processTokens, processMetrics, baseline management

These paths used JSONL token scanning and stats-cache.json which are
eliminated in the OTel-only architecture. Lifetime tokens are now
derived from daily_rollups via Supabase RPC."
```

---

### Task 8: Accumulate event counts into daily_rollups

The `processEvents()` method currently enqueues individual events to the `events` table. It also needs to accumulate event type counts into `daily_rollups.events` JSONB so that `get_project_summary` returns event counts.

**Files:**
- Modify: `src/pipeline/processor.ts`

- [ ] **Step 1: Update processEvents to also enqueue daily_rollups event counts**

After the existing event enqueue loop, add accumulation logic:

```typescript
// Accumulate event counts per project per date for daily_rollups
const eventCounts = new Map<string, Record<string, number>>();
for (const entry of entries) {
  const date = entry.timestamp?.substring(0, 10) ?? new Date().toISOString().substring(0, 10);
  const key = `${entry.projId}\0${date}`;
  const counts = eventCounts.get(key) ?? {};
  counts[entry.eventType] = (counts[entry.eventType] ?? 0) + 1;
  eventCounts.set(key, counts);
}

for (const [key, counts] of eventCounts) {
  const [projId, date] = key.split("\0");
  enqueue("daily_rollups", {
    project_id: projId,
    date,
    events: counts,
  });
}
```

Note: The shipper's upsert on `(project_id, date)` means this will merge with any existing daily_rollups row for that date. However, the `events` JSONB will be **replaced**, not merged. The processor should maintain a running accumulator for the current day's event counts and enqueue the full accumulated JSONB each cycle. Add a `dailyEventCounts` map as a class property.

- [ ] **Step 2: Run tests**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test`

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/processor.ts
git commit -m "feat(processor): accumulate event counts into daily_rollups events JSONB"
```

---

### Task 9: Clean up daemon.ts and receivers (renumbered from 8)

**Files:**
- Modify: `bin/daemon.ts`
- Modify: `src/pipeline/receivers.ts`

- [ ] **Step 1: Remove TokenReceiver and MetricsReceiver from receivers.ts**

Delete the `TokenReceiver` class (lines 87-118) and `MetricsReceiver` class (lines 124-141). Keep `LogReceiver` intact — it's still used for events.log tailing.

Remove imports: `scanProjectTokens`, `ProjectTokenMap`, `ProjectResolver`, `otelEventsReceivedSince`, `readStatsCache`, `readModelStats`.

Remove export of `MetricsSnapshot` type.

- [ ] **Step 2: Update daemon.ts pipeline loop**

Remove from the pipeline loop:

```typescript
// DELETE these lines:
let tokenMap: import("../src/project/scanner").ProjectTokenMap = new Map();
try { tokenMap = tokenReceiver.poll(); } catch (e) { ... }

let metrics: import("../src/pipeline/receivers").MetricsSnapshot = { ... };
try { metrics = metricsReceiver.poll(); } catch (e) { ... }

processor.processTokens(tokenMap);
processor.processMetrics(metrics.statsCache, metrics.modelStats);
```

Remove `tokenReceiver` and `metricsReceiver` instantiation from startup.

- [ ] **Step 3: Refresh session registry every cycle instead of every 5 minutes**

In `bin/daemon.ts`, move `refreshRegistry(resolver)` from the `cycle % 60 === 0` block to the main loop body:

```typescript
// Every cycle: refresh session registry (cheap readdirSync)
refreshRegistry(resolver);
```

- [ ] **Step 4: Remove startup processTokens/processMetrics calls**

Remove from the startup sequence (around line 198-200):

```typescript
// DELETE:
const initialTokenMap = tokenReceiver.poll();
processor.processTokens(initialTokenMap);
processor.processMetrics(readStatsCache(), readModelStats());
```

Also remove `processor.refreshBaselines()` from the maintenance block.

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test`

- [ ] **Step 6: Commit**

```bash
git add bin/daemon.ts src/pipeline/receivers.ts
git commit -m "refactor(daemon): remove JSONL/metrics receivers, refresh registry every cycle"
```

---

### Task 10: Dead code cleanup

**Files:**
- Modify: `src/project/scanner.ts`
- Modify: `src/parsers.ts`
- Modify: `src/db/local.ts`
- Delete: `src/visibility-cache.ts`
- Delete: `bin/dashboard.ts`
- Delete: `src/verify/` (directory)

- [ ] **Step 1: Remove JSONL scanning functions from scanner.ts**

Remove: `discoverJsonlFiles()`, `scanProjectTokens()`, `computeTokensByProject()`, `getOrCreate()`.

Keep: `resolveProjectName()`, `resolveProjIdForDir()` (still used by session registry).

- [ ] **Step 2: Remove stats functions from parsers.ts**

Remove: `readStatsCache()`, `readModelStats()`, `STATS_CACHE_FILE`, `MODEL_FILE`.

Keep: `LogTailer`, `parseLogLine`, `stripAnsi`, `parseTimestamp`, `LOG_FILE`.

- [ ] **Step 3: Remove cost_tracking from local.ts**

Remove: `upsertCostTracking()`, `getCostByProject()`, `CostTrackingRow` type, and the `cost_tracking` CREATE TABLE statement from `initLocal()`.

- [ ] **Step 4: Remove unused files**

```bash
rm src/visibility-cache.ts
rm bin/dashboard.ts
rm -r src/verify/
```

- [ ] **Step 5: Remove unused daemon-helpers functions**

In `bin/daemon-helpers.ts`, remove: `formatModelStats`, `buildProjectTelemetryUpdates`.

Keep: `formatTokens`, `sumValues`, `computeLastActive`, `filterAndMapEntries`, `aggregateProjectEvents`, `filterRecentEntries`.

- [ ] **Step 6: Run full test suite, fix any remaining failures**

Run: `cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter && bun test`

Remove or update test files that test deleted functions.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove dead code — JSONL scanning, stats-cache, cost_tracking, verify dashboard

Removed ~2,400 lines of code from paths that are no longer used
in the OTel-only architecture."
```

---

### Task 11: Integration verification

**Files:** None (verification only)

- [ ] **Step 1: Restart the daemon**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
kill $(cat ~/.claude/lo-exporter.pid 2>/dev/null) 2>/dev/null; sleep 2
bun run start &
```

- [ ] **Step 2: Verify OTel events are being processed**

```bash
tail -20 ~/.claude/lo-exporter.log
```

Expected: No "OTel events awaiting session resolution" (non-LO events are now skipped). Shipped rows include `sessions` and `daily_rollups` targets.

- [ ] **Step 3: Verify agent_state in Supabase**

Query Supabase: `SELECT * FROM agent_state;`

Expected: Current Claude Code sessions visible with PID, project_id, status.

- [ ] **Step 4: Verify daily_rollups are updating**

Query Supabase: `SELECT * FROM daily_rollups WHERE date = CURRENT_DATE ORDER BY project_id;`

Expected: Today's date has rows with token and cost JSONB data from OTel.

- [ ] **Step 5: Verify get_project_summary includes today's OTel data**

```sql
SELECT jsonb_pretty(get_project_summary(NULL::text[], CURRENT_DATE, CURRENT_DATE));
```

Expected: Non-zero tokens AND cost for active projects.

- [ ] **Step 6: Verify session breakdown**

```sql
SELECT jsonb_pretty(get_session_breakdown('proj_166345da-d821-4b3a-abbc-e3a439925e85'));
```

Expected: Current session visible with tokens, cost, model, duration.
