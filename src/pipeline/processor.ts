import { Database } from "bun:sqlite";
import type { ProjectResolver } from "../project/resolver";
import type { LogEntry, ModelStats, StatsCache } from "../parsers";
import type { ProjectTokenMap } from "../project/scanner";
import { computeTokensByProject } from "../project/scanner";
import { enqueue, enqueueArchive, addKnownProject, getKnownProjectIds, upsertCostTracking, getCostByProject } from "../db/local";
import type { OtelEventBatch } from "./otel-receiver";
import { getSupabase } from "../db/client";
import { formatModelStats, type LifetimeCounters } from "../../bin/daemon-helpers";

// ─── Tool name → event type classification ──────────────────────────────────
// Maps OTel tool_name to the same event types the JSONL emoji pipeline uses.
// Must stay in sync with EMOJI_TYPE_MAP in parsers.ts.

function classifyToolName(toolName: string): string {
  const name = toolName.toLowerCase();

  // Read tools
  if (name === "read" || name === "cat") return "read";

  // Search tools
  if (name === "grep" || name === "glob" || name === "search") return "search";

  // Fetch tools
  if (name === "webfetch" || name === "websearch" || name === "fetch") return "fetch";

  // MCP tools (prefixed with mcp__)
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) return "mcp";

  // Skills
  if (name === "skill") return "skill";

  // Agent tools
  if (name === "agent") return "agent_spawn";
  if (name === "sendmessage") return "message";

  // Task tools
  if (name === "taskcreate" || name === "taskupdate" || name === "taskget" || name === "tasklist" || name === "taskstop" || name === "taskoutput") return "task";

  // Plan tools
  if (name === "enterplanmode" || name === "exitplanmode") return "plan";

  // Tool search
  if (name === "toolsearch") return "tool";

  // Write/Edit tools — still "tool" (these are the core coding tools)
  if (name === "write" || name === "edit" || name === "bash" || name === "notebookedit") return "tool";

  // Default
  return "tool";
}

// ─── SQL aggregation result shape ────────────────────────────────────────────

interface EventAggRow {
  project_id: string;
  event_type: string;
  date: string;
  count: number;
}

export class Processor {
  private resolver: ProjectResolver;
  private db: Database;
  private knownProjects: Set<string>;
  private tokenBaseline: Map<string, number> = new Map();
  private lifetimeBaseline: Map<string, LifetimeCounters> = new Map();
  private lastMetricsHash: string = "";
  private lastDailySync: string = "";
  private lastSnapshotTime: number = 0;
  private todayTokensTotal: number = 0;
  private lastDailyPayloads: Map<string, string> = new Map();
  private lastTelemetryPayloads: Map<string, string> = new Map();
  /** Track (projId, date) pairs that have OTel data — prevents JSONL format ping-pong. */
  private otelCoveredPairs: Set<string> = new Set();
  /** Track fired budget alerts per (projId, date, threshold) to prevent re-firing. */
  private firedAlerts: Set<string> = new Set();
  private static BUDGET_THRESHOLDS = [5, 10, 25];

  constructor(resolver: ProjectResolver, db: Database) {
    this.resolver = resolver;
    this.db = db;
    this.knownProjects = new Set<string>();
  }

  /** Load known_projects from SQLite into in-memory Set. */
  loadKnownProjects(): void {
    const ids = getKnownProjectIds();
    for (const id of ids) {
      this.knownProjects.add(id);
    }
  }

