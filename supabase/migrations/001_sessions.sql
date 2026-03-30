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
