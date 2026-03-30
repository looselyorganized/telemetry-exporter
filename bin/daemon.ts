#!/usr/bin/env bun
/**
 * LO Telemetry Exporter — Always-On Service
 *
 * Wires pipeline stages (receivers -> processor -> shipper) together.
 * Contains NO business logic — no caches, no aggregation, no project resolution.
 *
 * Three subsystems:
 *   1. OTLP Receiver (HTTP) — accepts OTel events on 127.0.0.1:4318
 *   2. Process Watcher (250ms) — detects Claude lifecycle, pushes direct to Supabase
 *   3. Pipeline (5s) — collect -> process -> ship via SQLite outbox
 *
 * The daemon is always on. It does not know or care about facility status
 * (active/dormant). That's a UI signal for Next.js, not an operational control.
 * launchd owns the lifecycle — starts on boot, restarts on crash.
 */

import { LOG_FILE, readStatsCache, readModelStats } from "../src/parsers";
import { initSupabase, getSupabase } from "../src/db/client";
import { setFacilitySwitch } from "../src/db/facility";
import { pushAgentState } from "../src/db/agent-state";
import { ProcessWatcher } from "../src/process/watcher";
import { getFacilityState } from "../src/process/scanner";
import { ProjectResolver } from "../src/project/resolver";
import { reportError, clearErrors } from "../src/errors";
import { flushErrors, pruneResolved, clearErrorsTable } from "../src/db/errors";
import { PID_FILE, isProcessRunning } from "../src/cli-output";
import { initLocal, getLocal, closeLocal, purgeFailed, pruneProcessedOtelEvents, expireStaleOtelEvents, otelEventsReceivedSince, otelActiveSessionCount, otelQueueDepth } from "../src/db/local";
import { startOtlpServer, stopOtlpServer, pruneRateLimits } from "../src/otel/server";
import { buildSessionRegistry, refreshRegistry } from "../src/otel/session-registry";
import { OtelReceiver } from "../src/pipeline/otel-receiver";
import { LogReceiver, TokenReceiver, MetricsReceiver } from "../src/pipeline/receivers";
import { Processor } from "../src/pipeline/processor";
import { Shipper } from "../src/pipeline/shipper";
import { pruneOldEvents } from "../src/db/events";
import { deleteProjectDailyMetrics } from "../src/db/metrics";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

// ─── Config ────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const IS_BACKFILL = process.argv.includes("--backfill");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  console.error("Copy .env.example to .env and fill in your credentials.");
  process.exit(1);
}

// ─── Single-instance guard (PID file, atomic creation) ──────────────────────
function removePidFile(): void { try { unlinkSync(PID_FILE); } catch {} }

try {
  writeFileSync(PID_FILE, String(process.pid), { flag: "wx" });
} catch {
  if (existsSync(PID_FILE)) {
    const existingPid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(existingPid) && isProcessRunning(existingPid) && existingPid !== process.pid) {
      console.error(`Another exporter is already running (PID ${existingPid}).`);
      console.error(`If this is stale, remove ${PID_FILE} and retry.`);
      process.exit(1);
    }
  }
  writeFileSync(PID_FILE, String(process.pid));
}

