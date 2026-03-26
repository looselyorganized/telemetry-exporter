# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Bun-powered TypeScript daemon that syncs Claude Code telemetry from `~/.claude/` to Supabase for the LO operations dashboard. Uses OpenTelemetry as the primary data source for accurate per-request token and cost data. Local SQLite outbox provides durability — data survives daemon crashes and Supabase outages. No build step — Bun runs `.ts` files directly.

## Commands

```bash
bun install                          # install dependencies
bun run start                        # run daemon (incremental sync)
bun run backfill                     # backfill all history, then daemon
bun run open                         # facility open (preflight checks, flip active, dashboard)
bun run close                        # facility close (flip dormant, stop dashboard)
bun run dashboard                    # verification dashboard (localhost:7777)
```

No linter, no tsconfig. Dependencies: `@supabase/supabase-js` + `bun:sqlite` (built-in). Tests: `bun test`.

## Architecture

Always-on service (`bin/daemon.ts`, launchd-managed) with three subsystems:
- **OTLP receiver (HTTP)** — Bun server on `127.0.0.1:4318`, accepts OpenTelemetry JSON payloads, writes to SQLite before ack
- **Process watcher (250ms)** — detects Claude process lifecycle via `ps`/`lsof`, pushes agent state directly to Supabase
- **Pipeline (5s)** — Receivers collect data → Processor writes to SQLite outbox → Shipper pushes to Supabase

Data flows through a local SQLite outbox (`data/telemetry.db`, WAL mode) for durability. If the daemon crashes or Supabase is down, unshipped rows persist and drain on restart.

The daemon does not know or care about facility status (active/dormant). That's a UI signal for Next.js. `lo-open` and `lo-close` flip `facility_status.status` in Supabase but do not affect the daemon.

### Module Layout

```
bin/           Entry points (daemon, lo-open, lo-close, dashboard)
src/
  otel/
    server.ts          OTLP HTTP receiver (POST /v1/logs,metrics,traces) + Cost API (GET /cost/*)
    parser.ts          OTLP JSON parsing (pure functions, no side effects)
    session-registry.ts  Maps session.id → proj_id via ~/.claude/projects/ directory listing
  pipeline/
    receivers.ts       LogReceiver, TokenReceiver (JSONL fallback), MetricsReceiver
    otel-receiver.ts   Reads otel_events → structured ApiRequest/ToolResult batches
    processor.ts       Resolves projects, aggregates, deduplicates, writes to SQLite outbox
    shipper.ts         Reads outbox, ships to Supabase per strategy dispatch, circuit breaker
  db/
    local.ts           SQLite init, outbox CRUD, otel_events/sessions/cost_tracking tables
    client.ts          Supabase client singleton
    agent-state.ts     Direct agent state push (watcher → Supabase, bypasses outbox)
    types.ts           Shared type definitions
  process/
    scanner.ts         Detects running Claude processes, resolves CWDs
    watcher.ts         Sliding-window activity detection (40 ticks × 250ms)
  project/
    resolver.ts        Maps directory names → proj_ IDs via lo.yml + name cache
    scanner.ts         JSONL token aggregation from ~/.claude/projects/ (fallback only)
    slug-resolver.ts   Maps directory paths → project id via git remote URL
  verify/
    outbox-reader.ts   Reads SQLite outbox for dashboard comparison
    remote-reader.ts   Queries Supabase tables for dashboard comparison
    comparator.ts      Diffs outbox vs remote, produces discrepancy lists
  parsers.ts           Log/stats file readers
  errors.ts            In-memory error aggregation (flushed directly, not through outbox)
  cli-output.ts        ANSI status reporting, .env loading, path constants
  visibility-cache.ts  GitHub repo visibility via `gh repo list`
data/
  telemetry.db         SQLite database (gitignored, WAL mode)
```

### Key Data Flow

1. **OTLP receiver** accepts OpenTelemetry events from Claude Code on `127.0.0.1:4318`, writes to `otel_events` table in SQLite
2. **Session registry** maps `session.id` (= JSONL filename UUID) → `proj_id` via directory listing of `~/.claude/projects/`
3. **OtelReceiver** reads unprocessed `otel_events`, joins to projects via session registry, extracts `api_request` and `tool_result` batches
4. **Processor** (`processOtelBatch`) upserts `cost_tracking`, enqueues `daily_metrics` with per-type token breakdown, enqueues `project_telemetry` with lifetime totals, evaluates budget thresholds
5. **JSONL fallback** — `TokenReceiver` only activates when OTel coverage < 50% of registered sessions
6. **Shipper** reads unshipped outbox rows, ships to Supabase per target (alerts → projects → events → daily_metrics → project_telemetry → facility_metrics), with exponential backoff and circuit breaker
7. **Process watcher** (separate 250ms loop) pushes agent state directly to Supabase (bypasses outbox)
8. **Archive shipper** sends discrete facts (events, daily metrics, session mappings, state snapshots) to `outbox_archive` in Supabase

### OTel Event Types

| Event | Source | What it provides |
|-------|--------|-----------------|
| `claude_code.api_request` | OTel logs | Accurate `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `model`, `duration_ms` |
| `claude_code.tool_result` | OTel logs | `tool_name`, `success`, `duration_ms` |
| `claude_code.user_prompt` | OTel logs | `prompt_length` (stored, not yet processed) |
| `claude_code.api_error` | OTel logs | `error`, `status_code`, `model` (stored, not yet processed) |

### SQLite Tables

| Table | Purpose |
|-------|---------|
| `outbox` | Durable queue for Supabase shipping (WAL, priority dequeue, exponential backoff) |
| `otel_events` | Raw OTel events (processed flag, pruned after 7 days) |
| `sessions` | Immutable session_id → proj_id mapping (INSERT OR IGNORE) |
| `cost_tracking` | Per-project/date/model token + cost accumulation (upsert semantics) |
| `cursors` | File read cursors for LogReceiver |
| `known_projects` | Projects registered with Supabase |
| `archive_queue` | Deduped facts for long-term Supabase archive |

### Project Identity

Each LO project has a `lo.yml` file at its root with a stable `proj_` UUID:
```yaml
id: proj_fe8141ea-c26c-4b7e-a1e5-39d2eeeed5e8
```

The resolver reads these files directly — no git remote or Supabase lookup needed. A `.name-cache.json` file at the exporter root persists all `dirName → projId` associations, so old directory names still resolve after renames.

### Path Resolution

Several files resolve paths relative to `import.meta.dirname` or `import.meta.url` to find repo-root files (`.env`, `.exporter.pid`, `.visibility-cache.json`, `.project-mapping.json`). The `src/` files use `join(import.meta.dirname, "..")` to reach the repo root; `bin/` files use `join(dirname(url), "..")`.

### launchd Integration

`com.lo.telemetry-exporter.plist` runs `bun run bin/daemon.ts` as a macOS user agent. Always running — starts on boot, restarts on crash. One-time setup: `bun run setup`. Logs go to `~/.claude/lo-exporter.{log,err}`.

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

`lo-open` checks for `CLAUDE_CODE_ENABLE_TELEMETRY` and warns if not set.
