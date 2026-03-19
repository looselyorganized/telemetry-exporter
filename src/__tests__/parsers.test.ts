import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  stripAnsi,
  parseTimestamp,
  parseLogLine,
  LogTailer,
} from "../parsers";

// We can't import readModelStats directly since it reads a hardcoded path,
// but we can test it via a re-export trick. Instead, we'll test it indirectly
// by verifying the parsing logic through parseLogLine and other exports.

describe("stripAnsi", () => {
  test("removes ANSI color codes", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m")).toBe("hello");
  });

  test("removes multiple ANSI codes", () => {
    expect(stripAnsi("\x1b[1;32mgreen\x1b[0m \x1b[34mblue\x1b[0m")).toBe(
      "green blue"
    );
  });

  test("returns plain text unchanged", () => {
    expect(stripAnsi("no codes here")).toBe("no codes here");
  });

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("parseTimestamp", () => {
  const now = new Date();
  const year = now.getFullYear();

  test("parses MM/DD HH:MM AM format", () => {
    const d = parseTimestamp("03/15 2:30 PM");
    expect(d).not.toBeNull();
    expect(d!.getMonth()).toBe(2); // March = 2
    expect(d!.getDate()).toBe(15);
    expect(d!.getHours()).toBe(14);
    expect(d!.getMinutes()).toBe(30);
  });

  test("parses MM/DD HH:MM:SS AM format", () => {
    const d = parseTimestamp("01/05 11:45:30 AM");
    expect(d).not.toBeNull();
    expect(d!.getMonth()).toBe(0);
    expect(d!.getDate()).toBe(5);
    expect(d!.getHours()).toBe(11);
    expect(d!.getMinutes()).toBe(45);
    expect(d!.getSeconds()).toBe(30);
  });

  test("parses HH:MM AM format (no date)", () => {
    const d = parseTimestamp("9:15 AM");
    expect(d).not.toBeNull();
    expect(d!.getHours()).toBe(9);
    expect(d!.getMinutes()).toBe(15);
    expect(d!.getMonth()).toBe(now.getMonth());
    expect(d!.getDate()).toBe(now.getDate());
  });

  test("handles 12 PM correctly", () => {
    const d = parseTimestamp("12:00 PM");
    expect(d).not.toBeNull();
    expect(d!.getHours()).toBe(12);
  });

  test("handles 12 AM correctly (midnight)", () => {
    const d = parseTimestamp("12:00 AM");
    expect(d).not.toBeNull();
    expect(d!.getHours()).toBe(0);
  });

  test("strips timezone abbreviations", () => {
    const d = parseTimestamp("03/15 2:30 PM PST");
    expect(d).not.toBeNull();
    expect(d!.getHours()).toBe(14);
  });

  test("strips various timezone abbreviations", () => {
    for (const tz of ["EST", "EDT", "CST", "CDT", "MST", "MDT", "PDT", "UTC"]) {
      const d = parseTimestamp(`1:00 PM ${tz}`);
      expect(d).not.toBeNull();
      expect(d!.getHours()).toBe(13);
    }
  });

  test("returns null for empty string", () => {
    expect(parseTimestamp("")).toBeNull();
  });

  test("returns null for invalid input", () => {
    expect(parseTimestamp("not a timestamp")).toBeNull();
    expect(parseTimestamp("2024-01-01")).toBeNull();
  });
});

describe("parseLogLine", () => {
  test("parses a 4-part pipe-separated log line", () => {
    const line = "03/10 2:30 PM│my-project│main│🔧 Running tool";
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.timestamp).toBe("03/10 2:30 PM");
    expect(entry!.project).toBe("my-project");
    expect(entry!.branch).toBe("main");
    expect(entry!.eventType).toBe("tool");
    expect(entry!.emoji).toBe("🔧");
    expect(entry!.eventText).toBe("🔧 Running tool");
  });

  test("maps emojis to correct event types", () => {
    const cases: [string, string][] = [
      ["📖", "read"],
      ["🔍", "search"],
      ["🟢", "session_start"],
      ["🔴", "session_end"],
      ["✅", "completed"],
    ];
    for (const [emoji, expectedType] of cases) {
      const line = `03/10 1:00 PM│proj│br│${emoji} event`;
      const entry = parseLogLine(line);
      expect(entry).not.toBeNull();
      expect(entry!.eventType).toBe(expectedType);
    }
  });

  test("strips ANSI codes before parsing", () => {
    const line = "\x1b[32m03/10 1:00 PM│proj│main│🔧 tool\x1b[0m";
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.project).toBe("proj");
  });

  test("returns null when no project field", () => {
    // 2-part line: timestamp│event (no project)
    const line = "03/10 1:00 PM│🔧 tool";
    expect(parseLogLine(line)).toBeNull();
  });

  test("returns null for empty line", () => {
    expect(parseLogLine("")).toBeNull();
    expect(parseLogLine("   ")).toBeNull();
  });

  test("converts branch '-' to empty string", () => {
    const line = "03/10 1:00 PM│proj│-│🔧 tool";
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.branch).toBe("");
  });

  test("sets eventType to unknown when no emoji matches", () => {
    const line = "03/10 1:00 PM│proj│main│some event without emoji";
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.eventType).toBe("unknown");
    expect(entry!.emoji).toBe("");
  });
});

