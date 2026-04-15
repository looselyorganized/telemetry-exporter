# Telemetry Exporter

![Version](https://img.shields.io/badge/version-0.6.0-blue) ![Runtime](https://img.shields.io/badge/runtime-Bun-black?logo=bun) ![Storage](https://img.shields.io/badge/storage-SQLite%20%2B%20Supabase-green?logo=sqlite) ![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-compliant-orange) ![License](https://img.shields.io/badge/license-MIT-green)

Always-on macOS daemon that syncs [Claude Code](https://claude.com/claude-code) telemetry to Supabase for the [LORF](https://looselyorganized.com) facility dashboard. Uses OpenTelemetry as the sole source of per-request token and cost data. A local SQLite outbox makes the pipeline durable — data survives daemon crashes and Supabase outages.

## About Running the Exporter

Running the exporter requires a persistent process on the operator's machine that stays online to receive OTel events from running Claude Code sessions, watch the process table for lifecycle changes, and ship rolled-up telemetry to Supabase. The daemon runs under `launchd` as a macOS user agent — it starts on boot, restarts on crash, and stays running whether or not the facility is "open."

All telemetry flows through a local SQLite outbox (WAL mode) before it's shipped. If the daemon crashes mid-flush or Supabase is temporarily unavailable, rows persist locally and drain on restart. No telemetry is lost.

## What It Collects

| Source | What It Provides | Identity |
|--------|-----------------|----------|
| OTel `api_request` | Per-request tokens, cost, model, duration | `session.id` |
| OTel `tool_result` | Tool invocations, success/failure, duration | `session.id` |
| OTel `tool_decision` | Permission prompts accepted or rejected | `session.id` |
| OTel `api_error` | API error details and status codes | `session.id` |
| Process watcher (250 ms) | Live PID, active/idle, session_id | PID → `session.id` via `lsof` |
| `~/.claude/events.log` | 20-type activity stream | project name |

Everything lands in Supabase tables (`sessions`, `otel_api_requests`, `daily_rollups`, `agent_state`, `events`, `alerts`, `projects`, `facility_status`) used by the LORF platform to render live facility status, per-project cost, and agent activity.

## Dependencies

### Required

- [Bun](https://bun.sh) ≥ 1.1 — no build step, runs `.ts` directly
- Supabase project with the schema in `supabase/migrations/` applied
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SECRET_KEY` — Supabase service-role key (backend-only, never exposed to a browser)

### Optional

- `LO_PROJECT_ROOT` — parent directory of local projects (defaults to `/Users/bigviking/Documents/github/projects/lo`)

### Claude Code OTel Variables

Set in your shell profile so running Claude Code instances emit to the daemon:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json    # forces JSON over protobuf
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
```

## Setup

```bash
bun install
cp .env.example .env   # fill in Supabase credentials
bun run setup          # symlinks launchd plist, loads the user agent
```

After `setup`, the daemon is running under launchd. Logs land in `~/.claude/lo-exporter.log` and `~/.claude/lo-exporter.err`.

### Common Commands

```bash
bun run start      # run daemon in foreground (launchd does this in prod)
bun run backfill   # backfill history, then switch to daemon mode
bun run open       # flip facility_status to active (does NOT start the daemon)
bun run close      # flip facility_status to dormant (does NOT stop the daemon)
bun test           # test suite
```

## Architecture

```
Claude Code                          SQLite (data/telemetry.db)              Supabase
───────────────────                 ──────────────────────────             ──────────

  OTel SDK ──(POST /v1/logs)──→ [OTLP Receiver :4318]
                                     │
                                     ▼
                                 otel_events ──[OtelReceiver]──→ [Processor]
  events.log ──────[LogReceiver]───────────────→    │         pendingRollups
                                                    │         (unified accumulator)
                                                    ▼
                                              flushRollups ──→ outbox ──[Shipper]─→ sessions
                                                    │                              → otel_api_requests
                                                    │                              → daily_rollups
                                                    │                              → events
                                                    ▼                              → alerts
                                              sessions                             → projects
                                              known_projects

  ps/lsof ────[ProcessWatcher]────(direct push)──→ agent_state (INSERT/UPDATE/DELETE)
                                                   facility_status (heartbeat)

  Startup: reconcile_rollups() RPC ──→ daily_rollups (crash recovery from otel_api_requests)
```

Three independent subsystems running in a single process:

- **OTLP receiver** — Bun HTTP server on `127.0.0.1:4318`, accepts OTel JSON payloads, writes to SQLite *before* responding `HTTP 200`. No event is acknowledged until it's durably stored.
- **Process watcher (250 ms)** — detects Claude Code process lifecycle via `ps` / `lsof`, resolves `PID → session.id` by reading each process's persistent open directory handle to `~/.claude/tasks/<session_id>/`. Pushes agent state directly to Supabase `agent_state` (INSERT on discover, UPDATE on status change, DELETE on exit).
- **Pipeline (5 s)** — OtelReceiver + LogReceiver collect raw rows; Processor accumulates tokens, cost, and event counts into `pendingRollups` (in-memory, persistent across the daemon's lifetime); `flushRollups` enqueues one combined `daily_rollups` payload per project per day to the outbox; Shipper drains the outbox to Supabase with priority ordering, exponential backoff, and a circuit breaker.

### PID → Session Identity

Every Claude Code process holds a persistent open directory handle to its `~/.claude/tasks/<session_id>/` directory. The exporter discovers it once via `lsof -p PID` and caches the mapping (immutable for the process's lifetime). This is the deterministic bridge between an OS process and an application session — no guesswork, no heartbeat race.

### Crash Recovery

On startup, the daemon calls `reconcile_rollups()` on Supabase. The RPC replays `otel_api_requests` and rebuilds `daily_rollups` to match, so any split-brain between raw requests and pre-computed aggregates self-heals after an unclean exit.

## Why a Durable Outbox?

Telemetry pipelines fail in two directions: the source misbehaves (crashes, pauses, emits partial data) or the sink misbehaves (Supabase timeout, schema migration lag, rate limit). A direct `emit → ship` pipeline loses data in either case.

The outbox pattern makes both failures survivable:

1. OTel events land in SQLite (WAL mode) *before* the HTTP receiver acks. The source can crash any time after the 200 without data loss.
2. Rollups accumulate in memory and flush to the outbox; the outbox ships with exponential backoff. The sink can fail for minutes or hours without data loss.
3. `reconcile_rollups()` on startup aligns remote aggregates with raw local data. Any divergence between `otel_api_requests` and `daily_rollups` self-corrects.

The pattern is overkill for a hobbyist telemetry script and exactly right for infrastructure that has to survive operator restarts, laptop sleep, and Supabase free-tier blips.

## Why Claude Code OpenTelemetry?

Claude Code's OTel stream is the only first-party source for per-request token and cost data. Parsing the JSONL transcripts in `~/.claude/projects/` gives you conversation structure but not billing-accurate token counts — cache-read, cache-creation, input, output, and cost need the headers OTel surfaces. OTel is also versioned by Claude Code itself, so schema changes ship with the product rather than drifting against it.

## Supabase Schema

The schema lives in `supabase/migrations/` and consists of eight tables plus four RPCs:

| Table | Purpose |
|-------|---------|
| `sessions` | Session → project registry with parent-child tracking |
| `otel_api_requests` | Raw per-request token/cost data (source of truth) |
| `daily_rollups` | Pre-computed daily aggregates (tokens/cost/events JSONB) |
| `agent_state` | Ephemeral realtime agent status |
| `events` | Activity stream from events.log (20 event types) |
| `alerts` | Budget threshold alerts ($5 / $10 / $25 per project per day) |
| `projects` | Project registry with soft-delete |
| `facility_status` | Singleton heartbeat |

| RPC | Purpose |
|-----|---------|
| `get_project_summary(project_ids[], date_from, date_to)` | Tokens / cost / events by project + facility aggregate |
| `get_session_breakdown(project_id, date_from, date_to, tz)` | Per-session cost/token drill-down |
| `get_agent_state(project_ids[])` | Current agents with PID, model, status |
| `reconcile_rollups()` | Startup crash recovery — aligns daily_rollups with otel_api_requests |