// ─── Signal handlers ────────────────────────────────────────────────────────
function shutdown(): void {
  try { stopOtlpServer(); } catch {} // 1. Stop accepting new OTLP connections
  try { void flushErrors(); } catch {}
  try { closeLocal(); } catch {}     // 2. Close SQLite after OTLP server is stopped
  removePidFile();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", removePidFile);

// ─── Init ───────────────────────────────────────────────────────────────────
console.log("LO Telemetry Exporter starting...");
console.log(`  Supabase: ${SUPABASE_URL}`);
console.log(`  Watcher: 250ms poll (agent state push-on-change)`);
console.log(`  Aggregator: 5s cycle (tokens, sessions, events)`);
console.log(`  Mode: ${IS_BACKFILL ? "BACKFILL + daemon" : "daemon (incremental)"}\n`);

initSupabase(SUPABASE_URL, SUPABASE_KEY);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_DIR = join(REPO_ROOT, "data");
const DB_PATH = join(DB_DIR, "telemetry.db");

// ─── Code-change detection ─────────────────────────────────────────────────
// Record git commit at startup. If it changes, exit gracefully so launchd
// restarts the daemon with the new code. Prevents stale-daemon bugs.
function getGitHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}
const STARTUP_COMMIT = getGitHead();
function codeChanged(): boolean {
  if (!STARTUP_COMMIT) return false;
  const current = getGitHead();
  return current !== null && current !== STARTUP_COMMIT;
}
mkdirSync(DB_DIR, { recursive: true });
initLocal(DB_PATH);
console.log(`  SQLite: ${DB_PATH}`);
const purged = purgeFailed();
if (purged > 0) console.log(`  Purged ${purged} permanently failed outbox rows`);

clearErrors();
await clearErrorsTable();

// ─── OTLP receiver ─────────────────────────────────────────────────────────
try {
  startOtlpServer();
} catch (err) {
  console.warn(`  OTLP server failed to start: ${err instanceof Error ? err.message : err}`);
  console.warn("  OTel events will not be received. Check if port 4318 is in use.");
}

// ─── Build pipeline ─────────────────────────────────────────────────────────
const resolver = new ProjectResolver();
await resolver.refresh();
const rStats = resolver.stats();
console.log(`  Project maps: ${rStats.total} projects mapped (lo.yml: ${rStats.fromLoYml}, cache: ${rStats.fromNameCache})`);

const sessionCount = buildSessionRegistry(resolver);
console.log(`  Session registry: ${sessionCount} sessions mapped from ~/.claude/projects/`);

const logReceiver = new LogReceiver(LOG_FILE, DB_PATH);
const tokenReceiver = new TokenReceiver(resolver);
const metricsReceiver = new MetricsReceiver();
const otelReceiver = new OtelReceiver();
const processor = new Processor(resolver, getLocal());
const shipper = new Shipper(getSupabase());
await processor.hydrate();

// ─── Gap detection ──────────────────────────────────────────────────────────
const GAP_THRESHOLD_MS = 2 * 60 * 1000;

async function detectAndFillGap(): Promise<void> {
  const allEntries = logReceiver.readAll();
  console.log(`  ${allEntries.length} entries in log`);

  const { data: row } = await getSupabase().from("facility_status").select("updated_at").single();
  const lastUpdated = row?.updated_at ? new Date(row.updated_at as string) : null;
  const gapMs = lastUpdated ? Date.now() - lastUpdated.getTime() : Infinity;

  if (gapMs < GAP_THRESHOLD_MS) {
    console.log(`  No gap detected (last update ${Math.round(gapMs / 1000)}s ago)`);
    return;
  }

  console.log(`  Gap detected: offline ~${Math.round(gapMs / 60_000)} min (last: ${lastUpdated?.toISOString() ?? "never"})`);
  const gapEntries = lastUpdated
    ? allEntries.filter((e) => e.parsedTimestamp && e.parsedTimestamp > lastUpdated)
    : allEntries;
  console.log(`  Found ${gapEntries.length} events in the gap (of ${allEntries.length} total)`);

  processor.processGapEntries(gapEntries, tokenReceiver.poll(), readStatsCache(), readModelStats());
  console.log(`  Gap backfill: ${gapEntries.length} entries queued for shipping`);
}

// ─── Backfill mode ──────────────────────────────────────────────────────────
async function runBackfill(): Promise<void> {
  console.log("Starting backfill...");
  const allEntries = logReceiver.readAll();
  console.log(`  Found ${allEntries.length} events`);

  const deleted = await deleteProjectDailyMetrics();
  console.log(`  Deleted ${deleted} stale per-project daily_metrics rows`);

  processor.processGapEntries(allEntries, tokenReceiver.poll(), readStatsCache(), readModelStats());
  console.log(`  Backfill: ${allEntries.length} entries queued`);

  let totalShipped = 0;
  while (shipper.outboxDepth() > 0) {
    totalShipped += (await shipper.ship()).shipped;
    await Bun.sleep(100);
  }
  console.log(`  Backfill: shipped ${totalShipped} rows`);
  console.log("Backfill complete.\n");
}

