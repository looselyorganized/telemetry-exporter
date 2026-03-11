---
type: stream
---

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