  /** Process log entries: filter, register projects, enqueue events + archive. */
  processEvents(entries: LogEntry[]): void {
    this.db.transaction(() => {
      // Step 1: Resolve all entries — skip those that don't resolve
      const resolved: Array<{ entry: LogEntry; projId: string; slug: string }> = [];
      for (const entry of entries) {
        if (!entry.project) continue;
        const result = this.resolver.resolve(entry.project);
        if (result === null) continue;
        resolved.push({ entry, projId: result.projId, slug: result.slug });
      }

      // Step 2: Register unknown projects
      for (const { projId, slug } of resolved) {
        if (!this.knownProjects.has(projId)) {
          enqueue("projects", { id: projId, slug });
          addKnownProject(projId, slug);
          this.knownProjects.add(projId);
        }
      }

      // Step 3: Enqueue each event
      for (const { entry, projId } of resolved) {
        const timestamp = entry.parsedTimestamp?.toISOString() ?? new Date().toISOString();
        const eventPayload = {
          project_id: projId,
          event_type: entry.eventType,
          event_text: entry.eventText,
          timestamp,
          branch: entry.branch,
          emoji: entry.emoji,
        };
        enqueue("events", eventPayload);

        // Step 5: Archive each event with a content hash
        const hashInput = `${projId}\0${entry.eventType}\0${entry.eventText}\0${timestamp ?? ""}`;
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(hashInput);
        const contentHash = hasher.digest("hex");
        enqueueArchive("event", JSON.stringify(eventPayload), contentHash);
      }

      // Step 4: Enqueue project activity updates (one per project, using latest timestamp)
      const latestByProject = new Map<string, string>();
      for (const { entry, projId } of resolved) {
        if (entry.parsedTimestamp === null) continue;
        const ts = entry.parsedTimestamp.toISOString();
        const existing = latestByProject.get(projId);
        if (!existing || ts > existing) {
          latestByProject.set(projId, ts);
        }
      }

      // Build slug lookup from resolved entries
      const slugByProject = new Map<string, string>();
      for (const { projId, slug } of resolved) {
        slugByProject.set(projId, slug);
      }

      for (const [projId, lastActive] of latestByProject) {
        enqueue("projects", { id: projId, slug: slugByProject.get(projId), last_active: lastActive });
      }
    })();
  }

