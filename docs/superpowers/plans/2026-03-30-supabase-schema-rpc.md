# Supabase Schema + RPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the new Supabase schema (sessions, otel_requests, daily_rollups, agent_state) and RPC functions (get_project_summary, get_session_breakdown, get_agent_state) that serve telemetry data to any consumer.

**Architecture:** Additive migrations — new tables are created alongside existing ones. Historical data migrates from `daily_metrics` → `daily_rollups`. Old tables (`project_telemetry`, `facility_status` token fields) are not dropped yet — that happens after the exporter is rewired (Plan 2). RPC functions handle both old and new token JSONB formats.

**Tech Stack:** PostgreSQL (Supabase), SQL migrations, Supabase RPC

**TDD:** `platform/docs/superpowers/specs/2026-03-30-telemetry-architecture-tdd.md`

---

## File Map

All migration SQL files live in `supabase/migrations/` in the telemetry-exporter project. Files are numbered for execution order.

| File | Action | Responsibility |
|------|--------|---------------|
| `supabase/migrations/001_sessions.sql` | Create | Sessions table linking session_id → project_id with parent-child |
| `supabase/migrations/002_otel_requests.sql` | Create | Raw per-request OTel data with full token/cost breakdown |
| `supabase/migrations/003_daily_rollups.sql` | Create | Daily aggregates per project + migrate data from daily_metrics |
| `supabase/migrations/004_agent_state.sql` | Create | Ephemeral realtime agent status table |
| `supabase/migrations/005_events_update.sql` | Create | Add session_id column to existing events table |
| `supabase/migrations/006_rpc_get_project_summary.sql` | Create | RPC function for tokens/cost/events by project + timeframe |
| `supabase/migrations/007_rpc_get_session_breakdown.sql` | Create | RPC function for per-session cost/token drill-down |
| `supabase/migrations/008_rpc_get_agent_state.sql` | Create | RPC function for current agent status |

**How to run migrations:** Execute each SQL file in order via the Supabase Dashboard SQL Editor (Settings → SQL Editor), or via `psql` with your Supabase connection string:

```bash
psql "postgresql://postgres.[ref]:[password]@[host]:5432/postgres" -f supabase/migrations/001_sessions.sql
```

---

### Task 1: Create migrations directory and sessions table

**Files:**
- Create: `supabase/migrations/001_sessions.sql`

- [ ] **Step 1: Create migrations directory**

```bash
mkdir -p /Users/bigviking/Documents/github/projects/lo/telemetry-exporter/supabase/migrations
```

- [ ] **Step 2: Write sessions migration**

```sql
-- 001_sessions.sql
-- Session registry: links Claude Code sessions to projects with parent-child tracking.
-- Sessions are immutable after creation (first write wins).

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  parent_session_id  TEXT REFERENCES sessions(id),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;

-- Enable realtime for sessions (needed for shipper FK ordering)
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
```

- [ ] **Step 3: Run migration**

Execute the SQL in the Supabase SQL Editor or via psql.

- [ ] **Step 4: Verify**

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sessions'
ORDER BY ordinal_position;
```

Expected: 5 columns (id, project_id, parent_session_id, started_at, ended_at).

- [ ] **Step 5: Commit**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
git add supabase/migrations/001_sessions.sql
git commit -m "feat(schema): create sessions table for session→project mapping"
```

---

### Task 2: Create otel_requests table

**Files:**
- Create: `supabase/migrations/002_otel_requests.sql`

- [ ] **Step 1: Write otel_requests migration**

```sql
-- 002_otel_requests.sql
-- Raw per-request OTel data. Full token/cost granularity per API call.
-- 90-day retention (cleanup handled by exporter or scheduled job).

CREATE TABLE IF NOT EXISTS otel_requests (
  id                 BIGSERIAL PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  project_id         TEXT NOT NULL REFERENCES projects(id),
  model              TEXT NOT NULL,
  input_tokens       INT NOT NULL DEFAULT 0,
  output_tokens      INT NOT NULL DEFAULT 0,
  cache_read_tokens  INT NOT NULL DEFAULT 0,
  cache_write_tokens INT NOT NULL DEFAULT 0,
  cost_usd           DECIMAL(10,6) NOT NULL DEFAULT 0,
  duration_ms        INT NOT NULL DEFAULT 0,
  timestamp          TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otel_req_project_ts
  ON otel_requests(project_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_otel_req_session_ts
  ON otel_requests(session_id, timestamp);

-- Partition-friendly index for retention cleanup
CREATE INDEX IF NOT EXISTS idx_otel_req_timestamp
  ON otel_requests(timestamp);
```

