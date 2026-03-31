-- 005_rpc_get_project_summary.sql
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
          'billable', COALESCE(pt.total_tokens - pt.total_cache_read, 0),
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
        'billable', COALESCE((SELECT SUM(total_tokens - total_cache_read) FROM project_tokens), 0),
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