// ─── Startup ────────────────────────────────────────────────────────────────
if (IS_BACKFILL) {
  await runBackfill();
} else {
  console.log("Reading log file...");
  await detectAndFillGap();

  const initialTokenMap = tokenReceiver.poll();
  processor.processTokens(initialTokenMap);
  processor.processMetrics(readStatsCache(), readModelStats());

  const startupMetrics = processor.getStartupMetrics();
  if (startupMetrics) {
    const { error } = await getSupabase()
      .from("facility_status")
      .update(startupMetrics)
      .eq("id", 1);
    if (error) {
      console.warn(`  Startup sync failed: ${error.message}`);
    } else {
      console.log(`  Startup sync: pushed tokens_today=${startupMetrics.tokens_today} directly`);
    }
  }

  // Drain any outbox rows from gap detection or startup processing
  let startupShipped = 0;
  while (shipper.outboxDepth() > 0) {
    startupShipped += (await shipper.ship()).shipped;
    await Bun.sleep(100);
  }
  if (startupShipped > 0) console.log(`  Startup drain: shipped ${startupShipped} outbox rows`);

  console.log("  Ready — will only sync new events from this point.\n");
}
console.log("Daemon running (250ms watcher + 5s pipeline). Press Ctrl+C to stop.\n");

// ─── Auto-dormant state ─────────────────────────────────────────────────────
const AUTO_DORMANT_MS = 2 * 60 * 60 * 1000;
let lastActiveAgentTime = Date.now();
let autoDormantFired = false;

// ─── Loop 1: Process Watcher (250ms) ────────────────────────────────────────
const watcher = new ProcessWatcher();

async function watcherLoop(): Promise<never> {
  while (true) {
    try {
      const state = getFacilityState();
      const diff = watcher.tick();
      if (diff) {
        await pushAgentState(diff, state.processes);
        for (const event of diff.events) {
          console.log(`  ${new Date().toLocaleTimeString()} [${event.type}] ${event.project} (pid ${event.pid})`);
        }
      }
      if (watcher.activeAgents > 0) {
        lastActiveAgentTime = Date.now();
        autoDormantFired = false;
      }
      if (!autoDormantFired && Date.now() - lastActiveAgentTime > AUTO_DORMANT_MS) {
        await setFacilitySwitch("dormant");
        autoDormantFired = true;
        console.log(`  ${new Date().toLocaleTimeString()} [auto-dormant] Facility status → dormant after 2h idle`);
      }
    } catch (err) {
      console.error("Watcher error:", err);
      reportError("facility_state", `watcherLoop: ${err instanceof Error ? err.message : String(err)}`);
    }
    await Bun.sleep(250);
  }
}

// ─── Loop 2: Pipeline (5s) ──────────────────────────────────────────────────
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
const time = () => new Date().toLocaleTimeString();
let cycle = 0;