- [ ] **Step 2: Run migration**

Execute the SQL in the Supabase SQL Editor.

- [ ] **Step 3: Verify**

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'otel_requests'
ORDER BY ordinal_position;
```

Expected: 11 columns (id, session_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, timestamp).

- [ ] **Step 4: Commit**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
git add supabase/migrations/002_otel_requests.sql
git commit -m "feat(schema): create otel_requests table for raw per-request data"
```

---

### Task 3: Create daily_rollups and migrate historical data

**Files:**
- Create: `supabase/migrations/003_daily_rollups.sql`

- [ ] **Step 1: Write daily_rollups migration with data migration**

```sql
-- 003_daily_rollups.sql
-- Pre-computed daily aggregates per project. Kept forever.
-- Migrates existing data from daily_metrics.

CREATE TABLE IF NOT EXISTS daily_rollups (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  date        DATE NOT NULL,
  tokens      JSONB NOT NULL DEFAULT '{}',
  cost        JSONB NOT NULL DEFAULT '{}',
  events      JSONB NOT NULL DEFAULT '{}',
  sessions    INT NOT NULL DEFAULT 0,
  errors      INT NOT NULL DEFAULT 0,

  PRIMARY KEY (project_id, date)
);

-- Migrate existing daily_metrics data into daily_rollups.
-- Handles both old format (flat token totals) and new format (token breakdown).
-- Event counts are converted from INT columns to JSONB.
INSERT INTO daily_rollups (project_id, date, tokens, cost, events, sessions, errors)
SELECT
  project_id,
  date::date,
  COALESCE(tokens, '{}'),
  '{}',  -- no cost data in historical daily_metrics
  jsonb_strip_nulls(jsonb_build_object(
    'tool_use', NULLIF(COALESCE(tool_calls, 0), 0),
    'agent_spawn', NULLIF(COALESCE(agent_spawns, 0), 0),
    'message', NULLIF(COALESCE(team_messages, 0), 0),
    'finished_responding', NULLIF(COALESCE(messages, 0), 0)
  )),
  COALESCE(sessions, 0),
  0
FROM daily_metrics
ON CONFLICT (project_id, date) DO NOTHING;

-- Verify row count
DO $$
DECLARE
  source_count INT;
  target_count INT;
BEGIN
  SELECT COUNT(*) INTO source_count FROM daily_metrics;
  SELECT COUNT(*) INTO target_count FROM daily_rollups;
  RAISE NOTICE 'Migrated: % source rows, % target rows', source_count, target_count;
END $$;
```

- [ ] **Step 2: Run migration**

Execute the SQL in the Supabase SQL Editor. Check the NOTICE output for row counts.

- [ ] **Step 3: Verify data integrity**

```sql
-- Check row counts match
SELECT
  (SELECT COUNT(*) FROM daily_metrics) AS source,
  (SELECT COUNT(*) FROM daily_rollups) AS target;

-- Spot check: compare a specific project's token data
SELECT
  dm.date, dm.tokens AS dm_tokens, dr.tokens AS dr_tokens
FROM daily_metrics dm
JOIN daily_rollups dr ON dm.project_id = dr.project_id AND dm.date::date = dr.date
WHERE dm.project_id = (SELECT id FROM projects LIMIT 1)
ORDER BY dm.date DESC
LIMIT 3;
```

Expected: Row counts match. Token JSONB is identical between source and target.

- [ ] **Step 4: Commit**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
git add supabase/migrations/003_daily_rollups.sql
git commit -m "feat(schema): create daily_rollups table + migrate from daily_metrics"
```

---

### Task 4: Create agent_state table

**Files:**
- Create: `supabase/migrations/004_agent_state.sql`

- [ ] **Step 1: Write agent_state migration**

```sql
-- 004_agent_state.sql
-- Ephemeral realtime agent status. Rows exist only while processes are alive.
-- INSERT on process discovery, UPDATE on status/token change, DELETE on exit.

