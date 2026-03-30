/**
 * Parsers for Claude Code telemetry files.
 * Mirrors the Python parsing logic in dashboard.py.
 */

import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Paths ──────────────────────────────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), ".claude");
export const LOG_FILE = join(CLAUDE_DIR, "events.log");

// ─── ANSI stripping ────────────────────────────────────────────────────────

const ANSI_RE = /\033\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// ─── Emoji → event_type mapping ────────────────────────────────────────────

const EMOJI_TYPE_MAP: Record<string, string> = {
  "🔧": "tool",
  "📖": "read",
  "🔍": "search",
  "🌐": "fetch",
  "🔌": "mcp",
  "⚡": "skill",
  "🚀": "agent_spawn",
  "🤖": "agent_task",
  "🛬": "agent_finish",
  "🟢": "session_start",
  "🔴": "session_end",
  "🏁": "response_finish",
  "📐": "plan",
  "👋": "input_needed",
  "🔐": "permission",
  "❓": "question",
  "✅": "completed",
  "⚠️": "compact",
  "📋": "task",
  "💬": "message",
};

const EMOJI_KEYS = Object.keys(EMOJI_TYPE_MAP);

// ─── Log entry type ────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: string; // raw timestamp string from log
  parsedTimestamp: Date | null; // parsed to Date for DB
  project: string;
  branch: string;
  emoji: string;
  eventType: string;
  eventText: string;
}

// ─── Timestamp parsing ─────────────────────────────────────────────────────

/** Convert 12-hour format to 24-hour. */
function to24Hour(hourStr: string, ampm: string): number {
  let hour = parseInt(hourStr, 10);
  const upper = ampm.toUpperCase();
  if (upper === "PM" && hour !== 12) hour += 12;
  if (upper === "AM" && hour === 12) hour = 0;
  return hour;
}

/**
 * Parse timestamp strings from events.log.
 * Formats: "MM/DD HH:MM AM/PM", "HH:MM AM/PM", with optional seconds and timezone.
 */
export function parseTimestamp(ts: string): Date | null {
  ts = ts.trim();
  if (!ts) return null;

  // Remove timezone abbreviations like "PST", "PDT", etc.
  ts = ts.replace(/\s+(PST|PDT|EST|EDT|CST|CDT|MST|MDT|UTC)\s*$/i, "");

  const now = new Date();
  const year = now.getFullYear();

  // Try MM/DD HH:MM:SS AM/PM
  let m = ts.match(
    /^(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i
  );
  if (m) {
    const [, month, day, hourStr, min, sec, ampm] = m;
    return new Date(
      year,
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      to24Hour(hourStr, ampm),
      parseInt(min, 10),
      sec ? parseInt(sec, 10) : 0
    );
  }

  // Try HH:MM:SS AM/PM (no date)
  m = ts.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (m) {
    const [, hourStr, min, sec, ampm] = m;
    return new Date(
      year,
      now.getMonth(),
      now.getDate(),
      to24Hour(hourStr, ampm),
      parseInt(min, 10),
      sec ? parseInt(sec, 10) : 0
    );
  }

  return null;
}

// ─── Log line parser ───────────────────────────────────────────────────────

export function parseLogLine(rawLine: string): LogEntry | null {
  const clean = stripAnsi(rawLine).trim();
  if (!clean) return null;

  let timestamp = "";
  let project = "";
  let branch = "";
  let event = clean;

  const parts = clean.split("│");
  if (parts.length >= 4) {
    timestamp = parts[0].trim();
    project = parts[1].trim();
    branch = parts[2].trim();
    event = parts.slice(3).join("│").trim();
  } else if (parts.length >= 2) {
    timestamp = parts[0].trim();
    event = parts.slice(1).join("│").trim();
  }

  // Find the first matching emoji
  let emoji = "";
  let eventType = "unknown";
  for (const e of EMOJI_KEYS) {
    if (event.includes(e)) {
      emoji = e;
      eventType = EMOJI_TYPE_MAP[e];
      break;
    }
  }

  // Skip entries without a project (can't attribute them)
  if (!project) return null;

  return {
    timestamp,
    parsedTimestamp: parseTimestamp(timestamp),
    project,
    branch: branch === "-" ? "" : branch,
    emoji,
    eventType,
    eventText: event,
  };
}

// ─── Log tailer (incremental reads) ────────────────────────────────────────

export class LogTailer {
  private offset = 0;

  constructor(private path: string = LOG_FILE) {}

  /** Read all existing lines (for backfill). */
  readAll(): LogEntry[] {
    try {
      const data = readFileSync(this.path, "utf-8");
      this.offset = Buffer.byteLength(data, "utf-8");
      return this.parseLines(data);
    } catch {
      return [];
    }
  }

  /** Read only new lines since last poll. */
  poll(): LogEntry[] {
    try {
      const stat = statSync(this.path);
      if (stat.size < this.offset) {
        // File was truncated/rotated
        this.offset = 0;
      }
      if (stat.size === this.offset) {
        return [];
      }

      const allBytes = readFileSync(this.path);
      const newBytes = allBytes.subarray(this.offset);
      this.offset = allBytes.length;
      const text = newBytes.toString("utf-8");

      return this.parseLines(text);
    } catch {
      return [];
    }
  }

  /** Set the byte offset to a specific position (for restoring from cursor). */
  resetOffset(offset: number): void {
    this.offset = offset;
  }

  /** Get the current byte offset (for persisting to cursor). */
  currentOffset(): number {
    return this.offset;
  }

  private parseLines(data: string): LogEntry[] {
    return data
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseLogLine)
      .filter((entry): entry is LogEntry => entry !== null);
  }
}

