#!/usr/bin/env bun
/**
 * LO Facility Close Command
 *
 * Flips facility status to dormant in Supabase and stops the dashboard.
 * The exporter daemon is unaffected — it's always on, always shipping.
 * "Closing" is a signal for Next.js, not an operational change.
 *
 * Usage:
 *   bun run bin/lo-close.ts
 */

import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, unlinkSync } from "fs";
import {
  DASHBOARD_PID_FILE,
  DIM,
  RESET,
  BOLD,
  pass,
  fail,
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

  // 1. Flip status to dormant
  const { error } = await supabase
    .from("facility_status")
    .update({ status: "dormant", updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) {
    fail("Facility", `Failed to set status (${error.message})`);
    process.exit(1);
  }

  pass("Facility", "Status → dormant");

  // 2. Stop dashboard
  await stopDashboard();

  // Summary
  console.log();
  console.log(`  ${DIM}── Facility Closed ────────────────────${RESET}`);
  console.log(`  ${BOLD}Status:${RESET} dormant (exporter continues running)`);
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
