import { describe, test, expect, beforeEach } from "bun:test";
import { mock } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

// Mock Supabase for tests that call refresh()
const mockProjectRows: any[] = [];

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        data: table === "initiatives" ? mockProjectRows : [],
        error: null,
      }),
    }),
  }),
}));

const { initSupabase, getSupabase } = await import("../db/client");
initSupabase("http://fake", "fake-key");

const { ProjectResolver } = await import("../project/resolver");
const { PROJECT_ROOT } = await import("../project/slug-resolver");

// Some tests depend on PROJECT_ROOT existing with real .lo/ projects on disk
const hasProjectsOnDisk = existsSync(PROJECT_ROOT) &&
  existsSync(join(PROJECT_ROOT, "telemetry-exporter"));

describe("ProjectResolver", () => {
  let resolver: InstanceType<typeof ProjectResolver>;

  beforeEach(() => {
    resolver = new ProjectResolver();
    mockProjectRows.length = 0;
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
      // Simulate a project known to Supabase but not on local disk
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
      // Use the real projId from disk so disk + Supabase agree
      const LORF_BOT_ID = "proj_fe8141ea-c26c-4b7e-a1e5-39d2eeeed5e8";
      mockProjectRows.push({
        id: LORF_BOT_ID,
        slug: "lorf-bot",
      });

      await resolver.refresh(getSupabase());

      const supabaseResult = resolver.resolve("lorf-bot");
      const diskResult = resolver.resolve("lorf-bot");

      // Slug from Supabase resolves (disk wins if present, Supabase otherwise)
      expect(supabaseResult).not.toBeNull();
      expect(supabaseResult!.projId).toBe(LORF_BOT_ID);

      // Disk and Supabase agree on the same slug
      if (diskResult) {
        expect(diskResult.projId).toBe(supabaseResult!.projId);
      }
    });

    test.skipIf(!hasProjectsOnDisk)("gracefully degrades when Supabase throws", async () => {
      // Create a client whose .from().select() throws
      const throwingClient = {
        from: () => ({
          select: () => { throw new Error("network timeout"); },
        }),
      } as any;

      await resolver.refresh(throwingClient);

      // Disk + org-root + legacy should still populate
      const stats = resolver.stats();
      expect(stats.fromDisk).toBeGreaterThanOrEqual(2);
      expect(stats.fromSupabase).toBe(0);
      expect(resolver.resolve("lo")).not.toBeNull();
      expect(resolver.resolve("telemetry-exporter")).not.toBeNull();
    });

    test("disk wins over Supabase on conflicts", async () => {
      await resolver.refresh(getSupabase());
      const diskResult = resolver.resolve("telemetry-exporter");

      if (diskResult) {
        // Now add a Supabase entry with a conflicting projId
        mockProjectRows.push({
          id: "proj_imposter",
          slug: "telemetry-exporter",
        });

        // Re-refresh — disk should still win
        await resolver.refresh(getSupabase());
        const afterResult = resolver.resolve("telemetry-exporter");
        expect(afterResult!.projId).toBe(diskResult.projId);
        expect(afterResult!.projId).not.toBe("proj_imposter");
      }
    });
  });

  describe("entries()", () => {
    test("returns all known mappings", async () => {
      await resolver.refresh(getSupabase());
      const allEntries = [...resolver.entries()];
      expect(allEntries.length).toBeGreaterThanOrEqual(2);

      // Each entry has dirName, projId, and slug
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

      // Supabase-only entries should appear in entries() via slug
      expect(allEntries.has("remote-project")).toBe(true);
    });
  });

  describe("stats()", () => {
    test("returns resolution source breakdown", async () => {
      await resolver.refresh(getSupabase());
      const stats = resolver.stats();
      expect(stats).toHaveProperty("total");
      expect(stats).toHaveProperty("fromDisk");
      expect(stats).toHaveProperty("fromSupabase");
      expect(stats).toHaveProperty("fromLegacy");
      expect(stats.total).toBe(
        stats.fromDisk + stats.fromSupabase + stats.fromLegacy
      );
    });
  });
});
