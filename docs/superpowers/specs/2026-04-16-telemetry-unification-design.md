# Telemetry Unification — Exporter Events + Dashboard Upgrade

**Date**: 2026-04-16
**Status**: Approved
**Scope**: telemetry-exporter, claude-dashboard, Supabase (lorf-site)

## Problem

The telemetry exporter emits structured diagnostic events (integrity gaps, project blocks, budget alerts) to local stdout/stderr only. There is no remote visibility into daemon health. The claude-dashboard is a 2,400-line local-only Python TUI that duplicates token-counting logic already authoritative in Supabase. These should be unified: the exporter ships structured events to Supabase, and the dashboard reads from Supabase as an enhancement layer over local data.

## Design Principles

1. **Local-first, remote-enhanced.** Dashboard must work fully offline. Supabase is an upgrade, not a dependency.
2. **HTTP polling, not websockets.** 2-second polling is simpler, more reliable in Python/Textual, and sufficient for a TUI.
3. **Split before extend.** The monolithic dashboard.py gets decomposed into modules before adding Supabase plumbing.
4. **Separate table for exporter diagnostics.** The existing `events` table is high-volume agent activity. Exporter diagnostics have different access patterns (JSONB payload, level filtering, host column) and should not pollute the agent-activity table.

## Phase 1a — Exporter: ship structured events

### Supabase schema

```sql
CREATE TABLE exporter_events (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  level       text NOT NULL,      -- info | warn | error
  evt         text NOT NULL,      -- event type key
  session_id  text,
  project_id  text,
  payload     jsonb NOT NULL,
  host        text NOT NULL DEFAULT 'mac-mini-01'
);
CREATE INDEX idx_exporter_events_ts ON exporter_events (ts DESC);
```

### Code changes (telemetry-exporter)

**`src/errors.ts`** — add `reportEvent(level, evt, payload, opts?)`:
- Enqueues via `enqueue("exporter_events", { ts, level, evt, session_id, project_id, payload, host })`
- Echoes to stdout for local `tail -f`
- No dedup (unlike `reportError` — events are timestamped occurrences, not deduplicated states)

**`bin/daemon.ts`** — replace inline `console.warn(JSON.stringify({evt:...}))` calls:
- Line ~342: `otel_integrity_gap` → `reportEvent("warn", "otel_integrity_gap", row)`
- Line ~361: `project_blocked.drops` → `reportEvent("warn", "project_blocked.drops", { proj_id, dropped, breakdown })`

**`src/pipeline/shipper.ts`** — line ~397:
- `project_blocked` → `reportEvent("error", "project_blocked", { proj_id, slug, reason, error })`

**`src/pipeline/processor.ts`** — line ~295:
- `reconcile` RPC failure → `reportEvent("error", "reconcile_failed", { message })`

### Shipper target

Add `"exporter_events"` to the shipper's target routing (src/pipeline/shipper.ts). Simple Supabase insert, no RPC needed.

## Phase 1b — Dashboard: split monolith

Split `dashboard.py` into modules. No behavior changes.

```
claude-dashboard/
  dashboard.py        → app.py (ClaudeDashboardApp, compose, keybindings, main)
  data/
    __init__.py
    log_tailer.py     # LogTailer class (currently lines 237-320)
    token_scanner.py  # ProjectTokenScanner (lines 328-505)
    process_scanner.py # ProcessScanner (lines 771-867)
    agent_tree.py     # build_agent_tree + helpers (lines 585-677)
    stats.py          # count_events, LogEntry, parse helpers (lines 73-230)
    types.py          # shared dataclasses (LogEntry, AgentNode, etc.)
  views/
    __init__.py
    live.py           # Live tab rendering + filter logic
    stats_tab.py      # Stats tab
    instances.py      # Instances tab
  config.py           # color palette, constants, keybindings, CSS
```

Cut on existing seams. Classes are already self-contained. Verify: `python3 app.py` produces identical output.

## Phase 2 — Dashboard: Supabase as enhancement

### Dependencies

`supabase`, `python-dotenv`. Load `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` from `.env`. If missing → skip remote entirely.

### RemotePoller class

New `data/remote_poller.py`:
- HTTP polling at 2-second interval via `supabase.table(...).select().gte('ts', cursor).order('ts').limit(50)`
- Queries: `exporter_events`, `exporter_errors`, `facility_status`
- Connection state enum: `connected | degraded | offline`
- On failure: set state to `offline`, exponential backoff (2s → 4s → 8s → cap 30s), continue local-only
- Thread-safe queue for pushing rows into Textual's event loop

### Fallback matrix

| Data | Remote available | Remote unavailable |
|---|---|---|
| Stats/tokens | `get_project_summary` RPC | `stats-cache.json` + JSONL scan |
| Facility status | `facility_status` table | Local process scanner |
| Exporter signals | `exporter_events` poll | `~/.claude/lo-exporter.err` tail |
| Agent activity | Local `events.log` always | — |
| Processes | Local `ps`/`lsof` always | — |

### Header indicator

One-character connection status in the header bar:
- `▲` green = connected
- `▲` yellow = degraded (last poll failed, retrying)
- `▼` red = offline (3+ consecutive failures)

## Phase 3 — UI reconfiguration

### Tab: Live (existing, upgraded)

Add 1-line header strip above the event log:
```
● Operational | Agents 2/4 | Outbox 0 | ▲ Remote
```
Sourced from `facility_status` poll when available, local process scanner when not.

### Tab: Stats (existing, upgraded)

Primary source becomes `get_project_summary` RPC. Falls back to local on disconnect.

One RPC call replaces:
- `stats-cache.json` read (line 307)
- Incremental JSONL scanner (lines 328-505)
- `project-token-cache.json` read (line 328)

Keep the paginated daily breakdown UI. Data shape stays the same — only the source changes.

### Tab: Instances (existing, unchanged)

No changes. Local `ps`/`lsof` is sufficient. Remote `agent_state` visibility is a future enhancement.

### Tab: Signals (new)

Scrollable RichLog feed of `exporter_events` + `exporter_errors`, newest first.

Filters (keyboard-driven, matching Live tab patterns):
- By level: `i` (info), `w` (warn), `e` (error)
- By evt type: `/` search
- By project: `p` + select

Only available when remote is connected. Shows placeholder when offline:
```
Remote unavailable — tail ~/.claude/lo-exporter.err for local logs
```

## Out of scope

- Web `/ops/signals` page on the platform (separate PR)
- Supabase realtime websockets (polling is sufficient)
- Multi-device dedup (host column enables filtering; no dedup logic)
- Design-token alignment (separate PR)
- Dashboard rewrite (this is incremental)

## Execution order

```
Phase 1a: Exporter table + reportEvent           ~2hr  (unblocks Signals)
Phase 1b: Dashboard monolith split                ~3hr  (parallel with 1a, unblocks 2+3)
Phase 2:  RemotePoller + fallback wiring          ~3hr  (depends on 1a + 1b)
Phase 3:  Stats upgrade + Signals tab + header    ~3hr  (depends on 2)
```

Total: ~11 hours across 4 parallelizable phases.

## Test plan

- Phase 1a: exporter test — `reportEvent` enqueues correctly, shipper ships to Supabase
- Phase 1b: `python3 app.py` launches identically before and after split
- Phase 2: mock Supabase responses in tests; verify fallback activates on connection failure
- Phase 3: manual verification — Stats tab shows same data from RPC as from local; Signals tab renders events
