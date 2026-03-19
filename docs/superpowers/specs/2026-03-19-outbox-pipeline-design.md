# Outbox Pipeline Architecture

Refactor the telemetry exporter from a monolithic daemon with direct Supabase writes into a staged pipeline: Receivers -> Processor -> SQLite Outbox -> Shipper -> Supabase. Adds local durability, pluggable export targets, and clean separation of concerns.

## Motivation

The current `daemon.ts` (~820 lines) tightly couples data collection with cloud delivery. Three problems:

1. **Resilience** -- In-memory state (`allSeenEntries`, `cachedTokensByProject`, `knownProjects`, `RegistrationRetryTracker` buffers) is lost on daemon crash. Gap backfill recovers most data but relies on re-parsing raw files.
2. **Extensibility** -- Adding a second export target requires wiring into the aggregator loop. Every Supabase call is inline.
3. **Complexity** -- Collection, aggregation, resolution, retry logic, and shipping are interleaved in a single file with 6 in-memory caches.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Local store | `bun:sqlite` (WAL mode) | Zero dependencies, built into Bun, synchronous reads, concurrent read/write via WAL |
| Process watcher | Direct to Supabase (bypasses outbox) | Agent state is ephemeral, latency-sensitive, push-on-change. Outbox adds unnecessary delay. |
| Dashboard comparison | Outbox vs Supabase | Outbox is the canonical "collected" state. Tests the actual pipeline, not raw files. |
| Archive strategy | Discrete facts to `outbox_archive` in Supabase | Events, daily metrics, state snapshots. Hourly + significant transitions. Retain forever in Supabase. |
| Local retention | 7 days shipped, prune after | Local SQLite is a buffer, Supabase archive is long-term. |
| Snapshot frequency | Hourly + significant transitions (created/closed), throttled to 1 per 5 min | Avoids archive bloat from active/idle toggling. Granularity adjustable later via config. |
| Migration | Staged, 4 PRs, per-target feature flags | Each stage leaves the system functional. Rollback is safe. |
| Error routing | `exporter_errors` bypasses outbox (direct write) | Errors about the shipper must not be shipped by the shipper. |
| Retry | Exponential backoff with cap, circuit breaker | Replaces 3 current retry mechanisms with one unified approach. |

## Architecture Overview

```
~/.claude/ files          SQLite (data/telemetry.db)         Supabase
-----------------        -------------------------         ----------

  events.log ----[LogReceiver]---.
  JSONL files --[TokenReceiver]---+--> [Processor] --> outbox ----[Shipper]--> events
  stats-cache -[MetricsReceiver]--'        |          archive_queue --[Shipper]--> outbox_archive
                                           |                                  --> projects
                                           |                                  --> daily_metrics
                                           v                                  --> project_telemetry
                                     known_projects                           --> facility_status
                                     cursors

  ps/lsof -----[ProcessWatcher]----(direct)----> facility_status (agent fields)
                                              --> project_telemetry (agent fields)
```

### Concurrency Rule

Only the pipeline loop (5s) writes to SQLite. The process watcher (250ms) never touches the database. This eliminates write contention.

### Field Ownership

Shared Supabase tables have split ownership to prevent write conflicts:

| Table | Watcher owns | Shipper owns |
|-------|-------------|-------------|
| `facility_status` | `active_agents`, `active_projects` | `tokens_*`, `sessions_*`, `messages_*`, `model_stats`, `hour_distribution`, `first_session_date` |

> **Note:** `facility_status.status` is owned by neither loop -- it's set by `lo-open`/`lo-close` commands and the auto-close timer. The shipper must not write it.
| `project_telemetry` | `active_agents`, `agent_count` | `tokens_*`, `sessions_*`, `messages_*`, `tool_calls_*`, `agent_spawns_*`, `team_messages_*`, `models_today` |

The shipper uses `method: "update"` (not upsert) for these tables and only writes its owned columns.

---

## SQLite Schema

Location: `data/telemetry.db` at the exporter root.

