# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Bun-powered TypeScript daemon that syncs Claude Code telemetry from `~/.claude/` to Supabase for the LO facility dashboard. Uses OpenTelemetry as the sole data source for accurate per-request token and cost data. Local SQLite outbox provides durability — data survives daemon crashes and Supabase outages. No build step — Bun runs `.ts` files directly.

**Version:** 0.5.0 (OTel-only architecture with Supabase RPCs and crash recovery)

## Commands

```bash
bun install                          # install dependencies
bun run start                        # run daemon (incremental sync)
bun run backfill                     # backfill all history, then daemon
bun run open                         # facility open (preflight checks, flip active)
bun run close                        # facility close (flip dormant)
```

No linter, no tsconfig. Dependencies: `@supabase/supabase-js` + `bun:sqlite` (built-in). Tests: `bun test`.

## Architecture

Always-on service (`bin/daemon.ts`, launchd-managed) with three subsystems:
- **OTLP receiver (HTTP)** — Bun server on `127.0.0.1:4318`, accepts OpenTelemetry JSON payloads, writes to SQLite before ack
- **Process watcher (250ms)** — detects Claude process lifecycle via `ps`/`lsof`, resolves PID→session via `~/.claude/tasks/<session_id>/` open dir handle, pushes to Supabase `agent_state` table
- **Pipeline (5s)** — OtelReceiver + LogReceiver collect data → Processor accumulates into `pendingRollups` → `flushRollups` enqueues to outbox → Shipper pushes to Supabase

Data flows through a local SQLite outbox (`data/telemetry.db`, WAL mode) for durability. If the daemon crashes or Supabase is down, unshipped rows persist and drain on restart. Startup reconciliation (`reconcile_rollups()` RPC) ensures `daily_rollups` match `otel_api_requests` after any crash.

### Module Layout

```
bin/           Entry points (daemon, lo-open, lo-close)
src/
  otel/
    server.ts          OTLP HTTP receiver (POST /v1/logs,metrics,traces) + Cost API
    parser.ts          OTLP JSON parsing (pure functions, no side effects)
    session-registry.ts  Maps session.id → proj_id via ~/.claude/projects/ directory listing
  pipeline/
    receivers.ts       LogReceiver (tails events.log with cursor persistence)
    otel-receiver.ts   Reads otel_events → structured ApiRequest/ToolResult/ToolDecisionReject/ApiError batches
    processor.ts       Accumulates tokens/cost/events into pendingRollups, flushes to outbox
    shipper.ts         Reads outbox, ships to Supabase per strategy, circuit breaker
  db/
    local.ts           SQLite init, outbox CRUD, otel_events/sessions tables
    client.ts          Supabase client singleton
    agent-state.ts     Agent lifecycle push (watcher → Supabase agent_state INSERT/UPDATE/DELETE)
    types.ts           Shared type definitions
  process/
    scanner.ts         Detects Claude processes, resolves CWD + session_id via lsof
    watcher.ts         Sliding-window activity detection (40 ticks × 250ms)
  project/
    resolver.ts        Maps directory names → proj_ IDs via lo.yml + name cache
    scanner.ts         Resolves project names from encoded directory paths
    slug-resolver.ts   Maps directory paths → project id via git remote URL
  parsers.ts           Log file readers (LogTailer, parseLogLine)
  errors.ts            In-memory error aggregation
  cli-output.ts        ANSI status reporting, .env loading, path constants
supabase/
  migrations/          SQL migration files for Supabase schema + RPCs
data/
  telemetry.db         SQLite database (gitignored, WAL mode)
```

### Key Data Flow

