#!/usr/bin/env bun
/**
 * LO Telemetry Exporter — One-Time Setup
 *
 * Loads the launchd plist so the daemon runs permanently:
 *   - Starts on login (RunAtLoad)
 *   - Restarts on crash (KeepAlive)
 *   - Survives terminal closure
 *
 * Safe to run multiple times — idempotent.
 *
 * Usage:
 *   bun run setup
 */

import { existsSync, symlinkSync, unlinkSync, readFileSync } from "fs";
import { $ } from "bun";
import {
  EXPORTER_DIR,
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
  isProcessRunning,
  loadEnv,
} from "../src/cli-output";

async function main(): Promise<void> {
  console.log();
  console.log(`  ${BOLD}LO Telemetry Exporter — Setup${RESET}`);
  console.log();

  // 1. Verify .env exists
  loadEnv();
  pass("Environment", ".env loaded");

  // 2. Verify plist source exists
  if (!existsSync(PLIST_SOURCE)) {
    fail("Plist", `Not found: ${PLIST_SOURCE}`);
    abort(
      "The launchd plist is missing from the exporter directory.",
      "Restore it from git: git checkout com.lo.telemetry-exporter.plist"
    );
  }
  pass("Plist", `Found: ${PLIST_SOURCE}`);

  // 3. Kill any manually-running daemon (from `bun run start` in a terminal)
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(pid) && isProcessRunning(pid)) {
      console.log(`  ${DIM}Stopping manually-running daemon (PID ${pid})...${RESET}`);
      process.kill(pid, "SIGTERM");
      await Bun.sleep(2000);
      if (isProcessRunning(pid)) {
        process.kill(pid, "SIGKILL");
        await Bun.sleep(500);
      }
      pass("Daemon", `Stopped manual instance (PID ${pid})`);
    }
    try { unlinkSync(PID_FILE); } catch {}
  }

  // 4. Unload existing launchd service (if loaded)
  try {
    const result = await $`launchctl list`.quiet();
    if (result.stdout.toString().includes("com.lo.telemetry-exporter")) {
      await $`launchctl unload ${PLIST_DEST}`.quiet();
      pass("Launchd", "Unloaded existing service");
    }
  } catch {}

  // 5. Ensure symlink exists
  if (existsSync(PLIST_DEST)) {
    try { unlinkSync(PLIST_DEST); } catch {}
  }
  symlinkSync(PLIST_SOURCE, PLIST_DEST);
  pass("Symlink", `${PLIST_DEST}`);

  // 6. Load into launchd
  try {
    await $`launchctl load ${PLIST_DEST}`.quiet();
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? "";
    if (!stderr.includes("service already loaded")) {
      fail("Launchd", `Load failed: ${stderr.trim() || err.message}`);
      abort(
        "Could not load launchd plist.",
        `Try manually: launchctl load ${PLIST_DEST}`
      );
    }
  }
  pass("Launchd", "Service loaded (com.lo.telemetry-exporter)");

  // 7. Wait for daemon to start
  const MAX_WAIT = 8_000;
  const POLL_INTERVAL = 500;
  let waited = 0;

  while (waited < MAX_WAIT) {
    await Bun.sleep(POLL_INTERVAL);
    waited += POLL_INTERVAL;

    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (!isNaN(pid) && isProcessRunning(pid)) {
        pass("Daemon", `Running (PID ${pid}, started after ${waited}ms)`);

        console.log();
        console.log(`  ${DIM}── Setup Complete ─────────────────────${RESET}`);
        console.log(`  ${BOLD}Daemon:${RESET} always-on (launchd-managed)`);
        console.log(`  ${BOLD}Restarts:${RESET} automatic on crash`);
        console.log(`  ${BOLD}Survives:${RESET} terminal close, logout, reboot`);
        console.log(`  ${BOLD}Logs:${RESET} ~/.claude/lo-exporter.{log,err}`);
        console.log(`  ${BOLD}OTLP:${RESET} http://127.0.0.1:4318`);
        console.log();
        console.log(`  ${DIM}To check status:  bun run open${RESET}`);
        console.log(`  ${DIM}To view logs:     tail -f ~/.claude/lo-exporter.log${RESET}`);
        console.log(`  ${DIM}To stop forever:  launchctl unload ${PLIST_DEST}${RESET}`);
        console.log();
        return;
      }
    }
  }

  fail("Daemon", `Not running after ${MAX_WAIT / 1000}s`);
  console.log();
  console.log(`  ${DIM}Check logs: tail -20 ~/.claude/lo-exporter.err${RESET}`);
  console.log();
  process.exit(1);
}

main().catch((err) => {
  console.error(`  Unexpected error: ${err.message}`);
  process.exit(1);
});