```sql
-- Durable queue of all data destined for Supabase
CREATE TABLE outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target      TEXT NOT NULL,      -- 'events' | 'projects' | 'daily_metrics' | 'project_telemetry' | 'facility_metrics'
  payload     TEXT NOT NULL,      -- JSON blob matching the target table's expected shape
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'shipped' | 'failed'
  created_at  TEXT NOT NULL,      -- ISO 8601
  shipped_at  TEXT,               -- NULL until confirmed shipped
  error       TEXT,               -- Last shipping error (NULL on success)
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error_at TEXT
);

-- Tracks read positions for incremental sources
CREATE TABLE cursors (
  source     TEXT PRIMARY KEY,    -- 'events.log' (only source with a cursor)
  offset     INTEGER NOT NULL DEFAULT 0,
  checksum   TEXT,                -- file size for rotation detection
  updated_at TEXT NOT NULL
);

-- Projects the processor has seen and enqueued for registration
CREATE TABLE known_projects (
  proj_id    TEXT PRIMARY KEY,
  slug       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Discrete facts archived to Supabase for long-term history
CREATE TABLE archive_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_type    TEXT NOT NULL,     -- 'event' | 'daily_metric' | 'state_snapshot' | 'project_registration'
  payload      TEXT NOT NULL,
  content_hash TEXT NOT NULL,     -- SHA-256 of fact_type + natural key fields
  created_at   TEXT NOT NULL,
  shipped_at   TEXT
);

CREATE INDEX idx_outbox_pending ON outbox(status) WHERE status = 'pending';
CREATE INDEX idx_outbox_shipped ON outbox(shipped_at) WHERE shipped_at IS NOT NULL;
CREATE INDEX idx_outbox_target ON outbox(target, status);
CREATE UNIQUE INDEX idx_archive_content ON archive_queue(fact_type, content_hash);
CREATE INDEX idx_archive_unshipped ON archive_queue(shipped_at) WHERE shipped_at IS NULL;
```

### Cursors Scope

The `cursors` table is for `events.log` only (byte offset + file size for rotation detection). JSONL scanning remains full-scan -- files are small and `requestId` dedup is built into `extractUsageRecords`. This is intentional.

---

## Supabase Schema Addition

```sql
CREATE TABLE outbox_archive (
  id            BIGSERIAL PRIMARY KEY,
  fact_type     TEXT NOT NULL,
  payload       JSONB NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  shipped_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_outbox_archive_dedup ON outbox_archive(fact_type, content_hash);
CREATE INDEX idx_archive_type_created ON outbox_archive(fact_type, created_at);
```

Estimated volume: ~100KB/day, ~3MB/month. Negligible cost on any Supabase tier.

---

## Pipeline Stages

### Receivers

Receivers read sources and produce typed records. No side effects, no Supabase calls, no outbox writes.

```typescript
interface Receiver<T> {
  name: string;
  poll(): T[];
  readAll(): T[];
}
```

**LogReceiver** -- wraps existing `LogTailer`
- Source: `~/.claude/events.log`
- Output: `LogEntry[]`
- Cursor: byte offset persisted to SQLite `cursors` table
- Handles file rotation (file size < stored offset -> reset to 0)

**TokenReceiver** -- wraps `scanProjectTokens`
- Source: `~/.claude/projects/*/*.jsonl`
- Output: `ProjectTokenMap` (projId -> date -> model -> tokens)
- No cursor, full-scan each poll. `requestId` dedup built in.

**MetricsReceiver** -- wraps `readStatsCache` + `readModelStats`
- Source: `~/.claude/stats-cache.json`, `~/.claude/model-stats`
- Output: `{ statsCache, modelStats }`
- Checksum in cursors table so processor can skip unchanged reads.

**ProcessWatcher** -- existing `ProcessWatcher` class
- Source: `ps` + `lsof` system calls
- Output: `ProcessDiff | null`
- Stays direct to Supabase. Not routed through the outbox.

### Processor

Sits between receivers and the outbox. Resolves projects, aggregates, deduplicates, writes to SQLite in transactions.

Module: `src/pipeline/processor.ts`

