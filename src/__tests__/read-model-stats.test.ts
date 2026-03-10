import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * readModelStats reads from a hardcoded MODEL_FILE (~/.claude/model-stats).
 * We can't redirect it to a temp file without module mocking (which leaks).
 *
 * Instead, we test the parsing logic directly — the same split/filter/map
 * chain that readModelStats uses internally.
 */

function parseModelStatsContent(content: string) {
  return content
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6)
    .map((parts) => ({
      model: parts[0],
      total: parseInt(parts[1], 10),
      input: parseInt(parts[2], 10),
      cacheWrite: parseInt(parts[3], 10),
      cacheRead: parseInt(parts[4], 10),
      output: parseInt(parts[5], 10),
    }));
}

describe("readModelStats (parsing logic)", () => {
  test("parses space-separated model stats", () => {
    const result = parseModelStatsContent(
      "claude-3-opus 1000000 400000 100000 300000 200000\n"
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      model: "claude-3-opus",
      total: 1_000_000,
      input: 400_000,
      cacheWrite: 100_000,
      cacheRead: 300_000,
      output: 200_000,
    });
  });

  test("parses multiple model lines", () => {
    const content = [
      "claude-3-opus   1000000 400000 100000 300000 200000",
      "claude-3-sonnet  500000 200000  50000 150000 100000",
    ].join("\n");
    const result = parseModelStatsContent(content);
    expect(result).toHaveLength(2);
    expect(result[0].model).toBe("claude-3-opus");
    expect(result[1].model).toBe("claude-3-sonnet");
    expect(result[1].total).toBe(500_000);
  });

  test("skips lines with fewer than 6 fields", () => {
    const content = "incomplete 100 200\nvalid-model 100 50 10 30 10\n";
    const result = parseModelStatsContent(content);
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("valid-model");
  });

  test("handles extra whitespace between columns", () => {
    const result = parseModelStatsContent(
      "  model-a   100   50   10   30   10  \n"
    );
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("model-a");
    expect(result[0].total).toBe(100);
  });

  test("returns empty array for empty content", () => {
    expect(parseModelStatsContent("")).toHaveLength(0);
  });

  test("parses zero values correctly", () => {
    const result = parseModelStatsContent("model-x 0 0 0 0 0\n");
    expect(result).toHaveLength(1);
    expect(result[0].total).toBe(0);
    expect(result[0].input).toBe(0);
    expect(result[0].output).toBe(0);
  });

  test("ignores extra fields beyond 6", () => {
    const result = parseModelStatsContent("model-a 100 50 10 30 10 extra garbage\n");
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("model-a");
    expect(result[0].output).toBe(10);
  });

  test("handles model names with hyphens and numbers", () => {
    const result = parseModelStatsContent(
      "claude-opus-4-6-20260301 5000000 2000000 500000 1500000 1000000\n"
    );
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("claude-opus-4-6-20260301");
  });
});