1. **OTLP receiver** accepts OTel events from Claude Code on `:4318`, writes to `otel_events` table in SQLite
2. **Session registry** maps `session.id` → `proj_id` via directory listing of `~/.claude/projects/`, refreshed every 5s. Non-LO sessions are skipped (`processed=2`). Unresolved events expire after 5 minutes.
3. **OtelReceiver** reads unprocessed `otel_events`, resolves sessions, extracts `api_request`, `tool_result`, `tool_decision` (reject), and `api_error` batches
4. **Processor** accumulates tokens/cost into `pendingRollups` map (persists across daemon lifetime), enqueues `otel_api_requests` per request, enqueues `tool_decision_reject` and `api_error` events, evaluates budget thresholds using cumulative rollup cost
5. **LogReceiver** tails `events.log` for all 20 event types, enqueues to `events` table, accumulates event counts into `pendingRollups`
6. **flushRollups** enqueues one combined `daily_rollups` payload per (project_id, date) per cycle. Dedup via JSON comparison prevents duplicate outbox writes.
7. **Shipper** ships outbox rows to Supabase: sessions (priority 0) → projects → events/otel_api_requests → daily_rollups/alerts
8. **Process watcher** (separate 250ms loop) pushes agent state directly to Supabase `agent_state` table (INSERT on discover, UPDATE on status change, DELETE on exit)
9. **Startup reconciliation** calls `reconcile_rollups()` Supabase RPC to align `daily_rollups` with `otel_api_requests`, then seeds `pendingRollups` with reconciled data

### Three Data Sources (Non-Overlapping)

| Source | What it provides | Identity |
|--------|-----------------|----------|
| OTel `api_request` | Tokens, cost, model, duration | `session.id` |
| OTel `tool_result` | Tool name, success, duration | `session.id` |
| OTel `tool_decision` | Permission accept/reject | `session.id` |
| OTel `api_error` | Error details, status code | `session.id` |
| Process watcher | PID, active/idle, CWD, session_id | PID → `session.id` (via lsof) |
| events.log | 20 event types (activity stream) | project name (no session) |

### PID→Session Identity Chain

Every Claude Code process holds a persistent open directory handle to `~/.claude/tasks/<session_id>/`. Discovered via `lsof -p PID`, cached after first discovery (immutable for PID lifetime). This is the deterministic link between OS process and application session.

### SQLite Tables

| Table | Purpose |
|-------|---------|
| `outbox` | Durable queue for Supabase shipping (WAL, priority dequeue, exponential backoff) |
| `otel_events` | Raw OTel events (processed=0 pending, 1 processed, 2 skipped non-LO) |
| `sessions` | Session→project mapping with parent_session_id and PID |
| `cursors` | File read cursors for LogReceiver |
| `known_projects` | Projects registered with Supabase |
| `archive_queue` | Deduped facts for long-term Supabase archive |

### Supabase Tables

| Table | Purpose |
|-------|---------|
| `sessions` | Session→project registry with parent-child tracking |
| `otel_api_requests` | Raw per-request token/cost data (source of truth) |
| `daily_rollups` | Pre-computed daily aggregates (tokens/cost/events JSONB per project per date) |
| `agent_state` | Ephemeral realtime agent status (INSERT/UPDATE/DELETE lifecycle) |
| `events` | Activity stream from events.log (20 event types, with optional session_id) |
| `alerts` | Budget threshold alerts ($5/$10/$25 per project per day) |
| `projects` | Project registry (id, slug, last_active) |
| `facility_status` | Singleton heartbeat (status, active_agents, updated_at) |

### Supabase RPCs

| Function | Purpose |
|----------|---------|
| `get_project_summary(project_ids[], date_from, date_to)` | Tokens/cost/events by project + facility aggregate |
| `get_session_breakdown(project_id, date_from, date_to, tz)` | Per-session cost/token drill-down |
| `get_agent_state(project_ids[])` | Current agents with PID, model, status |
| `reconcile_rollups()` | Startup crash recovery — aligns daily_rollups with otel_api_requests |

### Project Identity

Each LO project has a `lo.yml` file at its root with a stable `proj_` UUID:
```yaml
id: proj_fe8141ea-c26c-4b7e-a1e5-39d2eeeed5e8
```

The resolver reads these files directly — no git remote or Supabase lookup needed.

### launchd Integration

`com.lo.telemetry-exporter.plist` runs `bun run bin/daemon.ts` as a macOS user agent. Always running — starts on boot, restarts on crash. The daemon checks `git rev-parse HEAD` every 5 minutes and exits gracefully if the commit has changed, so launchd restarts it with the new code. One-time setup: `bun run setup`. Logs go to `~/.claude/lo-exporter.{log,err}`.

## Environment

Requires `.env` at repo root with `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Optional `LO_PROJECT_ROOT` (defaults to `/Users/bigviking/Documents/github/projects/lo`).

### OTel Environment Variables

These must be set for Claude Code to emit OTel events to the daemon:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json    # critical: forces JSON over protobuf
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
```
