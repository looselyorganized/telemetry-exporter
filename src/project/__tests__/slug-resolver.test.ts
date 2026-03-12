import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  parseFrontmatter,
  parseYaml,
  resolveSlug,
  resolveProjId,
  loadLegacyMapping,
  clearSlugCache,
  clearProjIdCache,
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

/** Create a project directory with a metadata file inside .lo/ */
function makeProject(dirName: string, fileName: string, content: string): string {
  const projDir = join(tmpDir, dirName);
  mkdirSync(join(projDir, ".lo"), { recursive: true });
  writeFileSync(join(projDir, ".lo", fileName), content);
  return projDir;
}

// ─── parseFrontmatter ───────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("extracts key-value pairs from frontmatter", () => {
    const content = `---
id: abc-123
content_slug: my-project
---
# Body content`;
    expect(parseFrontmatter(content)).toEqual({
      id: "abc-123",
      content_slug: "my-project",
    });
  });

  test("strips surrounding quotes from values", () => {
    const content = `---
id: "quoted-id"
slug: 'single-quoted'
---`;
    expect(parseFrontmatter(content)).toEqual({
      id: "quoted-id",
      slug: "single-quoted",
    });
  });

  test("returns empty object when no frontmatter fences", () => {
    expect(parseFrontmatter("just some text")).toEqual({});
    expect(parseFrontmatter("")).toEqual({});
  });

  test("handles keys with hyphens", () => {
    const content = `---
proj-id: xyz
content-slug: hello
---`;
    expect(parseFrontmatter(content)).toEqual({
      "proj-id": "xyz",
      "content-slug": "hello",
    });
  });

  test("ignores lines without key-value format", () => {
    const content = `---
id: valid
  indented: ignored
---`;
    const result = parseFrontmatter(content);
    expect(result.id).toBe("valid");
    expect(Object.keys(result)).toHaveLength(1);
  });
});

// ─── parseYaml ──────────────────────────────────────────────────────────────

describe("parseYaml", () => {
  test("parses plain YAML key-value pairs", () => {
    const content = `id: "proj_abc123"
title: My Project
status: explore
state: public`;
    expect(parseYaml(content)).toEqual({
      id: "proj_abc123",
      title: "My Project",
      status: "explore",
      state: "public",
    });
  });

  test("strips inline comments from unquoted and quoted values", () => {
    expect(parseYaml("status: explore # comment").status).toBe("explore");
    expect(parseYaml(`status: "explore"  # comment`).status).toBe("explore");
  });

  test("returns empty object for empty content", () => {
    expect(parseYaml("")).toEqual({});
  });
});

// ─── resolveSlug ────────────────────────────────────────────────────────────

describe("resolveSlug", () => {
  test("returns null when no .lo/ directory exists", () => {
    const projectDir = join(tmpDir, "no-lo-project");
    mkdirSync(projectDir);
    expect(resolveSlug(projectDir)).toBeNull();
  });

  test("returns basename when .lo/ exists but no metadata file", () => {
    const projectDir = join(tmpDir, "my-project");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    expect(resolveSlug(projectDir)).toBe("my-project");
  });

  test("reads content_slug from PROJECT.md frontmatter", () => {
    const projectDir = makeProject("dir-name", "PROJECT.md", `---
content_slug: custom-slug
---
# Project`);
    expect(resolveSlug(projectDir)).toBe("custom-slug");
  });

  test("falls back to slug field when content_slug absent", () => {
    const projectDir = makeProject("dir-name", "PROJECT.md", `---
slug: fallback-slug
---`);
    expect(resolveSlug(projectDir)).toBe("fallback-slug");
  });

  test("reads lowercase project.md as fallback", () => {
    const projectDir = makeProject("dir-name", "project.md", `---
content_slug: from-lowercase
---`);
    expect(resolveSlug(projectDir)).toBe("from-lowercase");
  });

  test("reads content_slug from project.yml", () => {
    const projectDir = makeProject("dir-name", "project.yml", `id: proj_abc123
content_slug: from-yml`);
    expect(resolveSlug(projectDir)).toBe("from-yml");
  });

  test("falls back to dir name when project.yml has no slug", () => {
    const projectDir = makeProject("my-project", "project.yml", `id: proj_abc123
title: My Project`);
    expect(resolveSlug(projectDir)).toBe("my-project");
  });

  test("caches results across calls", () => {
    const projectDir = makeProject("cached", "PROJECT.md", `---
content_slug: original
---`);
    expect(resolveSlug(projectDir)).toBe("original");

    // Overwrite file -- cached value should persist
    writeFileSync(join(projectDir, ".lo", "PROJECT.md"), `---
content_slug: changed
---`);
    expect(resolveSlug(projectDir)).toBe("original");
  });
});

