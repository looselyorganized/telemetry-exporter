/**
 * Single resolution authority for dirName → projId mapping.
 *
 * Consolidates all resolution paths: disk (git remote) and Supabase.
 *
 * resolve() is synchronous — the 250ms watcher loop calls it and must never await.
 * refresh() is async — rebuilds maps from disk + Supabase. Called at startup
 * and periodically (every 60 cycles / 5 minutes).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSlugMap,
  clearSlugCache,
  clearProjIdCache,
  loadLegacyMapping,
  PROJECT_ROOT,
} from "./slug-resolver";

export interface ResolvedProject {
  projId: string;
  slug: string;
}

interface ResolutionStats {
  total: number;
  fromDisk: number;
  fromSupabase: number;
  fromLegacy: number;
}

const ORG_ROOT_ID = "proj_org-root";
const ORG_ROOT_NAMES = ["looselyorganized", "lo"];

export class ProjectResolver {
  private dirToProject = new Map<string, ResolvedProject>();
  private resolutionStats: ResolutionStats = {
    total: 0,
    fromDisk: 0,
    fromSupabase: 0,
    fromLegacy: 0,
  };

  /**
   * Synchronous, in-memory only. Never hits network or disk.
   */
  resolve(dirName: string): ResolvedProject | null {
    return this.dirToProject.get(dirName) ?? null;
  }

  /**
   * Async. Rebuilds maps from disk + Supabase.
   * Resolution sources in priority order:
   * 1. Supabase — canonical proj_ IDs from the projects table
   * 2. Disk — git remote URL → slug, matched against Supabase for proj_ ID
   * 3. Org-root hardcode — ["looselyorganized", "lo"] → proj_org-root
   *
   * Supabase provides the proj_ IDs. Disk provides the directory → slug mapping.
   * Projects not in Supabase are skipped (not yet set up).
   */
  async refresh(supabase: SupabaseClient): Promise<void> {
    const newMap = new Map<string, ResolvedProject>();
    let fromDisk = 0;
    let fromSupabase = 0;
    const fromLegacy = 0;

    // 1. Fetch slug → projId mapping from Supabase
    const slugToId = new Map<string, string>();
    try {
      const { data: projects } = await supabase
        .from("projects")
        .select("id, slug");

      for (const proj of projects ?? []) {
        const projId = proj.id as string;
        const slug = proj.slug as string;
        if (projId && slug) {
          slugToId.set(slug, projId);
        }
      }
    } catch {
      // Supabase unreachable — continue with what we have
    }

    // 2. Disk — git remote → slug, then look up proj_ ID from Supabase
    clearSlugCache();
    clearProjIdCache();
    const slugMap = buildSlugMap();

    for (const [dirName, slug] of slugMap) {
      const projId = slugToId.get(slug);
      if (projId) {
        newMap.set(dirName, { projId, slug });
        fromDisk++;
      }
    }

    // Also register by slug for Supabase-only entries (no local dir)
    for (const [slug, projId] of slugToId) {
      if (!newMap.has(slug)) {
        newMap.set(slug, { projId, slug });
        fromSupabase++;
      }
    }

    // 3. Org-root hardcode
    for (const name of ORG_ROOT_NAMES) {
      if (!newMap.has(name)) {
        newMap.set(name, { projId: ORG_ROOT_ID, slug: "org-root" });
        fromDisk++;
      }
    }

    this.dirToProject = newMap;
    this.resolutionStats = {
      total: newMap.size,
      fromDisk,
      fromSupabase,
      fromLegacy,
    };
  }

  /**
   * Iterate all known directory name → project mappings.
   */
  entries(): IterableIterator<[string, ResolvedProject]> {
    return this.dirToProject.entries();
  }

  /** Resolution stats for boot logging. */
  stats(): ResolutionStats {
    return { ...this.resolutionStats };
  }
}
