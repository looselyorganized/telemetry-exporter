/**
 * Single resolution authority for dirName → projId mapping.
 *
 * Consolidates all resolution paths: disk, Supabase slug,
 * org-root hardcode, and legacy .project-mapping.json.
 *
 * resolve() is synchronous — the 250ms watcher loop calls it and must never await.
 * refresh() is async — rebuilds maps from disk + Supabase. Called at startup
 * and periodically (every 60 cycles / 5 minutes).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { join } from "path";
import {
  buildSlugMap,
  clearSlugCache,
  resolveProjId,
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
   * 1. Disk (ground truth) — reads project.yml/PROJECT.md from each subdirectory
   * 2. Supabase slug — canonical slugs from the initiatives table
   * 3. Org-root hardcode — ["looselyorganized", "lo"] → proj_org-root
   * 4. Legacy .project-mapping.json — static fallback for orphaned directories
   *
   * Disk always wins on conflicts.
   */
  async refresh(supabase: SupabaseClient): Promise<void> {
    const newMap = new Map<string, ResolvedProject>();
    let fromDisk = 0;
    let fromSupabase = 0;
    let fromLegacy = 0;

    // 1. Disk — ground truth
    clearSlugCache();
    clearProjIdCache();
    const slugMap = buildSlugMap();

    for (const [dirName, slug] of slugMap) {
      const projId = resolveProjId(join(PROJECT_ROOT, dirName));
      if (projId) {
        newMap.set(dirName, { projId, slug });
        fromDisk++;
      }
    }

    // 2. Supabase slug — canonical slugs from the initiatives table
    try {
      const { data: projects } = await supabase
        .from("initiatives")
        .select("id, slug");

      for (const proj of projects ?? []) {
        const projId = proj.id as string;
        const slug = (proj.slug as string) ?? projId;

        // Add slug as a resolvable name (if not already from disk)
        if (slug && !newMap.has(slug)) {
          newMap.set(slug, { projId, slug });
          fromSupabase++;
        }
      }
    } catch {
      // Supabase unreachable — continue with disk + hardcoded sources
    }

    // 3. Org-root hardcode
    for (const name of ORG_ROOT_NAMES) {
      if (!newMap.has(name)) {
        newMap.set(name, { projId: ORG_ROOT_ID, slug: "org-root" });
        // Count org-root under disk since it's a hardcoded local source
        fromDisk++;
      }
    }

    // 4. Legacy .project-mapping.json
    const legacyMap = loadLegacyMapping();
    for (const [encodedName, projId] of legacyMap) {
      if (!newMap.has(encodedName)) {
        let slug = encodedName;
        for (const [, resolved] of newMap) {
          if (resolved.projId === projId) {
            slug = resolved.slug;
            break;
          }
        }
        newMap.set(encodedName, { projId, slug });
        fromLegacy++;
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
   * Includes disk, Supabase slug, org-root, and legacy entries.
   */
  entries(): IterableIterator<[string, ResolvedProject]> {
    return this.dirToProject.entries();
  }

  /** Resolution stats for boot logging. */
  stats(): ResolutionStats {
    return { ...this.resolutionStats };
  }
}