// ─── resolveProjId ──────────────────────────────────────────────────────────

describe("resolveProjId", () => {
  test("returns null when no .lo/ directory exists", () => {
    const projectDir = join(tmpDir, "no-lo");
    mkdirSync(projectDir);
    expect(resolveProjId(projectDir)).toBeNull();
  });

  test("returns null when .lo/ exists but no id in frontmatter", () => {
    const projectDir = makeProject("no-id", "PROJECT.md", `---
content_slug: something
---`);
    expect(resolveProjId(projectDir)).toBeNull();
  });

  test("reads id from PROJECT.md frontmatter", () => {
    const projectDir = makeProject("has-id", "PROJECT.md", `---
id: uuid-123-456
---`);
    expect(resolveProjId(projectDir)).toBe("uuid-123-456");
  });

  test("falls back to proj_id field", () => {
    const projectDir = makeProject("has-proj-id", "PROJECT.md", `---
proj_id: legacy-id
---`);
    expect(resolveProjId(projectDir)).toBe("legacy-id");
  });

  test("prefers id over proj_id", () => {
    const projectDir = makeProject("both", "PROJECT.md", `---
id: primary
proj_id: secondary
---`);
    expect(resolveProjId(projectDir)).toBe("primary");
  });

  test("reads id from project.yml", () => {
    const projectDir = makeProject("yml-id", "project.yml", `id: "proj_abc123"
title: My Project
status: explore`);
    expect(resolveProjId(projectDir)).toBe("proj_abc123");
  });

  test("returns null when project.yml has no id field", () => {
    const projectDir = makeProject("no-id-yml", "project.yml", `title: My Project
status: explore`);
    expect(resolveProjId(projectDir)).toBeNull();
  });

  test("prefers PROJECT.md over project.yml when both exist", () => {
    const projDir = makeProject("dual", "PROJECT.md", `---
id: proj_from_md
---`);
    writeFileSync(join(projDir, ".lo", "project.yml"), "id: proj_from_yml");
    expect(resolveProjId(projDir)).toBe("proj_from_md");
  });
});

// ─── Smoke: real projects on disk resolve ────────────────────────────────────

describe("smoke: all .lo/ projects resolve", () => {
  const { readdirSync, existsSync } = require("fs");
  const { join } = require("path");
  const { PROJECT_ROOT, buildSlugMap, resolveProjId, clearSlugCache, clearProjIdCache } = require("../slug-resolver");

  // Collect every directory under PROJECT_ROOT that has a .lo/ subdirectory
  let loProjects: string[] = [];
  try {
    loProjects = readdirSync(PROJECT_ROOT).filter((d: string) => {
      const full = join(PROJECT_ROOT, d);
      try { return readdirSync(full).length >= 0 && existsSync(join(full, ".lo")); }
      catch { return false; }
    });
  } catch { /* PROJECT_ROOT missing in CI — tests will be skipped */ }

  // Skip all smoke tests when PROJECT_ROOT has no .lo/ projects (e.g. in CI)
  const noProjects = loProjects.length === 0;

  test.skipIf(noProjects)("PROJECT_ROOT has .lo/ projects to test", () => {
    expect(loProjects.length).toBeGreaterThan(0);
  });

  test.skipIf(noProjects)("every .lo/ project resolves a non-null projId", () => {
    clearSlugCache();
    clearProjIdCache();

    const failures: string[] = [];
    for (const dir of loProjects) {
      const projId = resolveProjId(join(PROJECT_ROOT, dir));
      if (!projId) failures.push(dir);
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} project(s) have .lo/ but resolveProjId returned null — ` +
        `likely a metadata format the resolver doesn't support:\n` +
        failures.map((d) => {
          const files = readdirSync(join(PROJECT_ROOT, d, ".lo")).join(", ");
          return `  ${d}/.lo/ contains: [${files}]`;
        }).join("\n")
      );
    }
  });

  test.skipIf(noProjects)("buildSlugMap includes all .lo/ projects", () => {
    clearSlugCache();
    clearProjIdCache();
    const slugMap = buildSlugMap();

    const missing = loProjects.filter((d: string) => !slugMap.has(d));
    expect(missing).toEqual([]);
  });
});

// ─── loadLegacyMapping ──────────────────────────────────────────────────────

describe("loadLegacyMapping", () => {
  test("returns a Map (possibly empty)", () => {
    const mapping = loadLegacyMapping();
    expect(mapping).toBeInstanceOf(Map);
  });

  test("does not include _comment key", () => {
    const mapping = loadLegacyMapping();
    expect(mapping.has("_comment")).toBe(false);
  });

  test("caches result across calls", () => {
    const first = loadLegacyMapping();
    const second = loadLegacyMapping();
    expect(first).toBe(second); // same reference
  });
});