async function pipelineLoop(): Promise<never> {
  while (true) {
    try {
      // Collect (each receiver in its own try/catch)
      let newEntries: import("../src/parsers").LogEntry[] = [];
      try { newEntries = logReceiver.poll(); } catch (e) { reportError("event_write", `logReceiver: ${errMsg(e)}`); }

      let tokenMap: import("../src/project/scanner").ProjectTokenMap = new Map();
      try { tokenMap = tokenReceiver.poll(); } catch (e) { reportError("metrics_sync", `tokenReceiver: ${errMsg(e)}`); }

      let metrics: import("../src/pipeline/receivers").MetricsSnapshot = { statsCache: null, modelStats: [] };
      try { metrics = metricsReceiver.poll(); } catch (e) { reportError("metrics_sync", `metricsReceiver: ${errMsg(e)}`); }

      // Process -> SQLite outbox
      if (newEntries.length > 0) processor.processEvents(newEntries);
      processor.processTokens(tokenMap);
      processor.processMetrics(metrics.statsCache, metrics.modelStats);

      // OTel pipeline: poll unprocessed events, process into outbox
      try {
        const otelBatch = otelReceiver.poll();
        if (otelBatch.apiRequests.length > 0 || otelBatch.toolResults.length > 0
            || otelBatch.toolDecisionRejects.length > 0 || otelBatch.apiErrors.length > 0) {
          processor.processOtelBatch(otelBatch);
        }
        if (otelBatch.unresolved > 0 && cycle % 12 === 0) {
          console.log(`  ${time()} — ${otelBatch.unresolved} OTel events awaiting session resolution`);
        }
      } catch (e) { reportError("otel_processing", `otelReceiver: ${errMsg(e)}`); }

      // Flush accumulated daily rollups (unified across processEvents + processOtelBatch)
      processor.flushRollups();

      // Ship -> Supabase
      const result = await shipper.ship();
      if (result.shipped > 0 || result.failed > 0) {
        console.log(`  ${time()} — shipped ${result.shipped} rows${result.failed > 0 ? `, ${result.failed} failed` : ""}`);
      }

      // Archive (every 12 cycles / ~60s)
      if (cycle % 12 === 0 && cycle > 0) await shipper.shipArchive();

      // Periodic maintenance (every 60 cycles / ~5 min)
      if (cycle % 60 === 0 && cycle > 0) {
        // Code-change detection: exit if git HEAD has moved
        if (codeChanged()) {
          console.log(`  ${time()} — Code change detected (${STARTUP_COMMIT?.slice(0, 7)} → new). Exiting for restart.`);
          shutdown();
        }

        await processor.refreshResolver();
        refreshRegistry(resolver);
        await processor.refreshBaselines();
        if (new Date().getMinutes() < 1) {
          processor.snapshotFacilityState({
            status: watcher.activeAgents > 0 ? "active" : "dormant",
            activeAgents: watcher.activeAgents,
            activeProjects: [],
          });
        }
        shipper.pruneShipped(7);
        shipper.pruneShippedArchive(7);
        pruneProcessedOtelEvents(7);
        expireStaleOtelEvents(24);
        pruneRateLimits();
        await shipper.verify([]);
        const depth = shipper.outboxDepth();
        if (depth > 1000) reportError("event_write", `Outbox backlog: ${depth} pending rows`);
        const aDepth = shipper.archiveDepth();
        if (aDepth > 500) reportError("event_write", `Archive backlog: ${aDepth} pending rows`);
        await maybePruneRemoteEvents();

        // OTel health monitoring
        const otelRate = otelEventsReceivedSince(60);
        const otelSessions = otelActiveSessionCount(300);
        const otelDepth = otelQueueDepth();
        console.log(`  ${time()} — OTel: ${otelRate} events/min, ${otelSessions} sessions, ${otelDepth} queued`);
        if (watcher.activeAgents > 0 && otelRate === 0) {
          console.warn(`  ${time()} — Active agents detected but no OTel events — check CLAUDE_CODE_ENABLE_TELEMETRY`);
        }
      }
      cycle++;
    } catch (err) {
      reportError("event_write", `pipelineLoop: ${errMsg(err)}`);
    } finally {
      try { await flushErrors(); await pruneResolved(); } catch {}
    }
    await Bun.sleep(5000);
  }
}

// ─── Remote event pruning ───────────────────────────────────────────────────
let lastPruneDate = "";
async function maybePruneRemoteEvents(): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  if (today === lastPruneDate) return;
  try {
    const pruned = await pruneOldEvents(14);
    if (pruned > 0) console.log(`  Pruned ${pruned} events older than 14 days`);
    lastPruneDate = today;
  } catch (err) {
    console.error("Error pruning events:", err);
    reportError("event_write", `maybePruneRemoteEvents: ${errMsg(err)}`);
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────
await Promise.all([watcherLoop(), pipelineLoop()]);
