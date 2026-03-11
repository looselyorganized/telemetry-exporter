# Telemetry Exporter

Bun daemon that syncs Claude Code telemetry from `~/.claude/` to Supabase for the LO operations dashboard.

## Setup

```bash
bun install
cp .env.example .env  # fill in Supabase credentials
```

## Usage

```bash
# Incremental sync daemon (250ms watcher + 5s aggregator)
bun run bin/daemon.ts

# Backfill all history, then switch to daemon mode
bun run bin/daemon.ts --backfill

# Facility lifecycle
bun run bin/lo-open.ts    # start facility + preflight checks
bun run bin/lo-close.ts   # stop facility
bun run bin/lo-status.ts  # cross-project backlog scanner

# Verification dashboard (opens localhost:7777)
bun run bin/dashboard.ts
```

## launchd (auto-start on login)

The included plist keeps the exporter alive as a macOS user agent:

```bash
ln -s "$(pwd)/com.lo.telemetry-exporter.plist" ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.lo.telemetry-exporter.plist
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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Supabase service role key |
| `LO_PROJECT_ROOT` | No | Parent directory of all LO project repos |
| `DASHBOARD_PORT` | No | Port for verification dashboard (default: 7777) |
