# Telemetry Exporter

Always-on Bun daemon that syncs Claude Code telemetry to Supabase for the LO operations dashboard. Uses OpenTelemetry as the primary data source for accurate per-request token and cost data. Local SQLite outbox provides durability — data survives daemon crashes and Supabase outages.

## Setup

```bash
bun install
cp .env.example .env  # fill in Supabase credentials
```

### OTel Environment Variables

Add to `~/.zprofile` so Claude Code emits OTel events to the daemon:

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
bun run open              # preflight checks, flip active, launch dashboard
bun run close             # flip dormant, stop dashboard

# Verification dashboard (opens localhost:7777)
bun run dashboard
```

## Architecture

```
Claude Code                          SQLite (data/telemetry.db)              Supabase
───────────────────                 ──────────────────────────             ──────────

  OTel SDK ──(POST /v1/logs)──→ [OTLP Receiver :4318]
                                     │
                                     ▼
                                 otel_events ──[OtelReceiver]──.
  events.log ──────[LogReceiver]────────────────┤
  JSONL files ───[TokenReceiver (fallback)]─────┼─→ [Processor] ─→ outbox ──[Shipper]─→ alerts
  stats-cache ──[MetricsReceiver]───────────────┘        │         archive              → events
                                                         │                              → daily_metrics
                                                         ▼                              → project_telemetry
                                                   sessions                             → facility_status
                                                   cost_tracking
                                                   known_projects

  ps/lsof ────[ProcessWatcher]────(direct push)──→ facility_status (agent fields)

  Cost API:  GET /cost/today, /cost/:projId, /budget/:projId  (reads cost_tracking)
```

**Three subsystems:**
- **OTLP receiver** — Bun HTTP server on `127.0.0.1:4318`, accepts OTel JSON payloads, writes to SQLite before returning HTTP 200
- **Process watcher (250ms)** — detects Claude process lifecycle via `ps`/`lsof`, pushes agent state directly to Supabase
- **Pipeline (5s)** — receivers collect data, processor writes to SQLite outbox, shipper pushes to Supabase with exponential backoff and circuit breaker

The daemon is always on. `lo-open`/`lo-close` flip `facility_status.status` in Supabase (a UI signal for Next.js) but do not affect the daemon.

## Data Sources

| Source | Type | What it provides |
|--------|------|-----------------|
| OTel `api_request` | Primary | Accurate `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `model` |
| OTel `tool_result` | Primary | `tool_name`, `success`, `duration_ms` |
| `~/.claude/events.log` | Supplementary | Real-time event stream (session_start, response_finish, tool, agent_spawn) |
| `~/.claude/projects/*/` | Fallback | JSONL token data (only when no OTel events in last 5 min) |
| `~/.claude/stats-cache.json` | Supplementary | Historical daily stats, hour distribution |
| `~/.claude/model-stats` | Supplementary | Per-model token breakdowns |

## SQLite Tables

| Table | What it stores |
|-------|---------------|
| `otel_events` | Raw OTel events (processed flag, pruned after 7 days) |
| `sessions` | Immutable session_id to proj_id mapping |
| `cost_tracking` | Per-project/date/model token + cost accumulation |
| `outbox` | Durable queue for Supabase shipping (priority dequeue, exponential backoff) |
| `archive_queue` | Deduped facts for long-term Supabase archive |
| `cursors` | File read positions for LogReceiver |
| `known_projects` | Projects registered with Supabase |

## Supabase Tables

| Table | What it stores |
|-------|---------------|
| `alerts` | Budget threshold alerts ($5/$10/$25 per project per day) |
| `events` | Log events — timestamp, project, branch, event type, text |
| `projects` | One row per project — name, visibility, first_seen, last_active |
| `daily_metrics` | Per-project daily tokens (new: per-type breakdown), sessions, messages, tool calls |
| `facility_status` | Singleton live snapshot — status, active agents, tokens, model stats |
| `project_telemetry` | Per-project live snapshot — tokens, sessions, cost, agent counts |
| `outbox_archive` | Long-term archive of discrete facts (events, metrics, session mappings, state snapshots) |

## launchd (always-on)

The included plist keeps the exporter alive as a macOS user agent — starts on boot, restarts on crash:

```bash
# One-time setup
bun run setup   # symlinks plist to ~/Library/LaunchAgents/, loads into launchd

# Facility ceremony (does NOT affect the daemon)
bun run open    # preflight checks, flip active, launch dashboard
bun run close   # flip dormant, stop dashboard
```

Logs go to `~/.claude/lo-exporter.log` and `~/.claude/lo-exporter.err`.

## Dashboard

The verification dashboard at `localhost:7777` provides:

- `/api/health` — daemon status, Supabase connectivity, pipeline health (outbox depth, circuit breaker state)
- `/api/outbox` — outbox depth by target, failed rows with error messages, cursor state
- `/api/compare/*` — side-by-side comparison of outbox vs Supabase data
- `/api/errors` — exporter error log

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Supabase service role key |
| `LO_PROJECT_ROOT` | No | Parent directory of all LO project repos |
| `DASHBOARD_PORT` | No | Port for verification dashboard (default: 7777) |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | Yes* | Set to `1` in shell profile (*required for OTel data) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Yes* | `http://127.0.0.1:4318` (*required for OTel data) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Yes* | `http/json` — forces JSON over protobuf (*required) |
