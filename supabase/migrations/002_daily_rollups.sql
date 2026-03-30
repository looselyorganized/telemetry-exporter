-- 002_daily_rollups.sql
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
