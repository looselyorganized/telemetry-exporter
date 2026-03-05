/**
 * Slug resolver for the LO telemetry exporter.
 *
 * Maps project directory paths to their content_slug and proj_id by reading
 * .lo/PROJECT.md frontmatter. Only LO projects (those with .lo/)
 * are tracked — all others are silently ignored.
 *
 * Two resolution strategies:
 * 1. Live repos: reads .lo/PROJECT.md (or legacy .lo/project.md) for proj_id
 * 2. Legacy/orphan dirs: static mapping in .project-mapping.json (encoded path → proj_id)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join } from "path";

const PROJECT_ROOT =
  "/Users/bigviking/Documents/github/projects/lo";

const slugCache = new Map<string, string | null>();
const projIdCache = new Map<string, string | null>();
let legacyMappingCache: Map<string, string> | null = null;

/** Minimal YAML frontmatter parser — extracts key: value pairs between --- fences. */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return result;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a project directory path to its content_slug.
 * Returns null if the project has no .lo/ directory (opt-in signal).
 * When .lo/ is added later, the exporter picks it up on the next slug map
 * refresh and retroactively backfills all historical telemetry from JSONL.
 */
export function resolveSlug(projectDir: string): string | null {
  if (slugCache.has(projectDir)) return slugCache.get(projectDir)!;

  const loDir = join(projectDir, ".lo");
  if (!existsSync(loDir)) {
    slugCache.set(projectDir, null);
    return null;
  }

  let slug = basename(projectDir);

  try {
    const projectMdPath = existsSync(join(loDir, "PROJECT.md"))
      ? join(loDir, "PROJECT.md")
      : join(loDir, "project.md");
    const content = readFileSync(projectMdPath, "utf-8");
    const fm = parseFrontmatter(content);
    slug = fm.content_slug ?? fm.slug ?? slug;
  } catch {
    // .lo/ exists but no PROJECT.md or project.md — use directory basename
  }

  slugCache.set(projectDir, slug);
  return slug;
}

/**
 * Build a complete directory-name-to-slug mapping.
 * Only includes LO projects (those with .lo/ directories).
 * Called at startup + refreshed every 10 cycles (5 min at 30s intervals).
 */
export function buildSlugMap(): Map<string, string> {
  const map = new Map<string, string>();

  try {
    const dirs = readdirSync(PROJECT_ROOT).filter((d) =>
      isDirectory(join(PROJECT_ROOT, d))
    );

    for (const dir of dirs) {
      const slug = resolveSlug(join(PROJECT_ROOT, dir));
      if (slug) map.set(dir, slug);
    }
  } catch {
    // PROJECT_ROOT doesn't exist or isn't readable
  }

  return map;
}

/**
 * Clear the in-memory slug cache.
 * Call before refreshing the slug map.
 */
export function clearSlugCache(): void {
  slugCache.clear();
}

// ---------------------------------------------------------------------------
// proj_id resolution (stable UUIDs — replaces slug-based identification)
// ---------------------------------------------------------------------------

/**
 * Resolve a project directory path to its proj_id.
 * Reads .lo/PROJECT.md (or legacy .lo/project.md) frontmatter for the proj_id field.
 * Returns null if the project has no .lo/ directory or no proj_id in frontmatter.
 */
export function resolveProjId(projectDir: string): string | null {
  if (projIdCache.has(projectDir)) return projIdCache.get(projectDir)!;

  const loDir = join(projectDir, ".lo");
  if (!existsSync(loDir)) {
    projIdCache.set(projectDir, null);
    return null;
  }

  let projId: string | null = null;

  try {
    const projectMdPath = existsSync(join(loDir, "PROJECT.md"))
      ? join(loDir, "PROJECT.md")
      : join(loDir, "project.md");
    const content = readFileSync(projectMdPath, "utf-8");
    const fm = parseFrontmatter(content);
    projId = fm.proj_id ?? null;
  } catch {
    // .lo/ exists but no PROJECT.md or project.md — no proj_id available
  }

  projIdCache.set(projectDir, projId);
  return projId;
}

/**
 * Resolve a project directory path to its content_slug.
 * Convenience alias for resolveSlug() — named explicitly to distinguish
 * from proj_id resolution during the migration period.
 */
export function resolveContentSlug(projectDir: string): string | null {
  return resolveSlug(projectDir);
}

/**
 * Load the static legacy mapping from .project-mapping.json.
 * Returns a Map of encoded JSONL directory names → proj_id values
 * for directories that no longer exist on disk (old looselyorganized paths).
 *
 * The mapping is loaded once and cached for the lifetime of the process.
 */
export function loadLegacyMapping(): Map<string, string> {
  if (legacyMappingCache) return legacyMappingCache;

  legacyMappingCache = new Map<string, string>();

  try {
    const mappingPath = join(
      dirname(new URL(import.meta.url).pathname),
      ".project-mapping.json"
    );
    const raw = JSON.parse(readFileSync(mappingPath, "utf-8"));

    for (const [key, value] of Object.entries(raw)) {
      if (key === "_comment") continue;
      if (typeof value === "string") {
        legacyMappingCache.set(key, value);
      }
    }
  } catch {
    // .project-mapping.json not found or malformed — return empty map
  }

  return legacyMappingCache;
}

/**
 * Clear the in-memory proj_id and legacy mapping caches.
 * Call before refreshing proj_id resolution.
 */
export function clearProjIdCache(): void {
  projIdCache.clear();
  legacyMappingCache = null;
}