describe("LogTailer", () => {
  function makeTempDir() {
    return mkdtempSync(join(tmpdir(), "parsers-test-"));
  }

  test("readAll reads full file and returns entries", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "test.log");
    writeFileSync(
      logPath,
      "03/10 1:00 PM│proj│main│🔧 tool call\n03/10 1:01 PM│proj│main│📖 read file\n"
    );

    const tailer = new LogTailer(logPath);
    const entries = tailer.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].eventType).toBe("tool");
    expect(entries[1].eventType).toBe("read");
  });

  test("poll returns only new entries after readAll", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "test.log");
    writeFileSync(logPath, "03/10 1:00 PM│proj│main│🔧 tool\n");

    const tailer = new LogTailer(logPath);
    tailer.readAll();

    // Append new data
    const { appendFileSync } = require("fs");
    appendFileSync(logPath, "03/10 1:02 PM│proj│main│📖 read\n");

    const newEntries = tailer.poll();
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0].eventType).toBe("read");
  });

  test("poll returns empty when no new data", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "test.log");
    writeFileSync(logPath, "03/10 1:00 PM│proj│main│🔧 tool\n");

    const tailer = new LogTailer(logPath);
    tailer.readAll();

    expect(tailer.poll()).toHaveLength(0);
  });

  test("poll resets offset on file truncation", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "test.log");
    writeFileSync(
      logPath,
      "03/10 1:00 PM│proj│main│🔧 first\n03/10 1:01 PM│proj│main│📖 second\n"
    );

    const tailer = new LogTailer(logPath);
    tailer.readAll();

    // Truncate file with shorter content
    writeFileSync(logPath, "03/10 1:05 PM│proj│main│🔍 new\n");

    const entries = tailer.poll();
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe("search");
  });

  test("readAll returns empty for missing file", () => {
    const tailer = new LogTailer("/nonexistent/path/log.txt");
    expect(tailer.readAll()).toHaveLength(0);
  });

  test("poll returns empty for missing file", () => {
    const tailer = new LogTailer("/nonexistent/path/log.txt");
    expect(tailer.poll()).toHaveLength(0);
  });

  test("currentOffset returns 0 before any read", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "test.log");
    writeFileSync(logPath, "03/10 1:00 PM│proj│main│🔧 tool\n");

    const tailer = new LogTailer(logPath);
    expect(tailer.currentOffset()).toBe(0);
  });

  test("currentOffset returns byte position after readAll", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "test.log");
    writeFileSync(logPath, "03/10 1:00 PM│proj│main│🔧 tool call\n03/10 1:01 PM│proj│main│📖 read file\n");

    const tailer = new LogTailer(logPath);
    tailer.readAll();
    expect(tailer.currentOffset()).toBeGreaterThan(0);
  });

  test("resetOffset changes read position for next poll", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "test.log");
    writeFileSync(logPath, "03/10 1:00 PM│proj│main│🔧 tool call\n03/10 1:01 PM│proj│main│📖 read file\n");

    const tailer = new LogTailer(logPath);
    tailer.readAll(); // cursor moves to end

    // poll returns nothing new
    expect(tailer.poll()).toHaveLength(0);

    // reset to beginning
    tailer.resetOffset(0);

    // poll now returns all entries again
    const entries = tailer.poll();
    expect(entries).toHaveLength(2);
    expect(entries[0].eventType).toBe("tool");
    expect(entries[1].eventType).toBe("read");
  });
});

describe("readModelStats", () => {
  // readModelStats reads from a hardcoded MODEL_FILE (~/.claude/model-stats).
  // We can't redirect it without mock.module (which leaks in Bun).
  // The parsing logic is thoroughly tested in read-model-stats.test.ts.
  // Here we verify the function's contract: always returns an array of valid shapes.

  test("returns an array with valid entry shapes", async () => {
    const { readModelStats } = await import("../parsers");
    const result = readModelStats();
    expect(Array.isArray(result)).toBe(true);
    for (const entry of result) {
      expect(entry).toHaveProperty("model");
      expect(entry).toHaveProperty("total");
      expect(entry).toHaveProperty("input");
      expect(entry).toHaveProperty("cacheWrite");
      expect(entry).toHaveProperty("cacheRead");
      expect(entry).toHaveProperty("output");
      expect(typeof entry.model).toBe("string");
      expect(typeof entry.total).toBe("number");
    }
  });
});