  /** Process token data: enqueue daily_metrics and project_telemetry updates. */
  processTokens(tokenMap: ProjectTokenMap): void {
    const today = new Date().toISOString().substring(0, 10);

    // 1. Compute lifetime totals per project
    const tokensByProject = computeTokensByProject(tokenMap);

    // 2. Compute today's tokens unconditionally (used by processMetrics)
    let todayTotal = 0;
    const todayTokensByProject: Record<string, { total: number; models: Record<string, number> }> = {};
    for (const [projId, dateMap] of tokenMap) {
      const todayModels = dateMap.get(today);
      if (todayModels) {
        let total = 0;
        for (const t of Object.values(todayModels)) total += t;
        todayTokensByProject[projId] = { total, models: { ...todayModels } };
        todayTotal += total;
      }
    }
    this.todayTokensTotal = todayTotal;

    // 3. Check baseline diff — skip enqueuing if nothing changed
    let hasChanges = false;
    for (const [projId, total] of Object.entries(tokensByProject)) {
      if (this.tokenBaseline.get(projId) !== total) {
        hasChanges = true;
        break;
      }
    }
    if (!hasChanges) {
      for (const projId of this.tokenBaseline.keys()) {
        if (!(projId in tokensByProject)) {
          hasChanges = true;
          break;
        }
      }
    }
    if (!hasChanges) return;

    // 4. Query event aggregation from outbox SQL
    const eventAggRows = this.db
      .query<EventAggRow, []>(
        `SELECT
          json_extract(payload, '$.project_id') as project_id,
          json_extract(payload, '$.event_type') as event_type,
          substr(json_extract(payload, '$.timestamp'), 1, 10) as date,
          COUNT(*) as count
        FROM outbox
        WHERE target = 'events'
          AND created_at > date('now', '-31 days')
        GROUP BY project_id, event_type, date`
      )
      .all();

    // Build event counts map: projId -> date -> { sessions, messages, tool_calls, agent_spawns, team_messages }
    const eventCounts = new Map<string, Map<string, {
      sessions: number; messages: number; tool_calls: number; agent_spawns: number; team_messages: number;
    }>>();
    for (const row of eventAggRows) {
      if (!row.project_id || !row.date) continue;
      let dateMap = eventCounts.get(row.project_id);
      if (!dateMap) {
        dateMap = new Map();
        eventCounts.set(row.project_id, dateMap);
      }
      let counts = dateMap.get(row.date);
      if (!counts) {
        counts = { sessions: 0, messages: 0, tool_calls: 0, agent_spawns: 0, team_messages: 0 };
        dateMap.set(row.date, counts);
      }
      switch (row.event_type) {
        case "session_start":   counts.sessions += row.count; break;
        case "response_finish": counts.messages += row.count; break;
        case "tool":            counts.tool_calls += row.count; break;
        case "agent_spawn":     counts.agent_spawns += row.count; break;
        case "message":         counts.team_messages += row.count; break;
      }
    }

    // Determine if this is a fresh daily sync (date guard)
    const isNewDailySync = this.lastDailySync !== today;

    this.db.transaction(() => {
      // 5. Enqueue daily_metrics for each project/date
      for (const [projId, dateMap] of tokenMap) {
        for (const [date, models] of dateMap) {
          // Date guard: only sync past dates on the first run of the day
          if (date !== today && !isNewDailySync) continue;

          // Skip JSONL writes for pairs that have OTel data (prevents format ping-pong)
          if (this.otelCoveredPairs.has(`${projId}\0${date}`)) continue;

          const evCounts = eventCounts.get(projId)?.get(date);
          const payload = {
            date,
            project_id: projId,
            tokens: { ...models },
            sessions: evCounts?.sessions ?? 0,
            messages: evCounts?.messages ?? 0,
            tool_calls: evCounts?.tool_calls ?? 0,
            agent_spawns: evCounts?.agent_spawns ?? 0,
            team_messages: evCounts?.team_messages ?? 0,
          };

          // Skip if payload is identical to what was last enqueued for this (project, date)
          const dailyJson = JSON.stringify(payload);
          const dailyKey = `${projId}\0${date}`;
          if (this.lastDailyPayloads.get(dailyKey) === dailyJson) continue;
          this.lastDailyPayloads.set(dailyKey, dailyJson);

          enqueue("daily_metrics", payload);

          // Archive with content hash
          const hashInput = `${projId}\0${date}`;
          const hasher = new Bun.CryptoHasher("sha256");
          hasher.update(hashInput);
          const contentHash = hasher.digest("hex");
          enqueueArchive("daily_metrics", JSON.stringify(payload), contentHash);
        }
      }

      // 6. Compute lifetime event counters per project from event aggregation
      const lifetimeCounters: Record<string, LifetimeCounters> = {};
      for (const [projId, dateMap] of eventCounts) {
        const counters: LifetimeCounters = {
          sessions: 0, messages: 0, toolCalls: 0, agentSpawns: 0, teamMessages: 0,
        };
        for (const [, counts] of dateMap) {
          counters.sessions += counts.sessions;
          counters.messages += counts.messages;
          counters.toolCalls += counts.tool_calls;
          counters.agentSpawns += counts.agent_spawns;
          counters.teamMessages += counts.team_messages;
        }
        lifetimeCounters[projId] = counters;
      }

      // 7. Enqueue project_telemetry for each project with changes
      const allProjIds = new Set([
        ...Object.keys(tokensByProject),
        ...Object.keys(lifetimeCounters),
        ...Object.keys(todayTokensByProject),
      ]);

      for (const projId of allProjIds) {
        const todayData = todayTokensByProject[projId] ?? { total: 0, models: {} };
        const counters = lifetimeCounters[projId] ?? {
          sessions: 0, messages: 0, toolCalls: 0, agentSpawns: 0, teamMessages: 0,
        };
        const telemetryPayload = {
          project_id: projId,
          tokens_lifetime: tokensByProject[projId] ?? 0,
          tokens_today: todayData.total,
          models_today: todayData.models,
          sessions_lifetime: counters.sessions,
          messages_lifetime: counters.messages,
          tool_calls_lifetime: counters.toolCalls,
          agent_spawns_lifetime: counters.agentSpawns,
          team_messages_lifetime: counters.teamMessages,
        };

        // Skip if payload is identical to what was last enqueued for this project
        const telemetryJson = JSON.stringify(telemetryPayload);
        if (this.lastTelemetryPayloads.get(projId) === telemetryJson) continue;
        this.lastTelemetryPayloads.set(projId, telemetryJson);

        enqueue("project_telemetry", telemetryPayload);
      }

      // 8. Update baselines
      this.tokenBaseline = new Map(Object.entries(tokensByProject));
      this.lifetimeBaseline = new Map(Object.entries(lifetimeCounters));
      this.lastDailySync = today;
    })();
  }

