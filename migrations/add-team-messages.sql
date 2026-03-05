-- Add team_messages column to daily_metrics
ALTER TABLE daily_metrics
  ADD COLUMN IF NOT EXISTS team_messages integer NOT NULL DEFAULT 0;

-- Add team_messages_lifetime column to project_telemetry
ALTER TABLE project_telemetry
  ADD COLUMN IF NOT EXISTS team_messages_lifetime integer NOT NULL DEFAULT 0;
