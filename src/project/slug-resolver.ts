/**
 * Slug resolver for the LO telemetry exporter.
 *
 * Maps project directory paths to their project identifier by parsing
 * the git remote URL. Falls back to directory basename if no remote.
 */

import { readdirSync } from "fs";
import { homedir } from "os";
import { basename, join, normalize } from "path";
import { spawnSync } from "child_process";

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

/**
 * Parse a git remote URL to extract the repository name.
 * Handles SSH (git@github.com:org/repo.git) and HTTPS (https://github.com/org/repo.git).
 * Returns null for empty or malformed input.
 */
export function parseGitRemoteUrl(url: string): string | null {
  if (!url || !url.trim()) return null;

  url = url.trim();

  // SSH: git@github.com:org/repo.git
  const sshMatch = url.match(/^[\w.-]+@[\w.-]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const path = sshMatch[1];
    const parts = path.split("/");
    return parts[parts.length - 1] || null;
  }

  // HTTPS: https://github.com/org/repo.git
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, "").split("/");
    return segments[segments.length - 1] || null;
  } catch {
    return null;
  }
}

/**
 * Get the git remote URL for a directory.
 * Returns null if the directory is not a git repo or has no remote.
 */
function getGitRemoteUrl(dir: string): string | null {
  try {
    const result = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status !== 0 || !result.stdout) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Resolve a project directory path to its slug.
 * Uses git remote URL to derive the project name.
 * Falls back to directory basename if no git remote.
 */
export function resolveSlug(projectDir: string): string | null {
  if (slugCache.has(projectDir)) return slugCache.get(projectDir)!;

  const remoteUrl = getGitRemoteUrl(projectDir);
  const slug = (remoteUrl ? parseGitRemoteUrl(remoteUrl) : null) ?? basename(projectDir);

  slugCache.set(projectDir, slug);
  return slug;
}

/**
 * Build a complete directory-name-to-slug mapping.
 * Includes all directories under PROJECT_ROOT that are git repos.
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
// id resolution (uses git remote URL)
// ---------------------------------------------------------------------------

/**
 * Resolve a project directory path to its project id.
 * Uses the repo name from git remote URL as the identifier.
 * Falls back to directory basename if no git remote.
 * Returns null only if the directory doesn't exist.
 */
export function resolveProjId(projectDir: string): string | null {
  if (projIdCache.has(projectDir)) return projIdCache.get(projectDir)!;

  const remoteUrl = getGitRemoteUrl(projectDir);
  const projId = (remoteUrl ? parseGitRemoteUrl(remoteUrl) : null) ?? basename(projectDir);

  projIdCache.set(projectDir, projId);
  return projId;
}

/**
 * Load legacy mapping — returns empty map.
 * Kept for API compatibility with callers that reference this function.
 * @deprecated No longer reads .project-mapping.json
 */
export function loadLegacyMapping(): Map<string, string> {
  return new Map<string, string>();
}

/**
 * Clear the in-memory id cache.
 * Call before refreshing proj_id resolution.
 */
export function clearProjIdCache(): void {
  projIdCache.clear();
}
