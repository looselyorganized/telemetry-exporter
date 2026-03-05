# Telemetry Exporter

Bun daemon that syncs Claude Code telemetry from `~/.claude/` to Supabase for the LO operations dashboard.

## Setup

```bash
bun install
cp .env.example .env  # fill in Supabase credentials
```

## Usage

```bash
# Incremental sync daemon (30s active / 5min dormant)
bun run index.ts

# Backfill all history, then switch to daemon mode
bun run index.ts --backfill

# Facility lifecycle
bun run lo-open.ts    # start facility + preflight checks
bun run lo-close.ts   # stop facility
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
| `~/.claude/token-stats` | Aggregate token counts |
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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Supabase service role key |
| `LO_PROJECT_ROOT` | No | Parent directory of all LO project repos |
| `PUSH_INTERVAL_ACTIVE` | No | Sync interval when active (default: 30s) |
| `PUSH_INTERVAL_DORMANT` | No | Sync interval when dormant (default: 300s) |