```typescript
class Processor {
  // In-memory state, hydrated from SQLite + Supabase at startup
  private knownProjects: Set<string>;
  private tokenBaseline: Map<string, number>;
  private lifetimeBaseline: Map<string, LifetimeCounters>;
  private lastMetricsHash: string;
  private lastSnapshotTime: number;
  private lastDailySync: string;
  private lastProjectSync: string;
  private lastPruneDate: string;

  constructor(resolver: ProjectResolver, db: Database)

  async hydrate(): Promise<void>
  processEvents(entries: LogEntry[]): void
  processTokens(tokenMap: ProjectTokenMap): void
  processMetrics(statsCache, modelStats): void
  snapshotFacilityState(facilityState): void
  processGapEntries(entries: LogEntry[], tokenMap: ProjectTokenMap): void
  async refreshBaselines(): Promise<void>
  async refreshResolver(): Promise<void>
}
```

#### `hydrate()`

1. Load `known_projects` from SQLite into in-memory Set
2. Query Supabase `project_telemetry` for token/counter baselines
3. If Supabase unreachable: fall back to zero baselines (conservative -- may cause redundant outbox writes on first cycle, but shipping is idempotent). Log warning.

#### `processEvents(entries)`

Single SQLite transaction:

1. Filter to LO projects via `resolver.resolve()`
2. For unseen projIds (not in `knownProjects` Set):
   - Enqueue to outbox (target: `projects`)
   - Insert into SQLite `known_projects`
   - Add to in-memory Set
3. Enqueue each event to outbox (target: `events`)
4. Enqueue each event to archive_queue (content_hash: SHA-256 of `projId|eventType|eventText|timestamp`)

#### `processTokens(tokenMap)`

Single SQLite transaction:

1. Compute `tokensByProject`, `todayTokensByProject`
2. Compute per-project daily metric rows (date x project x model)
3. Diff token totals against `tokenBaseline` -- only enqueue if changed
4. Enqueue changed `daily_metrics` to outbox
5. Enqueue changed `daily_metrics` to archive_queue (content_hash: `projId|date`)
6. Enqueue `project_telemetry` updates to outbox (metrics fields only)
7. Update `tokenBaseline` in memory
8. Respect `lastDailySync` / `lastProjectSync` date guards for once-per-day operations

#### `processMetrics(statsCache, modelStats)`

Single SQLite transaction:

1. Build facility metrics (tokens_lifetime, sessions_lifetime, model_stats, hour_distribution)
2. Build global daily metrics (project_id IS NULL)
3. Hash output, skip if identical to `lastMetricsHash`
4. Enqueue to outbox (target: `facility_metrics`)
5. Enqueue global daily_metrics to outbox

> If the shipper falls behind (e.g., circuit breaker open), multiple `facility_metrics` rows may accumulate. This is intentional -- the shipper deduplicates singleton targets by keeping only the highest-id pending row (ship() step 8).

#### `snapshotFacilityState(facilityState)`

Called from the aggregator loop (never from the watcher):

1. Throttle: skip if last snapshot < 5 minutes ago (unless significant transition)
2. Significant transitions: `instance:created` or `instance:closed` only (not active/idle)
3. Hourly snapshots always fire regardless of throttle
4. Enqueue to archive_queue (fact_type: `state_snapshot`, content_hash: `snapshot|rounded_timestamp`)

#### Event Aggregation for Daily Metrics

Instead of maintaining `allSeenEntries` in memory, the Processor queries the SQLite outbox:

```sql
SELECT
  json_extract(payload, '$.project_id') as project_id,
  json_extract(payload, '$.event_type') as event_type,
  substr(json_extract(payload, '$.timestamp'), 1, 10) as date,
  COUNT(*) as count
FROM outbox
WHERE target = 'events'
GROUP BY project_id, event_type, date
```

This replaces the 31-day in-memory `allSeenEntries` array with a durable, queryable store.

### Shipper

Reads unshipped rows from the outbox, pushes to Supabase, marks shipped. The only component that talks to Supabase (besides the process watcher and error flushing).

Module: `src/pipeline/shipper.ts`

```typescript
class Shipper {
  constructor(db: Database, supabase: SupabaseClient)

  async ship(): Promise<ShipResult>
  async shipArchive(): Promise<ShipResult>
  pruneShipped(olderThanDays: number): void
  outboxDepth(): number
  async verify(lastUpdates: ProjectTelemetryUpdate[]): Promise<void>
}

interface ShipResult {
  shipped: number;
  failed: number;
  retriesScheduled: number;
  circuitBreakerState: "closed" | "open" | "half-open";
  byTarget: Record<string, { shipped: number; failed: number }>;
}
```

