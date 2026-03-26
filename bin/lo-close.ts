#!/usr/bin/env bun
/**
 * LO Facility Close Command
 *
 * Flips facility status to dormant and stops the dashboard.
 * The exporter daemon keeps running in dormant mode — it continues
 * processing data into SQLite but skips Supabase shipping.
 *
 * Usage:
 *   bun run bin/lo-close.ts
 */

import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import {
  PID_FILE,
  DORMANT_FLAG,
  DASHBOARD_PID_FILE,
  DIM,
  RESET,
  BOLD,
  pass,
  fail,
  warn,
  printCloseBanner,
  isProcessRunning,
  loadEnv,
} from "../src/cli-output";

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printCloseBanner();

  const { url, key } = loadEnv();

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Flip status to dormant in Supabase
  const { error } = await supabase
    .from("facility_status")
    .update({ status: "dormant", updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) {
    fail("Facility", `Failed to set status (${error.message})`);
    process.exit(1);
  }

  pass("Facility", "Status → dormant");

  // 2. Write dormant flag so daemon knows to skip Supabase shipping
  writeFileSync(DORMANT_FLAG, new Date().toISOString());
  pass("Exporter", "Dormant flag written (daemon continues processing locally)");

  // Verify daemon is still running
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(pid) && isProcessRunning(pid)) {
      pass("Exporter", `Still running (PID ${pid})`);
    } else {
      warn("Exporter", "Not running (will restart on next lo-open)");
    }
  } else {
    warn("Exporter", "No PID file (will start on next lo-open)");
  }

  // 3. Stop dashboard
  await stopDashboard();

  // Summary
  console.log();
  console.log(`  ${DIM}── Facility Closed ────────────────────${RESET}`);
  console.log(`  ${BOLD}Exporter:${RESET} running (dormant — local processing only)`);
  console.log(`  ${BOLD}Dashboard:${RESET} stopped`);
  console.log();
}

async function stopDashboard(): Promise<void> {
  if (!existsSync(DASHBOARD_PID_FILE)) {
    pass("Dashboard", "Already stopped");
    return;
  }

  const pid = parseInt(readFileSync(DASHBOARD_PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid) || !isProcessRunning(pid)) {
    try { unlinkSync(DASHBOARD_PID_FILE); } catch {}
    pass("Dashboard", "Already stopped (stale PID file cleaned)");
    return;
  }

  process.kill(pid, "SIGTERM");
  await Bun.sleep(1_000);

  if (isProcessRunning(pid)) {
    process.kill(pid, "SIGKILL");
    await Bun.sleep(500);
  }

  try { unlinkSync(DASHBOARD_PID_FILE); } catch {}

  if (!isProcessRunning(pid)) {
    pass("Dashboard", `Stopped (PID ${pid})`);
  } else {
    fail("Dashboard", `PID ${pid} could not be killed`);
  }
}

main().catch((err) => {
  console.error(`  Unexpected error: ${err.message}`);
  process.exit(1);
});