CREATE TABLE IF NOT EXISTS agent_state (
  session_id         TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  pid                INT NOT NULL,
  model              TEXT,
  status             TEXT NOT NULL DEFAULT 'idle',
  tokens_session     BIGINT DEFAULT 0,
  cost_session       DECIMAL(10,6) DEFAULT 0,
  parent_session_id  TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_state_project ON agent_state(project_id);

-- Enable realtime for agent_state (sub-second updates to Platform)
ALTER PUBLICATION supabase_realtime ADD TABLE agent_state;
```

- [ ] **Step 2: Run migration**

Execute the SQL in the Supabase SQL Editor.

- [ ] **Step 3: Verify**

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'agent_state'
ORDER BY ordinal_position;
```

Expected: 10 columns.

- [ ] **Step 4: Verify realtime is enabled**

```sql
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND tablename = 'agent_state';
```

Expected: 1 row.

- [ ] **Step 5: Commit**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
git add supabase/migrations/004_agent_state.sql
git commit -m "feat(schema): create agent_state table for realtime agent status"
```

---

### Task 5: Add session_id column to events table

**Files:**
- Create: `supabase/migrations/005_events_update.sql`

- [ ] **Step 1: Write events update migration**

```sql
-- 005_events_update.sql
-- Add session_id to existing events table for OTel-sourced events.
-- Existing rows keep NULL session_id (events.log has no session context).

ALTER TABLE events ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Index for session-level event queries
CREATE INDEX IF NOT EXISTS idx_events_session
  ON events(session_id, timestamp)
  WHERE session_id IS NOT NULL;

-- Partial index for attention alert realtime subscription
CREATE INDEX IF NOT EXISTS idx_events_attention
  ON events(event_type, timestamp)
  WHERE event_type IN ('wants_input', 'need_permission', 'ask_question');
```

- [ ] **Step 2: Run migration**

Execute the SQL in the Supabase SQL Editor.

- [ ] **Step 3: Verify**

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'events' AND column_name = 'session_id';
```

Expected: 1 row, TEXT, YES (nullable).

- [ ] **Step 4: Commit**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
git add supabase/migrations/005_events_update.sql
git commit -m "feat(schema): add session_id column to events table"
```

---

### Task 6: RPC function — get_project_summary

**Files:**
- Create: `supabase/migrations/006_rpc_get_project_summary.sql`

- [ ] **Step 1: Write the RPC function**

```sql
-- 006_rpc_get_project_summary.sql
-- Primary query: tokens, cost, events by project(s) and timeframe.
-- Handles both old (flat) and new (breakdown) token JSONB formats.

CREATE OR REPLACE FUNCTION get_project_summary(
  p_project_ids TEXT[] DEFAULT NULL,
  p_date_from   DATE DEFAULT NULL,
  p_date_to     DATE DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  result JSONB;
BEGIN
  WITH filtered AS (
    SELECT project_id, date, tokens, cost, events, sessions, errors
    FROM daily_rollups
    WHERE (p_project_ids IS NULL OR project_id = ANY(p_project_ids))
      AND (p_date_from IS NULL OR date >= p_date_from)
      AND (p_date_to IS NULL OR date <= p_date_to)
  ),

  -- Normalize token JSONB: old format {"model": N} → {"model": {"total": N}}
  -- New format {"model": {"input": N, ...}} → kept as-is with computed total
  token_rows AS (
    SELECT
      f.project_id,
      t.key AS model_name,
      CASE jsonb_typeof(t.value)
        WHEN 'number' THEN (t.value)::bigint
        ELSE 0
      END AS flat_total,
      CASE jsonb_typeof(t.value)
        WHEN 'object' THEN COALESCE((t.value->>'input')::bigint, 0)
        ELSE 0
      END AS input_tokens,
      CASE jsonb_typeof(t.value)
        WHEN 'object' THEN COALESCE((t.value->>'output')::bigint, 0)
        ELSE 0
      END AS output_tokens,
      CASE jsonb_typeof(t.value)
        WHEN 'object' THEN COALESCE((t.value->>'cache_read')::bigint, 0)
        ELSE 0
      END AS cache_read_tokens,
      CASE jsonb_typeof(t.value)
        WHEN 'object' THEN COALESCE((t.value->>'cache_write')::bigint, 0)
        ELSE 0
      END AS cache_write_tokens
    FROM filtered f, jsonb_each(f.tokens) AS t
  ),

  -- Aggregate tokens by project and model
  by_model AS (
    SELECT
      project_id,
      model_name,
      SUM(flat_total + input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total,
      SUM(input_tokens) AS input,
      SUM(output_tokens) AS output,
      SUM(cache_read_tokens) AS cache_read,
      SUM(cache_write_tokens) AS cache_write
    FROM token_rows
    GROUP BY project_id, model_name
  ),

  -- Build per-project token summary with model breakdown
  project_tokens AS (
    SELECT
      project_id,
      SUM(total) AS total_tokens,
      SUM(input) AS total_input,
      SUM(output) AS total_output,
      SUM(cache_read) AS total_cache_read,
      SUM(cache_write) AS total_cache_write,
      jsonb_object_agg(
        model_name,
        jsonb_build_object(
          'total', total,
          'input', input,
          'output', output,
          'cache_read', cache_read,
          'cache_write', cache_write
        )
      ) AS by_model
    FROM by_model
    GROUP BY project_id
  ),

  -- Aggregate cost by project and model
  cost_rows AS (
    SELECT
      f.project_id,
      c.key AS model_name,
      SUM((c.value)::numeric) AS model_cost
    FROM filtered f, jsonb_each_text(f.cost) AS c
    GROUP BY f.project_id, c.key
  ),

  project_cost AS (
    SELECT
      project_id,
      SUM(model_cost) AS total_cost,
      jsonb_object_agg(model_name, round(model_cost, 2)) AS by_model
    FROM cost_rows
    GROUP BY project_id
  ),

  -- Aggregate events by project and type
  event_rows AS (
    SELECT
      f.project_id,
      e.key AS event_type,
      SUM((e.value)::bigint) AS event_count
    FROM filtered f, jsonb_each_text(f.events) AS e
    GROUP BY f.project_id, e.key
  ),

  project_events AS (
    SELECT
      project_id,
      jsonb_object_agg(event_type, event_count) AS counts
    FROM event_rows
    GROUP BY project_id
  ),

  -- Aggregate sessions and errors by project
  project_meta AS (
    SELECT
      project_id,
      SUM(sessions) AS total_sessions,
      SUM(errors) AS total_errors
    FROM filtered
    GROUP BY project_id
  ),

  -- Build per-project result
  project_result AS (
    SELECT
      COALESCE(pt.project_id, pc.project_id, pe.project_id, pm.project_id) AS project_id,
      jsonb_build_object(
        'tokens', jsonb_build_object(
          'total', COALESCE(pt.total_tokens, 0),
          'input', COALESCE(pt.total_input, 0),
          'output', COALESCE(pt.total_output, 0),
          'cache_read', COALESCE(pt.total_cache_read, 0),
          'cache_write', COALESCE(pt.total_cache_write, 0),
          'by_model', COALESCE(pt.by_model, '{}'::jsonb)
        ),
        'cost', jsonb_build_object(
          'total', COALESCE(round(pc.total_cost, 2), 0),
          'by_model', COALESCE(pc.by_model, '{}'::jsonb)
        ),
        'events', COALESCE(pe.counts, '{}'::jsonb),
        'errors', COALESCE(pm.total_errors, 0),
        'sessions', COALESCE(pm.total_sessions, 0)
      ) AS summary
    FROM project_meta pm
    LEFT JOIN project_tokens pt USING (project_id)
    LEFT JOIN project_cost pc USING (project_id)
    LEFT JOIN project_events pe USING (project_id)
  )

  SELECT jsonb_build_object(
    'projects', COALESCE(jsonb_object_agg(pr.project_id, pr.summary), '{}'::jsonb),
    'facility', jsonb_build_object(
      'tokens', jsonb_build_object(
        'total', COALESCE((SELECT SUM(total_tokens) FROM project_tokens), 0),
        'input', COALESCE((SELECT SUM(total_input) FROM project_tokens), 0),
        'output', COALESCE((SELECT SUM(total_output) FROM project_tokens), 0),
        'cache_read', COALESCE((SELECT SUM(total_cache_read) FROM project_tokens), 0),
        'cache_write', COALESCE((SELECT SUM(total_cache_write) FROM project_tokens), 0)
      ),
      'cost', jsonb_build_object(
        'total', COALESCE((SELECT round(SUM(total_cost), 2) FROM project_cost), 0)
      ),
      'sessions', COALESCE((SELECT SUM(total_sessions) FROM project_meta), 0),
      'errors', COALESCE((SELECT SUM(total_errors) FROM project_meta), 0)
    )
  ) INTO result
  FROM project_result pr;

  RETURN COALESCE(result, '{"projects": {}, "facility": {"tokens": {"total": 0}, "cost": {"total": 0}, "sessions": 0, "errors": 0}}'::jsonb);
END;
$$;
```

- [ ] **Step 2: Run migration**

Execute the SQL in the Supabase SQL Editor.

- [ ] **Step 3: Test with migrated data — all projects, all time**

```sql
SELECT get_project_summary();
```

Expected: JSONB with `projects` keyed by proj_UUID, each with tokens/cost/events/sessions/errors. `facility` section has aggregate totals. Token totals should be non-zero (from migrated daily_metrics data).

- [ ] **Step 4: Test with filters — single project, date range**

```sql
SELECT get_project_summary(
  ARRAY['proj_166345da-d821-4b3a-abbc-e3a439925e85'],
  '2026-03-01'::date,
  '2026-03-30'::date
);
```

Expected: Only the platform project in `projects`. Tokens reflect March only.

- [ ] **Step 5: Test with no data — future date range**

```sql
SELECT get_project_summary(NULL, '2030-01-01'::date, '2030-12-31'::date);
```

Expected: Empty projects `{}`, facility totals all 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
git add supabase/migrations/006_rpc_get_project_summary.sql
git commit -m "feat(rpc): add get_project_summary function for tokens/cost/events"
```

---

### Task 7: RPC function — get_session_breakdown

**Files:**
- Create: `supabase/migrations/007_rpc_get_session_breakdown.sql`

- [ ] **Step 1: Write the RPC function**

```sql
-- 007_rpc_get_session_breakdown.sql
-- Per-session cost/token drill-down for a project.
-- Queries otel_requests (raw per-request data) for full granularity.

CREATE OR REPLACE FUNCTION get_session_breakdown(
  p_project_id TEXT,
  p_date_from  DATE DEFAULT CURRENT_DATE,
  p_date_to    DATE DEFAULT CURRENT_DATE
) RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'sessions', COALESCE(jsonb_agg(session_data ORDER BY started_at DESC), '[]'::jsonb)
  ) INTO result
  FROM (
    SELECT
      jsonb_build_object(
        'session_id', r.session_id,
        'parent_session_id', s.parent_session_id,
        'model', mode() WITHIN GROUP (ORDER BY r.model),
        'tokens', jsonb_build_object(
          'total', SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens),
          'input', SUM(r.input_tokens),
          'output', SUM(r.output_tokens),
          'cache_read', SUM(r.cache_read_tokens),
          'cache_write', SUM(r.cache_write_tokens)
        ),
        'cost', round(SUM(r.cost_usd), 2),
        'avg_duration_ms', round(AVG(r.duration_ms)),
        'requests', COUNT(*),
        'started_at', MIN(r.timestamp),
        'ended_at', MAX(r.timestamp),
        'duration_minutes', round(EXTRACT(EPOCH FROM (MAX(r.timestamp) - MIN(r.timestamp))) / 60)
      ) AS session_data,
      MIN(r.timestamp) AS started_at
    FROM otel_requests r
    LEFT JOIN sessions s ON r.session_id = s.id
    WHERE r.project_id = p_project_id
      AND r.timestamp >= p_date_from::timestamptz
      AND r.timestamp < (p_date_to + 1)::timestamptz
    GROUP BY r.session_id, s.parent_session_id
  ) sub;

  RETURN COALESCE(result, '{"sessions": []}'::jsonb);
END;
$$;
```

- [ ] **Step 2: Run migration**

Execute the SQL in the Supabase SQL Editor.

- [ ] **Step 3: Verify function exists**

```sql
-- No otel_requests data yet (exporter hasn't been rewired), so this returns empty.
-- We verify it runs without error and returns the correct empty shape.
SELECT get_session_breakdown('proj_166345da-d821-4b3a-abbc-e3a439925e85');
```

Expected: `{"sessions": []}` (no data in otel_requests yet — that comes with Plan 2).

- [ ] **Step 4: Commit**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
git add supabase/migrations/007_rpc_get_session_breakdown.sql
git commit -m "feat(rpc): add get_session_breakdown function for per-session drill-down"
```

---

### Task 8: RPC function — get_agent_state

**Files:**
- Create: `supabase/migrations/008_rpc_get_agent_state.sql`

- [ ] **Step 1: Write the RPC function**

```sql
-- 008_rpc_get_agent_state.sql
-- Current realtime agent status across projects.
-- Returns individual agents + aggregate summary.

CREATE OR REPLACE FUNCTION get_agent_state(
  p_project_ids TEXT[] DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  result JSONB;
BEGIN
  WITH agents AS (
    SELECT *
    FROM agent_state
    WHERE p_project_ids IS NULL OR project_id = ANY(p_project_ids)
  )
  SELECT jsonb_build_object(
    'agents', COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'session_id', a.session_id,
          'project_id', a.project_id,
          'pid', a.pid,
          'model', a.model,
          'status', a.status,
          'tokens_session', a.tokens_session,
          'cost_session', round(a.cost_session, 2),
          'parent_session_id', a.parent_session_id,
          'started_at', a.started_at,
          'updated_at', a.updated_at
        ) ORDER BY a.started_at
      ) FROM agents a),
      '[]'::jsonb
    ),
    'summary', jsonb_build_object(
      'active', (SELECT COUNT(*) FROM agents WHERE status = 'active'),
      'idle', (SELECT COUNT(*) FROM agents WHERE status = 'idle'),
      'total', (SELECT COUNT(*) FROM agents)
    )
  ) INTO result;

  RETURN result;
