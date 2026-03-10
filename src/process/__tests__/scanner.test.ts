import { describe, test, expect, beforeEach } from "bun:test";
import {
  deriveProjectName,
  clearProjectNameCache,
  parseClaudeProcesses,
  parseLsofCwds,
  parseCaffeinateParents,
} from "../scanner";

// ---------------------------------------------------------------------------
// deriveProjectName
// ---------------------------------------------------------------------------
describe("deriveProjectName", () => {
  beforeEach(() => {
    clearProjectNameCache();
  });

  test("returns 'unknown' for empty string", () => {
    expect(deriveProjectName("")).toBe("unknown");
  });

  test("returns 'unknown' for root path", () => {
    expect(deriveProjectName("/")).toBe("unknown");
  });

  test("finds git root by walking up", () => {
    // Use the actual repo path dynamically so this works in any checkout location
    const repoRoot = import.meta.dirname!.replace(/\/src\/process\/__tests__$/, "");
    const cwd = `${repoRoot}/src/process`;
    const result = deriveProjectName(cwd);
    // basename of the git root should be the project name
    expect(result).toBe(repoRoot.split("/").pop());
  });

  test("falls back to projects/ heuristic when no .git found", () => {
    // A path with no .git anywhere but containing "projects" segment
    const cwd = "/tmp/projects/my-cool-app/src/lib";
    const result = deriveProjectName(cwd);
    expect(result).toBe("my-cool-app");
  });

  test("falls back to basename when no git root or projects/ segment", () => {
    const cwd = "/tmp/some-random-dir";
    const result = deriveProjectName(cwd);
    expect(result).toBe("some-random-dir");
  });

  test("caches results for repeated calls", () => {
    const cwd = "/tmp/projects/cached-proj/deep/nested";
    const first = deriveProjectName(cwd);
    const second = deriveProjectName(cwd);
    expect(first).toBe(second);
    expect(first).toBe("cached-proj");
  });
});

// ---------------------------------------------------------------------------
// parseClaudeProcesses
// ---------------------------------------------------------------------------
describe("parseClaudeProcesses", () => {
  test("parses typical ps output with claude processes", () => {
    const psOutput = [
      "  PID  %CPU   RSS     ELAPSED COMM",
      "12345   5.2 524288  01:23:45 claude",
      "67890   0.1 102400  00:05:10 claude",
    ].join("\n");

    const result = parseClaudeProcesses(psOutput);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ pid: 12345, cpu: 5.2, memMb: 512, uptime: "01:23:45" });
    expect(result[1]).toEqual({ pid: 67890, cpu: 0.1, memMb: 100, uptime: "00:05:10" });
  });

  test("filters out non-claude processes", () => {
    const psOutput = [
      "  PID  %CPU   RSS     ELAPSED COMM",
      "12345   5.2 524288  01:23:45 claude",
      "11111   2.0 204800  00:10:00 node",
      "22222   1.0 102400  00:01:00 bash",
    ].join("\n");

    const result = parseClaudeProcesses(psOutput);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(12345);
  });

  test("handles empty output", () => {
    expect(parseClaudeProcesses("")).toEqual([]);
  });

  test("handles header-only output", () => {
    const psOutput = "  PID  %CPU   RSS     ELAPSED COMM\n";
    expect(parseClaudeProcesses(psOutput)).toEqual([]);
  });

  test("skips lines with fewer than 5 fields", () => {
    const psOutput = [
      "  PID  %CPU   RSS     ELAPSED COMM",
      "12345 5.2",
      "67890   0.1 102400  00:05:10 claude",
    ].join("\n");

    const result = parseClaudeProcesses(psOutput);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(67890);
  });
});

// ---------------------------------------------------------------------------
// parseLsofCwds
// ---------------------------------------------------------------------------
describe("parseLsofCwds", () => {
  test("parses p/n line format into pid-to-cwd map", () => {
    const output = [
      "p12345",
      "n/Users/bigviking/projects/foo",
      "p67890",
      "n/Users/bigviking/projects/bar",
    ].join("\n");

    const result = parseLsofCwds(output);
    expect(result).toEqual({
      12345: "/Users/bigviking/projects/foo",
      67890: "/Users/bigviking/projects/bar",
    });
  });

  test("handles empty string", () => {
    expect(parseLsofCwds("")).toEqual({});
  });

  test("ignores n lines before any p line", () => {
    const output = ["n/some/path", "p100", "n/real/path"].join("\n");
    const result = parseLsofCwds(output);
    // The first n line has currentPid=0, which is falsy, so it's skipped
    expect(result).toEqual({ 100: "/real/path" });
  });

  test("last n line wins for a given pid", () => {
    const output = ["p100", "n/first", "n/second"].join("\n");
    const result = parseLsofCwds(output);
    expect(result).toEqual({ 100: "/second" });
  });

  test("ignores unrecognized line prefixes", () => {
    const output = ["p100", "fcwd", "n/the/path", "x-ignored"].join("\n");
    const result = parseLsofCwds(output);
    expect(result).toEqual({ 100: "/the/path" });
  });
});

// ---------------------------------------------------------------------------
// parseCaffeinateParents
// ---------------------------------------------------------------------------
describe("parseCaffeinateParents", () => {
  test("extracts parent PIDs of caffeinate processes", () => {
    const output = [
      "  PID  PPID COMM",
      "  100   50 bash",
      "  200  100 caffeinate",
      "  300  250 caffeinate",
      "  400   50 node",
    ].join("\n");

    const result = parseCaffeinateParents(output);
    expect(result).toEqual(new Set([100, 250]));
  });

  test("returns empty set for no caffeinate processes", () => {
    const output = [
      "  PID  PPID COMM",
      "  100   50 bash",
      "  200   50 node",
    ].join("\n");

    expect(parseCaffeinateParents(output)).toEqual(new Set());
  });

  test("handles empty string", () => {
    expect(parseCaffeinateParents("")).toEqual(new Set());
  });

  test("handles header-only output", () => {
    expect(parseCaffeinateParents("  PID  PPID COMM\n")).toEqual(new Set());
  });

  test("deduplicates parent PIDs", () => {
    const output = [
      "  PID  PPID COMM",
      "  200  100 caffeinate",
      "  300  100 caffeinate",
    ].join("\n");

    const result = parseCaffeinateParents(output);
    expect(result).toEqual(new Set([100]));
    expect(result.size).toBe(1);
  });
});
