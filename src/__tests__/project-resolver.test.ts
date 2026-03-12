import { describe, test, expect, beforeEach } from "bun:test";
import { mock } from "bun:test";

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

const { ProjectResolver } = await import("../project/resolver");

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

    test("merges Supabase local_names for historical resolution", async () => {
      // Simulate a project with historical local name
      mockProjectRows.push({
        id: "proj_test123",
        content_slug: "lorf-bot",
        local_names: ["lo-concierge"],
      });

      await resolver.refresh(getSupabase());
      const result = resolver.resolve("lo-concierge");
      expect(result).not.toBeNull();
      expect(result!.projId).toBe("proj_test123");
    });

    test("lorf-bot scenario: both current and historical names resolve to same project", async () => {
      // Use the real projId from disk so disk + Supabase agree
      const LORF_BOT_ID = "proj_fe8141ea-c26c-4b7e-a1e5-39d2eeeed5e8";
      mockProjectRows.push({
        id: LORF_BOT_ID,
        content_slug: "lorf-bot",
        local_names: ["lo-concierge"],
      });

      await resolver.refresh(getSupabase());

      const diskResult = resolver.resolve("lorf-bot");
      const historyResult = resolver.resolve("lo-concierge");

      // Historical name always resolves via Supabase local_names
      expect(historyResult).not.toBeNull();
      expect(historyResult!.projId).toBe(LORF_BOT_ID);

      // If disk name also resolves, they must agree
      if (diskResult) {
        expect(diskResult.projId).toBe(historyResult!.projId);
      }
    });

    test("gracefully degrades when Supabase throws", async () => {
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
          content_slug: "telemetry-exporter",
          local_names: [],
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
        content_slug: "remote-project",
        local_names: ["old-remote-name"],
      });

      await resolver.refresh(getSupabase());
      const allEntries = new Map(resolver.entries());

      // Supabase-only entries should appear in entries()
      expect(allEntries.has("remote-project")).toBe(true);
      expect(allEntries.has("old-remote-name")).toBe(true);
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
