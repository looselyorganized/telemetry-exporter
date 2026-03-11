import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  getOrCreate,
  discoverJsonlFiles,
  extractUsageRecords,
  computeTokensByProject,
  resolveProjectName,
  type ProjectTokenMap,
} from "../scanner";
import { clearSlugCache, clearProjIdCache, PROJECT_ROOT } from "../slug-resolver";
import { existsSync } from "fs";

let tmpDir: string;

beforeEach(() => {
  clearSlugCache();
  clearProjIdCache();
  tmpDir = mkdtempSync(join(tmpdir(), "scanner-test-"));
});

// ─── getOrCreate ────────────────────────────────────────────────────────────

describe("getOrCreate", () => {
  test("returns existing value if key is present", () => {
    const map = new Map<string, number>();
    map.set("a", 42);
    expect(getOrCreate(map, "a", () => 0)).toBe(42);
  });

  test("inserts and returns default when key is absent", () => {
    const map = new Map<string, number[]>();
    const result = getOrCreate(map, "x", () => [1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
    expect(map.get("x")).toEqual([1, 2, 3]);
  });

  test("does not overwrite existing value", () => {
    const map = new Map<string, string>();
    map.set("k", "original");
    getOrCreate(map, "k", () => "replacement");
    expect(map.get("k")).toBe("original");
  });
});

// ─── discoverJsonlFiles ─────────────────────────────────────────────────────

describe("discoverJsonlFiles", () => {
  test("discovers top-level .jsonl files", () => {
    writeFileSync(join(tmpDir, "session1.jsonl"), "");
    writeFileSync(join(tmpDir, "session2.jsonl"), "");
    writeFileSync(join(tmpDir, "notes.txt"), "");

    const files = discoverJsonlFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.dedupKey).sort()).toEqual(["session1.jsonl", "session2.jsonl"]);
  });

  test("discovers subagent .jsonl files", () => {
    const subDir = join(tmpDir, "uuid-session", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent1.jsonl"), "");
    writeFileSync(join(subDir, "agent2.jsonl"), "");

    const files = discoverJsonlFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files[0].dedupKey).toBe(join("uuid-session", "subagents", "agent1.jsonl"));
  });

  test("returns empty array for non-existent directory", () => {
    expect(discoverJsonlFiles(join(tmpDir, "nope"))).toEqual([]);
  });

  test("combines top-level and subagent files", () => {
    writeFileSync(join(tmpDir, "main.jsonl"), "");
    const subDir = join(tmpDir, "sess", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "sub.jsonl"), "");

    const files = discoverJsonlFiles(tmpDir);
    expect(files).toHaveLength(2);
  });
});

// ─── extractUsageRecords ────────────────────────────────────────────────────

