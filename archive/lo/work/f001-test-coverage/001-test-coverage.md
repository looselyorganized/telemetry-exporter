---
status: done
feature_id: "f001"
feature: test-coverage
phase: 1
---

## Objective
Add test coverage to core project logic identified during Build transition.

## Tasks

### High Priority — Core Parsers & Data Transformation

- [x] [high] Test src/parsers.ts: `parseTimestamp` — 12h→24h conversion, MM/DD format, timezone stripping, null on invalid
- [x] [high] Test src/parsers.ts: `parseLogLine` — pipe-separated parsing, emoji→event_type mapping, null when no project
- [x] [high] Test src/parsers.ts: `stripAnsi` — ANSI color code removal
- [x] [high] Test src/parsers.ts: `LogTailer` — readAll offset tracking, poll incremental reads, file truncation handling
- [x] [high] Test src/parsers.ts: `readModelStats` — space-separated model stats parsing, missing file handling
- [x] [high] Test src/project/slug-resolver.ts: `parseFrontmatter` — YAML frontmatter between --- fences, quoted values
- [x] [high] Test src/project/slug-resolver.ts: `resolveProjId` — reads id/proj_id from PROJECT.md, null when no .lo/
- [x] [high] Test src/project/slug-resolver.ts: `resolveSlug` — content_slug from frontmatter, basename fallback
- [x] [high] Test src/project/slug-resolver.ts: `loadLegacyMapping` — .project-mapping.json loading, caching
- [x] [high] Test src/project/scanner.ts: `resolveProjectName` — encoded dir name → project name, org root prefix matching
- [x] [high] Test src/project/scanner.ts: `resolveProjIdForDir` — live repo resolution → legacy fallback
- [x] [high] Test src/project/scanner.ts: `extractUsageRecords` — JSONL token extraction, requestId deduplication
- [x] [high] Test src/project/scanner.ts: `computeTokensByProject` — token aggregation across dates/models

### High Priority — Process Detection

- [x] [high] Test src/process/scanner.ts: `deriveProjectName` — git root detection, "projects/" heuristic, basename fallback
- [x] [high] Test src/process/scanner.ts: `parseClaudeProcesses` — ps output parsing, filtering for "claude" comm
- [x] [high] Test src/process/scanner.ts: `resolveCwds` — lsof output parsing (p/n line format)
- [x] [high] Test src/process/scanner.ts: `findCaffeinatePids` — ps output filtering for caffeinate children
- [x] [high] Test src/process/watcher.ts: `countTruthy` — boolean array counting
- [x] [high] Test src/process/watcher.ts: `ProcessWatcher` — sliding window activity detection, state transitions (created/active/idle/closed)

### Medium Priority — Helpers & Utilities

- [x] [medium] Test bin/daemon.ts: `formatTokens` — "1.2M" formatting at various scales
- [x] [medium] Test bin/daemon.ts: `sumValues` — numeric record summation
- [x] [medium] Test bin/daemon.ts: `aggregateProjectEvents` — event grouping by project/date/type
- [x] [medium] Test bin/daemon.ts: `computeLastActive` — latest timestamp per project
- [x] [medium] Test bin/daemon.ts: `formatModelStats` — array to keyed object transformation
- [x] [medium] Test bin/daemon.ts: `filterAndMapEntries` — LO project filtering + projId mapping
- [x] [medium] Test bin/lo-status.ts: `parseFrontmatter` — handles quoted values + inline YAML comments
- [x] [medium] Test bin/lo-status.ts: `parseBacklogFeatures` — ### fNNN heading + Status: line extraction, done filtering
- [x] [medium] Test bin/lo-status.ts: `parseBacklogTasks` — unchecked task checkbox parsing
- [x] [medium] Test src/project/scanner.ts: `discoverJsonlFiles` — top-level + subagent nested discovery
- [x] [medium] Test src/project/scanner.ts: `getOrCreate` — Map utility (get existing / insert default)
- [x] [medium] Test src/cli-output.ts: `loadEnv` — .env parsing, comment skipping, missing credential abort

### Low Priority

- [x] [low] Test bin/daemon.ts: `buildProjectTelemetryUpdates` — aggregation from multiple caches
- [x] [low] Test bin/daemon.ts: `pruneSeenEntries` — 31-day retention cutoff
- [x] [low] Test src/visibility-cache.ts: `getVisibility` — cache hit vs GitHub lookup, default to private
