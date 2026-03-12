/**
 * Slug resolver for the LO telemetry exporter.
 *
 * Maps project directory paths to their content_slug and id by reading
 * .lo/PROJECT.md frontmatter. Only LO projects (those with .lo/)
 * are tracked — all others are silently ignored.
 *
 * Two resolution strategies:
 * 1. Live repos: reads .lo/PROJECT.md (or legacy .lo/project.md) for id
 * 2. Legacy/orphan dirs: static mapping in .project-mapping.json (encoded path → id)
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join, normalize } from "path";

import { isDirectory } from "../utils";

/**
 * Normalize a filesystem path: expand a leading "~" to the user's home
 * directory, resolve relative segments, and strip any trailing slash.
 */
export function normalizeFsPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return normalize(p).replace(/\/+$/, "");
}

export const PROJECT_ROOT = normalizeFsPath(
  process.env.LO_PROJECT_ROOT || "/Users/bigviking/Documents/github/projects/lo"
);

const slugCache = new Map<string, string | null>();
const projIdCache = new Map<string, string | null>();
let legacyMappingCache: Map<string, string> | null = null;

/** Parse lines of key: value YAML pairs. Handles quoted values and inline comments. */
function parseYamlLines(lines: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines.split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)/);
    if (!kv) continue;
    let v = kv[2].trim();
    // Strip inline YAML comments from quoted values (e.g. "explore"  # comment)
    v = v.replace(/^["']([^"']*)["']\s*#.*$/, "$1");
    // Strip inline YAML comments from unquoted values (e.g. explore # comment)
    v = v.replace(/\s+#.*$/, "");
    v = v.replace(/^["']|["']$/g, "");
    result[kv[1]] = v;
  }
  return result;
}

/** Extract key-value pairs from YAML frontmatter between --- fences. */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  return parseYamlLines(match[1]);
}

/** Parse a pure YAML file (no frontmatter fences) into key-value pairs. */
export function parseYaml(content: string): Record<string, string> {
  return parseYamlLines(content);
}

/** Read and parse project metadata from a .lo/ directory, or null if not found.
 *  Supports: PROJECT.md (frontmatter), project.md (frontmatter), project.yml (pure YAML). */
function readProjectFrontmatter(projectDir: string): Record<string, string> | null {
  const loDir = join(projectDir, ".lo");
  if (!existsSync(loDir)) return null;

  try {
    // Prefer .md with frontmatter, fall back to .yml (pure YAML)
    for (const name of ["PROJECT.md", "project.md", "project.yml"]) {
      const path = join(loDir, name);
      if (existsSync(path)) {
        const content = readFileSync(path, "utf-8");
        return name.endsWith(".yml") ? parseYaml(content) : parseFrontmatter(content);
      }
    }
    return {};
  } catch {
    return {};
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

  const fm = readProjectFrontmatter(projectDir);
  if (!fm) {
    slugCache.set(projectDir, null);
    return null;
  }

  const slug = fm.content_slug ?? fm.slug ?? basename(projectDir);
  slugCache.set(projectDir, slug);
  return slug;
}

/**
 * Build a complete directory-name-to-slug mapping.
 * Only includes LO projects (those with .lo/ directories).
 * Called at startup + refreshed every 60 cycles (5 min at 5s intervals).
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
// id resolution (stable UUIDs — replaces slug-based identification)
// ---------------------------------------------------------------------------

/**
 * Resolve a project directory path to its id.
 * Reads .lo/PROJECT.md (or legacy .lo/project.md) frontmatter for the id field.
 * Returns null if the project has no .lo/ directory or no id in frontmatter.
 */
export function resolveProjId(projectDir: string): string | null {
  if (projIdCache.has(projectDir)) return projIdCache.get(projectDir)!;

  const fm = readProjectFrontmatter(projectDir);
  const projId = fm ? (fm.id ?? fm.proj_id ?? null) : null;

  projIdCache.set(projectDir, projId);
  return projId;
}

/**
 * Load the static legacy mapping from .project-mapping.json.
 * Returns a Map of encoded JSONL directory names → id values
 * for directories that no longer exist on disk (old looselyorganized paths).
 *
 * The mapping is loaded once and cached for the lifetime of the process.
 */
export function loadLegacyMapping(): Map<string, string> {
  if (legacyMappingCache) return legacyMappingCache;

  legacyMappingCache = new Map<string, string>();

  try {
    const mappingPath = join(
      import.meta.dirname!,
      "..",
      "..",
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
 * Clear the in-memory id and legacy mapping caches.
 * Call before refreshing proj_id resolution.
 */
export function clearProjIdCache(): void {
  projIdCache.clear();
  legacyMappingCache = null;
}