  /**
   * Process a batch of OTel events: update cost_tracking, enqueue daily_metrics
   * with per-type token breakdown, and enqueue tool_result events.
   */
  processOtelBatch(batch: OtelEventBatch): void {
    if (batch.apiRequests.length === 0 && batch.toolResults.length === 0) return;

    const today = new Date().toISOString().substring(0, 10);

    this.db.transaction(() => {
      // 1. Process api_request events → cost_tracking + daily_metrics
      // Aggregate by (projId, date, model) within this batch
      const aggregated = new Map<string, {
        projId: string;
        date: string;
        model: string;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        count: number;
      }>();

      for (const req of batch.apiRequests) {
        const date = req.timestamp.substring(0, 10);

        // Ship raw per-request event to Supabase (proj_id already resolved)
        enqueue("otel_api_requests", {
          project_id: req.projId,
          session_id: req.sessionId,
          model: req.model,
          input_tokens: req.inputTokens,
          output_tokens: req.outputTokens,
          cache_read_tokens: req.cacheReadTokens,
          cache_write_tokens: req.cacheWriteTokens,
          cost_usd: req.costUsd,
          duration_ms: req.durationMs,
          timestamp: req.timestamp,
        });

        // Upsert cost_tracking (per-request granularity)
        upsertCostTracking(req.projId, date, req.model, {
          input: req.inputTokens,
          output: req.outputTokens,
          cache_read: req.cacheReadTokens,
          cache_write: req.cacheWriteTokens,
        }, req.costUsd);

        // Mark this pair as OTel-covered (prevents JSONL format ping-pong)
        this.otelCoveredPairs.add(`${req.projId}\0${date}`);

        // Aggregate for daily_metrics enqueue
        const key = `${req.projId}\0${date}\0${req.model}`;
        let agg = aggregated.get(key);
        if (!agg) {
          agg = { projId: req.projId, date, model: req.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, count: 0 };
          aggregated.set(key, agg);
        }
        agg.input += req.inputTokens;
        agg.output += req.outputTokens;
        agg.cacheRead += req.cacheReadTokens;
        agg.cacheWrite += req.cacheWriteTokens;
        agg.cost += req.costUsd;
        agg.count++;
      }

      // Query cost_tracking once per affected project — reused for daily_metrics and project_telemetry
      const affectedProjects = new Set<string>();
      for (const req of batch.apiRequests) {
        affectedProjects.add(req.projId);
      }

      const costByProject = new Map<string, import("../db/local").CostTrackingRow[]>();
      for (const projId of affectedProjects) {
        costByProject.set(projId, getCostByProject(projId));
      }

      // Build daily_metrics payloads grouped by (projId, date)
      const dailyGroups = new Map<string, {
        projId: string;
        date: string;
        models: Record<string, { input: number; cache_read: number; cache_write: number; output: number }>;
      }>();

      for (const agg of aggregated.values()) {
        const groupKey = `${agg.projId}\0${agg.date}`;
        let group = dailyGroups.get(groupKey);
        if (!group) {
          group = { projId: agg.projId, date: agg.date, models: {} };
          dailyGroups.set(groupKey, group);
        }

        // Read current totals from cost_tracking (cached query)
        const costRow = costByProject.get(agg.projId)?.find(r => r.date === agg.date && r.model === agg.model);
        if (costRow) {
          group.models[agg.model] = {
            input: costRow.input_tokens,
            cache_read: costRow.cache_read_tokens,
            cache_write: costRow.cache_write_tokens,
            output: costRow.output_tokens,
          };
        } else {
          group.models[agg.model] = {
            input: agg.input,
            cache_read: agg.cacheRead,
            cache_write: agg.cacheWrite,
            output: agg.output,
          };
        }
      }

      // Enqueue daily_metrics with new JSONB format
      for (const group of dailyGroups.values()) {
        const payload = {
          date: group.date,
          project_id: group.projId,
          tokens: group.models,
        };

        // Per-payload dedup
        const dailyJson = JSON.stringify(payload);
        const dailyKey = `${group.projId}\0${group.date}`;
        if (this.lastDailyPayloads.get(dailyKey) === dailyJson) continue;
        this.lastDailyPayloads.set(dailyKey, dailyJson);

        enqueue("daily_metrics", payload);
      }

      // Enqueue project_telemetry with accumulated cost_tracking totals (reusing cached query)
      for (const projId of affectedProjects) {
        const costRows = costByProject.get(projId) ?? [];
        let tokensLifetime = 0;
        let costLifetime = 0;
        const todayModels: Record<string, { input: number; cache_read: number; cache_write: number; output: number }> = {};
        let todayTotal = 0;

        for (const row of costRows) {
          const rowTotal = row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens;
          tokensLifetime += rowTotal;
          costLifetime += row.cost_usd;

          if (row.date === today) {
            todayModels[row.model] = {
              input: row.input_tokens,
              cache_read: row.cache_read_tokens,
              cache_write: row.cache_write_tokens,
              output: row.output_tokens,
            };
            todayTotal += rowTotal;
          }
        }

        const telemetryPayload = {
          project_id: projId,
          tokens_lifetime: tokensLifetime,
          tokens_today: todayTotal,
          models_today: todayModels,
          cost_lifetime: costLifetime,
        };

        // Per-payload dedup
        const telemetryJson = JSON.stringify(telemetryPayload);
        if (this.lastTelemetryPayloads.get(projId) === telemetryJson) continue;
        this.lastTelemetryPayloads.set(projId, telemetryJson);

        enqueue("project_telemetry", telemetryPayload);
      }

      // 2. Process tool_result events → events target
      // Classify by tool_name to match JSONL emoji-based types
      for (const tool of batch.toolResults) {
        enqueue("events", {
          project_id: tool.projId,
          event_type: classifyToolName(tool.toolName),
          event_text: `${tool.toolName} (${tool.success ? "success" : "failure"}, ${tool.durationMs}ms)`,
          timestamp: tool.timestamp,
        });
      }

      // 3. Budget threshold alerts
      for (const projId of affectedProjects) {
        const costRows = costByProject.get(projId) ?? [];
        let todayCost = 0;
        for (const row of costRows) {
          if (row.date === today) todayCost += row.cost_usd;
        }

        for (const threshold of Processor.BUDGET_THRESHOLDS) {
          const alertKey = `${projId}\0${today}\0${threshold}`;
          if (todayCost >= threshold && !this.firedAlerts.has(alertKey)) {
            enqueue("alerts", {
              project_id: projId,
              alert_type: "budget_threshold",
              threshold_usd: threshold,
              current_usd: Math.round(todayCost * 100) / 100,
              date: today,
            });
            this.firedAlerts.add(alertKey);
          }
        }
      }
    })();
  }