END;
$$;
```

- [ ] **Step 2: Run migration**

Execute the SQL in the Supabase SQL Editor.

- [ ] **Step 3: Verify function exists**

```sql
-- No agent_state rows yet (process watcher hasn't been rewired), so this returns empty.
SELECT get_agent_state();
```

Expected: `{"agents": [], "summary": {"active": 0, "idle": 0, "total": 0}}`

- [ ] **Step 4: Test with project filter**

```sql
SELECT get_agent_state(ARRAY['proj_166345da-d821-4b3a-abbc-e3a439925e85']);
```

Expected: Same empty result, filtered.

- [ ] **Step 5: Commit**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
git add supabase/migrations/008_rpc_get_agent_state.sql
git commit -m "feat(rpc): add get_agent_state function for realtime agent status"
```

---

### Task 9: End-to-end verification

**Files:** None (verification only)

- [ ] **Step 1: Verify all tables exist**

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('sessions', 'otel_requests', 'daily_rollups', 'agent_state')
ORDER BY table_name;
```

Expected: 4 rows.

- [ ] **Step 2: Verify daily_rollups has migrated data**

```sql
SELECT
  COUNT(*) AS total_rows,
  MIN(date) AS earliest,
  MAX(date) AS latest,
  COUNT(DISTINCT project_id) AS projects
FROM daily_rollups;
```

Expected: Matches daily_metrics row count, dates from Jan 15 to present, multiple projects.

- [ ] **Step 3: Verify get_project_summary returns real data**

```sql
-- All-time, all projects
SELECT jsonb_pretty(get_project_summary());
```

Expected: Non-zero token totals from migrated data. Multiple projects in the response.

- [ ] **Step 4: Verify realtime publications**

```sql
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND tablename IN ('agent_state', 'sessions')
ORDER BY tablename;
```

Expected: 2 rows (agent_state, sessions).

- [ ] **Step 5: Verify events table has session_id column**

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'events' AND column_name = 'session_id';
```

Expected: 1 row.

- [ ] **Step 6: Commit verification notes**

```bash
cd /Users/bigviking/Documents/github/projects/lo/telemetry-exporter
git add -A
git commit -m "feat(schema): complete Supabase schema migration — all tables + RPCs verified"
```
