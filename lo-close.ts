#!/usr/bin/env bun
/**
 * LO Facility Close Command
 *
 * Graceful shutdown: flips status to dormant, stops the exporter,
 * unloads the launchd service.
 *
 * Usage:
 *   bun run lo-close.ts
 */

import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { $ } from "bun";
import {
  PLIST_DEST,
  PID_FILE,
  DIM,
  RESET,
  BOLD,
  pass,
  fail,
  warn,
  printHeader,
  printCloseBanner,
  isProcessRunning,
  loadEnv,
} from "./cli-output";

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

  // 2. Stop exporter process (SIGTERM for graceful shutdown)
  await stopExporter();

  // Clean up stale PID file
  if (existsSync(PID_FILE)) {
    try {
      unlinkSync(PID_FILE);
    } catch {}
  }

  // 3. Unload launchd service (prevents auto-restart)
  await unloadLaunchd();

  // Summary
  console.log();
  console.log(`  ${DIM}── Facility Closed ────────────────────${RESET}`);
  console.log(`  ${BOLD}Exporter:${RESET} stopped`);
  console.log(`  ${BOLD}Launchd:${RESET} unloaded (lo-open will reload)`);
  console.log();
}

async function stopExporter(): Promise<void> {
  let pid: number | null = null;

  if (existsSync(PID_FILE)) {
    const parsed = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(parsed) && isProcessRunning(parsed)) {
      pid = parsed;
    }
  }

  if (!pid) {
    pass("Exporter", "Already stopped");
    return;
  }

  process.kill(pid, "SIGTERM");

  // Wait for exit (up to 5s)
  const MAX_WAIT = 5_000;
  const POLL_INTERVAL = 250;
  let waited = 0;

  while (waited < MAX_WAIT && isProcessRunning(pid)) {
    await Bun.sleep(POLL_INTERVAL);
    waited += POLL_INTERVAL;
  }

  if (isProcessRunning(pid)) {
    warn("Exporter", `PID ${pid} did not exit after ${MAX_WAIT / 1000}s, sending SIGKILL`);
    process.kill(pid, "SIGKILL");
    await Bun.sleep(500);
  }

  if (!isProcessRunning(pid)) {
    pass("Exporter", `Stopped (PID ${pid})`);
  } else {
    fail("Exporter", `PID ${pid} could not be killed`);
  }
}

async function unloadLaunchd(): Promise<void> {
  try {
    const result = await $`launchctl list`.quiet();
    const isLoaded = result.stdout.toString().includes("com.lo.telemetry-exporter");

    if (isLoaded) {
      await $`launchctl unload ${PLIST_DEST}`.quiet();
      pass("Launchd", "Service unloaded");
    } else {
      pass("Launchd", "Service already unloaded");
    }
  } catch {
    warn("Launchd", "Could not check/unload service");
  }
}

main().catch((err) => {
  console.error(`  Unexpected error: ${err.message}`);
  process.exit(1);
});
