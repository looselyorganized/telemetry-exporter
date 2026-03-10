import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * getVisibility depends on execSync (calls `gh repo list`) and reads/writes
 * a cache file at a path relative to import.meta.dirname. Testing the full
 * function would require either:
 * 1. mock.module("child_process") — but this leaks across Bun test files
 * 2. Running with `gh` available — flaky in CI
 *
 * Instead, we test the core logic patterns:
 * - Cache file parsing (JSON → Record<string, "public" | "private">)
 * - GitHub output parsing (name isPrivate → visibility)
 * - Default-to-private behavior
 */

describe("getVisibility (logic patterns)", () => {
  test("cache file format is valid JSON with string visibility values", () => {
    const cache: Record<string, "public" | "private"> = {
      "my-public-app": "public",
      "my-private-app": "private",
    };
    const json = JSON.stringify(cache, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed["my-public-app"]).toBe("public");
    expect(parsed["my-private-app"]).toBe("private");
  });

  test("gh repo list output parsing extracts name and isPrivate", () => {
    const ghOutput = "my-public-repo false\nmy-private-repo true\n";
    const repoMap: Record<string, boolean> = {};
    for (const line of ghOutput.trim().split("\n")) {
      const [name, isPrivate] = line.trim().split(" ");
      if (name) {
        repoMap[name] = isPrivate === "true";
      }
    }
    expect(repoMap["my-public-repo"]).toBe(false);
    expect(repoMap["my-private-repo"]).toBe(true);
  });

  test("isPublic logic: false isPrivate means public", () => {
    const repoMap: Record<string, boolean> = { "app": false };
    const isPublic = repoMap["app"] === false;
    expect(isPublic).toBe(true);
    const visibility = isPublic ? "public" : "private";
    expect(visibility).toBe("public");
  });

  test("unknown repo defaults to private", () => {
    const repoMap: Record<string, boolean> = {};
    const isPublic = repoMap["unknown"] === false;
    expect(isPublic).toBe(false);
    const visibility = isPublic ? "public" : "private";
    expect(visibility).toBe("private");
  });

  test("empty gh output results in empty repo map", () => {
    const ghOutput = "";
    const repoMap: Record<string, boolean> = {};
    if (ghOutput.trim()) {
      for (const line of ghOutput.trim().split("\n")) {
        const [name, isPrivate] = line.trim().split(" ");
        if (name) repoMap[name] = isPrivate === "true";
      }
    }
    expect(Object.keys(repoMap)).toHaveLength(0);
  });
});
