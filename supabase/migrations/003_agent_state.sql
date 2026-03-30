-- 003_agent_state.sql
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
