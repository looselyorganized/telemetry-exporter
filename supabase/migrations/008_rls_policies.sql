-- 008_rls_policies.sql
-- Read-only RLS for new tables.
-- Exporter writes via service_role key (bypasses RLS).
-- Platform reads via anon key (needs SELECT only).

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON sessions FOR SELECT USING (true);

ALTER TABLE daily_rollups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON daily_rollups FOR SELECT USING (true);

ALTER TABLE agent_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON agent_state FOR SELECT USING (true);
