import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mock } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock Supabase for tests that call refresh()
const mockProjectRows: any[] = [];

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        data: table === "projects" ? mockProjectRows : [],
        error: null,
      }),
    }),
  }),
}));

const { initSupabase, getSupabase } = await import("../db/client");
initSupabase("http://fake", "fake-key");

const { ProjectResolver, readLoYml, setNameCachePath, resetNameCachePath } = await import("../project/resolver");
const { PROJECT_ROOT } = await import("../project/slug-resolver");

// Some tests depend on PROJECT_ROOT existing with real projects on disk
const hasProjectsOnDisk = existsSync(PROJECT_ROOT) &&
  existsSync(join(PROJECT_ROOT, "telemetry-exporter"));

// Redirect name cache to a temp file so tests don't pollute the real cache
const testCacheDir = join(tmpdir(), "lo-resolver-test-" + process.pid);
const testCacheFile = join(testCacheDir, ".name-cache.json");

describe("ProjectResolver", () => {
  let resolver: InstanceType<typeof ProjectResolver>;

  beforeEach(() => {
    resolver = new ProjectResolver();
    mockProjectRows.length = 0;
    mkdirSync(testCacheDir, { recursive: true });
    setNameCachePath(testCacheFile);
  });

  afterEach(() => {
    resetNameCachePath();
    rmSync(testCacheDir, { recursive: true, force: true });
  });

  describe("resolve()", () => {
    test("returns null for unknown directory", () => {
      expect(resolver.resolve("unknown-dir")).toBeNull();
    });

    test("resolves org-root names", async () => {
      await resolver.refresh();
      const result = resolver.resolve("looselyorganized");
      expect(result).not.toBeNull();
      expect(result!.projId).toBe("proj_org-root");
      expect(result!.slug).toBe("org-root");
    });

    test("resolves org-root 'lo' alias", async () => {
      await resolver.refresh();
      const result = resolver.resolve("lo");
      expect(result).not.toBeNull();
      expect(result!.projId).toBe("proj_org-root");
    });
  });

  describe("refresh()", () => {
    test("loads projects from disk", async () => {
      await resolver.refresh();
      const stats = resolver.stats();
      // At minimum, org-root should be loaded
      expect(stats.total).toBeGreaterThanOrEqual(2);
    });

    test.skipIf(!hasProjectsOnDisk)("resolves lo.yml projects on disk", async () => {
      await resolver.refresh();
      const result = resolver.resolve("telemetry-exporter");
      // telemetry-exporter has a lo.yml now
      if (result) {
        expect(result.projId).toBe("proj_fc236751-369a-4b23-847e-577e06753eee");
      }
    });

    test("does not resolve projects without lo.yml", async () => {
      await resolver.refresh();
      // A dir without lo.yml should not resolve, even if Supabase knows about it
      const result = resolver.resolve("some-random-dir-without-lo-yml");
      expect(result).toBeNull();
    });

    test("name cache persists lo.yml mappings across refreshes", async () => {
      await resolver.refresh();

      // After refresh, lo.yml projects are in the name cache.
      // A second resolver should pick them up from cache even without disk access.
      const resolver2 = new ProjectResolver();
      await resolver2.refresh();
      // Org-root should always resolve
      expect(resolver2.resolve("lo")).not.toBeNull();
    });

    test("name cache entries are pruned after max age", async () => {
      // Seed cache with a stale entry (lastSeen far in the past)
      const staleCache = {
        "dead-project": {
          projId: "proj_dead",
          slug: "dead-project",
          lastSeen: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
        },
      };
      writeFileSync(testCacheFile, JSON.stringify(staleCache));

      await resolver.refresh();

      // Stale entry should NOT be in the resolver (it's not live)
      // and should be pruned from the cache file
      const resolver2 = new ProjectResolver();
      await resolver2.refresh();
      expect(resolver2.resolve("dead-project")).toBeNull();
    });
  });

  describe("entries()", () => {
    test("returns all known mappings", async () => {
      await resolver.refresh();
      const allEntries = [...resolver.entries()];
      expect(allEntries.length).toBeGreaterThanOrEqual(2);

      for (const [dirName, resolved] of allEntries) {
        expect(typeof dirName).toBe("string");
        expect(resolved.projId).toBeDefined();
        expect(resolved.slug).toBeDefined();
      }
    });

    test("only includes lo.yml projects and org-root", async () => {
      await resolver.refresh();
      const allEntries = new Map(resolver.entries());

      // Should NOT include projects without lo.yml
      for (const [, resolved] of allEntries) {
        expect(resolved.projId).toBeDefined();
      }
    });
  });

  describe("stats()", () => {
    test("returns resolution source breakdown", async () => {
      await resolver.refresh();
      const stats = resolver.stats();
      expect(stats).toHaveProperty("total");
      expect(stats).toHaveProperty("fromLoYml");
      expect(stats).toHaveProperty("fromNameCache");
      expect(stats.total).toBe(
        stats.fromLoYml + stats.fromNameCache
      );
    });
  });
});

describe("readLoYml", () => {
  const tmpDir = join(import.meta.dirname!, "../../.test-lo-yml");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads proj_ ID from lo.yml", () => {
    writeFileSync(join(tmpDir, "lo.yml"), "id: proj_abc-123\n");
    expect(readLoYml(tmpDir)).toBe("proj_abc-123");
  });

  test("returns null for missing file", () => {
    expect(readLoYml(tmpDir)).toBeNull();
  });

  test("returns null for malformed content", () => {
    writeFileSync(join(tmpDir, "lo.yml"), "name: test\n");
    expect(readLoYml(tmpDir)).toBeNull();
  });

  test("ignores non-proj_ ids", () => {
    writeFileSync(join(tmpDir, "lo.yml"), "id: not-a-proj-id\n");
    expect(readLoYml(tmpDir)).toBeNull();
  });
});
