# Telemetry Exporter

Bun daemon that syncs Claude Code telemetry from `~/.claude/` to Supabase for the LO operations dashboard. Uses a local SQLite outbox for durability — data survives daemon crashes and Supabase outages.

## Setup

```bash
bun install
cp .env.example .env  # fill in Supabase credentials
```

## Usage

```bash
# Incremental sync daemon (250ms watcher + 5s pipeline)
bun run start

# Backfill all history, then switch to daemon mode
bun run backfill

# Facility lifecycle
bun run open              # start facility + preflight checks
bun run close             # stop facility
bun run status            # cross-project backlog scanner

# Verification dashboard (opens localhost:7777)
bun run dashboard
```

## Architecture

```
~/.claude/ files          SQLite (data/telemetry.db)         Supabase
─────────────────        ─────────────────────────         ──────────

  events.log ───[LogReceiver]──.
  JSONL files ─[TokenReceiver]──┼─→ [Processor] ─→ outbox ──[Shipper]─→ events
  stats-cache [MetricsReceiver]─┘        │         archive ──[Shipper]─→ outbox_archive
                                         │                            ─→ projects
                                         ▼                            ─→ daily_metrics
                                   known_projects                     ─→ project_telemetry
                                   cursors                            ─→ facility_status

  ps/lsof ────[ProcessWatcher]────(direct)────→ facility_status (agent fields)
                                              → project_telemetry (agent fields)
```

**Dual-loop daemon:**
- **Process watcher (250ms)** — detects Claude process lifecycle, pushes agent state directly to Supabase
- **Pipeline (5s)** — receivers collect data → processor writes to SQLite outbox → shipper pushes to Supabase

The SQLite outbox (`data/telemetry.db`, WAL mode) provides local durability. If Supabase is down, the outbox accumulates rows and drains when connectivity returns. A circuit breaker pauses shipping after 3 consecutive failures.

## launchd (auto-start on login)

The included plist keeps the exporter alive as a macOS user agent:

```bash
bun run open   # symlinks plist, loads launchd, runs preflight checks
bun run close  # unloads launchd, stops daemon
```

Logs go to `~/.claude/lo-exporter.log` and `~/.claude/lo-exporter.err`.

## Data Sources

| File | Purpose |
|------|---------|
| `~/.claude/events.log` | Real-time event stream (pipe-delimited, emoji-tagged) |
| `~/.claude/model-stats` | Per-model token breakdowns |
| `~/.claude/stats-cache.json` | Historical daily stats |
| `~/.claude/projects/*/` | JSONL conversation files for per-project metrics |

## Supabase Tables

| Table | What it stores |
|-------|---------------|
| `events` | Every log line — timestamp, project, branch, emoji, event type, text |
| `projects` | One row per project — name, visibility, first_seen, last_active |
| `daily_metrics` | Global + per-project daily tokens, sessions, messages, tool calls |
| `facility_status` | Singleton live snapshot — status, active agents, tokens, model stats |
| `project_telemetry` | Per-project live snapshot — tokens, sessions, agent counts |
| `outbox_archive` | Long-term archive of discrete facts (events, metrics, state snapshots) |

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
