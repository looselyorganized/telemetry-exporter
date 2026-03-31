import { Database } from "bun:sqlite";
import type { ProjectResolver } from "../project/resolver";
import type { LogEntry } from "../parsers";
import { enqueue, enqueueArchive, addKnownProject, getKnownProjectIds } from "../db/local";
import { getSupabase } from "../db/client";
import type { OtelEventBatch } from "./otel-receiver";

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

export class Processor {
  private resolver: ProjectResolver;
  private db: Database;
  private knownProjects: Set<string>;
  private lastDailyPayloads: Map<string, string> = new Map();
  /** Accumulate daily rollup data across processOtelBatch and processEvents. */
  private pendingRollups = new Map<string, {
    project_id: string;
    date: string;
    tokens: Record<string, { input: number; cache_read: number; cache_write: number; output: number }>;
    cost: Record<string, number>;
    events: Record<string, number>;
    sessions: number;
    errors: number;
  }>();
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

      // Step 6: Accumulate event counts into daily rollups
      for (const { entry, projId } of resolved) {
        const timestamp = entry.parsedTimestamp?.toISOString() ?? new Date().toISOString();
        const date = timestamp.substring(0, 10);
        const rollup = this.getRollup(projId, date);
        rollup.events[entry.eventType] = (rollup.events[entry.eventType] ?? 0) + 1;
      }
    })();
  }

  /**
   * Process a batch of OTel events: enqueue raw per-request data,
   * accumulate tokens/cost into pendingRollups, process tool_decision
   * rejects and api_errors into events table.
   */
  processOtelBatch(batch: OtelEventBatch): void {
    if (batch.apiRequests.length === 0 && batch.toolResults.length === 0
        && batch.toolDecisionRejects.length === 0 && batch.apiErrors.length === 0) return;

    const today = new Date().toISOString().substring(0, 10);

    this.db.transaction(() => {
      // 1. Ship raw per-request data + accumulate into daily rollups

      for (const req of batch.apiRequests) {
        const date = req.timestamp.substring(0, 10);

        // Ship raw per-request to Supabase
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

        // Accumulate into daily rollups
        const rollup = this.getRollup(req.projId, date);
        if (!rollup.tokens[req.model]) {
          rollup.tokens[req.model] = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
        }
        rollup.tokens[req.model].input += req.inputTokens;
        rollup.tokens[req.model].output += req.outputTokens;
        rollup.tokens[req.model].cache_read += req.cacheReadTokens;
        rollup.tokens[req.model].cache_write += req.cacheWriteTokens;

        rollup.cost[req.model] = (rollup.cost[req.model] ?? 0) + req.costUsd;
      }

      // 2. Accumulate tool_result counts into daily rollups (not individual events — events.log covers that)
      for (const tool of batch.toolResults) {
        const date = tool.timestamp.substring(0, 10);
        const rollup = this.getRollup(tool.projId, date);
        const toolType = classifyToolName(tool.toolName);
        rollup.events[toolType] = (rollup.events[toolType] ?? 0) + 1;
      }

      // 3. Enqueue tool_decision rejects as individual events (for attention alerts)
      for (const reject of batch.toolDecisionRejects) {
        enqueue("events", {
          project_id: reject.projId,
          session_id: reject.sessionId,
          event_type: "tool_decision_reject",
          event_text: `🔐 ${reject.toolName} rejected`,
          timestamp: reject.timestamp,
        });
      }

      // 4. Enqueue api_errors as individual events + accumulate error count
      for (const err of batch.apiErrors) {
        const date = err.timestamp.substring(0, 10);
        const rollup = this.getRollup(err.projId, date);
        rollup.errors += 1;

        enqueue("events", {
          project_id: err.projId,
          session_id: err.sessionId,
          event_type: "api_error",
          event_text: `⚠️ ${err.statusCode} ${err.error} (${err.model})`,
          timestamp: err.timestamp,
        });
      }

      // 5. Budget threshold alerts — use cumulative rollup cost (not per-batch)
      const affectedProjects = new Set(batch.apiRequests.map(r => r.projId));
      for (const projId of affectedProjects) {
        const rollup = this.pendingRollups.get(`${projId}\0${today}`);
        if (!rollup) continue;
        const dailyCost = Object.values(rollup.cost).reduce((a, b) => a + b, 0);
        for (const threshold of Processor.BUDGET_THRESHOLDS) {
          const alertKey = `${projId}\0${today}\0${threshold}`;
          if (dailyCost >= threshold && !this.firedAlerts.has(alertKey)) {
            enqueue("alerts", {
              project_id: projId,
              alert_type: "budget_threshold",
              threshold_usd: threshold,
              current_usd: Math.round(dailyCost * 100) / 100,
              date: today,
            });
            this.firedAlerts.add(alertKey);
          }
        }
      }
    })();
  }

  /** Startup initialization: load known_projects from SQLite. */
  async hydrate(): Promise<void> {
    this.loadKnownProjects();
  }

  /**
   * Reconcile daily_rollups with otel_api_requests on startup.
   * Ensures token/cost aggregates match the raw per-request data.
   * Only updates tokens and cost columns — never touches events.
   */
  async reconcileRollups(): Promise<number> {
    const supabase = getSupabase();

    const { data: otelRows, error: otelError } = await supabase
      .from("otel_api_requests")
      .select("project_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd");

    if (otelError || !otelRows) return 0;

    // Aggregate by (project_id, date, model)
    const agg = new Map<string, {
      project_id: string;
      date: string;
      tokens: Record<string, { input: number; output: number; cache_read: number; cache_write: number }>;
      cost: Record<string, number>;
    }>();

    for (const row of otelRows) {
      const date = (row.timestamp as string).substring(0, 10);
      const key = `${row.project_id}\0${date}`;
      let entry = agg.get(key);
      if (!entry) {
        entry = { project_id: row.project_id as string, date, tokens: {}, cost: {} };
        agg.set(key, entry);
      }
      const model = row.model as string;
      if (!entry.tokens[model]) {
        entry.tokens[model] = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      }
      entry.tokens[model].input += Number(row.input_tokens) || 0;
      entry.tokens[model].output += Number(row.output_tokens) || 0;
      entry.tokens[model].cache_read += Number(row.cache_read_tokens) || 0;
      entry.tokens[model].cache_write += Number(row.cache_write_tokens) || 0;
      entry.cost[model] = (entry.cost[model] ?? 0) + (Number(row.cost_usd) || 0);
    }

    // Update daily_rollups tokens + cost only (never touch events)
    let updated = 0;
    for (const entry of agg.values()) {
      const { error } = await supabase
        .from("daily_rollups")
        .update({ tokens: entry.tokens, cost: entry.cost })
        .eq("project_id", entry.project_id)
        .eq("date", entry.date);

      if (!error) updated++;
    }

    return updated;
  }

  /** Trigger a resolver refresh (rebuilds dir→projId maps from disk). */
  async refreshResolver(): Promise<void> {
    await this.resolver.refresh();
  }

  /** Flush accumulated daily rollups to the outbox. Call once per pipeline cycle. */
  flushRollups(): void {
    for (const [key, rollup] of this.pendingRollups) {
      const json = JSON.stringify(rollup);
      if (this.lastDailyPayloads.get(key) === json) continue;
      this.lastDailyPayloads.set(key, json);
      enqueue("daily_rollups", rollup);
    }
    this.pendingRollups.clear();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Get or create a pending rollup entry for a (project, date) pair. */
  private getRollup(projId: string, date: string) {
    const key = `${projId}\0${date}`;
    let rollup = this.pendingRollups.get(key);
    if (!rollup) {
      rollup = { project_id: projId, date, tokens: {}, cost: {}, events: {}, sessions: 0, errors: 0 };
      this.pendingRollups.set(key, rollup);
    }
    return rollup;
  }

}
