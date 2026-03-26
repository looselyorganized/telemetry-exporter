import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initLocal, closeLocal, getSession } from "../../db/local";
import {
  buildSessionRegistry,
  lookupSession,
  registerSession,
  refreshRegistry,
} from "../session-registry";
import type { ProjectResolver } from "../../project/resolver";

const TEST_DB_PATH = "/tmp/lo-test-session-registry.db";

function deleteTestFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

// Mock resolver that maps specific encoded dir names to proj_ids
function mockResolver(mapping: Record<string, string>): ProjectResolver {
  return {
    resolve(name: string) {
      const projId = mapping[name];
      if (projId) return { projId, slug: name };
      return null;
    },
    refresh: async () => {},
    stats: () => ({ total: 0, fromLoYml: 0, fromNameCache: 0 }),
  } as unknown as ProjectResolver;
}

// Create a mock ~/.claude/projects/ structure in a temp dir
function createMockProjectsDir(structure: Record<string, string[]>): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "lo-sess-"));
  for (const [dirName, files] of Object.entries(structure)) {
    const dirPath = join(tmpDir, dirName);
    mkdirSync(dirPath, { recursive: true });
    for (const file of files) {
      if (file.includes("/")) {
        // Create nested directory structure (e.g., "uuid/subagents/sub.jsonl")
        const parts = file.split("/");
        const nestedDir = join(dirPath, ...parts.slice(0, -1));
        mkdirSync(nestedDir, { recursive: true });
        writeFileSync(join(dirPath, file), "");
      } else {
        writeFileSync(join(dirPath, file), "");
      }
    }
  }
  return tmpDir;
}

beforeEach(() => {
  deleteTestFiles();
  initLocal(TEST_DB_PATH);
});

afterEach(() => {
  closeLocal();
  deleteTestFiles();
});

// ─── lookupSession / registerSession ────────────────────────────────────────

describe("lookupSession", () => {
  test("returns null for unknown session", () => {
    expect(lookupSession("nonexistent")).toBeNull();
  });

  test("returns session after registration", () => {
    registerSession("sess-abc", "proj_123", "/path/to/project");
    const session = lookupSession("sess-abc");
    expect(session).not.toBeNull();
    expect(session!.proj_id).toBe("proj_123");
    expect(session!.cwd).toBe("/path/to/project");
  });
});

describe("registerSession", () => {
  test("first write wins (immutable)", () => {
    registerSession("sess-abc", "proj_111", "/first");
    registerSession("sess-abc", "proj_222", "/second");
    const session = lookupSession("sess-abc");
    expect(session!.proj_id).toBe("proj_111");
    expect(session!.cwd).toBe("/first");
  });
});

// ─── buildSessionRegistry ───────────────────────────────────────────────────

