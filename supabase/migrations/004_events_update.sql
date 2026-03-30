-- 004_events_update.sql
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
