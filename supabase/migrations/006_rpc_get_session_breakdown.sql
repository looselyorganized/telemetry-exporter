-- 006_rpc_get_session_breakdown.sql
-- Per-session cost/token drill-down for a project.
-- Queries otel_api_requests (raw per-request data) for full granularity.
-- Supports timezone-aware date filtering via p_tz parameter.

CREATE OR REPLACE FUNCTION get_session_breakdown(
  p_project_id TEXT,
  p_date_from  DATE DEFAULT CURRENT_DATE,
  p_date_to    DATE DEFAULT CURRENT_DATE,
  p_tz         TEXT DEFAULT 'UTC'
) RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  result JSONB;
  tz_from TIMESTAMPTZ;
  tz_to   TIMESTAMPTZ;
BEGIN
  -- Convert date boundaries to timezone-aware timestamps
  tz_from := (p_date_from::timestamp AT TIME ZONE p_tz);
  tz_to   := ((p_date_to + 1)::timestamp AT TIME ZONE p_tz);

  SELECT jsonb_build_object(
    'sessions', COALESCE(jsonb_agg(session_data ORDER BY started_at DESC), '[]'::jsonb)
  ) INTO result
  FROM (
    SELECT
      jsonb_build_object(
        'session_id', r.session_id,
        'parent_session_id', s.parent_session_id,
        'model', COALESCE(mode() WITHIN GROUP (ORDER BY r.model), MAX(r.model)),
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
    FROM otel_api_requests r
    LEFT JOIN sessions s ON r.session_id = s.id
    WHERE r.project_id = p_project_id
      AND r.timestamp >= tz_from
      AND r.timestamp < tz_to
    GROUP BY r.session_id, s.parent_session_id
  ) sub;

  RETURN COALESCE(result, '{"sessions": []}'::jsonb);
END;
$$;