#### Shipping Strategy Dispatch

Declarative table mapping outbox targets to Supabase operations:

```typescript
const SHIPPING_STRATEGIES: Record<string, ShippingStrategy> = {
  events: {
    table: "events",
    method: "upsert",
    onConflict: "project_id,event_type,event_text,timestamp",
    ignoreDuplicates: true,
    batchSize: 500,
    fallbackToPerRow: true,
    priority: 2,
  },
  projects: {
    table: "projects",
    method: "upsert",
    onConflict: "id",
    ignoreDuplicates: false,
    batchSize: 50,
    fallbackToPerRow: true,
    priority: 1,  // ships before events (FK dependency)
  },
  daily_metrics: {
    table: "daily_metrics",
    method: "upsert",
    onConflict: "date,project_id",
    batchSize: 100,
    fallbackToPerRow: true,
    priority: 3,
  },
  project_telemetry: {
    table: "project_telemetry",
    method: "update",  // not upsert -- only writes metrics-owned fields
    filterKey: "project_id",  // .eq("project_id", payload.project_id)
    excludeFields: ["active_agents", "agent_count"],
    batchSize: 50,
    fallbackToPerRow: true,
    priority: 4,
  },
  facility_metrics: {
    table: "facility_status",
    method: "update",
    filter: { id: 1 },
    excludeFields: ["active_agents", "active_projects", "status"],
    batchSize: 1,  // singleton
    fallbackToPerRow: false,
    priority: 5,
  },
};
```

#### `ship()` Algorithm

1. `SELECT * FROM outbox WHERE status = 'pending' AND (last_error_at IS NULL OR ...) ORDER BY id LIMIT 500`
   - Backoff filter: skip rows where `now() - last_error_at < 2^min(retry_count, 6) seconds` (1s, 2s, 4s, 8s, 16s, 32s, 60s cap)
2. Check circuit breaker. If open, return immediately.
3. Group rows by target.
4. Process targets in priority order (projects first, then events, etc.).
5. For each target group:
   - **FK dependency check**: before shipping events/daily_metrics/project_telemetry, check for unshipped/failed `projects` rows for those projIds. Skip dependent rows (deferred to next cycle).
   - Look up strategy. Execute Supabase operation.
   - **Success**: `UPDATE outbox SET status = 'shipped', shipped_at = now() WHERE id IN (...)`
   - **Transient failure (5xx, timeout)**: `UPDATE outbox SET error = '...', retry_count = retry_count + 1, last_error_at = now() WHERE id IN (...)`
   - **Permanent failure (4xx, FK violation)**: `UPDATE outbox SET status = 'failed', error = '...' WHERE id IN (...)`. Report to exporter_errors.
   - **Batch failure with fallbackToPerRow**: retry each row individually. For targets with `ignoreDuplicates: false`, per-row fallback uses conditional update (only write if payload timestamp is newer than existing row).
6. After 10 failed retry attempts: `status = 'failed'`.
7. Update circuit breaker state (3 consecutive 100% failure -> open for 60s).
8. For singleton targets (`facility_metrics`): deduplicate pending rows, keep only the highest id.
9. Return ShipResult.

#### `shipArchive()` Algorithm

1. `SELECT * FROM archive_queue WHERE shipped_at IS NULL ORDER BY id LIMIT 200`
2. Batch upsert into `outbox_archive` on `(fact_type, content_hash)`.
3. Mark shipped or set error for retry next cycle.

Archive rows retry indefinitely (no max attempts). This is safe because the unique index on `(fact_type, content_hash)` makes upserts idempotent, the volume is low (~100 rows/day), and permanent failures are unlikely since the archive table has no foreign key constraints.

#### Retry Semantics

Replaces three current mechanisms:

| Current | New |
|---------|-----|
| `withRetry()` (exponential backoff per call) | Outbox rows retry each cycle with backoff |
| `RegistrationRetryTracker` (6 attempts + event buffer) | Outbox `status`/`retry_count` + FK dependency check in shipper |
| `gapBackfill()` shipping portion | Gap entries flow through processor into outbox, ship normally |

---

## Orchestrator

The new `daemon.ts` is a thin wiring layer (~200 lines). No business logic, no caches, no aggregation.

Module: `bin/daemon.ts`

