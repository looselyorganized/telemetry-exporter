#!/usr/bin/env bun
/**
 * LO Facility Startup Command
 *
 * Preflight checks, launchd management, health verification, status flip.
 * Only sets facility to "open" when the entire telemetry pipeline is verified healthy.
 *
 * Usage:
 *   bun run bin/lo-open.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { $ } from "bun";
import {
  EXPORTER_DIR,
  PLIST_SOURCE,
  PLIST_DEST,
  PID_FILE,
  DASHBOARD_PID_FILE,
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

async function launchDashboard(): Promise<void> {
  // Kill any existing dashboard process (PID file or port holder)
  if (existsSync(DASHBOARD_PID_FILE)) {
    const oldPid = parseInt(readFileSync(DASHBOARD_PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(oldPid) && isProcessRunning(oldPid)) {
      try {
        process.kill(oldPid, "SIGTERM");
        await Bun.sleep(500);
      } catch {}
    }
    try { unlinkSync(DASHBOARD_PID_FILE); } catch {}
  }

  // Also kill anything holding port 7777 (stale process without PID file)
  try {
    const result = await $`lsof -ti :7777`.quiet();
    const pids = result.stdout.toString().trim().split("\n").filter(Boolean);
    for (const p of pids) {
      try { process.kill(parseInt(p, 10), "SIGTERM"); } catch {}
    }
    if (pids.length > 0) await Bun.sleep(500);
  } catch {}  // lsof returns non-zero if nothing found

  // Spawn dashboard as a detached background process
  const dashboardScript = join(EXPORTER_DIR, "bin", "dashboard.ts");
  try {
    const proc = Bun.spawn(["bun", "run", dashboardScript], {
      cwd: EXPORTER_DIR,
      stdio: ["ignore", "ignore", "ignore"],
    });

    if (proc.pid) {
      writeFileSync(DASHBOARD_PID_FILE, String(proc.pid));
      proc.unref();

      // Wait briefly for server to start, then open browser
      await Bun.sleep(1_000);
      if (isProcessRunning(proc.pid)) {
        try { Bun.spawn(["open", "-a", "Google Chrome", "http://localhost:7777"]); } catch {}
        pass("Dashboard", `Running at http://localhost:7777 (PID ${proc.pid})`);
      } else {
        fail("Dashboard", "Process exited immediately");
      }
    } else {
      fail("Dashboard", "Could not spawn process");
    }
  } catch (err: any) {
    warn("Dashboard", `Could not start: ${err.message}`);
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
  await checkTelemetry(supabase);
  await flipFacilityOpen(supabase);
  await launchDashboard();

  console.log();
  console.log(`  ${DIM}── Facility Open ──────────────────────${RESET}`);
  console.log(`  ${BOLD}Exporter:${RESET} PID ${pid} (launchd managed)`);
  console.log();
}

main().catch((err) => {
  console.error();
  console.error(`  Unexpected error: ${err.message}`);
  process.exit(1);
});
