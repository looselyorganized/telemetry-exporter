# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Bun-powered TypeScript daemon that syncs Claude Code telemetry from `~/.claude/` to Supabase for the LO operations dashboard. No build step — Bun runs `.ts` files directly.

## Commands

```bash
bun install                          # install dependencies
bun run start                        # run daemon (incremental sync)
bun run backfill                     # backfill all history, then daemon
bun run open                         # facility startup with preflight checks
bun run close                        # graceful facility shutdown
bun run status                       # cross-project backlog scanner
bun run dashboard                    # verification dashboard (localhost:7777)
```

No linter, no tsconfig. Dependencies: `@supabase/supabase-js` + `bun:sqlite` (built-in). Tests: `bun test`.

## Architecture

Pipeline daemon (`bin/daemon.ts`, ~270 lines) with dual loops:
- **Process watcher (250ms)** — detects Claude process lifecycle via `ps`/`lsof`, pushes agent state directly to Supabase
- **Pipeline (5s)** — Receivers collect data → Processor writes to SQLite outbox → Shipper pushes to Supabase

Data flows through a local SQLite outbox (`data/telemetry.db`, WAL mode) for durability. If the daemon crashes or Supabase is down, unshipped rows persist and drain on next startup.

### Module Layout

```
bin/           Entry points (daemon, lo-open, lo-close, lo-status, dashboard)
src/
  pipeline/
    receivers.ts       LogReceiver, TokenReceiver, MetricsReceiver (wrap existing parsers)
    processor.ts       Resolves projects, aggregates, deduplicates, writes to SQLite outbox
    shipper.ts         Reads outbox, ships to Supabase per strategy dispatch, circuit breaker
  db/
    local.ts           SQLite init, outbox CRUD, cursor persistence, archive queue, prune
    client.ts          Supabase client singleton
    agent-state.ts     Direct agent state push (watcher → Supabase, bypasses outbox)
    types.ts           Shared type definitions
  process/
    scanner.ts         Detects running Claude processes, resolves CWDs
    watcher.ts         Sliding-window activity detection (40 ticks × 250ms)
  project/
    resolver.ts        Maps directory names → proj_ IDs via lo.yml + name cache
    scanner.ts         JSONL token aggregation from ~/.claude/projects/
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

1. **Receivers** read `~/.claude/` sources: `events.log` (LogReceiver), JSONL session files (TokenReceiver), `stats-cache.json` + `model-stats` (MetricsReceiver)
2. `project/resolver.ts` maps directory names → `proj_` IDs using `lo.yml` files + `.name-cache.json`
3. **Processor** resolves projects, aggregates tokens/events, writes to SQLite outbox in transactions
4. **Shipper** reads unshipped outbox rows, ships to Supabase per target (projects → events → daily_metrics → project_telemetry → facility_metrics), with exponential backoff and circuit breaker
5. **Process watcher** (separate 250ms loop) pushes agent state directly to Supabase (bypasses outbox)
6. **Archive shipper** sends discrete facts (events, daily metrics, state snapshots) to `outbox_archive` in Supabase for long-term history

### Project Identity

Each LO project has a `lo.yml` file at its root with a stable `proj_` UUID:
```yaml
id: proj_fe8141ea-c26c-4b7e-a1e5-39d2eeeed5e8
```

The resolver reads these files directly — no git remote or Supabase lookup needed. A `.name-cache.json` file at the exporter root persists all `dirName → projId` associations, so old directory names still resolve after renames.

### Path Resolution

Several files resolve paths relative to `import.meta.dirname` or `import.meta.url` to find repo-root files (`.env`, `.exporter.pid`, `.visibility-cache.json`, `.project-mapping.json`). The `src/` files use `join(import.meta.dirname, "..")` to reach the repo root; `bin/` files use `join(dirname(url), "..")`.

### launchd Integration

`com.lo.telemetry-exporter.plist` runs `bun run bin/daemon.ts` as a macOS user agent. The `lo-open` command symlinks and loads it; `lo-close` unloads it. Logs go to `~/.claude/lo-exporter.{log,err}`.

## Environment

Requires `.env` at repo root with `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Optional `LO_PROJECT_ROOT` (defaults to `/Users/bigviking/Documents/github/projects/lo`).