describe("buildSessionRegistry", () => {
  test("registers sessions from JSONL files", () => {
    const projectsDir = createMockProjectsDir({
      "-Users-me-projects-lo-platform": [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
        "11111111-2222-3333-4444-555555555555.jsonl",
      ],
    });

    // The resolver must map the plain project name (from resolveProjectName)
    // Since resolveProjIdForDir is used, and it calls resolveProjectName internally,
    // we need to mock at the resolver level. The encoded dir won't match our
    // org roots, so resolveProjIdForDir will try the resolver with the encoded name directly.
    const resolver = mockResolver({
      "-Users-me-projects-lo-platform": "proj_platform",
    });

    const count = buildSessionRegistry(resolver, projectsDir);
    expect(count).toBe(2);

    const s1 = lookupSession("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(s1).not.toBeNull();
    expect(s1!.proj_id).toBe("proj_platform");

    const s2 = lookupSession("11111111-2222-3333-4444-555555555555");
    expect(s2).not.toBeNull();
    expect(s2!.proj_id).toBe("proj_platform");

    rmSync(projectsDir, { recursive: true });
  });

  test("ignores non-UUID filenames", () => {
    const projectsDir = createMockProjectsDir({
      "-Users-me-projects-foo": [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
        "not-a-uuid.jsonl",
        "CLAUDE.md",
        "settings.json",
      ],
    });

    const resolver = mockResolver({ "-Users-me-projects-foo": "proj_foo" });
    const count = buildSessionRegistry(resolver, projectsDir);
    expect(count).toBe(1);

    rmSync(projectsDir, { recursive: true });
  });

  test("skips directories that don't resolve to a project", () => {
    const projectsDir = createMockProjectsDir({
      "-Users-me-projects-unknown": [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
      ],
    });

    const resolver = mockResolver({}); // nothing resolves
    const count = buildSessionRegistry(resolver, projectsDir);
    expect(count).toBe(0);

    rmSync(projectsDir, { recursive: true });
  });

  test("handles empty projects directory", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "lo-empty-"));
    const resolver = mockResolver({});
    const count = buildSessionRegistry(resolver, projectsDir);
    expect(count).toBe(0);
    rmSync(projectsDir, { recursive: true });
  });

  test("handles missing projects directory", () => {
    const resolver = mockResolver({});
    const count = buildSessionRegistry(resolver, "/nonexistent/path");
    expect(count).toBe(0);
  });

  test("discovers subagent sessions", () => {
    const projectsDir = createMockProjectsDir({
      "-Users-me-projects-lo-exporter": [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/subagents/ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj.jsonl",
      ],
    });

    const resolver = mockResolver({ "-Users-me-projects-lo-exporter": "proj_exporter" });
    const count = buildSessionRegistry(resolver, projectsDir);
    // Only 1: the top-level .jsonl. The subagent UUID has non-hex chars so it's filtered.
    expect(count).toBe(1);

    const parent = lookupSession("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(parent).not.toBeNull();
    expect(parent!.proj_id).toBe("proj_exporter");

    // Note: subagent UUID "ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj" has hex g/h/i/j which aren't valid hex
    // So it won't match the UUID regex. Let's check it's not registered.
    const sub = lookupSession("ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj");
    expect(sub).toBeNull(); // not valid hex

    rmSync(projectsDir, { recursive: true });
  });

  test("discovers valid subagent UUIDs", () => {
    const projectsDir = createMockProjectsDir({
      "-Users-me-projects-lo-exporter": [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/subagents/11111111-2222-3333-4444-555555555555.jsonl",
      ],
    });

    const resolver = mockResolver({ "-Users-me-projects-lo-exporter": "proj_exporter" });
    const count = buildSessionRegistry(resolver, projectsDir);
    expect(count).toBe(2);

    expect(lookupSession("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).not.toBeNull();
    expect(lookupSession("11111111-2222-3333-4444-555555555555")).not.toBeNull();

    rmSync(projectsDir, { recursive: true });
  });
});

// ─── refreshRegistry ────────────────────────────────────────────────────────

describe("refreshRegistry", () => {
  test("picks up new sessions on refresh", () => {
    const projectsDir = createMockProjectsDir({
      "-Users-me-projects-foo": [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
      ],
    });

    const resolver = mockResolver({ "-Users-me-projects-foo": "proj_foo" });
    buildSessionRegistry(resolver, projectsDir);
    expect(lookupSession("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).not.toBeNull();

    // Add a new session file
    writeFileSync(
      join(projectsDir, "-Users-me-projects-foo", "22222222-3333-4444-5555-666666666666.jsonl"),
      ""
    );

    refreshRegistry(resolver, projectsDir);
    expect(lookupSession("22222222-3333-4444-5555-666666666666")).not.toBeNull();

    rmSync(projectsDir, { recursive: true });
  });

  test("does not overwrite existing sessions", () => {
    registerSession("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "proj_original", "/original");

    const projectsDir = createMockProjectsDir({
      "-Users-me-projects-bar": [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
      ],
    });

    const resolver = mockResolver({ "-Users-me-projects-bar": "proj_bar" });
    refreshRegistry(resolver, projectsDir);

    // Original mapping should be preserved
    const session = lookupSession("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(session!.proj_id).toBe("proj_original");

    rmSync(projectsDir, { recursive: true });
  });
});
