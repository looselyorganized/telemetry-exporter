import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

import {
  parseGitRemoteUrl,
  resolveSlug,
  resolveProjId,
  loadLegacyMapping,
  clearSlugCache,
  clearProjIdCache,
  PROJECT_ROOT,
  buildSlugMap,
} from "../slug-resolver";

let tmpDir: string;

beforeEach(() => {
  clearSlugCache();
  clearProjIdCache();
  tmpDir = mkdtempSync(join(tmpdir(), "slug-resolver-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a temporary git repo with a remote URL */
function makeGitRepo(dirName: string, remoteUrl: string): string {
  const projDir = join(tmpDir, dirName);
  mkdirSync(projDir, { recursive: true });
  spawnSync("git", ["init"], { cwd: projDir });
  spawnSync("git", ["remote", "add", "origin", remoteUrl], { cwd: projDir });
  return projDir;
}

/** Create a plain directory (no git) */
function makePlainDir(dirName: string): string {
  const projDir = join(tmpDir, dirName);
  mkdirSync(projDir, { recursive: true });
  return projDir;
}

// ─── parseGitRemoteUrl ──────────────────────────────────────────────────────

describe("parseGitRemoteUrl", () => {
  test("extracts repo name from SSH URL", () => {
    expect(parseGitRemoteUrl("git@github.com:looselyorganized/platform.git")).toBe("platform");
  });

  test("extracts repo name from HTTPS URL", () => {
    expect(parseGitRemoteUrl("https://github.com/looselyorganized/platform.git")).toBe("platform");
  });

  test("handles URLs without .git suffix", () => {
    expect(parseGitRemoteUrl("https://github.com/looselyorganized/platform")).toBe("platform");
  });

  test("handles SSH URLs without .git suffix", () => {
    expect(parseGitRemoteUrl("git@github.com:looselyorganized/nexus")).toBe("nexus");
  });

  test("returns null for empty string", () => {
    expect(parseGitRemoteUrl("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(parseGitRemoteUrl("   ")).toBeNull();
  });

  test("returns null for malformed URL", () => {
    expect(parseGitRemoteUrl("not-a-url")).toBeNull();
  });

  test("handles deep paths in SSH URL", () => {
    expect(parseGitRemoteUrl("git@github.com:org/sub/repo.git")).toBe("repo");
  });

  test("handles deep paths in HTTPS URL", () => {
    expect(parseGitRemoteUrl("https://github.com/org/sub/repo.git")).toBe("repo");
  });
});

// ─── resolveSlug ────────────────────────────────────────────────────────────

describe("resolveSlug", () => {
  test("resolves slug from git remote URL", () => {
    const projDir = makeGitRepo("some-dir", "git@github.com:looselyorganized/my-project.git");
    expect(resolveSlug(projDir)).toBe("my-project");
  });

  test("falls back to directory basename when no git remote", () => {
    const projDir = makePlainDir("fallback-name");
    expect(resolveSlug(projDir)).toBe("fallback-name");
  });

  test("caches results across calls", () => {
    const projDir = makeGitRepo("cached-dir", "git@github.com:org/cached-repo.git");
    expect(resolveSlug(projDir)).toBe("cached-repo");
    // Second call should use cache
    expect(resolveSlug(projDir)).toBe("cached-repo");
  });
});

// ─── resolveProjId ──────────────────────────────────────────────────────────

describe("resolveProjId", () => {
  test("resolves project id from git remote URL", () => {
    const projDir = makeGitRepo("id-dir", "https://github.com/looselyorganized/platform.git");
    expect(resolveProjId(projDir)).toBe("platform");
  });

  test("falls back to directory basename when no git remote", () => {
    const projDir = makePlainDir("no-remote");
    expect(resolveProjId(projDir)).toBe("no-remote");
  });

  test("caches results across calls", () => {
    const projDir = makeGitRepo("cached-id", "git@github.com:org/cached-id-repo.git");
    expect(resolveProjId(projDir)).toBe("cached-id-repo");
    expect(resolveProjId(projDir)).toBe("cached-id-repo");
  });
});

// ─── Smoke: real projects on disk resolve ────────────────────────────────────

describe("smoke: all projects resolve", () => {
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(PROJECT_ROOT).filter((d: string) => {
      const full = join(PROJECT_ROOT, d);
      try { return statSync(full).isDirectory(); }
      catch { return false; }
    });
  } catch { /* PROJECT_ROOT missing in CI — tests will be skipped */ }

  const noProjects = projectDirs.length === 0;

  test.skipIf(noProjects)("PROJECT_ROOT has projects to test", () => {
    console.info(`PROJECT_ROOT contains ${projectDirs.length} project(s): ${projectDirs.join(", ")}`);
  });

  test.skipIf(noProjects)("buildSlugMap includes git-backed projects", () => {
    clearSlugCache();
    clearProjIdCache();
    const slugMap = buildSlugMap();
    // At least some projects should resolve
    expect(slugMap.size).toBeGreaterThan(0);
  });
});

// ─── loadLegacyMapping ──────────────────────────────────────────────────────

describe("loadLegacyMapping", () => {
  test("returns an empty Map (deprecated)", () => {
    const mapping = loadLegacyMapping();
    expect(mapping).toBeInstanceOf(Map);
    expect(mapping.size).toBe(0);
  });
});