### Startup Sequence

```
1.  Single-instance guard (PID file with exclusive create flag 'wx')
2.  Write PID file immediately (before any async work)
3.  Register signal handlers (SIGINT, SIGTERM, exit)
4.  Init SQLite (create tables, enable WAL)
5.  Init Supabase client
6.  Build resolver, refresh from disk
7.  Build pipeline stages (receivers, processor, shipper)
8.  Hydrate processor (known_projects from SQLite, baselines from Supabase best-effort)
9.  Clear error state
10. LogReceiver.readAll() (sets cursor to end of file)
11. Gap detection:
    a. Query facility_status.updated_at from Supabase
    b. If gap > 2 minutes: feed missed entries through processor.processGapEntries()
12. Start both loops via Promise.all
```

### Backfill Mode (`--backfill`)

```
1-9.  Same as above
10.   Delete stale per-project daily_metrics from Supabase
11.   logReceiver.readAll() -> processor.processEvents(all)
12.   tokenReceiver.readAll() -> processor.processTokens(all)
13.   metricsReceiver.readAll() -> processor.processMetrics(all)
14.   Shipper drains outbox in batches (may take minutes)
15.   Start normal daemon loops
```

### Loop 1: Process Watcher (250ms)

Direct to Supabase, unchanged from current implementation. Includes auto-close logic (2h idle -> dormant).

### Loop 2: Pipeline (5s)

```
Each cycle:
  1. Collect (each receiver in its own try/catch):
     - newEntries = logReceiver.poll()
     - tokenMap = tokenReceiver.poll()
     - metrics = metricsReceiver.poll()
  2. Process -> writes to SQLite outbox:
     - processor.processEvents(newEntries)
     - processor.processTokens(tokenMap)
     - processor.processMetrics(metrics)
  3. Ship -> reads from outbox, pushes to Supabase:
     - result = await shipper.ship()
     - Log ShipResult
  4. Archive ship (every 12 cycles / ~60s):
     - await shipper.shipArchive()
  5. Periodic maintenance (every 60 cycles / ~5 min):
     - resolver.refresh()
     - processor.refreshBaselines() (from Supabase)
     - processor.snapshotFacilityState(watcher.currentState()) if hour boundary
     - shipper.pruneShipped(7) + archive_queue pruning
     - shipper.verify() (read-back comparison)
     - Outbox depth health check (> 1000 -> error)
     - Remote event pruning (pruneOldEvents(14), once per day)
  6. Finally:
     - flushErrorsDirect() + pruneResolved()
```

Individual receiver failures don't block shipping. A broken log file doesn't prevent token data from flowing.

### Signal Handlers

```typescript
function shutdown() {
  flushErrorsDirect();   // best-effort final error flush
  localDb.close();       // checkpoint WAL
  removePidFile();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", removePidFile);
```

### Loop Resilience

Each loop has a never-rethrow guard. If an error escapes the inner catch, it's logged and the loop continues. `Promise.all` only terminates if both loops exit (which they shouldn't).

---

## Dashboard

The verification dashboard shifts from comparing raw `~/.claude/` files against Supabase to comparing the SQLite outbox against Supabase.

### API Endpoints

```
GET /api/health          -- pipeline health (daemon, Supabase, circuit breaker, outbox depth)
GET /api/errors          -- exporter_errors from Supabase (unchanged)
GET /api/outbox          -- outbox status, depth by target, failed rows with error messages, cursors
GET /api/compare/events  -- outbox event counts vs Supabase event counts by project
GET /api/compare/metrics -- outbox daily_metrics vs Supabase daily_metrics
GET /api/compare/tokens  -- outbox token totals vs Supabase project_telemetry
GET /api/compare/models  -- model stats (unchanged, from model-stats file)
GET /api/compare/projects -- known_projects in SQLite vs projects in Supabase
```

### `/api/health` Response Shape

```json
{
  "daemon": { "running": true, "pid": 12345 },
  "supabase": { "connected": true, "latency": "45ms" },
  "pipeline": {
    "lastShipAt": "2026-03-19T14:30:05Z",
    "lastShipResult": { "shipped": 47, "failed": 0 },
    "circuitBreaker": "closed",
    "outboxDepth": 12,
    "archiveDepth": 3,
    "oldestPending": "2026-03-19T14:30:00Z"
  }
}
```

