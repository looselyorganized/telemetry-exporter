#!/usr/bin/env bun
/**
 * LO Facility Open Command
 *
 * Preflight checks, service health verification, OTel env check, status flip.
 * Only sets facility to "active" when all services are verified healthy.
 *
 * The exporter daemon should already be running (launchd-managed).
 * This command does NOT start or manage the daemon — it only verifies it.
 *
 * Usage:
 *   bun run bin/lo-open.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, unlinkSync, readdirSync } from "fs";
import { join, basename } from "path";
import {
  EXPORTER_DIR,
  PID_FILE,
  DIM,
  RESET,
  BOLD,
  pass,
  fail,
  warn,
  abort,
  printOpenBanner,
  isProcessRunning,
  loadEnv,
} from "../src/cli-output";

// ─── Constants ───────────────────────────────────────────────────────────────

const SITE_URL = "https://looselyorganized-production.up.railway.app";
const ERR_LOG = `${process.env.HOME!}/.claude/lo-exporter.err`;

// ─── Check Implementations ──────────────────────────────────────────────────

function readErrLogTail(lines = 10): string {
  if (!existsSync(ERR_LOG)) return "(no error log found)";
  try {
    const content = readFileSync(ERR_LOG, "utf-8").trim();
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return "(could not read error log)";
  }
}

function printErrLogTail(): void {
  const errTail = readErrLogTail(10);
  console.log();
  console.log(`  ${DIM}── Last 10 lines of ${ERR_LOG} ──${RESET}`);
  for (const line of errTail.split("\n")) {
    console.log(`  ${DIM}${line}${RESET}`);
  }
}

async function checkSupabase(url: string, key: string): Promise<SupabaseClient> {
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const start = Date.now();
  const { data, error } = await supabase
    .from("facility_status")
    .select("id, status, active_agents")
    .eq("id", 1)
    .single();
  const latency = Date.now() - start;

  if (error) {
    fail("Supabase", `Connection failed (${error.message})`);
    if (error.message.includes("401") || error.message.includes("403")) {
      abort(
        "Supabase credentials are invalid or expired.",
        "Check SUPABASE_SECRET_KEY in .env"
      );
    }
    abort(
      `Supabase returned: ${error.message}`,
      "Check https://status.supabase.com or verify SUPABASE_URL in .env"
    );
  }

  if (!data) {
    fail("Supabase", "No facility_status row found");
    abort("facility_status table is empty (expected row id=1).");
  }

  const suffix = data.status === "active" ? " — facility already active" : "";
  pass("Supabase", `Connected (${latency}ms)${suffix}`);

  return supabase;
}

async function checkDeployment(): Promise<void> {
  try {
    const start = Date.now();
    const response = await fetch(`${SITE_URL}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    const latency = Date.now() - start;

    if (!response.ok) {
      fail("Deployment", `${SITE_URL}/api/health returned ${response.status}`);
      abort(
        `Health endpoint is returning HTTP ${response.status}.`,
        "Check Railway dashboard or run: railway logs"
      );
    }

    try {
      const body = (await response.json()) as Record<string, unknown>;
      const details = [
        `${latency}ms`,
        body.version ? `v${body.version}` : null,
        body.uptime ? `up ${body.uptime}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      pass("Deployment", details);
    } catch {
      pass("Deployment", `Healthy (${latency}ms)`);
    }
  } catch (err: any) {
    fail("Deployment", "Health endpoint unreachable");
    abort(
      `Could not reach ${SITE_URL}/api/health: ${err.message}`,
      "Check Railway deployment status or your network connection."
    );
  }
}

async function checkSite(): Promise<void> {
  try {
    const start = Date.now();
    const response = await fetch(SITE_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    const latency = Date.now() - start;

    if (!response.ok) {
      fail("Site", `${SITE_URL} returned ${response.status} ${response.statusText}`);
      abort(
        `The site is returning HTTP ${response.status}.`,
        "Check Railway dashboard or run: railway logs"
      );
    }

    pass("Site", `${SITE_URL} reachable (${response.status}, ${latency}ms)`);
  } catch (err: any) {
    fail("Site", `${SITE_URL} unreachable`);
    abort(
      `Could not reach site: ${err.message}`,
      "Check DNS, Railway status, or your network connection."
    );
  }
}

function checkOtelEnv(): void {
  const telemetryEnabled = process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
  if (telemetryEnabled === "1") {
    pass("OTel", "CLAUDE_CODE_ENABLE_TELEMETRY=1");
  } else if (telemetryEnabled) {
    warn("OTel", `CLAUDE_CODE_ENABLE_TELEMETRY=${telemetryEnabled} (expected "1")`);
  } else {
    warn("OTel", "CLAUDE_CODE_ENABLE_TELEMETRY not set — OTel events will not flow");
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    pass("OTel", `Endpoint: ${endpoint}`);
  } else {
    warn("OTel", "OTEL_EXPORTER_OTLP_ENDPOINT not set — Claude Code may use default");
  }

  const protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol === "http/json") {
    pass("OTel", "Protocol: http/json");
  } else if (protocol) {
    warn("OTel", `Protocol: ${protocol} (expected "http/json" — protobuf will not parse)`);
  }
}

function checkExporter(): number {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(pid) && isProcessRunning(pid)) {
      pass("Exporter", `Running (PID ${pid})`);
      return pid;
    }
    // Stale PID file
    try { unlinkSync(PID_FILE); } catch {}
  }

  fail("Exporter", "Not running");
  printErrLogTail();
  abort(
    "Exporter daemon is not running.",
    "Run: bun run setup (loads launchd plist) or manually: bun run start"
  );
}

async function checkTelemetry(
  supabase: SupabaseClient
): Promise<void> {
  const { data: first, error: err1 } = await supabase
    .from("facility_status")
    .select("updated_at, active_agents")
    .eq("id", 1)
    .single();

  if (err1 || !first) {
    fail("Telemetry", "Could not read facility_status");
    abort(`Supabase query failed: ${err1?.message ?? "no data"}`);
  }

  const firstUpdated = new Date(first.updated_at as string);
  const firstAge = Date.now() - firstUpdated.getTime();

  // If updated very recently (< 10s), trust it without waiting
  if (firstAge < 10_000) {
    pass("Telemetry", `Data flowing (updated ${Math.round(firstAge / 1000)}s ago)`);
    return;
  }

  // Wait 6s (slightly longer than the 5s aggregate cycle) and check again
  const waitMs = 6_000;
  await Bun.sleep(waitMs);

  const { data: second, error: err2 } = await supabase
    .from("facility_status")
    .select("updated_at, active_agents")
    .eq("id", 1)
    .single();

  if (err2 || !second) {
    fail("Telemetry", "Could not re-read facility_status");
    abort(`Supabase query failed: ${err2?.message ?? "no data"}`);
  }

  const secondUpdated = new Date(second.updated_at as string);

  if (secondUpdated > firstUpdated) {
    const age = Math.round((Date.now() - secondUpdated.getTime()) / 1000);
    pass("Telemetry", `Data flowing (updated ${age}s ago)`);
    return;
  }

  fail(
    "Telemetry",
    `Stale — last update was ${Math.round(firstAge / 1000)}s ago, no change after ${waitMs / 1000}s`
  );
  printErrLogTail();
  abort(
    "Exporter process is running but not writing telemetry.",
    "It may be stuck or failing silently. Check the error log above."
  );
}

async function flipFacilityOpen(supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase
    .from("facility_status")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) {
    fail("Facility", `Failed to set status (${error.message})`);
    abort("Could not update facility_status to active.");
  }

  // Verify the write
  const { data } = await supabase
    .from("facility_status")
    .select("status")
    .eq("id", 1)
    .single();

  if (data?.status !== "active") {
    fail("Facility", "Write succeeded but read-back shows wrong status");
    abort("facility_status.status is not 'active' after update.");
  }

  pass("Facility", "Status → active");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printOpenBanner();

  const { url, key } = loadEnv();
  pass("Environment", ".env loaded, credentials present");

  const supabase = await checkSupabase(url, key);
  await checkDeployment();
  await checkSite();
  checkOtelEnv();

  const pid = checkExporter();
  await checkTelemetry(supabase);
  await flipFacilityOpen(supabase);

  // ─── To Do List ──────────────────────────────────────────────────────────
  const todoDir = join(EXPORTER_DIR, "..", "docs", "todo");
  if (existsSync(todoDir)) {
    try {
      const files = readdirSync(todoDir)
        .filter((f) => f.endsWith(".md"))
        .sort();

      if (files.length > 0) {
        console.log();
        console.log(`  ${DIM}── To Do ──────────────────────────────${RESET}`);
        for (const file of files) {
          const name = basename(file, ".md")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          console.log(`  ${BOLD}☐${RESET}  ${name}  ${DIM}docs/todo/${file}${RESET}`);
        }
      }
    } catch {}
  }

  console.log();
  console.log(`  ${DIM}── Facility Open ──────────────────────${RESET}`);
  console.log(`  ${BOLD}Exporter:${RESET} PID ${pid}`);
  console.log();
}

main().catch((err) => {
  console.error();
  console.error(`  Unexpected error: ${err.message}`);
  process.exit(1);
});
