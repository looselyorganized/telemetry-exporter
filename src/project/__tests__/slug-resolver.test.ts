import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  parseFrontmatter,
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

// ─── resolveSlug ────────────────────────────────────────────────────────────

describe("resolveSlug", () => {
  test("returns null when no .lo/ directory exists", () => {
    const projectDir = join(tmpDir, "no-lo-project");
    mkdirSync(projectDir);
    expect(resolveSlug(projectDir)).toBeNull();
  });

  test("returns basename when .lo/ exists but no PROJECT.md", () => {
    const projectDir = join(tmpDir, "my-project");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    expect(resolveSlug(projectDir)).toBe("my-project");
  });

  test("reads content_slug from PROJECT.md frontmatter", () => {
    const projectDir = join(tmpDir, "dir-name");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    writeFileSync(
      join(projectDir, ".lo", "PROJECT.md"),
      `---
content_slug: custom-slug
---
# Project`
    );
    expect(resolveSlug(projectDir)).toBe("custom-slug");
  });

  test("falls back to slug field when content_slug absent", () => {
    const projectDir = join(tmpDir, "dir-name");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    writeFileSync(
      join(projectDir, ".lo", "PROJECT.md"),
      `---
slug: fallback-slug
---`
    );
    expect(resolveSlug(projectDir)).toBe("fallback-slug");
  });

  test("reads lowercase project.md as fallback", () => {
    const projectDir = join(tmpDir, "dir-name");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    writeFileSync(
      join(projectDir, ".lo", "project.md"),
      `---
content_slug: from-lowercase
---`
    );
    expect(resolveSlug(projectDir)).toBe("from-lowercase");
  });

  test("caches results across calls", () => {
    const projectDir = join(tmpDir, "cached");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    writeFileSync(
      join(projectDir, ".lo", "PROJECT.md"),
      `---
content_slug: original
---`
    );
    expect(resolveSlug(projectDir)).toBe("original");

    // Overwrite file — cached value should persist
    writeFileSync(
      join(projectDir, ".lo", "PROJECT.md"),
      `---
content_slug: changed
---`
    );
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
    const projectDir = join(tmpDir, "no-id");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    writeFileSync(
      join(projectDir, ".lo", "PROJECT.md"),
      `---
content_slug: something
---`
    );
    expect(resolveProjId(projectDir)).toBeNull();
  });

  test("reads id from PROJECT.md frontmatter", () => {
    const projectDir = join(tmpDir, "has-id");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    writeFileSync(
      join(projectDir, ".lo", "PROJECT.md"),
      `---
id: uuid-123-456
---`
    );
    expect(resolveProjId(projectDir)).toBe("uuid-123-456");
  });

  test("falls back to proj_id field", () => {
    const projectDir = join(tmpDir, "has-proj-id");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    writeFileSync(
      join(projectDir, ".lo", "PROJECT.md"),
      `---
proj_id: legacy-id
---`
    );
    expect(resolveProjId(projectDir)).toBe("legacy-id");
  });

  test("prefers id over proj_id", () => {
    const projectDir = join(tmpDir, "both");
    mkdirSync(join(projectDir, ".lo"), { recursive: true });
    writeFileSync(
      join(projectDir, ".lo", "PROJECT.md"),
      `---
id: primary
proj_id: secondary
---`
    );
    expect(resolveProjId(projectDir)).toBe("primary");
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