### `/api/outbox` Response Shape

```json
{
  "depth": { "pending": 12, "shipped": 4830, "failed": 2 },
  "byTarget": {
    "events": { "pending": 8, "shipped": 4200, "failed": 0 },
    "project_telemetry": { "pending": 3, "shipped": 580, "failed": 1 },
    "facility_metrics": { "pending": 1, "shipped": 50, "failed": 0 }
  },
  "archive": { "pending": 3, "shipped": 1200 },
  "failedRows": [
    {
      "id": 4501,
      "target": "projects",
      "error": "409 Conflict: duplicate key violates unique constraint",
      "retryCount": 10,
      "createdAt": "2026-03-19T10:15:00Z"
    }
  ],
  "cursors": {
    "events.log": { "offset": 284720, "updatedAt": "2026-03-19T14:30:05Z" }
  }
}
```

### Migration Behavior

During staged migration, both raw file reader and outbox reader exist. Each compare endpoint switches based on which targets are outbox-enabled. After all targets migrate, the raw file reader is removed.

---

## Error Handling

### Error Categories and Routing

| Error source | Route | Retry behavior |
|-------------|-------|----------------|
| Receiver failure (file read, parse) | `reportError()` -> direct flush | No retry (next poll re-reads) |
| Processor failure (SQLite write) | `reportError()` -> direct flush | Transaction rollback, data collected again next cycle |
| Shipper transient (5xx, timeout) | Outbox `retry_count` + backoff | Exponential: 1s, 2s, 4s, 8s, 16s, 32s, 60s cap. Max 10 attempts. |
| Shipper permanent (4xx, FK) | Outbox `status = 'failed'` | No retry. Logged to exporter_errors with full error message. |
| Circuit breaker open | ShipResult shows state | Pauses all shipping for 60s. Triggers after 3 consecutive 100% failure cycles. |
| Archive ship failure | archive_queue retry | Same backoff as main outbox |
| Process watcher failure | `reportError()` -> direct flush | Next tick retries (250ms) |

### Human-Readable Error Messages

Failed outbox rows store the full error in the `error` column. The `/api/outbox` endpoint surfaces these with context:

```
"409 Conflict: duplicate key violates unique constraint 'projects_pkey' for proj_abc123"
"502 Bad Gateway: Supabase returned HTTP 502 at 2026-03-19T14:30:05Z (attempt 3/10)"
"23503 Foreign key violation: project_id 'proj_xyz' not found in projects table"
```

No opaque error codes. Every failure tells you what went wrong, which row, and how many times it's been retried.

---

## Migration Plan

Four staged PRs, each leaving the system fully functional.

### Stage 1: Add SQLite Layer

- Add `src/db/local.ts` (init, enqueue, dequeue, cursors, prune)
- Add SQLite schema (outbox, cursors, known_projects, archive_queue)
- Add `data/` to `.gitignore`
- Initialize SQLite in daemon startup (alongside existing Supabase init)
- No behavior changes. SQLite is created but nothing flows through it.

### Stage 2: Receivers + Processor + Shipper

- Add `src/pipeline/processor.ts`
- Add `src/pipeline/shipper.ts`
- Add receiver adapters (LogReceiver, TokenReceiver, MetricsReceiver)
- Per-target feature flags: migrate `events` first (highest volume, most testable)
- When flag is on for a target: processor writes to outbox, shipper reads and ships
- When flag is off: existing direct path unchanged
- Migration order: events -> projects -> daily_metrics -> project_telemetry -> facility_metrics
- Disable old direct path per target before enabling shipper for that target
- `facility_status.updated_at` set by both paths during migration, shipper always updates it

### Stage 3: Refactor Daemon into Orchestrator

- Replace `daemon.ts` with thin orchestrator (~200 lines)
- All targets flow through outbox (feature flags removed)
- Remove direct-write paths in `src/db/` modules (events.ts, metrics.ts, telemetry.ts, facility.ts, projects.ts)
- Remove `RegistrationRetryTracker` (replaced by outbox retry)
- Remove in-memory caches from daemon (moved to Processor)
- Add `outbox_archive` table to Supabase
- Enable archive shipping

### Stage 4: Update Dashboard

