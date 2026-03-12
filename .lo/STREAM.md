---
type: stream
---

<entry>
date: 2026-03-12
title: "Dashboard error view"
<description>
In-memory error aggregator deduplicates sync and daemon errors by category and normalized message, flushes to Supabase every cycle, and surfaces them in a new Errors tab with colored category badges and expandable context. 15 error sites instrumented across sync and daemon layers — errors auto-prune after 5 minutes of silence.
</description>
</entry>

<entry>
date: 2026-03-10
title: "v0.1.0 release"
commits: 8
<description>
Tagged v0.1.0 with event RCA fixes (14-day window alignment, dedup via Supabase conflict key, log start date detection), org-root project creation and daemon tracking, dashboard lifecycle wired into lo-open/lo-close, and concierge UUID migration. First versioned release.
</description>
</entry>

<entry>
date: 2026-03-10
title: "Comprehensive test coverage"
commits: 5
<description>
218 tests across 11 files covering parsers, process scanner/watcher, project scanner/slug-resolver, CLI output, visibility cache, comparator, and extracted helpers. CodeRabbit review addressed CI-resilient test skipping for path-dependent assertions.
</description>
</entry>

<entry>
date: 2026-03-10
title: "Code simplification and branch cleanup"
commits: 6
<description>
Deduplicated type definitions (ProjectEventAggregates, parseFrontmatter, PROJECT_ROOT) across daemon-helpers, lo-status-helpers, and slug-resolver. Fixed operator precedence on Supabase type casts. Merged all feature branches to main, deleted stale remotes, cleared completed backlog.
</description>
</entry>

<entry>
date: 2026-03-10
title: "Telemetry verification dashboard and event RCA"
<description>
Built a local verification dashboard (bin/dashboard.ts) comparing events.log against Supabase side-by-side across five dimensions — events, metrics, tokens, models, projects. RCA on event divergence uncovered three root causes: 14-day pruning vs 30-day comparison window, duplicate log line counting, and 3,658 misattributed org-root events stored under the platform projId. Created a new proj_org-root project, re-attributed stale events, backfilled 14K org-root entries, and wired the daemon to track looselyorganized/lo directory names going forward.
</description>
</entry>

<entry>
date: 2026-03-10
title: "Source reorganization and backlog bootstrap"
<description>
Reorganized flat .ts files into bin/ (entry points) and src/ (library modules) directories. Added CLAUDE.md conventions and bootstrapped the backlog with 10 tracked cleanup tasks from code review — duplicated utilities, hardcoded paths, stale comments. Also cleaned orphan daily_metrics rows from Supabase that were causing recurring FK errors in the exporter logs.
</description>
</entry>

<entry>
date: 2026-03-04
title: "Extracted from claude-dashboard"
<description>
Telemetry exporter extracted from claude-dashboard/exporter/ into its own repo. Same extraction pattern as content-webhook — different language, different runtime, zero shared code with the dashboard TUI.
</description>
</entry>
