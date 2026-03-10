---
updated: 2026-03-10
---

## Features

- [ ] f001 Test Coverage
  Retroactive test coverage for core project logic. Generated during Explore → Build transition.
  [active](work/f001-test-coverage/)

## Tasks

- [ ] t001 Deduplicate `formatTokens` — identical `(n / 1e6).toFixed(1) + "M"` in bin/daemon.ts:193 and src/sync.ts:28. Import from sync.ts or extract to a shared helpers module.
- [ ] t002 Deduplicate `isProcessRunning` — identical in bin/daemon.ts:67 and src/cli-output.ts:128. cli-output.ts already exports it; daemon.ts should import from there.
- [ ] t003 Deduplicate `isDirectory` — identical `statSync().isDirectory()` wrapper in src/project/scanner.ts:38 and src/project/slug-resolver.ts:38. Extract to a shared utility.
- [ ] t004 Consolidate `parseFrontmatter` — two implementations with different behavior: src/project/slug-resolver.ts:24 (regex-based) and bin/lo-status.ts:63 (handles quoted values + inline comments). Keep the more robust lo-status.ts version, share it.
- [ ] t005 Deduplicate `PID_FILE` — computed independently in bin/daemon.ts:65 and src/cli-output.ts:15. daemon.ts should import from cli-output.ts.
- [ ] t006 Fix `PROJECT_ROOT` env var support in src/ modules — bin/daemon.ts:141 reads `LO_PROJECT_ROOT` env var but src/process/scanner.ts:13, src/project/scanner.ts:22, and src/project/slug-resolver.ts:16 all hardcode `/Users/bigviking/Documents/github/projects/lo`. The env var is documented but effectively broken for these modules.
- [ ] t007 Remove unused export `printHeader` — exported from src/cli-output.ts:66, imported but never called in bin/lo-open.ts:27 and bin/lo-close.ts:24. Delete the function and imports.
- [ ] t008 Remove unused export `resolveContentSlug` — trivial alias for `resolveSlug()` in src/project/slug-resolver.ts:150-152 described as "migration period" convenience. No external callers. Delete it.
- [ ] t009 Fix stale comment in slug-resolver — src/project/slug-resolver.ts:82 says "refreshed every 10 cycles (5 min at 30s intervals)" but daemon.ts:829 refreshes every 60 cycles at 5s intervals. Update the comment.
- [ ] t010 Fix visibility type mismatch — src/visibility-cache.ts:73 docstring says default is "classified" but returns "private" (line 80). Meanwhile daemon.ts:231 passes result to sync.ts `upsertProject` which expects `"public" | "classified"`. Align the types.
