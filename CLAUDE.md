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
```

No tests, no linter, no tsconfig. Single dependency: `@supabase/supabase-js`.

## Architecture

Dual-loop daemon (`bin/daemon.ts`):
- **Process watcher (250ms)** — detects Claude process lifecycle via `ps`/`lsof`, pushes agent state changes immediately
- **Aggregator (5s)** — tails `events.log`, scans JSONL session files, syncs tokens/sessions/events to Supabase

### Module Layout

```
bin/           Entry points (daemon, lo-open, lo-close, lo-status)
src/           Library code
  parsers.ts           Log/stats file readers
  sync.ts              All Supabase writes (largest file)
  cli-output.ts        ANSI status reporting, .env loading, path constants
  visibility-cache.ts  GitHub repo visibility via `gh repo list`
  process/
    scanner.ts         Detects running Claude processes, resolves CWDs
    watcher.ts         Sliding-window activity detection (40 ticks × 250ms)
  project/
    scanner.ts         JSONL token aggregation from ~/.claude/projects/
    slug-resolver.ts   Maps directory paths → proj_id via .lo/PROJECT.md frontmatter
```

### Key Data Flow

1. `parsers.ts` reads `~/.claude/events.log` (pipe-delimited, emoji-tagged lines)
2. `project/slug-resolver.ts` maps directory names to proj_ids using `.lo/PROJECT.md` frontmatter
3. `project/scanner.ts` scans `~/.claude/projects/*/` JSONL files for per-project token usage
4. `process/scanner.ts` → `process/watcher.ts` detects running Claude instances and activity state
5. `sync.ts` pushes everything to Supabase tables: `events`, `projects`, `daily_metrics`, `facility_status`, `project_telemetry`

### Path Resolution

Several files resolve paths relative to `import.meta.dirname` or `import.meta.url` to find repo-root files (`.env`, `.exporter.pid`, `.visibility-cache.json`, `.project-mapping.json`). The `src/` files use `join(import.meta.dirname, "..")` to reach the repo root; `bin/` files use `join(dirname(url), "..")`.

### launchd Integration

`com.lo.telemetry-exporter.plist` runs `bun run bin/daemon.ts` as a macOS user agent. The `lo-open` command symlinks and loads it; `lo-close` unloads it. Logs go to `~/.claude/lo-exporter.{log,err}`.

## Environment

Requires `.env` at repo root with `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Optional `LO_PROJECT_ROOT` (defaults to `/Users/bigviking/Documents/github/projects/lo`).
