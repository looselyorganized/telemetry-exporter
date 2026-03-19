import { Database } from "bun:sqlite";
import type { ProjectResolver } from "../project/resolver";
import type { LogEntry, ModelStats, StatsCache } from "../parsers";
import type { ProjectTokenMap } from "../project/scanner";
import { computeTokensByProject } from "../project/scanner";
import { enqueue, enqueueArchive, addKnownProject, getKnownProjectIds } from "../db/local";
import { getSupabase } from "../db/client";
import { sumValues, formatModelStats, type LifetimeCounters } from "../../bin/daemon-helpers";

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
  private lastProjectSync: string = "";
  private lastSnapshotTime: number = 0;

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
        const timestamp = entry.parsedTimestamp?.toISOString() ?? null;
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

      for (const [projId, lastActive] of latestByProject) {
        enqueue("projects", { id: projId, last_active: lastActive });
      }
    })();
  }

  /** Process token data: enqueue daily_metrics and project_telemetry updates. */
  processTokens(tokenMap: ProjectTokenMap): void {
    const today = new Date().toISOString().substring(0, 10);

    // 1. Compute lifetime totals per project
    const tokensByProject = computeTokensByProject(tokenMap);

    // 2. Check baseline diff — skip entirely if nothing changed
    let hasChanges = false;
    for (const [projId, total] of Object.entries(tokensByProject)) {
      if (this.tokenBaseline.get(projId) !== total) {
        hasChanges = true;
        break;
      }
    }
    // Also check if a project was removed from baseline
    if (!hasChanges) {
      for (const projId of this.tokenBaseline.keys()) {
        if (!(projId in tokensByProject)) {
          hasChanges = true;
          break;
        }
      }
    }
    if (!hasChanges) return;

    // 3. Compute today's tokens per project per model
    const todayTokensByProject: Record<string, { total: number; models: Record<string, number> }> = {};
    for (const [projId, dateMap] of tokenMap) {
      const todayModels = dateMap.get(today);
      if (todayModels) {
        let total = 0;
        for (const t of Object.values(todayModels)) total += t;
        todayTokensByProject[projId] = { total, models: { ...todayModels } };
      }
    }

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
    const isNewProjectSync = this.lastProjectSync !== today;

    this.db.transaction(() => {
      // 5. Enqueue daily_metrics for each project/date
      for (const [projId, dateMap] of tokenMap) {
        for (const [date, models] of dateMap) {
          // Date guard: only sync past dates on the first run of the day
          if (date !== today && !isNewDailySync) continue;

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
        enqueue("project_telemetry", {
          project_id: projId,
          tokens_lifetime: tokensByProject[projId] ?? 0,
          tokens_today: todayData.total,
          models_today: todayData.models,
          sessions_lifetime: counters.sessions,
          messages_lifetime: counters.messages,
          tool_calls_lifetime: counters.toolCalls,
          agent_spawns_lifetime: counters.agentSpawns,
          team_messages_lifetime: counters.teamMessages,
        });
      }

      // 8. Update baselines
      this.tokenBaseline = new Map(Object.entries(tokensByProject));
      this.lifetimeBaseline = new Map(Object.entries(lifetimeCounters));
      this.lastDailySync = today;
      this.lastProjectSync = today;
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
        )
        .not("project_id", "is", null);

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
        .select("project_id, sessions, messages, tool_calls, agent_spawns, team_messages")
        .not("project_id", "is", null);

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

  /** Process facility-wide metrics: enqueue facility_metrics and global daily_metrics. */
  processMetrics(statsCache: StatsCache | null, modelStats: ModelStats[]): void {
    const today = new Date().toISOString().substring(0, 10);

    // 1. Compute lifetime totals from baselines
    let tokensLifetime = 0;
    for (const total of this.tokenBaseline.values()) {
      tokensLifetime += total;
    }

    let tokensToday = 0;
    // Sum today's tokens from tokenBaseline is lifetime — we need today-only from daily.
    // Use statsCache dailyModelTokens for today's tokens
    if (statsCache?.dailyModelTokens) {
      const todayEntry = statsCache.dailyModelTokens.find((d) => d.date === today);
      if (todayEntry) {
        for (const t of Object.values(todayEntry.tokensByModel)) {
          tokensToday += t;
        }
      }
    }

    let sessionsLifetime = 0;
    let messagesLifetime = 0;
    for (const counters of this.lifetimeBaseline.values()) {
      sessionsLifetime += counters.sessions;
      messagesLifetime += counters.messages;
    }

    // 2. Build facility metrics
    const facilityPayload = {
      tokens_lifetime: tokensLifetime,
      tokens_today: tokensToday,
      sessions_lifetime: sessionsLifetime,
      messages_lifetime: messagesLifetime,
      model_stats: formatModelStats(modelStats),
      hour_distribution: statsCache?.hourCounts ?? {},
      first_session_date: statsCache?.firstSessionDate ?? null,
      updated_at: new Date().toISOString(),
    };

    // 3. Build global daily_metrics rows (project_id IS NULL)
    const globalDailyRows: Array<{
      date: string; project_id: null;
      tokens: Record<string, number>;
      sessions: number; messages: number; tool_calls: number;
    }> = [];
    if (statsCache?.dailyActivity) {
      for (const day of statsCache.dailyActivity) {
        const modelTokens = statsCache.dailyModelTokens?.find((d) => d.date === day.date);
        globalDailyRows.push({
          date: day.date,
          project_id: null,
          tokens: modelTokens?.tokensByModel ?? {},
          sessions: day.sessionCount,
          messages: day.messageCount,
          tool_calls: day.toolCallCount,
        });
      }
    }

    // 4. Hash to detect changes
    const hashInput = JSON.stringify({ facilityPayload, globalDailyRows });
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(hashInput);
    const metricsHash = hasher.digest("hex");

    if (metricsHash === this.lastMetricsHash) return;

    this.db.transaction(() => {
      // 5. Enqueue facility_metrics
      enqueue("facility_metrics", facilityPayload);

      // 6. Enqueue global daily_metrics
      for (const row of globalDailyRows) {
        enqueue("daily_metrics", row);
      }

      // 7. Update hash
      this.lastMetricsHash = metricsHash;
    })();
  }
}
