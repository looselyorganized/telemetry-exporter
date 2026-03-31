/**
 * Shared CLI output helpers for lo-open and lo-close commands.
 *
 * Provides ANSI-colored status reporting (pass/fail/warn),
 * .env file loading, and process liveness checks.
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

// ─── Paths ──────────────────────────────────────────────────────────────────

export const EXPORTER_DIR = join(import.meta.dirname!, "..");
export const ENV_FILE = join(EXPORTER_DIR, ".env");
export const PID_FILE = join(EXPORTER_DIR, ".exporter.pid");
export const PLIST_NAME = "com.lo.telemetry-exporter.plist";
export const PLIST_SOURCE = join(EXPORTER_DIR, PLIST_NAME);
export const PLIST_DEST = join(
  process.env.HOME!,
  "Library/LaunchAgents",
  PLIST_NAME
);

// ─── ANSI Codes ─────────────────────────────────────────────────────────────

const PASS_ICON = "\x1b[32m[✓]\x1b[0m";
const FAIL_ICON = "\x1b[31m[✗]\x1b[0m";
const WARN_ICON = "\x1b[33m[!]\x1b[0m";
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";

// ─── Status Logging ─────────────────────────────────────────────────────────

function statusLine(icon: string, label: string, detail: string, dimDetail = true): void {
  const padded = label.padEnd(18);
  const styledDetail = dimDetail ? `${DIM}${detail}${RESET}` : detail;
  console.log(`  ${icon} ${BOLD}${padded}${RESET} ${styledDetail}`);
}

export function pass(label: string, detail: string): void {
  statusLine(PASS_ICON, label, detail);
}

export function fail(label: string, detail: string): void {
  statusLine(FAIL_ICON, label, detail, false);
}

export function warn(label: string, detail: string): void {
  statusLine(WARN_ICON, label, detail, false);
}

/**
 * Print a fatal error and exit. Typed as `never` so callers
 * do not need unreachable return statements after calling this.
 */
export function abort(reason: string, hint?: string): never {
  console.log();
  console.log(`  ${BOLD}\x1b[31mABORT${RESET} — Cannot open facility.`);
  console.log(`  ${reason}`);
  if (hint) console.log(`  ${DIM}${hint}${RESET}`);
  console.log();
  process.exit(1);
}

// ─── LORF Banner ────────────────────────────────────────────────────────────

const LORF_LINES = [
  "██╗      ██████╗ ██████╗ ███████╗",
  "██║     ██╔═══██╗██╔══██╗██╔════╝",
  "██║     ██║   ██║██████╔╝█████╗  ",
  "██║     ██║   ██║██╔══██╗██╔══╝  ",
  "███████╗╚██████╔╝██║  ██║██║     ",
  "╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝     ",
];

const OPEN_GRADIENT: [number, number, number][] = [
  [80, 255, 160],
  [60, 220, 140],
  [45, 185, 115],
  [35, 150, 90],
  [25, 115, 70],
  [15, 80, 50],
];

const CLOSE_GRADIENT: [number, number, number][] = [
  [255, 200, 60],
  [240, 170, 50],
  [220, 140, 40],
  [190, 110, 35],
  [160, 80, 30],
  [120, 60, 25],
];

function printBanner(gradient: [number, number, number][]): void {
  console.log();
  for (let i = 0; i < LORF_LINES.length; i++) {
    const [r, g, b] = gradient[i];
    console.log(`  \x1b[38;2;${r};${g};${b}m${BOLD}${LORF_LINES[i]}${RESET}`);
  }
  console.log(`  ${DIM}Loosely Organized Research Facility${RESET}`);
  console.log();
}

export function printOpenBanner(): void {
  printBanner(OPEN_GRADIENT);
  console.log(`  ${DIM}Opening facility...${RESET}`);
  console.log();
}

export function printCloseBanner(): void {
  printBanner(CLOSE_GRADIENT);
  console.log(`  ${DIM}Closing facility...${RESET}`);
  console.log();
}

// ─── Plugin Version ─────────────────────────────────────────────────────────

const INSTALLED_PLUGINS_FILE = join(
  process.env.HOME!,
  ".claude/plugins/installed_plugins.json"
);

export function getLoPluginVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(INSTALLED_PLUGINS_FILE, "utf-8"));
    const entry = raw?.plugins?.["lo@looselyorganized"]?.[0];
    return entry?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a PID belongs to an exporter process (bun), not a recycled PID.
 * Returns false if the process doesn't exist or isn't a bun process.
 */
export function isExporterProcess(pid: number): boolean {
  if (!isProcessRunning(pid)) return false;
  try {
    const comm = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    return comm.includes("bun");
  } catch {
    return false;
  }
}

/** JSON format for enriched PID file. */
export interface PidFileContents {
  pid: number;
  startedAt: string;
}

/** Parse a PID file — supports JSON format and bare-integer legacy format. */
export function parsePidFile(content: string): PidFileContents | null {
  const trimmed = content.trim();
  // Try JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      return parsed as PidFileContents;
    }
  } catch {}
  // Fallback: bare integer (backward compat)
  const pid = parseInt(trimmed, 10);
  if (!isNaN(pid)) return { pid, startedAt: "" };
  return null;
}

/**
 * Parse a .env file and populate process.env for any keys not already set.
 * Returns the parsed SUPABASE_URL and SUPABASE_SECRET_KEY, or aborts if missing.
 */
export function loadEnv(): { url: string; key: string } {
  if (!existsSync(ENV_FILE)) {
    fail("Environment", ".env file not found");
    abort(
      `Expected .env at ${ENV_FILE}`,
      "Copy .env.example to .env and fill in your Supabase credentials."
    );
  }

  const content = readFileSync(ENV_FILE, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    const v = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    fail("Environment", "Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
    abort(
      "Required environment variables are not set in .env",
      "Check .env.example for the required variables."
    );
  }

  return { url, key };
}
