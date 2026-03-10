---
type: stream
---

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
