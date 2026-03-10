---
id: "proj_fc236751-369a-4b23-847e-577e06753eee"
title: "Telemetry Exporter"
description: "Bun daemon that syncs Claude Code telemetry from ~/.claude/ to Supabase for the LO operations dashboard."
status: "build"
state: "private"
repo: "https://github.com/looselyorganized/telemetry-exporter.git"
stack:
  - TypeScript
  - Bun
  - Supabase
infrastructure:
  - Supabase
  - launchd
agents:
  - name: "claude-code"
    role: "AI coding agent (Claude Code)"
---

Bun-powered daemon that reads Claude Code's native telemetry files (`~/.claude/events.log`, `model-stats`, `stats-cache.json`) and syncs them to Supabase Postgres. Provides facility-wide operational visibility for the LO platform.

## Capabilities

- **Event Sync** — Incremental log tailing with pipe-delimited, emoji-tagged event parsing and Supabase upsert
- **Facility Status** — Singleton live snapshot of active agents, tokens, model stats, and hour distribution
- **Per-Project Metrics** — Daily token breakdowns, session counts, and tool call aggregates per LO project
- **Process Scanning** — Detects running Claude processes via ps/lsof with CWD resolution and MCP server discovery
- **CLI Controls** — lo-open/lo-close scripts for facility lifecycle management with preflight checks

## Architecture

TypeScript/Bun daemon with dual-loop architecture: 250ms process watcher (agent state push-on-change) + 5s aggregator (tokens, sessions, events). Parses events, model stats, and JSONL conversation files. Upserts to Supabase Postgres tables: events, projects, daily_metrics, facility_status, project_telemetry. launchd keeps it alive.

## Infrastructure

- **Supabase** — Hosted Postgres for telemetry storage via `@supabase/supabase-js`
- **launchd** — macOS service management keeping the exporter alive via plist
