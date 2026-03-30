-- 007_rpc_get_agent_state.sql
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