  /** Startup initialization: load known_projects and hydrate baselines from Supabase. */
  async hydrate(): Promise<void> {
    this.loadKnownProjects();
    await this._loadBaselinesFromSupabase();
  }

  /**
   * Snapshot facility state to the archive_queue.
   * Throttled to once per 5 minutes, but always fires on hour boundary.
   */
  snapshotFacilityState(facilityState: { status: string; activeAgents: number; activeProjects: any[] }): void {
    const now = Date.now();
    const isHourBoundary = new Date().getMinutes() < 1;
    const elapsed = now - this.lastSnapshotTime;

    if (!isHourBoundary && elapsed < 5 * 60 * 1000) {
      return;
    }

    // Round to nearest 5 minutes for content hash stability
    const roundedTimestamp = Math.round(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
    const hashInput = `snapshot\0${roundedTimestamp}`;
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(hashInput);
    const contentHash = hasher.digest("hex");

    enqueueArchive("state_snapshot", JSON.stringify(facilityState), contentHash);
    this.lastSnapshotTime = now;
  }

  /**
   * Compose processEvents + processTokens + processMetrics in one call.
   * Skips processEvents when entries array is empty.
   */
  processGapEntries(
    entries: LogEntry[],
    tokenMap: ProjectTokenMap,
    statsCache: StatsCache | null,
    modelStats: ModelStats[]
  ): void {
    if (entries.length > 0) this.processEvents(entries);
    this.processTokens(tokenMap);
    this.processMetrics(statsCache, modelStats);
  }

  /**
   * Return the current facility metrics snapshot for direct Supabase push
   * at startup. Returns null if processTokens hasn't been called yet.
   */
  getStartupMetrics(): { tokens_today: number; tokens_lifetime: number; updated_at: string } | null {
    let tokensLifetime = 0;
    for (const total of this.tokenBaseline.values()) {
      tokensLifetime += total;
    }
    return {
      tokens_today: this.todayTokensTotal,
      tokens_lifetime: tokensLifetime,
      updated_at: new Date().toISOString(),
    };
  }

  /** Refresh token and lifetime baselines from Supabase. */
  async refreshBaselines(): Promise<void> {
    await this._loadBaselinesFromSupabase();
  }

  /** Trigger a resolver refresh (rebuilds dir→projId maps from disk). */
  async refreshResolver(): Promise<void> {
    await this.resolver.refresh();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Shared implementation for hydrate() and refreshBaselines(). */
  private async _loadBaselinesFromSupabase(): Promise<void> {
    try {
      const supabase = getSupabase();

      // 1. Load token / lifetime baselines from project_telemetry
      const { data: telemetryRows, error: telemetryError } = await supabase
        .from("project_telemetry")
        .select(
          "project_id, tokens_lifetime, sessions_lifetime, messages_lifetime, tool_calls_lifetime, agent_spawns_lifetime, team_messages_lifetime"
        );

      if (telemetryError || !telemetryRows) {
        console.warn("[processor] hydrate: Supabase project_telemetry query failed — using zero baselines");
        return;
      }

      for (const row of telemetryRows) {
        if (!row.project_id) continue;
        this.tokenBaseline.set(row.project_id, row.tokens_lifetime ?? 0);
      }

      // 2. Load lifetime event counters from daily_metrics
      const { data: dailyRows, error: dailyError } = await supabase
        .from("daily_metrics")
        .select("project_id, sessions, messages, tool_calls, agent_spawns, team_messages");

      if (dailyError || !dailyRows) {
        // Non-fatal: token baselines loaded, lifetime counters default to zero
        console.warn("[processor] hydrate: Supabase daily_metrics query failed — lifetime counters will be zero");
        return;
      }

      // Sum per project across all daily_metrics rows
      const lifetimeSums = new Map<string, LifetimeCounters>();
      for (const row of dailyRows) {
        if (!row.project_id) continue;
        let counters = lifetimeSums.get(row.project_id);
        if (!counters) {
          counters = { sessions: 0, messages: 0, toolCalls: 0, agentSpawns: 0, teamMessages: 0 };
          lifetimeSums.set(row.project_id, counters);
        }
        counters.sessions += row.sessions ?? 0;
        counters.messages += row.messages ?? 0;
        counters.toolCalls += row.tool_calls ?? 0;
        counters.agentSpawns += row.agent_spawns ?? 0;
        counters.teamMessages += row.team_messages ?? 0;
      }

      this.lifetimeBaseline = lifetimeSums;
    } catch (err) {
      console.warn("[processor] hydrate: unexpected error —", err);
    }
  }

  /** Process facility-wide metrics: enqueue facility_metrics. */
  processMetrics(statsCache: StatsCache | null, modelStats: ModelStats[]): void {
    // 1. Compute lifetime totals from baselines
    let tokensLifetime = 0;
    for (const total of this.tokenBaseline.values()) {
      tokensLifetime += total;
    }

    let sessionsLifetime = 0;
    let messagesLifetime = 0;
    for (const counters of this.lifetimeBaseline.values()) {
      sessionsLifetime += counters.sessions;
      messagesLifetime += counters.messages;
    }

    // 2. Build facility metrics (tokens_today from tokenMap via processTokens)
    const facilityPayload = {
      tokens_lifetime: tokensLifetime,
      tokens_today: this.todayTokensTotal,
      sessions_lifetime: sessionsLifetime,
      messages_lifetime: messagesLifetime,
      model_stats: formatModelStats(modelStats),
      hour_distribution: statsCache?.hourCounts ?? {},
      first_session_date: statsCache?.firstSessionDate ?? null,
      updated_at: "", // placeholder — set after hash check
    };

    // 3. Hash to detect changes (exclude updated_at which changes every call)
    const { updated_at: _, ...hashable } = facilityPayload;
    const hashInput = JSON.stringify(hashable);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(hashInput);
    const metricsHash = hasher.digest("hex");

    if (metricsHash === this.lastMetricsHash) return;

    facilityPayload.updated_at = new Date().toISOString();

    this.db.transaction(() => {
      enqueue("facility_metrics", facilityPayload);
      this.lastMetricsHash = metricsHash;
    })();
  }
}
