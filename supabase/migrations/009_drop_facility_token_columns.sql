-- 009_drop_facility_token_columns.sql
-- Remove dead token/metric columns from facility_status.
-- These were never written by the daemon — all zeros.
-- Token data lives in daily_rollups, queried via get_project_summary() RPC.

ALTER TABLE facility_status
  DROP COLUMN IF EXISTS tokens_lifetime,
  DROP COLUMN IF EXISTS tokens_today,
  DROP COLUMN IF EXISTS sessions_lifetime,
  DROP COLUMN IF EXISTS messages_lifetime,
  DROP COLUMN IF EXISTS model_stats,
  DROP COLUMN IF EXISTS hour_distribution,
  DROP COLUMN IF EXISTS first_session_date,
  DROP COLUMN IF EXISTS agents_by_project,
  DROP COLUMN IF EXISTS tokens_by_project;