describe("extractUsageRecords", () => {
  function makeUsageLine(opts: {
    requestId?: string;
    model?: string;
    timestamp?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }): string {
    return JSON.stringify({
      requestId: opts.requestId ?? "req-1",
      timestamp: opts.timestamp ?? "2025-01-15T10:00:00Z",
      message: {
        model: opts.model ?? "claude-3-opus",
        usage: {
          input_tokens: opts.input_tokens ?? 100,
          output_tokens: opts.output_tokens ?? 50,
          cache_creation_input_tokens: opts.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: opts.cache_read_input_tokens ?? 0,
        },
      },
    });
  }

  test("extracts usage records and aggregates into result map", () => {
    const filePath = join(tmpDir, "session.jsonl");
    writeFileSync(filePath, makeUsageLine({ requestId: "r1", input_tokens: 100, output_tokens: 50 }));

    const result: ProjectTokenMap = new Map();
    const count = extractUsageRecords(filePath, "proj-1", result);

    expect(count).toBe(1);
    expect(result.has("proj-1")).toBe(true);
    const dateMap = result.get("proj-1")!;
    expect(dateMap.has("2025-01-15")).toBe(true);
    expect(dateMap.get("2025-01-15")!["claude-3-opus"]).toBe(150);
  });

  test("deduplicates by requestId", () => {
    const filePath = join(tmpDir, "dedup.jsonl");
    const line = makeUsageLine({ requestId: "same-id", input_tokens: 100, output_tokens: 50 });
    writeFileSync(filePath, `${line}\n${line}\n${line}`);

    const result: ProjectTokenMap = new Map();
    const count = extractUsageRecords(filePath, "proj-1", result);

    expect(count).toBe(1);
    expect(result.get("proj-1")!.get("2025-01-15")!["claude-3-opus"]).toBe(150);
  });

  test("allows records without requestId (no dedup)", () => {
    const filePath = join(tmpDir, "no-reqid.jsonl");
    const line1 = JSON.stringify({
      timestamp: "2025-01-15T10:00:00Z",
      message: { model: "claude-3-opus", usage: { input_tokens: 10, output_tokens: 5 } },
    });
    const line2 = JSON.stringify({
      timestamp: "2025-01-15T11:00:00Z",
      message: { model: "claude-3-opus", usage: { input_tokens: 20, output_tokens: 10 } },
    });
    writeFileSync(filePath, `${line1}\n${line2}`);

    const result: ProjectTokenMap = new Map();
    const count = extractUsageRecords(filePath, "proj-1", result);
    expect(count).toBe(2);
    expect(result.get("proj-1")!.get("2025-01-15")!["claude-3-opus"]).toBe(45);
  });

  test("skips lines without usage", () => {
    const filePath = join(tmpDir, "mixed.jsonl");
    const usageLine = makeUsageLine({});
    const noUsageLine = JSON.stringify({ type: "text", message: { content: "hello" } });
    writeFileSync(filePath, `${noUsageLine}\n${usageLine}`);

    const result: ProjectTokenMap = new Map();
    const count = extractUsageRecords(filePath, "proj-1", result);
    expect(count).toBe(1);
  });

  test("skips records with zero tokens", () => {
    const filePath = join(tmpDir, "zero.jsonl");
    const line = makeUsageLine({ requestId: "r1", input_tokens: 0, output_tokens: 0 });
    writeFileSync(filePath, line);

    const result: ProjectTokenMap = new Map();
    const count = extractUsageRecords(filePath, "proj-1", result);
    expect(count).toBe(0);
  });

  test("sums all token types", () => {
    const filePath = join(tmpDir, "all-types.jsonl");
    const line = makeUsageLine({
      requestId: "r1",
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
    });
    writeFileSync(filePath, line);

    const result: ProjectTokenMap = new Map();
    extractUsageRecords(filePath, "proj-1", result);
    expect(result.get("proj-1")!.get("2025-01-15")!["claude-3-opus"]).toBe(650);
  });

  test("groups by date and model", () => {
    const filePath = join(tmpDir, "multi.jsonl");
    const lines = [
      makeUsageLine({ requestId: "r1", timestamp: "2025-01-15T10:00:00Z", model: "claude-3-opus", input_tokens: 100, output_tokens: 0 }),
      makeUsageLine({ requestId: "r2", timestamp: "2025-01-16T10:00:00Z", model: "claude-3-opus", input_tokens: 200, output_tokens: 0 }),
      makeUsageLine({ requestId: "r3", timestamp: "2025-01-15T11:00:00Z", model: "claude-3-sonnet", input_tokens: 50, output_tokens: 0 }),
    ];
    writeFileSync(filePath, lines.join("\n"));

    const result: ProjectTokenMap = new Map();
    extractUsageRecords(filePath, "proj-1", result);

    const dateMap = result.get("proj-1")!;
    expect(dateMap.get("2025-01-15")!["claude-3-opus"]).toBe(100);
    expect(dateMap.get("2025-01-15")!["claude-3-sonnet"]).toBe(50);
    expect(dateMap.get("2025-01-16")!["claude-3-opus"]).toBe(200);
  });
});

// ─── computeTokensByProject ─────────────────────────────────────────────────

describe("computeTokensByProject", () => {
  test("sums tokens across dates and models", () => {
    const tokenMap: ProjectTokenMap = new Map();
    const dateMap = new Map<string, Record<string, number>>();
    dateMap.set("2025-01-15", { "claude-3-opus": 100, "claude-3-sonnet": 50 });
    dateMap.set("2025-01-16", { "claude-3-opus": 200 });
    tokenMap.set("proj-1", dateMap);

    expect(computeTokensByProject(tokenMap)).toEqual({ "proj-1": 350 });
  });

  test("handles multiple projects", () => {
    const tokenMap: ProjectTokenMap = new Map();

    const dateMap1 = new Map<string, Record<string, number>>();
    dateMap1.set("2025-01-15", { "claude-3-opus": 100 });
    tokenMap.set("proj-1", dateMap1);

    const dateMap2 = new Map<string, Record<string, number>>();
    dateMap2.set("2025-01-15", { "claude-3-opus": 200 });
    tokenMap.set("proj-2", dateMap2);

    expect(computeTokensByProject(tokenMap)).toEqual({ "proj-1": 100, "proj-2": 200 });
  });

  test("returns empty object for empty map", () => {
    expect(computeTokensByProject(new Map())).toEqual({});
  });
});

// ─── resolveProjectName ─────────────────────────────────────────────────────

describe("resolveProjectName", () => {
  // Derive PROJECT_ROOT dynamically from the repo checkout location
  // so tests work in any environment (local dev, CI, etc.)
  const repoRoot = import.meta.dirname!.replace(/\/src\/project\/__tests__$/, "");
  const projectRoot = repoRoot.replace(/\/[^/]+$/, ""); // parent of repo = LO project root
  const encodedRoot = projectRoot.replace(/\//g, "-");
  const repoName = repoRoot.split("/").pop()!;

  test("returns null for unrecognized encoded dir name", () => {
    expect(resolveProjectName("some-random-path")).toBeNull();
  });

  test("returns null for org root without trailing project", () => {
    expect(resolveProjectName(encodedRoot)).toBeNull();
  });

  // This test depends on the actual PROJECT_ROOT matching the checkout location
  // and the repo directory existing on disk — skip gracefully in CI or other envs.
  const canResolveOnDisk =
    projectRoot === PROJECT_ROOT && existsSync(join(PROJECT_ROOT, repoName));

  test.skipIf(!canResolveOnDisk)(
    "resolves encoded dir name to project name for real projects on disk",
    () => {
      const result = resolveProjectName(`${encodedRoot}-${repoName}`);
      expect(result).toBe(repoName);
    },
  );
});
