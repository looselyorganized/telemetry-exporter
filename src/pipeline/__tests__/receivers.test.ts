import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { initLocal, closeLocal, getCursor } from "../../db/local";
import { LogReceiver } from "../receivers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid log line with project field populated. */
function logLine(project: string, event: string): string {
  return `03/19 10:00 AM │ ${project} │ main │ 🔧 ${event}\n`;
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "receivers-test-"));
  dbPath = join(tmpDir, "test.db");
  initLocal(dbPath);
});

afterEach(() => {
  closeLocal();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// LogReceiver
// ---------------------------------------------------------------------------

describe("LogReceiver", () => {
  test("readAll reads entries from file and persists cursor to SQLite", () => {
    const logPath = join(tmpDir, "events.log");
    writeFileSync(logPath, logLine("my-project", "tool call 1") + logLine("my-project", "tool call 2"));

    const receiver = new LogReceiver(logPath, dbPath);
    const entries = receiver.readAll();

    expect(entries.length).toBe(2);
    expect(entries[0].project).toBe("my-project");

    // Cursor should be persisted to SQLite
    const cursor = getCursor("events.log");
    expect(cursor).not.toBeNull();
    expect(cursor!.offset).toBeGreaterThan(0);
  });

  test("poll returns only new entries since last read", () => {
    const logPath = join(tmpDir, "events.log");
    writeFileSync(logPath, logLine("my-project", "first entry"));

    const receiver = new LogReceiver(logPath, dbPath);
    const first = receiver.readAll();
    expect(first.length).toBe(1);

    // Append new entries
    writeFileSync(logPath, logLine("my-project", "first entry") + logLine("my-project", "second entry"));

    const second = receiver.poll();
    expect(second.length).toBe(1);
    expect(second[0].eventText).toContain("second entry");
  });

  test("poll detects file rotation (file shrinks → resets cursor)", () => {
    const logPath = join(tmpDir, "events.log");
    writeFileSync(logPath, logLine("my-project", "old entry 1") + logLine("my-project", "old entry 2"));

    const receiver = new LogReceiver(logPath, dbPath);
    receiver.readAll(); // consume all → cursor at end

    // Simulate rotation: replace file with shorter content
    writeFileSync(logPath, logLine("my-project", "new entry after rotation"));

    const entries = receiver.poll();
    // After rotation detection, re-reads from 0 → gets the new line
    expect(entries.length).toBe(1);
    expect(entries[0].eventText).toContain("new entry after rotation");
  });

  test("cursor is restored from SQLite on construction", () => {
    const logPath = join(tmpDir, "events.log");
    const content = logLine("proj-a", "entry one") + logLine("proj-a", "entry two");
    writeFileSync(logPath, content);

    // First receiver: read all to persist cursor
    const receiver1 = new LogReceiver(logPath, dbPath);
    receiver1.readAll();

    const cursor = getCursor("events.log");
    expect(cursor!.offset).toBeGreaterThan(0);

    // Second receiver: should restore cursor and not re-read old entries
    const receiver2 = new LogReceiver(logPath, dbPath);
    const entries = receiver2.poll();
    expect(entries.length).toBe(0); // nothing new
  });

  test("poll returns empty for missing file (no crash)", () => {
    const logPath = join(tmpDir, "nonexistent.log");
    const receiver = new LogReceiver(logPath, dbPath);
    expect(() => receiver.poll()).not.toThrow();
    const entries = receiver.poll();
    expect(entries).toEqual([]);
  });

  test("readAll returns empty for missing file (no crash)", () => {
    const logPath = join(tmpDir, "nonexistent.log");
    const receiver = new LogReceiver(logPath, dbPath);
    expect(() => receiver.readAll()).not.toThrow();
    const entries = receiver.readAll();
    expect(entries).toEqual([]);
  });
});
