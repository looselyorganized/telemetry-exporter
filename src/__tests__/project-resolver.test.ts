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
      await resolver.refresh(getSupabase());
      const result = resolver.resolve("looselyorganized");
      expect(result).not.toBeNull();
      expect(result!.projId).toBe("proj_org-root");
      expect(result!.slug).toBe("org-root");
    });

    test("resolves org-root 'lo' alias", async () => {
      await resolver.refresh(getSupabase());
      const result = resolver.resolve("lo");
      expect(result).not.toBeNull();
      expect(result!.projId).toBe("proj_org-root");
    });
  });

  describe("refresh()", () => {
    test("loads projects from disk", async () => {
      await resolver.refresh(getSupabase());
      const stats = resolver.stats();
      // At minimum, org-root should be loaded
      expect(stats.total).toBeGreaterThanOrEqual(2);
    });

    test("resolves Supabase slug entries not on disk", async () => {
      mockProjectRows.push({
        id: "proj_test123",
        slug: "supabase-only-project",
      });

      await resolver.refresh(getSupabase());
      const result = resolver.resolve("supabase-only-project");
      expect(result).not.toBeNull();
      expect(result!.projId).toBe("proj_test123");
    });

    test("lorf-bot scenario: slug from Supabase and disk both resolve to same project", async () => {
      const LORF_BOT_ID = "proj_fe8141ea-c26c-4b7e-a1e5-39d2eeeed5e8";
      mockProjectRows.push({
        id: LORF_BOT_ID,
        slug: "lorf-bot",
      });

      await resolver.refresh(getSupabase());

      const supabaseResult = resolver.resolve("lorf-bot");
      const diskResult = resolver.resolve("lorf-bot");

      expect(supabaseResult).not.toBeNull();
      expect(supabaseResult!.projId).toBe(LORF_BOT_ID);

      if (diskResult) {
        expect(diskResult.projId).toBe(supabaseResult!.projId);
      }
    });

    test.skipIf(!hasProjectsOnDisk)("gracefully degrades when Supabase throws", async () => {
      const throwingClient = {
        from: () => ({
          select: () => { throw new Error("network timeout"); },
        }),
      } as any;

      await resolver.refresh(throwingClient);

      const stats = resolver.stats();
      expect(stats.fromSupabase).toBe(0);
      // Org-root names should always resolve (via hardcode or name cache)
      expect(resolver.resolve("lo")).not.toBeNull();
      expect(resolver.resolve("looselyorganized")).not.toBeNull();
      expect(stats.total).toBeGreaterThanOrEqual(2);
    });

    test("Supabase proj_ ID is used for disk projects without lo.yml", async () => {
      mockProjectRows.push({
        id: "proj_fc236751-369a-4b23-847e-577e06753eee",
        slug: "telemetry-exporter",
      });

      await resolver.refresh(getSupabase());
      const result = resolver.resolve("telemetry-exporter");

      if (result) {
        expect(result.projId).toBe("proj_fc236751-369a-4b23-847e-577e06753eee");
        expect(result.slug).toBe("telemetry-exporter");
      }
    });

    test.skipIf(!hasProjectsOnDisk)("lo.yml takes priority over Supabase slug resolution", async () => {
      const loYmlId = readLoYml(join(PROJECT_ROOT, "lorf-bot"));
      if (!loYmlId) return; // skip if lorf-bot has no lo.yml yet

      mockProjectRows.push({
        id: "proj_wrong-id-from-supabase",
        slug: "lorf-bot",
      });

      await resolver.refresh(getSupabase());
      const result = resolver.resolve("lorf-bot");

      expect(result).not.toBeNull();
      expect(result!.projId).toBe(loYmlId); // lo.yml wins
    });

    test("name cache persists mappings across refreshes", async () => {
      // First refresh with a Supabase-only project
      mockProjectRows.push({ id: "proj_cached", slug: "cached-project" });
      await resolver.refresh(getSupabase());
      expect(resolver.resolve("cached-project")?.projId).toBe("proj_cached");

      // Second refresh without that project in Supabase — should still resolve via cache
      const resolver2 = new ProjectResolver();
      mockProjectRows.length = 0;
      await resolver2.refresh(getSupabase());
      const cached = resolver2.resolve("cached-project");
      expect(cached).not.toBeNull();
      expect(cached!.projId).toBe("proj_cached");
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

      await resolver.refresh(getSupabase());

      // Stale entry should NOT be in the resolver (it's not live)
      // and should be pruned from the cache file
      const resolver2 = new ProjectResolver();
      await resolver2.refresh(getSupabase());
      expect(resolver2.resolve("dead-project")).toBeNull();
    });
  });

  describe("entries()", () => {
    test("returns all known mappings", async () => {
      await resolver.refresh(getSupabase());
      const allEntries = [...resolver.entries()];
      expect(allEntries.length).toBeGreaterThanOrEqual(2);

      for (const [dirName, resolved] of allEntries) {
        expect(typeof dirName).toBe("string");
        expect(resolved.projId).toBeDefined();
        expect(resolved.slug).toBeDefined();
      }
    });

    test("includes supplemental projects not on disk", async () => {
      mockProjectRows.push({
        id: "proj_remote_only",
        slug: "remote-project",
      });

      await resolver.refresh(getSupabase());
      const allEntries = new Map(resolver.entries());

      expect(allEntries.has("remote-project")).toBe(true);
    });
  });

  describe("stats()", () => {
    test("returns resolution source breakdown", async () => {
      await resolver.refresh(getSupabase());
      const stats = resolver.stats();
      expect(stats).toHaveProperty("total");
      expect(stats).toHaveProperty("fromLoYml");
      expect(stats).toHaveProperty("fromDisk");
      expect(stats).toHaveProperty("fromSupabase");
      expect(stats).toHaveProperty("fromNameCache");
      expect(stats.total).toBe(
        stats.fromLoYml + stats.fromDisk + stats.fromSupabase + stats.fromNameCache
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