- Replace `src/verify/local-reader.ts` with `src/verify/outbox-reader.ts`
- Add `/api/outbox` endpoint
- Update `/api/health` with pipeline status
- Update compare endpoints to read from SQLite
- Remove raw file reader (dead code)

---

## Module Map (After Migration)

```
bin/
  daemon.ts              Thin orchestrator (~200 lines, down from ~820)
  daemon-helpers.ts      Pure helper functions (unchanged)
  lo-open.ts             Facility startup (unchanged)
  lo-close.ts            Facility shutdown (unchanged)
  lo-status.ts           Backlog scanner (unchanged)
  dashboard.ts           Verification dashboard (revised endpoints)

src/
  pipeline/
    processor.ts         Receives data, resolves, aggregates, writes to outbox
    shipper.ts           Reads outbox, ships to Supabase, manages retries
    receivers.ts         LogReceiver, TokenReceiver, MetricsReceiver adapters

  db/
    local.ts             SQLite operations (init, enqueue, dequeue, cursors, prune)
    client.ts            Supabase client (unchanged)
    check-result.ts      Error handling (unchanged)
    agent-state.ts       Direct agent state push (unchanged)
    types.ts             Shared type definitions (extended)

  process/
    scanner.ts           Process enumeration (unchanged)
    watcher.ts           Activity detection (unchanged)

  project/
    resolver.ts          Project identity resolution (unchanged)
    scanner.ts           JSONL token scanning (unchanged)
    slug-resolver.ts     Git remote URL parsing (unchanged)

  parsers.ts             Log/stats file readers (unchanged)
  errors.ts              In-memory error aggregation (unchanged)
  registration-retry.ts  REMOVED (replaced by outbox retry)
  cli-output.ts          ANSI formatting, paths (unchanged)
  visibility-cache.ts    GitHub repo visibility (unchanged)

  verify/
    outbox-reader.ts     NEW: reads from SQLite outbox
    remote-reader.ts     Queries Supabase (unchanged)
    comparator.ts        Diffs local vs remote (minor changes)
    local-reader.ts      REMOVED after Stage 4

data/
  telemetry.db           SQLite database (gitignored)
```

---

## Testing Strategy

### Unit Tests (per module)

- `src/db/local.ts`: enqueue/dequeue, cursor CRUD, prune shipped, WAL mode verification
- `src/pipeline/processor.ts`: processEvents (filtering, dedup, transactions), processTokens (diff logic, daily sync guards), processMetrics (hash-based skip), snapshotFacilityState (throttle, significant transitions)
- `src/pipeline/shipper.ts`: strategy dispatch, batch/per-row fallback, backoff calculation, circuit breaker state machine, FK dependency ordering, singleton dedup, failed row handling
- `src/pipeline/receivers.ts`: cursor persistence across polls, rotation detection
- `src/verify/outbox-reader.ts`: SQLite queries match expected shapes

### Integration Tests

- Full cycle: receiver.poll() -> processor.process*() -> shipper.ship() with a mock Supabase
- Crash recovery: write to outbox, simulate crash (no ship), restart, verify outbox drains
- Circuit breaker: simulate consecutive 5xx, verify pause, verify recovery
- Gap backfill: simulate offline gap, verify events flow through processor into outbox

### Existing Tests

All 283 existing tests continue to pass. Parsers, resolver, scanner, watcher, daemon-helpers -- none of these change. New tests add to the suite, they don't replace.

---

## Observability

### Logging

One-line summaries per cycle:

```
14:30:05 -- shipped 47 rows (events: 42, project_telemetry: 5), 0 failed
14:30:10 -- shipped 3 rows (facility_metrics: 1, events: 2), 0 failed
14:35:05 -- WARN: 5 rows failed (projects: 2 permanent, events: 3 transient), outbox depth: 156
14:35:10 -- CIRCUIT BREAKER OPEN: Supabase unreachable, pausing shipper for 60s
```

### Dashboard

- `/api/health` shows pipeline status at a glance
- `/api/outbox` shows failed rows with full error messages
- Compare endpoints show collection vs shipping discrepancies

### Alerts

- Outbox depth > 1000: error reported
- Archive depth > 500: error reported
- Circuit breaker open: error reported
- 10 consecutive processor failures: critical error reported
