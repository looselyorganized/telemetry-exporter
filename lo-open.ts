#!/usr/bin/env bun
/**
 * LO Facility Startup Command
 *
 * Preflight checks, launchd management, health verification, status flip.
 * Only sets facility to "open" when the entire telemetry pipeline is verified healthy.
 *
 * Usage:
 *   bun run lo-open.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, symlinkSync, unlinkSync } from "fs";
import { $ } from "bun";
import {
  PLIST_SOURCE,
  PLIST_DEST,
  PID_FILE,
  DIM,
  RESET,
  BOLD,
  pass,
  fail,
  warn,
  abort,
  printHeader,
  printOpenBanner,
  isProcessRunning,
  loadEnv,
} from "./cli-output";

// ─── Constants ───────────────────────────────────────────────────────────────

const SITE_URL = "https://looselyorganized.org";
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

async function checkLaunchd(): Promise<void> {
  // 1. Ensure plist symlink exists
  if (!existsSync(PLIST_DEST)) {
    if (!existsSync(PLIST_SOURCE)) {
      fail("Launchd", "Plist file missing from exporter directory");
      abort(
        `Expected ${PLIST_SOURCE}`,
        "The launchd plist was deleted. Recreate it or restore from git."
      );
    }
    try {
      symlinkSync(PLIST_SOURCE, PLIST_DEST);
      pass("Launchd", `Symlink created → ${PLIST_DEST}`);
    } catch (err: any) {
      fail("Launchd", `Could not create symlink: ${err.message}`);
      abort("Failed to symlink plist to LaunchAgents.");
    }
  }

  // 2. Check if already loaded
  try {
    const result = await $`launchctl list`.quiet();
    if (result.stdout.toString().includes("com.lo.telemetry-exporter")) {
      pass("Launchd", "Service loaded (com.lo.telemetry-exporter)");
      return;
    }
  } catch {
    // launchctl list failed entirely — fall through to load
  }

  // 3. Not loaded — load it
  try {
    await $`launchctl load ${PLIST_DEST}`.quiet();
    pass("Launchd", "Service loaded (was not loaded, loaded now)");
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? "";
    if (stderr.includes("service already loaded")) {
      pass("Launchd", "Service loaded (already loaded)");
    } else {
      fail("Launchd", "launchctl load failed");
      abort(
        `launchctl load returned: ${stderr.trim() || err.message}`,
        "Try manually: launchctl load ~/Library/LaunchAgents/com.lo.telemetry-exporter.plist"
      );
    }
  }
}

async function checkExporter(): Promise<number> {
  // Check PID file for a running process
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(pid) && isProcessRunning(pid)) {
      pass("Exporter", `Running (PID ${pid})`);
      return pid;
    }
    // Stale PID file — clean it up
    try {
      unlinkSync(PID_FILE);
    } catch {}
  }

  // Not running — wait for launchd to spawn it
  const MAX_WAIT = 5_000;
  const POLL_INTERVAL = 500;
  let waited = 0;

  while (waited < MAX_WAIT) {
    await Bun.sleep(POLL_INTERVAL);
    waited += POLL_INTERVAL;

    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (!isNaN(pid) && isProcessRunning(pid)) {
        pass("Exporter", `Running (PID ${pid}, started after ${waited}ms)`);
        return pid;
      }
    }
  }

  fail("Exporter", "Not running after 5s wait");
  printErrLogTail();
  abort(
    "Exporter did not start. Check error log above.",
    `Log: ${ERR_LOG}`
  );
}

async function fetchAgentTotals(
  supabase: SupabaseClient
): Promise<{ activeAgents: number; agentCount: number }> {
  const { data: rows } = await supabase
    .from("project_telemetry")
    .select("active_agents, agent_count");

  const agentCount =
    rows?.reduce((sum, r) => sum + (Number(r.agent_count) || 0), 0) ?? 0;
  const activeAgents =
    rows?.reduce((sum, r) => sum + (Number(r.active_agents) || 0), 0) ?? 0;

  return { activeAgents, agentCount };
}

async function checkTelemetry(
  supabase: SupabaseClient
): Promise<{ updatedAt: string; activeAgents: number; agentCount: number }> {
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
    const agents = await fetchAgentTotals(supabase);
    pass("Telemetry", `Data flowing (updated ${Math.round(firstAge / 1000)}s ago)`);
    return { updatedAt: first.updated_at as string, ...agents };
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
    const agents = await fetchAgentTotals(supabase);
    const age = Math.round((Date.now() - secondUpdated.getTime()) / 1000);
    pass("Telemetry", `Data flowing (updated ${age}s ago)`);
    return { updatedAt: second.updated_at as string, ...agents };
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

async function launchDashboard(): Promise<void> {
  try {
    await $`open "warp://launch/claude-dash"`.quiet();
    pass("Dashboard", "Warp launch config triggered");
  } catch {
    warn("Dashboard", "Could not launch Warp — open manually and run 'claude-dash'");
  }
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
  await checkLaunchd();
  const pid = await checkExporter();
  const telemetry = await checkTelemetry(supabase);
  await flipFacilityOpen(supabase);
  await launchDashboard();

  const ago = Math.round(
    (Date.now() - new Date(telemetry.updatedAt).getTime()) / 1000
  );
  console.log();
  console.log(`  ${DIM}── Facility Open ──────────────────────${RESET}`);
  console.log(`  ${BOLD}Exporter:${RESET} PID ${pid} (launchd managed)`);
  console.log(
    `  ${BOLD}Agents:${RESET} ${telemetry.agentCount} instances, ${telemetry.activeAgents} active`
  );
  console.log(`  ${BOLD}Last sync:${RESET} ${ago}s ago`);
  console.log();
}

main().catch((err) => {
  console.error();
  console.error(`  Unexpected error: ${err.message}`);
  process.exit(1);
});
