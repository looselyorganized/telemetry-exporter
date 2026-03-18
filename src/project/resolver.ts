/**
 * Single resolution authority for dirName → projId mapping.
 *
 * Only projects with a lo.yml file are resolved and exported.
 * Resolution sources:
 * 1. lo.yml — declared identity file in project root (only path for projects)
 * 2. Name cache — persisted dirName → projId mappings that survive renames
 * 3. Org-root hardcode — ["looselyorganized", "lo"] → proj_org-root
 *
 * resolve() is synchronous — the 250ms watcher loop calls it and must never await.
 * refresh() is async — rebuilds maps from disk. Called at startup
 * and periodically (every 60 cycles / 5 minutes).
 */

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  buildSlugMap,
  clearSlugCache,
  clearProjIdCache,
  PROJECT_ROOT,
} from "./slug-resolver";
import { isDirectory } from "../utils";

export interface ResolvedProject {
  projId: string;
  slug: string;
}

interface ResolutionStats {
  total: number;
  fromLoYml: number;
  fromNameCache: number;
}

const ORG_ROOT_ID = "proj_org-root";
const ORG_ROOT_NAMES = ["looselyorganized", "lo"];

/** Max age for name cache entries (30 days). */
const NAME_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_EXPORTER_DIR = join(import.meta.dirname!, "../..");
const DEFAULT_NAME_CACHE_FILE = join(DEFAULT_EXPORTER_DIR, ".name-cache.json");

/** Override for tests — set to a temp path to avoid polluting the real cache. */
let nameCacheFilePath = DEFAULT_NAME_CACHE_FILE;

export function setNameCachePath(path: string): void {
  nameCacheFilePath = path;
}

export function resetNameCachePath(): void {
  nameCacheFilePath = DEFAULT_NAME_CACHE_FILE;
}

// ─── lo.yml reader ─────────────────────────────────────────────────────────

/**
 * Read the proj_ ID from a lo.yml file.
 * Expects a line like: id: proj_<uuid>
 */
export function readLoYml(dir: string): string | null {
  const ymlPath = join(dir, "lo.yml");
  try {
    const content = readFileSync(ymlPath, "utf-8");
    const match = content.match(/^id:\s*(proj_\S+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ─── Name cache ────────────────────────────────────────────────────────────

interface NameCacheEntry {
  projId: string;
  slug: string;
  /** ISO timestamp of last time this entry was confirmed by a live source. */
  lastSeen: string;
}

function loadNameCache(): Record<string, NameCacheEntry> {
  try {
    return JSON.parse(readFileSync(nameCacheFilePath, "utf-8"));
  } catch {
    return {};
  }
}

function saveNameCache(cache: Record<string, NameCacheEntry>): void {
  try {
    writeFileSync(nameCacheFilePath, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // Non-fatal — cache is an optimization, not a requirement
  }
}

/**
 * Remove entries older than NAME_CACHE_MAX_AGE_MS that aren't in the
 * current live map (i.e., still-active entries are always kept).
 */
function pruneNameCache(
  cache: Record<string, NameCacheEntry>,
  liveKeys: Set<string>
): Record<string, NameCacheEntry> {
  const cutoff = Date.now() - NAME_CACHE_MAX_AGE_MS;
  const pruned: Record<string, NameCacheEntry> = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (liveKeys.has(key) || new Date(entry.lastSeen).getTime() > cutoff) {
      pruned[key] = entry;
    }
  }
  return pruned;
}

// ─── Resolver ──────────────────────────────────────────────────────────────

export class ProjectResolver {
  private dirToProject = new Map<string, ResolvedProject>();
  private resolutionStats: ResolutionStats = {
    total: 0,
    fromLoYml: 0,
    fromNameCache: 0,
  };

  /**
   * Synchronous, in-memory only. Never hits network or disk.
   */
  resolve(dirName: string): ResolvedProject | null {
    return this.dirToProject.get(dirName) ?? null;
  }

  /**
   * Async. Rebuilds maps from lo.yml + name cache.
   *
   * Only projects with a lo.yml file are exported. Resolution sources:
   * 1. lo.yml — read proj_ ID directly from each project dir
   * 2. Name cache — persisted old dirName → projId mappings (rename resilience)
   * 3. Org-root hardcode — ["looselyorganized", "lo"] → proj_org-root
   * 4. Persist all current mappings to name cache, prune stale entries
   */
  async refresh(): Promise<void> {
    const newMap = new Map<string, ResolvedProject>();
    let fromLoYml = 0;
    let fromNameCache = 0;

    // Build slug map for git remote slug derivation
    clearSlugCache();
    clearProjIdCache();
    const slugMap = buildSlugMap();

    // 1. lo.yml — only resolution path for projects
    try {
      const dirs = readdirSync(PROJECT_ROOT).filter((d) =>
        isDirectory(join(PROJECT_ROOT, d))
      );

      for (const dirName of dirs) {
        const projId = readLoYml(join(PROJECT_ROOT, dirName));
        if (projId) {
          const slug = slugMap.get(dirName) ?? dirName;
          newMap.set(dirName, { projId, slug });
          fromLoYml++;
        }
      }
    } catch {
      // PROJECT_ROOT doesn't exist or isn't readable
    }

    // Snapshot live-resolved keys before loading cache (for lastSeen tracking)
    const liveKeys = new Set(newMap.keys());

    // 3. Name cache — load old mappings for renamed/deleted dirs
    const nameCache = loadNameCache();
    for (const [dirName, cached] of Object.entries(nameCache)) {
      if (!newMap.has(dirName)) {
        newMap.set(dirName, { projId: cached.projId, slug: cached.slug });
        fromNameCache++;
      }
    }

    // 4. Org-root hardcode
    for (const name of ORG_ROOT_NAMES) {
      if (!newMap.has(name)) {
        newMap.set(name, { projId: ORG_ROOT_ID, slug: "org-root" });
        liveKeys.add(name);
        fromLoYml++; // org-root is a known identity, count with lo.yml
      }
    }

    // 5. Persist current mappings to name cache (with pruning)
    // Only live-resolved entries get a fresh lastSeen; cache-only entries keep their original timestamp
    const now = new Date().toISOString();
    const updatedCache = { ...nameCache };
    for (const [dirName, resolved] of newMap) {
      if (liveKeys.has(dirName)) {
        updatedCache[dirName] = { projId: resolved.projId, slug: resolved.slug, lastSeen: now };
      } else if (!updatedCache[dirName]) {
        // Shouldn't happen (cache-only entries already in nameCache), but be safe
        updatedCache[dirName] = { projId: resolved.projId, slug: resolved.slug, lastSeen: now };
      }
    }
    saveNameCache(pruneNameCache(updatedCache, liveKeys));

    this.dirToProject = newMap;
    this.resolutionStats = {
      total: newMap.size,
      fromLoYml,
      fromNameCache,
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
