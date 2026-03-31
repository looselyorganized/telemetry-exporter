# Telemetry Exporter

Always-on Bun daemon that syncs Claude Code telemetry to Supabase for the LO facility dashboard. Uses OpenTelemetry as the sole data source for accurate per-request token and cost data. Local SQLite outbox provides durability — data survives daemon crashes and Supabase outages.

**Version:** 0.5.0

## Setup

```bash
bun install
cp .env.example .env  # fill in Supabase credentials
```

### OTel Environment Variables

Add to `~/.claude/settings.json` env overrides so Claude Code emits OTel events to the daemon:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json    # critical: forces JSON over protobuf
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
```

## Usage

```bash
# Run daemon (always-on, launchd-managed in production)
bun run start

# Backfill all history, then switch to daemon mode
bun run backfill

# Facility ceremony (does NOT start/stop the daemon)
bun run open              # preflight checks, flip active
bun run close             # flip dormant
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

**Three subsystems:**
- **OTLP receiver** — Bun HTTP server on `127.0.0.1:4318`, accepts OTel JSON payloads, writes to SQLite before returning HTTP 200
- **Process watcher (250ms)** — detects Claude process lifecycle via `ps`/`lsof`, resolves PID→session via open `~/.claude/tasks/<session_id>/` directory handle, pushes to Supabase `agent_state` table
- **Pipeline (5s)** — OtelReceiver + LogReceiver collect data, Processor accumulates into `pendingRollups` (persists across daemon lifetime), flushRollups enqueues to outbox, Shipper pushes to Supabase with exponential backoff and circuit breaker

The daemon is always on. `lo-open`/`lo-close` flip `facility_status.status` in Supabase (a UI signal for Next.js) but do not affect the daemon.

## Data Sources

| Source | What it provides | Identity |
|--------|-----------------|----------|
| OTel `api_request` | Tokens, cost, model, duration | `session.id` |
| OTel `tool_result` | Tool name, success, duration | `session.id` |
| OTel `tool_decision` | Permission accept/reject | `session.id` |
| OTel `api_error` | Error details, status code | `session.id` |
| Process watcher | PID, active/idle, session_id | PID → `session.id` (via lsof) |
| `~/.claude/events.log` | 20 event types (activity stream) | project name |

## Supabase Tables

| Table | What it stores |
|-------|---------------|
| `sessions` | Session→project registry with parent-child tracking |
| `otel_api_requests` | Raw per-request token/cost data (source of truth) |
| `daily_rollups` | Pre-computed daily aggregates (tokens/cost/events JSONB) |
| `agent_state` | Ephemeral realtime agent status |
| `events` | Activity stream (20 event types from events.log) |
| `alerts` | Budget threshold alerts ($5/$10/$25 per project per day) |
| `projects` | Project registry |
| `facility_status` | Singleton heartbeat |

## Supabase RPCs

| Function | Purpose |
|----------|---------|
| `get_project_summary` | Tokens/cost/events by project + facility aggregate, any timeframe |
| `get_session_breakdown` | Per-session cost/token drill-down with timezone support |
| `get_agent_state` | Current agents with PID, model, status, tokens |
| `reconcile_rollups` | Startup crash recovery — aligns rollups with raw request data |

## SQLite Tables

| Table | What it stores |
|-------|---------------|
| `otel_events` | Raw OTel events (0=pending, 1=processed, 2=skipped non-LO) |
| `sessions` | Session→project mapping with parent_session_id and PID |
| `outbox` | Durable queue for Supabase shipping |
| `archive_queue` | Deduped facts for long-term archive |
| `cursors` | File read positions for LogReceiver |
| `known_projects` | Projects registered with Supabase |

## launchd (always-on)

```bash
# One-time setup
bun run setup   # symlinks plist to ~/Library/LaunchAgents/, loads into launchd

# Facility ceremony (does NOT affect the daemon)
bun run open    # preflight checks, flip active
bun run close   # flip dormant
```

Logs go to `~/.claude/lo-exporter.log` and `~/.claude/lo-exporter.err`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Supabase service role key |
| `LO_PROJECT_ROOT` | No | Parent directory of all LO project repos |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | Yes* | Set to `1` in shell profile (*required for OTel data) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Yes* | `http://127.0.0.1:4318` (*required for OTel data) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Yes* | `http/json` — forces JSON over protobuf (*required) |
