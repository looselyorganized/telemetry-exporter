---
updated: 2026-03-12
---

## Features

- [ ] f002 Dashboard error view
  In-memory error aggregator with Supabase persistence and dashboard UI for surfacing daemon errors.
  [active](.lo/work/f002-dashboard-error-view/)

- [ ] f003 Pipeline redesign
  Split sync.ts into db/ domain modules, standardize error handling via checkResult, unify project resolution via ProjectResolver.
  [active](.lo/work/f003-pipeline-redesign/)

## Tasks

- [ ] t001 Add lint script
  Add ESLint config and `lint` script to package.json so GH CI can run lint checks via the reusable workflow.

- [ ] t002 Add build script
  Add `build` script to package.json so GH CI can run build checks via the reusable workflow.

- [ ] t003 Update dashboard error category CSS classes
  Dashboard CSS selectors (`.cat-sync_write`, `.cat-project_resolution`, `.cat-facility_update`) use old error category names from before the Phase 1 db/ module split. They silently fail to style error badges for the new categories. Update to match current `ErrorCategory` values.

- [ ] t004 Fix legacy resolver entries using encoded path as slug
  `ProjectResolver` stores legacy `.project-mapping.json` entries with `slug: encodedName` (e.g. `-Users-bigviking-Documents-github-projects-lo-nexus`). Not a real slug. Cosmetic — legacy slugs are never displayed — but the type system allows callers to trust `resolved.slug` as display-friendly.
