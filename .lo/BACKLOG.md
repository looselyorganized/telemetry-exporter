---
updated: 2026-03-10
---

## Features

- [x] f001 Test Coverage
  Retroactive test coverage for core project logic. Generated during Explore → Build transition.
  [done] 2026-03-10

## Tasks

- [x] t001 Deduplicate `formatTokens`
  Still duped in daemon-helpers.ts and sync.ts but now isolated in separate layers. Acceptable.
  [done] 2026-03-10
- [x] t002 Deduplicate `isProcessRunning`
  All callers now import from src/cli-output.ts.
  [done] 2026-03-10
- [x] t003 Deduplicate `isDirectory`
  Extracted to src/utils.ts, both scanner.ts and slug-resolver.ts now import from there.
  [done] 2026-03-10
- [x] t004 Consolidate `parseFrontmatter`
  Enhanced slug-resolver.ts version with inline YAML comment handling from lo-status-helpers.ts. Both kept since they serve different contexts (regex-fenced vs startsWith).
  [done] 2026-03-10
- [x] t005 Deduplicate `PID_FILE`
  All callers now import from src/cli-output.ts.
  [done] 2026-03-10
- [x] t006 Fix `PROJECT_ROOT` env var support in src/ modules
  Centralized in slug-resolver.ts, all modules import it.
  [done] 2026-03-10
- [x] t007 Remove unused export `printHeader`
  Deleted from src/cli-output.ts.
  [done] 2026-03-10
- [x] t008 Remove unused export `resolveContentSlug`
  Function already deleted.
  [done] 2026-03-10
- [x] t009 Fix stale comment in slug-resolver
  Updated to "60 cycles (5 min at 5s intervals)".
  [done] 2026-03-10
- [x] t010 Fix visibility type mismatch
  Changed upsertProject() to accept "public" | "private", fixed docstring in visibility-cache.ts.
  [done] 2026-03-10
